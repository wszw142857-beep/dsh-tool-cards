/**
 * 4 类交互容器（规范 §1 的 10–13）+ 展示层组件。
 *
 * @module chat-ui-demo/components/containers
 */
import React from 'react';
import { useBoundProp } from '@json-render/react';
import { ChevronLeft, ChevronRight, ChevronDown, Close, Check, Alert as AlertIcon, Info } from './icons.js';

const h = React.createElement;

/** 10 表单：子控件组合 + 必填校验 + 提交按钮；校验不过不触发远端。 */
export function Form({ element, children, emit, on }) {
  const p = element.props ?? {};
  const [error, setError] = React.useState(null);
  const handler = on ? on('click') : { bound: false };

  const submit = async (event) => {
    event.preventDefault();
    if (p.disabled === true) return;
    if (handler.bound === false) {
      setError('该表单未绑定提交动作');
      return;
    }
    setError(null);
    await emit('click');
  };

  return h(
    'form',
    { className: 'cui-form', onSubmit: submit, noValidate: true },
    p.label ? h('div', { className: 'cui-form-title' }, p.label) : null,
    children,
    error ? h('div', { className: 'cui-error', role: 'alert' }, error) : null,
    h(
      'div',
      { className: 'cui-form-actions' },
      h(
        'button',
        {
          type: 'submit',
          className: 'cui-button cui-button-primary',
          disabled: p.disabled === true,
        },
        p.submitLabel ?? '提交',
      ),
    ),
  );
}

/** 11 可点击区域：整块可点，Enter/Space 同样有效。 */
export function Pressable({ element, children, emit, on }) {
  const p = element.props ?? {};
  const handler = on ? on('click') : { bound: false };
  const activate = () => {
    if (p.disabled === true || handler.bound === false) return;
    void emit('click');
  };
  return h(
    'div',
    {
      className: 'cui-pressable',
      role: 'button',
      tabIndex: p.disabled === true ? -1 : 0,
      'aria-disabled': p.disabled === true,
      'aria-label': p.label,
      onClick: activate,
      onKeyDown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate();
        }
      },
    },
    children,
  );
}

/** 12 弹出层：点击打开、Escape 关闭、焦点回到触发器。 */
export function Popover({ element, children }) {
  const p = element.props ?? {};
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef(null);

  const close = React.useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  React.useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  return h(
    'div',
    { className: 'cui-popover-wrap' },
    h(
      'button',
      {
        type: 'button',
        ref: triggerRef,
        className: 'cui-button cui-button-secondary cui-popover-trigger',
        'aria-expanded': open,
        'aria-haspopup': 'dialog',
        disabled: p.disabled === true,
        onClick: () => setOpen((previous) => !previous),
      },
      h('span', null, p.trigger),
      h(ChevronDown, { size: 14 }),
    ),
    open
      ? h(
          'div',
          {
            className: `cui-popover cui-popover-${p.placement ?? 'bottom'}`,
            role: 'dialog',
            'aria-label': p.trigger,
          },
          p.content ? h('p', { className: 'cui-popover-text' }, p.content) : null,
          children,
          h(
            'button',
            { type: 'button', className: 'cui-icon-button cui-popover-close', 'aria-label': '关闭', onClick: close },
            h(Close, { size: 14 }),
          ),
        )
      : null,
  );
}

/** 13 轮播：左右操作 + 键盘导航 + 索引与状态同步。 */
export function Carousel({ element, bindings }) {
  const p = element.props ?? {};
  const items = p.items ?? [];
  const [rawIndex, setIndex] = useBoundProp(Number(p.activeIndex ?? 0), bindings?.value);
  const index = Math.min(Math.max(Number(rawIndex ?? 0) || 0, 0), items.length - 1);
  const current = items[index];

  const move = (delta) => {
    const count = items.length;
    if (count === 0) return;
    const next = p.loop === false ? Math.min(Math.max(index + delta, 0), count - 1) : (index + delta + count) % count;
    setIndex(next);
  };

  return h(
    'div',
    {
      className: 'cui-carousel',
      tabIndex: 0,
      role: 'group',
      'aria-roledescription': '轮播',
      'aria-label': p.items?.[0]?.title ?? '轮播',
      onKeyDown: (event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          move(-1);
        }
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          move(1);
        }
      },
    },
    h(
      'div',
      { className: 'cui-carousel-head' },
      h(
        'button',
        {
          type: 'button',
          className: 'cui-icon-button',
          'aria-label': '上一项',
          disabled: p.loop === false && index === 0,
          onClick: () => move(-1),
        },
        h(ChevronLeft),
      ),
      h('span', { className: 'cui-hint cui-carousel-counter' }, `${index + 1} / ${items.length}`),
      h(
        'button',
        {
          type: 'button',
          className: 'cui-icon-button',
          'aria-label': '下一项',
          disabled: p.loop === false && index === items.length - 1,
          onClick: () => move(1),
        },
        h(ChevronRight),
      ),
    ),
    current
      ? h(
          'div',
          { className: 'cui-carousel-body' },
          h('div', { className: 'cui-carousel-title' }, current.title),
          h('p', { className: 'cui-carousel-text' }, current.text),
        )
      : null,
    h(
      'div',
      { className: 'cui-carousel-dots', role: 'tablist', 'aria-label': '切换条目' },
      items.map((item, i) =>
        h('button', {
          type: 'button',
          key: item.title,
          className: 'cui-carousel-dot',
          'aria-label': item.title,
          'aria-current': i === index ? 'true' : undefined,
          onClick: () => setIndex(i),
        }),
      ),
    ),
  );
}

