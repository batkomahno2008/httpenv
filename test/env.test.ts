// Unit tests for the pure env mapping (#22).
//
// Spec: docs/behaviour-contract.md section 4 (B1-B12) and the intentional
// differences D1, D5 and D10. Every test name starts with the contract ID it
// covers. Expected serializer bytes were produced with Go
// `json.Marshal(map[string]string)` (the reference implementation), checked on
// Go 1.24.7 and on Go 1.27.2 (current `golang:alpine` in the Dockerfile). The
// two agree on every byte except how invalid UTF-8 is written (see B9 below).
import { describe, expect, it } from 'vitest';

import { envToRecord, serializeEnv } from '../src/env.js';
import type { EnvRecord, EnvSource } from '../src/env.js';

/** Copies own enumerable properties into a plain object, so the assertions do
 * not depend on whether the implementation uses a null-prototype record. */
function plain(record: Readonly<EnvRecord>): EnvRecord {
  return { ...record };
}

/** Builds a record whose keys may include `__proto__` as an own property. */
function rec(entries: readonly (readonly [string, string])[]): EnvRecord {
  const out: EnvRecord = {};
  for (const [key, value] of entries) {
    Object.defineProperty(out, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

const KIB_64 = 64 * 1024;
const longValue = 'x'.repeat(KIB_64 - 1) + 'é';
const longName = 'N'.repeat(KIB_64);

describe('envToRecord with envp-style string entries', () => {
  const cases: readonly { name: string; env: readonly string[]; expected: EnvRecord }[] = [
    {
      name: 'B1 plain KEY=value pairs',
      env: ['FOO=bar', 'BAZ=qux'],
      expected: { FOO: 'bar', BAZ: 'qux' },
    },
    { name: 'B2 splits on the first "=" only', env: ['EQ=a=b=c'], expected: { EQ: 'a=b=c' } },
    { name: 'B2 value that is only "="', env: ['EQ=='], expected: { EQ: '=' } },
    { name: 'B3 empty value is kept', env: ['EMPTY='], expected: { EMPTY: '' } },
    { name: 'B4 first duplicate wins', env: ['A=first', 'A=second'], expected: { A: 'first' } },
    {
      name: 'B4 first duplicate wins even when the first value is empty',
      env: ['A=', 'A=second', 'A=third'],
      expected: { A: '' },
    },
    {
      name: 'B4 first duplicate wins for names that exist on Object.prototype',
      env: ['constructor=1', 'constructor=2', 'toString=a', 'hasOwnProperty=h', 'valueOf=v'],
      expected: { constructor: '1', toString: 'a', hasOwnProperty: 'h', valueOf: 'v' },
    },
    { name: 'B5 empty entry is skipped', env: ['', 'FOO=bar', ''], expected: { FOO: 'bar' } },
    { name: 'B6 empty environment gives {}', env: [], expected: {} },
    {
      name: 'B6 environment of only skipped entries gives {}',
      env: ['', 'NOEQ', '=x'],
      expected: {},
    },
    {
      name: 'B7 names keep case and punctuation',
      env: ['parity_lowercase=1', 'PARITY.DOT-DASH=2', 'a=3', 'A=4', ' SP ACE =5'],
      expected: { parity_lowercase: '1', 'PARITY.DOT-DASH': '2', a: '3', A: '4', ' SP ACE ': '5' },
    },
    {
      name: 'B8 values are preserved exactly',
      env: [
        'SPACES=  lead and trail  ',
        'QUOTE="q"\\back',
        'NL=line1\nline2',
        'TAB=a\tb',
        'CR=a\rb',
        'CTL=\u0001\u0000\u001f\u007f',
        'LS=x\u2028y\u2029z',
        'HTML=<a href="x">&amp;</a>',
      ],
      expected: {
        SPACES: '  lead and trail  ',
        QUOTE: '"q"\\back',
        NL: 'line1\nline2',
        TAB: 'a\tb',
        CR: 'a\rb',
        CTL: '\u0001\u0000\u001f\u007f',
        LS: 'x\u2028y\u2029z',
        HTML: '<a href="x">&amp;</a>',
      },
    },
    {
      name: 'B7/B8 unicode names and values are preserved',
      env: ['UNI=héllo 日本 🚀', 'ÜNÏ_日本=🚀', '😀=astral name'],
      expected: { UNI: 'héllo 日本 🚀', ÜNÏ_日本: '🚀', '😀': 'astral name' },
    },
    {
      name: 'B8 long (64 KiB) value is preserved',
      env: [`LONG=${longValue}`],
      expected: { LONG: longValue },
    },
    {
      name: 'B7 long (64 KiB) name is preserved',
      env: [`${longName}=v`],
      expected: { [longName]: 'v' },
    },
    { name: 'D1 entry without "=" is skipped', env: ['NOEQ', 'FOO=bar'], expected: { FOO: 'bar' } },
    {
      name: 'D1 entry without "=" between valid entries does not affect them',
      env: ['A=1', 'JUNK', 'B=2', 'MORE JUNK'],
      expected: { A: '1', B: '2' },
    },
    {
      name: 'D5 empty-name entry "=val" is skipped',
      env: ['=val', 'FOO=bar'],
      expected: { FOO: 'bar' },
    },
    { name: 'D5 bare "=" entry is skipped', env: ['=', 'FOO=bar'], expected: { FOO: 'bar' } },
    {
      name: 'D5 Windows-style "=C:=C:\\" entries are skipped',
      env: ['=C:=C:\\', '=ExitCode=00000000', 'PATH=C:\\Windows'],
      expected: { PATH: 'C:\\Windows' },
    },
  ];

  it.each(cases)('$name', ({ env, expected }) => {
    expect(plain(envToRecord(env))).toStrictEqual(expected);
  });

  it('B7 "__proto__" is kept as an own property, not used as the prototype', () => {
    const record = envToRecord(['__proto__=x', 'A=1']);
    expect(Object.prototype.hasOwnProperty.call(record, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(record, '__proto__')?.value).toBe('x');
    expect(JSON.parse(serializeEnv(record))).toStrictEqual(
      JSON.parse('{"A":"1","__proto__":"x"}') as unknown,
    );
  });

  it('B1 every value is a string', () => {
    const record = envToRecord(['A=1', 'B=', 'C=true', 'D=null', 'E={}']);
    for (const value of Object.values(record)) {
      expect(typeof value).toBe('string');
    }
    expect(plain(record)).toStrictEqual({ A: '1', B: '', C: 'true', D: 'null', E: '{}' });
  });

  it('B1 does not mutate the input array', () => {
    const env = Object.freeze(['A=1', 'NOEQ', '=x']);
    envToRecord(env);
    expect(env).toStrictEqual(['A=1', 'NOEQ', '=x']);
  });
});

describe('envToRecord with a process.env-style object', () => {
  const cases: readonly { name: string; env: EnvSource; expected: EnvRecord }[] = [
    {
      name: 'B1 copies string values',
      env: { FOO: 'bar', EQ: 'a=b=c' },
      expected: { FOO: 'bar', EQ: 'a=b=c' },
    },
    { name: 'B3 empty value is kept', env: { EMPTY: '' }, expected: { EMPTY: '' } },
    { name: 'B6 empty object gives {}', env: {}, expected: {} },
    {
      name: 'B1 undefined values are skipped',
      env: { FOO: 'bar', GONE: undefined },
      expected: { FOO: 'bar' },
    },
    { name: 'B6 only undefined values gives {}', env: { GONE: undefined }, expected: {} },
    {
      name: 'B7/B8 unicode, control characters and long values are preserved',
      env: { UNI: 'héllo 日本 🚀', 日本: 'x', CTL: '\u0001\t\n', LONG: longValue },
      expected: { UNI: 'héllo 日本 🚀', 日本: 'x', CTL: '\u0001\t\n', LONG: longValue },
    },
    {
      name: 'B7 names that exist on Object.prototype are copied',
      env: { constructor: 'c', toString: 't' },
      expected: { constructor: 'c', toString: 't' },
    },
  ];

  it.each(cases)('$name', ({ env, expected }) => {
    expect(plain(envToRecord(env))).toStrictEqual(expected);
  });

  it('D5 an empty name is skipped like in the string form', () => {
    expect(plain(envToRecord({ '': 'val', FOO: 'bar' }))).toStrictEqual({ FOO: 'bar' });
  });

  it('B7 an own "__proto__" key is kept as an own property', () => {
    const env = rec([['__proto__', 'x']]);
    const record = envToRecord(env);
    expect(Object.getOwnPropertyDescriptor(record, '__proto__')?.value).toBe('x');
  });

  it('B1 the result is a copy, not the input object', () => {
    const env: NodeJS.ProcessEnv = { FOO: 'bar' };
    const record = envToRecord(env);
    env['FOO'] = 'changed';
    expect(record['FOO']).toBe('bar');
  });

  it('B1 works on the real process.env (every value is a string)', () => {
    const record = envToRecord(process.env);
    for (const [key, value] of Object.entries(process.env)) {
      if (key !== '' && value !== undefined) {
        expect(record[key]).toBe(value);
      }
    }
  });
});

describe('serializeEnv', () => {
  it('B6/B12 empty record is exactly "{}"', () => {
    expect(serializeEnv({})).toBe('{}');
  });

  it('B1/B12 flat object, no whitespace, no trailing newline', () => {
    const body = serializeEnv({ FOO: 'bar' });
    expect(body).toBe('{"FOO":"bar"}');
    expect(body.endsWith('}')).toBe(true);
  });

  const sortCases: readonly { name: string; record: EnvRecord; expected: string }[] = [
    {
      name: 'B10 keys sorted by byte value, not insertion order',
      record: { b: '2', a: '1', c: '3' },
      expected: '{"a":"1","b":"2","c":"3"}',
    },
    {
      name: 'B10 uppercase < "_" < lowercase (byte order, not locale order)',
      record: { a: '2', _: '3', B: '1', A: '0', '0': 'n' },
      expected: '{"0":"n","A":"0","B":"1","_":"3","a":"2"}',
    },
    {
      name: 'B10 prefix sorts first',
      record: { AB: '2', A: '1', A_: '3' },
      expected: '{"A":"1","AB":"2","A_":"3"}',
    },
    {
      // UTF-16 code-unit order would put U+1F600 (D83D DE00) before U+FF01;
      // UTF-8 byte order (EF BC 81 < F0 9F 98 80) puts U+FF01 first, as Go does.
      name: 'B10 UTF-8 byte order, not UTF-16 code-unit order',
      record: { '😀': 'k2', '！': 'k1', é: 'k0' },
      expected: '{"é":"k0","！":"k1","😀":"k2"}',
    },
    {
      // Array-index-like keys are ordered first by JS objects; the body must not be.
      name: 'B10 integer-like keys are sorted as strings',
      record: { B: 'b', '10': 'ten', '9': 'nine', '1': 'one' },
      expected: '{"1":"one","10":"ten","9":"nine","B":"b"}',
    },
  ];

  it.each(sortCases)('$name', ({ record, expected }) => {
    expect(serializeEnv(record)).toBe(expected);
  });

  // Escaping: expected bytes are Go json.Marshal output (identical on 1.24.7 and 1.27.2
  // except the B9 rows).
  const escapeCases: readonly { name: string; value: string; expected: string }[] = [
    {
      name: 'B11 "<", ">", "&" as \\u003c, \\u003e, \\u0026',
      value: '<a>&',
      expected: '"\\u003ca\\u003e\\u0026"',
    },
    {
      name: 'B11 U+2028/U+2029 as \\u2028/\\u2029',
      value: 'x\u2028y\u2029',
      expected: '"x\\u2028y\\u2029"',
    },
    { name: 'B11 \\n \\r \\t short escapes', value: '\n\r\t', expected: '"\\n\\r\\t"' },
    // Go >= 1.22 writes \b and \f as short escapes (observed with Go 1.24.7).
    {
      name: 'B11 backspace and form feed as \\b and \\f (Go >= 1.22)',
      value: '\b\f',
      expected: '"\\b\\f"',
    },
    {
      name: 'B11 other control characters as \\u00XX',
      value: '\u0000\u0001\u0007\u000b\u000e\u001b\u001f',
      expected: '"\\u0000\\u0001\\u0007\\u000b\\u000e\\u001b\\u001f"',
    },
    { name: 'B11 DEL (0x7f) is written raw', value: '\u007f', expected: '"\u007f"' },
    { name: 'B11 quote and backslash escaped, "/" raw', value: '"\\/', expected: '"\\"\\\\/"' },
    {
      name: 'B11 non-ASCII written as raw UTF-8',
      value: 'héllo 日本 🚀',
      expected: '"héllo 日本 🚀"',
    },
    // A JS string cannot hold invalid UTF-8; a lone surrogate is the analogue.
    // Go replaces each invalid byte with U+FFFD (B9). Go <= 1.24 writes it as the
    // escape \ufffd; Go >= 1.25 (1.27.2 observed, the Dockerfile reference)
    // writes a raw U+FFFD. The bytes are D10/SHOULD; the tests follow the
    // current reference. The decoded value (U+FFFD) is the MUST, tested below.
    { name: 'B9/B11 lone high surrogate becomes U+FFFD', value: '\uD800', expected: '"\uFFFD"' },
    {
      name: 'B9/B11 lone low surrogate becomes U+FFFD',
      value: 'a\uDC00b',
      expected: '"a\uFFFDb"',
    },
    {
      name: 'B9/B11 reversed surrogate pair gives two U+FFFD',
      value: '\uDE00\uD83D',
      expected: '"\uFFFD\uFFFD"',
    },
    { name: 'B9/B11 high surrogate at end of string', value: 'ok\uD83D', expected: '"ok\uFFFD"' },
    { name: 'B9/B11 literal U+FFFD is written raw', value: '\uFFFD', expected: '"\uFFFD"' },
  ];

  it.each(escapeCases)('$name (value)', ({ value, expected }) => {
    expect(serializeEnv({ K: value })).toBe(`{"K":${expected}}`);
  });

  it.each(escapeCases)('$name (key)', ({ value, expected }) => {
    expect(serializeEnv(rec([[value, 'v']]))).toBe(`{${expected}:"v"}`);
  });

  it('B9 a lone surrogate decodes to U+FFFD after JSON.parse', () => {
    const body = serializeEnv({ BAD: '\uD800', [`\uDC00`]: 'k' });
    const parsed = JSON.parse(body) as EnvRecord;
    expect(parsed).toStrictEqual({ BAD: '\uFFFD', '\uFFFD': 'k' });
    // The body must hold no lone surrogate, so it encodes to valid UTF-8.
    expect(body).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });

  it('B10/B11 HTML in keys is escaped and sorted by the raw key bytes', () => {
    // Go sorts the unescaped keys: "<k>&" (0x3c) sorts before "A" (0x41).
    expect(serializeEnv({ A: '1', '<k>&': 'v' })).toBe('{"\\u003ck\\u003e\\u0026":"v","A":"1"}');
  });

  it('B7 own "__proto__" key is serialized like any other key', () => {
    expect(
      serializeEnv(
        rec([
          ['__proto__', 'x'],
          ['A', '1'],
        ]),
      ),
    ).toBe('{"A":"1","__proto__":"x"}');
  });

  const roundTrips: readonly { name: string; record: EnvRecord }[] = [
    { name: 'B1 empty', record: {} },
    { name: 'B2/B3 "=" and empty values', record: { EQ: 'a=b=c', EMPTY: '' } },
    {
      name: 'B8 every control character, quotes, backslashes, separators',
      record: {
        CTL: Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)).join(''),
        QUOTE: '"q"\\back',
        LS: '\u2028\u2029',
        HTML: '<a href="x">&amp;</a>',
      },
    },
    {
      name: 'B7/B8 unicode keys and values',
      record: { UNI: 'héllo 日本 🚀', 日本: '🚀', '😀': 'é' },
    },
    { name: 'B8 64 KiB value and name', record: { LONG: longValue, [longName]: 'v' } },
  ];

  it.each(roundTrips)('B1 JSON.parse round-trips: $name', ({ record }) => {
    expect(JSON.parse(serializeEnv(record))).toStrictEqual(record);
  });

  it('B1 does not mutate the input record', () => {
    const record = Object.freeze({ B: '2', A: '<1>' });
    serializeEnv(record);
    expect(record).toStrictEqual({ B: '2', A: '<1>' });
  });
});

describe('Go reference probe body (contract section 4)', () => {
  // Exact Go 1.24.7 body from docs/behaviour-contract.md section 4.
  const goBody124 =
    '{"BAD":"\\ufffd\\ufffd","CTL":"\\u0001\\t","EMPTY":"","EQ":"a=b=c","FOO":"bar",' +
    '"HTML":"\\u003ca href=\\"x\\"\\u003e\\u0026amp;\\u003c/a\\u003e","LS":"x\\u2028y",' +
    '"NL":"line1\\nline2","QUOTE":"\\"q\\"\\\\back","UNI":"héllo 日本 🚀"}';
  // Go >= 1.25 (1.27.2 observed): identical except BAD is two raw U+FFFD.
  const goBody = goBody124.replace('"BAD":"\\ufffd\\ufffd"', '"BAD":"\uFFFD\uFFFD"');

  const probeWithoutBad: readonly string[] = [
    'FOO=bar',
    'EQ=a=b=c',
    'EMPTY=',
    'HTML=<a href="x">&amp;</a>',
    'UNI=héllo 日本 🚀',
    'QUOTE="q"\\back',
    'NL=line1\nline2',
    'LS=x\u2028y',
    'CTL=\u0001\t',
  ];

  it('B1-B12 probe env without BAD gives the Go body minus BAD', () => {
    // BAD=<FF FE> (invalid UTF-8) cannot be expressed in a JS string, so it is
    // left out here and covered by the lone-surrogate cases above (B9).
    const expected = goBody124.replace('"BAD":"\\ufffd\\ufffd",', '');
    expect(serializeEnv(envToRecord(probeWithoutBad))).toBe(expected);
  });

  it('B9 with BAD as two lone surrogates the body matches Go 1.27.2 byte for byte', () => {
    // Two lone low surrogates are the closest JS analogue of two invalid bytes.
    const env = [...probeWithoutBad, 'BAD=\uDCFF\uDCFE'];
    expect(serializeEnv(envToRecord(env))).toBe(goBody);
  });

  it('D1/D5/B4/B5 malformed and duplicate entries do not change the Go body', () => {
    const env = [
      '',
      'NOEQ',
      '=val',
      '=C:=C:\\',
      ...probeWithoutBad,
      'FOO=later',
      'BAD=\uDCFF\uDCFE',
    ];
    expect(serializeEnv(envToRecord(env))).toBe(goBody);
  });

  it('D10 decoded JSON equals the decoded Go 1.24.7 body from the contract', () => {
    const env = [...probeWithoutBad, 'BAD=\uDCFF\uDCFE'];
    expect(JSON.parse(serializeEnv(envToRecord(env)))).toStrictEqual(
      JSON.parse(goBody124) as unknown,
    );
  });
});
