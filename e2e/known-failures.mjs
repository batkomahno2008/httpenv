// known-failures.mjs - the explicit list of scenarios that are EXPECTED to fail
// for a given implementation (selected with E2E_IMPL / --impl).
//
// An expected failure still runs. It is reported as passing ("XFAIL") only if
// it fails with an assertion error whose message matches `symptom`, i.e. the
// documented defect and nothing else. If it passes, the run fails ("XPASS"),
// so a fixed defect cannot hide here. Any other error (container not ready,
// docker error, a different assertion) fails the run as usual.
//
// Every entry must point at a row of docs/behaviour-contract.md.
// The default implementation is `ts`, which has no known failures: strict.

export const KNOWN_FAILURES = {
  go: {
    'content-type': {
      ref: 'D2',
      reason:
        'Go does not set Content-Type; net/http content-sniffs the JSON body and sends ' +
        '"text/plain; charset=utf-8" (docs/behaviour-contract.md H2, D2).',
      symptom: /text\/plain/,
    },
  },
  ts: {},
};

export const IMPLS = Object.keys(KNOWN_FAILURES);
