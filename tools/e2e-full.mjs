/**
 * 端到端验证：用**真实插件代码**跑一遍卡片全生命周期。
 *
 * 覆盖除「模型发出 tool call」之外的全部环节（那一步由 DSH 管线负责，
 * 已通过工具表出现 chat_ui、槽位出现 chat_ui 条目证明）：
 *
 *   1. 工具 definition：execute → render → presentationMeta
 *   2. 客户端组件：用真 React + jsdom 挂载 ChatUiCard，渲染真实 meta
 *   3. 交互：拖滑动条 → 指标联动、零请求
 *   4. 动作：点按钮 → 截获 fetch，检查上报体
 *   5. 宿主：把上报体丢进 formatActionPrompt，检查模型将看到的文本
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const require = createRequire(join(root, 'package.json'));

const React = require('react');
const { JSDOM } = require('jsdom');

/* ---------------- 1. 用真实定义跑工具半边 ---------------- */

const { apply: hostApply, validateUi, formatActionPrompt } = await import(
  new URL('../host.js', import.meta.url)
);

// 截获 ctx.tools.register 拿到的 definition
let definition = null;
const hostCtx = {
  effect: () => () => {},
  on: () => () => {},
  get: (name) => (name === 'webServer' ? { register: () => () => {} } : undefined),
  logger: () => ({ warn: () => {}, info: () => {} }),
  tools: {
    register(def) {
      definition = def;
      return () => {};
    },
  },
};
hostApply(hostCtx, {});
assert.ok(definition, 'host did not register a tool definition');
assert.equal(definition.name, 'chat_ui');

const sample = JSON.parse(readFileSync(join(root, 'tools/sample-args.json'), 'utf8'));

// 会话归属由宿主在执行时确定，因此这里必须传 exec.agent。
const value = await definition.execute(
  { title: sample.title, ui: sample.ui },
  { agent: { id: 'session-e2e' } },
);
console.log('tool execute →', JSON.stringify(value).slice(0, 80), '…');
assert.equal(value.ok, true, `execute rejected: ${value.error}`);
assert.equal(typeof value.cardToken, 'string', 'execute must issue a card token');

const rendered = definition.output.render({ title: sample.title }, value);
assert.equal(rendered[0].type, 'text');
console.log('model sees  →', rendered[0].text.slice(0, 90), '…');
assert.ok(!rendered[0].text.includes('"tree"'), 'model text must not contain the UI payload');

const meta = definition.output.presentationMeta({ title: sample.title }, value);
assert.equal(meta.kind, 'chat-ui/1.0');
assert.equal(meta.ui.tree.type, 'Card');
console.log('client meta → kind=%s title=%s nodes=%d', meta.kind, meta.title, countNodes(meta.ui.tree));

function countNodes(node) {
  let n = 1;
  for (const child of node.children ?? []) n += countNodes(child);
  return n;
}

/* ---------------- 2. 真 React + jsdom 挂载客户端组件 ---------------- */

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:61412/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.IS_REACT_ACT_ENVIRONMENT = true;

// 截获动作上报
const posts = [];
globalThis.fetch = async (url, init) => {
  posts.push({ url, body: JSON.parse(init.body) });
  return { ok: true, status: 200, text: async () => '{"ok":true}' };
};

// 载入客户端 bundle（与浏览器同一份产物）
let registered = null;
const sandbox = {
  window: { __ModuleLoader__: { load: (entry) => { registered = entry; } } },
  console,
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(root, 'lib/client.js'), 'utf8'), sandbox);
const clientExports = registered.factory((id) => {
  if (id === 'react') return React;
  if (id === 'react/jsx-runtime') return require('react/jsx-runtime');
  throw new Error(`unexpected external: ${id}`);
});

// 客户端 bundle 在 vm 里，DOM 与 fetch 要挂到它的沙箱
sandbox.document = globalThis.document;
sandbox.window = globalThis.window;
sandbox.fetch = globalThis.fetch;

// 样式：跑 apply() 时会 append <style>
const styleCalls = [];
const registeredNodes = [];
const clientCtx = {
  effect(fn, label) {
    styleCalls.push(label);
    fn();
    return () => {};
  },
  slots: {
    inject: (_key, cb) => { cb(); return () => {}; },
    register: () => () => {},
  },
  // 提供 uiConversation，让 apply() 走「提升」分支（与真实 DSH 一致）
  inject: (names, callback) => {
    callback({
      get: (name) =>
        name === 'uiConversation'
          ? {
              events: { register: () => () => {} },
            }
          : undefined,
      effect: (fn) => { fn(); return () => {}; },
      slots: {
        inject: (_key, cb) => { cb(); return () => {}; },
        register: (opts) => { registeredNodes.push(opts.key); return () => {}; },
      },
    });
    return () => {};
  },
};
clientExports.apply(clientCtx);
console.log('style injected →', dom.window.document.head.children.length === 1);
console.log('promoted node registered →', registeredNodes.join(','));

