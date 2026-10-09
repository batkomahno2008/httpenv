// Unit tests for the HTTP request handler (#23).
// Contract IDs refer to docs/behaviour-contract.md (sections 2, 3 and 6).
//
// D4: Go's unreachable `json.Marshal` error branch (`w.Write([]byte("{}"))`) is
// intentionally NOT ported, so there is no serializer-failure fallback to test.
// `createHandler` takes no serializer option on purpose; the "inject a failing
// serializer" case of #23 is satisfied by "the dead branch is removed".
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Agent } from 'node:http';

import type { EnvSource } from '../src/env.js';
import { envToRecord, serializeEnv } from '../src/env.js';
import { CONTENT_TYPE, createHandler } from '../src/handler.js';
import type { TestServer } from './helpers/http.js';
import { TRANSPORT_HEADERS, listenOnLoopback, send, sendRaw } from './helpers/http.js';

const ENV = {
  FOO: 'bar',
  EQ: 'a=b=c',
  EMPTY: '',
  UNI: 'héllo 日本 🚀',
  HTML: '<a href="x">&amp;</a>',
} as const;

let current: EnvSource = ENV;
let getEnvCalls = 0;
let srv: TestServer;

beforeAll(async () => {
  srv = await listenOnLoopback(
    createHandler({
      getEnv: () => {
        getEnvCalls += 1;
        return current;
      },
    }),
  );
});

afterAll(async () => {
  await srv.close();
});

afterEach(() => {
  current = ENV;
});

function json(body: Buffer): unknown {
  return JSON.parse(body.toString('utf8'));
}

describe('GET / (contract section 2, H1, B1)', () => {
  it('H1/B1: answers 200 with a JSON object equal to the injected environment', async () => {
    const res = await send(srv.port);
    expect(res.status).toBe(200);
    expect(json(res.body)).toEqual(ENV);
  });

  it('body is exactly the serializer output for the injected environment', async () => {
    const res = await send(srv.port);
    expect(res.body.toString('utf8')).toBe(serializeEnv(envToRecord(ENV)));
  });

  it('B6: an empty environment gives {}', async () => {
    current = {};
    const res = await send(srv.port);
    expect(res.status).toBe(200);
    expect(res.body.toString('utf8')).toBe('{}');
  });

  it('accepts envp-style entries too', async () => {
    current = ['A=1', 'B=x=y'];
    const res = await send(srv.port);
    expect(json(res.body)).toEqual({ A: '1', B: 'x=y' });
  });

  it('D1: an entry without "=" is skipped; still 200, connection not dropped', async () => {
    current = ['NOEQUALS', 'FOO=bar', ''];
    const res = await send(srv.port);
    expect(res.status).toBe(200);
    expect(json(res.body)).toEqual({ FOO: 'bar' });
  });

  it('D5: an entry with an empty name is omitted', async () => {
    current = ['=val', 'FOO=bar'];
    const res = await send(srv.port);
    expect(res.status).toBe(200);
    expect(json(res.body)).toEqual({ FOO: 'bar' });
  });
});

describe('headers (contract section 3)', () => {
  it('D2/H2: Content-Type is exactly application/json; charset=utf-8', async () => {
    expect(CONTENT_TYPE).toBe('application/json; charset=utf-8');
    const res = await send(srv.port);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
  });

  it('H3: Content-Length equals the body byte length (multi-byte UTF-8)', async () => {
    const res = await send(srv.port);
    const expectedBytes = Buffer.byteLength(serializeEnv(envToRecord(ENV)), 'utf8');
    // Multi-byte characters make the byte length differ from the string length.
    expect(expectedBytes).toBeGreaterThan(serializeEnv(envToRecord(ENV)).length);
    expect(res.headers['content-length']).toBe(String(expectedBytes));
    expect(res.body.length).toBe(expectedBytes);
  });

  it('H3: Content-Length is sent for a large (> 2 KiB) body as well', async () => {
    current = { BIG: 'x'.repeat(4096), UNI: '日本'.repeat(500) };
    const res = await send(srv.port);
    expect(res.headers['content-length']).toBe(String(res.body.length));
    expect(res.headers['transfer-encoding']).toBeUndefined();
    expect(json(res.body)).toEqual(current);
  });

  it('H4: Date is present', async () => {
    const res = await send(srv.port);
    expect(res.headers.date).toEqual(expect.any(String));
  });

  it('H5: adds no application headers beyond Content-Type and Content-Length', async () => {
    const res = await send(srv.port);
    const appHeaders = Object.keys(res.headers)
      .filter((name) => !TRANSPORT_HEADERS.includes(name))
      .sort();
    expect(appHeaders).toEqual(['content-length', 'content-type']);
  });
});

