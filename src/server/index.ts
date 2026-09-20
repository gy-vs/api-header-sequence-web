import express from 'express';
import {fileURLToPath} from 'node:url';
import {
  migrateHeaders,
  mergeHeaders,
  stripBlankRows,
  validateHeaders,
  validateStatus,
  type HeaderEntry,
  type HeaderIssue,
  type Scenario,
} from '../shared/headers';
import {replayResponse} from './replay';

type StoredScenario = {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  response: {status: unknown; headers: unknown; body: unknown};
};

// Beta is intentionally persisted in the legacy object form so migration
// runs on every read until it is re-saved.
function createStore(): StoredScenario[] {
  const modernHeaders: HeaderEntry[] = [
    {id: 'h-seed-1', name: 'Content-Type', value: 'application/json'},
    {id: 'h-seed-2', name: 'Set-Cookie', value: 'sid=alpha; Path=/'},
    {id: 'h-seed-3', name: 'Set-Cookie', value: 'theme=dark; Path=/'},
    {id: 'h-seed-4', name: 'X-Trace', value: 'seed-first'},
  ];
  return [
    {
      id: 'alpha',
      name: 'Primary request sequences',
      revision: 3,
      updatedAt: new Date(0).toISOString(),
      response: {status: 200, headers: modernHeaders, body: JSON.stringify({ok: true})},
    },
    {
      id: 'beta',
      name: 'Secondary request sequences',
      revision: 5,
      updatedAt: new Date(1000).toISOString(),
      response: {
        status: 202,
        headers: {'Content-Type': 'text/plain', 'Set-Cookie': ['sid=beta', 'theme=light'], 'x-trace': ['one', 'two']},
        body: 'accepted',
      },
    },
  ];
}

/** Read-time normalization: legacy object form -> ordered rows. Idempotent. */
function presentScenario(stored: StoredScenario): Scenario {
  const headers = migrateHeaders(stored.response.headers);
  return {
    id: stored.id,
    name: stored.name,
    revision: stored.revision,
    updatedAt: stored.updatedAt,
    response: {
      status: typeof stored.response.status === 'number' ? stored.response.status : 200,
      headers,
      body: typeof stored.response.body === 'string' ? stored.response.body : '',
    },
  };
}

export function createApp() {
  const app = express();
  const store = createStore();
  app.disable('x-powered-by');
  app.use(express.json({limit: '1mb'}));

  app.get('/api/bootstrap', (_req, res) => {
    res.json({family: 'api-scenario', count: store.length});
  });

  app.get('/api/scenarios', (_req, res) => {
    res.json(
      store.map((stored) => {
        const {response, ...summary} = presentScenario(stored);
        return {...summary, status: response.status, headerCount: response.headers.length};
      }),
    );
  });

  app.get('/api/scenarios/:id', (req, res) => {
    const stored = store.find((row) => row.id === req.params.id);
    if (!stored) return res.status(404).json({error: 'not_found'});
    const scenario = presentScenario(stored);
    res.set('ETag', String(scenario.revision)).json({...scenario, mergedHeaders: mergeHeaders(scenario.response.headers)});
  });

  app.put('/api/scenarios/:id', (req, res) => {
    const stored = store.find((row) => row.id === req.params.id);
    if (!stored) return res.status(404).json({error: 'not_found'});

    if (Number(req.body?.revision) !== stored.revision) {
      // 409 carries the normalized current state so the stale page can
      // reload or decide to overwrite; its rows already carry stable ids.
      const current = presentScenario(stored);
      return res.status(409).json({error: 'revision_conflict', current: {...current, mergedHeaders: mergeHeaders(current.response.headers)}});
    }

    const incomingResponse = req.body?.response;
    const status = Number(incomingResponse?.status ?? 200);
    const body = typeof incomingResponse?.body === 'string' ? incomingResponse.body : '';
    // migrateHeaders accepts the legacy object form too; stripBlankRows
    // drops fully empty editor rows. Ids are preserved verbatim and never
    // renumbered or replaced, so focus/errors stay bound to the right row.
    const headers = stripBlankRows(migrateHeaders(incomingResponse?.headers));

    const issues: HeaderIssue[] = [...validateStatus(status), ...validateHeaders(headers)];
    if (issues.length > 0) return res.status(400).json({error: 'validation_failed', issues});

    stored.response = {status, headers, body};
    stored.revision += 1;
    stored.updatedAt = new Date().toISOString();

    const scenario = presentScenario(stored);
    res.json({...scenario, mergedHeaders: mergeHeaders(headers)});
  });

  app.post('/api/scenarios/:id/analyze', async (req, res) => {
    const stored = store.find((row) => row.id === req.params.id);
    if (!stored) return res.status(404).json({error: 'not_found'});
    await new Promise((resolve) => setTimeout(resolve, req.params.id === 'alpha' ? 100 : 20));
    const draft = req.body?.response;
    const headers = stripBlankRows(migrateHeaders(draft?.headers));
    const status = Number(draft?.status ?? stored.response.status ?? 200);
    const issues: HeaderIssue[] = [...validateStatus(status), ...validateHeaders(headers)];
    res.json({
      id: stored.id,
      revision: stored.revision,
      status,
      wireLines: headers.map((entry) => `${entry.name}: ${entry.value}`),
      diagnostics: issues,
    });
  });

  // Replay the stored mock response. GET is allowed so raw-wire tests can
  // observe exact line emission; the editor calls POST.
  app.all('/api/scenarios/:id/replay', (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'POST') return next();
    const stored = store.find((row) => row.id === req.params.id);
    if (!stored) return res.status(404).json({error: 'not_found'});
    const spec = presentScenario(stored).response;
    replayResponse(res, spec);
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
