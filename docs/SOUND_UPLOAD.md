# Opt-in Sound source upload for the independent MCP backend

This is an optional external-backend extension in the 0.6.0 candidate.
The34 original-editor tools and four legacy source tools are unchanged by default.
Generic source mode remains38 tools unless explicitly opted in; upload mode adds
one tool (39 total). This is not another native original-editor import API.

## Explicit configuration

Add `"sourceUploads": true` to the native MCP private config **only** with the
existing `sourceProtocol: "fgui-rebuild-http/1"`, sourceHelper and sourceConfig.
In that independent backend's config add `"uploadRoots": ["ABSOLUTE_IMPORT_DIR"]`.
Use actual canonical local directories; at most16, no symlink/reparse roots.
No upload roots are inferred from the project, home, drive or current directory.
The metadata reports policy enablement/count/limit, not private import root paths.
Enable it only when the separately installed backend advertises the matching contract.

## Tool and execution flow

`source_sound_upload({requestId, session, expectedRevision, filePath})` accepts
exactly those fields. filePath is an existing local WAV/MP3/OGG regular file below
an explicitly configured root. Maximum64MiB, including empty/opaque bytes.
No bytes/base64/URL/user-selected destination go into MCP input. The helper hashes
then streams the same pinned file handle into fixed loopback `/api/sound-upload`.
The second-pass hash detects same-size/same-mtime content changes; the editor
independently checks the upload SHA256. The file is not decoded by uploading it.
Canonical file paths and all ancestors reject links/reparse points; this is not
an OS security sandbox against hostile same-user filesystem races.

Actual metadata must identify the configured project, independent layer, source
session and revision, and advertise the exact session-owned/single-use upload
contract. There is no native fallback. A successful receipt includes uploadId,
actual bytes/SHA256, source session/revision and expiry, without modifying source.
Then use a **separate new requestId** in source_command with sound_import or
sound_replace and the returned uploadId, followed by explicit save/history.

## Durable non-replay

The existing OS-locked, bounded receipt store is shared with source_command.
Upload intents bind command, configured project and all request arguments before
dispatch. Same requestId/same arguments returns the exact stored historical
response without reading the local file or contacting HTTP, including after
helper/MCP restart or local-file deletion. It does not renew a spent/expired lease.
New bytes or a deliberate new upload need a new requestId. Changed arguments with
the same ID conflict. Response loss, source drift after dispatch or persistence
failure yields OUTCOME_UNKNOWN and never automatically repeats the upload.
Receipt reads remain paged and do not execute either upload or editor commands.

The endpoint creates a bounded private temporary capture. Upload is not project save,
codec verification, native Undo, SDK parity or speaker playback. The external backend
owns lifecycle/expiry/consumption. This repository does not distribute that backend.
