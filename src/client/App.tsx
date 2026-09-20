import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {MutableRefObject} from 'react';
import {ArrowDown, ArrowUp, FlaskConical, Play, Plus, Save, Trash2, X} from 'lucide-react';
import {
  HeaderLine,
  groupHeaders,
  mergeHeaders,
  migrateHeaders,
  newHeaderId,
  validateHeaderLines,
} from '../shared/headers';

type Summary = {id: string; name: string; revision: number; updatedAt: string};
type WireStep = {
  id: string;
  method: string;
  url: string;
  requestHeaders: HeaderLine[];
  responseStatus: number;
  responseHeaders: HeaderLine[];
  responseBody: string;
};
type WireScenario = Summary & {content: string; steps: WireStep[]};

type StepDraft = WireStep;
type Draft = {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  content: string;
  steps: StepDraft[];
};

type Bucket = {stepId: string; kind: 'requestHeaders' | 'responseHeaders'};

const EMPTY: Draft = {
  id: '',
  name: '',
  revision: 0,
  updatedAt: '',
  content: '',
  steps: [],
};

function fromWire(value: WireScenario): Draft {
  // Tolerate legacy object-shaped headers even though the server normally
  // migrates them before responding.
  return {
    ...value,
    steps: value.steps.map(step => ({
      ...step,
      requestHeaders: migrateHeaders(step.requestHeaders),
      responseHeaders: migrateHeaders(step.responseHeaders),
      responseBody: step.responseBody ?? '',
    })),
  };
}

function newStep(): StepDraft {
  return {
    id: newHeaderId(),
    method: 'GET',
    url: '',
    requestHeaders: [],
    responseStatus: 200,
    responseHeaders: [],
    responseBody: '',
  };
}

