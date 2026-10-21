/**
 * 越权防护的真实行为测试。
 *
 * 用真实 host.js 起插件，捕获它注册的 /chat-ui/action 路由，
 * 然后用手工构造的请求去打：
 *
 *   A. 只带伪造的 sessionId，不带 cardToken  → 必须 403
 *   B. 带无效 cardToken                      → 必须 403
 *   C. 带合法 cardToken（由 execute 签发）    → 必须 200，且消息落到**凭证对应的会话**
 *   D. 合法 cardToken + 伪造 sessionId        → 仍落到凭证对应的会话（sessionId 被忽略）
 */
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const { apply } = await import(new URL('../host.js', import.meta.url));

/* ---------- 搭一个能捕获路由与工具的假 ctx ---------- */

let definition = null;
let routeHandler = null;
/** 按路径保存全部路由（0.2.0 起有 action 与 state 两个）。 */
const routeHandlers = new Map();
const followedUp = []; // 记录哪些会话收到了 followup
const liveAgents = new Map();

/** 造一个假 agent，记录 followup。 */
function makeAgent(id) {
  return {
    id,
    followup(message) {
      followedUp.push({ sessionId: id, message });
    },
  };
}

const ctx = {
  effect: (fn) => {
    const d = fn();
    return () => {
      if (typeof d === 'function') d();
    };
  },
  on: () => () => {},
  get: (name) => {
    if (name === 'webServer') {
      return {
        // 0.2.0 起插件注册两个路由（action + state），必须按路径分别保存，
        // 只留最后一个会让 action 路由被 state 路由覆盖。
        register: (route) => {
          routeHandlers.set(route.path, route.handler);
          if (route.path === '/chat-ui/action') routeHandler = route.handler;
          return () => {};
        },
      };
    }
    if (name === 'agents') {
      return { get: (id) => liveAgents.get(id) };
    }
    if (name === 'connection') {
      // 真实 Host 一定提供同源围栏；插件在缺失时按 503 拒绝（fail-closed）。
      return {
        requestRejection: () => undefined,
      };
    }
    return undefined;
  },
  logger: () => ({ warn() {}, info() {} }),
  tools: {
    register: (def) => {
      definition = def;
      return () => {};
    },
  },
};

apply(ctx, {});
assert.ok(definition, 'tool not registered');
assert.ok(routeHandler, 'action route not registered');

/* ---------- 造请求 / 响应替身 ---------- */

/** 构造一个可被 for await 读取的请求。 */
function makeReq(body, method = 'POST') {
  const text = JSON.stringify(body);
  const buf = Buffer.from(text, 'utf8');
  return {
    method,
    // 0.2.0 起路由要求 application/json；缺这个头会被 415 拦掉。
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield buf;
    },
  };
}

/** 构造一个捕获状态码与响应体的响应。 */
function makeRes() {
  const captured = { status: 0, body: '' };
  return {
    writeHead(status) {
      captured.status = status;
    },
    end(payload) {
      captured.body = payload ?? '';
    },
    get captured() {
      return captured;
    },
  };
}

/** 调一次路由，返回 { status, json }。 */
async function call(body) {
  const res = makeRes();
  await routeHandler(makeReq(body), res);
  let json = null;
  try {
    json = JSON.parse(res.captured.body);
  } catch {
    json = res.captured.body;
  }
  return { status: res.captured.status, json };
}

/* ---------- 准备两个会话 ---------- */

const sessionA = 'session-A';
const sessionB = 'session-B';
liveAgents.set(sessionA, makeAgent(sessionA));
liveAgents.set(sessionB, makeAgent(sessionB));

const ui = {
  schemaVersion: 'chat-ui/1.0',
  initialState: { dose: 2 },
  tree: {
    id: 'root',
    type: 'Card',
    props: {},
    children: [{ id: 'btn', type: 'Button', label: '应用', actionId: 'apply' }],
  },
  actions: { apply: { kind: 'submitToAgent', operation: 'apply-dose', includeKeys: ['dose'] } },
};

// 在会话 A 里执行工具 → 拿到 A 的卡片凭证
const valueA = await definition.execute({ title: 'A 的卡', ui }, { agent: { id: sessionA } });
assert.equal(valueA.ok, true);
assert.equal(typeof valueA.cardToken, 'string', 'execute must issue a cardToken');
const tokenA = valueA.cardToken;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

console.log('\n越权防护行为测试\n');

/* A. 只伪造 sessionId */
{
  followedUp.length = 0;
  const r = await call({ sessionId: sessionB, actionId: 'apply', values: { dose: 9 } });
  check('A. 只带伪造 sessionId → 403', r.status === 403, `status=${r.status} ${JSON.stringify(r.json)}`);
  check('A. 未产生任何 followup', followedUp.length === 0, `count=${followedUp.length}`);
}

/* B. 无效 token */
{
  followedUp.length = 0;
  const r = await call({ cardToken: 'tc_forged', sessionId: sessionB, actionId: 'apply', values: { dose: 9 } });
  check('B. 无效 cardToken → 403', r.status === 403, `status=${r.status} ${JSON.stringify(r.json)}`);
  check('B. 未产生任何 followup', followedUp.length === 0, `count=${followedUp.length}`);
}

/* C. 合法 token */
{
  followedUp.length = 0;
  const r = await call({ cardToken: tokenA, actionId: 'apply', values: { dose: 3.5 } });
  check('C. 合法 cardToken → 200', r.status === 200, `status=${r.status}`);
  check('C. 落到凭证对应的会话', followedUp.length === 1 && followedUp[0].sessionId === sessionA, JSON.stringify(followedUp.map((f) => f.sessionId)));
}

/* D. 合法 token + 伪造 sessionId：sessionId 必须被忽略 */
{
  followedUp.length = 0;
  const r = await call({ cardToken: tokenA, sessionId: sessionB, actionId: 'apply', values: { dose: 1 } });
  check('D. 合法 token + 伪造 sessionId → 200', r.status === 200, `status=${r.status}`);
  check(
    'D. 仍落到凭证会话 A（伪造的 B 被忽略）',
    followedUp.length === 1 && followedUp[0].sessionId === sessionA,
    JSON.stringify(followedUp.map((f) => f.sessionId)),
  );
}

/* E. 拿不到会话时不签发 token（卡片只读） */
{
  const value = await definition.execute({ title: 'no session', ui }, {});
  check('E. 无会话时 execute 不签发 token', typeof value.cardToken === 'undefined' && value.readonly === true, JSON.stringify({ cardToken: value.cardToken, readonly: value.readonly }));
}

/* F. 会话已结束 */
{
  followedUp.length = 0;
  liveAgents.delete(sessionA);
  const r = await call({ cardToken: tokenA, actionId: 'apply', values: { dose: 1 } });
  check('F. 归属会话已释放 → 409', r.status === 409, `status=${r.status} ${JSON.stringify(r.json)}`);
  check('F. 未产生 followup', followedUp.length === 0);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) process.exitCode = 1;
