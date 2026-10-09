/**
 * HTTP request handler: answers every method and path with the env JSON.
 */
import type { RequestListener } from 'node:http';

import { envToRecord, serializeEnv } from './env.js';
import type { EnvSource } from './env.js';

/** Options for {@link createHandler}. */
export interface HandlerOptions {
  /**
   * Returns the environment to serve. Called once per request.
   * Defaults to `() => process.env`. Tests inject a fixed environment here.
   */
  readonly getEnv?: () => EnvSource;
}

/** Response `Content-Type` (contract D2). */
export const CONTENT_TYPE = 'application/json; charset=utf-8';

/**
 * Creates the `node:http` request listener.
 *
 * Contract (docs/behaviour-contract.md sections 2-3): status 200 for every path
 * and method, `Content-Type` {@link CONTENT_TYPE}, `Content-Length` equal to the
 * body length, no body for `HEAD`, no other application headers. The request
 * body, query string and headers are ignored.
 */
export function createHandler(options: HandlerOptions = {}): RequestListener {
  const getEnv = options.getEnv ?? ((): EnvSource => process.env);
  return (req, res) => {
    const body = Buffer.from(serializeEnv(envToRecord(getEnv())), 'utf8');
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPE,
      'Content-Length': body.length,
    });
    if (req.method === 'HEAD') {
      res.end();
    } else {
      res.end(body);
    }
  };
}
