// Loopback-only HTTP helpers for the handler/server/main suites (#23).
import { request as httpRequest } from 'node:http';
import type { Agent, IncomingHttpHeaders, RequestListener, Server } from 'node:http';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';

export const LOOPBACK = '127.0.0.1';

/** A raw response: status, headers and the exact body bytes. */
export interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

export interface SendOptions {
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Defaults to `false` (a fresh connection per request, closed afterwards). */
  readonly agent?: Agent | false;
}

/** Sends one request to `127.0.0.1:<port>` and buffers the whole response. */
export function send(port: number, options: SendOptions = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: LOOPBACK,
        port,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        headers: options.headers ?? {},
        agent: options.agent ?? false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

/**
 * Writes raw bytes on a fresh TCP connection and returns everything the server
 * sends until it closes the connection (for HTTP/1.0 and non-standard methods,
 * which `http.request` cannot produce or normalizes).
 */
export function sendRaw(port: number, raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: LOOPBACK, port });
    const chunks: Buffer[] = [];
    socket.on('connect', () => socket.end(raw));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      resolve(Buffer.concat(chunks).toString('latin1'));
    });
  });
}

/** A plain `node:http` server around a listener, on a random loopback port. */
export interface TestServer {
  readonly server: Server;
  readonly port: number;
  close(): Promise<void>;
}

/** Hosts `listener` on `127.0.0.1:0`, independently of `startServer`. */
export async function listenOnLoopback(listener: RequestListener): Promise<TestServer> {
  const server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

/** Headers that `node:http` adds on its own and the contract treats as transport (H4, D8). */
export const TRANSPORT_HEADERS: readonly string[] = [
  'date',
  'connection',
  'keep-alive',
  'transfer-encoding',
];