const { act } = React;
const { createRoot } = require('react-dom/client');

const container = dom.window.document.getElementById('root');
const reactRoot = createRoot(container);

// 按**真实链路**渲染：先用事件定义把 tool/result 变成最终输出节点，
// 再把节点交给 ChatUiNode —— 与 DSH 里发生的事完全一致。
const nodeDefinition = clientExports.createChatUiDefinition();
const toolResultEvent = { type: 'tool/result', seq: 31, data: { turn: 1, meta } };
const matched = nodeDefinition.match(toolResultEvent);
assert.ok(matched, 'definition did not match the chat_ui tool result');
const state = nodeDefinition.start({}, { event: toolResultEvent, ...matched });
const viewNode = nodeDefinition.buildViewNode({ key: 'node-1', id: 'id-1', state });
assert.ok(viewNode, 'buildViewNode returned null');
console.log('\n--- 提升为最终输出 ---');
console.log('node.kind:', viewNode.kind, '| visibility:', viewNode.visibility, '| location:', viewNode.location.kind);

await act(async () => {
  reactRoot.render(
    // 卡片节点不再接收 sessionId：动作归属由 meta.cardToken 决定。
    React.createElement(clientExports.ChatUiNode, { node: viewNode }),
  );
});

const text = () => container.textContent ?? '';
const metricNumber = () => {
  const node = container.querySelector('.cui-metric-value');
  const match = (node?.textContent ?? '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : Number.NaN;
};

console.log('\n--- 渲染结果 ---');
console.log('卡片标题:', container.querySelector('.cui-chat-card-title')?.textContent);
console.log('控件数:', {
  range: container.querySelectorAll('input[type="range"]').length,
  select: container.querySelectorAll('select').length,
  number: container.querySelectorAll('input[type="number"]').length,
  button: container.querySelectorAll('button').length,
});
console.log('初始指标:', metricNumber());

assert.ok(container.querySelector('.cui-chat-card'), 'card root missing');
assert.equal(metricNumber(), 2, 'initial metric should be 2.000');
assert.equal(posts.length, 0, 'no request expected before interaction');

/* ---------------- 3. 拖动：联动且零请求 ---------------- */

const slider = container.querySelector('input[type="range"]');
const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
await act(async () => {
  setter.call(slider, '3.2');
  slider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
});

console.log('拖动后指标:', metricNumber());
assert.equal(metricNumber(), 3.2, 'metric should follow slider');
assert.equal(posts.length, 0, 'dragging must not send any request');

/* ---------------- 4. 点按钮：上报快照 ---------------- */

// 按结构找提交按钮：卡片里唯一的整行主按钮（文案由运行时模型决定，不能按字面匹配）
const button = container.querySelector('.cui-submit-row button');
assert.ok(button, 'submit button missing');
assert.ok(button, 'action button missing');

await act(async () => {
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 30));
});

console.log('\n--- 动作上报 ---');
console.log('POST 次数:', posts.length);
assert.equal(posts.length, 1, 'expected exactly one POST');
const post = posts[0];
console.log('url:', post.url);
console.log('body:', JSON.stringify(post.body));

assert.equal(post.url, '/chat-ui/action');
// 安全模型：只发宿主签发的 cardToken，不发 sessionId。
assert.equal(typeof post.body.cardToken, 'string', 'payload must carry the host-issued cardToken');
assert.equal(post.body.cardToken, value.cardToken, 'cardToken must be the one issued at execute time');
assert.ok(!('sessionId' in post.body), 'payload must NOT carry a client-supplied sessionId');
assert.equal(post.body.actionId, 'analyseDose');
assert.equal(post.body.operation, 'analyse-remediation-dose');
assert.deepEqual(Object.keys(post.body.values).sort(), ['doseGPerKg', 'soilTons', 'tech']);
assert.equal(post.body.values.doseGPerKg, 3.2);
assert.ok(!('url' in post.body), 'payload must not carry a target URL');

/* ---------------- 5. 宿主把它变成一条 user 消息 ---------------- */

const prompt = formatActionPrompt(post.body);
console.log('\n--- 模型将收到的消息 ---');
console.log(prompt);

assert.match(prompt, /analyseDose/);
assert.match(prompt, /doseGPerKg: 3\.2/);
assert.match(prompt, /soilTons: 1000/);

console.log('\n全链路验证通过（除「模型发出 tool call」由 DSH 管线负责）');
