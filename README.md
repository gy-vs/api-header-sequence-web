# API Scenario Studio

Local workbench for API mock-response scenarios.

Run `npm install`, then `npm run dev` (API on :4174, Vite on :4173).
`npm test` runs the Vitest suite; `npm run build` type-checks and bundles.

## Header model

Response headers are an **ordered list of rows**, not an object map:

```json
{
  "response": {
    "status": 200,
    "headers": [
      {"id": "h_…", "name": "Set-Cookie", "value": "sid=a; Path=/"},
      {"id": "h_…", "name": "set-cookie", "value": "theme=dark; Path=/"}
    ],
    "body": "…"
  }
}
```

- Rows keep user order and display casing; name comparison is case-insensitive.
- `id` is stable and client-owned; the server preserves it verbatim and never
  renumbers, so focus and per-row errors stay attached to the right row.
- Set-Cookie is non-combinable and always emitted as independent wire lines.
  Other duplicates are also stored independently; `mergedHeaders` on read
  provides the RFC 9110 `, `-joined protocol view (first occurrence position
  and casing).
- The legacy object form (`{"Name": "v"}` / `{"Set-Cookie": ["a", "b"]}`) is
  accepted on PUT and migrated on GET.

The editor preview and the `POST /api/scenarios/:id/replay` adapter share the
same `toWireLines` projection; replay writes the flat raw header array via
`writeHead`, so ordering, casing and duplicates reach the wire unchanged.
PUT uses optimistic concurrency (`revision`); a stale save gets `409` with
the current state and may reload or overwrite.
