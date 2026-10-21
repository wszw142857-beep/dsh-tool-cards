/**
 * 诊断：系统提示段是否在**两种激活顺序**下都能注册成功。
 *
 * 历史缺陷（0.2.0 及之前）：
 *   `ctx.effect(() => { const sp = ctx.get('systemPrompt'); if (!sp) return; ... })`
 *   只在 apply 那一刻读一次。若 systemPrompt 服务晚于插件就绪，
 *   提示段**永久丢失且没有任何报错**——而这段文本正是模型「会不会主动
 *   调用 chat_ui」的主要依据，丢了就等于自动调用能力悄悄失效。
 *
 * 现在改用 `ctx.inject(['systemPrompt'], cb)`：反应式，服务就绪即注册。
 *
 * 本脚本模拟 Cordis 的 inject 语义：服务注册后调用回调，并记录 disposer。
 */
const { apply } = await import(new URL('../host.js', import.meta.url));

/**
 * 造一个带 inject 语义的假 ctx。
 * @param {{systemPromptReady: boolean}} options
 */
function makeCtx({ systemPromptReady }) {
  const state = {
    sections: [],
    routes: [],
    tool: null,
    pendingInjections: [], // [{ names, callback }]
    available: new Map(),
  };

  const systemPromptService = {
    section: (s) => {
      state.sections.push(s);
      return () => {
        state.sections = state.sections.filter((x) => x !== s);
      };
    },
  };

  if (systemPromptReady) state.available.set('systemPrompt', systemPromptService);

  const ctx = {
    effect: (fn) => {
      const d = fn();
      return () => {
        if (typeof d === 'function') d();
      };
    },
    on: () => () => {},
    /**
     * 反应式注入：如果服务已在，立刻回调；
     * 否则挂起，等服务出现时再回调（与 Cordis 的 inject 语义一致）。
     */
    inject: (names, callback) => {
      const ready = names.every((n) => state.available.has(n));
      if (ready) {
        callback(makeOwnerCtx(names));
      } else {
        state.pendingInjections.push({ names, callback });
      }
      return () => {};
    },
    get: (name) => state.available.get(name),
    logger: () => ({ warn() {}, info() {} }),
    tools: { register: (d) => { state.tool = d; return () => {}; } },
  };

  /** inject 回调拿到的 owner ctx。 */
  function makeOwnerCtx(names) {
    return {
      get: (name) => (names.includes(name) ? state.available.get(name) : state.available.get(name)),
      effect: (fn) => {
        const d = fn();
        return () => {
          if (typeof d === 'function') d();
        };
      },
    };
  }

  function provideSystemPrompt() {
    state.available.set('systemPrompt', systemPromptService);
    const still = [];
    for (const item of state.pendingInjections) {
      if (item.names.every((n) => state.available.has(n))) {
        item.callback(makeOwnerCtx(item.names));
      } else {
        still.push(item);
      }
    }
    state.pendingInjections = still;
  }

  // webServer / connection 最小实现
  state.available.set('webServer', {
    register: (r) => {
      state.routes.push(r.path);
      return () => {};
    },
  });
  state.available.set('connection', { requestRejection: () => undefined });
  state.available.set('agents', { get: () => undefined });

  return { ctx, state, provideSystemPrompt };
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

console.log('\n系统提示段注册诊断\n');

console.log('A. systemPrompt 在插件激活前就绪');
{
  const { ctx, state } = makeCtx({ systemPromptReady: true });
  apply(ctx, {});
  check('注册了 1 个提示段', state.sections.length === 1, `got ${state.sections.length}`);
  check('段名是 chat-ui:cards', state.sections[0]?.name === 'chat-ui:cards', state.sections[0]?.name);
  check('order = 620', state.sections[0]?.order === 620, String(state.sections[0]?.order));
  check('文本非空且提到 chat_ui', (state.sections[0]?.text ?? '').includes('chat_ui'));
}

console.log('\nB. systemPrompt 在插件激活**之后**才就绪（旧的失败路径）');
{
  const { ctx, state, provideSystemPrompt } = makeCtx({ systemPromptReady: false });
  apply(ctx, {});
  check('激活瞬间还没注册（合理）', state.sections.length === 0, `got ${state.sections.length}`);

  provideSystemPrompt();
  check('服务就绪后自动注册', state.sections.length === 1, `got ${state.sections.length}`);
  check('不再是永久丢失', state.sections.length === 1 && state.sections[0].name === 'chat-ui:cards');
}

console.log('\nC. 提示段丢了会怎样（对照说明）');
{
  console.log('  无提示段时，模型只靠工具名 + 工具 description 判断是否调用；');
  console.log('  有提示段时，等于在每个请求的系统提示里再强调一遍触发条件。');
  console.log('  两者叠加才是「自动调用」的实际强度来源。');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) process.exitCode = 1;
