/**
 * 一条消息 = 一个独立状态域。
 *
 * 规范 §5.4 要求「每条消息独立保存状态，不可在两个相同控件间无意共享数据」。
 *
 * 注意 json-render 的 StateProvider：一旦传入外部 store（我们需要它，
 * 才能读出快照、也才能给每条消息一份独立 store），它就进入 controlled 模式，
 * **不再回调 onStateChange**。所以持久化必须自己订阅 store。
 *
 * @module chat-ui-demo/MessageCard
 */
import React from 'react';
import { JSONUIProvider, Renderer } from '@json-render/react';
import { createStateStore } from '@json-render/core';
import { compileMessage, normalizeActions, expressionFunctions, buildActionEvent } from './protocol/chatui.js';
import { registry, Unsupported } from './registry.js';
import { ValidationRegistryProvider, useValidationRegistry } from './validation.js';
import { t, makeUseT } from '../i18n.js';

const h = React.createElement;
/** 语言变化时自动重渲染的翻译函数。 */
const useT = makeUseT(React);

/**
 * 渲染一条 chat-ui/1.0 消息。
 * @param {{
 *   message: object,
 *   onHostAction: (event:object, meta:object) => Promise<unknown>,
 *   onStatePersist?: (messageId:string, state:Record<string,unknown>) => void,
 *   initialRuntimeState?: Record<string,unknown>,
 * }} props
 */
export function MessageCard({ message, onHostAction, onStatePersist, initialRuntimeState }) {
  const compiled = React.useMemo(() => {
    const spec = compileMessage(message);
    const actionsTable = normalizeActions(message.ui?.actions);
    return { spec, actionsTable, knownActions: new Set(Object.keys(actionsTable)) };
  }, [message]);

  // 每条消息一个 store：消息之间的同名键不会互相污染。
  // 只在挂载时创建一次；恢复状态已在创建前合并进初始值。
  const storeRef = React.useRef(null);
  if (storeRef.current === null) {
    storeRef.current = createStateStore({
      ...compiled.spec.state,
      ...(initialRuntimeState ?? {}),
    });
  }
  const store = storeRef.current;

  // 宿主读回的状态是**异步**到达的（要先请求 /chat-ui/state）。
  // 到达时 store 已经用 initialState 建好了，必须把值合并进去，
  // 否则「切走再回来」看到的永远是初始值。
  const appliedRestore = React.useRef(initialRuntimeState ?? null);
  React.useEffect(() => {
    if (initialRuntimeState === undefined || initialRuntimeState === null) return;
    if (appliedRestore.current === initialRuntimeState) return;
    appliedRestore.current = initialRuntimeState;
    for (const [key, value] of Object.entries(initialRuntimeState)) {
      if (store.get(`/${key}`) !== value) store.set(`/${key}`, value);
    }
  }, [initialRuntimeState, store]);

  // controlled 模式下订阅 store，把整份快照交给宿主持久化。
  React.useEffect(() => {
    if (!onStatePersist) return undefined;
    return store.subscribe(() => {
      onStatePersist(message.id, store.getSnapshot());
    });
  }, [store, message.id, onStatePersist]);

  return h(
    ValidationRegistryProvider,
    null,
    h(Inner, { compiled, message, store, onHostAction }),
  );
}

/** 内层：在 Provider 内部构造 handlers（需要读到校验登记表）。 */
function Inner({ compiled, message, store, onHostAction }) {
  const validation = useValidationRegistry();

  const handlers = React.useMemo(() => {
    const make = (actionId) => async () => {
      const action = compiled.actionsTable[actionId];
      if (!action) throw new Error(t('unknownAction', { action: actionId }));

      if (action.kind === 'openUrl') {
        window.open(action.url, '_blank', 'noopener,noreferrer');
        return;
      }

      // 规范 T05：必填项不过 → 只显示字段错误，绝不触发远端。
      if (validation && !validation.validateAll()) {
        throw new Error(t('submitBlocked'));
      }

      // 只发送白名单键的「验证后快照」。
      const snapshot = {};
      for (const key of action.includeKeys) {
        snapshot[key] = store.get(`/${key}`);
      }
      const event = buildActionEvent({
        messageId: message.id,
        componentId: message.ui?.tree?.id ?? '',
        actionId,
        values: snapshot,
      });
      await onHostAction?.(event, action);
    };

    // json-render 只在 handler 缺省时 warn，所以这里用 Proxy：
    // 任何未登记 actionId 都解析成一个明确失败的函数，界面才能给出反馈。
    return new Proxy(
      {},
      {
        has: () => true,
        get: (_target, prop) => {
          if (typeof prop !== 'string') return undefined;
          if (compiled.knownActions.has(prop)) return make(prop);
          return async () => {
            throw new Error(`该按钮未绑定动作（${prop}）`);
          };
        },
      },
    );
  }, [compiled, message.id, onHostAction, store, validation]);

  return h(
    'div',
    { className: 'cui-message-ui', 'data-message-id': message.id },
    h(
      JSONUIProvider,
      { registry, store, functions: expressionFunctions, handlers },
      h(Renderer, { spec: compiled.spec, registry, fallback: Unsupported }),
    ),
  );
}

/** 便捷：读出当前 store 快照（供外部「提交前快照」用）。 */
export function readMessageState(message, initialRuntimeState) {
  const spec = compileMessage(message);
  return { ...spec.state, ...(initialRuntimeState ?? {}) };
}
