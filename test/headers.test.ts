import {describe, expect, it} from 'vitest';
import {
  groupHeaders,
  headerPairs,
  isNonMergeable,
  mergeHeaders,
  migrateHeaders,
  newHeaderId,
  validateHeaderLines,
} from '../src/shared/headers';

describe('ordered header model', () => {
  it('keeps duplicate headers as independent ordered rows', () => {
    const lines = migrateHeaders([
      {id: 'a', name: 'Set-Cookie', value: 'sid=abc; HttpOnly'},
      {id: 'b', name: 'Set-Cookie', value: 'track=1; Secure'},
      {id: 'c', name: 'Set-Cookie', value: 'geo=cn'},
    ]);
    expect(lines).toHaveLength(3);
    expect(headerPairs(lines).map(h => h.value)).toEqual([
      'sid=abc; HttpOnly',
      'track=1; Secure',
      'geo=cn',
    ]);
  });

  it('never merges Set-Cookie, but folds mergeable fields per RFC 9110', () => {
    const lines = migrateHeaders([
      {id: '1', name: 'Set-Cookie', value: 'a=1'},
      {id: '2', name: 'Set-Cookie', value: 'b=2'},
      {id: '3', name: 'Warning', value: '199 - "one"'},
      {id: '4', name: 'Warning', value: '214 - "two"'},
      {id: '5', name: 'X-Trace', value: 'x'},
    ]);
    const merged = mergeHeaders(lines);
    expect(merged.filter(h => isNonMergeable(h.name))).toEqual([
      {name: 'Set-Cookie', value: 'a=1'},
      {name: 'Set-Cookie', value: 'b=2'},
    ]);
    expect(merged.find(h => h.name === 'Warning')?.value).toBe('199 - "one", 214 - "two"');
    // Group position follows the first occurrence, not object-key sorting;
    // Set-Cookie stays two separate lines instead of collapsing.
    expect(merged.map(h => h.name)).toEqual([
      'Set-Cookie',
      'Set-Cookie',
      'Warning',
      'X-Trace',
    ]);
  });

  it('compares names case-insensitively while preserving the first display casing', () => {
    const lines = migrateHeaders([
      {id: '1', name: 'content-type', value: 'application/json'},
      {id: '2', name: 'Content-Type', value: 'text/plain'},
    ]);
    const groups = groupHeaders(lines);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('content-type');
    expect(groups[0].name).toBe('content-type');
    expect(groups[0].values).toEqual(['application/json', 'text/plain']);
  });

  it('preserves user order instead of sorting by key', () => {
    const lines = migrateHeaders([
      {id: '1', name: 'Zebra', value: 'z'},
      {id: '2', name: 'Apple', value: 'a'},
      {id: '3', name: 'mango', value: 'm'},
    ]);
    expect(headerPairs(lines).map(h => h.name)).toEqual(['Zebra', 'Apple', 'mango']);
  });

  it('migrates the legacy plain-object format and assigns stable ids', () => {
    const lines = migrateHeaders({'X-First': '1', 'X-Second': '2'});
    expect(lines.map(h => h.name)).toEqual(['X-First', 'X-Second']);
    expect(lines.every(h => typeof h.id === 'string' && h.id.length > 0)).toBe(true);
  });

  it('never reassigns client-supplied ids, even after reordering', () => {
    const ordered = migrateHeaders([
      {id: 'r1', name: 'A', value: '1'},
      {id: 'r2', name: 'B', value: '2'},
      {id: 'r3', name: 'C', value: '3'},
    ]);
    const [first, ...rest] = ordered;
    const moved = [...rest, first];
    expect(migrateHeaders(moved).map(h => h.id)).toEqual(['r2', 'r3', 'r1']);
  });

  it('rejects duplicated row ids and malformed rows', () => {
    expect(() =>
      migrateHeaders([
        {id: 'x', name: 'A', value: '1'},
        {id: 'x', name: 'B', value: '2'},
      ]),
    ).toThrow(/duplicate header row id/);
    expect(() => migrateHeaders([{id: 'y', name: 'A'} as never])).toThrow();
  });

  it('generates unique ids', () => {
    const ids = new Set(Array.from({length: 100}, newHeaderId));
    expect(ids.size).toBe(100);
  });

  it('validates rows and reports issues keyed by stable row id', () => {
    const issues = validateHeaderLines([
      {id: 'ok', name: 'Accept', value: 'text/plain'},
      {id: 'bad-name', name: 'Bad Name', value: 'x'},
      {id: 'empty', name: '  ', value: 'x'},
      {id: 'crlf', name: 'X-Note', value: 'a\r\nb: c'},
    ]);
    expect(issues.map(i => i.id)).toEqual(['bad-name', 'empty', 'crlf']);
  });
});
