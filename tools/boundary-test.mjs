/**
 * 错误边界行为测试（真实 bundle + 真 React + jsdom）。
 *
 * 关键点：`CardErrorBoundary` 单独的捕获能力已由 boundary-probe.mjs 证过。
 * 这里要证的是**边界接在正确的层级上**：
 *
 *   1. ChatUiNode 内部抛错 → 降级为错误卡，不冒到外层
 *   2. 同一条消息里其他卡片照常渲染（边界是隔离的，不是全局的）
 *   3. 节点数据缺失（node=null / data=null）→ 静默跳过，不出错误卡
 *   4. 退化视图 ChatUiToolRowFallback 也有边界
 *
 * 用 monkey-patch 制造真实异常：把 MessageCard 的外部依赖打桩不现实，
 * 改为直接向 ChatUiNode 传入会让 CardBody 抛错的 ui
 * （`ui.actions` 为 null 时 CardBody 里的 `card.ui?.actions?.[...]` 不会抛，
 *  但 `tree` 为 null 会让 registry 找不到组件 —— 那也不抛）。
 *
 * 因此这里用最可靠的方式：一个伪造的 node，其 `data.card` 是 Proxy，
 * 读取 `title` 时抛错。这不依赖任何组件内部实现。
 */
import assert from 'node:assert/strict';
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

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
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
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{"ok":true}' });

let registered = null;
const sandbox = {
  window: { __ModuleLoader__: { load: (e) => { registered = e; } } },
  document: globalThis.document,
  fetch: globalThis.fetch,
  console,
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(root, 'lib/client.js'), 'utf8'), sandbox);
const client = registered.factory((id) => {
  if (id === 'react') return React;
  if (id === 'react/jsx-runtime') return require('react/jsx-runtime');
  throw new Error(`unexpected external: ${id}`);
});

client.apply({
  effect: (fn) => { fn(); return () => {}; },
  slots: { inject: (_k, cb) => { cb(); return () => {}; }, register: () => () => {} },
  inject: (_names, cb) => {
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

/** 正常卡片。 */
function goodCard(title = '正常卡片') {
  return {
    title,
    ui: {
      schemaVersion: 'chat-ui/1.0',
      initialState: { n: 2 },
      tree: {
        id: 'root',
        type: 'Card',
        props: { title },
        children: [
          { id: 'm', type: 'Metric', label: '值', props: { precision: 0 }, value: { op: 'mul', args: [{ var: 'n' }, 2] } },
        ],
      },
      actions: {},
    },
  };
}

/**
 * 会抛错的卡片：card 是 Proxy，任何属性读取都抛。
 * 这绕开了组件内部的所有防御，用来验证边界确实在这一层。
 */
function throwingCard() {
  return new Proxy({}, {
    get() {
      throw new Error('card payload exploded');
    },
  });
}

const container = dom.window.document.getElementById('root');
const reactRoot = createRoot(container);
const origError = console.error;
console.error = () => {};

await act(async () => {
  reactRoot.render(
    React.createElement(
      'div',
      null,
      React.createElement(client.ChatUiNode, { key: 'a', node: { key: 'a', data: { card: throwingCard(), cardId: 'a' } } }),
      React.createElement(client.ChatUiNode, { key: 'b', node: { key: 'b', data: { card: goodCard(), cardId: 'b' } } }),
      React.createElement(client.ChatUiNode, { key: 'c', node: null }),
      React.createElement(client.ChatUiNode, { key: 'd', node: { data: null } }),
    ),
  );
});
console.error = origError;

const text = container.textContent ?? '';
console.log('\n--- 渲染结果 ---');
console.log('页面文本:', JSON.stringify(text.slice(0, 200)));

check('坏卡片降级为错误卡', text.includes('这张卡片没能渲染'));
check('错误卡有重试入口', text.includes('重试渲染'));
check('错误卡保留可展开详情', container.querySelector('.cui-card-error-details') !== null);
check(
  '错误详情含真实原因',
  (container.querySelector('.cui-card-error-message')?.textContent ?? '').includes('exploded'),
  (container.querySelector('.cui-card-error-message')?.textContent ?? '').slice(0, 60),
);

check('同一条消息里的好卡片仍然渲染', text.includes('正常卡片'));
check('好卡片数值正确（2×2=4）', text.includes('4'));
check(
  '节点数据缺失时静默跳过（不产生错误卡）',
  container.querySelectorAll('.cui-card-error').length === 1,
  `count=${container.querySelectorAll('.cui-card-error').length}`,
);
check('渲染未冒到外层', text.length > 0);

/* 退化视图也要有边界 */
const container2 = dom.window.document.createElement('div');
dom.window.document.body.appendChild(container2);
const root2 = createRoot(container2);
console.error = () => {};
await act(async () => {
  root2.render(
    React.createElement(client.ChatUiToolRowFallback, {
      block: { meta: { kind: 'chat-ui/1.0', title: 'x', ui: { tree: throwingCard() } } },
    }),
  );
});
console.error = origError;
check('退化视图同样有边界保护', (container2.textContent ?? '').includes('这张卡片没能渲染'));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) process.exitCode = 1;
