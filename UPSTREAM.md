# Provenance

- Upstream: https://github.com/wingcd/fairygui-agent-bridge
- Reviewed upstream revision: `4b3abc16da973b4a1d54325f61d2522455349168`
- License: MIT, retained in `LICENSE`, `server.UPSTREAM-LICENSE`, and `plugin/LICENSE`.
- This repository is an independently managed derivative, not an official FairyGUI release.

The upstream tool catalogue and editor command handlers were retained and adapted.
The local predecessor added fixed-project routing, authenticated asynchronous HTTP,
request identity, bounded queues, original-editor background job lifecycle handling,
vector-property readback, and an independent optional reconstruction layer.

Version 0.4.0 packages the MCP independently, removes mandatory analysis-workspace
dependencies, makes the plugin port configurable, adds pre-newline input bounds,
queued cancellation, conservative tool annotations, and portable offline tests.

No original editor program, Unity runtime, SDK, source reconstruction, analysis
database, reverse-engineering dump or third-party project asset is distributed.

Version 0.7.0 adds locally developed diagnostics, schema discovery, and optional
HTTP/browser-preview adapter modules under source_backend/. These are client-side
integration code, not recovered proprietary editor code. The native plugin remains
the exact 0.6.0 implementation; server and plugin versions are tracked separately.
Playwright and a browser are optional external installations and are not bundled.
