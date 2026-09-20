import {
  HeaderInput,
  HeaderLine,
  headerPairs,
  mergeHeaders,
  migrateHeaders,
} from '../shared/headers';

export type ReplayStep = {
  id: string;
  method: string;
  url: string;
  requestHeaders: HeaderLine[];
  responseStatus: number;
  responseHeaders: HeaderLine[];
  responseBody?: string;
};

export type Scenario = {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  steps: ReplayStep[];
  /** Free-form notes kept alongside the structured steps. */
  content: string;
};

type LegacyStep = {
  id?: unknown;
  method?: unknown;
  url?: unknown;
  status?: unknown;
  responseStatus?: unknown;
  headers?: HeaderInput;
  requestHeaders?: HeaderInput;
  responseHeaders?: HeaderInput;
  body?: unknown;
  responseBody?: unknown;
};

type LegacyScenario = {
  id: string;
  name?: string;
  revision?: number;
  updatedAt?: string;
  content?: string;
  steps?: LegacyStep[];
  // Legacy step layout living at the top level of older documents.
  requestHeaders?: HeaderInput;
  responseHeaders?: HeaderInput;
  method?: unknown;
  url?: unknown;
  responseStatus?: unknown;
};

let stepCounter = 0;
function stepId(): string {
  stepCounter = (stepCounter + 1) % 0xffffffff;
  return `s-${Date.now().toString(36)}-${stepCounter.toString(36)}`;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value == null ? fallback : String(value);
}

function asStatus(value: unknown): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 100 && n <= 599 ? n : 200;
}

function migrateStep(step: LegacyStep): ReplayStep {
  return {
    id: typeof step.id === 'string' && step.id ? step.id : stepId(),
    method: asString(step.method, 'GET').toUpperCase(),
    url: asString(step.url),
    // The very first prototype only had a single `headers` object.
    requestHeaders: migrateHeaders(step.requestHeaders ?? step.headers),
    responseStatus: asStatus(step.responseStatus ?? step.status),
    responseHeaders: migrateHeaders(step.responseHeaders),
    responseBody: asString(step.responseBody ?? step.body),
  };
}

/**
 * Load a scenario from a legacy document:
 * - headers encoded as plain objects (`{"Set-Cookie": "..."}`) migrate to
 *   ordered rows, with ids assigned once and preserved thereafter;
 * - documents predating the steps array migrate their top-level fields into
 *   a single step.
 */
export function migrateScenario(doc: LegacyScenario): Scenario {
  let steps: ReplayStep[];
  if (Array.isArray(doc.steps)) {
    steps = doc.steps.map(migrateStep);
  } else {
    steps = [
      {
        id: stepId(),
        method: asString(doc.method, 'GET').toUpperCase(),
        url: asString(doc.url),
        requestHeaders: migrateHeaders(doc.requestHeaders),
        responseStatus: asStatus(doc.responseStatus),
        responseHeaders: migrateHeaders(doc.responseHeaders),
        responseBody: asString(doc.content),
      },
    ];
  }
  return {
    id: asString(doc.id),
    name: asString(doc.name, 'Untitled scenario'),
    revision: Number.isInteger(doc.revision) ? (doc.revision as number) : 0,
    updatedAt: asString(doc.updatedAt, new Date(0).toISOString()),
    steps,
    content: asString(doc.content),
  };
}

export type WireScenario = ReturnType<typeof toWire>;

/**
 * Wire/persistence form. Headers always travel as ordered arrays of
 * {id, name, value} rows — never an object map.
 */
export function toWire(s: Scenario) {
  return {
    id: s.id,
    name: s.name,
    revision: s.revision,
    updatedAt: s.updatedAt,
    content: s.content,
    steps: s.steps.map(step => ({
      id: step.id,
      method: step.method,
      url: step.url,
      requestHeaders: step.requestHeaders,
      responseStatus: step.responseStatus,
      responseHeaders: step.responseHeaders,
      responseBody: step.responseBody ?? '',
    })),
  };
}

export function fromWire(body: unknown, id: string): Scenario {
  const doc = (body ?? {}) as Partial<LegacyScenario>;
  const migrated = migrateScenario({...doc, id});
  return {
    ...migrated,
    name: asString(doc.name, migrated.name),
    content: asString(doc.content, migrated.content),
    revision: Number.isInteger(doc.revision) ? (doc.revision as number) : migrated.revision,
    updatedAt: asString(doc.updatedAt, migrated.updatedAt),
  };
}

/** Normalize an inbound scenario body from either format into ordered rows. */
export function parseScenarioBody(body: unknown, id: string): Scenario {
  return fromWire(body, id);
}

export type AdaptedResponse = {
  status: number;
  /** Headers exactly as they must appear on the wire; Set-Cookie stays split. */
  headers: {name: string; value: string}[];
  body: string;
};

/**
 * Replay adapter: turn stored steps into the outgoing request / mocked
 * response representation. Mergeable fields are combined per RFC 9110 for
 * consumers that want one entry per field name; the raw adapter keeps every
 * stored row on its own line (required for Set-Cookie).
 */
export function adaptResponseStep(step: ReplayStep): AdaptedResponse {
  return {
    status: step.responseStatus,
    headers: headerPairs(step.responseHeaders),
    body: step.responseBody ?? '',
  };
}

export function adaptMergedResponseStep(step: ReplayStep): AdaptedResponse {
  return {
    status: step.responseStatus,
    headers: mergeHeaders(step.responseHeaders),
    body: step.responseBody ?? '',
  };
}

export function adaptRequestStep(step: ReplayStep): {
  method: string;
  url: string;
  headers: {name: string; value: string}[];
} {
  // Requests fold mergeable fields too; Cookie is itself a single field and
  // only Set-Cookie on responses is strictly non-mergeable.
  return {
    method: step.method,
    url: step.url,
    headers: mergeHeaders(step.requestHeaders),
  };
}
