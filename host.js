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

      /** 客户端从 tool/result 的 meta 读完整 UI。 */
      presentationMeta(args, value) {
        if (!value.ok) return { kind: 'chat-ui/1.0', error: value.error ?? 'unknown' };
        return {
          kind: 'chat-ui/1.0',
          title: typeof args.title === 'string' ? args.title : '',
          ui: value.ui,
        };
      },
    },

    async execute(args) {
      if (args?.title !== undefined && (typeof args.title !== 'string' || args.title.length > MAX_TITLE_CHARS)) {
        return { ok: false, error: `title must be a string of at most ${MAX_TITLE_CHARS} characters` };
      }
      const result = validateUi(args?.ui);
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, ui: result.ui };
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

        const agents = ctx.get('agents');
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
        const agent = sessionId === '' ? agents?.currentInitiator?.() : agents?.get?.(sessionId);
        if (!agent) {
          sendJson(res, 409, { ok: false, error: 'no live agent for this session' });
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
}
