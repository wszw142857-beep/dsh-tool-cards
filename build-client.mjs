/**
 * 客户端打包：把 src/client.js 及其全部依赖打成一个 CJS「closure factory」，
 * 再包进 DSH 的 `window.__ModuleLoader__.load({ id, factory })` 协议。
 *
 * 关键点：
 *  - `react` 必须保持 external：浏览器里由宿主 module table 提供，
 *    打进第二份 React 会让 hooks 直接报错（"Invalid hook call"）。
 *  - `@json-render/*`、`zod` 全部内联：它们不在平台基线里，
 *    作为 external 会在浏览器端解析失败。
 *  - 产物只注册 factory，不执行副作用；样式在 apply() 里插入。
 */
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = here;
const outDir = join(root, 'lib');

// 客户端 bundle 的注册 id 必须等于 package.json 的 name，
// 否则 dsh-client-modules 按包名找不到对应的 factory。
const PACKAGE_ID = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).name;

/* ---------- 0. 从 card.css 生成 card-css.js ----------
   样式只有一份真源（src/card.css）；生成物随构建更新，避免源码与产物漂移。 */
const css = await readFile(join(root, 'src/card.css'), 'utf8');
await writeFile(
  join(root, 'src/card-css.js'),
  `/** 卡片样式（构建时从 card.css 生成，勿手改）。 */\nexport const CARD_CSS = ${JSON.stringify(css)};\n`,
  'utf8',
);

/* ---------- 1. 打包 JS ---------- */
const result = await build({
  entryPoints: [join(root, 'src/client.js')],
  bundle: true,
  minify: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome110', 'edge110', 'firefox110', 'safari16'],
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  define: { 'process.env.NODE_ENV': '"production"' },
  write: false,
  logLevel: 'warning',
});

const bundle = result.outputFiles[0].text;

/* ---------- 3. 组装 __ModuleLoader__ 包装 ---------- */
const banner = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(PACKAGE_ID)},
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
`;
const footer = `
    return module.exports;
  }
});
`;

const jsBody = bundle
  // esbuild 的 CJS 产物自带 module/exports 声明，这里去掉以免重复声明
  .replace(/^"use strict";\n?/, '')
  .replace(/var module = \{ exports: \{\} \};\n?/g, '')
  .replace(/var exports = module\.exports;\n?/g, '');

const finalSource =
  banner +
  jsBody +
  footer;

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'client.js'), finalSource, 'utf8');

console.log(`wrote ${join(outDir, 'client.js')} (${(finalSource.length / 1024).toFixed(0)} KiB)`);
console.log(`  css inlined: ${(css.length / 1024).toFixed(1)} KiB`);
