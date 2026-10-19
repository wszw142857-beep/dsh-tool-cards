/**
 * 消息级校验登记表（规范 §11 T05）。
 *
 * 规范要求：必填为空提交时「逐字段显示错误、不触发远端」。
 *
 * 为什么不用 json-render 自带的 ValidationProvider：
 * 它的字段配置要由每个控件自己注册、提交时要走 validateForm action，
 * 而我们的提交是由 Form/Button 直接触发 handlers 的；并且我们需要
 * 「一次性收集本消息所有必填项、失败时保持错误可见」这一条明确语义。
 *
 * 实现要点：错误放在**独立的 context** 里。如果只让 Provider 自己
 * forceUpdate，React 会因为 children 元素引用没变而 bailout，字段错误不会刷新。
 *
 * @module chat-ui-demo/validation
 */
import React from 'react';

const RegistryContext = React.createContext(null);
const ErrorsContext = React.createContext({});

/**
 * 提供一份消息级校验登记表。
 * @param {{children: React.ReactNode}} props
 */
export function ValidationRegistryProvider({ children }) {
  const fieldsRef = React.useRef(new Map());
  const isEmptyRef = React.useRef(new Map());
  const [errors, setErrors] = React.useState({});

  /** 稳定的 API：登记 / 校验 / 清理。 */
  const api = React.useMemo(
    () => ({
      /**
       * 登记一个必填字段。
       * @param {string} key 状态键
       * @param {() => boolean} isEmpty 当前是否为空
       * @param {string} message 错误文案
       * @returns {() => void} 注销函数
       */
      register(key, isEmpty, message) {
        isEmptyRef.current.set(key, isEmpty);
        fieldsRef.current.set(key, message);
        return () => {
          fieldsRef.current.delete(key);
          isEmptyRef.current.delete(key);
        };
      },
      /**
       * 跑全部必填校验，返回是否通过。
       * @returns {boolean}
       */
      validateAll() {
        const next = {};
        for (const [key, message] of fieldsRef.current) {
          const isEmpty = isEmptyRef.current.get(key);
          if (isEmpty?.()) next[key] = message;
        }
        setErrors(next);
        return Object.keys(next).length === 0;
      },
      /** 清掉所有错误（例如用户开始重新输入时）。 */
      clear() {
        setErrors((previous) => (Object.keys(previous).length === 0 ? previous : {}));
      },
    }),
    [],
  );

  return React.createElement(
    RegistryContext.Provider,
    { value: api },
    React.createElement(ErrorsContext.Provider, { value: errors }, children),
  );
}

/**
 * 读取校验 API；不在 Provider 内时返回 null（组件仍可独立渲染）。
 * @returns {null | {register:Function, validateAll:Function, clear:Function}}
 */
export function useValidationRegistry() {
  return React.useContext(RegistryContext);
}

/**
 * 登记一个必填字段，并返回它当前的错误文案。
 * 未启用必填（key 为空）时不登记。
 * @param {string} key 状态键
 * @param {() => boolean} isEmpty 当前值是否为空
 * @param {string} message 错误文案
 * @returns {string|undefined}
 */
export function useRequiredField(key, isEmpty, message) {
  const registry = useValidationRegistry();
  const errors = React.useContext(ErrorsContext);
  const isEmptyRef = React.useRef(isEmpty);
  isEmptyRef.current = isEmpty;

  React.useEffect(() => {
    if (!registry || !key) return undefined;
    return registry.register(key, () => isEmptyRef.current(), message);
  }, [registry, key, message]);

  return key ? errors[key] : undefined;
}
