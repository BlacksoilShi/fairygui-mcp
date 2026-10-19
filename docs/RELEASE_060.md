# 0.6.0 candidate: release and upgrade boundaries

## Catalogue
- Native only:34 tools.
- Optional legacy fixed source adapter:38 tools, fixed Gesture/Main.
- Explicit fgui-rebuild-http/1:38 tools, four generic tools replace four fixed tools.
- Generic protocol plus sourceUploads=true:39 tools, provided the external backend
  independently enables upload roots. Backend code is NOT bundled.

## Native publication
configured respects the project setting. all publishes all branches. selected requires
a nonempty branch. trunk explicitly requests the trunk. all/trunk reject branch;
configured accepts it only with existing single-branch processing, rejecting it under
all-branch settings rather than silently ignoring it. Native Run Task completion is
observed before mode restoration/release.
A response timeout does not mean the native task stopped: the queue remains held while
the task drains. A durable interrupted lease blocks later writes until a guarded
restore. See [PUBLISH_OWNER_PROOF.md](PUBLISH_OWNER_PROOF.md).

## Upgrade
1. Finish outstanding operations and save/close only the configured editor.
2. Back up the current MCP code, private config and that project's plugin.
3. Replace server/helper/plugin together; preserve private token/project/port fields.
   Do not combine a new server with an old plugin or silently overwrite mismatches.
4. Start/attach, verify ping version0.6.0 and exact project identity, inspect catalogue,
   then exercise scoped read/edit/save/publish in a disposable project.
5. Interrupted publishing needs explicit editor_start recoverPublish=true; preparation
   alone is not success. Live/unknown owner, changed records and save failures block.

## Verification and limits
The candidate's production logic is inherited from the frozen recovery candidate;
only semantic version constants and line endings change during release assembly.
The independent release is rerun through generated-source parity, protocol/transport,
plugin VM, helper/owner/recovery and install/metadata checks. Recorded native6.0.5/6.1.4
interruption/recovery/publication tests apply to the preceding candidate bytes, not
a fresh native run of this versioned distribution. Paired deployment/native smoke
remains a separate acceptance gate.

255 checks recorded in REVIEW.md describe historical0.5.0, not0.6.0 totals.
No full editor/API, native Undo/transaction, all-format/SDK/OS or visual/runtime parity
claim. Paths/custom easing/actions, complete Gear/UI authoring and Godot remain open.
