import http from 'node:http';
import net from 'node:net';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import type {HeaderEntry} from '../src/shared/headers';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no ephemeral port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
);

/** Raw HTTP/1.0 request so duplicate header lines and ordering are visible verbatim. */
async function rawGet(path: string): Promise<{statusLine: string; headerBlock: string}> {
  const port = new URL(baseUrl).port;
  const socket = net.connect(Number(port), '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write(`GET ${path} HTTP/1.0\r\nHost: x\r\n\r\n`);
  let buffer = '';
  await new Promise<void>((resolve) => {
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.includes('\r\n\r\n')) resolve();
    });
  });
  socket.end();
  const head = buffer.split('\r\n\r\n')[0];
  const [statusLine, ...lines] = head.split('\r\n');
  return {statusLine, headerBlock: lines.join('\r\n')};
}

async function getScenario(id: string) {
  const response = await request(server).get(`/api/scenarios/${id}`);
  expect(response.status).toBe(200);
  return response.body;
}

async function save(id: string, revision: number, headers: unknown, extra: Record<string, unknown> = {}) {
  return request(server)
    .put(`/api/scenarios/${id}`)
    .send({revision, response: {status: 200, headers, body: ''}, ...extra});
}

describe('persistence of ordered multi-valued headers', () => {
  it('keeps every duplicate row and its id, order and casing after save/reload', async () => {
    const before = await getScenario('alpha');
    const headers: HeaderEntry[] = [
      {id: 'line-1', name: 'X-Trace', value: 'first'},
      {id: 'line-2', name: 'Set-Cookie', value: 'a=1'},
      {id: 'line-3', name: 'Warning', value: '199 - "one"'},
      {id: 'line-4', name: 'set-COOKIE', value: 'b=2'},
      {id: 'line-5', name: 'x-TRACE', value: 'second'},
      {id: 'line-6', name: 'WARNING', value: '299 - "two"'},
    ];
    const saved = await save('alpha', before.revision, headers);
    expect(saved.status).toBe(200);
    const reloaded = await getScenario('alpha');
    expect(reloaded.response.headers).toEqual(headers);
    // merged projection: combinable rows combined, Set-Cookie untouched
    expect(reloaded.response.headers).toHaveLength(6);
  });

  it('replay adapter emits interleaved order and independent Set-Cookie/Warning lines verbatim', async () => {
    const {statusLine, headerBlock} = await rawGet('/api/scenarios/alpha/replay');
    expect(statusLine).toBe('HTTP/1.1 200 OK');
    const lines = headerBlock
      .split('\r\n')
      .filter((line) => !/^(date|connection|content-length):/i.test(line));
    expect(lines).toEqual([
      'X-Trace: first',
      'Set-Cookie: a=1',
      'Warning: 199 - "one"',
      'set-COOKIE: b=2',
      'x-TRACE: second',
      'WARNING: 299 - "two"',
    ]);
  });

  it('exposes the protocol merge view without touching the canonical rows', async () => {
    const reloaded = await getScenario('alpha');
    expect(reloaded.mergedHeaders).toEqual([
      {name: 'X-Trace', value: 'first, second'},
      {name: 'Set-Cookie', value: 'a=1'},
      {name: 'Warning', value: '199 - "one", 299 - "two"'},
      {name: 'set-COOKIE', value: 'b=2'},
    ]);
  });

  it('migrates the legacy object form on read, including Set-Cookie arrays', async () => {
    const beta = await getScenario('beta');
    expect(beta.response.headers.map((entry: HeaderEntry) => [entry.name, entry.value])).toEqual([
      ['Content-Type', 'text/plain'],
      ['Set-Cookie', 'sid=beta'],
      ['Set-Cookie', 'theme=light'],
      ['x-trace', 'one'],
      ['x-trace', 'two'],
    ]);
    const migrated = await save(
      'beta',
      beta.revision,
      beta.response.headers.map((entry: HeaderEntry) => ({...entry, value: `${entry.value}!`})),
    );
    expect(migrated.status).toBe(200);
    // migration assigns ids and the round trip preserves them
    const again = await getScenario('beta');
    expect(again.response.headers.map((entry: HeaderEntry) => entry.value)).toEqual([
      'text/plain!',
      'sid=beta!',
      'theme=light!',
      'one!',
      'two!',
    ]);
    expect(again.response.headers.every((entry: HeaderEntry) => entry.id.length > 0)).toBe(true);
  });
});

