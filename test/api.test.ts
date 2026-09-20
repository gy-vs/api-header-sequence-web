import {describe, expect, it} from 'vitest';
import request, {Agent} from 'supertest';
import {createApp} from '../src/server/index';

// Express 5's application type is wider than the RequestListener union in
// @types/supertest 7; wrap so api(app) keeps the chainable Test type.
function api(app: ReturnType<typeof createApp>): Agent {
  return request(app as unknown as Parameters<typeof request>[0]);
}

function step(overrides: Record<string, unknown> = {}) {
  return {
    id: 'step-1',
    method: 'GET',
    url: 'https://example.test/x',
    requestHeaders: [],
    responseStatus: 200,
    responseHeaders: [],
    responseBody: '',
    ...overrides,
  };
}

function body(steps: unknown[], revision: number) {
  return {name: 'Primary request sequences', content: '', revision, steps};
}

function save(
  app: ReturnType<typeof createApp>,
  steps: unknown[],
  revision: number,
) {
  return api(app).put('/api/scenarios/alpha').send(body(steps, revision));
}

async function currentRevision(app: ReturnType<typeof createApp>) {
  const res = await api(app).get('/api/scenarios/alpha');
  return res.body.revision as number;
}

describe('scenario service', () => {
  it('loads and conditionally updates a record', async () => {
    const app = createApp();
    const revision = await currentRevision(app);
    await save(app, [], revision).expect(200);
    await save(app, [], revision).expect(409);
  });

  it('migrates the legacy object header format embedded in steps', async () => {
    const app = createApp();
    const revision = await currentRevision(app);
    const res = await save(
      app,
      [
        step({
          requestHeaders: {Accept: 'application/json', 'X-Legacy': 'yes'},
          responseHeaders: {'Set-Cookie': 'a=1'},
        }),
      ],
      revision,
    ).expect(200);
    const saved = res.body.steps[0];
    expect(saved.requestHeaders.map((h: {name: string}) => h.name)).toEqual([
      'Accept',
      'X-Legacy',
    ]);
    expect(saved.requestHeaders.every((h: {id: string}) => h.id)).toBe(true);
    expect(saved.responseHeaders[0].name).toBe('Set-Cookie');
  });

  it('migrates the seeded legacy document on a cold start', async () => {
    const app = createApp();
    const res = await api(app).get('/api/scenarios/alpha').expect(200);
    const names = res.body.steps[0].responseHeaders.map((h: {name: string}) => h.name);
    expect(names).toContain('Set-Cookie');
    expect(names).toContain('Warning');
    // Seed used both "Content-Type" and "accept-language" casing; first-seen casing survives.
    expect(res.body.steps[0].requestHeaders.map((h: {name: string}) => h.name)).toEqual([
      'Accept',
      'accept-language',
    ]);
  });

  it('keeps multiple Set-Cookie and Warning lines as independent rows through save/reload', async () => {
    const app = createApp();
    const revision = await currentRevision(app);
    const rows = [
      {id: 'c1', name: 'Set-Cookie', value: 'sid=abc; HttpOnly'},
      {id: 'c2', name: 'Warning', value: '199 - "first"'},
      {id: 'c3', name: 'Set-Cookie', value: 'track=1; Secure'},
      {id: 'c4', name: 'Set-Cookie', value: 'geo=cn'},
      {id: 'c5', name: 'Warning', value: '214 - "second"'},
    ];
    await save(app, [step({responseHeaders: rows})], revision).expect(200);
    const reloaded = await api(app).get('/api/scenarios/alpha').expect(200);
    expect(reloaded.body.steps[0].responseHeaders).toEqual(rows);
  });

  it('stores same-name headers with different casing and preserves display forms', async () => {
    const app = createApp();
    const revision = await currentRevision(app);
    const rows = [
      {id: 'h1', name: 'content-type', value: 'application/json'},
      {id: 'h2', name: 'Content-Type', value: 'text/plain'},
      {id: 'h3', name: 'CONTENT-TYPE', value: 'text/html'},
    ];
    await save(app, [step({responseHeaders: rows})], revision).expect(200);
    const got = await api(app).get('/api/scenarios/alpha');
    expect(got.body.steps[0].responseHeaders.map((h: {name: string}) => h.name)).toEqual([
      'content-type',
      'Content-Type',
      'CONTENT-TYPE',
    ]);
  });

  it('honors drag reordering: server stores array order instead of sorting object keys', async () => {
    const app = createApp();
    const revision = await currentRevision(app);
    const rows = [
      {id: 'r-z', name: 'Zebra', value: '1'},
      {id: 'r-a', name: 'Apple', value: '2'},
      {id: 'r-m', name: 'Mango', value: '3'},
    ];
    const draggedToTop = [rows[1], rows[0], rows[2]];
    await save(app, [step({responseHeaders: draggedToTop})], revision).expect(200);
    const got = await api(app).get('/api/scenarios/alpha');
    expect(got.body.steps[0].responseHeaders.map((h: {id: string}) => h.id)).toEqual([
      'r-a',
      'r-z',
      'r-m',
    ]);
  });

  it('deletes the middle row without renumbering the stable ids of neighbors', async () => {
    const app = createApp();
    const revision = await currentRevision(app);
    const rows = [
      {id: 'row-1', name: 'X-One', value: '1'},
      {id: 'row-2', name: 'X-Two', value: '2'},
      {id: 'row-3', name: 'X-Three', value: '3'},
    ];
    await save(app, [step({responseHeaders: rows})], revision).expect(200);
    const rev2 = await currentRevision(app);
    await save(
      app,
      [step({responseHeaders: [rows[0], rows[2]]})],
      rev2,
    ).expect(200);
    const got = await api(app).get('/api/scenarios/alpha');
    expect(got.body.steps[0].responseHeaders.map((h: {id: string}) => h.id)).toEqual([
      'row-1',
      'row-3',
    ]);
  });

  it('rejects a concurrent save from a second page with 409 and the winner document', async () => {
    const app = createApp();
    const revision = await currentRevision(app);
    // Page A saves first.
    const a = await save(
      app,
      [step({responseHeaders: [{id: 'pa', name: 'X-Page', value: 'A'}]})],
      revision,
    ).expect(200);
    // Page B still holds the old revision; its save must not overwrite A.
    const b = await save(
      app,
      [step({responseHeaders: [{id: 'pb', name: 'X-Page', value: 'B'}]})],
      revision,
    ).expect(409);
    expect(b.body.error).toBe('revision_conflict');
    expect(b.body.current.revision).toBe(a.body.revision);
    expect(b.body.current.steps[0].responseHeaders[0].value).toBe('A');
  });

  it('never renumbers stable row ids across save cycles', async () => {
    const app = createApp();
    const revision = await currentRevision(app);
    const clientIds = ['stable-7', 'stable-11', 'stable-3'];
    const res = await save(
      app,
      [step({responseHeaders: clientIds.map(id => ({id, name: 'X-Custom', value: id}))})],
      revision,
    ).expect(200);
    const serverIds = res.body.steps[0].responseHeaders.map((h: {id: string}) => h.id);
    expect(serverIds).toEqual(clientIds);
  });

  it('returns validation errors pinned to the stable row id', async () => {
    const app = createApp();
    const revision = await currentRevision(app);
    const res = await save(
      app,
      [
        step({
          responseHeaders: [
            {id: 'good', name: 'X-Ok', value: 'fine'},
            {id: 'broken', name: 'Bad Name', value: 'x'},
          ],
        }),
      ],
      revision,
    ).expect(400);
    expect(res.body.error).toBe('validation_failed');
    expect(res.body.issues[0].headerId).toBe('broken');
    // Rejected save must not bump the revision.
    expect(await currentRevision(app)).toBe(revision);
  });

  it('replay adapter keeps Set-Cookie split in raw view and merges Warning only', async () => {
    const app = createApp();
    const revision = await currentRevision(app);
    await save(
      app,
      [
        step({
          id: 'step-alpha-1',
          responseHeaders: [
            {id: 'c1', name: 'Set-Cookie', value: 'a=1'},
            {id: 'w1', name: 'Warning', value: '199 - "one"'},
            {id: 'c2', name: 'set-cookie', value: 'b=2'},
            {id: 'w2', name: 'Warning', value: '214 - "two"'},
          ],
        }),
      ],
      revision,
    ).expect(200);
    const replay = await api(app).get('/api/scenarios/alpha/replay').expect(200);
    const {raw, merged} = replay.body.steps[0];
    expect(raw.headers).toHaveLength(4);
    expect(raw.headers.filter((h: {name: string}) => h.name.toLowerCase() === 'set-cookie')).toEqual([
      {name: 'Set-Cookie', value: 'a=1'},
      {name: 'set-cookie', value: 'b=2'},
    ]);
    const mergedCookies = merged.headers.filter(
      (h: {name: string}) => h.name.toLowerCase() === 'set-cookie',
    );
    expect(mergedCookies).toHaveLength(2);
    expect(merged.headers.find((h: {name: string}) => h.name === 'Warning').value).toBe(
      '199 - "one", 214 - "two"',
    );
  });

  it('wire replay emits duplicate Set-Cookie as separate physical response lines', async () => {
    const app = createApp();
    const revision = await currentRevision(app);
    await save(
      app,
      [
        step({
          id: 'step-alpha-1',
          responseHeaders: [
            {id: 'c1', name: 'Set-Cookie', value: 'sid=abc; HttpOnly'},
            {id: 'c2', name: 'Set-Cookie', value: 'track=1; Secure'},
          ],
        }),
      ],
      revision,
    ).expect(200);
    const res = await api(app).get('/api/scenarios/alpha/replay/step-alpha-1').expect(200);
    const cookies = res.headers['set-cookie'];
    expect(Array.isArray(cookies) ? cookies : [cookies]).toEqual([
      'sid=abc; HttpOnly',
      'track=1; Secure',
    ]);
  });
});