/* ------------------------------- 展示层 ------------------------------- */

export function Card({ element, children }) {
  const p = element.props ?? {};
  return h(
    'section',
    { className: 'cui-card' },
    p.title ? h('h3', { className: 'cui-card-title' }, p.title) : null,
    p.subtitle ? h('div', { className: 'cui-hint' }, p.subtitle) : null,
    children,
  );
}

/** 指标卡：value 已由表达式求值；NaN/Infinity 收敛成可展示错误。 */
export function Metric({ element }) {
  const p = element.props ?? {};
  const raw = p.value;
  const number = typeof raw === 'number' ? raw : Number(raw);
  const usable = typeof raw !== 'undefined' && Number.isFinite(number);
  const precision = Number.isFinite(Number(p.precision)) ? Number(p.precision) : undefined;
  const display = usable
    ? precision !== undefined
      ? number.toFixed(precision)
      : String(Math.round(number * 1e6) / 1e6)
    : '—';
  const error = usable ? p.error : p.error ?? '计算结果不可用（除零或非数字）';

  return h(
    'div',
    { className: `cui-metric${usable ? '' : ' cui-metric-error'}` },
    h('div', { className: 'cui-metric-label' }, p.label),
    h(
      'div',
      { className: 'cui-metric-value' },
      display,
      p.unit ? h('span', { className: 'cui-metric-unit' }, ` ${p.unit}`) : null,
    ),
    error ? h('div', { className: 'cui-error', role: 'status' }, error) : null,
    p.hint ? h('div', { className: 'cui-hint' }, p.hint) : null,
  );
}

export function Text({ element }) {
  const p = element.props ?? {};
  return h('p', { className: `cui-text cui-text-${p.tone ?? 'default'}` }, p.text);
}

export function Heading({ element }) {
  const p = element.props ?? {};
  const level = Math.min(Math.max(Number(p.level ?? 3), 1), 6);
  return h(`h${level}`, { className: 'cui-heading' }, p.text);
}

export function Row({ element, children }) {
  const p = element.props ?? {};
  return h(
    'div',
    {
      className: 'cui-row',
      style: {
        gap: p.gap ?? 12,
        flexWrap: p.wrap === false ? 'nowrap' : 'wrap',
        alignItems: p.align ?? 'start',
      },
    },
    children,
  );
}

export function Column({ element, children }) {
  const p = element.props ?? {};
  return h('div', { className: 'cui-column', style: { gap: p.gap ?? 12 } }, children);
}

export function Divider() {
  return h('hr', { className: 'cui-divider' });
}

export function Badge({ element }) {
  const p = element.props ?? {};
  const tone = p.tone ?? 'default';
  const glyph =
    tone === 'success' ? h(Check, { size: 12 }) : tone === 'warn' || tone === 'danger' ? h(AlertIcon, { size: 12 }) : null;
  return h('span', { className: `cui-badge cui-badge-${tone}` }, glyph, h('span', null, p.text));
}

export function Alert({ element }) {
  const p = element.props ?? {};
  const tone = p.tone ?? 'info';
  const glyph =
    tone === 'success' ? h(Check, { size: 14 }) : tone === 'warn' || tone === 'danger' ? h(AlertIcon, { size: 14 }) : h(Info, { size: 14 });
  return h(
    'div',
    { className: `cui-alert cui-alert-${tone}`, role: 'status' },
    h('span', { className: 'cui-alert-icon' }, glyph),
    h(
      'div',
      { className: 'cui-alert-body' },
      p.title ? h('strong', null, p.title) : null,
      h('span', null, p.text),
    ),
  );
}

export function Table({ element }) {
  const p = element.props ?? {};
  const columns = p.columns ?? [];
  const rows = p.rows ?? [];
  if (columns.length === 0) return h(Alert, { element: { props: { text: '表格缺少列定义', tone: 'warn' } } });
  return h(
    'div',
    { className: 'cui-table-wrap' },
    h(
      'table',
      { className: 'cui-table' },
      h('thead', null, h('tr', null, columns.map((column) => h('th', { key: column.key }, column.label)))),
      h(
        'tbody',
        null,
        rows.map((row, index) =>
          h(
            'tr',
            { key: index },
            columns.map((column) =>
              h('td', { key: column.key }, row[column.key] === null ? '—' : String(row[column.key] ?? '')),
            ),
          ),
        ),
      ),
    ),
  );
}

/** 参数快照：提交前让用户看到「将要发出去的东西」。 */
export function KeyValue({ element }) {
  const p = element.props ?? {};
  return h(
    'dl',
    { className: 'cui-kv' },
    (p.entries ?? []).map((entry) =>
      h('div', { className: 'cui-kv-row', key: entry.key }, h('dt', null, entry.key), h('dd', null, String(entry.value))),
    ),
  );
}
