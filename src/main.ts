/**
 * Process entry point: `node dist/main.js`.
 *
 * SCAFFOLD (#29): signatures only. The implementation lands in #30.
 */
import { pathToFileURL } from 'node:url';

/** Injectable process dependencies, so #23 can test startup and signals without a real process. */
export interface MainOptions {
  /** Where the two startup lines are written (contract P3). Defaults to `process.stdout`. */
  readonly stdout?: NodeJS.WritableStream;
  /** Signals that trigger graceful shutdown (contract D3). Defaults to `['SIGTERM', 'SIGINT']`. */
  readonly signals?: readonly NodeJS.Signals[];
}

/**
 * Prints the startup lines, starts the server on port 8080 and installs the
 * shutdown handlers. Resolves once the server is listening.
 */
export function main(_options?: MainOptions): Promise<void> {
  return Promise.reject(new Error('main: not implemented yet (#30)'));
}

/** True when this module is the process entry point (not imported by a test). */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntryPoint()) {
  await main();
}
