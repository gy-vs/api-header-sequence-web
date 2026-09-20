import express from 'express';
import {fileURLToPath} from 'node:url';
import {validateHeaderLines} from '../shared/headers';
import {
  Scenario,
  adaptMergedResponseStep,
  adaptResponseStep,
  migrateScenario,
  parseScenarioBody,
  toWire,
} from './scenario';

type RecordRow = {id: string; name: string; revision: number; content: string; updatedAt: string};

// Seed documents deliberately use the *legacy* plain-object header shape so
// every cold start exercises migration (including display-casing of names).
const seeds: unknown[] = [
  {
    id: 'alpha',
    name: 'Primary request sequences',
    revision: 3,
    content: 'request sequences: alpha\nstate: active',
    updatedAt: new Date(0).toISOString(),
    steps: [
      {
        id: 'step-alpha-1',
        method: 'get',
        url: 'https://example.test/widgets',
        requestHeaders: {Accept: 'application/json', 'accept-language': 'en'},
        responseStatus: 200,
        responseHeaders: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Set-Cookie': 'sid=abc; HttpOnly',
          Warning: '199 - "legacy seed"',
        },
        responseBody: '{"ok":true}',
      },
    ],
  },
  {
    id: 'beta',
    name: 'Secondary request sequences',
    revision: 5,
    content: 'request sequences: beta\nstate: review',
    updatedAt: new Date(1000).toISOString(),
    steps: [],
  },
];

// Persistent (for the lifetime of the process) ordered header rows live in
// the map created per app below. createApp() builds a fresh seeded store, so
// tests get isolated apps while production still keeps one long-lived store.
export function createApp() {
  const scenarios = new Map<string, Scenario>(
    (seeds as Parameters<typeof migrateScenario>[0][]).map(doc => {
      const scenario = migrateScenario(doc);
      return [scenario.id, scenario];
    }),
  );

  const app = express();
  app.use(express.json({limit: '1mb'}));

  const summary = (s: Scenario): Omit<RecordRow, 'content'> & {stepCount: number} => ({
    id: s.id,
    name: s.name,
    revision: s.revision,
    updatedAt: s.updatedAt,
    stepCount: s.steps.length,
  });

  app.get('/api/bootstrap', (_req, res) =>
    res.json({family: 'api-scenario', count: scenarios.size}),
  );

  app.get('/api/scenarios', (_req, res) =>
    res.json([...scenarios.values()].map(summary)),
  );

  app.get('/api/scenarios/:id', (req, res) => {
    const scenario = scenarios.get(req.params.id);
    if (!scenario) return res.status(404).json({error: 'not_found'});
    res.set('ETag', String(scenario.revision)).json(toWire(scenario));
  });

  app.put('/api/scenarios/:id', (req, res) => {
    const current = scenarios.get(req.params.id);
    if (!current) return res.status(404).json({error: 'not_found'});

    // Optimistic concurrency: a second page saving against the same revision
    // loses nothing silently — it gets 409 and the current document.
    if (req.body?.revision !== current.revision) {
      return res.status(409).json({error: 'revision_conflict', current: toWire(current)});
    }

    let next: Scenario;
    try {
      next = parseScenarioBody(req.body, current.id);
    } catch (error) {
      return res
        .status(400)
        .json({error: 'invalid_headers', message: (error as Error).message});
    }

    // Field validation keeps the stable row id so the client can pin the
    // message to exactly the line the user is editing.
    const issues: {stepId: string; headerId: string; message: string}[] = [];
    for (const step of next.steps) {
      for (const bucket of [step.requestHeaders, step.responseHeaders]) {
        for (const issue of validateHeaderLines(bucket)) {
          issues.push({stepId: step.id, headerId: issue.id, message: issue.message});
        }
      }
    }
    if (issues.length) return res.status(400).json({error: 'validation_failed', issues});

    next = {
      ...next,
      id: current.id,
      name: next.name || current.name,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    scenarios.set(current.id, next);
    res.json(toWire(next));
  });

  app.post('/api/scenarios/:id/analyze', (req, res) => {
    const scenario = scenarios.get(req.params.id);
    if (!scenario) return res.status(404).json({error: 'not_found'});
    // Analyze the draft body when supplied (legacy behavior), else the stored doc.
    let draft: Scenario;
    try {
      draft =
        req.body && typeof req.body === 'object' && 'steps' in req.body
          ? parseScenarioBody(req.body, scenario.id)
          : scenario;
    } catch (error) {
      return res
        .status(400)
        .json({error: 'invalid_headers', message: (error as Error).message});
    }
    const diagnostics: {stepId: string; headerId: string; message: string}[] = [];
    for (const step of draft.steps) {
      for (const bucket of [step.requestHeaders, step.responseHeaders]) {
        for (const issue of validateHeaderLines(bucket)) {
          diagnostics.push({stepId: step.id, headerId: issue.id, message: issue.message});
        }
      }
    }
    const lines = String(req.body?.content ?? draft.content).split(/\r?\n/).length;
    res.json({id: scenario.id, revision: scenario.revision, lines, diagnostics});
  });

  // Structured replay preview: raw preserves every row on its own line,
  // merged folds combinable fields per RFC 9110 (Set-Cookie still split).
  app.get('/api/scenarios/:id/replay', (req, res) => {
    const scenario = scenarios.get(req.params.id);
    if (!scenario) return res.status(404).json({error: 'not_found'});
    const steps = scenario.steps.map(step => ({
      id: step.id,
      raw: adaptResponseStep(step),
      merged: adaptMergedResponseStep(step),
    }));
    res.json({id: scenario.id, revision: scenario.revision, steps});
  });

  // Wire-level replay: res.append emits one physical header line per stored
  // row, proving duplicate Set-Cookie / Warning lines really stay separate.
  app.get('/api/scenarios/:id/replay/:stepId', (req, res) => {
    const scenario = scenarios.get(req.params.id);
    if (!scenario) return res.status(404).json({error: 'not_found'});
    const step = scenario.steps.find(value => value.id === req.params.stepId);
    if (!step) return res.status(404).json({error: 'step_not_found'});
    const adapted = adaptResponseStep(step);
    for (const header of adapted.headers) {
      res.append(header.name, header.value);
    }
    res.status(adapted.status).send(adapted.body);
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
