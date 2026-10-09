#!/usr/bin/env node
// run.mjs - entry point for the container e2e suite (e2e/httpenv.e2e.test.mjs).
// Maps command-line flags onto the suite's environment variables and runs it
// with the built-in `node --test` runner. Node.js built-ins only.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { IMPLS } from './known-failures.mjs';

const USAGE = `Usage: node e2e/run.mjs --image <ref> [options] [-- <extra node --test args>]

  --image REF          Image under test (default: $TESTING_IMAGE).
  --impl go|ts         Known-failure list to apply (default: $E2E_IMPL or ts = strict).
  --ready-timeout S    Seconds for GET / to answer 200 (default: $E2E_READY_TIMEOUT or 20).
  --stop-budget S      Seconds docker stop may take (default: $E2E_STOP_BUDGET or 3).
  --platform P         docker run --platform, e.g. linux/arm/v7 (default: $E2E_PLATFORM).
  -h, --help           Show this help.

Arguments after "--" go to node --test, e.g.
  -- --test-reporter=spec --test-reporter-destination=stdout \\
     --test-reporter=junit --test-reporter-destination=e2e-junit.xml

Exit codes: 0 = all scenarios passed (expected failures included),
            1 = a scenario failed, 2 = usage error.`;

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      image: { type: 'string' },
      impl: { type: 'string' },
      'ready-timeout': { type: 'string' },
      'stop-budget': { type: 'string' },
      platform: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
} catch (err) {
  console.error(`${err.message}\n\n${USAGE}`);
  process.exit(2);
}
const { values, positionals } = parsed;
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const env = { ...process.env };
const set = (key, value) => {
  if (value !== undefined && value !== '') env[key] = value;
};
set('TESTING_IMAGE', values.image);
set('E2E_IMPL', values.impl);
set('E2E_READY_TIMEOUT', values['ready-timeout']);
set('E2E_STOP_BUDGET', values['stop-budget']);
set('E2E_PLATFORM', values.platform);

const usageError = (msg) => {
  console.error(`${msg}\n\n${USAGE}`);
  process.exit(2);
};
if (!env.TESTING_IMAGE) usageError('No image: pass --image <ref> or set TESTING_IMAGE.');
if (env.E2E_IMPL && !IMPLS.includes(env.E2E_IMPL))
  usageError(`--impl/E2E_IMPL must be one of: ${IMPLS.join(', ')}.`);
for (const key of ['E2E_READY_TIMEOUT', 'E2E_STOP_BUDGET']) {
  if (env[key] !== undefined && env[key] !== '' && !(Number(env[key]) > 0))
    usageError(`${key} must be a positive number of seconds.`);
}

const suite = fileURLToPath(new URL('./httpenv.e2e.test.mjs', import.meta.url));
const child = spawn(process.execPath, ['--test', ...positionals, suite], { env, stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
