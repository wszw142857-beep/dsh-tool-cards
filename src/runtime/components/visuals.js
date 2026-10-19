/**
 * 2 类交互式可视化（规范 §1 的 14–15）。
 *
 * 与调研结论一致：json-render 的 shadcn 组件集里没有 Chart，所以这里是
 * 自绘 SVG 实现（零依赖、离线可跑、跟随主题 token）。
 * Map 在无瓦片服务时按规范 §11 的 T14 降级为点位列表。
 *
 * 几何约定（踩过的坑）：
 *  - 柱状图必须用 **band 刻度**（每类占一段、柱在段中心），不能用点刻度。
 *    点刻度把第一个点放在 PAD.left，柱子居中后左半边会压进 Y 轴刻度文字。
 *  - 折线/散点用「半段内缩」的点刻度，首尾点也不会贴到轴线。
 *  - 所有图元都套在 clipPath 里：数据再离谱也不会画出绘图区。
 *
 * @module chat-ui-demo/components/visuals
 */
import React from 'react';

const h = React.createElement;

const WIDTH = 560;
const DEFAULT_HEIGHT = 220;
const PAD = { top: 18, right: 20, bottom: 34, left: 58 };

/** 轴刻度数量（含 0 与最大值）。 */
const Y_TICKS = 4;

/**
 * 把刻度值收成好看的数（1/2/5 × 10^n），避免出现 7.35 这种刻度。
 * @param {number} value
 * @returns {number}
 */
function niceStep(value) {
  if (!(value > 0)) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const scaled = value / base;
  const nice = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return nice * base;
}

/**
 * 计算绘图区与两轴映射。
 * @param {Array} data
 * @param {Array} series
 * @param {number} height
 */
function computeScale(data, series, height) {
  const values = series
    .flatMap((entry) => data.map((row) => Number(row[entry.key])))
    .filter((value) => Number.isFinite(value));

  const rawMax = Math.max(1, ...values);
  const step = niceStep(rawMax / Y_TICKS);
  const max = Math.ceil(rawMax / step) * step;
  const min = Math.min(0, ...values);

  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const count = Math.max(data.length, 1);
  const band = innerW / count;

  return {
    min,
    max,
    step,
    innerW,
    innerH,
    band,
    /** 柱状图：第 i 类的段中心。 */
    center: (index) => PAD.left + band * (index + 0.5),
    /** 折线/散点：半段内缩，首尾不贴轴。 */
    point: (index) =>
      count <= 1
        ? PAD.left + innerW / 2
        : PAD.left + band / 2 + (index * (innerW - band)) / (count - 1),
    y: (value) => PAD.top + innerH - ((value - min) / (max - min || 1)) * innerH,
  };
}

/** 生成唯一的 clipPath id（同页多图不能撞）。 */
let chartSeq = 0;
function useClipId() {
  const ref = React.useRef(null);
  if (ref.current === null) {
    chartSeq += 1;
    ref.current = `cui-clip-${chartSeq}`;
  }
  return ref.current;
}

