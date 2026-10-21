/**
 * 客户端半边：把 chat_ui 工具的卡片渲染进会话，并**提升为最终输出**。
 *
 * 为什么要「提升」：
 *   `chat_ui` 是工具调用，工具结果默认属于「过程」。DSH 在思考结束后会把过程折叠，
 *   卡片也跟着消失。用户要的是一张留在答案里的可交互卡片，所以这里做两件事：
 *     1. 注册一个自定义 Chat 节点（kind = CHAT_UI_NODE_KIND），由 tool/result 事件驱动；
 *     2. `buildViewNode()` 把它挂进最终输出流，位置与助手回复同级。
 *   这与 dsh-image-gen 处理图片结果的机制完全一致。
 *
 * 注册点：
 *   - `uiConversation.events.register(definition)`  事件 → 节点
 *   - `conversation.chat.node[CHAT_UI_NODE_KIND]`    节点 → 视图
 *   - `tool.call.toolview[chat_ui]`                  工具行的占位提示（不再是卡片本体）
 *
 * 动作出口：POST /chat-ui/action（宿主路由 → agent.followup）。
 *
 * @module dsh-tool-cards/client
 */
import React from 'react';
import { MessageCard } from './runtime/MessageCard.js';
import { TOOL_NAME } from '../protocol.js';
import { CARD_CSS } from './card-css.js';
import { createCardStateStore } from './state-store.js';
import { t, makeUseT, syncFromLocale, subscribeLang, lang as currentLang } from './i18n.js';

const h = React.createElement;
/** 语言变化时自动重渲染的翻译函数。 */
const useT = makeUseT(React);

/** 宿主路由地址；同源相对路径。 */
const ACTION_PATH = '/chat-ui/action';

/** 自定义 Chat 节点类型名。 */
export const CHAT_UI_NODE_KIND = 'chat-ui-card';

/**
 * 订阅界面语言：语言变化时触发重渲染，让已挂载的卡片文案立即更新。
 * 返回值本身不用，它是「当前语言」的标识，作为 state 依赖。
 * @returns {string}
 */
function useLang() {
  const [lang, setLang] = React.useState(() => currentLang());
  React.useEffect(() => subscribeLang(() => setLang(currentLang())), []);
  return lang;
}

/* ------------------------------------------------------------------ *
 * 错误边界
 *
 * 卡片内容是模型生成的，坏 spec / 缺字段 / 组件内异常都可能发生。
 * 没有边界时，一次渲染异常会让**整个 slot entry 崩溃**
 * （控制台 `slot entry crashed in 'conversation.chat.node'`），
 * 用户的整条聊天记录都会受影响。
 *
 * React 只支持 class 组件做错误边界，所以这里用 class。
 * 边界**不吞掉问题**：它把错误摘要显示在卡片位置，方便用户反馈，
 * 同时保留 "查看详情" 折叠块给开发者。
 * ------------------------------------------------------------------ */

export class CardErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.handleRetry = this.handleRetry.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // 只记录，不再向上抛：让这一张卡片降级，而不是整条会话崩掉。
    // console.error 在 DSH 里会带上插件前缀，便于排查。
    console.error('[dsh-tool-cards] card render failed:', error, info?.componentStack ?? '');
  }

  handleRetry() {
    this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (error === null) return this.props.children;

    const message = error instanceof Error ? error.message : String(error);

    return h(
      'div',
      { className: 'cui-alert cui-alert-danger cui-card-error', role: 'alert' },
      h(
        'div',
        { className: 'cui-alert-body' },
        h('strong', null, t('cardFailedTitle')),
        h('span', null, t('cardFailedHint')),
        h(
          'details',
          { className: 'cui-card-error-details' },
          h('summary', null, t('cardFailedDetails')),
          h('pre', { className: 'cui-card-error-message' }, message),
        ),
      ),
      h(
        'button',
        { type: 'button', className: 'cui-button cui-button-secondary', onClick: this.handleRetry },
        t('retry'),
      ),
    );
  }
}

/**
 * 上报一次卡片动作。
 *
 * 只发宿主签发的 `cardToken`，**不发 sessionId**——
 * 目标会话由宿主侧凭证决定，客户端无权指定。
 * @param {{cardToken:string, actionId:string, operation:string, kind:string, values:object}} payload
 */
async function postAction(payload) {
  const response = await fetch(ACTION_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `HTTP ${response.status}`);
  }
}

/**
 * 从工具结果的 meta 里取卡片载荷。
 * @param {unknown} meta
 * @returns {{title:string, ui:object, cardToken?:string, readonly?:boolean} | null}
 */
function cardFromMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  if (meta.kind !== 'chat-ui/1.0') return null;
  if (!meta.ui || typeof meta.ui !== 'object') return null;
  return {
    title: typeof meta.title === 'string' ? meta.title : '',
    ui: meta.ui,
    // 宿主签发的凭证：动作回传的唯一凭据。
    // 客户端**不**发送 sessionId——会话归属由宿主侧凭证决定。
    ...(typeof meta.cardToken === 'string' ? { cardToken: meta.cardToken } : {}),
    ...(meta.readonly === true ? { readonly: true } : {}),
  };
}

/**
 * 卡片本体：给定 { title, ui, cardToken } 渲染。
 *
 * 状态持久化：挂载时向宿主读回上次的值，变更时防抖写回。
 * 卡片是「最终输出」节点，会话切换/历史回看都会重挂载，
 * 没有这一步用户拖好的参数会瞬间丢回初始值。
 *
 * @param {{card:{title:string, ui:object, cardToken?:string, readonly?:boolean}, cardId:string}} props
 */
function CardBody({ card, cardId }) {
  const message = React.useMemo(
    () => ({ id: cardId, role: 'assistant', text: card.title, ui: card.ui }),
    [card, cardId],
  );

  // 每次 card 变化重建存储（cardToken 变了就是另一张卡）。
  const store = React.useMemo(() => createCardStateStore({ cardToken: card.cardToken }), [card.cardToken]);

  // 读回的状态：undefined = 还没读完（此时先渲染初始值，避免闪空白）。
  const [restored, setRestored] = React.useState(undefined);

  React.useEffect(() => {
    let cancelled = false;
    void store
      .read()
      .then((state) => {
        if (!cancelled && state !== null) setRestored(state);
      })
      .catch(() => {
        // 读失败就用初始值，不阻塞渲染
      });
    return () => {
      cancelled = true;
    };
  }, [store]);

  // 卸载时把最后一次变更刷出去，避免「拖完立刻切走」丢掉。
  React.useEffect(
    () => () => {
      store.dispose();
    },
    [store],
  );

  return h(MessageCard, {
    message,
    // 读回之前传 undefined，让 MessageCard 用 spec 里的 initialState。
    initialRuntimeState: restored,
    onStatePersist: (_messageId, state) => store.write(state),
    onHostAction: (event) => {
      if (!card.cardToken) {
        // 宿主没给凭证（例如拿不到会话归属）：明确失败，绝不猜一个目标会话。
        return Promise.reject(new Error(t('noToken')));
      }
      const action = card.ui?.actions?.[event.actionId];
      return postAction({
        cardToken: card.cardToken,
        actionId: event.actionId,
        operation: action?.operation ?? '',
        kind: action?.kind ?? '',
        values: event.values,
      });
    },
  });
}

/**
 * 最终输出的卡片节点。
 *
 * 边界包在**最外层**：节点数据本身异常（缺 card、结构不对）时
 * 也要降级成一张错误卡，而不是让 slot entry 崩掉。
 * @param {{node:{data:{card:object}}}} props
 */
export function ChatUiNode(props) {
  return h(
    CardErrorBoundary,
    null,
    h(ChatUiNodeInner, props),
  );
}

/** 真正的节点渲染；所有异常由外层 CardErrorBoundary 捕获。 */
function ChatUiNodeInner(props) {
  // 订阅语言：切换语言时这里重渲染，卡片骨架文案随之更新。
  useLang();
  const card = props.node?.data?.card;
  const cardId = props.node?.data?.cardId ?? props.node?.key ?? 'chat-ui-card';
  if (!card) return null;
  return h(
    'div',
    { className: 'cui-chat-card', 'data-tool': TOOL_NAME },
    card.title ? h('div', { className: 'cui-chat-card-title' }, card.title) : null,
    h(CardBody, { card, cardId }),
  );
}

/**
 * 工具行的占位：卡片已经提升到最终输出，工具行只留一句说明，
 * 避免同一张卡片出现两次。
 * @param {{block:object}} props
 */
export function ChatUiToolRow(props) {
  return h(CardErrorBoundary, null, h(ChatUiToolRowInner, props));
}

/** 工具行占位的实际渲染。 */
function ChatUiToolRowInner(props) {
  const card = cardFromMeta(props.block?.meta);
  return h(
    'div',
    { className: 'cui-toolrow' },
    h(
      'span',
      { className: 'cui-toolrow-text' },
      card ? card.title || t('unsupportedTitle') : t('unsupportedTitle'),
    ),
    card
      ? h(
          'details',
          { className: 'cui-toolrow-details' },
          h('summary', null, t('cardFailedDetails')),
          h('pre', { className: 'cui-toolrow-json' }, JSON.stringify(card.ui, null, 2).slice(0, 4000)),
        )
      : null,
    h('span', { className: 'cui-toolrow-note' }, ''),
  );
}

