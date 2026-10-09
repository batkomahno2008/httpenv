// Implementation-level checks for #30. The official suites are #23
// (test/handler.test.ts, test/server.test.ts, test/main.test.ts).
import { EventEmitter } from 'node:events';
import { request, Agent } from 'node:http';
import { connect } from 'node:net';
import type { IncomingHttpHeaders, RequestListener } from 'node:http';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { CONTENT_TYPE, createHandler } from '../src/handler.js';
import { STARTUP_MESSAGE, main } from '../src/main.js';
import type { SignalTarget } from '../src/main.js';
import { startServer } from '../src/server.js';
import type { RunningServer } from '../src/server.js';

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function send(port: number, method: string, path: string, agent?: Agent): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, agent }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    req.end(method === 'POST' ? 'ignored body' : undefined);
  });
}

function capture(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  let text = '';
  stream.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
  return { stream, text: () => text };
}

const servers: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function serve(handler: RequestListener): Promise<number> {
  const running = await startServer({ handler, port: 0, host: '127.0.0.1' });
  servers.push(running);
  return running.address.port;
}

describe('handler over HTTP', () => {
  it('answers every method and path with the env JSON and only the contract headers', async () => {
    const port = await serve(createHandler({ getEnv: () => ['FOO=bar', 'X=<'] }));
    for (const [method, path] of [
      ['GET', '/'],
      ['POST', '/some/deep/path/'],
      ['DELETE', '/a/../b'],
      ['GET', '/q?x=1'],
    ] as const) {
      const reply = await send(port, method, path);
      expect(reply.status).toBe(200);
      expect(reply.body).toBe('{"FOO":"bar","X":"\\u003c"}');
      expect(reply.headers['content-type']).toBe(CONTENT_TYPE);
      expect(reply.headers['content-length']).toBe(String(Buffer.byteLength(reply.body)));
      for (const name of Object.keys(reply.headers)) {
        expect(['connection', 'content-length', 'content-type', 'date', 'keep-alive']).toContain(
          name,
        );
      }
    }
  });

  it('sends Content-Length but no body on HEAD', async () => {
    const port = await serve(createHandler({ getEnv: () => ({ U: 'é' }) }));
    const reply = await send(port, 'HEAD', '/');
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('');
    expect(reply.headers['content-length']).toBe(String(Buffer.byteLength('{"U":"é"}')));
  });

  it('reads the environment on every request', async () => {
    let n = 0;
    const port = await serve(createHandler({ getEnv: () => [`N=${String(++n)}`] }));
    expect((await send(port, 'GET', '/')).body).toBe('{"N":"1"}');
    expect((await send(port, 'GET', '/')).body).toBe('{"N":"2"}');
  });
});

