# dsh-tool-cards

[中文](#中文) | [English](#english)

## 中文

**为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供交互式聊天卡片。**

在一条助手消息内直接渲染滑块、下拉、分段控件、日期选择器、表单、图表和表格——用户按下提交按钮后，参数快照会作为新消息回传给智能体。

> [!NOTE]
> 这是 `chat-ui/1.0` 消息格式的独立实现，不是任何官方 ChatGPT 协议，也不复现任何私有实现。

### 它做什么

```
模型调用 chat_ui({ title, ui })
  → host 校验载荷（组件白名单、深度、节点数、action 形状）
  → 工具结果 meta 携带 { kind: 'chat-ui/1.0', title, ui }
  → 卡片被"提升"为最终聊天输出（不折叠进工具过程）
      拖动 / 勾选 / 输入 → 仅本地状态，零请求
      按下提交按钮   → POST /chat-ui/action { actionId, operation, values }
  → host 通过 agent.followup() 把它变成一条用户消息
  → 智能体在下一轮看到参数快照
```

### 为什么卡片要被"提升"

`chat_ui` 是一次工具调用，而工具结果通常属于 *process* 区段——模型思考结束后 DSH 会把这一段折叠起来，卡片也会跟着消失。所以 client 端注册了一个由 `tool/result` 事件驱动的自定义聊天节点（`chat-ui-card`），锚定到会话输出流上；工具行则降级为一行占位符加一个原始数据展开。

如果 `uiConversation` 不可用，插件会回退为在工具行内渲染卡片，功能仍然可用。

### 组件

共 26 种注册组件：

| 分组 | 类型 |
|---|---|
| 输入 | `Slider` `Checkbox` `Radio` `Select` `Segmented` `Input` `Textarea` `Date` `Button` |
| 容器 | `Form` `Pressable` `Popover` `Carousel` |
| 视觉 | `Chart`（柱/线/饼/散点）`Map` |
| 展示 | `Card` `Metric` `Text` `Heading` `Row` `Column` `Divider` `Badge` `Alert` `Table` `KeyValue` |

表达式使用白名单 JSON AST——`{ op: "mul", args: [{ var: "a" }, { var: "b" }] }`，支持 `add`/`sub`/`mul`/`div`/`round`/`eq`/`and`/`or`/`not`。**没有 eval，不生成代码。**

### 安装

```bash
# 在你的 DSH profile 里
dsh plugin add dsh-tool-cards
```

或在 `~/.dsh/profiles/<profile>/package.json` 中手动加入 bundle 行：

```json
{ "dsh": { "profile": { "bundles": ["...", "dsh-tool-cards"] } } }
```

然后重启 DSH（profile patch 在启动时读取）。

### 用法

`chat_ui` 工具会出现在模型的工具集里。它的描述告诉模型何时使用它（调参数、多维对比、"给我做个计算器"），何时不该用（纯解释、一次性结论）。

最小载荷示例：

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

Action 类型：`submitToAgent`、`callTool`、`openUrl`（仅 http/https）。

### 按钮与文案约定

- 提交按钮是卡片**唯一的出口**：全宽、加粗、上方有分隔线。
- 按钮文案描述**用户的下一个动作**，由模型按当前任务决定——"应用这组参数""计算推荐投加量""提交这次配比"。

### 限制

每条消息：≤ 120 个节点，树深度 ≤ 8，≤ 60 个状态键，≤ 20 个 action，文本 ≤ 4000 字符。由 host 强制执行，畸形载荷在到达 client 前就会被拒绝。

### 说明与注意事项

- `Chart` 和 `Map` 是手绘 SVG。`Map` 只做坐标投影示意，不连接任何瓦片服务。
- client bundle 将 `react` 保持为 external（由 host 提供），内联了 `@json-render/*` 和 `zod`，因为它们不在平台模块基线里。
- 样式只使用 `--dsw-alias-*` 主题 token，自动跟随亮/暗主题。

### 开发

```bash
git clone https://github.com/wszw142857-beep/dsh-tool-cards
cd dsh-tool-cards
npm install
npm run build     # 重新生成 src/card-css.js 和 lib/client.js
npm run check     # protocol + bundle 自测
```

更多测试工具在 `tools/`（不随 npm tarball 发布）：

| 脚本 | 用途 |
|---|---|
| `tools/selftest.mjs` | 15 项检查：协议校验、bundle 导出面、提升机制、回归防护 |
| `tools/bundle-rehearsal.mjs` | 10 项检查：在 static-plugin 上下文中运行 `apply()`，含/不含 `uiConversation` |
| `tools/e2e-full.mjs` | 全链路：真实工具定义 → 事件定义 → 真实 React 渲染 → 拖动 → 提交 |
| `tools/preview.mjs` | 渲染真实 bundle 并输出可直接截图的页面 |

## English

**Interactive chat cards for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

Render sliders, selects, segmented controls, date pickers, forms, charts and tables **inside an
assistant message** — then send the resulting parameter snapshot back to the agent when the user
presses the submit button.

> [!NOTE]
> This is a standalone implementation of the `chat-ui/1.0` message format. It is not an official
> ChatGPT protocol and does not reproduce any private implementation.

### What it does

```
model calls chat_ui({ title, ui })
  → host validates the payload (component whitelist, depth, node count, action shapes)
  → tool result meta carries { kind: 'chat-ui/1.0', title, ui }
  → the card is promoted to final chat output (not folded into the tool process)
      dragging / checking / typing → local state only, zero requests
      pressing the submit button  → POST /chat-ui/action { cardToken, actionId, operation, values }
  → host resolves the card token to its owning session, then agent.followup()
  → the agent sees the parameter snapshot on its next turn
```

### Why the card is "promoted"

`chat_ui` is a tool call, and tool results normally belong to the *process* section, which DSH
collapses once the model finishes thinking — taking the card with it. So the client registers a
custom chat node (`chat-ui-card`) driven by the `tool/result` event and anchors it to the session
output stream. The tool row degrades to a one-line placeholder plus a raw-data disclosure.

If `uiConversation` is unavailable, the plugin falls back to rendering the card inside the tool row,
so the feature still works.

<<<<<<< HEAD
### Components
=======
### Action ownership (security)

The client **never** says which session an action belongs to. At execute time the host records
`card → session` and hands the client an opaque `cardToken` through `presentationMeta`; the action
route accepts only that token and ignores any `sessionId` in the request body.

An earlier version trusted `body.sessionId` and resolved it with `agents.get()`, which let any
same-origin page inject a user message into *any* session. `tools/security-test.mjs` now pins the
behavior: forged `sessionId` → 403, unknown token → 403, valid token + forged session → routed to
the token's own session, released session → 409.

If the host cannot determine the owner session, the tool issues no token and the card renders
read-only — it never guesses a target.

## Components
>>>>>>> 0b92eff (feat: 0.2.0 — state persistence, error isolation, i18n)

26 registered component types:

| Group | Types |
|---|---|
| Inputs | `Slider` `Checkbox` `Radio` `Select` `Segmented` `Input` `Textarea` `Date` `Button` |
| Containers | `Form` `Pressable` `Popover` `Carousel` |
| Visuals | `Chart` (bar/line/pie/scatter) `Map` |
| Display | `Card` `Metric` `Text` `Heading` `Row` `Column` `Divider` `Badge` `Alert` `Table` `KeyValue` |

Expressions use a whitelisted JSON AST — `{ op: "mul", args: [{ var: "a" }, { var: "b" }] }` with
`add`/`sub`/`mul`/`div`/`round`/`eq`/`and`/`or`/`not`. **No eval, no generated code.**

### Install

```bash
# in your DSH profile
dsh plugin add dsh-tool-cards
```

Or add the bundle row yourself in `~/.dsh/profiles/<profile>/package.json`:

```json
{ "dsh": { "profile": { "bundles": ["...", "dsh-tool-cards"] } } }
```

Then restart DSH (a profile patch is read at startup).

### Usage

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

### Button and copy conventions

- The submit button is the card's **only** exit: full-width, bold, separated by a rule above it.
- Button labels describe **the user's next action**, decided by the model for the task at hand —
  "应用这组参数", "计算推荐投加量", "提交这次配比".

### Limits

Per message: ≤ 120 nodes, tree depth ≤ 8, ≤ 60 state keys, ≤ 20 actions, ≤ 4000-char text.
Enforced on the host, so a malformed payload is rejected before it reaches the client.

### Notes and caveats

- `Chart` and `Map` are hand-drawn SVG. `Map` projects coordinates only for illustration and does
  not connect to any tile service.
- The client bundle keeps `react` external (the host provides it) and inlines `@json-render/*`
  and `zod`, because those are not on the platform module baseline.
- Styling uses only `--dsw-alias-*` theme tokens, so it follows light/dark automatically.

<<<<<<< HEAD
### Development
=======
### Failure isolation

Card content is model-generated, so any single card can be malformed. Every render entry
(`ChatUiNode`, `ChatUiToolRow`, `ChatUiToolRowFallback`) is wrapped in a class-based
`CardErrorBoundary`: a broken card degrades into a small error card — cause, collapsible details,
and a retry button — while the rest of the conversation keeps rendering. Without it, one bad card
would crash the whole slot entry and take the transcript with it.

Missing node data is not an error: `node=null` or `data=null` renders nothing.

### Card state

Sliders and inputs keep their values across session switches, history navigation and remounts.
State is stored per card on the host (`GET/POST /chat-ui/state`, keyed by the card token) with
`localStorage` as a fallback; writes are debounced at 400 ms so dragging does not spam the route.

It deliberately does **not** go into the session log: dragging a slider is interaction, not a
conversation fact, and logging every tick would pollute the model's context.

### Interface language

Card chrome — submit, close, retry, empty states, validation messages, the map disclaimer —
follows `ctx.locale` and updates live when the language changes. Business copy (card titles,
field labels) is authored by the model in the conversation's language and is never translated.

## Development
>>>>>>> 0b92eff (feat: 0.2.0 — state persistence, error isolation, i18n)

```bash
git clone https://github.com/wszw142857-beep/dsh-tool-cards
cd dsh-tool-cards
npm install
npm run build             # regenerate src/card-css.js and lib/client.js
npm run check             # protocol + bundle self-tests (16)
npm run check:security    # action-ownership / privilege escalation (11)
npm run check:boundary    # render failure isolation (9)
npm run check:v020        # state persistence, i18n, isolation (12)
node tools/e2e-full.mjs   # full chain, needs jsdom
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
