/**
 * Pure mapping from a process environment to the JSON response body.
 *
 * No I/O and no access to `process.env` here: callers pass the environment in,
 * so unit tests (#22) can feed crafted entries that docker and `child_process`
 * cannot create (no `=`, empty name, see docs/behaviour-contract.md D1/D5).
 *
 * SCAFFOLD (#29): signatures only. The implementation lands in #30.
 */

/**
 * An environment in one of two shapes:
 * - an object such as `process.env` (`undefined` values are skipped);
 * - raw `envp`-style entries such as `["FOO=bar", "EQ=a=b=c"]`.
 */
export type EnvSource = Readonly<NodeJS.ProcessEnv> | readonly string[];

/** Flat map of variable name to value; every key and value is a string (contract B1). */
export type EnvRecord = Record<string, string>;

/**
 * Builds the response object from an environment.
 *
 * Contract (docs/behaviour-contract.md section 4): split on the first `=` (B2),
 * keep empty values (B3), first duplicate wins (B4), skip empty entries (B5) and
 * entries without `=` (D1), preserve names and values exactly (B7, B8).
 */
export function envToRecord(_env: EnvSource): EnvRecord {
  throw new Error('envToRecord: not implemented yet (#30)');
}

/**
 * Serializes an env record to the exact response body bytes (as a string).
 *
 * Contract: a flat JSON object (B1), no trailing newline (B12). Keys SHOULD be
 * sorted by byte value (B10) and escaping SHOULD match Go's `json.Marshal` (B11).
 */
export function serializeEnv(_record: Readonly<EnvRecord>): string {
  throw new Error('serializeEnv: not implemented yet (#30)');
}
