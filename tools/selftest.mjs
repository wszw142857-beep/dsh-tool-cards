/**
 * 插件自检：不依赖 DSH，直接在 Node 里跑宿主逻辑。
 *
 * 覆盖：
 *  1. protocol.validateUi 的放行与拒绝（类型白名单、限额、动作形状）
 *  2. 工具 definition 的 render / presentationMeta 输出形状
 *  3. 构造一次卡片动作 → formatActionPrompt 的文本
 *  4. 客户端 bundle 的语法与导出面（在 vm 里以最小 __ModuleLoader__ 求值）
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const { validateUi, formatActionPrompt, ALLOWED_TYPES, LIMITS } = await import(
  new URL('../protocol.js', import.meta.url)
);

let passed = 0;
let failed = 0;
const failures = [];

/** 跑一个用例。 */
function test(name, body) {
  try {
    body();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (cause) {
    failed += 1;
    failures.push({ name, cause });
    console.log(`  FAIL ${name}\n       ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** 最小合法 UI。 */
function minimalUi(overrides = {}) {
  return {
    schemaVersion: 'chat-ui/1.0',
    initialState: { amount: 2 },
    tree: {
      id: 'root',
      type: 'Card',
      props: { title: 't' },
      children: [{ id: 'slider', type: 'Slider', label: '量', bind: 'amount', props: { min: 0, max: 10 } }],
    },
    actions: {},
    ...overrides,
  };
}

console.log('\ndsh-chat-ui — 自检\n');

console.log('[protocol]');

test('合法卡片通过校验并规范化 actions', () => {
  const ui = minimalUi({
    actions: {
      go: { kind: 'submitToAgent', operation: 'op', includeKeys: ['amount'], extra: 'dropped' },
      link: { kind: 'openUrl', url: 'https://example.com' },
    },
  });
  const result = validateUi(ui);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ui.actions.go, { kind: 'submitToAgent', operation: 'op', includeKeys: ['amount'] });
  assert.equal(result.ui.actions.link.url, 'https://example.com');
});

test('拒绝未知组件类型', () => {
  const ui = minimalUi();
  ui.tree.children[0].type = 'ScriptInjection';
  const result = validateUi(ui);
  assert.equal(result.ok, false);
  assert.match(result.error, /unsupported component type/);
});

test('拒绝重复 id', () => {
  const ui = minimalUi();
  ui.tree.children[0].id = 'root';
  assert.equal(validateUi(ui).ok, false);
});

test('拒绝超出深度上限的树', () => {
  let node = { id: 'deep', type: 'Column', props: {} };
  const rootNode = { id: 'root', type: 'Column', props: {}, children: [node] };
  for (let i = 0; i < LIMITS.maxDepth + 2; i += 1) {
    const next = { id: `n${i}`, type: 'Column', props: {} };
    node.children = [next];
    node = next;
  }
  const result = validateUi({ schemaVersion: 'chat-ui/1.0', initialState: {}, tree: rootNode, actions: {} });
  assert.equal(result.ok, false);
  assert.match(result.error, /depth/);
});

test('拒绝未知 schemaVersion', () => {
  assert.equal(validateUi(minimalUi({ schemaVersion: 'chat-ui/2.0' })).ok, false);
});

test('拒绝非 http(s) 的 openUrl', () => {
  const ui = minimalUi({ actions: { x: { kind: 'openUrl', url: 'javascript:alert(1)' } } });
  const result = validateUi(ui);
  assert.equal(result.ok, false);
  assert.match(result.error, /http/);
});

test('拒绝未知动作 kind', () => {
  const ui = minimalUi({ actions: { x: { kind: 'runShell', operation: 'rm -rf /' } } });
  assert.equal(validateUi(ui).ok, false);
});

test('组件白名单覆盖规范 §1 的 15 类', () => {
  for (const type of ['Slider', 'Checkbox', 'Radio', 'Select', 'Segmented', 'Input', 'Textarea', 'Date', 'Button',
    'Form', 'Pressable', 'Popover', 'Carousel', 'Chart', 'Map']) {
    assert.ok(ALLOWED_TYPES.includes(type), `${type} missing from whitelist`);
  }
});

console.log('\n[action prompt]');

test('动作文本只含动作名与快照，不含可执行目标', () => {
  const text = formatActionPrompt({
    actionId: 'analyseDose',
    operation: 'analyse-remediation-dose',
    values: { soilTons: 1000, doseGPerKg: 3.2 },
  });
  assert.match(text, /analyseDose/);
  assert.match(text, /soilTons: 1000/);
  assert.match(text, /doseGPerKg: 3\.2/);
  assert.ok(!/https?:\/\//.test(text), 'prompt must not contain a URL');
  assert.ok(!/rm -rf/.test(text));
});

console.log('\n[client bundle]');

test('bundle 能在最小 __ModuleLoader__ 下注册并导出 apply', () => {
  const source = readFileSync(join(root, 'lib/client.js'), 'utf8');
  let registered = null;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(entry) {
          registered = entry;
        },
      },
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  assert.ok(registered, 'bundle did not call __ModuleLoader__.load');
  // 注册 id 必须等于 package.json 的 name，否则 dsh-client-modules 按包名找不到 factory。
  assert.equal(registered.id, 'dsh-tool-cards', 'bundle id must equal the package name');

  // 用最小的 react 替身跑 factory：只验证模块求值不抛错、导出面正确。
  // React.Component 必须是真的类——bundle 里的第三方库会 extends 它。
  class Component {
    constructor(props) {
      this.props = props;
    }
    setState() {}
  }
  const reactStub = {
    Component,
    PureComponent: Component,
    createElement: () => null,
    cloneElement: () => null,
    isValidElement: () => false,
    Children: { map: () => [], toArray: () => [] },
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    useContext: () => null,
    createContext: () => ({ Provider: null, Consumer: null }),
    memo: (fn) => fn,
    forwardRef: (fn) => fn,
    useSyncExternalStore: (_s, get) => get(),
    version: '18.3.1',
  };
  const exports = registered.factory((id) => {
    if (id === 'react') return reactStub;
    if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: null };
    throw new Error(`unexpected external: ${id}`);
  });

  assert.equal(typeof exports.apply, 'function');
  assert.deepEqual([...exports.inject], ['slots']);

  // 提升机制的三件套：节点类型、节点视图、事件定义生成器
  assert.equal(typeof exports.CHAT_UI_NODE_KIND, 'string');
  assert.equal(typeof exports.ChatUiNode, 'function');
  assert.equal(typeof exports.ChatUiToolRow, 'function');
  assert.equal(typeof exports.createChatUiDefinition, 'function');

  // 事件定义必须能真的把一条 tool/result 变成最终输出节点
  const definition = exports.createChatUiDefinition();
  assert.equal(definition.kind, exports.CHAT_UI_NODE_KIND);
  assert.equal(definition.target, 'chat');
  const meta = { kind: 'chat-ui/1.0', title: 't', ui: { schemaVersion: 'chat-ui/1.0', initialState: {}, tree: { id: 'r', type: 'Card' }, actions: {} } };
  const event = { type: 'tool/result', seq: 7, data: { turn: 1, meta } };
  const matched = definition.match(event);
  assert.ok(matched, 'match() should accept a chat_ui tool result');
  const state = definition.start({}, { event, ...matched });
  const node = definition.buildViewNode({ key: 'k', id: 'id', state });
  assert.equal(node.kind, exports.CHAT_UI_NODE_KIND);
  assert.equal(node.visibility, 'visible');
  // bundle 在 vm 沙箱里，对象原型与本地不同，用字段断言而不是 deepEqual。
  assert.equal(node.location.kind, 'session');
  assert.equal(node.data.card.title, 't');

  // 非 chat_ui 的结果必须不匹配，避免抢别人的节点
  assert.equal(definition.match({ type: 'tool/result', seq: 8, data: { turn: 1, meta: { kind: 'other' } } }), null);
  assert.equal(definition.match({ type: 'assistant/message', seq: 9, data: {} }), null);
});

test('bundle 不含未解析的 external 请求', () => {
  const source = readFileSync(join(root, 'lib/client.js'), 'utf8');
  const requires = [...source.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]);
  const unique = [...new Set(requires)].sort();
  // 平台模块表提供 react 与 react/jsx-runtime，二者都属合法 external。
  assert.deepEqual(unique, ['react', 'react/jsx-runtime'], `unexpected externals: ${unique.join(', ')}`);
});

test('卡片文案不得出现“让 AI”式措辞（由运行时模型按任务自己起名）', () => {
  // 检查所有会进入用户界面的示例与预览数据；工具描述本身也检查，
  // 避免模型照着示例抄回“让 AI 分析”。
  const files = [
    join(root, 'tools/sample-args.json'),
    join(root, 'dist-preview/meta.js'),
    join(root, '..', '..', 'chat-ui-demo', 'src', 'examples', 'dose-calculator.json'),
    join(root, '..', '..', 'chat-ui-demo', 'src', 'examples', 'pollutant-analysis.json'),
    join(root, '..', '..', 'chat-ui-demo', 'src', 'examples', 'intake-form.json'),
  ];
  const banned = [/让\s*AI/, /AI\s*分析/, /问\s*模型/, /请\s*模型/, /不请求大模型/];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const pattern of banned) {
      assert.ok(!pattern.test(text), `${file} contains banned UI wording: ${pattern}`);
    }
  }
  // 工具描述可以出现这些词，但只能出现在「不要这样写」的约束里。
  const host = readFileSync(join(root, 'host.js'), 'utf8');
  assert.ok(/不要出现/.test(host) || /不要写/.test(host), 'tool description must state the wording rule');
});

test('动作路由不信任客户端自报的 sessionId（越权防护）', () => {
  const host = readFileSync(join(root, 'host.js'), 'utf8');
  const code = host
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('/*') && !line.trim().startsWith('//'))
    .join('\n');

  // 1. 不得从请求体读 sessionId 并据此解析 agent
  assert.ok(
    !/agents\?\.get\?\.\(sessionId\)/.test(code),
    'route must not resolve an agent from a client-supplied sessionId',
  );
  assert.ok(
    !/body\?\.sessionId/.test(code),
    'route must not read body.sessionId at all',
  );
  // 2. 必须走宿主签发的卡片凭证
  assert.ok(/resolveCardOwner\(/.test(code), 'route must resolve the owner via cardToken');
  assert.ok(/issueCardToken\(/.test(code), 'tool execute must issue a card token');
  // 3. 客户端绝不能发送 sessionId
  const client = readFileSync(join(root, 'src/client.js'), 'utf8');
  const clientCode = client
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('/*') && !line.trim().startsWith('//'))
    .join('\n');
  assert.ok(!/sessionId/.test(clientCode), 'client must not send sessionId');
});

test('客户端不读取 ctx.styles（静态插件的 ctx 没有该服务）', () => {
  const source = readFileSync(join(root, 'src/client.js'), 'utf8');
  // 允许出现在 JSDoc 里，但不允许出现在可执行代码里
  const code = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('/*') && !line.trim().startsWith('//'))
    .join('\n');
  assert.ok(!/ctx\s*\.\s*styles/.test(code), 'src/client.js must not read ctx.styles');
  assert.ok(!/ctx\s*\.\s*styles/.test(readFileSync(join(root, 'lib/client.js'), 'utf8')    .replace(/"[^"]*ctx\.styles[^"]*"/g, '')), 'bundle must not read ctx.styles');
});

test('客户端上报体必须带 operation（宿主靠它映射能力）', () => {
  const source = readFileSync(join(root, 'src/client.js'), 'utf8');
  assert.ok(/operation:\s*action\?\.operation/.test(source), 'postAction must include operation from the action table');
  assert.ok(!/postAction\(\{\s*sessionId:\s*props\.sessionId,\s*\.\.\.event\s*\}\)/.test(source),
    'postAction must not just spread the event (it lacks operation)');
});

test('卡片外壳提供标题容器（否则标题被丢掉）', () => {
  const source = readFileSync(join(root, 'src/client.js'), 'utf8');
  assert.ok(/cui-chat-card-title/.test(source), 'ChatUiCard must render a title container');
  assert.ok(/className: 'cui-chat-card'/.test(source), 'ChatUiCard must render the card shell');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const failure of failures) {
    console.error(`--- ${failure.name}`);
    console.error(failure.cause);
  }
  process.exitCode = 1;
}