/** 14 图表：柱状 / 折线 / 饼图 / 散点；空数据显示空状态。 */
export function Chart({ element }) {
  const p = element.props ?? {};
  const data = Array.isArray(p.data) ? p.data : [];
  const series = Array.isArray(p.series) && p.series.length > 0 ? p.series : [];
  const chartType = p.chartType ?? 'bar';
  const height = Number(p.height ?? DEFAULT_HEIGHT);
  const [hover, setHover] = React.useState(null);
  const clipId = useClipId();

  if (data.length === 0) {
    return h('div', { className: 'cui-chart cui-chart-empty', role: 'status' }, '暂无数据');
  }
  if (series.length === 0) {
    return h('div', { className: 'cui-chart cui-chart-empty', role: 'status' }, '图表缺少 series 定义');
  }

  if (chartType === 'pie') {
    const key = series[0].key;
    const total = data.reduce((sum, row) => sum + Math.max(0, Number(row[key]) || 0), 0) || 1;
    let angle = -Math.PI / 2;
    const radius = Math.min(WIDTH, height) / 2 - 20;
    const cx = WIDTH / 2;
    const cy = height / 2;
    const arcs = data.map((row, index) => {
      const value = Math.max(0, Number(row[key]) || 0);
      const sweep = (value / total) * Math.PI * 2;
      const x1 = cx + radius * Math.cos(angle);
      const y1 = cy + radius * Math.sin(angle);
      angle += sweep;
      const x2 = cx + radius * Math.cos(angle);
      const y2 = cy + radius * Math.sin(angle);
      const large = sweep > Math.PI ? 1 : 0;
      return {
        path: `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} Z`,
        index,
        label: String(row[p.xKey] ?? index),
        value,
      };
    });
    return h(
      'figure',
      { className: 'cui-chart' },
      p.label ? h('figcaption', { className: 'cui-chart-title' }, p.label) : null,
      h(
        'svg',
        { viewBox: `0 0 ${WIDTH} ${height}`, role: 'img', 'aria-label': p.label ?? '饼图' },
        arcs.map((arc) =>
          h('path', {
            key: arc.index,
            d: arc.path,
            className: `cui-pie-slice cui-pie-${arc.index % 6}`,
            onMouseEnter: () => setHover({ label: arc.label, value: arc.value, series: series[0].label ?? key }),
            onMouseLeave: () => setHover(null),
          }),
        ),
      ),
      hover
        ? h('div', { className: 'cui-tooltip' }, `${hover.label} · ${hover.series}: ${hover.value}`)
        : h(
            'ul',
            { className: 'cui-legend' },
            data.map((row, index) =>
              h(
                'li',
                { key: index },
                h('span', { className: `cui-legend-dot cui-pie-${index % 6}` }),
                String(row[p.xKey] ?? index),
              ),
            ),
          ),
    );
  }

  const scale = computeScale(data, series, height);
  const yTicks = Array.from({ length: Y_TICKS + 1 }, (_, i) => {
    const value = scale.min + ((scale.max - scale.min) * i) / Y_TICKS;
    return { value, y: scale.y(value) };
  });

  /** 柱宽：留出段间空隙，且不超过段宽的 72%。 */
  const barWidth = Math.max(
    4,
    Math.min(30, (scale.band * 0.72) / series.length),
  );
  const showsXLabels = data.length <= 14;

  return h(
    'figure',
    { className: 'cui-chart' },
    p.label ? h('figcaption', { className: 'cui-chart-title' }, p.label) : null,
    h(
      'svg',
      { viewBox: `0 0 ${WIDTH} ${height}`, role: 'img', 'aria-label': p.label ?? `${chartType} 图` },
      h(
        'defs',
        null,
        h('clipPath', { id: clipId }, h('rect', {
          x: PAD.left,
          y: PAD.top,
          width: scale.innerW,
          height: scale.innerH,
        })),
      ),
      // 网格线与 Y 轴刻度
      yTicks.map((tick, index) =>
        h(
          'g',
          { key: `y-${index}` },
          h('line', {
            x1: PAD.left,
            x2: WIDTH - PAD.right,
            y1: tick.y,
            y2: tick.y,
            className: index === 0 ? 'cui-axis-line' : 'cui-grid-line',
          }),
          h(
            'text',
            {
              x: PAD.left - 10,
              y: tick.y + 4,
              className: 'cui-axis-label',
              textAnchor: 'end',
            },
            String(Math.round(tick.value * 1000) / 1000),
          ),
        ),
      ),
      // X 轴类目标签
      showsXLabels
        ? data.map((row, index) =>
            h(
              'text',
              {
                key: `x-${index}`,
                x: chartType === 'bar' ? scale.center(index) : scale.point(index),
                y: height - PAD.bottom + 18,
                className: 'cui-axis-label',
                textAnchor: 'middle',
              },
              String(row[p.xKey] ?? index),
            ),
          )
        : null,
      // 数据图元：统一裁剪到绘图区
      h(
        'g',
        { clipPath: `url(#${clipId})` },
        chartType === 'bar'
          ? data.map((row, index) =>
              series.map((entry, si) => {
                const value = Number(row[entry.key]);
                if (!Number.isFinite(value)) return null;
                const zero = scale.y(0);
                const top = scale.y(value);
                const groupWidth = barWidth * series.length;
                const x = scale.center(index) - groupWidth / 2 + si * barWidth;
                return h('rect', {
                  key: `${index}-${entry.key}`,
                  x,
                  y: Math.min(zero, top),
                  width: Math.max(1, barWidth - 3),
                  height: Math.max(1, Math.abs(zero - top)),
                  rx: Math.min(4, (barWidth - 3) / 3),
                  className: `cui-series cui-series-${si}`,
                  onMouseEnter: () =>
                    setHover({ label: String(row[p.xKey] ?? index), series: entry.label ?? entry.key, value }),
                  onMouseLeave: () => setHover(null),
                });
              }),
            )
          : null,
        chartType === 'line'
          ? series.map((entry, si) => {
              const points = data
                .map((row, index) => {
                  const value = Number(row[entry.key]);
                  return Number.isFinite(value) ? `${scale.point(index)},${scale.y(value)}` : null;
                })
                .filter(Boolean)
                .join(' ');
              return points
                ? h('polyline', { key: entry.key, points, className: `cui-series-line cui-series-${si}` })
                : null;
            })
          : null,
        chartType === 'scatter'
          ? series.map((entry, si) =>
              data.map((row, index) => {
                const value = Number(row[entry.key]);
                if (!Number.isFinite(value)) return null;
                return h('circle', {
                  key: `${index}-${entry.key}`,
                  cx: scale.point(index),
                  cy: scale.y(value),
                  r: 4,
                  className: `cui-series cui-series-${si}`,
                  onMouseEnter: () =>
                    setHover({ label: String(row[p.xKey] ?? index), series: entry.label ?? entry.key, value }),
                  onMouseLeave: () => setHover(null),
                });
              }),
            )
          : null,
      ),
    ),
    hover
      ? h('div', { className: 'cui-tooltip' }, `${hover.label} · ${hover.series}: ${hover.value}`)
      : h(
          'ul',
          { className: 'cui-legend' },
          series.map((entry, si) =>
            h(
              'li',
              { key: entry.key },
              h('span', { className: `cui-legend-dot cui-series-${si}` }),
              entry.label ?? entry.key,
            ),
          ),
        ),
  );
}

