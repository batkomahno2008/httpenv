// Sample test so `npm test` runs. The real unit-test suites land in #22 and #23.
import { describe, expect, it } from 'vitest';

import { PORT } from '../src/server.js';

describe('scaffold', () => {
  it('listens on the contract port', () => {
    expect(PORT).toBe(8080);
  });
});
