/**
 * chat-ui/1.0 → json-render Spec 兼容层。
 *
 * 对外协议 = 《交互式聊天组件复现_开发规范_v1.0》§4 的 chat-ui/1.0
 * （嵌套 tree + 表达式 AST + actions）。
 * 渲染内核 = vercel-labs/json-render 的扁平 Spec（$state / $bindState /
 * $computed / $cond / visible / on）。
 *
 * 为什么要这一层：规范文档里的作者格式（嵌套、AST 表达式）对模型更友好，
 * 而 json-render 的渲染器要求扁平 elements + JSON Pointer 状态路径。
 * 转换是纯函数、无求值、无 eval：AST 只被「翻译」成 $computed 调用，
 * 真正的算术由注册在 JSONUIProvider.functions 里的白名单函数完成。
 *
 * @module chat-ui-demo/protocol/chatui
 */

/** chat-ui/1.0 的表达式操作符白名单（规范 §4 唯一的 op 集合）。 */
export const EXPR_OPS = ['add', 'sub', 'mul', 'div', 'round', 'eq', 'and', 'or', 'not'];

/** 表达式递归深度上限（规范 §5.3 要求限深）。 */
const MAX_EXPR_DEPTH = 8;

/** 表达式节点数上限。 */
const MAX_EXPR_NODES = 200;

/**
 * 把 AST 参数数组转成 json-render `$computed` 需要的具名参数对象。
 * json-render 的 `$computed.args` 是 Record<string, Expr>，所以 a0/a1/... 具名。
 * @param {Array} args
 * @param {number} depth
 * @param {{nodes:number}} budget
 * @returns {Record<string, unknown>}
 */
function compileArgs(args, depth, budget) {
  const out = {};
  (args ?? []).forEach((arg, index) => {
    out[`a${index}`] = compileExpr(arg, depth + 1, budget);
  });
  return out;
}

/**
 * 编译一个表达式：AST → json-render 动态值。
 * - 字面量原样返回
 * - {var} → {$state: "/"+var}
 * - {op,args} → {$computed: op, args: {a0..aN}}
 * @param {unknown} expr
 * @param {number} [depth]
 * @param {{nodes:number}} [budget]
 * @returns {unknown}
 */
export function compileExpr(expr, depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (depth > MAX_EXPR_DEPTH) throw new Error(`expression nesting exceeds ${MAX_EXPR_DEPTH}`);
  if (budget.nodes > MAX_EXPR_NODES) throw new Error(`expression node count exceeds ${MAX_EXPR_NODES}`);

  if (expr === null || typeof expr !== 'object') return expr;

  if (Array.isArray(expr)) return expr.map((item) => compileExpr(item, depth + 1, budget));

  if (typeof expr.var === 'string') return { $state: `/${expr.var}` };

  if (typeof expr.op === 'string') {
    if (!EXPR_OPS.includes(expr.op)) throw new Error(`unsupported expression op: ${expr.op}`);
    const args = Array.isArray(expr.args) ? expr.args : [];
    if (args.length === 0) throw new Error(`expression "${expr.op}" needs at least one argument`);
    if (args.length > 8) throw new Error(`expression "${expr.op}" accepts at most 8 arguments`);
    return { $computed: expr.op, args: compileArgs(args, depth, budget) };
  }

  // 普通对象：逐值递归（props 里可能嵌表达式）
  const out = {};
  for (const [key, value] of Object.entries(expr)) {
    out[key] = compileExpr(value, depth + 1, budget);
  }
  return out;
}

/**
 * 编译一个组件的 props：`bind` 变成 `$bindState`，其余按表达式编译。
 * 规范里 bind 写在元素顶层（`bind: "soilTons"`），json-render 里是
 * 「某个 prop 用 $bindState」；控件统一把绑定值放在 `value` prop 上。
 * @param {{bind?:string, props?:Record<string, unknown>, value?:unknown}} node
 * @returns {Record<string, unknown>}
 */
