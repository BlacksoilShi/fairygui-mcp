# Preview maintenance and owned-process lifecycle

Adds `source_preview` inspect and cleanup actions, in addition to the existing
start/status/read/cancel/release. No source files or source-write receipts are
modified. Inspection is bounded to the explicitly configured project's8 job
records; it reports capacity, expiry, phase and recovery needs. Corrupt/foreign
records are reported, not deleted or reset into fresh jobs.

On Windows an unnamed Job Object owns the spawned Node process and descendants.
The runner assigns the child handle before admitting browser launch via a local
node-owned handshake. Its non-inherited handle has KILL_ON_JOB_CLOSE enabled;
runner death therefore terminates its contained processes. Membership/birth
observations are retained in the private job record. This does not terminate
unrelated GUI/browser processes and is not an OS sandbox or memory/disk quota.

Normal cancellation is cooperative and awaits existing preview cancellation.
Protocol notifications for an in-flight preview start are handled after admission
reconciliation, cancel the supplied job ID and suppress the cancelled request's
response. Later notifications for a completed start do not retroactively cancel
the background job; use its explicit cancel action. Native/source write request
cancellation still does not promise undo or automatic replay.

After a killed runner, status reports interrupted and remote cleanup unconfirmed.
The source server's120s TTL remains authoritative for an unobserved ticket. The
cleanup action only removes the exact owned profile after all recorded processes
are stopped, Windows containment was bound, and the original profile marker hash
matches. Reparse paths, changed markers and unknown job-root files are preserved.
Cleanup does not report remote pending0 or erase source-write uncertainty.
Non-Windows operation remains cooperative-only: orphan profile cleanup requiring
kernel containment is explicitly rejected, not claimed supported.

Implementation references (API layout/semantics, not proof of our execution):

* [Basic limits / kill-on-close](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information)
* [Extended limits structure](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information)
* [Assign child process](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject)
* [Query process membership](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject)
* [MCP2025-06-18 cancellation](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation)

Real execution, forced-runner crash, profile cleanup, protocol/deadline tests and
full96 rendering gates have separate verification records. Package installation alone does not prove current deployment or full editor completion.
