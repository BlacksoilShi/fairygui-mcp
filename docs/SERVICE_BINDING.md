# Shared service binding

Version 0.7.1 adds an optional, explicit service binding for the independent source adapter. Literal backend configurations remain compatible.

A new client can enable browser preview without adding unsupported fields to an older client's private backend configuration. Keep one existing literal configuration as the authoritative service binding, and reference it from the new profile:

```json
{
  "serviceBinding": {
    "protocol": "fgui-service-binding/1",
    "configPath": "F:/PROJECT/private/backend-legacy.json",
    "projectPath": "F:/PROJECT/source/Example.fairy",
    "receiptDir": "F:/PROJECT/receipts"
  },
  "browserPreview": {
    "node": "F:/TOOLS/node.exe",
    "playwrightModule": "F:/TOOLS/playwright-core",
    "browserExecutable": "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "jobDir": "F:/PROJECT/preview-jobs",
    "timeoutMs": 60000
  }
}
```

The referenced file keeps its existing literal contract, projectPath, receiptDir, port, token, timeoutSeconds and uploadRoots. It must not contain another binding or browserPreview. Only browserPreview may be overlaid. The new profile contains no copied source Bearer token.

Each backend instance reads one bounded JSON generation. A later invocation observes an atomic replacement of the authoritative service file, including new port/token values. An in-flight request retains its original connection snapshot; this feature does not restart services, retry writes, replay unknown outcomes or migrate jobs. Existing session/revision guards remain in force.

Absolute paths are required. The profile pins project and receipt identities; a change to either is rejected before dispatch. Missing, malformed, oversized, duplicate-key, nested-binding and reparse/symlink paths fail closed with bounded errors that omit config contents and credentials.

For rollout, leave the old server and old client configuration intact. Use a separate new client config pointing to this profile and the matching adapter version. Installations must verify both old and new clients before and after controlled service rebinding, plus preview cleanup and configuration rollback. This feature by itself does not prove a running host has reloaded its tools.

The native editor plugin is unchanged at 0.6.0. This adapter change does not implement the external editor service or complete editor parity.
