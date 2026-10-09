#!/usr/bin/env node
// parity-mutant.mjs - a deliberately non-reference httpenv used ONLY to prove
// that scripts/parity-diff.mjs works (see scripts/parity-selftest.sh).
// It is NOT the TypeScript port and must not be used as one.
//
//   PARITY_MUTANT=conforming  behaves like the intended TS port: only the
//                             allow-listed differences from the Go server.
//   PARITY_MUTANT=broken      additionally introduces unexplained differences
//                             (extra env key, changed value, wrong status on a
//                             path, different startup line).
//
// PARITY_MUTANT and PARITY_MUTANT_PORT are removed from the served env so the
// mutant's own configuration does not show up as a difference.
import http from 'node:http';

const mode = process.env.PARITY_MUTANT ?? 'conforming';
const port = Number(process.env.PARITY_MUTANT_PORT ?? 8080);
delete process.env.PARITY_MUTANT;
delete process.env.PARITY_MUTANT_PORT;
const broken = mode === 'broken';

function body() {
  const env = {};
  for (const k of Object.keys(process.env).sort()) env[k] = process.env[k];
  if (broken) {
    env.PARITY_EXTRA = 'only in mutant';
    if ('PARITY_SIMPLE' in env) env.PARITY_SIMPLE = 'changed';
  }
  return JSON.stringify(env);
}

const server = http.createServer((req, res) => {
  const payload = body();
  res.statusCode = broken && req.url === '/favicon.ico' ? 404 : 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.end(payload);
});

process.stdout.write(broken
  ? 'Starting mutant httpenv on port 8080\n'
  : 'Starting httpenv listening on port 8080.Please stand by...\n'
    + 'Why did the cat refuse to play cards with the dog? Because every time he got a good hand, he wagged his tail!\n');
server.listen(port);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
