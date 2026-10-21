/**
 * 卡片内的界面文案。
 *
 * 为什么不能只靠 locale/*.json：那两份文件只喂插件管理器的标题/描述，
 * 卡片内部的「提交」「关闭」「最多 N 字」等文案是渲染时用的，
 * 必须由客户端自己按当前语言取。
 *
 * 策略：
 *   - 随 bundle 内置 zh / en 两套词典，不额外发请求。
 *   - 启动时用 `ctx.locale` 的当前值选语言；locale 服务不可用时回落中文。
 *   - 订阅 locale 变化，切换语言后卡片文案立即跟着变。
 *
 * 只覆盖**界面骨架文案**（按钮、占位、错误）。业务文案（标题、字段名）
 * 由模型生成，本来就该跟随对话语言，不做翻译。
 *
 * @module dsh-tool-cards/i18n
 */

/** 词典。键是两个语言共有的稳定标识。 */
const DICT = {
  zh: {
    submit: '提交',
    close: '关闭',
    retry: '重试渲染',
    cardFailedTitle: '这张卡片没能渲染',
    cardFailedHint: '卡片内容可能不完整。可以让模型重新生成一次。',
    cardFailedDetails: '查看详情',
    preview: '上一项',
    next: '下一项',
    carouselOf: '{index} / {total}',
    maxChars: '最多 {n} 字',
    unit: '单位 {unit}',
    noData: '暂无数据',
    chartNoSeries: '图表缺少 series 定义',
    tableNoColumns: '表格缺少列定义',
    mapNoPoints: '暂无点位数据',
    mapNoCoords: '坐标缺失，已降级为点位列表',
    mapDisclaimer: '未接入瓦片服务：坐标仅做等距投影示意，不用于路线或距离计算。',
    notSupported: '暂不支持该控件：{type}',
    unsupportedTitle: '暂不支持该控件',
    requiredField: '{label}不能为空',
    actionFailed: '该按钮未绑定动作（{action}）',
    actionUnbound: '该按钮未绑定动作',
    noToken: '这张卡片没有可用的提交凭证，请重新生成',
    submitBlocked: '请先补全标红的必填项',
    unknownAction: '未登记的动作：{action}',
    errorState: '计算结果不可用（除零或非数字）',
  },
  en: {
    submit: 'Submit',
    close: 'Close',
    retry: 'Retry',
    cardFailedTitle: 'This card could not be rendered',
    cardFailedHint: 'The card content may be incomplete. You can ask the model to regenerate it.',
    cardFailedDetails: 'Details',
    preview: 'Previous',
    next: 'Next',
    carouselOf: '{index} / {total}',
    maxChars: 'Up to {n} characters',
    unit: 'Unit: {unit}',
    noData: 'No data',
    chartNoSeries: 'Chart is missing a series definition',
    tableNoColumns: 'Table is missing column definitions',
    mapNoPoints: 'No markers',
    mapNoCoords: 'Coordinates missing — showing the marker list instead',
    mapDisclaimer: 'No tile service: coordinates are projected for illustration only, not for routing or distance.',
    notSupported: 'Unsupported component: {type}',
    unsupportedTitle: 'Unsupported component',
    requiredField: '{label} is required',
    actionFailed: 'This button has no bound action ({action})',
    actionUnbound: 'This button has no bound action',
    noToken: 'This card has no submit credential; regenerate it',
    submitBlocked: 'Fill in the highlighted required fields first',
    unknownAction: 'Unregistered action: {action}',
    errorState: 'Result unavailable (division by zero or non-numeric)',
  },
};

/** 规范化语言标签：`zh-CN` → `zh`，其余未知一律 `en`。 */
function normalize(tag) {
  const value = String(tag ?? '').toLowerCase();
  if (value.startsWith('zh')) return 'zh';
  if (value === '') return 'zh';
  return 'en';
}

/** 当前语言（模块级：整个卡片层共享一个语言）。 */
let current = 'zh';

/** 订阅者，便于语言切换时通知卡片重渲染。 */
const listeners = new Set();

/**
 * 取一条文案并填入占位符。
 * @param {keyof typeof DICT.zh} key
 * @param {Record<string, string|number>} [params]
 * @returns {string}
 */
export function t(key, params) {
  const table = DICT[current] ?? DICT.zh;
  let text = table[key] ?? DICT.zh[key] ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

/**
 * 当前语言码。
 * @returns {'zh'|'en'}
 */
export function lang() {
  return current;
}

/**
 * 订阅语言变化。
 * @param {() => void} listener
 * @returns {() => void}
 */
export function subscribeLang(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 按 locale 快照更新语言；值没变时不动。
 * @param {unknown} snapshot `ctx.locale.getSnapshot()` 的返回值
 */
export function syncLang(snapshot) {
  const next = normalize(snapshot?.active);
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

/**
 * 读一次 locale 快照并同步。
 * @param {{getSnapshot?: Function}} locale
 */
export function syncFromLocale(locale) {
  if (typeof locale?.getSnapshot === 'function') syncLang(locale.getSnapshot());
}

/** 供测试使用的词典大小。 */
export const LOCALE_KEYS = Object.keys(DICT.zh);

/**
 * 订阅语言变化的 React 钩子，返回随语言更新的翻译函数。
 *
 * 为什么每个用文案的组件都要调：`t()` 是模块级纯函数，
 * 语言变了但组件没重渲染，界面不会更新。
 * 组件是 `React.memo` 的，父组件重渲染不一定能透传下去，
 * 所以由**实际渲染文案的组件**自己订阅。
 *
 * @param {{useState:Function, useEffect:Function}} React
 * @returns {(key: string, params?: Record<string, string|number>) => string}
 */
export function makeUseT(React) {
  return function useT() {
    const [, force] = React.useState(0);
    React.useEffect(() => subscribeLang(() => force((n) => n + 1)), []);
    return t;
  };
}