/**
 * 15 地图：没有瓦片服务时按规范 T14 降级为文本点位列表。
 * 有 center/markers 时画一个等距投影的简易散点地图（不承诺真实地理精度）。
 */
export function MapView({ element }) {
  const p = element.props ?? {};
  const markers = Array.isArray(p.markers) ? p.markers : [];
  const [selected, setSelected] = React.useState(null);

  if (markers.length === 0) {
    return h('div', { className: 'cui-map cui-map-fallback', role: 'status' }, p.unavailableReason ?? '暂无点位数据');
  }

  const lats = markers.map((m) => m.lat).filter(Number.isFinite);
  const lngs = markers.map((m) => m.lng).filter(Number.isFinite);
  if (lats.length === 0 || lngs.length === 0) {
    return h(
      'div',
      { className: 'cui-map cui-map-fallback', role: 'status' },
      h('div', { className: 'cui-hint' }, p.unavailableReason ?? '坐标缺失，已降级为点位列表'),
      h(
        'ul',
        { className: 'cui-map-list' },
        markers.map((marker) =>
          h('li', { key: marker.id }, `${marker.label ?? marker.id}（${marker.lat}, ${marker.lng}）`),
        ),
      ),
    );
  }

  const center =
    p.center ?? {
      lat: (Math.min(...lats) + Math.max(...lats)) / 2,
      lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
    };
  const spanLat = Math.max(0.01, (Math.max(...lats) - Math.min(...lats)) * 1.4);
  const spanLng = Math.max(0.01, (Math.max(...lngs) - Math.min(...lngs)) * 1.4);
  const project = (marker) => ({
    x: 50 + ((marker.lng - center.lng) / spanLng + 0.5) * (WIDTH - 100),
    y: DEFAULT_HEIGHT / 2 - ((marker.lat - center.lat) / spanLat) * (DEFAULT_HEIGHT - 40),
  });

  return h(
    'figure',
    { className: 'cui-map' },
    p.label ? h('figcaption', { className: 'cui-chart-title' }, p.label) : null,
    h(
      'svg',
      { viewBox: `0 0 ${WIDTH} ${DEFAULT_HEIGHT}`, role: 'img', 'aria-label': p.label ?? '点位图' },
      h('rect', { x: 0, y: 0, width: WIDTH, height: DEFAULT_HEIGHT, rx: 10, className: 'cui-map-bg' }),
      markers.map((marker) => {
        const { x, y } = project(marker);
        return h('circle', {
          key: marker.id,
          cx: x,
          cy: y,
          r: selected === marker.id ? 8 : 5,
          className: 'cui-map-marker',
          'aria-label': marker.label ?? marker.id,
          onMouseEnter: () => setSelected(marker.id),
          onMouseLeave: () => setSelected(null),
        });
      }),
    ),
    h(
      'ul',
      { className: 'cui-map-list' },
      markers.map((marker) =>
        h('li', { key: marker.id, 'aria-current': selected === marker.id }, marker.label ?? marker.id),
      ),
    ),
    h('div', { className: 'cui-hint' }, '未接入瓦片服务：坐标仅做等距投影示意，不用于路线或距离计算。'),
  );
}
