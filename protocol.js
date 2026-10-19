/**
 * chat-ui/1.0 协议层：宿主与客户端共用的纯函数部分。
 *
 * 本文件不 import 任何东西——host 与 client 两侧都要能在受限环境里加载它。
 *
 * @module dsh-tool-cards/protocol
 */

/** 注册进模型可见工具表的名称。 */
export const TOOL_NAME = 'chat_ui';

/** 规范 §1 的组件白名单；与客户端 catalog 必须逐字一致。 */
export const ALLOWED_TYPES = Object.freeze([
  'Slider', 'Checkbox', 'Radio', 'Select', 'Segmented', 'Input', 'Textarea', 'Date', 'Button',
  'Form', 'Pressable', 'Popover', 'Carousel', 'Chart', 'Map',
  'Card', 'Metric', 'Text', 'Heading', 'Row', 'Column', 'Divider', 'Badge', 'Alert', 'Table', 'KeyValue',
]);

const ALLOWED_TYPE_SET = new Set(ALLOWED_TYPES);

/** 规范 §8 的工程限额（首版阈值）。 */
export const LIMITS = Object.freeze({
  maxPayloadBytes: 64 * 1024,
  maxNodes: 120,
  maxDepth: 8,
  maxStateKeys: 60,
  maxProps: 40,
  maxActions: 20,
  maxIncludeKeys: 60,
});

/**
 * 校验并规范化一棵 chat-ui/1.0 的 UI 树。
 * @param {unknown} ui
 * @returns {{ok:true, ui:object} | {ok:false, error:string}}
 */