describe('graceful close', () => {
  it('closes idle keep-alive connections and lets in-flight responses finish', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const env = createHandler({ getEnv: () => ['A=1'] });
    const running = await startServer({
      port: 0,
      host: '127.0.0.1',
      handler: (req, res) => {
        if (req.url === '/slow') {
          void gate.then(() => {
            env(req, res);
          });
        } else env(req, res);
      },
    });
    const { port } = running.address;
    const agent = new Agent({ keepAlive: true });
    await send(port, 'GET', '/', agent); // leaves an idle keep-alive socket
    const slow = send(port, 'GET', '/slow');
    await new Promise((r) => setTimeout(r, 50));

    let closed = false;
    const closing = running.close().then(() => (closed = true));
    expect(running.close()).toBe(running.close()); // idempotent
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(false); // waiting for /slow
    await expect(send(port, 'GET', '/')).rejects.toThrow(); // no longer accepting

    release();
    expect((await slow).body).toBe('{"A":"1"}');
    await closing;
    expect(closed).toBe(true);
    agent.destroy();
  });

  it('closes a keep-alive connection that was busy when close() started, promptly', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const env = createHandler({ getEnv: () => ['A=1'] });
    const running = await startServer({
      port: 0,
      host: '127.0.0.1',
      handler: (req, res) => {
        void gate.then(() => {
          env(req, res);
        });
      },
    });
    const agent = new Agent({ keepAlive: true });
    const slow = send(running.address.port, 'GET', '/slow', agent);
    await new Promise((r) => setTimeout(r, 50));

    const closing = running.close();
    release();
    const started = Date.now();
    expect((await slow).body).toBe('{"A":"1"}');
    await closing;
    expect(Date.now() - started).toBeLessThan(1000);
    agent.destroy();
  });

  it('answers a request that arrives on a busy connection during close with Connection: close', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const env = createHandler({ getEnv: () => ['A=1'] });
    const running = await startServer({
      port: 0,
      host: '127.0.0.1',
      handler: (req, res) => {
        if (req.url === '/slow') {
          void gate.then(() => {
            env(req, res);
          });
        } else env(req, res);
      },
    });
    const socket = connect(running.address.port, '127.0.0.1');
    let raw = '';
    socket.on('data', (chunk: Buffer) => (raw += chunk.toString('latin1')));
    const ended = new Promise((resolve) => socket.once('close', resolve));
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write('GET /slow HTTP/1.1\r\nHost: x\r\n\r\n');
    await new Promise((r) => setTimeout(r, 50));

    const closing = running.close();
    socket.write('GET /next HTTP/1.1\r\nHost: x\r\n\r\n'); // pipelined while closing
    await new Promise((r) => setTimeout(r, 50));
    release();
    const started = Date.now();
    await closing;
    await ended;
    expect(Date.now() - started).toBeLessThan(1000);
    const responses = raw.split('HTTP/1.1 200 OK').slice(1);
    expect(responses).toHaveLength(2);
    expect(responses[1]).toMatch(/\r\nConnection: close\r\n/i);
  });

  it('defaults to the env handler', async () => {
    const running = await startServer({ port: 0 });
    servers.push(running);
    const reply = await send(running.address.port, 'GET', '/');
    expect(JSON.parse(reply.body)).toHaveProperty('PATH', process.env['PATH']);
  });

  it('rejects on a bind error', async () => {
    const port = await serve(createHandler());
    await expect(startServer({ port, host: '127.0.0.1' })).rejects.toThrow(/EADDRINUSE/);
  });
});

describe('main', () => {
  function setup(extra: { shutdownTimeoutMs?: number } = {}) {
    const out = capture();
    const err = capture();
    const target = new EventEmitter() as EventEmitter & SignalTarget;
    const codes: number[] = [];
    let onExit: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => (onExit = resolve));
    const options = {
      stdout: out.stream,
      stderr: err.stream,
      signalTarget: target,
      exit: (code: number) => {
        codes.push(code);
        onExit(code);
      },
      port: 0,
      host: '127.0.0.1',
      ...extra,
    };
    return { out, err, target, codes, exited, options };
  }

  it('prints the Go startup lines, serves, and exits 0 on SIGTERM', async () => {
    const t = setup();
    const running = await main(t.options);
    expect(t.out.text()).toBe(STARTUP_MESSAGE);
    expect((await send(running.address.port, 'GET', '/')).status).toBe(200);
    t.target.emit('SIGTERM');
    t.target.emit('SIGINT'); // ignored while draining
    expect(await t.exited).toBe(0);
    expect(t.codes).toEqual([0]);
    expect(t.err.text()).toBe('');
    expect(t.target.listenerCount('SIGTERM')).toBe(0);
    expect(t.target.listenerCount('SIGINT')).toBe(0);
  });

  it('forces exit 1 when in-flight requests outlast the timeout', async () => {
    const t = setup({ shutdownTimeoutMs: 100 });
    const running = await main(t.options);
    const { port } = running.address;
    // A request whose headers never finish: busy, so neither idle-closed nor drained.
    const socket = connect(port, '127.0.0.1');
    socket.on('error', () => undefined);
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write('GET / HTTP/1.1\r\nHost: x\r\n');
    await new Promise((r) => setTimeout(r, 50));
    t.target.emit('SIGINT');
    expect(await t.exited).toBe(1);
    expect(t.err.text()).toMatch(/timed out/);
    socket.destroy();
  });

  it('reports a bind error on stderr after the startup lines and rejects', async () => {
    const port = await serve(createHandler());
    const t = setup();
    await expect(main({ ...t.options, port })).rejects.toThrow(/EADDRINUSE/);
    expect(t.out.text()).toBe(STARTUP_MESSAGE);
    expect(t.err.text()).toMatch(/^httpenv: .*EADDRINUSE/);
    expect(t.target.listenerCount('SIGTERM')).toBe(0);
  });
});
