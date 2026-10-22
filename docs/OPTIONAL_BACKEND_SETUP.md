# Optional source adapter installation

Native-only use needs only the normal setup.py private configuration, Node 22+
and Python 3.11+. The following is optional. Use the same source project for the
backend service and adapter; do not silently replace an existing configuration.

## Generic source and schemas

Add these fields to the private MCP configuration, replacing example paths:

~~~json
{
  "sourceHelper": "D:/FGUI-work/fairygui-mcp/source_backend/backend.py",
  "sourceConfig": "D:/FGUI-work/runtime/backend-private.json",
  "sourceProtocol": "fgui-rebuild-http/1",
  "sourceSchemas": true,
  "sourcePreviews": false,
  "sourceUploads": false
}
~~~

Create a separate private backend configuration matching your already running
HTTP editor service:

~~~json
{
  "contract": "fgui-rebuild-http/1",
  "projectPath": "D:/FGUI-work/source-project/Example.fairy",
  "port": 18180,
  "token": "YOUR_PRIVATE_HTTP_SERVICE_TOKEN",
  "receiptDir": "D:/FGUI-work/runtime/source-receipts",
  "timeoutSeconds": 15
}
~~~

This package does not start or install the HTTP editor service. Use its actual
private token, not the native editor token. Keep credentials out of Git and
diagnostics. The adapter validates the explicit loopback endpoint and project
identity. A field named planToken is a short-lived typed migration lease, not an
authentication token; its narrow handling is documented separately.

## Browser preview

Set sourcePreviews=true in the MCP configuration and add browserPreview to the
private backend configuration:

~~~json
{
  "browserPreview": {
    "node": "D:/shared-tools/node/node.exe",
    "playwrightModule": "D:/shared-tools/browser/node_modules/playwright",
    "browserExecutable": "D:/shared-tools/chromium/chrome.exe",
    "jobDir": "D:/FGUI-work/runtime/source-preview-jobs",
    "timeoutMs": 120000
  }
}
~~~

All paths are explicit and absolute. jobDir must be outside the source project
and receipt trees, dedicated to owned jobs, not an unrelated populated directory.
The module path must name the locally installed Playwright module; the browser
must already exist. No installer or browser download is run by this adapter.

Start from source_capabilities and source_state. Use their actual source session,
revision, package and canonical component ID. Preview arguments must match the
advertised backend profile. They are not arbitrary browser commands.

A job ID is 32 lowercase hexadecimal characters. Repeating the same ID with the
same input reconciles admission, not a new execution. Use returned nextOffset and
full artifact SHA256 for byte pages. A cancelled/interrupted job may still have
remote cleanup uncertainty; respect its reported state and TTL. inspect/cleanup
never clear source-write receipts or erase unknown files.

The native editor may continue running when source preview is used. Native ping
does not prove the independent source endpoint or browser dependencies work.

## Tests versus deployment

npm test does not need the external editor service or Playwright. Real preview,
full corpus, expiry, crash and final installed-package tests must be run against
your chosen backend/dependency versions. Tool registration alone proves none of
those runtime properties. See [0.7.0](RELEASE_070.md) for version and rollback rules.
