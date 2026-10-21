/**
 * 注册表：catalog 的 type 名 → 已审核的渲染器。
 *
 * 这是规范 §5.1 的 Registry 模式：模型永远不生成组件代码，
 * 只生成 `type` 字符串，命中不到就走兜底提示。
 *
 * 注意 json-render 的调用约定：defineRegistry 把渲染器当普通 React 组件调用，
 * 传进来的是**已解析的扁平对象** `{ props, children, slots, emit, on, bindings,
 * loading }`，没有 `element`。本项目实现统一按 `{ element: {type, props} }`
 * 书写，所以这里做一层包装还原签名（也顺带把 type 补回 element）。
 *
 * @module chat-ui-demo/registry
 */
import { defineRegistry } from '@json-render/react';
import React from 'react';
import { catalog } from './catalog.js';
import {
  Slider,
  Checkbox,
  Radio,
  Select,
  Segmented,
  Input,
  Textarea,
  DateField,
  Button,
} from './components/inputs.js';
import {
  Form,
  Pressable,
  Popover,
  Carousel,
  Card,
  Metric,
  Text,
  Heading,
  Row,
  Column,
  Divider,
  Badge,
  Alert,
  Table,
  KeyValue,
} from './components/containers.js';
import { Chart, MapView } from './components/visuals.js';
import { t, makeUseT } from '../i18n.js';

/** 组件实现表；键必须与 catalog 的组件名逐字一致。 */
export const implementations = {
  Slider,
  Checkbox,
  Radio,
  Select,
  Segmented,
  Input,
  Textarea,
  Date: DateField,
  Button,
  Form,
  Pressable,
  Popover,
  Carousel,
  Chart,
  Map: MapView,
  Card,
  Metric,
  Text,
  Heading,
  Row,
  Column,
  Divider,
  Badge,
  Alert,
  Table,
  KeyValue,
};

/**
 * 把实现包成 json-render 期望的签名。
 * 必须是真正的函数组件（首字母大写 + 返回 React 元素），
 * hooks 才能归属这个包装组件。
 * @param {Function} Component
 * @param {string} type
 */
function adapt(Component, type) {
  return function Adapted({ props, children, slots, emit, on, bindings, loading }) {
    return React.createElement(Component, {
      element: { type, props },
      children,
      slots,
      emit,
      on,
      bindings,
      loading,
    });
  };
}

/** 组件名 → 适配后的渲染器。 */
const components = Object.fromEntries(
  Object.entries(implementations).map(([type, Component]) => [type, adapt(Component, type)]),
);

/** 未收录的 type 统一降级提示，不抛错、不执行任何东西。 */
function Unsupported({ element }) {
  return React.createElement(
    'div',
    { className: 'cui-alert cui-alert-warn', role: 'status' },
    t('notSupported', { type: element?.type ?? '?' }),
  );
}

const defined = defineRegistry(catalog, { components });

export const registry = defined.registry;
export const actions = defined.actions;
export { Unsupported };
