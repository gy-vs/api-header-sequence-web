import {describe, expect, it} from 'vitest';
import {
  isCombinable,
  mergeHeaders,
  migrateHeaders,
  newHeaderId,
  stripBlankRows,
  toWireLines,
  validateHeaders,
  validateStatus,
  type HeaderEntry,
} from '../src/shared/headers';

const row = (name: string, value: string, id?: string): HeaderEntry => ({id: id ?? newHeaderId(), name, value});

describe('migrateHeaders', () => {
  it('migrates the legacy object form: string and array values, order and casing preserved', () => {
    const result = migrateHeaders({
      'Content-Type': 'application/json',
      'Set-Cookie': ['a=1', 'b=2'],
      'x-trace': ['one', 'two'],
    });
    expect(result.map((entry) => [entry.name, entry.value])).toEqual([
      ['Content-Type', 'application/json'],
      ['Set-Cookie', 'a=1'],
      ['Set-Cookie', 'b=2'],
      ['x-trace', 'one'],
      ['x-trace', 'two'],
    ]);
    const ids = result.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.length > 0)).toBe(true);
  });

  it('preserves canonical array ids verbatim and drops fully blank rows', () => {
    const result = migrateHeaders([
      {id: 'client-7', name: 'X-A', value: '1'},
      {id: 'client-8', name: '', value: ''},
      {id: 'client-9', name: '', value: '   '},
    ]);
    expect(result.map((entry) => entry.id)).toEqual(['client-7']);
  });

  it('fills ids for array rows that lack them instead of throwing', () => {
    const result = migrateHeaders([{name: 'Warning', value: '199 - "x"'}]);
    expect(result[0].id.length).toBeGreaterThan(0);
  });
});

describe('mergeHeaders', () => {
  it('merges case-insensitive duplicates of combinable fields at first position using first casing', () => {
    const entries = [
      row('X-Trace', 'first', 'r1'),
      row('warning', '199 - "one"', 'r2'),
      row('x-trace', 'second', 'r3'),
      row('WARNING', '299 - "two"', 'r4'),
    ];
    expect(mergeHeaders(entries)).toEqual([
      {name: 'X-Trace', value: 'first, second'},
      {name: 'warning', value: '199 - "one", 299 - "two"'},
    ]);
  });

  it('keeps every Set-Cookie row independent even with different casing', () => {
    const entries = [row('Set-Cookie', 'a=1', 'r1'), row('set-cookie', 'b=2', 'r2')];
    expect(mergeHeaders(entries)).toEqual([
      {name: 'Set-Cookie', value: 'a=1'},
      {name: 'set-cookie', value: 'b=2'},
    ]);
    expect(isCombinable('SET-COOKIE')).toBe(false);
    expect(isCombinable('warning')).toBe(true);
  });

  it('preserves first-occurrence position when a non-combinable row interleaves duplicates', () => {
    const entries = [row('X-A', '1', 'r1'), row('Set-Cookie', 'c=1', 'r2'), row('x-a', '2', 'r3')];
    expect(mergeHeaders(entries).map((line) => line.name)).toEqual(['X-A', 'Set-Cookie']);
  });
});

describe('toWireLines', () => {
  it('emits one line per stored row, in order, with stored casing', () => {
    const entries = [
      row('X-Trace', 'first', 'r1'),
      row('Set-Cookie', 'a=1', 'r2'),
      row('X-trace', 'second', 'r3'),
      row('set-cookie', 'b=2', 'r4'),
    ];
    expect(toWireLines(entries)).toEqual([
      ['X-Trace', 'first'],
      ['Set-Cookie', 'a=1'],
      ['X-trace', 'second'],
      ['set-cookie', 'b=2'],
    ]);
  });

  it('skips rows with empty names; stripBlankRows removes fully empty rows only', () => {
    const entries = [row('', '1', 'r1'), row('X', '', 'r2'), row(' ', '', 'r3')];
    expect(toWireLines(entries)).toEqual([['X', '']]);
    // value without a name is not blank (it must be caught by validation, not silently dropped)
    expect(stripBlankRows(entries).map((entry) => entry.id)).toEqual(['r1', 'r2']);
  });
});

describe('validation', () => {
  it('flags bad names and CRLF in values keyed by row id', () => {
    const issues = validateHeaders([row('bad name', 'ok', 'r1'), row('X', 'v\r\nInjected: 1', 'r2')]);
    expect(issues).toEqual([
      {id: 'r1', field: 'name', message: 'Invalid header name token.'},
      {id: 'r2', field: 'value', message: 'Header value contains CR/LF or control characters.'},
    ]);
  });

  it('validates status range and ignores blank rows', () => {
    expect(validateStatus(204)).toEqual([]);
    expect(validateStatus(99)[0].field).toBe('status');
    expect(validateHeaders([row('', '', 'r1')])).toEqual([]);
  });
});
