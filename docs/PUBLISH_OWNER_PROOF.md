# Interrupted publish recovery — 0.6.0 candidate

Use editor_start with recoverPublish=true explicitly. The normal no-argument
startup path is unchanged. This optional flag adds no catalogue entries.
The server starts/attaches the configured GUI, asks the external Python helper
to prepare a proof, then polls native state. Preparation alone is not recovery;
a blocked native state returns PUBLISH_RECOVERY_PENDING, never a success claim.

## Evidence and proof contract

The external helper uses one held Windows process handle for zero-time wait and
creation time. Exact decimal uint64 FILETIME strings avoid floating-point loss;
leading zeros/out-of-range values are invalid. Live or unknown owners block.
PID-only leases stay conservative when their PID is present. Error87 alone is
insufficient: absence also requires a complete nonempty OS PID census containing
the known helper PID and excluding the target PID. Access denied is unknown.

The authenticated fresh native ping supplies host PID/session/project and exact
lease SHA256. The helper verifies the configured editor image, and the recorded
PID/birth/project when a launcher record exists. It confines lease/proof paths
and rejects linked ancestors. It never restores settings or deletes a lease.

Envelope: {"payload":"<canonical ASCII JSON>","signature":"<lowercase hex>"}.
HMAC-SHA256 signs ASCII("fgui-publish-owner-proof-v1\n") + ASCII(payload), keyed
by the private config token. Payload binds exact canonical lease UTF8 hash,
project/requestId, current host PID/session, owner observation, issue and expiry.
Lifetime is at most5000ms, with at most250ms positive clock skew.
The embedded-JS consumer performs its own bounded SHA256/HMAC verification,
strict exact schemas, duplicate/canonical checks and identity/time validation.
A private token is local coordination authentication, not a same-user OS sandbox.

## Exclusive coordination and persisted readback

Helper and native consumer both acquire the same Windows share-none handle to
publish-proof.lock. Native uses File.Open(OpenOrCreate,ReadWrite,None); helper
uses CreateFileW(OPEN_ALWAYS,sharing0). The filename can persist: it is not a
process-liveness claim and is never deleted based on age. The OS handle prevents
concurrent proof preparation/consumption across clients and releases on exit.

Before restore, re-read the exact lease and proof and check RAM/disk modes are
within the lease before/effective pair. Save through the native settings facade.
Read back both native property and on-disk settings/Publish.json. Increment the
revision conservatively before writes. Only after persisted restore and another
exact lease/proof guard, delete the matching proof, then its lease. A crash
between deletions leaves a lease needing fresh proof, not an unguarded restore.
Save/readback/cleanup conflicts remain blocked and preserve external edits.

## Verification scope

All129 prior plugin assertion lines are retained verbatim. Fixture glue now
explicitly supplies independently signed helper evidence to the native consumer,
not a fake native process enumeration. Those129 plus14 new consumer/crypto/
persisted-state assertions pass (143 total). Python owner40, recovery-helper10,
legacy-helper25 and generic-adapter182 are separate regression levels.

Actual6.1.4 consumed the retained real interrupted lease: wrong-key and expired
proofs blocked without modifying lease/settings; explicit MCP recovery restored
mode0 on disk and removed the matching lease/proof; subsequent all-mode native
publication decoded exactly against the retained independent package reference.
Actual6.0.5 used a fresh real native Run Task paused in a test-only adapter with
a30s fallback. The task was pending at timeout and GUI exit. After restart the
uninstrumented candidate recovered through the same MCP/helper flag and published
again with exact decoded package parity. Archive/GameAssembly/metadata provenance
is recorded separately. No original installed executable was modified.

The old121pass/8fail reports remain historical failures; they are not edited.
The tests are scoped recovery evidence. This candidate is not a claim
that all editor reconstruction, SDK/render/runtime work or Godot is complete.

## Primary references

- https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocess
- https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject
- https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes
- https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-enumprocesses
- https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew
