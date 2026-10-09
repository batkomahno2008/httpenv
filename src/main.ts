/**
 * Process entry point: `node dist/main.js`.
 */
import { pathToFileURL } from 'node:url';

import { PORT, startServer } from './server.js';
import type { RunningServer } from './server.js';

/** The two startup lines, byte for byte as the Go version prints them (contract P3). */
export const STARTUP_MESSAGE =
  'Starting httpenv listening on port 8080.Please stand by...\n' +
  'Why did the cat refuse to play cards with the dog? Because every time he got a good hand, he wagged his tail!\n';

/** Default upper bound for a graceful shutdown, well inside Docker's 10 s grace period. */
export const SHUTDOWN_TIMEOUT_MS = 5000;

/** Something signal listeners can be attached to, such as `process`. */
export interface SignalTarget {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

/** Injectable process dependencies, so #23 can test startup and signals without a real process. */
export interface MainOptions {
  /** Where the two startup lines are written (contract P3). Defaults to `process.stdout`. */
  readonly stdout?: NodeJS.WritableStream;
  /** Where a bind error or a forced shutdown is reported. Defaults to `process.stderr`. */
  readonly stderr?: NodeJS.WritableStream;
  /** Signals that trigger graceful shutdown (contract D3). Defaults to `['SIGTERM', 'SIGINT']`. */
  readonly signals?: readonly NodeJS.Signals[];
  /** Where signal listeners are installed. Defaults to `process`. */
  readonly signalTarget?: SignalTarget;
  /** Ends the process after shutdown: 0 when graceful, 1 when forced or failed. Defaults to `process.exit`. */
  readonly exit?: (code: number) => void;
  /** Port to bind. Defaults to {@link PORT}; tests only (no port configuration, contract P2). */
  readonly port?: number;
  /** Host to bind. Defaults to all interfaces (contract P1); tests only. */
  readonly host?: string;
  /** How long in-flight requests may take after a signal before a forced exit. Defaults to {@link SHUTDOWN_TIMEOUT_MS}. */
  readonly shutdownTimeoutMs?: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Prints the startup lines, starts the server on port 8080 and installs the
 * shutdown handlers. Resolves with the running server once it is listening.
 * On a bind error, reports it on stderr and rejects (contract P5).
 *
 * On the first signal: stop accepting, close idle connections, let in-flight
 * responses finish, then `exit(0)`. If that takes longer than the shutdown
 * timeout, `exit(1)` (the timer is unref'd, so it never keeps the process alive).
 */
export async function main(options: MainOptions = {}): Promise<RunningServer> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const signals = options.signals ?? ['SIGTERM', 'SIGINT'];
  const signalTarget = options.signalTarget ?? process;
  const exit = options.exit ?? ((code: number): void => process.exit(code));
  const timeoutMs = options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;

  // Go prints before it binds, so the lines appear even when the bind fails.
  stdout.write(STARTUP_MESSAGE);

  let running: RunningServer;
  try {
    running = await startServer({
      port: options.port ?? PORT,
      ...(options.host === undefined ? {} : { host: options.host }),
    });
  } catch (err: unknown) {
    stderr.write(`httpenv: ${errorMessage(err)}\n`);
    throw err;
  }

  let shuttingDown = false;
  const onSignal = (): void => {
    if (shuttingDown) return; // already draining; the timeout still bounds it
    shuttingDown = true;
    const timer = setTimeout(() => {
      stderr.write(
        `httpenv: graceful shutdown timed out after ${String(timeoutMs)} ms, forcing exit\n`,
      );
      exit(1);
    }, timeoutMs);
    timer.unref();
    running.close().then(
      () => {
        clearTimeout(timer);
        for (const signal of signals) signalTarget.off(signal, onSignal);
        exit(0);
      },
      (err: unknown) => {
        clearTimeout(timer);
        stderr.write(`httpenv: shutdown failed: ${errorMessage(err)}\n`);
        exit(1);
      },
    );
  };
  for (const signal of signals) signalTarget.on(signal, onSignal);

  return running;
}

/** True when this module is the process entry point (not imported by a test). */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntryPoint()) {
  // main already reported the error on stderr; nothing else keeps the event loop alive.
  main().catch(() => {
    process.exitCode = 1;
  });
}
