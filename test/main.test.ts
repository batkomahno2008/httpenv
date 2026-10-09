// Unit tests for the process entry point `main()` (#23), run in-process.
// Contract IDs refer to docs/behaviour-contract.md (sections 1 and 6).
//
// Everything process-level is injected: stdout/stderr are captured, signals are
// emitted on a private EventEmitter (never real signals), `exit` is a mock, and
// the server binds a random loopback port. Port 8080 is never bound: the one
// test that checks the default port rewrites the requested port to 0.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Agent, Server } from 'node:http';
import type { RequestListener } from 'node:http';
import { Writable } from 'node:stream';

import { main } from '../src/main.js';
import type { MainOptions } from '../src/main.js';
import { CONTENT_TYPE } from '../src/handler.js';
import type * as HandlerModule from '../src/handler.js';
import type { RunningServer } from '../src/server.js';
import { PORT } from '../src/server.js';
import { LOOPBACK, listenOnLoopback, send } from './helpers/http.js';

/** Contract P3, byte for byte (no space after `8080.`; each line ends with `\n`). */
const STARTUP =
  'Starting httpenv listening on port 8080.Please stand by...\n' +
  'Why did the cat refuse to play cards with the dog? Because every time he got a good hand, he wagged his tail!\n';

// Lets a test hold requests inside the default handler that main() builds, so a
// response is genuinely in flight when the signal arrives.
const gate = vi.hoisted(() => {
  const state = {
    hold: false,
    received: Promise.resolve(),
    release: (): void => undefined,
    onReceived: (): void => undefined,
    released: Promise.resolve(),
    arm(): void {
      state.hold = true;
      state.received = new Promise<void>((resolve) => (state.onReceived = resolve));
      state.released = new Promise<void>((resolve) => (state.release = resolve));
    },
  };
  return state;
});

vi.mock('../src/handler.js', async (importOriginal) => {
  const mod = await importOriginal<typeof HandlerModule>();
  return {
    ...mod,
    createHandler: (...args: Parameters<typeof mod.createHandler>): RequestListener => {
      const inner = mod.createHandler(...args);
      return (req, res) => {
        if (!gate.hold) {
          inner(req, res);
          return;
        }
        gate.onReceived();
        void gate.released.then(() => {
          inner(req, res);
        });
      };
    },
  };
});

/** A writable that records everything written to it. */
class Capture extends Writable {
  text = '';
  override _write(chunk: unknown, _enc: BufferEncoding, done: (err?: Error | null) => void): void {
    this.text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    done();
  }
}

interface Harness {
  readonly stdout: Capture;
  readonly stderr: Capture;
  readonly signals: EventEmitter;
  readonly exit: ReturnType<typeof vi.fn<(code: number) => void>>;
  readonly options: MainOptions;
}

function harness(extra: Partial<MainOptions> = {}): Harness {
  const stdout = new Capture();
  const stderr = new Capture();
  const signals = new EventEmitter();
  const exit = vi.fn<(code: number) => void>();
  return {
    stdout,
    stderr,
    signals,
    exit,
    options: { stdout, stderr, signalTarget: signals, exit, port: 0, host: LOOPBACK, ...extra },
  };
}

const started: RunningServer[] = [];

async function startMain(h: Harness): Promise<RunningServer> {
  const running = await main(h.options);
  started.push(running);
  return running;
}

function exitCode(h: Harness): Promise<number> {
  return vi.waitFor(
    () => {
      const code = h.exit.mock.calls[0]?.[0];
      if (code === undefined) throw new Error('exit() not called yet');
      return code;
    },
    { timeout: 3000, interval: 5 },
  );
}

