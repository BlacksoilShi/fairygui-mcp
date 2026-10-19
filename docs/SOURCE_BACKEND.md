# Optional external reconstruction backend: fgui-rebuild-http/1

This repository distributes only the MCP client, not backend.py, an editor or an SDK.
The separately configured backend must implement this contract. Native and source layers
remain independent. Optional upload policy is in [SOUND_UPLOAD.md](SOUND_UPLOAD.md).

## Execution and tool catalogues

The MCP `server.mjs` preserves34 native tools. Without a source backend its
catalogue is unchanged. Legacy source configuration still exposes the four fixed
Gesture/Main tools. Explicit `sourceProtocol: "fgui-rebuild-http/1"` instead exposes these
four generic tools (38 total, not42):

* `source_capabilities({})`: actual backend operations, limits, session and revision.
* `source_state({package?,component?,snapshot?})`: arbitrary name/ID selection. Null/omitted
  selects the backend default. `snapshot:true` forces a stable snapshot. A state over60KiB
  automatically returns a snapshot pointer rather than truncation/failure. Continue with
  `source_state({snapshotId,offset?,limit?})`; selectors/force flag and snapshot continuation
  are mutually exclusive. Names are not interpreted as a different engine.
* `source_command({requestId,session,expectedRevision,package,component,operation,args})`:
  all fields required; selectors may be null for project/package-level operations.
  `operation` must be advertised by the live independent backend. Its exact argument
  schema remains enforced by that editor's command dispatcher; the generic JSON object
  in MCP is not a promise that every combination is valid.
* `source_receipt_read({requestId,offset?,limit?})`: persistent result fragments. Offset
  counts Unicode code points, limit1..65536, default65536. Follow `nextOffset` until null;
  concatenate `text` unchanged and verify the full UTF8 SHA256 before parsing the JSON.

Every backend response identifies `contract`, `layer: independent-source-http` and
`nativeEditorExecuted:false`. Successful live observations retain session/revision.
Native ping and native revision are a **different authority**; never substitute them.
The MCP adapter rejects a mismatched source contract/layer, with no native fallback.

## Explicit private configurations

Backend CLI: `python backend.py COMMAND JSON_ARGS`, with `FGUI_MCP_CONFIG` naming an
absolute private config file. The backend has no editor/source-code import dependency;
it connects only to the literal127.0.0.1, configured port, authenticated HTTP shell.

Backend config fields:

```json
{
  "contract": "fgui-rebuild-http/1",
  "projectPath": "ABSOLUTE_PROJECT_FILE.fairy",
  "port": 18180,
  "token": "PRIVATE_EDITOR_HTTP_TOKEN",
  "receiptDir": "ABSOLUTE_SEPARATE_PRIVATE_RECEIPT_DIRECTORY",
  "timeoutSeconds": 15
}
```

Replace the typed slots; projectPath pins one existing.fairy file, not a global registry.
Receipts must be in a separate tree from its source. Keep configuration/receipt storage
private through normal filesystem permissions. No token is included in receipts/errors.
This code is not an OS sandbox against another process running as the same user.

In the normal native MCP config, configure absolute `sourceHelper` pointing to backend.py,
absolute `sourceConfig` pointing to the backend config, and the exact `sourceProtocol`
above. Other native config fields remain required. The source project may differ from
the native project; tools always declare the distinct execution layer.

The independent HTTP editor must already be running. This candidate neither launches
another model per command nor auto-reloads an existing model: UI and MCP see the same
dirty drafts, history, pending lifecycle plan, revision and source-conflict guards.

## Admission, response loss and recovery

requestId is32 lowercase hexadecimal characters, caller-generated once for one intent.
Before dispatch, the backend acquires an OS-released ledger admission lock and fsyncs a
pending record that binds a canonical argument hash and configured project identity.
It then validates the live project path/layer/session before the single HTTP POST.
The editor itself checks expectedRevision at dispatch. Two MCP clients do not bypass it.

* Same ID/same arguments with a complete record returns that exact stored response,
  even after helper restart, without a network request.
* Same ID/different arguments or project is REQUEST_ID_CONFLICT.
* A pending record returns OUTCOME_UNKNOWN, never replays the POST.
* Timeout/disconnect/invalid response after POST is conservatively OUTCOME_UNKNOWN.
  The POST may have committed. Inspect fresh source_state and the receipt; do not
  automatically generate a new ID to retry the same intent.
* Completed structured backend errors preserve their revision, session, request ID
  and journal/recovery details through MCP error.details.sourceBackend.
* A receipt-write failure leaves admission pending. Helper/process cancellation does
  not imply editor cancellation. A helper may still finish after its caller disconnects.
* No power-loss/multi-file transaction guarantee is claimed. Filesystem/ledger edits
  by another local process and deletion of receipt tombstones invalidate deduplication.

The ledger reserves maximum response space before dispatch:64MiB total and256 records.
Pending entries reserve8MiB+64KiB each; completed records consume their actual bytes.
Full capacity rejects **before** mutation. Retention/explicit archive/reset UX is future
work. Never delete pending records or reuse an ID as an automatic recovery mechanism.

HTTP JSON responses are bounded to8MiB. Helper input/output is bounded to60KiB beneath
the public MCP64KiB limit. Large command results are stored completely and return a
small `receiptOnly` pointer; this avoids reporting failure solely because a mutation's
receipt exceeded MCP stdout capacity. `operationOk` carries the actual operation result.
Large failed receipts set MCP isError and remain readable. Large state reads capture
immutable snapshots in a separate cache, at most8 entries/32MiB and120-second absolute
TTL. Continuations read no live editor state: `live:false`, capturedSession/revision and
consistency markers distinguish historical snapshots from current state. Follow Unicode
code-point offsets and nextOffset until null; concatenate text unchanged and verify SHA256
of the complete UTF8 JSON before parsing. Initial pointers identify readWith/source_state
and startOffset0. An expired/missing snapshot explicitly requires a fresh capture; it never
falls back to a different state midway. Expired cache entries may be removed on fresh
capture, but command tombstones are never pruned. HTTP state over8MiB remains an explicit
engine/adapter limit; page transport does not make the upstream state API unbounded.
No silent truncation, invented success or full-rendering claim.

Configured HTTP timeout is1..120 seconds per request (default15). A command can involve
one GET then one POST. The MCP allows250 seconds for its helper; clients must
set a compatible timeout when choosing the maximum. No automatic network retry occurs.

## Byte-budgeted page transport

State snapshots and durable receipt reads now default to at most65536 Unicode code
points per requested page. The helper measures the **entire serialized response**,
including metadata, JSON quote/backslash escaping and UTF8 bytes, and uses bounded
binary search to return the largest prefix fitting60KiB. A non-final page always
advances; a metadata/one-character overflow reports RESPONSE_LIMIT rather than an
infinite zero-progress cursor. Follow actual nextOffset, not offset+requested limit.

Explicit legacy limits such as4096 or8192 remain valid.65537 is rejected; tests changed
only the two invalid-boundary constants8193->65537, with AST evidence that all other
legacy test code is unchanged. The input/HTTP/internal JSON depths,8MiB upstream
state bound,120-second absolute expiry,8-record/32MiB snapshot cache and64MiB command
ledger budget are unchanged. No TTL increase or partial-result success workaround.


The JSON request schema is [contract.schema.json](contract.schema.json). Actual editor
operation argument schemas are enforced by the live backend; this is not a complete
nested-operation schema. Bounded HTTP state/ledger/TTL remain explicit limits.
