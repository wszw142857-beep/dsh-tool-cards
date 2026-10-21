/**
 * 0.2.0 三项功能的真实行为测试：状态持久化、界面本地化、错误边界。
 *
 * 用真实产物：lib/client.js（与 DSH 页面同一份）+ 真 React + jsdom，
 * 以及真实 host.js 的路由。
 *
 * 注意（踩过的坑）：jsdom 里给 input 赋 value 再 dispatchEvent('input')
 * **不会**触发 React 的 onChange——React 的 value tracker 不认这种赋值。
 * 可靠做法是从 DOM 节点的 `__reactProps$*` 上取 onChange 直接调用。
 * 之前用 dispatchEvent 的测试拿到的是假阴性。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const require = createRequire(join(root, 'package.json'));

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');

/* ---------------- DOM ---------------- */
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://127.0.0.1:1/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.IS_REACT_ACT_ENVIRONMENT = true;

/* ---------------- 真宿主：内存态 + 路由 ---------------- */
const routeHandlers = new Map();
let definition = null;
const followups = [];
const liveAgents = new Map([['session-1', { id: 'session-1', followup: (m) => followups.push(m) }]]);

const hostCtx = {
  effect: (fn) => { fn(); return () => {}; },
  on: () => () => {},
  get: (name) => {
    if (name === 'webServer') return { register: (r) => { routeHandlers.set(r.path, r.handler); return () => {}; } };
    if (name === 'agents') return { get: (id) => liveAgents.get(id) };
    // 两个路由都要求同源围栏存在（fail-closed），假 ctx 必须提供。
    if (name === 'connection') return { requestRejection: () => undefined };
    return undefined;
  },
  logger: () => ({ warn() {}, info() {} }),
  tools: { register: (d) => { definition = d; return () => {}; } },
};

const { apply: hostApply } = await import(new URL('../host.js', import.meta.url));
hostApply(hostCtx, {});
if (!routeHandlers.has('/chat-ui/state')) {
  console.error('state route missing; aborting');
  process.exit(1);
}

function makeReq(body, method = 'POST', url = '/chat-ui/state') {
  const buf = Buffer.from(body === undefined ? '' : JSON.stringify(body), 'utf8');
  // POST 需要 application/json（路由会 415 拦掉缺头的请求）；GET 不需要 body。
  const headers = method === 'POST' ? { 'content-type': 'application/json' } : {};
  return { method, url, headers, async *[Symbol.asyncIterator]() { yield buf; } };
}
function makeRes() {
  const captured = { status: 0, body: '' };
  return { writeHead(s) { captured.status = s; }, end(p) { captured.body = p ?? ''; }, get captured() { return captured; } };
}

/* ---------------- 一张卡 ---------------- */
const ui = {
  schemaVersion: 'chat-ui/1.0',
  initialState: { dose: 2 },
  tree: {
    id: 'root', type: 'Card', props: { title: '剂量卡' },
    children: [
      { id: 'dose', type: 'Slider', label: '投加量', bind: 'dose', props: { min: 0.1, max: 5, step: 0.1 } },
      { id: 'btn', type: 'Button', label: '提交', actionId: 'apply' },
    ],
  },
  actions: { apply: { kind: 'submitToAgent', operation: 'apply', includeKeys: ['dose'] } },
};
const value = await definition.execute({ title: '剂量卡', ui }, { agent: { id: 'session-1' } });
const cardToken = value.cardToken;
const meta = definition.output.presentationMeta({ title: '剂量卡' }, value);

/* ---------------- fetch 桥接到真实路由 ---------------- */
const fetchLog = [];
globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(String(url), 'http://127.0.0.1:1');
  const method = init.method ?? 'GET';
  fetchLog.push({ path: parsed.pathname, method, body: init.body });
  const handler = routeHandlers.get(parsed.pathname);
  if (!handler) return { ok: false, status: 404, text: async () => 'nf' };
  const req = makeReq(init.body ? JSON.parse(init.body) : undefined, method, parsed.pathname + parsed.search);
  const res = makeRes();
  await handler(req, res);
  return {
    ok: res.captured.status >= 200 && res.captured.status < 300,
    status: res.captured.status,
    text: async () => res.captured.body,
    json: async () => JSON.parse(res.captured.body),
  };
};

/* ---------------- 客户端 ---------------- */
let registered = null;
const sandbox = {
  window: { __ModuleLoader__: { load: (e) => { registered = e; } } },
  document: globalThis.document,
  fetch: globalThis.fetch,
  // bundle 在 vm 里跑，这些宿主环境设施必须一起挂进沙箱
  localStorage: dom.window.localStorage,
  setTimeout,
  clearTimeout,
  console,
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(root, 'lib/client.js'), 'utf8'), sandbox);
const client = registered.factory((id) => {
  if (id === 'react') return React;
  if (id === 'react/jsx-runtime') return require('react/jsx-runtime');
  throw new Error(`unexpected external: ${id}`);
});

let localeListeners = [];
const localeState = { active: 'zh-CN' };
const locale = {
  getSnapshot: () => localeState,
  subscribe(fn) { localeListeners.push(fn); return () => {}; },
  setActive(next) { localeState.active = next; for (const f of localeListeners) f(); },
};

