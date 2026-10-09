/**
 * Pure mapping from a process environment to the JSON response body.
 *
 * No I/O and no access to `process.env` here: callers pass the environment in,
 * so unit tests (#22) can feed crafted entries that docker and `child_process`
 * cannot create (no `=`, empty name, see docs/behaviour-contract.md D1/D5).
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
 * Adds `name` as an own, enumerable property. A plain assignment would treat a
 * variable literally named `__proto__` as a prototype change and drop it.
 */
function define(record: EnvRecord, name: string, value: string): void {
  Object.defineProperty(record, name, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * Builds the response object from an environment.
 *
 * Contract (docs/behaviour-contract.md section 4): split on the first `=` (B2),
 * keep empty values (B3), first duplicate wins (B4), skip empty entries (B5) and
 * entries without `=` (D1), preserve names and values exactly (B7, B8).
 * Entries with an empty name (`=val`) are skipped, as `process.env` cannot see
 * them either (D5).
 */
export function envToRecord(env: EnvSource): EnvRecord {
  const record: EnvRecord = {};
  if (Array.isArray(env)) {
    const entries: readonly string[] = env;
    for (const entry of entries) {
      const eq = entry.indexOf('=');
      // -1: no `=` (D1, Go panics); 0: empty name (D5). Both cover "" (B5).
      if (eq <= 0) continue;
      const name = entry.slice(0, eq);
      if (Object.hasOwn(record, name)) continue; // first duplicate wins (B4)
      define(record, name, entry.slice(eq + 1));
    }
    return record;
  }
  const vars = env as Readonly<NodeJS.ProcessEnv>;
  for (const name of Object.keys(vars)) {
    const value = vars[name];
    if (name === '' || value === undefined) continue;
    define(record, name, value);
  }
  return record;
}

const HEX = '0123456789abcdef';

/** Characters that need escaping (or replacement) in Go's `json.Marshal` output. */
// eslint-disable-next-line no-control-regex
const NEEDS_ESCAPE = /[\u0000-\u001f"\\<>&\u2028\u2029\ud800-\udfff]/;

/**
 * Quotes a string the way Go's `json.Marshal` does (HTML-safe escaping, B11):
 * `"` and `\` as `\"` `\\`; `\b` `\f` `\n` `\r` `\t` as short escapes; other
 * control characters and `<` `>` `&` U+2028 U+2029 as `\u00XX`/`\u20XX`; all
 * other characters raw. A lone UTF-16 surrogate (not valid Unicode, so it has
 * no UTF-8 encoding) becomes a raw U+FFFD, as Go 1.25+ does for invalid UTF-8.
 */
function quote(s: string): string {
  if (!NEEDS_ESCAPE.test(s)) return `"${s}"`;
  let out = '"';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep: string;
    if (c >= 0xd800 && c <= 0xdfff) {
      const next = s.charCodeAt(i + 1); // NaN past the end
      if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        i++; // valid surrogate pair: copy as is
        continue;
      }
      rep = '\ufffd';
    } else if (
      c >= 0x20 &&
      c !== 0x22 &&
      c !== 0x5c &&
      c !== 0x3c &&
      c !== 0x3e &&
      c !== 0x26 &&
      c !== 0x2028 &&
      c !== 0x2029
    ) {
      continue;
    } else if (c === 0x22) {
      rep = '\\"';
    } else if (c === 0x5c) {
      rep = '\\\\';
    } else if (c === 0x08) {
      rep = '\\b';
    } else if (c === 0x0c) {
      rep = '\\f';
    } else if (c === 0x0a) {
      rep = '\\n';
    } else if (c === 0x0d) {
      rep = '\\r';
    } else if (c === 0x09) {
      rep = '\\t';
    } else {
      rep = `\\u${HEX.charAt(c >> 12)}${HEX.charAt((c >> 8) & 0xf)}${HEX.charAt((c >> 4) & 0xf)}${HEX.charAt(c & 0xf)}`;
    }
    out += s.slice(start, i) + rep;
    start = i + 1;
  }
  return `${out}${s.slice(start)}"`;
}

/** Orders keys by their UTF-8 bytes, like Go's sorted map keys (B10). */
function compareUtf8(a: { bytes: Buffer }, b: { bytes: Buffer }): number {
  return Buffer.compare(a.bytes, b.bytes);
}

/**
 * Serializes an env record to the exact response body bytes (as a string).
 *
 * Contract: a flat JSON object (B1), no trailing newline (B12), keys sorted by
 * UTF-8 byte value (B10) and Go `json.Marshal` escaping (B11). There is no `{}`
 * fallback: serializing strings cannot fail (D4).
 */
export function serializeEnv(record: Readonly<EnvRecord>): string {
  const parts = Object.entries(record)
    .map(([key, value]) => ({ key, value, bytes: Buffer.from(key, 'utf8') }))
    .sort(compareUtf8)
    .map(({ key, value }) => `${quote(key)}:${quote(value)}`);
  return `{${parts.join(',')}}`;
}
