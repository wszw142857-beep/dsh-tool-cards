/**
 * 用**真实客户端 bundle** 渲染一张卡片并截图。
 *
 * 加载的就是 lib/client.js（与 DSH 页面同一份产物），
 * React 换成本地依赖，DSH 主题 token 用等价 CSS 变量喂进去。
 *
 * 渲染的是**最终输出的节点视图** ChatUiNode —— 也就是卡片提升后
 * 用户实际看到的那一份；同时验证工具行占位不会再显示一张重复的卡片。
 */
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'dist-preview');

await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [join(here, 'preview-boot.js')],
  bundle: true,
  format: 'iife',
  target: ['chrome110'],
  outfile: join(outDir, 'boot.js'),
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});

await writeFile(join(outDir, 'client.js'), await readFile(join(root, 'lib/client.js'), 'utf8'), 'utf8');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>chat_ui card preview</title>
<style>
  :root {
    --dsw-alias-bg-base: #ffffff;
    --dsw-alias-bg-layer-1: #fafbfc;
    --dsw-alias-bg-layer-2: #f1f3f6;
    --dsw-alias-bg-overlay: #ffffff;
    --dsw-alias-border-l1: rgba(16,24,40,.10);
    --dsw-alias-border-l2: rgba(16,24,40,.20);
    --dsw-alias-brand-primary: #2f6fd0;
    --dsw-alias-label-primary: #16181d;
    --dsw-alias-label-secondary: #4b5565;
    --dsw-alias-label-caption: #7a8494;
    --dsw-alias-state-error-primary: #d64541;
    --dsw-alias-state-warn-primary: #b8791d;
    --dsw-alias-state-success-primary: #1f8f5f;
    --dsw-alias-state-idle-primary: #9aa4b2;
    --dsh-content-font-size-secondary: 13px;
  }
  body { margin: 0; background: var(--dsw-alias-bg-base); font: 14px/1.55 "Segoe UI","Microsoft YaHei",sans-serif; }
  .wrap { max-width: 660px; padding: 24px; display: flex; flex-direction: column; gap: 14px; }
  .label { font-size: 11.5px; color: var(--dsw-alias-label-caption); margin-bottom: -6px; }
  .surface { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 14px 16px; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="label">最终输出区（提升后的卡片）</div>
    <div class="surface" id="promoted"></div>
    <div class="label">工具行（应只是一句占位，不重复卡片）</div>
    <div class="surface" id="toolrow"></div>
  </div>
  <script src="boot.js"></script>
  <script src="meta.js"></script>
  <script src="client.js"></script>
  <script src="mount.js"></script>
</body>
</html>`;

await writeFile(join(outDir, 'index.html'), html, 'utf8');

const mount = `
(function () {
  var entry = window.__CHATUI_ENTRY__;
  var out = document.getElementById('promoted');
  if (!entry) { out.textContent = 'bundle did not register'; return; }
  var React = window.__PREVIEW_REACT__;
  var jsxRuntime = window.__PREVIEW_JSX_RUNTIME__;
  var exports = entry.factory(function (id) {
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime') return jsxRuntime;
    throw new Error('unexpected external: ' + id);
  });

  // 与 DSH 里相同的 apply() 调用；这里注入一个假的 uiConversation，
  // 让插件走「提升」分支而不是退化分支。
  var registered = { events: [], nodes: [] };
  exports.apply({
    effect: function (fn) { fn(); return function () {}; },
    inject: function (names, cb) {
      cb({
        get: function (name) {
          if (name !== 'uiConversation') return undefined;
          return {
            events: { register: function (def) { registered.events.push(def); return function () {}; } },
            views: { register: function () { return function () {}; } },
            binding: function () { return undefined; }
          };
        },
        effect: function (fn) { fn(); return function () {}; },
        slots: {
          inject: function (k, cb2) { cb2(); return function () {}; },
          register: function (opts, Comp) { registered.nodes.push(opts.key); return function () {}; }
        }
      });
    },
    slots: {
      inject: function (k, cb) { cb(); return function () {}; },
      register: function () { return function () {}; }
    }
  });

  var meta = window.__PREVIEW_META__;
  var ReactDOMClient = window.__PREVIEW_REACT_DOM_CLIENT__;

  // 用真实的事件定义跑一遍：tool/result → 节点
  var def = registered.events[0];
  var matched = def ? def.match({ type: 'tool/result', seq: 42, data: { turn: 1, meta: meta } }) : null;
  var state = def && matched ? def.start({}, { event: { type: 'tool/result', seq: 42, data: { turn: 1, meta: meta } }, ...matched }) : null;
  var node = def && state ? def.buildViewNode({ key: 'k1', id: 'id1', state: state }) : null;

  var root1 = ReactDOMClient.createRoot(out);
  root1.render(node
    ? React.createElement(exports.ChatUiNode, { node: node, sessionId: 'preview' })
    : React.createElement('div', null, 'node not built'));

  // 工具行占位
  var root2 = ReactDOMClient.createRoot(document.getElementById('toolrow'));
  root2.render(React.createElement(exports.ChatUiToolRow, {
    block: { call: { id: 'c1', name: 'chat_ui' }, meta: meta }
  }));

  window.__PREVIEW_INFO__ = {
    events: registered.events.map(function (d) { return d.kind; }),
    nodes: registered.nodes,
    matched: !!matched,
    nodeKind: node && node.kind
  };
})();
`;
await writeFile(join(outDir, 'mount.js'), mount, 'utf8');

const { apply: hostApply } = await import(new URL('../host.js', import.meta.url));
let definition = null;
hostApply({
  effect: () => () => {},
  on: () => () => {},
  get: () => undefined,
  logger: () => ({ warn() {} }),
  tools: { register: (def) => { definition = def; return () => {}; } },
}, {});
const sample = JSON.parse(await readFile(join(root, 'tools/sample-args.json'), 'utf8'));
const value = await definition.execute({ title: sample.title, ui: sample.ui });
const meta = definition.output.presentationMeta({ title: sample.title }, value);
await writeFile(join(outDir, 'meta.js'), `window.__PREVIEW_META__ = ${JSON.stringify(meta)};\n`, 'utf8');

console.log('preview written; meta kind =', meta.kind, '| title =', meta.title);