/* ------------------------------------------------------------------ *
 * 事件定义：把 tool/result 变成最终输出节点
 * ------------------------------------------------------------------ */

/**
 * 造一个 Chat 节点定义：匹配 chat_ui 的 tool/result，并在最终输出流里建节点。
 * 契约与 dsh-image-gen 的图片结果定义一致。
 * @returns {object}
 */
export function createChatUiDefinition() {
  return {
    kind: CHAT_UI_NODE_KIND,
    target: 'chat',

    match(event) {
      if (event.type !== 'tool/result') return null;
      const card = cardFromMeta(event.data?.meta);
      if (!card) return null;
      const turn = event.data?.turn;
      if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 0) return null;
      return { id: `result:${event.seq}`, role: 'start' };
    },

    start(_context, match) {
      const card = cardFromMeta(match.event.data?.meta);
      const turn = match.event.data?.turn;
      if (!card || typeof turn !== 'number') {
        throw new Error('chat-ui-card start requires a chat_ui tool result');
      }
      return { turn, card, seq: match.event.seq };
    },

    update(context) {
      return context.state;
    },

    buildViewNode(context) {
      const state = context.state;
      if (!state || !state.card) return null;
      return {
        key: context.key,
        kind: CHAT_UI_NODE_KIND,
        id: context.id,
        target: 'chat',
        anchorSeq: state.seq,
        location: { kind: 'session' },
        visibility: 'visible',
        data: {
          turn: state.turn,
          card: state.card,
          cardId: `chat-ui:${context.id}`,
        },
      };
    },
  };
}

/**
 * 客户端插件入口。
 * @param {{slots:object, effect:Function, inject:Function, get:Function}} ctx
 */
export function apply(ctx) {
  // Card styles follow the client plugin lifetime and are removed on dispose.
  ctx.effect(() => {
    const style = document.createElement('style');
    style.textContent = CARD_CSS;
    document.head.appendChild(style);
    return () => style.remove();
  }, 'dsh-tool-cards: card styles');

  // 语言：读一次当前 locale，并订阅变化。
  // 切换语言后卡片文案立即跟着变（无需重载页面）。
  ctx.effect(() => {
    const locale = ctx.get?.('locale');
    if (!locale) return () => {};
    syncFromLocale(locale);
    if (typeof locale.subscribe !== 'function') return () => {};
    return locale.subscribe(() => syncFromLocale(locale));
  }, 'dsh-tool-cards: locale sync');

  // 工具行：只留占位，卡片本体提升到最终输出
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key: TOOL_NAME }, ChatUiToolRow),
  );

  // 提升：注册节点定义 + 节点视图
  ctx.inject(['uiConversation'], (owner) => {
    const uiConversation = owner.get('uiConversation');
    if (!uiConversation || typeof uiConversation.events?.register !== 'function') {
      // 没有 uiConversation 时退化为「卡片留在工具行」，功能仍可用。
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register({ name: 'tool.call.toolview', key: TOOL_NAME }, ChatUiToolRowFallback),
      );
      return;
    }

    owner.effect(
      () => uiConversation.events.register(createChatUiDefinition()),
      'dsh-tool-cards: promoted card node',
    );

    owner.slots.inject('conversation.chat.node', () =>
      owner.slots.register(
        { name: 'conversation.chat.node', key: CHAT_UI_NODE_KIND },
        ChatUiNode,
      ),
    );
  });
}

/**
 * 无 uiConversation 时的退化视图：直接在工具行里渲染卡片。
 * @param {{block:object}} props
 */
export function ChatUiToolRowFallback(props) {
  return h(CardErrorBoundary, null, h(ChatUiToolRowFallbackInner, props));
}

/** 退化视图的实际渲染。 */
function ChatUiToolRowFallbackInner(props) {
  const card = cardFromMeta(props.block?.meta);
  if (!card) return h(ChatUiToolRowInner, props);
  return h(
    'div',
    { className: 'cui-chat-card', 'data-tool': TOOL_NAME },
    card.title ? h('div', { className: 'cui-chat-card-title' }, card.title) : null,
    h(CardBody, { card, cardId: 'chat-ui:inline' }),
  );
}

/** 客户端侧硬依赖。 */
export const inject = ['slots'];
