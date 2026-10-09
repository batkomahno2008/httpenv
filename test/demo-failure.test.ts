// [DEMO - do not merge] proves a failing unit test and a lint error fail CI (#32)
import { describe, expect, it } from 'vitest';

describe('CI failure demo', () => {
  it('fails on purpose', () => {
    const unused = 1;
    expect(1 + 1).toBe(3);
  });
});
