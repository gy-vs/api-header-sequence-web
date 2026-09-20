// Ordered multi-value header model.
//
// Headers are stored as an *ordered array of rows* instead of an object map:
// object keys drop duplicates (e.g. multiple Set-Cookie lines), JSON object
// key order is not meaningful, and a case-insensitive protocol field name
// ("Content-Type" vs "content-type") cannot be represented as a map without
// losing one of the display forms. Each row keeps a client-generated stable
// id that the server never renumbers, so focus and per-row validation errors
// stay attached to the same line across save/reload cycles.

export type HeaderLine = {id: string; name: string; value: string};

/** Fields that must never be folded into a comma-separated merged line. */
const NON_MERGEABLE = new Set(['set-cookie']);
export function isNonMergeable(name: string): boolean {
  return NON_MERGEABLE.has(name.trim().toLowerCase());
}

/** Case-insensitive field name key; the original casing is preserved on the row. */
export function headerKey(name: string): string {
  return name.trim().toLowerCase();
}

export type HeaderIssue = {id: string; message: string};

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9a-zA-Z]+$/;

/** Protocol-level validation of a single row. Empty names are rejected. */
export function validateHeaderLine(line: HeaderLine): string | null {
  if (!line.name.trim()) return 'Header name is required';
  if (!TOKEN.test(line.name.trim())) return 'Header name contains invalid characters';
  if (/[\r\n]/.test(line.value)) return 'Header value must be a single line';
  return null;
}

export function validateHeaderLines(lines: HeaderLine[]): HeaderIssue[] {
  const issues: HeaderIssue[] = [];
  for (const line of lines) {
    const message = validateHeaderLine(line);
    if (message) issues.push({id: line.id, message});
  }
  return issues;
}

// Legacy wire/storage shape: a plain object mapping field name to value.
// Duplicate keys with different casing cannot round-trip in JSON anyway;
// entries are imported in object order, preserving each key's display form.
export type LegacyHeaderMap = Record<string, string>;
export type HeaderInput = HeaderLine[] | LegacyHeaderMap | null | undefined;

let counter = 0;
export function newHeaderId(): string {
  const crypto =
    typeof globalThis === 'object'
      ? (globalThis as {crypto?: {randomUUID?: () => string}}).crypto
      : undefined;
  if (crypto?.randomUUID) return crypto.randomUUID();
  counter = (counter + 1) % 0xffffffff;
  return `h-${Date.now().toString(36)}-${counter.toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function isLine(value: unknown): value is HeaderLine {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as HeaderLine).name === 'string' &&
    typeof (value as HeaderLine).value === 'string'
  );
}

/**
 * Accept the ordered array format or the legacy object format and return an
 * ordered row list. Rows without an id (legacy objects / old clients) are
 * assigned stable ids at import time; rows that already carry an id keep it
 * verbatim — the server never reassigns or renumbers ids.
 */
export function migrateHeaders(input: HeaderInput): HeaderLine[] {
  if (input == null) return [];
  if (Array.isArray(input)) {
    const lines: HeaderLine[] = [];
    const seen = new Set<string>();
    for (const entry of input) {
      if (!isLine(entry)) {
        throw new TypeError('headers must be objects with string name and value');
      }
      const id = entry.id ? String(entry.id) : newHeaderId();
      if (seen.has(id)) throw new TypeError(`duplicate header row id: ${id}`);
      seen.add(id);
      lines.push({id, name: entry.name, value: entry.value});
    }
    return lines;
  }
  if (typeof input !== 'object') {
    throw new TypeError('headers must be an array or an object');
  }
  return Object.entries(input as LegacyHeaderMap).map(([name, value]) => ({
    id: newHeaderId(),
    name,
    value: String(value),
  }));
}

/** One protocol field with all its values gathered (first occurrence wins casing/order). */
export type HeaderGroup = {name: string; key: string; values: string[]; mergeable: boolean};

/** Group the ordered rows by case-insensitive name without changing order. */
export function groupHeaders(lines: HeaderLine[]): HeaderGroup[] {
  const groups: HeaderGroup[] = [];
  const byKey = new Map<string, HeaderGroup>();
  for (const line of lines) {
    const key = headerKey(line.name);
    let group = byKey.get(key);
    if (!group) {
      group = {
        name: line.name,
        key,
        values: [],
        mergeable: !isNonMergeable(line.name),
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.values.push(line.value);
  }
  return groups;
}

/** RFC 9110 merged view: mergeable fields fold with ", ", non-mergeable stay separate. */
export function mergeHeaders(lines: HeaderLine[]): {name: string; value: string}[] {
  const out: {name: string; value: string}[] = [];
  for (const group of groupHeaders(lines)) {
    if (group.mergeable) out.push({name: group.name, value: group.values.join(', ')});
    else for (const value of group.values) out.push({name: group.name, value});
  }
  return out;
}

/** Fully flattened ordered (name, value) pairs — one entry per stored row. */
export function headerPairs(lines: HeaderLine[]): {name: string; value: string}[] {
  return lines.map(line => ({name: line.name, value: line.value}));
}
