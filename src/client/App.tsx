import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ArrowDown, ArrowUp, FlaskConical, GripVertical, Play, Plus, RotateCcw, Save, Trash2} from 'lucide-react';
import {
  mergeHeaders,
  newHeaderId,
  stripBlankRows,
  toWireLines,
  validateHeaders,
  validateStatus,
  type HeaderEntry,
  type HeaderIssue,
  type Scenario,
} from '../shared/headers';

type Summary = {id: string; name: string; revision: number; updatedAt: string};
type LoadedScenario = Scenario & {mergedHeaders?: Array<{name: string; value: string}>};

export default function App() {
  const [items, setItems] = useState<Summary[]>([]);
  const [selected, setSelected] = useState('alpha');
  const [draft, setDraft] = useState<ScenarioResponseDraft | null>(null);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState('Ready');
  const [issues, setIssues] = useState<HeaderIssue[]>([]);
  const [conflict, setConflict] = useState<LoadedScenario | null>(null);
  const [mergeView, setMergeView] = useState(false);
  const [replayResult, setReplayResult] = useState<{status: number; body: string} | null>(null);
  const dragId = useRef<string | null>(null);

  useEffect(() => {
    fetch('/api/scenarios')
      .then((r) => r.json())
      .then(setItems);
  }, []);

  const load = useCallback((id: string) => {
    setStatus('Loading');
    setConflict(null);
    setIssues([]);
    setReplayResult(null);
    fetch(`/api/scenarios/${id}`)
      .then((r) => r.json())
      .then((value: LoadedScenario) => {
        setRevision(value.revision);
        setDraft({status: value.response.status, headers: value.response.headers, body: value.response.body});
        setStatus('Loaded');
      });
  }, []);

  useEffect(() => {
    load(selected);
  }, [selected, load]);

  const updateRow = useCallback((id: string, patch: Partial<Omit<HeaderEntry, 'id'>>) => {
    setDraft((current) =>
      current ? {...current, headers: current.headers.map((row) => (row.id === id ? {...row, ...patch} : row))} : current,
    );
    setIssues((current) => current.filter((issue) => issue.id !== id || issue.field === 'status'));
  }, []);

  const addRow = useCallback(() => {
    setDraft((current) =>
      current ? {...current, headers: [...current.headers, {id: newHeaderId(), name: '', value: ''}]} : current,
    );
  }, []);

  const removeRow = useCallback((id: string) => {
    setDraft((current) => (current ? {...current, headers: current.headers.filter((row) => row.id !== id)} : current));
    setIssues((current) => current.filter((issue) => issue.id !== id));
  }, []);

  const moveRow = useCallback((id: string, direction: -1 | 1) => {
    setDraft((current) => {
      if (!current) return current;
      const from = current.headers.findIndex((row) => row.id === id);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= current.headers.length) return current;
      const headers = current.headers.slice();
      const [row] = headers.splice(from, 1);
      headers.splice(to, 0, row);
      return {...current, headers};
    });
  }, []);

  const reorder = useCallback((draggedId: string, targetId: string) => {
    if (draggedId === targetId) return;
    setDraft((current) => {
      if (!current) return current;
      const headers = current.headers.slice();
      const from = headers.findIndex((row) => row.id === draggedId);
      if (from < 0) return current;
      const [row] = headers.splice(from, 1);
      const to = headers.findIndex((entry) => entry.id === targetId);
      if (to < 0) return current;
      headers.splice(to, 0, row);
      return {...current, headers};
    });
  }, []);

  async function save(overwrite = false) {
    if (!draft) return;
    const nextRevision = overwrite && conflict ? conflict.revision : revision;
    setStatus('Saving');
    const response = await fetch(`/api/scenarios/${selected}`, {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({revision: nextRevision, response: {...draft, headers: stripBlankRows(draft.headers)}}),
    });
    const value = await response.json();
    if (response.status === 409) {
      setConflict(value.current);
      setStatus('Revision conflict');
      return;
    }
    if (response.status === 400) {
      setIssues(value.issues ?? []);
      setStatus('Validation failed');
      return;
    }
    if (!response.ok) {
      setStatus(`Save failed (${response.status})`);
      return;
    }
    // Success: adopt the normalized server rows (and their ids, which are
    // ours, preserved verbatim), so the UI never renumbers lines.
    setRevision(value.revision);
    setDraft({status: value.response.status, headers: value.response.headers, body: value.response.body});
    setConflict(null);
    setIssues([]);
    setStatus('Saved');
  }

  async function replay() {
    setStatus('Replaying');
    const response = await fetch(`/api/scenarios/${selected}/replay`, {method: 'POST'});
    const body = await response.text();
    setReplayResult({status: response.status, body});
    setStatus('Replayed');
  }

  const wireLines = useMemo(() => (draft ? toWireLines(draft.headers) : []), [draft]);
  const merged = useMemo(() => (draft ? mergeHeaders(draft.headers) : []), [draft]);
  const clientIssues = useMemo(
    () => (draft ? [...validateStatus(draft.status), ...validateHeaders(draft.headers)] : []),
    [draft],
  );
  const shownIssues = issues.length > 0 ? issues : clientIssues;
  const rowError = (id: string, field: 'name' | 'value') =>
    shownIssues.find((issue) => issue.id === id && issue.field === field)?.message;
  const statusError = shownIssues.find((issue) => issue.field === 'status')?.message;

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>API Scenario Studio</strong>
        <small>Local workspace</small>
      </header>
      <section className="workspace">
        <aside className="pane">
          <h2>Items</h2>
          <div className="list">
            {items.map((item) => (
              <button className={item.id === selected ? 'active' : ''} onClick={() => setSelected(item.id)} key={item.id}>
                {item.name}
                <br />
                <small>Revision {item.revision}</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="pane">
          <div className="toolbar">
            <button className="primary" onClick={() => save(false)}>
              <Save size={15} />
              Save
            </button>
            <button onClick={replay}>
              <Play size={15} />
              Replay
            </button>
            <span>{status}</span>
          </div>

          {conflict && (
            <div className="conflict" role="alert">
              <strong>Another page saved revision {conflict.revision}.</strong>{' '}
              <span>Your changes are still open.</span>
              <div className="conflict-actions">
                <button onClick={() => load(selected)}>
                  <RotateCcw size={14} /> Reload theirs
                </button>
                <button className="primary" onClick={() => save(true)}>
                  Overwrite with mine
                </button>
              </div>
            </div>
          )}

          {draft && (
            <>
              <label className="status-field">
                Status
                <input
                  aria-label="Status code"
                  type="number"
                  min={100}
                  max={599}
                  value={Number.isFinite(draft.status) ? draft.status : ''}
                  onChange={(event) => setDraft({...draft, status: Number(event.target.value)})}
                  className={statusError ? 'invalid' : ''}
                />
                {statusError && <small className="error">{statusError}</small>}
              </label>

              <table className="headers">
                <thead>
                  <tr>
                    <th className="drag-col" />
                    <th>Header name</th>
                    <th>Value</th>
                    <th className="row-actions-col" />
                  </tr>
                </thead>
                <tbody>
                  {draft.headers.map((row, index) => {
                    const nameError = rowError(row.id, 'name');
                    const valueError = rowError(row.id, 'value');
                    return (
                      <tr
                        key={row.id}
                        className={dragId.current === row.id ? 'dragging' : ''}
                        onDragOver={(event) => {
                          event.preventDefault();
                          if (dragId.current && dragId.current !== row.id) reorder(dragId.current, row.id);
                        }}
                      >
                        <td className="drag-col">
                          <button
                            className="icon drag-handle"
                            title="Drag to reorder"
                            draggable
                            onDragStart={() => {
                              dragId.current = row.id;
                            }}
                            onDragEnd={() => {
                              dragId.current = null;
                            }}
                          >
                            <GripVertical size={15} />
                          </button>
                        </td>
                        <td>
                          <input
                            aria-label={`Header name ${index + 1}`}
                            className={nameError ? 'invalid' : ''}
                            value={row.name}
                            placeholder="Set-Cookie"
                            onChange={(event) => updateRow(row.id, {name: event.target.value})}
                          />
                          {nameError && <small className="error">{nameError}</small>}
                        </td>
                        <td>
                          <input
                            aria-label={`Header value ${index + 1}`}
                            className={valueError ? 'invalid' : ''}
                            value={row.value}
                            onChange={(event) => updateRow(row.id, {value: event.target.value})}
                          />
                          {valueError && <small className="error">{valueError}</small>}
                        </td>
                        <td className="row-actions-col">
                          <button className="icon" title="Move up" disabled={index === 0} onClick={() => moveRow(row.id, -1)}>
                            <ArrowUp size={14} />
                          </button>
                          <button
                            className="icon"
                            title="Move down"
                            disabled={index === draft.headers.length - 1}
                            onClick={() => moveRow(row.id, 1)}
                          >
                            <ArrowDown size={14} />
                          </button>
                          <button className="icon danger" title="Delete row" onClick={() => removeRow(row.id)}>
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <button className="add-row" onClick={addRow}>
                <Plus size={14} /> Add header
              </button>

              <h3 className="body-title">Body</h3>
              <textarea aria-label="Body" value={draft.body} onChange={(event) => setDraft({...draft, body: event.target.value})} />
            </>
          )}
        </section>

        <aside className="pane">
          <h2>Preview</h2>
          <span className="pill">{selected}</span>
          {draft && (
            <div className="preview">
              <div className="preview-toggle">
                <button className={mergeView ? '' : 'active'} onClick={() => setMergeView(false)}>
                  Wire lines ({wireLines.length})
                </button>
                <button className={mergeView ? 'active' : ''} onClick={() => setMergeView(true)}>
                  Merged view ({merged.length})
                </button>
              </div>
              <pre className="wire">
                {`HTTP/1.1 ${draft.status}\r\n`}
                {(mergeView ? merged.map((line) => [line.name, line.value] as const) : wireLines)
                  .map(([name, value]) => `${name}: ${value}`)
                  .join('\r\n')}
              </pre>
              {mergeView && (
                <p className="hint">Set-Cookie and other non-combinable fields always stay on independent lines.</p>
              )}
              <h3>Replayed response</h3>
              {replayResult ? (
                <pre className="wire">
                  HTTP/1.1 {replayResult.status}
                  {'\n'}
                  {replayResult.body}
                </pre>
              ) : (
                <p className="hint">Press Replay to send this scenario through the replay adapter.</p>
              )}
              <small className="hint">Revision {revision}</small>
            </div>
          )}
        </aside>
      </section>
    </main>
  );
}

type ScenarioResponseDraft = {
  status: number;
  headers: HeaderEntry[];
  body: string;
};
