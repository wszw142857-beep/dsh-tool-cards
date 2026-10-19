# dsh-tool-cards

**Interactive chat cards for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

Render sliders, selects, segmented controls, date pickers, forms, charts and tables **inside an
assistant message** — then send the resulting parameter snapshot back to the agent when the user
presses the submit button.

> [!NOTE]
> This is a standalone implementation of the `chat-ui/1.0` message format. It is not an official
> ChatGPT protocol and does not reproduce any private implementation.

## What it does

```
model calls chat_ui({ title, ui })
  → host validates the payload (component whitelist, depth, node count, action shapes)
  → tool result meta carries { kind: 'chat-ui/1.0', title, ui }
  → the card is promoted to final chat output (not folded into the tool process)
      dragging / checking / typing → local state only, zero requests
      pressing the submit button  → POST /chat-ui/action { actionId, operation, values }
  → host turns it into a user message via agent.followup()
  → the agent sees the parameter snapshot on its next turn
```

### Why the card is "promoted"

`chat_ui` is a tool call, and tool results normally belong to the *process* section, which DSH
collapses once the model finishes thinking — taking the card with it. So the client registers a
custom chat node (`chat-ui-card`) driven by the `tool/result` event and anchors it to the session
output stream. The tool row degrades to a one-line placeholder plus a raw-data disclosure.

If `uiConversation` is unavailable, the plugin falls back to rendering the card inside the tool row,
so the feature still works.

## Components

26 registered component types:

| Group | Types |
|---|---|
| Inputs | `Slider` `Checkbox` `Radio` `Select` `Segmented` `Input` `Textarea` `Date` `Button` |
| Containers | `Form` `Pressable` `Popover` `Carousel` |
| Visuals | `Chart` (bar/line/pie/scatter) `Map` |
| Display | `Card` `Metric` `Text` `Heading` `Row` `Column` `Divider` `Badge` `Alert` `Table` `KeyValue` |

Expressions use a whitelisted JSON AST — `{ op: "mul", args: [{ var: "a" }, { var: "b" }] }` with
`add`/`sub`/`mul`/`div`/`round`/`eq`/`and`/`or`/`not`. **No eval, no generated code.**

## Install

```bash
# in your DSH profile
dsh plugin add dsh-tool-cards
```

Or add the bundle row yourself in `~/.dsh/profiles/<profile>/package.json`:

```json
{ "dsh": { "profile": { "bundles": ["...", "dsh-tool-cards"] } } }
```

Then restart DSH (a profile patch is read at startup).

## Usage

The `chat_ui` tool appears in the model's tool set. Its description tells the model when to reach
for it (parameter tuning, multi-dimensional comparison, "build me a calculator") and when not to
(pure explanation, one-shot answers).

A minimal payload:

```json
{
  "title": "药剂投加量计算器",
  "ui": {
    "schemaVersion": "chat-ui/1.0",
    "initialState": { "soilTons": 1000, "doseGPerKg": 2 },
    "tree": {
      "id": "root",
      "type": "Card",
      "props": { "title": "药剂投加量" },
      "children": [
        { "id": "soil", "type": "Input", "label": "土壤质量 (t)", "bind": "soilTons",
          "props": { "inputType": "number", "min": 0 } },
        { "id": "dose", "type": "Slider", "label": "投加量 (g/kg)", "bind": "doseGPerKg",
          "props": { "min": 0.1, "max": 5, "step": 0.1 } },
        { "id": "total", "type": "Metric", "label": "理论药剂质量", "props": { "unit": "t" },
          "value": { "op": "round", "args": [
            { "op": "div", "args": [
              { "op": "mul", "args": [{ "var": "soilTons" }, { "var": "doseGPerKg" }] }, 1000
            ] }, 3 ] } },
        { "id": "submit", "type": "Button", "label": "提交这次配比", "actionId": "apply" }
      ]
    },
    "actions": {
      "apply": {
        "kind": "submitToAgent",
        "operation": "apply-dose",
        "includeKeys": ["soilTons", "doseGPerKg"]
      }
    }
  }
}
```

Action kinds: `submitToAgent`, `callTool`, `openUrl` (http/https only).

## Button and copy conventions

- The submit button is the card's **only** exit: full-width, bold, separated by a rule above it.
- Button labels describe **the user's next action**, decided by the model for the task at hand —
  "应用这组参数", "计算推荐投加量", "提交这次配比".
- Labels must not say "让 AI" / "AI 分析" / "问模型", and must not explain the implementation
  ("本地计算" / "不请求大模型"). The user is looking at a product surface, not at a technical note.

## Limits

Per message: ≤ 120 nodes, tree depth ≤ 8, ≤ 60 state keys, ≤ 20 actions, ≤ 4000-char text.
Enforced on the host, so a malformed payload is rejected before it reaches the client.

## Notes and caveats

- `Chart` and `Map` are hand-drawn SVG. `Map` projects coordinates only for illustration and does
  not connect to any tile service.
- The client bundle keeps `react` external (the host provides it) and inlines `@json-render/*`
  and `zod`, because those are not on the platform module baseline.
- Styling uses only `--dsw-alias-*` theme tokens, so it follows light/dark automatically.

## Development

```bash
git clone https://github.com/wszw142857-beep/dsh-tool-cards
cd dsh-tool-cards
npm install
npm run build     # regenerate src/card-css.js and lib/client.js
npm run check     # protocol + bundle self-tests
```

Additional harnesses live in `tools/` (not shipped in the npm tarball):

| Script | Purpose |
|---|---|
| `tools/selftest.mjs` | 15 checks: protocol validation, bundle export surface, promotion mechanism, regression guards |
| `tools/bundle-rehearsal.mjs` | 10 checks: runs `apply()` under a static-plugin context, with and without `uiConversation` |
| `tools/e2e-full.mjs` | full chain: real tool definition → event definition → real React render → drag → submit |
| `tools/preview.mjs` | renders the real bundle and writes a screenshot-ready page |

## License

MIT
