/**
 * 控件溢出回归测试（真实浏览器，量像素）。
 *
 * 之前的问题：`.cui-control` 用 `width:100%` 但没 `box-sizing: border-box`，
 * padding + border 额外撑出父容器，textarea 明显右侧越界。
 *
 * 这里用真实 bundle 渲染一张含 Input / Textarea / Select / Slider 的卡片，
 * 逐个断言「控件宽度 ≤ 父容器宽度」，并截图供人眼复核。
 */
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire('D:/Users/12930/.dsh/profiles/desktop/node_modules/');
const puppeteer = require('C:/Users/12930/.dsh/profiles/desktop/node_modules/puppeteer-core');

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'dist-preview', 'overflow');
await mkdir(outDir, { recursive: true });

/* boot 脚本：把 React 等挂到 window，供真实 bundle require */
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

/* 测试卡片：所有会受 width:100% 影响的控件 */
const ui = {
  schemaVersion: 'chat-ui/1.0',
  initialState: { mass: 1000, dose: 2, tech: 'ISCO', note: '', day: '2026-10-21' },
  tree: {
    id: 'root', type: 'Card', props: { title: '溢出检查', subtitle: '每个控件都应贴在容器内' },
    children: [
      { id: 'mass', type: 'Input', label: '土壤质量 (t)', bind: 'mass', props: { inputType: 'number' } },
      { id: 'dose', type: 'Slider', label: '投加量', bind: 'dose', props: { min: 0.1, max: 5, step: 0.1 } },
      { id: 'tech', type: 'Select', label: '工艺', bind: 'tech', props: { options: [{ label: 'ISCO', value: 'ISCO' }, { label: 'ISCR', value: 'ISCR' }] } },
      { id: 'day', type: 'Date', label: '日期', bind: 'day', props: {} },
      { id: 'note', type: 'Textarea', label: '备注（这块之前越界）', bind: 'note', props: { rows: 3, maxLength: 120 } },
    ],
  },
  actions: {},
};

const meta = { kind: 'chat-ui/1.0', title: '溢出检查', ui, cardToken: 'tok-overflow' };
await writeFile(join(outDir, 'meta.js'), `window.__PREVIEW_META__ = ${JSON.stringify(meta)};\n`, 'utf8');

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  :root{
    --dsw-alias-bg-base:#fff; --dsw-alias-bg-layer-1:#fafbfc; --dsw-alias-bg-layer-2:#f1f3f6;
    --dsw-alias-bg-overlay:#fff; --dsw-alias-border-l1:rgba(16,24,40,.10); --dsw-alias-border-l2:rgba(16,24,40,.20);
    --dsw-alias-brand-primary:#2f6fd0; --dsw-alias-label-primary:#16181d; --dsw-alias-label-secondary:#4b5565;
    --dsw-alias-label-caption:#7a8494; --dsw-alias-state-error-primary:#d64541; --dsw-alias-state-warn-primary:#b8791d;
    --dsw-alias-state-success-primary:#1f8f5f; --dsw-alias-state-idle-primary:#9aa4b2;
    --dsh-content-font-size-secondary:13px;
  }
  body{margin:0;background:#fff;font:14px/1.55 "Segoe UI","Microsoft YaHei",sans-serif}
  .wrap{max-width:600px;padding:20px}
  .bubble{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px 16px}
</style></head>
<body>
  <div class="wrap"><div class="bubble" id="root"></div></div>
  <script src="boot.js"></script><script src="meta.js"></script>
  <script src="client.js"></script><script src="mount.js"></script>
</body></html>`;
await writeFile(join(outDir, 'index.html'), html, 'utf8');

const mount = `
(function(){
  var entry = window.__CHATUI_ENTRY__;
  if(!entry){ document.getElementById('root').textContent='no bundle'; return; }
  var React = window.__PREVIEW_REACT__, jsx = window.__PREVIEW_JSX_RUNTIME__;
  var client = entry.factory(function(id){
    if(id==='react') return React;
    if(id==='react/jsx-runtime') return jsx;
    throw new Error('unexpected '+id);
  });
  client.apply({
    effect:function(fn){fn();return function(){};},
    slots:{inject:function(k,cb){cb();return function(){};},register:function(){return function(){};}},
    inject:function(n,cb){cb({get:function(){return {events:{register:function(){return function(){};}}};},
      effect:function(fn){fn();return function(){};},
      slots:{inject:function(k,c){c();return function(){};},register:function(){return function(){};}}});return function(){};}
  });
  var meta = window.__PREVIEW_META__;
  var ReactDOMClient = window.__PREVIEW_REACT_DOM_CLIENT__;
  ReactDOMClient.createRoot(document.getElementById('root')).render(
    React.createElement(client.ChatUiNode, {
      node:{key:'k',data:{card:{title:meta.title,ui:meta.ui,cardToken:meta.cardToken},cardId:'k'}}
    })
  );
  window.__PREVIEW_READY__ = true;
})();`;
await writeFile(join(outDir, 'mount.js'), mount, 'utf8');

/* ---------- 真实浏览器量宽度 ---------- */
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  args: ['--no-first-run', '--allow-file-access-from-files'],
  defaultViewport: { width: 760, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
await page.goto(`file:///${join(outDir, 'index.html').replace(/\\/g, '/')}`, { waitUntil: 'load' });
await page.waitForSelector('.cui-card', { timeout: 8000 });
await new Promise((r) => setTimeout(r, 300));

const measured = await page.evaluate(() => {
  const card = document.querySelector('.cui-card');
  const cardBox = card.getBoundingClientRect();
  const out = [];
  const checks = [
    ['Input(number)', '.cui-field input.cui-control'],
    ['Select', '.cui-field select.cui-control'],
    ['Date', '.cui-field input[type="date"]'],
    ['Textarea', '.cui-field textarea.cui-control'],
  ];
  for (const [name, sel] of checks) {
    const el = document.querySelector(sel);
    if (!el) { out.push({ name, missing: true }); continue; }
    const box = el.getBoundingClientRect();
    const field = el.closest('.cui-field');
    const fieldBox = field.getBoundingClientRect();
    out.push({
      name,
      elRight: Math.round(box.right),
      fieldRight: Math.round(fieldBox.right),
      cardRight: Math.round(cardBox.right),
      overField: Math.round(box.right - fieldBox.right),
      overCard: Math.round(box.right - cardBox.right),
      width: Math.round(box.width),
      fieldWidth: Math.round(fieldBox.width),
      scrollW: el.scrollWidth,
      clientW: el.clientWidth,
    });
  }
  return { out, card: { left: Math.round(cardBox.left), right: Math.round(cardBox.right) } };
});

console.log('\n卡片容器: left=%d right=%d\n', measured.card.left, measured.card.right);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

for (const item of measured.out) {
  if (item.missing) { check(`${item.name} 存在`, false, 'not found'); continue; }
  check(
    `${item.name} 不超出父容器`,
    item.overField <= 1,
    `右边界超出 ${item.overField}px（宽 ${item.width}/${item.fieldWidth}）`,
  );
  check(
    `${item.name} 不超出卡片`,
    item.overCard <= 1,
    `超出卡片 ${item.overCard}px`,
  );
}

await page.screenshot({ path: join(outDir, 'overflow.png'), fullPage: false });
console.log('\nshot:', join(outDir, 'overflow.png'));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) process.exitCode = 1;
