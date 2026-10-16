# 0.5.0 release review

- 34 native tools;38 with the separately configured source adapter.
- 255 offline checks:3 framing,9 revision ordering,116 transport/schema,
  12 standalone protocol,90 plugin VM,25 Python helper checks; plus build parity.
- Windows editor6.1.4 and6.0.5:1,200 resources/13 pages, independent-client
  optimistic write conflicts, fresh validated screenshots, external refresh/import/delete.
- Controllers, relations and six numeric transition tracks were exercised through
  real stdio clients, saved XML, complete editor restarts and native frame sampling.
- Combined fixtures verify controller actions/gear bindings alongside relations,
  transitions and original object CRUD/publication. No editor binaries, credentials,
  extracted code, private project assets or raw runtime logs are distributed here.
- Known constraints and unimplemented broader editing options are explicit in NEXT.md.
- UI/source-backend changes are not coordinated native MCP writers; partial native
  failures are not transactional; ordinary Undo is not guaranteed. Version coverage
  does not imply every API, OS, engine runtime or output format works.

The following record is historical; its open items are not the current0.5.0 status.

---

# 0.4.0 release review

## Fixed in this iteration

| Finding | Resolution |
|---|---|
| Mandatory sibling analysis scripts, demo manifests and source reconstruction | Self-contained native helper; reconstruction is an explicit optional adapter |
| Plugin required port 17931 despite configurable server port | Shared admissible port range 1024–65535; alternate-port tests |
| readline buffered unlimited bytes before length check | Streaming bounded line framing; oversize detected before newline, recovery at delimiter |
| Cancel notifications ignored for queued edits | Cancel before dispatch without sending an editor request; no false claim of undoing active effects |
| Ping bypass had no global outstanding-request bound | 64-request admission cap plus existing 32-operation serial queue |
| Native request deadline began before the initial handshake | Handshake precedes the operation deadline |
| Oversized declared HTTP responses left unread | Cancel the response body on header size rejection |
| Tool descriptions did not distinguish optional deployment | 18 native tools by default; 22 with explicit source backend |
| Distribution risk from local config/logs/editor/project data | Explicit source-only publishing, ignore rules and pre-upload tree scan |
| Existing plugin could be overwritten silently | Installation preflight; mismatches require explicit update/backup |

## Verification levels

- Predecessor regression: 86 Node transport/schema/mock-helper checks, 36 plugin VM checks.
- Current: 86 Node checks, 38 plugin VM checks, 12 standalone protocol/cancellation checks,
  3 line-framing checks, 17 Python helper tests, generated-plugin parity check.
- These automated checks are **not** native editor compatibility proofs. They use managed API stubs,
  loopback HTTP mocks and disposable local files.
- Predecessor native evidence covered original Windows 6.1.4 read/edit/save/publish, component/object CRUD,
  and a bounded 330-second liveness observation. It does not imply all versions work.
- Current native 0.4.0: 15 real stdio checks against an unmodified original 6.1.4 working copy, on alternate port 18123: startup, 22-tool catalogue with external source adapter, source inspection, read/edit/save, publish, independent text decode, create/read/delete component, text and published-output restoration, advancing session and background hold. No mouse/keyboard actions were used.
- The first native run exposed the `Gesture_fui.bytes` naming variant. That failed record was retained; the verifier was fixed and the successful run independently decoded the newly published text.
- Raw local evidence and fixture data are retained outside this repository, not uploaded.

## Still open

- Native screenshot and refresh end-to-end verification.
- General publish-name/output-format support; current artifact verification is not full binary decoding.
- Broad native property coverage and partial-failure transaction semantics.
- Cross-process durable deduplication and conflict coordination between multiple MCP clients.
- Performance on large resource trees and finer-grained output pagination.
- macOS/Linux editor compatibility, further editor versions, and source-backend package distribution.

The tests support the listed observations only. A full editor reconstruction, SDK compatibility
matrix or Godot integration is not delivered by this MCP repository.