function compileProps(node) {
  const props = { ...(node.props ?? {}) };

  if (typeof node.bind === 'string' && node.bind.length > 0) {
    props.value = { $bindState: `/${node.bind}` };
  } else if (node.value !== undefined) {
    props.value = compileExpr(node.value);
  } else if (props.value !== undefined) {
    props.value = compileExpr(props.value);
  }

  // props 内部也可能带表达式（例如 chart 的 data 来自状态）
  for (const [key, value] of Object.entries(props)) {
    if (key === 'value' && props.value && props.value.$bindState) continue;
    props[key] = compileExpr(value);
  }
  return props;
}

/** 需要把 `action.kind` 映射成可读标签的集合。 */
const ACTION_KINDS = new Set(['submitToAgent', 'callTool', 'openUrl']);

/**
 * 把 chat-ui/1.0 的嵌套 tree 编译成 json-render 的扁平 spec。
 *
 * 输出：{ root, elements, state }
 * - elements 的 key = 原 node.id（保持可读、可定位）
 * - state 的来源：ui.initialState 摊平为值；`value` 表达式仍留在 props 里
 * - 动作：node.actionId 落到 `on.click = { action: actionId, params }`，
 *   由宿主 handlers 承接；动作本身的 operation/includeKeys 由调用方保留
 *   （见 normalizeActions），避免把服务端语义塞进客户端 spec。
 *
 * @param {object} message chat-ui/1.0 消息
 * @returns {{root:string, elements:Record<string, object>, state:Record<string, unknown>}}
 */
export function compileMessage(message) {
  const ui = message?.ui;
  if (!ui) throw new Error('message has no ui payload');
  if (ui.schemaVersion !== 'chat-ui/1.0') throw new Error(`unsupported schemaVersion: ${ui.schemaVersion}`);
  if (!ui.tree || typeof ui.tree.id !== 'string') throw new Error('ui.tree is missing a root id');

  const elements = {};
  const seen = new Set();

  const walk = (node, parentId) => {
    if (!node || typeof node.id !== 'string') throw new Error('every node needs a string id');
    if (seen.has(node.id)) throw new Error(`duplicate node id: ${node.id}`);
    seen.add(node.id);

    const element = {
      type: node.type,
      props: compileProps(node),
    };

    if (node.label !== undefined) element.props.label = node.label;
    if (node.actionId !== undefined) {
      element.on = { click: { action: node.actionId } };
      element.props.actionId = node.actionId;
    }

    // 规范 §2-4：条件显隐随状态联动；映射到 json-render 的 visible 白名单。
    const visible = compileVisibility(node.visible);
    if (visible !== undefined) element.visible = visible;

    const children = Array.isArray(node.children) ? node.children : [];
    if (children.length > 0) {
      element.children = children.map((child) => child.id);
    }

    elements[node.id] = element;
    for (const child of children) walk(child, node.id);
    return node.id;
  };

  walk(ui.tree, null);

  return {
    root: ui.tree.id,
    elements,
    state: { ...(ui.initialState ?? {}) },
  };
}

/**
 * 把 chat-ui/1.0 的显隐条件编译成 json-render 的 `visible`。
 *
 * 规范用的是安全的比较式条件（不带 eval），json-render 的 `visible`
 * 恰好是同一套白名单算子，因此这里只做形状映射：
 *   { var, eq }            → { $state: "/var", eq: value }
 *   { var, in: [...] }     → { $or: [ {eq v1}, {eq v2}, ... ] }
 *   { var }                → { $state: "/var" }（真值判断）
 *   { not: cond }          → 内层取反
 *
 * 不支持的形状直接抛错——宁可让消息降级，也不静默忽略安全条件。
 * @param {unknown} condition
 * @returns {unknown}
 */
export function compileVisibility(condition) {
  if (condition === undefined) return undefined;
  if (typeof condition === 'boolean') return condition;
  if (condition === null || typeof condition !== 'object') {
    throw new Error('visible must be a condition object or boolean');
  }

  if (Array.isArray(condition)) {
    return condition.map(compileVisibility);
  }

  if (condition.not !== undefined) {
    const inner = compileVisibility(condition.not);
    return { $and: [{ not: true, ...(typeof inner === 'object' ? inner : { $state: '/__always' }) }] };
  }

  const stateKey = condition.var ?? condition.$state;
  if (typeof stateKey !== 'string') throw new Error('visible needs a "var" state key');

  const pointer = stateKey.startsWith('/') ? stateKey : `/${stateKey}`;

  if (Array.isArray(condition.in)) {
    return { $or: condition.in.map((value) => ({ $state: pointer, eq: value })) };
  }

  const out = { $state: pointer };
  for (const op of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte']) {
    if (condition[op] !== undefined) out[op] = condition[op];
  }
  return out;
}

