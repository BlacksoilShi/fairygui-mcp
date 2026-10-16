# 0.5.0: native observability, coordination and editing

This document describes the verified 0.5.0 feature boundaries; it does not claim a complete editor reconstruction.

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

## Native relation/layout tools (development2)

`relation_list({pkg,name,objectId,offset?,limit?})` reads direct-child geometry and bounded
relation groups. `relation_set({... ,targetId,definitions:[{type,percent?}]})` replaces the
whole group for **one target only**; `relation_remove({... ,targetId})` removes that group.
`targetId` is `$parent` or a direct sibling ID. Nested children and root-to-child relations
are not yet exposed. Read native object IDs with `list_children`, not display names.

Definitions use editor names such as `Width`, `Height`, `Left_Left`, `Top_Top`, `Size`.
They map through `FairyEditor.FRelationType`, **not runtime FairyGUI.RelationType**:
editor Width is11, Height23, Top_Top12. Size expands to Width+Height; duplicate expanded
definitions are rejected. Native `FRelationItem.AddDef` creates the descriptor grammar.
Percent defaults to false. A target group replacement never means merging definitions.

Self/cyclic dependencies, disabled/read-only relations, dirty documents, unknown IDs/types
and graph inspection above256 objects/1,024 edges are rejected before mutation. Writes
participate in session revision checks. Native readback and the post-save dirty flag are
checked; partial failures are not replayed or automatically undone. Native Undo is unverified.

Native graph fixtures test parent size deltas, group replacement, percent scaling, sibling
movement, removal stopping propagation, XML persistence and behavior after editor restart.
Text with native autoSize may reflow on reopen; this API does not override text auto-sizing.
Offset lists are not immutable snapshots; restart after revision/external edits.

## Native transitions (development3)

Seven tools, original editor API, no reconstruction dependency:

- `transition_list({pkg,name,transition?,offset?,limit?})`: omit transition for summaries;
  include it for keyframes. Continue `nextOffset`; pages are not snapshots.
- `transition_create({pkg,name,transition})`: empty named transition. The native non-null
  AddTransition name argument is ignored on tested versions; the bridge creates with the
  default name then calls the native property facade to name it. Duplicate names fail.
- `transition_update({... ,settings:{frameRate?,autoPlay?,autoPlayRepeat?,autoPlayDelay?}})`:
  changes specified metadata only. Frame rate1..120, finite repeats1..100, delay0..60 seconds.
- `transition_keyframe_set({... ,targetId,type,frame,values,tween?,label?})`: upsert one tuple
  (direct child ID, type, frame), not blind append. XY/Size/Scale/Skew take `[x,y]`;
  Alpha/Rotation take `[number]`. Frames0..36000. Values are bounded finite numbers;
  native encoding uses three-decimal precision, and mismatched decoding is rejected.
- `transition_keyframe_remove({... ,targetId,type,frame})`: remove exactly that tuple.
- `transition_remove({...})`: remove named transition; inspect action references first.
- `transition_sample({... ,frame,targetIds:[id,...]})`: synchronous native edit-mode sample
  of1..20 direct children. It returns observed `samples`, `restoredSamples`,
  `checkedStateRestored` and the exact categories of checked fields. No save occurs.

Create the endpoint first, then the starting keyframe with `tween:true`. Native tweening
pairs the next strictly later frame on the same target/type track, not the next global
keyframe. Duplicate tuples and missing endpoints fail before document mutation. Deleting
an endpoint still used by a tween is rejected. Saved XML can fold endpoints into
`startValue`, `endValue`, `duration`; the read API returns expanded editor keyframes.

Editing is bounded to1,000 keyframes,100 transitions, and only the six numeric types above.
Preexisting Sound/Transition/Animation or other actions, paths, custom easing, partial or
percentage values, missing/incompatible targets, and unsupported ranges are rejected
rather than silently changed. Other transition names remain untouched. Metadata and keyframe
clones are compared to the original before editing, then read back after the native update.
Native metadata may contain additional fields that are preserved, not editable through this API.

Document.UpdateTransition operates on the *active timeline*, not the XML name. The bridge
rejects an already-active timeline or dirty document, enters the requested timeline,
checks its identity, applies the draft, exits/restores the native design snapshot, then saves.
There is no guaranteed ordinary Undo, transaction, or automatic rollback after partial failure.
A save with `isModified` still set is an error. Runtime tests additionally read saved XML and
restart the process to check persistence. Editor exceptions require fresh inspection, not retries.

`head` and RefreshTransition defer evaluation; they are not synchronous sampling APIs.
Sampling instead uses zero-duration native edit-mode playback, explicitly stops all retained
tweeners, and exits the timeline. Edit mode alone does not disable Sound/nested actions,
so the full transition is checked before playback. Internal restore verification covers
at most2,000 direct children plus root geometry, scale, skew, rotation, alpha, pivot,
visibility and gear locks, root-controller selected indices, clean document, exited timeline,
no playback and no retained tweeners. It is not a promise about every nested object or field.
Cleanup and verification also run after playback exceptions; an unconfirmed cleanup reports
TRANSITION_RESTORE_FAILED. Sampling participates in revision coordination despite not saving.

Native scenarios on6.1.4 and6.0.5 use two graph children and two transitions, modify all six numeric
tween tracks and remove a single Rotation keyframe, read bounded pages, reject orphan endpoints and unknown
targets, verify XML/design geometry, restart, edit again, and delete the fixture. Native
sampling checks start/mid/end interpolation, unchanged sibling, restored design coordinates,
and unchanged XML. Size/Scale/Skew/Rotation endpoint values and all six tracks surviving
restart are also verified. Complex actions/paths/easing and native Undo remain open work.

## Further expansion boundaries

Other versions and untested APIs require actual execution; declarations alone are not compatibility proof.
Relations cover direct-child parent/sibling groups; nested/inherited behavior remains separate.
Controller actions/gear editing and deeper page editing remain beyond the initial five tools.
Complex transition tracks and native exception recovery still need separate targeted work.
No automatic rollback or ordinary editor Undo guarantee is made. This release adds the
initial controller/transition/relation APIs, not every possible editor operation.

## Combined native regression

On both6.1.4 and6.0.5, one component combined controller rename/page-name changes,
change_page actions, gearXY/gearSize, parent-width relations and XY transition sampling.
The renamed controller retained its action and gear bindings; page switches still propagated
through the action to the second controller and its size gear. Sampling restored checked
geometry and controller selections. Restart retained these behaviors; parent resizing still
propagated. A native exported container then inserted the component, changed placement,
saved and published; the independently reopened package matched ID/header/hash checks.
Object removal and fixture deletion completed the loop. Publish artifact checks are not
full runtime rendering-equivalence proof.