client.apply({
  effect: (fn) => { fn(); return () => {}; },
  slots: { inject: (_k, cb) => { cb(); return () => {}; }, register: () => () => {} },
  get: (name) => (name === 'locale' ? locale : undefined),
  inject: (_n, cb) => {
    cb({
      get: () => ({ events: { register: () => () => {} } }),
      effect: (fn) => { fn(); return () => {}; },
      slots: { inject: (_k, c) => { c(); return () => {}; }, register: () => () => {} },
    });
    return () => {};
  },
});

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** 从 DOM 节点取 React 的 onChange 并调用（jsdom 下唯一可靠的方式）。 */
async function fireChange(node, nextValue) {
  const key = Object.keys(node).find((k) => k.startsWith('__reactProps'));
  if (!key) throw new Error('no react props on node');
  await act(async () => {
    node[key].onChange({ target: { value: String(nextValue) } });
  });
}

async function mountCard() {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const reactRoot = createRoot(container);
  await act(async () => {
    reactRoot.render(React.createElement(client.ChatUiNode, {
      node: { key: 'n1', data: { card: { title: '剂量卡', ui, cardToken }, cardId: 'n1' } },
    }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
  return { container, reactRoot };
}

/* ================= 1. 状态持久化 ================= */

console.log('\n[1] 状态持久化');

{
  const { container, reactRoot } = await mountCard();
  const slider = container.querySelector('input[type="range"]');
  check('卡片渲染出滑块', Boolean(slider));
  check('初始值来自 initialState', slider?.value === '2', `got ${slider?.value}`);

  await fireChange(slider, 3.5);
  await act(async () => { await new Promise((r) => setTimeout(r, 700)); });

  const post = fetchLog.find((c) => c.path === '/chat-ui/state' && c.method === 'POST');
  check('拖动后状态上报到宿主', Boolean(post), post?.body?.slice(0, 70));
  check('上报的是新值 3.5', (post?.body ?? '').includes('3.5'));

  // 通过真实路由读回
  const res = makeRes();
  await routeHandlers.get('/chat-ui/state')(makeReq(undefined, 'GET', `/chat-ui/state?cardToken=${cardToken}`), res);
  const body = JSON.parse(res.captured.body);
  check('宿主可读回状态', res.captured.status === 200 && body.state?.dose === 3.5, JSON.stringify(body));

  // 卸载 → 重挂载，模拟切走再回来
  await act(async () => reactRoot.unmount());
  const again = await mountCard();
  const slider2 = again.container.querySelector('input[type="range"]');
  check('重挂载后恢复上次的值', slider2?.value === '3.5', `got ${slider2?.value}`);
  await act(async () => again.reactRoot.unmount());
}

/* ================= 2. 界面本地化 ================= */

console.log('\n[2] 界面本地化');

{
  // 用 Form 的默认提交按钮验证：它属于**界面骨架**文案（submitLabel 缺省时取 t('submit')）。
  // Button 的 label 是模型生成的业务文案，本来就不该翻译。
  const formUi = {
    schemaVersion: 'chat-ui/1.0',
    initialState: {},
    tree: {
      id: 'root', type: 'Card', props: { title: '表单卡' },
      children: [
        {
          id: 'f', type: 'Form', props: {},
          children: [{ id: 'note', type: 'Textarea', label: '模型给的字段名', bind: 'note', props: {} }],
        },
      ],
    },
    actions: {},
  };

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const reactRoot = createRoot(container);
  await act(async () => {
    reactRoot.render(React.createElement(client.ChatUiNode, {
      node: { key: 'f1', data: { card: { title: '表单卡', ui: formUi, cardToken }, cardId: 'f1' } },
    }));
  });

  const submitText = () => container.querySelector('.cui-form-actions button')?.textContent ?? '';
  const fieldLabel = () => container.querySelector('textarea')?.getAttribute('aria-label') ?? '';

  check('中文环境：提交按钮显示中文', submitText().includes('提交'), submitText());

  await act(async () => { locale.setActive('en-US'); });
  check('切到英文：骨架文案翻译', submitText().toLowerCase().includes('submit'), submitText());
  check('业务文案不翻译（模型给什么就是什么）', fieldLabel() === '模型给的字段名', fieldLabel());

  await act(async () => { locale.setActive('zh-CN'); });
  check('切回中文：骨架文案恢复', submitText().includes('提交'), submitText());

  await act(async () => reactRoot.unmount());
}

/* ================= 3. 错误边界 ================= */

console.log('\n[3] 错误边界');

{
  const orig = console.error;
  console.error = () => {};
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const reactRoot = createRoot(container);
  const boom = new Proxy({}, { get() { throw new Error('boom for test'); } });

  await act(async () => {
    reactRoot.render(React.createElement('div', null,
      React.createElement(client.ChatUiNode, { key: 'bad', node: { data: { card: boom, cardId: 'bad' } } }),
      React.createElement(client.ChatUiNode, {
        key: 'good',
        node: { data: { card: { title: '好卡', ui, cardToken }, cardId: 'good' } },
      }),
    ));
  });
  console.error = orig;

  const text = container.textContent ?? '';
  check('坏卡片降级为错误卡', text.includes('这张卡片没能渲染'));
  check('好卡片仍然渲染', text.includes('好卡'));
  await act(async () => reactRoot.unmount());
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) process.exitCode = 1;