/**
 * 规范化 actions 表，供宿主保存「可信的动作描述」。
 * 客户端只记住 actionId → operation/includeKeys，绝不保存 URL 之外的执行体。
 * @param {Record<string, object>} actions
 * @returns {Record<string, object>}
 */
export function normalizeActions(actions) {
  const out = {};
  for (const [actionId, action] of Object.entries(actions ?? {})) {
    if (!action || typeof action.kind !== 'string' || !ACTION_KINDS.has(action.kind)) {
      throw new Error(`action "${actionId}" has an unsupported kind`);
    }
    if (action.kind === 'openUrl') {
      if (typeof action.url !== 'string' || !/^https?:\/\//i.test(action.url)) {
        throw new Error(`action "${actionId}" openUrl must be http(s)`);
      }
      out[actionId] = { kind: 'openUrl', url: action.url };
      continue;
    }
    out[actionId] = {
      kind: action.kind,
      operation: action.operation,
      includeKeys: Array.isArray(action.includeKeys) ? [...action.includeKeys] : [],
    };
  }
  return out;
}

/**
 * 生成 HOST_ACTION 事件（规范 §4.2）。
 * 只包含白名单键的「验证后快照」，不携带任何可执行目标。
 * @param {{messageId:string, componentId:string, actionId:string, values:Record<string, unknown>}} input
 * @returns {object}
 */
export function buildActionEvent({ messageId, componentId, actionId, values }) {
  return {
    type: 'ui.action',
    messageId,
    componentId,
    actionId,
    clientEventId: `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    values: { ...values },
  };
}

/* ------------------------------------------------------------------ *
 * 表达式求值器（宿主 functions 表，白名单 switch，绝不 eval）
 * ------------------------------------------------------------------ */

/**
 * 数字收敛：把 NaN / ±Infinity 收敛为 `undefined`，交给 UI 显示错误。
 * @param {number} value
 * @returns {number|undefined}
 */
function finite(value) {
  return Number.isFinite(value) ? value : undefined;
}

/** 逐参数取数，非数字返回 undefined。 */
function nums(args) {
  return Object.keys(args ?? {})
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((key) => args[key]);
}

/**
 * 白名单算术函数表：名字与规范 EXPR_OPS 一一对应。
 * 每个函数接收 `{a0, a1, ...}`，返回数字或 undefined。
 * @type {Record<string, (args:Record<string, unknown>) => unknown>}
 */
export const expressionFunctions = {
  add: (args) => finite(nums(args).reduce((sum, v) => sum + Number(v), 0)),
  sub: (args) => {
    const [a, b, ...rest] = nums(args).map(Number);
    return finite(rest.reduce((acc, v) => acc - v, a - b));
  },
  mul: (args) => finite(nums(args).reduce((acc, v) => acc * Number(v), 1)),
  div: (args) => {
    const list = nums(args).map(Number);
    const result = list.slice(1).reduce((acc, v) => (v === 0 ? NaN : acc / v), list[0]);
    return finite(result);
  },
  round: (args) => {
    const [value, digits] = nums(args).map(Number);
    if (!Number.isFinite(value)) return undefined;
    const d = Math.min(Math.max(Number.isFinite(digits) ? digits : 0, 0), 10);
    const factor = 10 ** d;
    return finite(Math.round(value * factor) / factor);
  },
  eq: (args) => {
    const [a, b] = nums(args);
    return a === b;
  },
  and: (args) => nums(args).every(Boolean),
  or: (args) => nums(args).some(Boolean),
  not: (args) => !nums(args)[0],
};

/**
 * 判断一次计算结果是否「可展示」。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRenderableNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}