describe('every method, every path (contract section 2)', () => {
  const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE'] as const;
  const paths = [
    '/',
    '/some/deep/path/',
    '/deep/path/',
    '/favicon.ico',
    '/a/',
    '/a%2Fb',
    '/%2e%2e/',
    '/q?x=1&y=%3Cz%3E&x=2',
    '/?a=1',
  ] as const;

  it.each(methods)('%s / → 200 with the same body as GET /', async (method) => {
    const reference = await send(srv.port);
    const res = await send(srv.port, { method });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(CONTENT_TYPE);
    expect(res.body.equals(reference.body)).toBe(true);
  });

  it.each(paths)(
    'GET %s → 200 with the same body as GET / (path and query ignored)',
    async (path) => {
      const reference = await send(srv.port);
      const res = await send(srv.port, { path });
      expect(res.status).toBe(200);
      expect(res.body.equals(reference.body)).toBe(true);
    },
  );

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
    '%s with a request body → same body (request body ignored)',
    async (method) => {
      const reference = await send(srv.port);
      const res = await send(srv.port, {
        method,
        path: '/deep/path/?x=1',
        body: '{"ignored":true}',
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(200);
      expect(res.body.equals(reference.body)).toBe(true);
    },
  );

  it.each(['text/html', 'application/json'])(
    'GET with Accept: %s → same body and Content-Type (no negotiation)',
    async (accept) => {
      const reference = await send(srv.port);
      const res = await send(srv.port, { headers: { accept } });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe(CONTENT_TYPE);
      expect(res.body.equals(reference.body)).toBe(true);
    },
  );

  it.each(['/a/../b', '//x', '/./', '/.'])(
    'D6: unclean path %s → 200 with the env JSON (no redirect)',
    async (path) => {
      const reference = await send(srv.port);
      const res = await send(srv.port, { path });
      expect(res.status).toBe(200);
      expect(res.headers.location).toBeUndefined();
      expect(res.body.equals(reference.body)).toBe(true);
    },
  );

  it('HTTP/1.0 request → 200 and the same body', async () => {
    const reference = await send(srv.port);
    const raw = await sendRaw(srv.port, 'GET / HTTP/1.0\r\n\r\n');
    expect(raw).toMatch(/^HTTP\/1\.[01] 200 /);
    const body = raw.slice(raw.indexOf('\r\n\r\n') + 4);
    expect(Buffer.from(body, 'latin1').equals(reference.body)).toBe(true);
  });

  it('D7: an extension method is rejected by node:http (400/405/501), server keeps serving', async () => {
    const raw = await sendRaw(srv.port, 'FOO / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    expect(raw).toMatch(/^HTTP\/1\.1 (400|405|501) /);
    expect((await send(srv.port)).status).toBe(200);
  });

  it('keep-alive: several requests on one connection all get the env JSON', async () => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const sockets = new Set<unknown>();
      agent.on('free', (socket) => sockets.add(socket));
      for (let i = 0; i < 3; i += 1) {
        const res = await send(srv.port, { agent, path: `/r${String(i)}` });
        expect(res.status).toBe(200);
        expect(json(res.body)).toEqual(ENV);
      }
      expect(sockets.size).toBe(1);
    } finally {
      agent.destroy();
    }
  });
});

describe('HEAD (contract section 2, H3)', () => {
  it('HEAD / → 200, same Content-Type and Content-Length as GET, empty body', async () => {
    const get = await send(srv.port);
    const head = await send(srv.port, { method: 'HEAD', path: '/any/path?q=1' });
    expect(head.status).toBe(200);
    expect(head.headers['content-type']).toBe(CONTENT_TYPE);
    expect(head.headers['content-length']).toBe(get.headers['content-length']);
    expect(head.body.length).toBe(0);
  });

  it('H5: HEAD adds no application headers either', async () => {
    const head = await send(srv.port, { method: 'HEAD' });
    const appHeaders = Object.keys(head.headers)
      .filter((name) => !TRANSPORT_HEADERS.includes(name))
      .sort();
    expect(appHeaders).toEqual(['content-length', 'content-type']);
  });
});

describe('environment is read per request', () => {
  it('calls getEnv once per request', async () => {
    const before = getEnvCalls;
    await send(srv.port);
    await send(srv.port, { method: 'HEAD' });
    await send(srv.port, { method: 'POST', path: '/x' });
    expect(getEnvCalls - before).toBe(3);
  });

  it('a changed environment shows up on the next request', async () => {
    current = { STEP: '1' };
    expect(json((await send(srv.port)).body)).toEqual({ STEP: '1' });
    current = { STEP: '2', NEW: 'yes' };
    expect(json((await send(srv.port)).body)).toEqual({ STEP: '2', NEW: 'yes' });
  });
});

describe('default getEnv (process.env)', () => {
  let def: TestServer;

  beforeAll(async () => {
    def = await listenOnLoopback(createHandler());
  });

  afterAll(async () => {
    await def.close();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('serves process.env, read at request time', async () => {
    vi.stubEnv('HTTPENV_UNIT_23', 'first');
    const first = json((await send(def.port)).body) as Record<string, unknown>;
    expect(first['HTTPENV_UNIT_23']).toBe('first');

    vi.stubEnv('HTTPENV_UNIT_23', 'second é');
    const second = json((await send(def.port)).body) as Record<string, unknown>;
    expect(second['HTTPENV_UNIT_23']).toBe('second é');
    expect(second).toEqual(envToRecord(process.env));
  });
});