describe('stable client-owned row ids', () => {
  it('never renumbers ids on drag-reorder save or middle deletion', async () => {
    const before = await getScenario('alpha');
    const reordered = [...before.response.headers].reverse();
    const saved = await save('alpha', before.revision, reordered);
    expect(saved.body.response.headers.map((entry: HeaderEntry) => entry.id)).toEqual(reordered.map((entry) => entry.id));

    const withMiddleRemoved = reordered.filter((entry, index) => index !== 2);
    const savedAgain = await save('alpha', saved.body.revision, withMiddleRemoved);
    expect(savedAgain.body.response.headers.map((entry: HeaderEntry) => entry.id)).toEqual(
      withMiddleRemoved.map((entry) => entry.id),
    );
    // ids must be the original client ids, not positional numbers
    expect(savedAgain.body.response.headers.map((entry: HeaderEntry) => entry.id)).toContain('line-1');
  });
});

describe('concurrent saves', () => {
  it('the second page loses with 409 and receives current rows with stable ids; overwrite then succeeds', async () => {
    const before = await getScenario('beta');
    const pageA = await save('beta', before.revision, [{id: 'a-row', name: 'X-A', value: 'A'}]);
    expect(pageA.status).toBe(200);
    const pageB = await request(server)
      .put('/api/scenarios/beta')
      .send({revision: before.revision, response: {status: 201, headers: [{id: 'b-row', name: 'X-B', value: 'B'}], body: ''}});
    expect(pageB.status).toBe(409);
    expect(pageB.body.error).toBe('revision_conflict');
    expect(pageB.body.current.response.headers[0].id).toBe('a-row');
    expect(pageB.body.current.revision).toBe(pageA.body.revision);

    // page B overwrites using the revision returned inside the 409
    const overwrite = await request(server)
      .put('/api/scenarios/beta')
      .send({revision: pageB.body.current.revision, response: {status: 201, headers: [{id: 'b-row', name: 'X-B', value: 'B'}], body: ''}});
    expect(overwrite.status).toBe(200);
    const reloaded = await getScenario('beta');
    expect(reloaded.revision).toBe(pageB.body.current.revision + 1);
    expect(reloaded.response.headers.map((entry: HeaderEntry) => entry.id)).toEqual(['b-row']);
  });
});

describe('validation', () => {
  it('rejects CRLF injection, bad tokens and bad status with row-keyed 400 issues', async () => {
    const before = await getScenario('beta');
    const bad = await request(server)
      .put('/api/scenarios/beta')
      .send({
        revision: before.revision,
        response: {
          status: 600,
          headers: [
            {id: 'bad-name', name: 'not a token', value: 'x'},
            {id: 'bad-value', name: 'X-Inject', value: 'x\r\nSet-Cookie: pwned=1'},
          ],
          body: '',
        },
      });
    expect(bad.status).toBe(400);
    expect(bad.body.issues.map((issue: {id?: string}) => issue.id).sort()).toEqual(['bad-name', 'bad-value', undefined]);
    expect(bad.body.issues.some((issue: {field?: string}) => issue.field === 'status')).toBe(true);
    // failed save must not advance revision or mutate rows
    const unchanged = await getScenario('beta');
    expect(unchanged.response.headers.map((entry: HeaderEntry) => entry.id)).toEqual(['b-row']);
  });

  it('strips blank rows and rejects unknown records', async () => {
    const before = await getScenario('alpha');
    const ok = await save('alpha', before.revision, [
      {id: 'keep', name: 'X-K', value: 'v'},
      {id: 'blank', name: '', value: ''},
    ]);
    expect(ok.status).toBe(200);
    const reloaded = await getScenario('alpha');
    expect(reloaded.response.headers.map((entry: HeaderEntry) => entry.id)).toEqual(['keep']);
    const missing = await request(server).put('/api/scenarios/nope').send({revision: 1, response: {headers: []}});
    expect(missing.status).toBe(404);
  });
});
