/**
 * 卡片状态的持久化。
 *
 * 为什么需要：卡片被提升为「最终输出」的 Chat 节点，会随会话切换、
 * 历史回看、组件重挂载而重新渲染。没有持久化时，用户拖好的滑动条、
 * 选中的工艺会在重挂载瞬间回到初始值——这是用户能直接感知的缺陷。
 *
 * 两层策略（从弱到强，自动降级）：
 *
 *   1. **宿主内存**（首选）：POST /chat-ui/state → 宿主按 cardToken 存进
 *      进程内 Map。同一会话内切走再回来、节点重挂载都能恢复。
 *      为什么不落盘到会话日志：卡片状态属于「交互过程」而非「对话事实」，
 *      写进日志会让每拖一次滑动条就产生一条记录，污染上下文。
 *   2. **localStorage**（降级）：宿主不可达（离线、路由未注册）时用本地存储，
 *      按 cardToken 分键。刷新页面后仍能恢复。
 *
 * 写操作做节流：拖动会产生大量变更事件，只保留最后一次，
 * 且只在值真正变化时写。
 *
 * @module dsh-tool-cards/state-store
 */

/** 状态上报路径。 */
export const STATE_PATH = '/chat-ui/state';

/** 每次写入的防抖间隔（ms）。拖动时高频触发，合并成一次。 */
const WRITE_DEBOUNCE_MS = 400;

/** localStorage 的键前缀。 */
const LS_PREFIX = 'dsh-tool-cards:state:';

/**
 * 造一个按卡片 id 分区的状态存储。
 *
 * @param {{cardToken?: string, fetchImpl?: typeof fetch}} options
 * @returns {{
 *   read: () => Promise<Record<string, unknown> | null>,
 *   write: (state: Record<string, unknown>) => void,
 *   flush: () => Promise<void>,
 *   dispose: () => void,
 * }}
 */
export function createCardStateStore({ cardToken, fetchImpl } = {}) {
  const doFetch = fetchImpl ?? ((...args) => fetch(...args));

  /** 最近一次待写状态；null 表示没有待写。 */
  let pending = null;
  let timer = null;
  let inFlight = null;
  let disposed = false;

  /**
   * 真正发出写入。
   * @param {Record<string, unknown>} state
   */
  async function send(state) {
    if (!cardToken) return;

    // 先尝试宿主：它能在整个会话生命周期里保留状态。
    try {
      const response = await doFetch(STATE_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cardToken, state }),
      });
      if (response.ok) return;
    } catch {
      // 宿主不可达，落到 localStorage
    }

    try {
      localStorage.setItem(`${LS_PREFIX}${cardToken}`, JSON.stringify(state));
    } catch {
      // 隐私模式 / 配额满：静默放弃，不影响交互
    }
  }

  /** 把待写状态合并成一次写入。 */
  async function pump() {
    timer = null;
    if (disposed || pending === null) return;
    const state = pending;
    pending = null;
    inFlight = send(state);
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
  }

  return {
    /**
     * 读回上次的状态。
     * @returns {Promise<Record<string, unknown> | null>}
     */
    async read() {
      if (!cardToken) return null;

      try {
        const response = await doFetch(
          `${STATE_PATH}?cardToken=${encodeURIComponent(cardToken)}`,
          { method: 'GET', credentials: 'same-origin' },
        );
        if (response.ok) {
          const body = await response.json();
          if (body && typeof body.state === 'object' && body.state !== null) return body.state;
          if (body && body.state === null) return null;
        }
      } catch {
        // 落到 localStorage
      }

      try {
        const raw = localStorage.getItem(`${LS_PREFIX}${cardToken}`);
        if (raw !== null) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') return parsed;
        }
      } catch {
        // 忽略
      }
      return null;
    },

    /**
     * 记下一次状态变更（防抖后写入）。
     * @param {Record<string, unknown>} state
     */
    write(state) {
      if (disposed || !cardToken) return;
      pending = state;
      if (timer !== null) return;
      timer = setTimeout(() => {
        void pump();
      }, WRITE_DEBOUNCE_MS);
    },

    /** 立即把待写状态刷出去（卸载前调用）。 */
    async flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight) await inFlight;
      await pump();
    },

    /** 组件卸载：清计时器，尽力刷一次。 */
    dispose() {
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      // 卸载时同步刷不了就放弃：下次挂载会重新读，不影响正确性。
      if (pending !== null) void send(pending);
      pending = null;
    },
  };
}
