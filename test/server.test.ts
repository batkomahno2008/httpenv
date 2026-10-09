// Unit tests for the server lifecycle: bind, serve, graceful close (#23).
// Contract IDs refer to docs/behaviour-contract.md (sections 1 and 6).
// Tests never bind port 8080: they use port 0 (a random free port) on loopback.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, Server } from 'node:http';
import type { RequestListener } from 'node:http';

import { envToRecord } from '../src/env.js';
import { CONTENT_TYPE, createHandler } from '../src/handler.js';
import type { RunningServer } from '../src/server.js';
import { PORT, startServer } from '../src/server.js';
import { LOOPBACK, listenOnLoopback, send } from './helpers/http.js';

const running: RunningServer[] = [];

async function start(options: Parameters<typeof startServer>[0]): Promise<RunningServer> {
  const srv = await startServer(options);
  running.push(srv);
  return srv;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const srv of running.splice(0)) {
    if (srv.server.listening) await srv.close();
  }
});

/** A handler that holds every request until `release()` is called. */
function gatedHandler(): {
  handler: RequestListener;
  received: Promise<void>;
  release: () => void;
} {
  let onReceived!: () => void;
  let onRelease!: () => void;
  const received = new Promise<void>((resolve) => (onReceived = resolve));
  const released = new Promise<void>((resolve) => (onRelease = resolve));
  const inner = createHandler({ getEnv: () => ({ SLOW: 'done' }) });
  const handler: RequestListener = (req, res) => {
    onReceived();
    void released.then(() => {
      inner(req, res);
    });
  };
  return { handler, received, release: onRelease };
}

/** Rejects if `promise` takes longer than `ms`. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${what} did not settle within ${String(ms)} ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

describe('PORT (contract P1, P2)', () => {
  it('P1: the contract port is 8080', () => {
    expect(PORT).toBe(8080);
  });

  it('P1/P2: startServer binds PORT when no port is given', async () => {
    // Never bind the real 8080 in tests: record the requested port, then bind 0 instead.
    const requested: unknown[] = [];
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-applied with the right `this` below
    const realListen = Server.prototype.listen;
    vi.spyOn(Server.prototype, 'listen').mockImplementation(function (
      this: Server,
      ...args: unknown[]
    ) {
      const [first, ...rest] = args;
      if (typeof first === 'object' && first !== null) {
        requested.push((first as { port?: unknown }).port);
        return Reflect.apply(realListen, this, [{ ...first, port: 0 }, ...rest]) as Server;
      }
      requested.push(first);
      return Reflect.apply(realListen, this, [0, ...rest]) as Server;
    });

    const srv = await start({ handler: createHandler({ getEnv: () => ({}) }), host: LOOPBACK });
    expect(requested).toEqual([PORT]);
    expect(srv.address.port).toBeGreaterThan(0);
  });
});

describe('startServer (contract P1)', () => {
  it('binds the configured port; port 0 reports the real port in address', async () => {
    const srv = await start({
      handler: createHandler({ getEnv: () => ({ FOO: 'bar' }) }),
      port: 0,
      host: LOOPBACK,
    });
    expect(srv.server.listening).toBe(true);
    expect(srv.address.port).toBeGreaterThan(0);
    expect(srv.address.port).not.toBe(PORT);
    expect(srv.address.address).toBe(LOOPBACK);

    const res = await send(srv.address.port);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(CONTENT_TYPE);
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ FOO: 'bar' });
  });

  it('binds an explicit non-zero port', async () => {
    // Find a free port, release it, then ask startServer for exactly that port.
    const probe = await listenOnLoopback(() => undefined);
    const port = probe.port;
    await probe.close();

    const srv = await start({
      handler: createHandler({ getEnv: () => ({}) }),
      port,
      host: LOOPBACK,
    });
    expect(srv.address.port).toBe(port);
    expect((await send(port)).status).toBe(200);
  });

  it('P1: binds all interfaces by default (reachable over loopback)', async () => {
    const srv = await start({ handler: createHandler({ getEnv: () => ({ A: '1' }) }), port: 0 });
    expect(['::', '0.0.0.0']).toContain(srv.address.address);
    const res = await send(srv.address.port);
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ A: '1' });
  });

  it('defaults to createHandler() serving process.env', async () => {
    vi.stubEnv('HTTPENV_UNIT_23_SERVER', 'yes');
    try {
      const srv = await start({ port: 0, host: LOOPBACK });
      const res = await send(srv.address.port);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe(CONTENT_TYPE);
      expect(JSON.parse(res.body.toString('utf8'))).toEqual(envToRecord(process.env));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('listen error (contract P5)', () => {
  it('P5: rejects with EADDRINUSE when the port is already in use', async () => {
    const holder = await listenOnLoopback(() => undefined);
    try {
      const attempt = startServer({
        handler: createHandler({ getEnv: () => ({}) }),
        port: holder.port,
        host: LOOPBACK,
      });
      await expect(attempt).rejects.toMatchObject({ code: 'EADDRINUSE' });
      await expect(attempt).rejects.toThrow(/EADDRINUSE|address already in use/i);
    } finally {
      await holder.close();
    }
  });
});

describe('close() graceful shutdown (contract D3)', () => {
  it('resolves and stops listening', async () => {
    const srv = await start({
      handler: createHandler({ getEnv: () => ({}) }),
      port: 0,
      host: LOOPBACK,
    });
    const { port } = srv.address;
    await within(srv.close(), 2000, 'close()');
    expect(srv.server.listening).toBe(false);
    await expect(send(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('D3: lets an in-flight request finish and refuses new connections meanwhile', async () => {
    const gate = gatedHandler();
    const srv = await start({ handler: gate.handler, port: 0, host: LOOPBACK });
    const { port } = srv.address;

    const inFlight = send(port, { path: '/in-flight' });
    await gate.received;

    let closed = false;
    const closing = srv.close().then(() => {
      closed = true;
    });

    // Stop accepting: a new connection is refused while the old request is still running.
    await expect(send(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(closed).toBe(false);

    gate.release();
    const res = await inFlight;
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ SLOW: 'done' });
    await within(closing, 2000, 'close() after the in-flight request');
    expect(closed).toBe(true);
  });

  it('D3: idle keep-alive connections do not hold shutdown open', async () => {
    const srv = await start({
      handler: createHandler({ getEnv: () => ({}) }),
      port: 0,
      host: LOOPBACK,
    });
    const agent = new Agent({ keepAlive: true });
    try {
      const res = await send(srv.address.port, { agent });
      expect(res.status).toBe(200);
      // The agent now holds an idle keep-alive socket (node:http keeps it for 5 s by default).
      await within(srv.close(), 1000, 'close() with an idle keep-alive connection');
    } finally {
      agent.destroy();
    }
  });

  it('D3: a keep-alive connection that was busy at close does not hold shutdown open', async () => {
    const gate = gatedHandler();
    const srv = await start({ handler: gate.handler, port: 0, host: LOOPBACK });
    const agent = new Agent({ keepAlive: true });
    try {
      const inFlight = send(srv.address.port, { agent });
      await gate.received;
      const closing = srv.close();
      gate.release();
      expect((await inFlight).status).toBe(200);
      await within(closing, 1000, 'close() after a keep-alive in-flight request');
    } finally {
      agent.destroy();
    }
  });
});