export default function App() {
  const [items, setItems] = useState<Summary[]>([]);
  const [selected, setSelected] = useState('alpha');
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [status, setStatus] = useState('Ready');
  const [conflict, setConflict] = useState<WireScenario | null>(null);
  const [serverIssues, setServerIssues] = useState<{headerId: string; message: string}[]>([]);
  const [replay, setReplay] = useState<unknown>(null);
  const [dragRow, setDragRow] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const addFocus = useRef<{bucket: Bucket; id: string} | null>(null);

  useEffect(() => {
    fetch('/api/scenarios')
      .then(r => r.json())
      .then(setItems);
  }, []);

  const reload = useCallback((id: string) => {
    setStatus('Loading');
    setConflict(null);
    setServerIssues([]);
    fetch('/api/scenarios/' + id)
      .then(r => r.json())
      .then((value: WireScenario) => {
        setDraft(fromWire(value));
        setStatus('Loaded');
      });
  }, []);

  useEffect(() => reload(selected), [selected, reload]);

  // Refetch if another browser tab/page saves the same scenario; the ETag
  // revision changes out from under us and a later save must then 409.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'saved:' + selected) reload(selected);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [selected, reload]);

  const updateStep = (stepId: string, patch: Partial<StepDraft>) =>
    setDraft(d => ({
      ...d,
      steps: d.steps.map(step => (step.id === stepId ? {...step, ...patch} : step)),
    }));

  const mutateRows = (
    stepId: string,
    kind: Bucket['kind'],
    fn: (rows: HeaderLine[]) => HeaderLine[],
  ) =>
    setDraft(d => ({
      ...d,
      steps: d.steps.map(step =>
        step.id === stepId ? {...step, [kind]: fn(step[kind])} : step,
      ),
    }));

  const patchRow = (bucket: Bucket, rowId: string, patch: Partial<HeaderLine>) =>
    mutateRows(bucket.stepId, bucket.kind, rows =>
      rows.map(row => (row.id === rowId ? {...row, ...patch} : row)),
    );

  const addRow = (bucket: Bucket) => {
    const row: HeaderLine = {id: newHeaderId(), name: '', value: ''};
    addFocus.current = {bucket, id: row.id};
    mutateRows(bucket.stepId, bucket.kind, rows => [...rows, row]);
  };

  const removeRow = (bucket: Bucket, rowId: string) =>
    mutateRows(bucket.stepId, bucket.kind, rows => rows.filter(row => row.id !== rowId));

  const moveRow = (bucket: Bucket, rowId: string, delta: number) =>
    mutateRows(bucket.stepId, bucket.kind, rows => {
      const index = rows.findIndex(row => row.id === rowId);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= rows.length) return rows;
      const next = [...rows];
      const [row] = next.splice(index, 1);
      next.splice(target, 0, row);
      return next;
    });

  // Drag reordering works off stable ids: dropping row A over row B reinserts
  // A at B's position. No ids are ever regenerated, so React keeps the same
  // DOM nodes (and the user's focus) on the same logical lines.
  const dropOn = (bucket: Bucket, targetId: string) => {
    const sourceId = dragRow;
    setDragRow(null);
    setDragOver(null);
    if (!sourceId || sourceId === targetId) return;
    mutateRows(bucket.stepId, bucket.kind, rows => {
      const from = rows.findIndex(row => row.id === sourceId);
      const to = rows.findIndex(row => row.id === targetId);
      if (from < 0 || to < 0) return rows;
      const next = [...rows];
      const [row] = next.splice(from, 1);
      next.splice(to, 0, row);
      return next;
    });
  };

  const localIssues = useMemo(() => {
    const map = new Map<string, string>();
    for (const step of draft.steps) {
      for (const bucket of [step.requestHeaders, step.responseHeaders]) {
        for (const issue of validateHeaderLines(bucket)) map.set(issue.id, issue.message);
      }
    }
    return map;
  }, [draft]);

  const issueFor = (rowId: string) => localIssues.get(rowId)
    ?? serverIssues.find(issue => issue.headerId === rowId)?.message;

  async function save() {
    if (!draft.id) return;
    setStatus('Saving');
    setConflict(null);
    setServerIssues([]);
    const response = await fetch('/api/scenarios/' + draft.id, {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        name: draft.name,
        revision: draft.revision,
        content: draft.content,
        steps: draft.steps.map(step => ({
          id: step.id,
          method: step.method,
          url: step.url,
          responseStatus: step.responseStatus,
          responseBody: step.responseBody,
          // Ordered rows with their stable ids — no object map anywhere.
          requestHeaders: step.requestHeaders,
          responseHeaders: step.responseHeaders,
        })),
      }),
    });
    const value = await response.json();
    if (response.status === 409) {
      // Concurrent save from another page: keep this page's edits and surface
      // the winner instead of silently overwriting or clobbering the draft.
      setConflict(value.current);
      setStatus('Revision conflict');
      return;
    }
    if (!response.ok) {
      if (Array.isArray(value.issues)) setServerIssues(value.issues);
      setStatus('Save rejected');
      return;
    }
    setDraft(fromWire(value));
    setItems(list => list.map(item => (item.id === value.id ? value : item)));
    // Signal other open pages/tabs that a newer revision exists.
    localStorage.setItem('saved:' + value.id, String(value.revision));
    setStatus('Saved');
  }

  async function replayScenario() {
    if (!draft.id) return;
    setStatus('Replaying');
    const response = await fetch('/api/scenarios/' + draft.id + '/replay');
    setReplay(await response.json());
    setStatus('Replayed');
  }

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>API Scenario Studio</strong>
        <small>Local workspace · ordered multi-value headers</small>
      </header>
      <section className="workspace">
        <aside className="pane">
          <h2>Items</h2>
          <div className="list">
            {items.map(item => (
              <button
                className={item.id === selected ? 'active' : ''}
                onClick={() => setSelected(item.id)}
                key={item.id}
              >
                {item.name}
                <br />
                <small>Revision {item.revision}</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="pane">
          <div className="toolbar">
            <button className="primary" onClick={save}>
              <Save size={15} />
              Save (rev {draft.revision})
            </button>
            <button onClick={replayScenario}>
              <Play size={15} />
              Replay
            </button>
            <span>{status}</span>
          </div>

          {conflict && (
            <div className="conflict" role="alert">
              <strong>Another page saved revision {conflict.revision} first.</strong>
              <span>Your edits are preserved below; reload to start from the newest version.</span>
              <button onClick={() => reload(draft.id)}>
                <X size={14} /> Reload newest
              </button>
            </div>
          )}

          <div className="steps">
            {draft.steps.map((step, stepIndex) => (
              <article className="step" key={step.id}>
                <header className="step-head">
                  <span className="step-index">#{stepIndex + 1}</span>
                  <input
                    aria-label="Method"
                    className="method"
                    value={step.method}
                    onChange={event => updateStep(step.id, {method: event.target.value})}
                  />
                  <input
                    aria-label="URL"
                    className="url"
                    value={step.url}
                    placeholder="https://example.test/path"
                    onChange={event => updateStep(step.id, {url: event.target.value})}
                  />
                  <input
                    aria-label="Response status"
                    className="status"
                    type="number"
                    value={step.responseStatus}
                    onChange={event =>
                      updateStep(step.id, {responseStatus: Number(event.target.value)})
                    }
                  />
                  <button
                    className="icon"
                    title="Delete step"
                    onClick={() =>
                      setDraft(d => ({...d, steps: d.steps.filter(s => s.id !== step.id)}))
                    }
                  >
                    <Trash2 size={15} />
                  </button>
                </header>

                <HeaderTable
                  title="Request headers"
                  bucket={{stepId: step.id, kind: 'requestHeaders'}}
                  rows={step.requestHeaders}
                  issueFor={issueFor}
                  onPatch={patchRow}
                  onAdd={addRow}
                  onRemove={removeRow}
                  onMove={moveRow}
                  dragRow={dragRow}
                  dragOver={dragOver}
                  setDragRow={setDragRow}
                  setDragOver={setDragOver}
                  onDrop={dropOn}
                  addFocus={addFocus}
                />

                <HeaderTable
                  title="Response headers"
                  bucket={{stepId: step.id, kind: 'responseHeaders'}}
                  rows={step.responseHeaders}
                  issueFor={issueFor}
                  onPatch={patchRow}
                  onAdd={addRow}
                  onRemove={removeRow}
                  onMove={moveRow}
                  dragRow={dragRow}
                  dragOver={dragOver}
                  setDragRow={setDragRow}
                  setDragOver={setDragOver}
                  onDrop={dropOn}
                  addFocus={addFocus}
                />

                <textarea
                  aria-label="Response body"
                  className="body"
                  value={step.responseBody}
                  onChange={event => updateStep(step.id, {responseBody: event.target.value})}
                />
              </article>
            ))}
          </div>

          <button
            className="add-step"
            onClick={() => setDraft(d => ({...d, steps: [...d.steps, newStep()]}))}
          >
            <Plus size={15} /> Add step
          </button>
        </section>

        <aside className="pane">
          <h2>Replay preview</h2>
          <MergedView draft={draft} />
          <pre>{JSON.stringify(replay, null, 2)}</pre>
        </aside>
      </section>
    </main>
  );
}

type HeaderTableProps = {
  title: string;
  bucket: Bucket;
  rows: HeaderLine[];
  issueFor: (rowId: string) => string | undefined;
  onPatch: (bucket: Bucket, rowId: string, patch: Partial<HeaderLine>) => void;
  onAdd: (bucket: Bucket) => void;
  onRemove: (bucket: Bucket, rowId: string) => void;
  onMove: (bucket: Bucket, rowId: string, delta: number) => void;
  dragRow: string | null;
  dragOver: string | null;
  setDragRow: (id: string | null) => void;
  setDragOver: (id: string | null) => void;
  onDrop: (bucket: Bucket, targetId: string) => void;
  addFocus: MutableRefObject<{bucket: Bucket; id: string} | null>;
};

function HeaderTable(props: HeaderTableProps) {
  const {title, bucket, rows} = props;
  // Multiplicity per case-insensitive name drives the duplicate badge.
  const repeated = useMemo(() => {
    const counts = new Map<string, number>();
    for (const group of groupHeaders(rows)) counts.set(group.key, group.values.length);
    return counts;
  }, [rows]);

  return (
    <div className="headers">
      <div className="headers-head">
        <h4>{title}</h4>
        <button onClick={() => props.onAdd(bucket)}>
          <Plus size={13} /> Add row
        </button>
      </div>
      {rows.length === 0 && <p className="empty">No header rows.</p>}
      {rows.map((row, index) => {
        const issue = props.issueFor(row.id);
        const count = repeated.get(row.name.trim().toLowerCase()) ?? 1;
        const pending = props.addFocus.current;
        const autoFocus = pending?.bucket.stepId === bucket.stepId &&
          pending.bucket.kind === bucket.kind && pending.id === row.id;
        if (autoFocus) props.addFocus.current = null;
        return (
          <div
            className={
              'header-row' +
              (props.dragRow === row.id ? ' dragging' : '') +
              (props.dragOver === row.id ? ' dragover' : '') +
              (issue ? ' invalid' : '')
            }
            key={row.id}
            draggable
            onDragStart={() => props.setDragRow(row.id)}
            onDragEnd={() => {
              props.setDragRow(null);
              props.setDragOver(null);
            }}
            onDragOver={event => {
              event.preventDefault();
              if (props.dragOver !== row.id) props.setDragOver(row.id);
            }}
            onDrop={event => {
              event.preventDefault();
              props.onDrop(bucket, row.id);
            }}
          >
            <span className="grip" title="Drag to reorder">⠿</span>
            <div className="fields">
              <div className="inputs">
                <input
                  aria-label={`${title} name ${index + 1}`}
                  className="hname"
                  value={row.name}
                  autoFocus={autoFocus}
                  placeholder="Name"
                  onChange={event => props.onPatch(bucket, row.id, {name: event.target.value})}
                />
                <input
                  aria-label={`${title} value ${index + 1}`}
                  className="hvalue"
                  value={row.value}
                  placeholder="Value"
                  onChange={event => props.onPatch(bucket, row.id, {value: event.target.value})}
                />
              </div>
              {issue && <small className="row-error" data-row-id={row.id}>{issue}</small>}
            </div>
            {count > 1 && <span className="badge" title="Duplicate field name (case-insensitive)">×{count}</span>}
            <div className="row-actions">
              <button disabled={index === 0} onClick={() => props.onMove(bucket, row.id, -1)} title="Move up">
                <ArrowUp size={14} />
              </button>
              <button disabled={index === rows.length - 1} onClick={() => props.onMove(bucket, row.id, 1)} title="Move down">
                <ArrowDown size={14} />
              </button>
              <button onClick={() => props.onRemove(bucket, row.id)} title="Delete row">
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MergedView({draft}: {draft: Draft}) {
  return (
    <div className="merged">
      {draft.steps.map(step => {
        const mergedResponse = mergeHeaders(step.responseHeaders);
        const rawSetCookie = step.responseHeaders.filter(
          row => row.name.trim().toLowerCase() === 'set-cookie',
        );
        return (
          <div key={step.id}>
            <span className="pill">
              {step.method || 'GET'} {step.url || '(no url)'} → {step.responseStatus}
            </span>
            <ul>
              {mergedResponse.map((header, i) => (
                <li key={i}>
                  <code>{header.name}: {header.value}</code>
                </li>
              ))}
            </ul>
            {rawSetCookie.length > 1 && (
              <p className="note">
                {rawSetCookie.length} independent Set-Cookie lines are preserved on the wire.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
