// Ordered, multi-valued HTTP header model shared by the client editor,
// the JSON API, persistence and the replay adapter.
//
// A header block is an *ordered list of rows*, not an object: rows keep
// their user-entered order and casing, duplicate names (including
// Set-Cookie) stay distinct, and every row carries a stable client-owned
// id that the server must never renumber.

export type HeaderEntry = {
  /** Stable, client-owned id. Persisted verbatim; the server never renumbers it. */
  id: string;
  /** Display form exactly as typed. Comparisons must use normalizeHeaderName(). */
  name: string;
  value: string;
};

export type ScenarioResponse = {
  status: number;
  headers: HeaderEntry[];
  body: string;
};

export type Scenario = {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  response: ScenarioResponse;
};

/** Legacy on-the-wire / persisted shape: object keyed by header name. */
export type LegacyHeaderMap = Record<string, string | string[] | undefined>;

export type HeaderIssue = {
  /** Set for row issues so the UI can attach the error to the exact row. */
  id?: string;
  field?: 'name' | 'value' | 'status';
  message: string;
};

/** Field names that RFC 9110 does not allow to be combined into one line. */
const NON_COMBINABLE = new Set(['set-cookie']);

// RFC 9110 token (field name)
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Field value: reject NUL/CR/LF and other control chars except HT.
const ILLEGAL_VALUE_CHARS = /[\0-\b\n-\x1f\x7f]/;

let fallbackCounter = 0;

export function newHeaderId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) return `h_${cryptoApi.randomUUID()}`;
  fallbackCounter += 1;
  return `h_${Date.now().toString(36)}_${fallbackCounter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Case-insensitive name comparison key. Does not mutate the display form. */
export function normalizeHeaderName(name: string): string {
  return name.trim().toLowerCase();
}

export function isCombinable(name: string): boolean {
  return !NON_COMBINABLE.has(normalizeHeaderName(name));
}

/**
 * Accept both the canonical ordered array and the legacy object form
 * (values may be strings or arrays of strings), returning canonical rows.
 *
 * - Existing row ids are preserved verbatim (never regenerated).
 * - Rows coming from the legacy form receive one stable id each.
 * - Display casing and insertion order are preserved.
 * - Fully blank array rows are dropped during migration.
 */
export function migrateHeaders(input: unknown): HeaderEntry[] {
  if (Array.isArray(input)) {
    const rows: HeaderEntry[] = [];
    for (const raw of input) {
      if (!raw || typeof raw !== 'object') continue;
      const record = raw as { id?: unknown; name?: unknown; value?: unknown };
      const name = typeof record.name === 'string' ? record.name : String(record.name ?? '');
      const value = typeof record.value === 'string' ? record.value : String(record.value ?? '');
      if (name === '' && value.trim() === '') continue;
      const id = typeof record.id === 'string' && record.id.length > 0 ? record.id : newHeaderId();
      rows.push({ id, name, value });
    }
    return rows;
  }
  if (input && typeof input === 'object') {
    const rows: HeaderEntry[] = [];
    for (const [name, rawValue] of Object.entries(input as LegacyHeaderMap)) {
      const values = Array.isArray(rawValue) ? rawValue : rawValue === undefined ? [] : [rawValue];
      for (const value of values) {
        if (value === undefined || value === null) continue;
        rows.push({ id: newHeaderId(), name, value: String(value) });
      }
    }
    return rows;
  }
  return [];
}

/** Rows the user left completely empty are stripped from save payloads. */
export function stripBlankRows(entries: readonly HeaderEntry[]): HeaderEntry[] {
  return entries.filter((entry) => entry.name.trim() !== '' || entry.value.trim() !== '');
}

export type MergedHeader = { name: string; value: string };

/**
 * Protocol merge view (RFC 9110 5.2): combinable headers sharing a
 * case-insensitive name are joined with ", " and emitted at the first
 * occurrence position using the first occurrence's casing. Set-Cookie and
 * other non-combinable fields are always emitted as independent lines.
 */
export function mergeHeaders(entries: readonly HeaderEntry[]): MergedHeader[] {
  const groups = new Map<string, { name: string; values: string[] }>();
  for (const entry of entries) {
    const key = normalizeHeaderName(entry.name);
    if (key === '') continue;
    if (!isCombinable(entry.name)) continue;
    const group = groups.get(key);
    if (group) {
      group.values.push(entry.value);
    } else {
      groups.set(key, { name: entry.name, values: [entry.value] });
    }
  }

  const result: MergedHeader[] = [];
  const emitted = new Set<string>();
  for (const entry of entries) {
    const key = normalizeHeaderName(entry.name);
    if (key === '') continue;
    if (!isCombinable(entry.name)) {
      result.push({ name: entry.name, value: entry.value });
      continue;
    }
    if (emitted.has(key)) continue;
    emitted.add(key);
    const group = groups.get(key)!;
    result.push({ name: group.name, value: group.values.join(', ') });
  }
  return result;
}

/**
 * Canonical wire projection: one line per stored row, in stored order,
 * using the stored display casing. The replay adapter and the editor
 * preview both call this, so they cannot diverge.
 */
export function toWireLines(entries: readonly HeaderEntry[]): Array<readonly [string, string]> {
  const lines: Array<readonly [string, string]> = [];
  for (const entry of entries) {
    if (normalizeHeaderName(entry.name) === '') continue;
    lines.push([entry.name, entry.value] as const);
  }
  return lines;
}

export function validateHeaders(entries: readonly HeaderEntry[]): HeaderIssue[] {
  const issues: HeaderIssue[] = [];
  for (const entry of entries) {
    const hasName = entry.name.trim() !== '';
    const hasValue = entry.value.trim() !== '';
    if (!hasName && !hasValue) continue; // blank row, stripped on save
    if (!hasName) {
      issues.push({ id: entry.id, field: 'name', message: 'Header name is required.' });
    } else if (!TOKEN.test(entry.name.trim())) {
      issues.push({ id: entry.id, field: 'name', message: 'Invalid header name token.' });
    }
    if (ILLEGAL_VALUE_CHARS.test(entry.value)) {
      issues.push({ id: entry.id, field: 'value', message: 'Header value contains CR/LF or control characters.' });
    }
  }
  return issues;
}

export function validateStatus(status: unknown): HeaderIssue[] {
  return Number.isInteger(status) && (status as number) >= 100 && (status as number) <= 599
    ? []
    : [{ field: 'status', message: 'Status must be an integer between 100 and 599.' }];
}