export function validateUi(ui) {
  if (ui === null || typeof ui !== 'object' || Array.isArray(ui)) {
    return { ok: false, error: 'ui must be an object' };
  }
  let serialized;
  try {
    serialized = JSON.stringify(ui);
  } catch {
    return { ok: false, error: 'ui must contain only JSON-compatible values' };
  }
  if (typeof serialized !== 'string') {
    return { ok: false, error: 'ui must contain only JSON-compatible values' };
  }
  if (new TextEncoder().encode(serialized).byteLength > LIMITS.maxPayloadBytes) {
    return { ok: false, error: `ui payload exceeds ${LIMITS.maxPayloadBytes} bytes` };
  }
  if (ui.schemaVersion !== 'chat-ui/1.0') {
    return { ok: false, error: `unsupported schemaVersion: ${String(ui.schemaVersion)}` };
  }
  if (ui.tree === null || typeof ui.tree !== 'object' || Array.isArray(ui.tree)) {
    return { ok: false, error: 'ui.tree must be an object' };
  }

  const seenIds = new Set();
  const referencedActionIds = new Set();
  let nodeCount = 0;
  let failure = null;

  /** 深度优先校验；任何一处不合法就整张卡拒绝渲染。 */
  const walk = (node, depth) => {
    if (failure !== null) return;
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      failure = 'every node must be an object';
      return;
    }
    if (typeof node.id !== 'string' || node.id === '') {
      failure = 'every node needs a non-empty string id';
      return;
    }
    if (seenIds.has(node.id)) {
      failure = `duplicate node id: ${node.id}`;
      return;
    }
    seenIds.add(node.id);

    nodeCount += 1;
    if (nodeCount > LIMITS.maxNodes) {
      failure = `node count exceeds ${LIMITS.maxNodes}`;
      return;
    }
    if (depth > LIMITS.maxDepth) {
      failure = `tree depth exceeds ${LIMITS.maxDepth}`;
      return;
    }
    if (typeof node.type !== 'string' || !ALLOWED_TYPE_SET.has(node.type)) {
      failure = `unsupported component type: ${String(node.type)}`;
      return;
    }
    if (node.label !== undefined && (typeof node.label !== 'string' || node.label.length > 512)) {
      failure = `node "${node.id}" has an invalid label`;
      return;
    }
    if (node.bind !== undefined && (typeof node.bind !== 'string' || node.bind.length > 128)) {
      failure = `node "${node.id}" has an invalid bind`;
      return;
    }
    if (node.actionId !== undefined && (typeof node.actionId !== 'string' || node.actionId.length > 128)) {
      failure = `node "${node.id}" has an invalid actionId`;
      return;
    }
    if (typeof node.actionId === 'string') referencedActionIds.add(node.actionId);
    if (node.props !== undefined) {
      if (node.props === null || typeof node.props !== 'object' || Array.isArray(node.props)) {
        failure = `node "${node.id}" props must be an object`;
        return;
      }
      if (Object.keys(node.props).length > LIMITS.maxProps) {
        failure = `node "${node.id}" has too many props`;
        return;
      }
    }

    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) {
        failure = `node "${node.id}" children must be an array`;
        return;
      }
      for (const child of node.children) walk(child, depth + 1);
    }
  };

  walk(ui.tree, 0);
  if (failure !== null) return { ok: false, error: failure };

  const initialState = ui.initialState ?? {};
  if (initialState === null || typeof initialState !== 'object' || Array.isArray(initialState)) {
    return { ok: false, error: 'ui.initialState must be an object' };
  }
  if (Object.keys(initialState).length > LIMITS.maxStateKeys) {
    return { ok: false, error: `initialState exceeds ${LIMITS.maxStateKeys} keys` };
  }

  const actions = ui.actions ?? {};
  if (actions === null || typeof actions !== 'object' || Array.isArray(actions)) {
    return { ok: false, error: 'ui.actions must be an object' };
  }
  const actionEntries = Object.entries(actions);
  if (actionEntries.length > LIMITS.maxActions) {
    return { ok: false, error: `actions exceed ${LIMITS.maxActions} entries` };
  }

  const normalizedActions = Object.create(null);
  for (const [actionId, action] of actionEntries) {
    if (actionId === '' || actionId.length > 128) {
      return { ok: false, error: 'action ids must contain 1 to 128 characters' };
    }
    if (action === null || typeof action !== 'object' || Array.isArray(action)) {
      return { ok: false, error: `action "${actionId}" must be an object` };
    }
    if (action.kind === 'openUrl') {
      if (typeof action.url !== 'string' || !/^https?:\/\//i.test(action.url) || action.url.length > 2048) {
        return { ok: false, error: `action "${actionId}" openUrl must be an http(s) URL` };
      }
      normalizedActions[actionId] = { kind: 'openUrl', url: action.url };
      continue;
    }
    if (action.kind !== 'submitToAgent' && action.kind !== 'callTool') {
      return { ok: false, error: `action "${actionId}" has an unsupported kind` };
    }
    if (typeof action.operation !== 'string' || action.operation === '' || action.operation.length > 128) {
      return { ok: false, error: `action "${actionId}" needs an operation name` };
    }
    const includeKeys = action.includeKeys ?? [];
    if (!Array.isArray(includeKeys) || includeKeys.some((key) => typeof key !== 'string')) {
      return { ok: false, error: `action "${actionId}" includeKeys must be strings` };
    }
    if (includeKeys.length > LIMITS.maxIncludeKeys) {
      return { ok: false, error: `action "${actionId}" lists too many keys` };
    }
    normalizedActions[actionId] = {
      kind: action.kind,
      operation: action.operation,
      includeKeys: [...includeKeys],
    };
  }

  for (const actionId of referencedActionIds) {
    if (!Object.hasOwn(normalizedActions, actionId)) {
      return { ok: false, error: `node references an unregistered action: ${actionId}` };
    }
  }

  return {
    ok: true,
    ui: {
      schemaVersion: 'chat-ui/1.0',
      initialState,
      tree: ui.tree,
      actions: normalizedActions,
    },
  };
}

/**
 * 把一次卡片动作渲染成给模型看的文本。
 * 只包含「哪个动作、什么参数」，不含任何可执行目标。
 * @param {{actionId?:string, operation?:string, values?:Record<string,unknown>}} payload
 * @returns {string}
 */
export function formatActionPrompt(payload) {
  const actionId = typeof payload?.actionId === 'string' ? payload.actionId : 'unknown';
  const operation = typeof payload?.operation === 'string' ? payload.operation : '';
  const values =
    payload?.values && typeof payload.values === 'object' && !Array.isArray(payload.values) ? payload.values : {};

  const lines = ['（来自聊天内交互卡片的操作）'];
  lines.push(`动作：${actionId}${operation === '' ? '' : `（operation: ${operation}）`}`);
  const entries = Object.entries(values);
  if (entries.length === 0) {
    lines.push('参数：无');
  } else {
    lines.push('参数：');
    for (const [key, value] of entries) lines.push(`- ${key}: ${JSON.stringify(value)}`);
  }
  lines.push('请基于以上参数继续分析或执行。');
  return lines.join('\n');
}
