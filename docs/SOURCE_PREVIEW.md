# Opt-in independent-source browser preview jobs

`sourcePreviews: true` with `sourceProtocol: "fgui-rebuild-http/1"` enables one
`source_preview` lifecycle tool. It is absent by default and in native-only mode.
The external adapter additionally requires explicit private `browserPreview`
configuration: node, playwrightModule, browserExecutable, jobDir, timeoutMs.
Preview helper JSON is piped over bounded stdin, not Windows command arguments.
Browser TEMP/TMP is contained under the newly owned profile, not the result root.
Status includes the measured scope/profile and measurement total on completion.
Dependencies stay optional; native editor use does not need a browser backend.
Included in the 0.7.0 package; availability requires explicit flags and backend configuration. Installing files does not enable the feature.

Actions:

* start: jobId32 lowercase hex, session, expectedRevision, package name, canonical
  component ID and args. Duplicate ID + identical args returns its existing job;
  different args conflict. A lost start response can be reconciled by the same ID.
* status: returns phase, state, scope and expiry. Use actual stage/counts, not a
  fabricated percentage. Queued/running jobs are not completion receipts.
* read: completed result or PNG, offset bytes, limit1..16384. Pages contain base64
  artifact bytes, total byte length, SHA256 and nextOffset. Assemble bytes first,
  verify full SHA, then decode JSON or PNG. Unicode can split across byte pages.
* cancel: requests cooperative cancellation. Wait for terminal; an acknowledgement
  of the request is not proof of remote cleanup. Already completed jobs stay done.
* release: only terminal, stopped owned workers; idempotent when already absent.

Source files and history remain read-only, but tool annotations deliberately do
not describe resource creation/cancel/release as an entirely read-only operation.
The tool has no arbitrary path, URL, command or script argument. Artifact IDs are
separate from source_state snapshots and source_command write receipts.

The job store is pinned outside project/receipt trees, with owner-only Windows
directory/file ACLs, bounded 2 active/8 retained jobs, 180s absolute cache TTL and
64MiB output admission budget (25MiB reservation per active job). Chromium profile
memory/disk is not an OS quota; profile cleanup is checked separately. Expired
terminal jobs are pruned on admission only after owned processes have stopped.
Unexpected files are preserved and reported instead of recursively deleted.

Each worker owns a real interpreter PID/birth and Node PID/birth. Windows venv
launchers are bypassed for the detached stdlib runner so a wrapper PID is never
mistaken for the actual worker. Lost/changed ownership is reported as interrupted
or cleanup unconfirmed, not automatically restarted. This is not source-write
replay and never clears write-ledger pending entries.

The source service must advertise browserText and match the configured project,
session and revision. Real text measurement, challenge receipts, source digest,
viewport/font profile and remote cancellation use browser_preview.cjs. If no
safely bound ticket was observed, report cleanup unconfirmed and the server TTL.
Overall job deadline starts at admission; no new full timeout is granted at each
layer. Cancellation while browser startup is in flight also closes owned context.

Validation is layered: initial stdio workflows cover one SDK-backed PNG/field
case, cancellation, disabled config and legacy backend; the full-corpus gate
must run 19 packages/96 states through MCP itself. Actual execution status lives
in the external verification record, not this checklist. Crash/expiry/capacity/
orphan workflows, paired packaging and deployment have separate gates. Do not
infer full M05 completion or editor parity from either the host or initial MCP pass.

Maintenance actions include inspect/cleanup plus Windows contained child ownership.
A protocol cancellation during start suppresses its reply and reconciles job cancel;
later completed-start cancellations require the explicit job action. Orphan local
profile cleanup is separate from remote ticket TTL and source-write uncertainty.
