/**
 * 9 类基础输入/动作控件（规范 §1 的 01–09）。
 *
 * 组件契约来自 json-render 的 CatalogComponentBoundary：
 *   已解析的 element.props、children、bindings（$bindState 的写回路径）、emit。
 * 状态写回统一走 useBoundProp(element.props.value, bindings?.value)，
 * 因此每条消息各自一份 StateProvider，天然互不串值。
 *
 * @module chat-ui-demo/components/inputs
 */
import React from 'react';
import { useBoundProp } from '../use-bound-prop.js';
import { useRequiredField } from '../validation.js';
import { Spinner } from './icons.js';
import { t, makeUseT } from '../../i18n.js';

const h = React.createElement;
/** 语言变化时自动重渲染的翻译函数。 */
const useT = makeUseT(React);

/** 控件外壳：label + 控件 + 单位/提示。 */
export function Field({ label, hint, error, htmlFor, children }) {
  return h(
    'div',
    { className: 'cui-field' },
    label
      ? h(
          'div',
          { className: 'cui-field-head' },
          h('label', { className: 'cui-label', htmlFor }, label),
          hint ? h('span', { className: 'cui-hint' }, hint) : null,
        )
      : null,
    children,
    error ? h('div', { className: 'cui-error', role: 'alert' }, error) : null,
  );
}

/** 01 滑动条：吸附步长，同时给出精确数字输入途径。 */
export function Slider({ element, bindings }) {
  const p = element.props ?? {};
  const min = Number(p.min ?? 0);
  const max = Number(p.max ?? 100);
  const step = Number(p.step ?? 1);
  const [value, setValue] = useBoundProp(p.value ?? min, bindings?.value);
  const id = `cui-${element.props?._key ?? element.type}-${p.label}`;
  const current = Number(value ?? min);
  const disabled = p.disabled === true;

  return h(
    Field,
    { label: p.label, hint: p.unit ? t('unit', { unit: p.unit }) : undefined, htmlFor: id },
    h(
      'div',
      { className: 'cui-slider' },
      h('input', {
        id,
        type: 'range',
        min,
        max,
        step,
        value: Number.isFinite(current) ? current : min,
        disabled,
        'aria-label': p.label,
        onChange: (event) => setValue(Number(event.target.value)),
      }),
      h('input', {
        type: 'number',
        className: 'cui-slider-number',
        min,
        max,
        step,
        value: Number.isFinite(current) ? current : min,
        disabled,
        'aria-label': `${p.label} — ${t('submit')}`,
        onChange: (event) => {
          const raw = event.target.value;
          if (raw === '') return;
          const next = Number(raw);
          if (Number.isFinite(next)) setValue(Math.min(max, Math.max(min, next)));
        },
      }),
    ),
  );
}

/** 02 复选框。 */
export function Checkbox({ element, bindings }) {
  const p = element.props ?? {};
  const [value, setValue] = useBoundProp(Boolean(p.value), bindings?.value);
  const id = `cui-check-${p.label}`;
  return h(
    'div',
    { className: 'cui-field' },
    h(
      'label',
      { className: 'cui-inline', htmlFor: id },
      h('input', {
        id,
        type: 'checkbox',
        checked: Boolean(value),
        disabled: p.disabled === true,
        onChange: (event) => setValue(event.target.checked),
      }),
      h('span', null, p.label),
    ),
  );
}

/** 03 单选组：组内互斥。 */
export function Radio({ element, bindings }) {
  const p = element.props ?? {};
  const [value, setValue] = useBoundProp(p.value, bindings?.value);
  const name = `cui-radio-${p.label ?? element.type}`;
  return h(
    Field,
    { label: p.label },
    h(
      'div',
      { className: 'cui-radio-group', role: 'radiogroup', 'aria-label': p.label },
      (p.options ?? []).map((option) =>
        h(
          'label',
          { className: 'cui-inline', key: option.value },
          h('input', {
            type: 'radio',
            name,
            value: option.value,
            checked: value === option.value,
            disabled: p.disabled === true,
            onChange: () => setValue(option.value),
          }),
          h('span', null, option.label),
        ),
      ),
    ),
  );
}

/** 04 下拉选择。 */
export function Select({ element, bindings }) {
  const p = element.props ?? {};
  const [value, setValue] = useBoundProp(p.value ?? '', bindings?.value);
  return h(
    Field,
    { label: p.label },
    h(
      'select',
      {
        className: 'cui-control',
        value: value ?? '',
        disabled: p.disabled === true,
        'aria-label': p.label,
        onChange: (event) => setValue(event.target.value),
      },
      p.placeholder ? h('option', { value: '' }, p.placeholder) : null,
      (p.options ?? []).map((option) =>
        h('option', { key: option.value, value: option.value }, option.label),
      ),
    ),
  );
}

/** 05 分段选择：2~5 选项；超过 5 个自动降级为 Select。 */
export function Segmented({ element, bindings }) {
  const p = element.props ?? {};
  const [value, setValue] = useBoundProp(p.value, bindings?.value);
  const options = p.options ?? [];
  if (options.length > 5) {
    return h(Select, { element, bindings });
  }
  return h(
    Field,
    { label: p.label },
    h(
      'div',
      { className: 'cui-segmented', role: 'group', 'aria-label': p.label },
      options.map((option) =>
        h(
          'button',
          {
            type: 'button',
            key: option.value,
            className: 'cui-segment',
            'aria-pressed': value === option.value,
            disabled: p.disabled === true,
            onClick: () => setValue(option.value),
          },
          option.label,
        ),
      ),
    ),
  );
}

