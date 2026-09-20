import type {Response} from 'express';
import {toWireLines, type ScenarioResponse} from '../shared/headers';

/**
 * Replay an authored mock response onto a live Express response.
 *
 * Headers are written with writeHead's flat raw array (Node >= 20.2):
 * each stored row becomes one line, in stored order, with the stored
 * display casing. Unlike res.set/append + an object map, this neither
 * collapses duplicate names nor regroups rows by (case-folded) key, so
 * Set-Cookie stays independent and user reordering is honored exactly.
 *
 * This is the only place a stored response becomes bytes, and it shares
 * toWireLines() with the editor preview.
 */
export function replayResponse(res: Response, spec: ScenarioResponse): void {
  const lines = toWireLines(spec.headers);
  const raw: string[] = [];
  for (const [name, value] of lines) {
    raw.push(name, value);
  }
  // writeHead bypasses res.setHeader's case-insensitive map; flushHeaders
  // is unnecessary because writeHead sends the header block immediately.
  res.writeHead(spec.status, raw);
  res.end(spec.body ?? '');
}
