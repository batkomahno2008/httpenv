/**
 * HTTP request handler: answers every method and path with the env JSON.
 *
 * SCAFFOLD (#29): signatures only. The implementation lands in #30.
 */
import type { RequestListener } from 'node:http';

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
 * body length, no body for `HEAD`, no other application headers.
 */
export function createHandler(_options?: HandlerOptions): RequestListener {
  throw new Error('createHandler: not implemented yet (#30)');
}
