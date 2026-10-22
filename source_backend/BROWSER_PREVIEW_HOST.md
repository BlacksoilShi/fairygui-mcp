# Browser preview host component

This optional source adapter component reuses the actual served editor UI's
ordered browser-text measurement protocol. It does not register a new MCP tool,
does not upgrade the deployed source service, and is not the full M05 milestone.
The optional source_preview MCP tool wraps this host in bounded maintained jobs.

## Interface

`browser_preview.cjs` exports `validateConfig`, `validateRequest`, and
`createHost(config, existingWorkDirectory, {signal, onProgress})`.
The host exposes sequential `preview(request, artifactStem)` and `close()`.
Concurrent calls are rejected. Any failed preview closes its page: close that
host before creating another. Always await `close()` in a finally block.

Config is private, not a model-supplied tool argument. It contains the configured
HTTP loopback origin, Bearer token, exact project file, session, revision,
Playwright module path, browser executable and timeoutMs (1000..120000).
The public dependency is optional: import and validation do not load Playwright.
Runtime/dependency paths stay in the shared tools library; work stays in the
target project's own analysis directory. Never pass a token in command arguments.

Requests contain only package name, canonical component ID and preview args.
Only the existing events/host/max_steps/branch/variables/random_values/
stage_profile/custom_ease_profile options can be sent. Actual semantic support
remains the model's authority; this host does not add unsupported composition.

CLI: `node browser_preview.cjs PRIVATE_JSON EXISTING_WORK_DIRECTORY`.
The private file must be inside that work directory and has keys host/request.
Use the project's private-state creator for owner-only Windows credentials.
CLI emits bounded receipt metadata; result JSON and PNG remain local. Do not
publish the private input, profile, source project or reverse-engineering data.

## Read-only and rendering contract

The browser may GET only the configured origin. Page POSTs are restricted to
text_preview_start/step/cancel with the configured session/revision/component.
The preview uses `command('preview', args)` in the real served UI, its actual
checkbox and DOM measurements; it does not synthesize text sizes or run arbitrary
tool-provided JavaScript. Auth is injected into session storage, not the URL.

The profile is headless Edge, Arial, DPR1, 1850x1250. The entire component must
fit the real stage viewport without hint overlap. No toolbar hiding, masks,
tolerance or crop of the declared component is introduced. PNG and result sizes
are bounded; artifact names are fixed stems inside the owned work directory.

Each result records source/request scope, actual measurements, profile, full
viewport clip, artifact byte lengths and SHA256. Error output contains only
controlled codes, not browser exception messages/stacks or configured tokens.
Per-preview timeout covers navigation/replay/capture after host startup; optional
MCP job integration must impose its own overall startup/queue/deadline budget.

## Cancellation and ownership

Abort/deadline resets the UI task and explicitly awaits remote cancellation when
a validated ticket was observed. If a start was dispatched but no safely bound
ticket was observed, cleanup.confirmed is false with the server's 120s TTL.
This is not reported as an empty remote pending set. Source writes are never
undone or replayed by the host.

Close awaits the owned browser context, then removes only the newly created
browser-profile directory after marker, resolved-parent and symlink checks.
Work, private config and artifacts are retained. Browser process exit is verified
externally in delivery tests, separately from context-close acknowledgement.

## Scope and remaining work

Component tests compare 19 packages/96 prefix states against the retained actual
UI/independent-SDK full PNG oracle, with unchanged source/history. Negatives cover
cancel, identity, deadline, unconfirmed cleanup and concurrent host reuse.

Still required before MCP preview release: opt-in source_preview schema and
dispatch, durable bounded job store, start/status/read/cancel/release, namespace
separation from source_state, progress/deadline propagation, orphan recovery,
large artifact paging, actual stdio-to-host tests and paired deployment rollback.
Do not describe this component's pass as an already available MCP preview tool.
