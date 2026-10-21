/**
 * Host 入口：注册 chat_ui 工具，并把卡片动作变成一次 followup。
 *
 * 三条设计取舍，都写清理由：
 *
 * 1. **动作走 HTTP 路由，不用 `ctx.on` 事件。**
 *    静态插件没有「客户端调宿主」的私有 RPC（那个 `host.call` 只对
 *    `cordis_define` 动态包开放）。本 profile 里可以验证的同类做法是
 *    better-sidebar 与 image-gen：`ctx.webServer.register({kind:'exact', path})`
 *    + `ctx.connection.requestRejection(req)` 做同源围栏。
 *
 * 2. **动作必须变成一条真正的 user 消息。**
 *    DSH 以会话日志为唯一事实来源，模型只能读到日志里的东西。
 *    所以按钮动作 → `agent.followup(createUserTextMessage(...))`，
 *    它才会出现在下一轮的上下文里。
 *
 * 3. **零依赖。**
 *    不 import 任何 `@deepseek-ai/*`。本机 profile 下
 *    `require.resolve('@deepseek-ai/dsh-tools')` 是 MODULE_NOT_FOUND
 *    （只有 Host 自己的解析器能加载），所以手写 definition 比猜
 *    `defineTool` 的编译细节更稳。
 *
 * @module dsh-tool-cards
 */
import { TOOL_NAME, validateUi, formatActionPrompt } from './protocol.js';

export { TOOL_NAME, validateUi, formatActionPrompt };

/** 卡片动作的上报路径。 */
export const ACTION_PATH = '/chat-ui/action';

/** 卡片状态的读写路径。 */
export const STATE_PATH = '/chat-ui/state';

/** 插件激活所需的硬依赖。 */
export const inject = ['tools'];

/** 单次上报的最大字节数，防止一个坏客户端把路由打爆。 */
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TITLE_CHARS = 256;

let messageSeq = 0;

/**
 * 造一条不可变的 user 消息。
 * 形状对齐 `UserMessage`：`{ id, role, content, source }`。
 * @param {string} text
 */
function createUserTextMessage(text) {
  messageSeq += 1;
  return Object.freeze({
    id: `chatui-${Date.now().toString(36)}-${messageSeq.toString(36)}`,
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'user' }),
  });
}

/* ------------------------------------------------------------------ *
 * 卡片归属凭证
 *
 * 安全模型：客户端**不能**指定「把动作写进哪个会话」。
 *
 * 早期实现直接信任 body.sessionId 并 `agents.get(sessionId)`，
 * 任何持有同源凭据的页面都能替任意会话注入一条 user 消息——这是越权。
 *
 * 现在改为：工具执行时由宿主记下「这张卡片属于哪个会话」，
 * 返回给客户端的是一个不透明 token；动作回来时只认 token。
 * 客户端既猜不出别人的 token，也无法把动作指向别的会话。
 *
 * 生命周期：token 随卡片存活而保留（会话可能被重新打开），
 * 用 LRU 上限防止无限增长；会话被释放后 token 自动失效。
 * ------------------------------------------------------------------ */

/** 卡片 token → 会话 id。 */
const cardOwners = new Map();

/** 上限；超过后按插入顺序淘汰最旧的（Map 保持插入序）。 */
const MAX_CARD_TOKENS = 2000;

/**
 * 登记一张卡片的归属会话。
 * @param {string} sessionId
 * @returns {string} 不透明 token
 */
