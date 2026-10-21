/**
 * 组件用的状态绑定适配层。
 *
 * 为什么不能直接用 `@json-render/react` 的 `useBoundProp`：
 * 渲染层在**调用组件之前**已经把 `$bindState` 解析成当前值
 * （`resolveElementProps`），所以组件拿到的 `props.value` 是快照。
 * `useBoundProp` 内部再走 `StateProvider` 的 `set`，在传入外部 store
 * 的 controlled 模式下不会回调 `onStateChange`——实测拖滑动条时
 * `onStatePersist` 永不触发，值也写不回去。
 *
 * 因此这里自己实现：直接用 store + bindings 里的 JSON Pointer 读写。
 * 组件拿到的 `bindings.value` 形如 `/dose`，就是状态路径。
 *
 * @module dsh-tool-cards/use-bound-prop
 */
import React from 'react';
import { useStateStore } from '@json-render/react';

/**
 * 双向绑定一个状态键。
 *
 * @param {unknown} propValue 渲染层已解析出的当前值（用作初值/回落）
 * @param {string|undefined} bindingPath `bindings.value`，形如 `/dose`
 * @returns {[unknown, (next:unknown)=>void]}
 */
export function useBoundProp(propValue, bindingPath) {
  // json-render 的 StateProvider 一定提供了 get/set/getSnapshot；
  // 它内部持有的正是我们传进 JSONUIProvider 的那个 store。
  const { getSnapshot, set } = useStateStore();

  const subscribe = React.useCallback((listener) => {
    // StateProvider 用 useSyncExternalStore 订阅自身，这里复用它暴露的
    // 读取能力：没有独立 subscribe 时，退化为跟随父组件重渲染。
    return typeof listener === 'function' ? () => {} : () => {};
  }, []);

  const read = React.useCallback(() => {
    if (typeof bindingPath !== 'string' || bindingPath === '') return propValue;
    const segments = bindingPath.split('/').filter(Boolean);
    let current = getSnapshot();
    for (const segment of segments) {
      if (current === null || current === undefined) return propValue;
      current = current[segment];
    }
    return current === undefined ? propValue : current;
  }, [bindingPath, propValue, getSnapshot]);

  const value = read();

  const setValue = React.useCallback(
    (next) => {
      if (typeof bindingPath !== 'string' || bindingPath === '') return;
      set(bindingPath, next);
    },
    [bindingPath, set],
  );

  return [value, setValue];
}
