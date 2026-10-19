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

const h = React.createElement;

/** 宿主路由地址；同源相对路径。 */
const ACTION_PATH = '/chat-ui/action';

/** 自定义 Chat 节点类型名。 */
export const CHAT_UI_NODE_KIND = 'chat-ui-card';

/**
 * 上报一次卡片动作。
 * @param {{sessionId?:string, actionId:string, operation:string, kind:string, values:object}} payload
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
 * @returns {{title:string, ui:object} | null}
 */
function cardFromMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  if (meta.kind !== 'chat-ui/1.0') return null;
  if (!meta.ui || typeof meta.ui !== 'object') return null;
  return { title: typeof meta.title === 'string' ? meta.title : '', ui: meta.ui };
}

/**
 * 卡片本体：给定 { title, ui } 渲染。
 * @param {{card:{title:string, ui:object}, sessionId?:string, cardId:string}} props
 */
function CardBody({ card, sessionId, cardId }) {
  const message = React.useMemo(
    () => ({ id: cardId, role: 'assistant', text: card.title, ui: card.ui }),
    [card, cardId],
  );

  return h(MessageCard, {
    message,
    onHostAction: (event) => {
      const action = card.ui?.actions?.[event.actionId];
      return postAction({
        sessionId,
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
 * @param {{node:{data:{card:object}}, sessionId:string}} props
 */
export function ChatUiNode(props) {
  const card = props.node?.data?.card;
  const cardId = props.node?.data?.cardId ?? props.node?.key ?? 'chat-ui-card';
  if (!card) return null;
  return h(
    'div',
    { className: 'cui-chat-card', 'data-tool': TOOL_NAME },
    card.title ? h('div', { className: 'cui-chat-card-title' }, card.title) : null,
    h(CardBody, { card, sessionId: props.sessionId, cardId }),
  );
}

/**
 * 工具行的占位：卡片已经提升到最终输出，工具行只留一句说明，
 * 避免同一张卡片出现两次。
 * @param {{block:object}} props
 */
export function ChatUiToolRow(props) {
  const card = cardFromMeta(props.block?.meta);
  const [open, setOpen] = React.useState(false);
  return h(
    'div',
    { className: 'cui-toolrow' },
    h(
      'span',
      { className: 'cui-toolrow-text' },
      card ? `交互卡片：${card.title || '未命名'}` : '交互卡片（未渲染）',
    ),
    card
      ? h(
          'details',
          { className: 'cui-toolrow-details' },
          h('summary', null, '查看原始数据'),
          h('pre', { className: 'cui-toolrow-json' }, JSON.stringify(card.ui, null, 2).slice(0, 4000)),
        )
      : null,
    h('span', { className: 'cui-toolrow-note' }, '卡片已显示在下方结果中'),
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
 * @param {{block:object, sessionId:string}} props
 */
export function ChatUiToolRowFallback(props) {
  const card = cardFromMeta(props.block?.meta);
  if (!card) return h(ChatUiToolRow, props);
  return h(
    'div',
    { className: 'cui-chat-card', 'data-tool': TOOL_NAME },
    card.title ? h('div', { className: 'cui-chat-card-title' }, card.title) : null,
    h(CardBody, { card, sessionId: props.sessionId, cardId: 'chat-ui:inline' }),
  );
}

/** 客户端侧硬依赖。 */
export const inject = ['slots'];
