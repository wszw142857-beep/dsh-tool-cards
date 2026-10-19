/**
 * 真实装载条件演练。分两个场景，都用**静态插件条件**的 ctx：
 *
 *   A. 没有 uiConversation（退化）：卡片留在工具行里渲染，功能仍可用。
 *   B. 有 uiConversation（提升）：注册节点定义 + 节点视图，
 *      并把一条 tool/result 真的变成最终输出节点。
 *
 * 两个场景的 ctx 都**不提供 `styles`**：
 *   `ctx.styles` 是动态包才有的注入符号，静态插件读它会 TypeError，
 *   导致整个客户端 entry 激活失败（DSH 启动报「插件激活失败」）。
 *   样式由 apply() 自建 <style> 并用 ctx.effect 卸载。
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

/** 最小 DOM 替身，只够 appendChild / remove / head。 */
function createDocumentStub() {
  const head = {
    children: [],
    appendChild(node) {
      this.children.push(node);
      return node;
    },
  };
  return {
    head,
    createElement(tag) {
      return {
        tag,
        textContent: '',
        removed: false,
        remove() {
          this.removed = true;
          head.children = head.children.filter((item) => item !== this);
        },
      };
    },
  };
}

/** 加载真实 bundle，返回 { exports, sandbox }。
 *  document 必须挂在 bundle 求值用的那个沙箱上：bundle 在 vm 里跑，
 *  读的是 sandbox.document，而不是宿主进程的 globalThis.document。 */
function loadBundle(documentStub) {
  let registered = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => { registered = entry; } } },
    document: documentStub,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(root, 'lib/client.js'), 'utf8'), sandbox);
  assert.ok(registered, 'bundle did not register');
  const exports = registered.factory((id) => {
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime') return require('react/jsx-runtime');
    throw new Error(`unexpected external: ${id}`);
  });
  return { exports, sandbox };
}

/**
 * 造一个静态插件的 ctx。
 * @param {{withConversation?: boolean}} options
 */
function createCtx(options = {}) {
  const calls = [];
  const cleanups = [];
  const documentStub = createDocumentStub();

  const record = (fn, label) => {
    calls.push(`effect:${label ?? ''}`);
    const dispose = fn();
    if (typeof dispose === 'function') cleanups.push(dispose);
    return () => {};
  };

  const makeSlots = (tag) => ({
    inject(key, callback) {
      calls.push(`${tag}:slots.inject:${key}`);
      callback();
      return () => {};
    },
    register(opts, Component) {
      calls.push(`${tag}:register:${opts.name}:${opts.key}`);
      assert.equal(typeof Component, 'function', `${opts.key} must be a component`);
      return () => {};
    },
  });

  const uiConversation = options.withConversation
    ? {
        events: {
          register(def) {
            calls.push(`uiConversation.events.register:${def.kind}`);
            return () => {};
          },
        },
      }
    : undefined;

  const ctx = {
    document: documentStub,
    effect: record,
    slots: makeSlots('ctx'),
    inject(names, callback) {
      calls.push(`ctx.inject:${names.join(',')}`);
      callback({
        get: (name) => (name === 'uiConversation' ? uiConversation : undefined),
        effect: record,
        slots: makeSlots('owner'),
      });
      return () => {};
    },
  };
  return { ctx, calls, cleanups, documentStub };
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/* ---------------- A. 没有 uiConversation：退化但不崩 ---------------- */

console.log('\nA. 退化分支（无 uiConversation）');
{
  const probe = createCtx({ withConversation: false });
  const { exports } = loadBundle(probe.documentStub);
  const { ctx, calls, documentStub } = probe;
  ctx.effect = (fn, label) => {
    calls.push(`effect:${label ?? ''}`);
    fn();
    return () => {};
  };
  // apply() 里的 document 用的是全局，挂到 globalThis 供 sandbox 之外调用
  globalThis.document = documentStub;

  let threw = null;
  try {
    exports.apply(ctx);
  } catch (error) {
    threw = error;
  }
  check('apply() 不抛错（无 ctx.styles）', threw === null, threw ? String(threw) : '');
  check(
    '注册了 tool.call.toolview:chat_ui',
    calls.some((c) => c.endsWith('register:tool.call.toolview:chat_ui')),
    calls.filter((c) => c.includes('register')).join(' | '),
  );
  check('注入了 <style>', documentStub.head.children.length === 1, `count=${documentStub.head.children.length}`);
}

/* ---------------- B. 有 uiConversation：提升 ---------------- */

console.log('\nB. 提升分支（有 uiConversation）');
{
  const probe = createCtx({ withConversation: true });
  const { exports } = loadBundle(probe.documentStub);
  const { ctx, calls, documentStub } = probe;
  globalThis.document = documentStub;

  let threw = null;
  try {
    exports.apply(ctx);
  } catch (error) {
    threw = error;
  }
  check('apply() 不抛错', threw === null, threw ? String(threw) : '');
  check(
    '注册了事件定义',
    calls.some((c) => c.startsWith('uiConversation.events.register:chat-ui-card')),
    calls.join(' | '),
  );
  check(
    '注册了最终输出节点视图',
    calls.some((c) => c === 'owner:register:conversation.chat.node:chat-ui-card'),
    calls.filter((c) => c.startsWith('owner:register')).join(' | '),
  );
  check(
    '工具行仍注册（只作占位）',
    calls.some((c) => c.endsWith('register:tool.call.toolview:chat_ui')),
  );

  // 事件定义真的能把一条 tool/result 变成最终输出节点
  const definition = exports.createChatUiDefinition();
  const meta = {
    kind: 'chat-ui/1.0',
    title: '药剂投加量计算器',
    ui: { schemaVersion: 'chat-ui/1.0', initialState: {}, tree: { id: 'r', type: 'Card' }, actions: {} },
  };
  const event = { type: 'tool/result', seq: 11, data: { turn: 2, meta } };
  const matched = definition.match(event);
  check('match() 命中 chat_ui 结果', matched !== null);
  const node = definition.buildViewNode({ key: 'k', id: 'i', state: definition.start({}, { event, ...(matched ?? {}) }) });
  check('buildViewNode 产出可见节点', node && node.visibility === 'visible' && node.location.kind === 'session', JSON.stringify(node?.location));
  check('非 chat_ui 结果不匹配', definition.match({ type: 'tool/result', seq: 12, data: { turn: 2, meta: { kind: 'x' } } }) === null);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) process.exitCode = 1;
