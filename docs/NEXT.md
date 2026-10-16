# 0.5.0 development: native observability and coordination

This is an in-progress branch, not a declaration that the full expansion goal is complete.

## Bounded pagination

Use `list_items_page({pkg, limit: 100})`, then pass its `nextCursor` to the next call.
Each result contains flat rows including `id`, `parentId`, `depth` and `childCount`.
The package root is included. A final page may contain no rows after traversal-stack cleanup.
Stop on `done`, not on an empty `items` array.

- Maximum 100 rows and approximately 45 KiB row data per page.
- Maximum 512 traversal steps per request and 64 ancestor frames per cursor.
- Maximum 16 active cursors, 60-second sliding expiry, single-use continuation tokens.
- Native MCP mutations invalidate all outstanding cursors, even when they partially fail.
- An observed ancestor identity/count change also rejects continuation.
- External GUI/file edits are **not** a transactionally frozen snapshot; same-count replacements
  may escape detection. Restart traversal after external editing.

The old `list_items` tool remains for small trees. Original-editor testing used 1,200 generated
components: the old 1,024-node bound failed explicitly; the new tool read every component once
in 13 pages. Offline tests additionally cover 5,000 children and UTF-8 response-byte limits.

## Multi-client writes

The plugin serializes all native requests from every MCP process and owns a session revision.
The server caches the revision from a successful native observation and sends it as
`expectedRevision` on mutations. The plugin checks it at dispatch, **before** mutation, and
advances it on completion (including potentially partial failure). Requests rejected before
dispatch do not consume a write revision.

If two clients act on the same observed revision, the first dispatched mutation wins; the other
receives `REVISION_CONFLICT`. Inspect fresh state before deciding whether to reissue the edit.
There is no automatic retry, merge, transaction rollback or cross-restart revision continuity.
This protects native MCP writers, not independent GUI edits or separate `source_*` backend processes.
Direct bridge clients must supply `expectedRevision`; update plugin and server together.

## Screenshots

The previous Unity `ScreenCapture.CaptureScreenshot` entry point is absent from the observed
6.1.4 JS bindings. The native implementation now uses the declared editor root display:

`App.groot.displayObject.GetScreenShot` → bounded RGB/RGBA texture → row reversal →
`VImage.New` → PNG save → texture/image release → Python PNG verification.

Capture includes editor UI content, **not** desktop pixels or OS window chrome.
Existing output files are preserved; choose a fresh `.png` path inside `screenshotDir`.
The verifier checks PNG chunk CRCs, dimensions, bounded zlib output and filter codes.
It does not infer whether the captured UI looks correct; native evidence additionally includes
visual inspection of the 1920×1057 image with upright text and resource tree.

## Refresh

`refresh` now rejects unsaved documents before calling `App.RefreshProject`.
The call requests refresh; it does not prove asynchronous imports have finished.
Native verification created an external component XML, requested refresh, polled
`read_component` until it appeared, and deleted it through the editor API.

## Native controllers

Five new tools operate on a component root through `Document` APIs:

- `controller_list({pkg,name,controller?,offset?,limit?})`: bounded names, export flags, selected indices and native page IDs. Follow `nextOffset`; restart after revision/external changes (not a snapshot).
- `controller_create({pkg,name,controller,pages,exported?})`: generates page IDs natively.
- `controller_update({pkg,name,controller,newName?,exported?,pageNames?:[{id,name}]})`:
  clones native XML and edits only requested fields, preserving page IDs and opaque native fields.
- `controller_select({pkg,name,controller,index})`: switches the editor preview page and reads it back.
  `previousIndex` is the old selection; selected preview state persistence is editor-defined.
- `controller_remove({pkg,name,controller})`: native deletion; linked gears/actions may be affected.

Mutations participate in revision conflict checks, wait for the component document to load,
reject dirty documents instead of saving unrelated work, then save through the native facade. A still-dirty document after save is an error, not success.
This flag check is not an independent fsync/byte-equality guarantee; native regression also reads saved XML.
Names are bounded to128 characters without commas; up to100 controllers/pages are supported.
Update currently covers controller name/export and existing page names, not page deletion,
reordering, controller actions, or gear assignment. Use stable page IDs returned by reads.
There is no automatic undo on partial native failure. Read fresh state before retrying.
Native Undo/Redo is not verified for these tools. In particular, shipped6.1.4 history code
looks controllers up by the pre-edit name, so a rename can invalidate its undo entry.
`controller_update` returns `history.nativeUndoVerified:false` and `renameUndoRisk` on rename;
do not rely on editor Undo to restore a renamed controller. Keep a project backup.
Native tests cover create/update/select/delete and persistence across a complete editor restart;
mock tests additionally exercise dirty documents, absent capabilities, invalid inputs and stale writers.

## Observed editor compatibility

The same plugin was executed on original Windows6.1.4 and official Windows6.0.5.
Both passed the generated1,200-component/13-page scenario, independent-client write conflict,
external refresh/import/delete, validated native screenshot, and controller CRUD with restart
persistence. This is a feature-scoped compatibility result, not all editor/API coverage.
The6.0.5 screenshot was visually checked for upright menus, tree and baseline text.
No binaries, generated project, private configuration or runtime logs are shipped here.

A regression exposed restored inactive documents with unloaded content: `ensureDocOpen`
now explicitly opens those tabs before waiting. Pagination preserves native string resource
kinds rather than coercing them to numbers/null. Delayed ping replies cannot reduce a
client's observed revision within a session; a new session resets that revision.

## Remaining goal scope

Other editor versions and untested APIs still require actual execution; declarations alone are not compatibility proof.
Transition and relation APIs are mapped from shipped declarations but not yet exposed and verified.
Controller actions/gear editing and deeper page editing remain beyond the initial five tools.
These are active work, not implied by existing tests.
