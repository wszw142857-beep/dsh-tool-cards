/**
 * 一处性的内联 SVG 图标集。
 *
 * 为什么自带：DSH 插件不允许 require 宿主的 ui-primitives，而字符箭头
 * （‹ › × ▸）在不同字体下大小、基线、粗细都不一致，看起来像错字。
 * 这里统一 16×16、`currentColor`、1.6 描边，随主题色走。
 *
 * @module chat-ui-demo/components/icons
 */
import React from 'react';

const h = React.createElement;

/**
 * 图标底座。
 * @param {{children: React.ReactNode, size?: number, className?: string}} props
 */
function Icon({ children, size = 16, className }) {
  return h(
    'svg',
    {
      viewBox: '0 0 16 16',
      width: size,
      height: size,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      focusable: false,
      className,
      style: { display: 'block', flex: 'none' },
    },
    children,
  );
}

/** 左箭头。 */
export function ChevronLeft({ size }) {
  return h(Icon, { size }, h('path', { d: 'M10 3.5 5.5 8 10 12.5' }));
}

/** 右箭头。 */
export function ChevronRight({ size }) {
  return h(Icon, { size }, h('path', { d: 'M6 3.5 10.5 8 6 12.5' }));
}

/** 关闭。 */
export function Close({ size }) {
  return h(Icon, { size }, h('path', { d: 'M4.5 4.5l7 7M11.5 4.5l-7 7' }));
}

/** 展开（向下）。 */
export function ChevronDown({ size }) {
  return h(Icon, { size }, h('path', { d: 'M3.5 6 8 10.5 12.5 6' }));
}

/** 勾。 */
export function Check({ size }) {
  return h(Icon, { size }, h('path', { d: 'M3.5 8.5 6.5 11.5 12.5 4.5' }));
}

/** 警告三角。 */
export function Alert({ size }) {
  return h(
    Icon,
    { size },
    h('path', { d: 'M8 2.5 14.5 13.5h-13L8 2.5Z' }),
    h('path', { d: 'M8 6.5v3.2M8 11.6v.6' }),
  );
}

/** 提示圆。 */
export function Info({ size }) {
  return h(
    Icon,
    { size },
    h('circle', { cx: 8, cy: 8, r: 6 }),
    h('path', { d: 'M8 7.2v4M8 5.1v.7' }),
  );
}

/** 装载态圆环（旋转由 CSS 控制）。 */
export function Spinner({ size = 12 }) {
  return h(
    'svg',
    {
      viewBox: '0 0 16 16',
      width: size,
      height: size,
      'aria-hidden': true,
      focusable: false,
      className: 'cui-spinner-svg',
      style: { display: 'block', flex: 'none' },
    },
    h('circle', { cx: 8, cy: 8, r: 6, stroke: 'currentColor', strokeWidth: 2, opacity: 0.25, fill: 'none' }),
    h('path', {
      d: 'M14 8a6 6 0 0 0-6-6',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      fill: 'none',
    }),
  );
}
