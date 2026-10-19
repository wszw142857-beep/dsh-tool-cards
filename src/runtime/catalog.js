/**
 * 组件目录（catalog）：规范 §1 的 15 类交互 + §1 末尾的展示层组件。
 *
 * json-render 的 catalog 是「模型只能从这里取 type」的白名单，同时给
 * `catalog.prompt()` 生成系统提示。我们把规范的 props 语义压进 zod schema，
 * 让非法 type / 多余字段在编译期就被挡住。
 *
 * @module chat-ui-demo/catalog
 */
import { defineCatalog } from '@json-render/core';
import { schema } from '@json-render/react/schema';
import { z } from 'zod';

/** 选项数组（下拉、单选、分段共用）。 */
const options = z.array(z.object({ label: z.string(), value: z.string() })).min(1).max(60);

/** 数值/文本绑定 prop：数值控件统一用 `value` 承接状态。 */
const bound = z.union([z.string(), z.number(), z.boolean()]).optional();

/** 15 类交互 + 展示层的 catalog 定义。 */
const components = {
  /* ---------------- 01-09 基础输入 / 动作 ---------------- */
  Slider: {
    props: z.object({
      label: z.string(),
      value: z.number().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      step: z.number().optional(),
      unit: z.string().optional(),
      disabled: z.boolean().optional(),
    }),
    description: '滑动条；改值只更新本地状态，不调用模型。',
  },
  Checkbox: {
    props: z.object({
      label: z.string(),
      value: z.boolean().optional(),
      disabled: z.boolean().optional(),
    }),
    description: '复选框，布尔状态。',
  },
  Radio: {
    props: z.object({
      label: z.string().optional(),
      value: z.string().optional(),
      options,
      disabled: z.boolean().optional(),
    }),
    description: '单选组，组内只能选一个。',
  },
  Select: {
    props: z.object({
      label: z.string().optional(),
      value: z.string().optional(),
      options,
      placeholder: z.string().optional(),
      disabled: z.boolean().optional(),
    }),
    description: '下拉选择，默认单选。',
  },
  Segmented: {
    props: z.object({
      label: z.string().optional(),
      value: z.string().optional(),
      options,
      disabled: z.boolean().optional(),
    }),
    description: '分段选择，适合 2~5 个互斥选项。',
  },
  Input: {
    props: z.object({
      label: z.string().optional(),
      value: bound,
      inputType: z.enum(['text', 'number', 'email', 'url']).optional(),
      placeholder: z.string().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      step: z.number().optional(),
      required: z.boolean().optional(),
      disabled: z.boolean().optional(),
    }),
    description: '单行输入。number 时空串不当作 0。',
  },
  Textarea: {
    props: z.object({
      label: z.string().optional(),
      value: z.string().optional(),
      rows: z.number().optional(),
      maxLength: z.number().optional(),
      placeholder: z.string().optional(),
      required: z.boolean().optional(),
      disabled: z.boolean().optional(),
    }),
    description: '多行输入，带最大长度与滚动策略。',
  },
  Date: {
    props: z.object({
      label: z.string().optional(),
      value: z.string().optional(),
      min: z.string().optional(),
      max: z.string().optional(),
      disabled: z.boolean().optional(),
    }),
    description: '日期选择，值为无时区的 YYYY-MM-DD。',
  },
  Button: {
    props: z.object({
      label: z.string(),
      actionId: z.string().optional(),
      disabled: z.boolean().optional(),
      loading: z.boolean().optional(),
      variant: z.enum(['primary', 'secondary', 'ghost']).optional(),
    }),
    description: '按钮；本地动作或宿主动作，提交时防重复点击。',
  },

  /* ---------------- 10-13 交互容器 ---------------- */
  Form: {
    props: z.object({
      label: z.string().optional(),
      submitLabel: z.string().optional(),
      actionId: z.string().optional(),
      disabled: z.boolean().optional(),
    }),
    description: '表单容器：子控件组合、必填校验、提交按钮。',
  },
  Pressable: {
    props: z.object({
      label: z.string().optional(),
      actionId: z.string().optional(),
      disabled: z.boolean().optional(),
    }),
    description: '整块可点击区域，键盘 Enter/Space 可操作。',
  },
  Popover: {
    props: z.object({
      trigger: z.string(),
      placement: z.enum(['top', 'bottom', 'left', 'right']).optional(),
      content: z.string().optional(),
      disabled: z.boolean().optional(),
    }),
    description: '弹出层：点击打开、Escape 关闭、焦点回到触发器。',
  },
  Carousel: {
    props: z.object({
      items: z.array(z.object({ title: z.string(), text: z.string() })).min(1).max(20),
      activeIndex: z.number().optional(),
      loop: z.boolean().optional(),
    }),
    description: '轮播：左右操作 + 键盘导航 + 索引同步。',
  },

  /* ---------------- 14-15 可视化 ---------------- */
  Chart: {
    props: z.object({
      label: z.string().optional(),
      chartType: z.enum(['bar', 'line', 'pie', 'scatter']).optional(),
      data: z.array(z.record(z.string(), z.union([z.string(), z.number()]))).max(200),
      xKey: z.string(),
      series: z.array(z.object({ key: z.string(), label: z.string().optional() })).min(1),
      height: z.number().optional(),
    }),
    description: '图表：柱状/折线/饼图/散点，tooltip 是基本交互。',
  },
  Map: {
    props: z.object({
      label: z.string().optional(),
      markers: z.array(z.object({
        id: z.string(),
        lat: z.number(),
        lng: z.number(),
        label: z.string().optional(),
      })).max(200),
      center: z.object({ lat: z.number(), lng: z.number() }).optional(),
      zoom: z.number().optional(),
      unavailableReason: z.string().optional(),
    }),
    description: '地图点位；无瓦片服务时降级为点位列表。',
  },

  /* ---------------- 展示层 ---------------- */
  Card: {
    props: z.object({ title: z.string().optional(), subtitle: z.string().optional() }),
    description: '卡片容器。',
  },
  Metric: {
    props: z.object({
      label: z.string(),
      value: z.union([z.number(), z.string()]).optional(),
      unit: z.string().optional(),
      precision: z.number().optional(),
      hint: z.string().optional(),
      error: z.string().optional(),
    }),
    description: '指标卡；value 可由表达式计算。',
  },
  Text: {
    props: z.object({ text: z.string(), tone: z.enum(['default', 'muted', 'danger']).optional() }),
    description: '纯文本。',
  },
  Heading: {
    props: z.object({ text: z.string(), level: z.number().optional() }),
    description: '标题。',
  },
  Row: {
    props: z.object({ gap: z.number().optional(), wrap: z.boolean().optional(), align: z.enum(['start', 'center', 'end']).optional() }),
    description: '横排容器。',
  },
  Column: {
    props: z.object({ gap: z.number().optional() }),
    description: '竖排容器。',
  },
  Divider: {
    props: z.object({}),
    description: '分隔线。',
  },
  Badge: {
    props: z.object({ text: z.string(), tone: z.enum(['default', 'success', 'warn', 'danger']).optional() }),
    description: '徽标。',
  },
  Alert: {
    props: z.object({ title: z.string().optional(), text: z.string(), tone: z.enum(['info', 'success', 'warn', 'danger']).optional() }),
    description: '提示条。',
  },
  Table: {
    props: z.object({
      columns: z.array(z.object({ key: z.string(), label: z.string() })).min(1).max(20),
      rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))).max(200),
    }),
    description: '表格，用于不支持控件时的降级展示。',
  },
  KeyValue: {
    props: z.object({
      entries: z.array(z.object({ key: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) })).max(60),
    }),
    description: '参数快照列表（提交前展示）。',
  },
};

/**
 * 动作：模型只能声明「哪一类动作」，具体 operation 由服务端登记。
 * 这里登记的是客户端允许的三种 kind。
 */
const actions = {
  submitToAgent: { description: '把当前参数快照提交给模型继续分析' },
  callTool: { description: '把当前参数快照交给服务端已登记的工具' },
  openUrl: { description: '打开 http(s) 链接' },
};

/** 导出 catalog；`catalog.prompt()` 可直接作为模型系统提示的一部分。 */
export const catalog = defineCatalog(schema, { components, actions });

/** 组件名清单（测试与文档用）。 */
export const CATALOG_COMPONENT_NAMES = Object.keys(components);
