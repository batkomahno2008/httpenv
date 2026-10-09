// Implementation-level checks for #30. The official env suite is #22 (test/env.test.ts).
import { describe, expect, it } from 'vitest';

import { envToRecord, serializeEnv } from '../src/env.js';

describe('envToRecord', () => {
  it('splits envp entries on the first "=" and keeps empty values', () => {
    expect(envToRecord(['FOO=bar', 'EQ=a=b=c', 'EMPTY='])).toEqual({
      FOO: 'bar',
      EQ: 'a=b=c',
      EMPTY: '',
    });
  });

  it('skips empty entries, entries without "=" and empty names; first duplicate wins', () => {
    expect(envToRecord(['', 'NOEQ', '=val', 'A=first', 'A=second'])).toEqual({ A: 'first' });
  });

  it('reads objects, skipping undefined values and the empty name', () => {
    expect(envToRecord({ A: '1', B: undefined, '': 'x', C: '' })).toEqual({ A: '1', C: '' });
  });

  it('keeps a variable named __proto__ as an own property', () => {
    const record = envToRecord(['__proto__=x']);
    expect(Object.keys(record)).toEqual(['__proto__']);
    expect(serializeEnv(record)).toBe('{"__proto__":"x"}');
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
  });
});

describe('serializeEnv', () => {
  it('matches the exact Go body for the contract probe environment', () => {
    const env = [
      'FOO=bar',
      'EQ=a=b=c',
      'EMPTY=',
      'HTML=<a href="x">&amp;</a>',
      'UNI=héllo 日本 🚀',
      'QUOTE="q"\\back',
      'NL=line1\nline2',
      'LS=x y',
      'BAD=��',
      'CTL=\u0001\t',
    ];
    // Contract section 4, with BAD written raw as Node decodes invalid UTF-8 (Go 1.25+ also writes it raw).
    expect(serializeEnv(envToRecord(env))).toBe(
      '{"BAD":"��","CTL":"\\u0001\\t","EMPTY":"","EQ":"a=b=c","FOO":"bar",' +
        '"HTML":"\\u003ca href=\\"x\\"\\u003e\\u0026amp;\\u003c/a\\u003e","LS":"x\\u2028y",' +
        '"NL":"line1\\nline2","QUOTE":"\\"q\\"\\\\back","UNI":"héllo 日本 🚀"}',
    );
  });

  it('escapes like Go json.Marshal (observed with Go 1.24 and 1.27)', () => {
    const value = '\u0000\u0001\b\f\n\r\t\u001f\u007f"\\/<>&  é😀';
    expect(serializeEnv({ ctl: value })).toBe(
      '{"ctl":"\\u0000\\u0001\\b\\f\\n\\r\\t\\u001f\u007f\\"\\\\/\\u003c\\u003e\\u0026\\u2028\\u2029é😀"}',
    );
  });

  it('replaces lone surrogates with U+FFFD and keeps valid pairs', () => {
    expect(serializeEnv({ S: 'a\ud800b\udc00c\ud83d' })).toBe('{"S":"a�b�c�"}');
    expect(JSON.parse(serializeEnv({ S: 'x😀' }))).toEqual({ S: 'x😀' });
  });

  it('sorts keys by UTF-8 bytes, not UTF-16 code units', () => {
    // UTF-16 order would put U+1F600 (surrogates D83D..) before U+FFFF.
    expect(serializeEnv({ '😀': 'y', '￿': 'x', a: '', Z: '' })).toBe(
      '{"Z":"","a":"","￿":"x","😀":"y"}',
    );
  });

  it('serializes an empty environment as {} with no trailing newline', () => {
    expect(serializeEnv({})).toBe('{}');
  });

  it('round-trips through JSON.parse', () => {
    const record = envToRecord(['K=v<>& \u0002"\\']);
    expect(JSON.parse(serializeEnv(record))).toEqual(record);
  });
});