afterEach(async () => {
  gate.release();
  gate.hold = false;
  for (const running of started.splice(0)) {
    running.server.closeAllConnections();
    if (running.server.listening) await running.close();
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('startup (contract P1, P2, P3, P4)', () => {
  it('P3: writes exactly the two startup lines to stdout', async () => {
    const h = harness();
    await startMain(h);
    expect(h.stdout.text).toBe(STARTUP);
    expect(h.stderr.text).toBe('');
  });

  it('P1/P2/P3: binds port 8080 on all interfaces by default, after printing the startup lines', async () => {
    // Never bind the real 8080: record what main() asks for, then bind 0 instead.
    const h = harness();
    const calls: { port: unknown; host: unknown; stdout: string }[] = [];
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-applied with the right `this` below
    const realListen = Server.prototype.listen;
    vi.spyOn(Server.prototype, 'listen').mockImplementation(function (
      this: Server,
      ...args: unknown[]
    ) {
      const [first, ...rest] = args;
      if (typeof first === 'object' && first !== null) {
        const opts = first as { port?: unknown; host?: unknown };
        calls.push({ port: opts.port, host: opts.host, stdout: h.stdout.text });
        return Reflect.apply(realListen, this, [{ ...first, port: 0 }, ...rest]) as Server;
      }
      calls.push({ port: first, host: rest[0], stdout: h.stdout.text });
      return Reflect.apply(realListen, this, [0, ...rest]) as Server;
    });

    const { stdout, stderr, signalTarget, exit } = h.options;
    const running = await main({
      ...(stdout && { stdout }),
      ...(stderr && { stderr }),
      ...(signalTarget && { signalTarget }),
      ...(exit && { exit }),
    });
    started.push(running);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.port).toBe(PORT);
    expect(PORT).toBe(8080);
    expect([undefined, '::', '0.0.0.0']).toContain(calls[0]?.host);
    expect(['::', '0.0.0.0']).toContain(running.address.address);
    // P3: the lines are already out when the listener is bound.
    expect(calls[0]?.stdout).toBe(STARTUP);
  });

  it('P1: resolves once listening and serves process.env', async () => {
    vi.stubEnv('HTTPENV_UNIT_23_MAIN', 'hello');
    const h = harness();
    const running = await startMain(h);
    expect(running.server.listening).toBe(true);
    expect(running.address.port).toBeGreaterThan(0);

    const res = await send(running.address.port, { path: '/any?x=1' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(CONTENT_TYPE);
    const body = JSON.parse(res.body.toString('utf8')) as Record<string, unknown>;
    expect(body['HTTPENV_UNIT_23_MAIN']).toBe('hello');
  });

  it('P4: nothing is written to stderr (or more to stdout) while serving requests', async () => {
    const h = harness();
    const running = await startMain(h);
    await send(running.address.port);
    await send(running.address.port, { method: 'POST', path: '/x', body: 'ignored' });
    await send(running.address.port, { method: 'HEAD' });
    expect(h.stdout.text).toBe(STARTUP);
    expect(h.stderr.text).toBe('');
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('D3: listens for SIGTERM and SIGINT by default', async () => {
    const h = harness();
    await startMain(h);
    expect(h.signals.listenerCount('SIGTERM')).toBe(1);
    expect(h.signals.listenerCount('SIGINT')).toBe(1);
  });

  it('honours an injected signal list', async () => {
    const h = harness({ signals: ['SIGUSR2'] });
    await startMain(h);
    expect(h.signals.listenerCount('SIGUSR2')).toBe(1);
    expect(h.signals.listenerCount('SIGTERM')).toBe(0);
    expect(h.signals.listenerCount('SIGINT')).toBe(0);
  });

  it('installs its handlers on process by default (removed again in this test)', async () => {
    const before = {
      SIGTERM: process.listeners('SIGTERM'),
      SIGINT: process.listeners('SIGINT'),
    };
    const h = harness();
    const { signalTarget: _unused, ...withoutTarget } = h.options;
    const running = await main(withoutTarget);
    started.push(running);
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      const added = process.listeners(signal).filter((l) => !before[signal].includes(l));
      expect(added).toHaveLength(1);
      for (const l of added) process.removeListener(signal, l);
    }
  });
});

describe('graceful shutdown (contract D3)', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('D3: %s stops listening and exits 0', async (signal) => {
    const h = harness();
    const running = await startMain(h);
    const { port } = running.address;

    h.signals.emit(signal, signal);
    expect(await exitCode(h)).toBe(0);
    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(running.server.listening).toBe(false);
    await expect(send(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(h.stderr.text).toBe('');
    // Handlers are removed after a clean shutdown.
    expect(h.signals.listenerCount('SIGTERM')).toBe(0);
    expect(h.signals.listenerCount('SIGINT')).toBe(0);
  });

  it('D3: SIGTERM lets an in-flight request finish, refusing new connections meanwhile, then exits 0', async () => {
    const h = harness();
    const running = await startMain(h);
    const { port } = running.address;

    gate.arm();
    const inFlight = send(port, { path: '/in-flight' });
    await gate.received;

    h.signals.emit('SIGTERM', 'SIGTERM');
    await vi.waitFor(() => {
      expect(running.server.listening).toBe(false);
    });
    await expect(send(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(h.exit).not.toHaveBeenCalled();

    gate.release();
    const res = await inFlight;
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(CONTENT_TYPE);
    expect(JSON.parse(res.body.toString('utf8'))).toEqual(expect.any(Object));
    expect(await exitCode(h)).toBe(0);
  });

  it('D3: an in-flight request on a keep-alive connection still drains to exit 0 promptly', async () => {
    // Real clients (and Docker health checks, proxies) reuse connections. After
    // its response, such a connection must not keep the server open until the
    // keep-alive timeout, or the shutdown timer forces a non-zero exit.
    const h = harness({ shutdownTimeoutMs: 2000 });
    const running = await startMain(h);
    const agent = new Agent({ keepAlive: true });
    try {
      gate.arm();
      const inFlight = send(running.address.port, { agent });
      await gate.received;

      h.signals.emit('SIGTERM', 'SIGTERM');
      gate.release();
      expect((await inFlight).status).toBe(200);
      const t0 = Date.now();
      expect(await exitCode(h)).toBe(0);
      expect(Date.now() - t0).toBeLessThan(1000);
    } finally {
      agent.destroy();
    }
  });

  it('D3: a second signal while draining does not exit early or twice', async () => {
    const h = harness();
    const running = await startMain(h);

    gate.arm();
    const inFlight = send(running.address.port);
    await gate.received;

    h.signals.emit('SIGTERM', 'SIGTERM');
    h.signals.emit('SIGINT', 'SIGINT');
    h.signals.emit('SIGTERM', 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.exit).not.toHaveBeenCalled();

    gate.release();
    expect((await inFlight).status).toBe(200);
    expect(await exitCode(h)).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.exit).toHaveBeenCalledTimes(1);
  });

  it('D3: forces exit (non-zero, message on stderr) when draining exceeds the timeout', async () => {
    const h = harness({ shutdownTimeoutMs: 100 });
    const running = await startMain(h);

    gate.arm();
    const inFlight = send(running.address.port).catch((err: unknown) => err);
    await gate.received;

    const t0 = Date.now();
    h.signals.emit('SIGTERM', 'SIGTERM');
    const code = await exitCode(h);
    expect(code).not.toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
    expect(h.stderr.text).toMatch(/shutdown|timed out|forc/i);

    gate.release();
    await inFlight;
  });

  it('a failing close() is reported on stderr and exits non-zero', async () => {
    const h = harness();
    const running = await startMain(h);
    // Close the underlying server behind main's back so its close() fails.
    await new Promise<void>((resolve) => {
      running.server.close(() => {
        resolve();
      });
    });

    h.signals.emit('SIGTERM', 'SIGTERM');
    expect(await exitCode(h)).not.toBe(0);
    expect(h.stderr.text).not.toBe('');
  });
});

describe('listen error (contract P5)', () => {
  it('P5: port in use → startup lines, clear error on stderr, rejection', async () => {
    const holder = await listenOnLoopback(() => undefined);
    try {
      const h = harness({ port: holder.port });
      const attempt = main(h.options);
      await expect(attempt).rejects.toMatchObject({ code: 'EADDRINUSE' });
      // Go prints the two lines before it binds, so they appear even on failure.
      expect(h.stdout.text).toBe(STARTUP);
      expect(h.stderr.text).toMatch(/EADDRINUSE|address already in use/i);
      expect(h.stderr.text).toContain(String(holder.port));
      // No shutdown handlers are left behind for a server that never started.
      expect(h.signals.listenerCount('SIGTERM')).toBe(0);
      expect(h.exit).not.toHaveBeenCalled();
    } finally {
      await holder.close();
    }
  });
});
