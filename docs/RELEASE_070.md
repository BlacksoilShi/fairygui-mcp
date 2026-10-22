# 0.7.0 — diagnostics, schema discovery and maintained previews

MCP server/package version: **0.7.0**. Native project plugin version: **0.6.0**.
All native plugin files are unchanged from the independently published 0.6.0
baseline. The MCP client and Python helper change together; upgrading this client
does not require changing editor binaries or reinstalling an identical plugin.

## Tool profiles

| Configuration | Tools |
|---|---:|
| Native only, including bridge_diagnostics | 35 |
| Legacy source integration | 39 |
| Generic source base | 39 |
| Generic + any one of uploads/schemas/previews | 40 |
| Generic + any two flags | 41 |
| Generic + all three flags | 42 |

Each flag is an explicit boolean and requires sourceProtocol=fgui-rebuild-http/1.
Counts refer to tools/list, not number of editor operations or completed features.
Existing configuration with no new flags keeps previews and schema queries off.

## Distribution

The optional source_backend/ directory contains a standalone HTTP adapter and
bounded preview-job host. It contains no reconstructed editor service, SDK,
project asset or original editor program. Native use has no dependency on it.
Browser preview uses an explicitly installed Playwright module and browser;
the package performs no dependency or browser downloads.

- bridge_diagnostics: read-only native connection, ownership and configuration checks.
- source_operation_schema: bounded, digest-consistent read-only operation discovery.
- source_preview: start/status/read/cancel/release/inspect/cleanup lifecycle.
  Input does not accept arbitrary URLs, scripts or commands.
- Existing source receipt, upload and native editing contracts are retained.

Source files stay read-only during preview, but creating jobs, cancelling work and
deleting owned artifacts are side effects; the preview tool is not annotated as
entirely read-only. Cancellation acknowledgment is not remote cleanup proof.
Windows crash containment uses owned process identities and a Job Object.
Non-Windows behavior is cooperative-only and does not claim orphan cleanup parity.

## Verification and limitations

npm test runs all shipped offline groups, including actual stdio tools/list across
ten profiles (native, legacy, eight generic combinations), Python ownership tests,
adapter schema cases, transport, setup and release checks. Native editor and real
browser integration remain separately scoped gates; no complete editor parity,
all-SDK equivalence, automatic restart, or automatic write replay is claimed.

A schema with complete=false remains incomplete even if it has 80 operation names.
An installed package, a connected backend, a loaded tool list and a published Git
revision are separate identities. Verify them separately after upgrade.

## Upgrade / rollback

Keep private MCP/backend configs outside the repository. Back up their exact bytes,
the previous package, and any needed receipt/job records. Retain the same receipt
directory; do not reset pending entries to force a retry. Drain or cancel preview
jobs and confirm ownership-based termination before changing preview code.

Upgrade server.mjs, helper.py, diagnostics.py, lib/ and optional source_backend/
as one verified package, then reconnect the stdio client. Check initialize version,
tools/list, native ping and source capabilities independently. An already loaded
client may retain its previous tool list until reconnection.

For rollback to 0.6.0, restore its code and exact compatible private configuration.
Remove sourceSchemas/sourcePreviews keys if not present in that baseline; setting
an unsupported key to false still fails validation. Restore the matching adapter
path and preview settings. Do not reuse a stale HTTP token after changing the
source service. Backend service rollback is separate from client code rollback.

See [optional setup](OPTIONAL_BACKEND_SETUP.md), [preview jobs](SOURCE_PREVIEW.md),
[schemas](OPERATION_SCHEMA_QUERY.md), and [diagnostics](CONNECTION_DIAGNOSTICS.md).
