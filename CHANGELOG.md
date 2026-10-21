# Changelog

All notable changes to this project are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.2.1] — 2026-10-21

Two fixes: one visual, one that could silently disable auto-invocation.

### Fixed

- **Controls overflowed their container.** `.cui-control` set `width: 100%` without
  `box-sizing: border-box`, so `padding` and `border` were added outside the declared width —
  most visible on the textarea, which extended past the card's right edge. Every element inside
  a card now uses `border-box`, and the textarea additionally refuses horizontal resizing.
  Covered by `tools/overflow-test.mjs`, which measures real pixel widths in a browser.
- **The system-prompt section could be skipped silently.** The section was registered with a
  one-shot `ctx.get('systemPrompt')`; when that optional service activated *after* this plugin,
  the lookup returned `undefined`, the section was dropped, and nothing was logged. Since that
  text is half of what tells the model when to reach for `chat_ui`, auto-invocation could quietly
  weaken. Registration now uses reactive `ctx.inject(['systemPrompt'], …)`, so it happens whenever
  the service becomes available. `tools/diag-prompt.mjs` pins both activation orders.

### Notes

- Existing installs should restart DSH after upgrading (the client bundle changed).

## [0.2.0] — 2026-10-21

Three fixes that make the plugin safe and pleasant to use for longer sessions.

### Added

- **Card state persistence.** Sliders, selects and inputs now keep their values across
  session switches, history navigation and component remounts. State lives in a host-side
  per-card store (`GET/POST /chat-ui/state`, keyed by the card token), with `localStorage`
  as a fallback when the host route is unreachable. Writes are debounced (400 ms) so dragging
  does not spam the route.
- **Error isolation.** Every render entry (`ChatUiNode`, `ChatUiToolRow`,
  `ChatUiToolRowFallback`) is wrapped in a class-based `CardErrorBoundary`. A malformed card
  degrades into a small error card with the cause, collapsible details and a retry button —
  the rest of the conversation keeps rendering.
- **Interface localization (zh / en).** Card chrome (submit, close, retry, empty states,
  validation messages, map disclaimer) follows `ctx.locale` and updates live when the language
  changes. Business copy in card titles and field names stays as authored by the model.
- `index.d.ts` with types for `ChatUiPayload`, the expression AST, actions and validation.
- `CHANGELOG.md` and a GitHub Actions workflow running all four test suites.

### Changed

- The card action payload now carries `cardToken` instead of `sessionId` (see Security).
- Versions prior to 0.2.0 must restart DSH after upgrading: the client bundle changed.

### Security

- **Fixed: cross-session message injection.** The action route used to trust `body.sessionId`
  and resolve it with `agents.get()`, so any same-origin page could inject a user message into
  any live session. The host now records `card → session` at tool-execution time, hands the
  client an opaque token, and accepts only that token. A client-supplied `sessionId` is ignored
  entirely.
- When the host cannot determine the owner session, no token is issued and the card renders
  read-only — it never guesses a target.

### Tests

| Suite | Count |
|---|---|
| `npm run check` — protocol, bundle surface, promotion, regressions | 16 |
| `npm run check:security` — action ownership | 11 |
| `npm run check:boundary` — render failure isolation | 9 |
| `node tools/e2e-full.mjs` — full chain | 1 |

## [0.1.1] — unreleased

Development version. Superseded by 0.2.0 before publishing.

## [0.1.0] — 2026-10-19

First public release.

### Added

- `chat_ui` tool: renders an interactive card from a `chat-ui/1.0` payload.
- 26 component types: inputs, containers, charts, tables and display nodes.
- Whitelisted expression AST (`add`/`sub`/`mul`/`div`/`round`/`eq`/`and`/`or`/`not`) — no `eval`.
- Cards are promoted to final chat output through a custom `chat-ui-card` node, so they are
  not folded into the tool process.
- Submit action flows back to the agent as a real user message (`agent.followup`).
- Host-side validation: ≤120 nodes, depth ≤8, ≤60 state keys, ≤20 actions.

[0.2.0]: https://github.com/wszw142857-beep/dsh-tool-cards/compare/v0.1.0...v0.2.0
[0.1.1]: https://github.com/wszw142857-beep/dsh-tool-cards/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/wszw142857-beep/dsh-tool-cards/releases/tag/v0.1.0
