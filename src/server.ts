/**
 * HTTP server lifecycle: listen and graceful close.
 */
import { createServer } from 'node:http';
import type { RequestListener, Server } from 'node:http';
import type { AddressInfo, ListenOptions } from 'node:net';

import { createHandler } from './handler.js';

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
   * responses finish, then resolve. Idle keep-alive connections are closed at
   * once. Calling it again returns the same promise.
   */
  close(): Promise<void>;
}

/** Starts listening and resolves once the port is bound; rejects on a bind error (contract P5). */
export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const server = createServer(options.handler ?? createHandler());
  const listen: ListenOptions = { port: options.port ?? PORT };
  // No host means all interfaces (`::` dual-stack, or `0.0.0.0`), like Go's `:8080`.
  if (options.host !== undefined) listen.host = options.host;

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      reject(err);
    };
    server.once('error', onError);
    server.listen(listen, () => {
      server.off('error', onError);
      resolve();
    });
  });

  let closing: Promise<void> | undefined;
  return {
    server,
    address: server.address() as AddressInfo,
    close(): Promise<void> {
      closing ??= new Promise<void>((resolve, reject) => {
        // Stops accepting; the callback runs once every connection has ended.
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
        // Busy connections are closed by node:http after their response ends.
        server.closeIdleConnections();
      });
      return closing;
    },
  };
}
