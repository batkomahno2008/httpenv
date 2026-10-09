/**
 * HTTP server lifecycle: listen and graceful close.
 *
 * SCAFFOLD (#29): signatures only. The implementation lands in #30.
 */
import type { RequestListener, Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The only port the app listens on (contract P1; no port configuration, P2). */
export const PORT = 8080;

/** Options for {@link startServer}. */
export interface StartServerOptions {
  /** Request listener. Defaults to `createHandler()` from `./handler.js`. */
  readonly handler?: RequestListener;
  /** Port to bind. Defaults to {@link PORT}. Tests pass `0` for a random free port. */
  readonly port?: number;
  /** Host to bind. Defaults to all interfaces (contract P1). Tests may pass `127.0.0.1`. */
  readonly host?: string;
}

/** A listening server. */
export interface RunningServer {
  readonly server: Server;
  /** The bound address (use `.port` when listening on port `0`). */
  readonly address: AddressInfo;
  /**
   * Graceful shutdown (contract D3): stop accepting connections, let in-flight
   * responses finish, then resolve.
   */
  close(): Promise<void>;
}

/** Starts listening and resolves once the port is bound; rejects on a bind error (contract P5). */
export function startServer(_options?: StartServerOptions): Promise<RunningServer> {
  return Promise.reject(new Error('startServer: not implemented yet (#30)'));
}