/** 06 单行输入：number 时空串保持空，绝不偷偷变成 0。 */
export function Input({ element, bindings }) {
  const p = element.props ?? {};
  const inputType = p.inputType ?? 'text';
  const [value, setValue] = useBoundProp(p.value, bindings?.value);
  const [draft, setDraft] = React.useState(value === undefined ? '' : String(value));

  React.useEffect(() => {
    setDraft(value === undefined || value === null ? '' : String(value));
  }, [value]);

  const commit = (raw) => {
    setDraft(raw);
    if (inputType !== 'number') {
      setValue(raw);
      return;
    }
    if (raw.trim() === '') return; // 保持空，不回写 0
    const next = Number(raw);
    if (!Number.isFinite(next)) return;
    const clamped = Math.min(p.max ?? Number.POSITIVE_INFINITY, Math.max(p.min ?? Number.NEGATIVE_INFINITY, next));
    setValue(clamped);
  };

  // 规范 T05：required 的字段在提交时逐字段报错。
  const boundKey = bindings?.value?.replace(/^\//, '') ?? '';
  const requiredError = useRequiredField(
    p.required === true ? boundKey : '',
    () => String(value ?? '').trim() === '',
    t('requiredField', { label: p.label ?? '' }),
  );

  return h(
    Field,
    { label: p.label, error: requiredError },
    h('input', {
      className: `cui-control${requiredError ? ' cui-invalid' : ''}`,
      type: inputType,
      value: draft,
      placeholder: p.placeholder,
      min: p.min,
      max: p.max,
      step: p.step,
      required: p.required === true,
      disabled: p.disabled === true,
      'aria-label': p.label,
      'aria-invalid': requiredError ? 'true' : undefined,
      onChange: (event) => commit(event.target.value),
      onBlur: () => {
        if (inputType === 'number' && draft.trim() === '') setDraft('');
      },
    }),
  );
}

/** 07 多行输入：maxLength + 固定行数，避免无限拉高气泡。 */
export function Textarea({ element, bindings }) {
  const p = element.props ?? {};
  const [value, setValue] = useBoundProp(p.value ?? '', bindings?.value);
  const boundKey = bindings?.value?.replace(/^\//, '') ?? '';
  const requiredError = useRequiredField(
    p.required === true ? boundKey : '',
    () => String(value ?? '').trim() === '',
    t('requiredField', { label: p.label ?? '' }),
  );
  return h(
    Field,
    { label: p.label, hint: p.maxLength ? t('maxChars', { n: p.maxLength }) : undefined, error: requiredError },
    h('textarea', {
      className: `cui-control cui-textarea${requiredError ? ' cui-invalid' : ''}`,
      rows: p.rows ?? 3,
      maxLength: p.maxLength,
      placeholder: p.placeholder,
      value: value ?? '',
      required: p.required === true,
      disabled: p.disabled === true,
      'aria-label': p.label,
      'aria-invalid': requiredError ? 'true' : undefined,
      onChange: (event) => setValue(event.target.value),
    }),
  );
}

/** 08 日期选择：值是无时区的 YYYY-MM-DD。 */
export function DateField({ element, bindings }) {
  const p = element.props ?? {};
  const [value, setValue] = useBoundProp(p.value ?? '', bindings?.value);
  return h(
    Field,
    { label: p.label },
    h('input', {
      className: 'cui-control',
      type: 'date',
      value: value ?? '',
      min: p.min,
      max: p.max,
      disabled: p.disabled === true,
      'aria-label': p.label,
      onChange: (event) => setValue(event.target.value),
    }),
  );
}

/** 09 按钮：本地状态 vs 宿主动作分开；提交中防连击。 */
export function Button({ element, emit, on }) {
  // 订阅语言：卡片骨架文案随语言切换即时更新。
  const tt = useT();
  const p = element.props ?? {};
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  // 用 ref 做同步锁：同一帧里的多次 click 共享同一个事件循环，
  // 只看 state 会读到旧值，防重复提交必须靠 ref。
  const inFlight = React.useRef(false);
  const handler = on ? on('click') : { bound: false };

  const click = async () => {
    if (inFlight.current || p.disabled === true) return;
    if (handler.bound === false) {
      setError(tt('actionUnbound'));
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await emit('click');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  // 动作按钮 = 卡片里唯一的「提交」出口，做成整行醒目按钮：
  // 与控件之间加一条分隔线，避免用户以为拖动就会提交。
  const isSubmit = p.variant !== 'ghost' && p.variant !== 'link';
  return h(
    'div',
    { className: `cui-button-wrap${isSubmit ? ' cui-submit-row' : ''}` },
    h(
      'button',
      {
        type: 'button',
        className: `cui-button cui-button-${p.variant ?? 'primary'}${isSubmit ? ' cui-button-block' : ''}`,
        'data-action': p.actionId ?? undefined,
        disabled: p.disabled === true || busy || p.loading === true || handler.bound === false,
        'aria-busy': busy || p.loading === true,
        onClick: click,
      },
      busy || p.loading === true ? h(Spinner, { size: 14 }) : null,
      h('span', null, p.label),
    ),
    error ? h('div', { className: 'cui-error', role: 'alert' }, error) : null,
  );
}