function issueCardToken(sessionId) {
  const token = `tc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  cardOwners.set(token, sessionId);
  while (cardOwners.size > MAX_CARD_TOKENS) {
    const oldest = cardOwners.keys().next();
    if (oldest.done) break;
    cardOwners.delete(oldest.value);
  }
  return token;
}

/**
 * 由 token 反查归属会话。
 * @param {unknown} token
 * @returns {string | undefined}
 */
function resolveCardOwner(token) {
  if (typeof token !== 'string' || token === '') return undefined;
  return cardOwners.get(token);
}

/* ------------------------------------------------------------------ *
 * 卡片状态
 *
 * 卡片是「最终输出」节点，会话切换 / 历史回看都会重新挂载；
 * 没有服务端状态时，用户拖好的参数会瞬间回到初始值。
 *
 * 存在进程内 Map（按 cardToken 分键），不写进会话日志：
 * 拖动是交互过程而非对话事实，写日志会让上下文被高频记录污染。
 *
 * 与 cardOwners 一样用 LRU 上限；token 失效时状态一并删除。
 * ------------------------------------------------------------------ */

/** 卡片 token → 该卡片的状态快照。 */
const cardStates = new Map();

/** 状态条数上限。 */
const MAX_CARD_STATES = 2000;

/** 单份状态的 JSON 上限（规范 §8：数值输入要限额）。 */
const MAX_STATE_BYTES = 16 * 1024;

/**
 * 保存一份卡片状态。
 * @param {string} token
 * @param {unknown} state
 * @returns {boolean} 是否接受
 */
function saveCardState(token, state) {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return false;
  let serialized;
  try {
    serialized = JSON.stringify(state);
  } catch {
    return false;
  }
  if (typeof serialized !== 'string' || serialized.length > MAX_STATE_BYTES) return false;

  // 重新插入以刷新 LRU 顺序
  cardStates.delete(token);
  cardStates.set(token, state);
  while (cardStates.size > MAX_CARD_STATES) {
    const oldest = cardStates.keys().next();
    if (oldest.done) break;
    cardStates.delete(oldest.value);
  }
  return true;
}

/**
 * 读回一份卡片状态。
 * @param {string} token
 * @returns {unknown | null}
 */
function loadCardState(token) {
  if (!cardStates.has(token)) return null;
  const state = cardStates.get(token);
  // LRU 刷新
  cardStates.delete(token);
  cardStates.set(token, state);
  return state;
}

/** 读请求体，带大小上限。 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('payload too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  return JSON.parse(text);
}

/** 统一的 JSON 响应。 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/**
 * Cordis 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{echoPrompt?: boolean}} [config]
 */
export function apply(ctx, config = {}) {
  const settings = { echoPrompt: config?.echoPrompt !== false };

  /* ---------------- chat_ui 工具 ---------------- */

  const disposeTool = ctx.tools.register({
    name: TOOL_NAME,
    description:
      '在聊天里嵌入一个可交互卡片（chat-ui/1.0），让用户直接调参并当场看到结果。' +
      '\n\n【你应该主动调用它的场合】' +
      '\n- 用户在调参数、做取舍，且结果可以由公式/规则算出来（投加量、配比、阈值、预算、评分、单位换算）。' +
      '\n- 你正要给出一串数字，而其中几个是用户可调的输入：不要只在正文里罗列，做成卡片让他拖。' +
      '\n- 需要用户先做选择你才能继续（选工艺、选污染物、选口径）：用 Select/Radio/Segmented 收齐再提交。' +
      '\n- 要展示多维数据对比（各点位浓度、多方案对比）：用 Chart/Table 代替长表格。' +
      '\n- 用户说“做个计算器/面板/调试一下看看/给我个可调的东西”。' +
      '\n\n【不要用的场合】' +
      '\n- 纯问答、纯解释、一次性的最终结论（用户没有可调的输入）。' +
      '\n- 只是为了排版好看而套一层卡片。' +
      '\n\n【约定】' +
      '\n- 卡片内拖动/勾选/输入只在本地联动，不会发消息也不消耗 token；' +
      '只有用户点动作按钮（Button/Pressable）才会把参数快照作为新消息回给你。' +
      '\n- 因此：需要用户确认后你再继续的动作，一定要给一个 Button，并在 actions 里登记它。' +
      '\n- 组件白名单：Slider/Checkbox/Radio/Select/Segmented/Input/Textarea/Date/Button/Form/Pressable/' +
      'Popover/Carousel/Chart/Map/Card/Metric/Text/Heading/Row/Column/Divider/Badge/Alert/Table/KeyValue。' +
      '\n- 计算用表达式 AST：{op:"mul",args:[{var:"a"},{var:"b"}]}，op 只能是 ' +
      'add/sub/mul/div/round/eq/and/or/not，禁止写代码。' +
      '\n\n【文案规范（重要）】' +
      '\n- 卡片是产品界面，不是技术演示。按钮、标题、提示里不要出现“让 AI”“AI 分析”“问模型”“请模型”这类词；' +
      '也不要写“本地计算/不请求大模型”这类实现解释。用户关心的是他要完成的动作。' +
      '\n- 按钮文案要写**用户的下一个动作**，由你按当前任务决定，例如：' +
      '“应用这组参数”“按此方案出清单”“计算推荐投加量”“提交这次配比”“确认并生成报告”“重新评估达标情况”。' +
      '\n- 一般同一张卡片只留一个主按钮；确有必要再补一个次要按钮（variant: "secondary"）。' +
      '\n- 卡片标题说清这张卡在算什么；不要用“交互卡片”“参数面板”这类占位词。',

    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '卡片标题，用于工具行摘要。' },
        ui: {
          type: 'object',
          description: 'chat-ui/1.0 载荷：{ schemaVersion, initialState, tree, actions }。',
          properties: {
            schemaVersion: { type: 'string' },
            initialState: { type: 'object' },
            tree: { type: 'object' },
            actions: { type: 'object' },
          },
          required: ['schemaVersion', 'tree'],
        },
      },
      required: ['ui'],
    },

    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          ui: { type: 'object' },
          error: { type: 'string' },
          // 宿主签发的卡片凭证：客户端动作回传时只认它，不认自报的 sessionId
          cardToken: { type: 'string' },
          // 拿不到会话归属时置 true：卡片可见但提交按钮不可用
          readonly: { type: 'boolean' },
        },
        required: ['ok'],
      },

      /** 模型看到的是纯文本摘要；UI 不进上下文。 */
      render(args, value) {
        if (!value.ok) {
          return [{ type: 'text', text: `卡片未渲染：${value.error ?? '未知原因'}` }];
        }
        const title = typeof args.title === 'string' && args.title !== '' ? args.title : '交互卡片';
        const count = Object.keys(value.ui?.actions ?? {}).length;
        return [
          {
            type: 'text',
            text:
              `已渲染交互卡片「${title}」（${count} 个动作）。` +
              '用户在卡片里的拖动、勾选、输入都在本地完成，不会触发新消息；' +
              '点击带动作的按钮时，你会收到一条包含参数快照的新消息。',
          },
        ];
      },

      /** 客户端从 tool/result 的 meta 读完整 UI 与卡片凭证。 */
      presentationMeta(args, value) {
        if (!value.ok) return { kind: 'chat-ui/1.0', error: value.error ?? 'unknown' };
        return {
          kind: 'chat-ui/1.0',
          title: typeof args.title === 'string' ? args.title : '',
          ui: value.ui,
          // 凭证随 meta 下发；它是客户端回传动作的唯一凭据。
          ...(typeof value.cardToken === 'string' ? { cardToken: value.cardToken } : {}),
          ...(value.readonly === true ? { readonly: true } : {}),
        };
      },
    },

    /**
     * 校验 + 签发卡片凭证。
     *
     * `exec.agent.id` 就是这张卡片所属的会话，**由宿主在执行时确定**，
     * 客户端无法伪造。凭证随结果返回，客户端只能拿着它回传动作。
     */
    async execute(args, exec) {
      if (args?.title !== undefined && (typeof args.title !== 'string' || args.title.length > MAX_TITLE_CHARS)) {
        return { ok: false, error: `title must be a string of at most ${MAX_TITLE_CHARS} characters` };
      }
      const result = validateUi(args?.ui);
      if (!result.ok) return { ok: false, error: result.error };

      const sessionId = typeof exec?.agent?.id === 'string' ? exec.agent.id : undefined;
      if (sessionId === undefined) {
        // 拿不到会话就无法安全地归属动作；宁可让卡片只读，也不猜一个目标。
        return { ok: true, ui: result.ui, readonly: true };
      }
      return { ok: true, ui: result.ui, cardToken: issueCardToken(sessionId) };
    },

    isConcurrencySafe: () => true,
  });

  ctx.effect(() => disposeTool, 'dsh-tool-cards: chat_ui tool');

  /* ---------------- 系统提示：让模型在合适时机自己想起这个工具 ---------------- */

  ctx.effect(() => {
    const systemPrompt = ctx.get('systemPrompt');
    if (!systemPrompt) return () => {};
    return systemPrompt.section({
      name: 'chat-ui:cards',
      order: 620,
      text:
        '当用户正在调参数、做取舍，或某个结论依赖他自己可调的输入时，' +
        '优先用 `chat_ui` 工具把参数做成可交互卡片，而不是只用文字罗列数字。' +
        '典型触发：投加量/配比/阈值/预算/评分这类可调数值、需要用户先选口径才能继续、' +
        '多维数据对比（图表优于长表格）、用户说“做个计算器/面板/调一下看看”。' +
        '不需要时不套卡片：纯解释、一次性结论、没有可调输入的回答直接写正文。' +
        '卡片里的控件只在本地联动不消耗 token；需要用户确认后再继续的动作，' +
        '必须给一个 Button 并在 actions 里登记，用户点了才会带着参数快照回来。' +
        '卡片文案按当前任务由你自己起：按钮写用户的下一个动作（如“应用这组参数”“计算推荐投加量”），' +
        '不要出现“让 AI”“AI 分析”“问模型”或“本地计算/不请求大模型”这类词——' +
        '用户看到的是产品界面，不是你和他之间的技术说明。',
    });
  }, 'dsh-tool-cards: prompt section');

  /* ---------------- 动作上报路由 ---------------- */

  ctx.effect(() => {
    const webServer = ctx.get('webServer');
    if (!webServer) {
      ctx.logger?.('dsh-tool-cards')?.warn?.('webServer unavailable; card actions stay local');
      return () => {};
    }

    const connection = ctx.get('connection');
    const hasOriginGuard = typeof connection?.requestRejection === 'function';
    const allowed = (req) => hasOriginGuard && connection.requestRejection(req) === undefined;

    return webServer.register({
      kind: 'exact',
      path: ACTION_PATH,
      handler: async (req, res) => {
        if (!hasOriginGuard) {
          sendJson(res, 503, { ok: false, error: 'same-origin guard unavailable' });
          return;
        }
        if (!allowed(req)) {
          sendJson(res, 403, { ok: false, error: 'forbidden' });
          return;
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' });
          return;
        }
        const contentType = req.headers?.['content-type'];
        if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
          sendJson(res, 415, { ok: false, error: 'application/json required' });
          return;
        }

        let body;
        try {
          body = await readJsonBody(req);
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : 'bad request' });
          return;
        }

        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { ok: false, error: 'JSON body must be an object' });
          return;
        }

        const actionId = typeof body.actionId === 'string' ? body.actionId : '';
        if (actionId === '' || actionId.length > 128) {
          sendJson(res, 400, { ok: false, error: 'actionId must contain 1 to 128 characters' });
          return;
        }

        // 只认宿主签发的卡片凭证。请求体里的 sessionId **一律忽略**：
        // 那是客户端可伪造的字段，信它等于允许跨会话注入消息。
        const ownerSessionId = resolveCardOwner(body?.cardToken);
        if (ownerSessionId === undefined) {
          sendJson(res, 403, { ok: false, error: 'unknown or expired card token' });
          return;
        }

        const agents = ctx.get('agents');
        // 只认凭证里的会话；body.sessionId 是客户端可伪造字段，绝不使用。
        const agent = agents?.get?.(ownerSessionId);
        if (!agent) {
          sendJson(res, 409, { ok: false, error: 'the card owner session is no longer live' });
          return;
        }

        const prompt = formatActionPrompt({
          actionId,
          operation: body?.operation,
          values: body?.values,
        });

        if (settings.echoPrompt) {
          try {
            await agent.followup(createUserTextMessage(prompt));
          } catch (error) {
            ctx.logger?.('dsh-tool-cards')?.warn?.('failed to submit card action', error);
            sendJson(res, 502, { ok: false, error: 'failed to submit card action' });
            return;
          }
        }

        sendJson(res, 200, { ok: true });
      },
    });
  }, 'dsh-tool-cards: card action route');

  /* ---------------- 卡片状态路由 ---------------- */

  ctx.effect(() => {
    const webServer = ctx.get('webServer');
    if (!webServer) return () => {};

    const connection = ctx.get('connection');
    // 与 action 路由同一口径：没有同源围栏就不放行，而不是默认信任。
    const hasOriginGuard = typeof connection?.requestRejection === 'function';
    const allowed = (req) => hasOriginGuard && connection.requestRejection(req) === undefined;

    return webServer.register({
      kind: 'exact',
      path: STATE_PATH,
      handler: async (req, res) => {
        if (!hasOriginGuard) {
          sendJson(res, 503, { ok: false, error: 'same-origin guard unavailable' });
          return;
        }
        if (!allowed(req)) {
          sendJson(res, 403, { ok: false, error: 'forbidden' });
          return;
        }

        // 读：GET ?cardToken=...
        if (req.method === 'GET') {
          let token;
          try {
            token = new URL(req.url ?? '/', 'http://dsh.internal').searchParams.get('cardToken') ?? '';
          } catch {
            token = '';
          }
          if (resolveCardOwner(token) === undefined) {
            sendJson(res, 403, { ok: false, error: 'unknown or expired card token' });
            return;
          }
          sendJson(res, 200, { ok: true, state: loadCardState(token) });
          return;
        }

        // 写：POST { cardToken, state }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' });
          return;
        }
        // 与 action 路由同一口径：只收 JSON。
        const contentType = req.headers?.['content-type'];
        if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
          sendJson(res, 415, { ok: false, error: 'application/json required' });
          return;
        }

        let body;
        try {
          body = await readJsonBody(req);
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : 'bad request' });
          return;
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { ok: false, error: 'JSON body must be an object' });
          return;
        }

        if (resolveCardOwner(body?.cardToken) === undefined) {
          sendJson(res, 403, { ok: false, error: 'unknown or expired card token' });
          return;
        }
        if (!saveCardState(body.cardToken, body?.state)) {
          sendJson(res, 400, { ok: false, error: 'state must be a JSON object within the size limit' });
          return;
        }
        sendJson(res, 200, { ok: true });
      },
    });
  }, 'dsh-tool-cards: card state route');
}
