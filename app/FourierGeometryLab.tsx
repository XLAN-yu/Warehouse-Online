"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

type RotatingComponent = {
  id: string;
  label: string;
  frequency: number;
  amplitude: number;
  phase: number;
  color: string;
  custom: boolean;
};
type CustomComponent = Pick<RotatingComponent, "id" | "frequency" | "amplitude" | "phase">;
type ScreenPoint = { x: number; y: number };

const TAU = Math.PI * 2;
const VIEW_WIDTH = 1120;
const VIEW_HEIGHT = 480;
const WAVE_LEFT = 52;
const WAVE_RIGHT = 654;
const ORIGIN_X = 862;
const ORIGIN_Y = 246;
const WAVE_WINDOW_SECONDS = 3.7;
const MAX_CUSTOM_COMPONENTS = 6;
const COLORS = ["#45e7ff", "#a895ff", "#ff9cda", "#ffa968", "#54e4bc", "#6bb6ff", "#e4d66a", "#ff7f9a"];

const DEFAULTS = {
  count: 4,
  amplitude: 0.82,
  decay: 0.8,
  frequency: 0.62,
  harmonicStep: 1,
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function polyline(points: ScreenPoint[]) {
  return points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
}

function RangeControl({ label, value, valueText, minimum, maximum, step, onChange, onReset }: {
  label: string;
  value: number;
  valueText: string;
  minimum: number;
  maximum: number;
  step: number;
  onChange: (value: number) => void;
  onReset: () => void;
}) {
  return <div className="geometry-range-control">
    <label><span>{label}</span><output>{valueText}</output><input type="range" min={minimum} max={maximum} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>
    <button type="button" className="slider-reset" aria-label={`恢复${label}默认值`} onClick={onReset}>恢复默认</button>
  </div>;
}

export function FourierGeometryLab({ active }: { active: boolean }) {
  const [count, setCount] = useState(DEFAULTS.count);
  const [amplitude, setAmplitude] = useState(DEFAULTS.amplitude);
  const [decay, setDecay] = useState(DEFAULTS.decay);
  const [frequency, setFrequency] = useState(DEFAULTS.frequency);
  const [harmonicStep, setHarmonicStep] = useState(DEFAULTS.harmonicStep);
  const [customComponents, setCustomComponents] = useState<CustomComponent[]>([]);
  const [running, setRunning] = useState(true);
  const [time, setTime] = useState(0);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active || !running) return;
    let previous = performance.now();
    const animate = (now: number) => {
      const delta = Math.min((now - previous) / 1000, 0.05);
      previous = now;
      setTime((current) => (current + delta) % (1 / Math.max(frequency, 0.05)));
      frameRef.current = requestAnimationFrame(animate);
    };
    frameRef.current = requestAnimationFrame(animate);
    return () => { if (frameRef.current !== null) cancelAnimationFrame(frameRef.current); };
  }, [active, frequency, running]);

  const harmonicComponents = useMemo<RotatingComponent[]>(() => Array.from({ length: count }, (_, index) => {
    const order = (index + 1) * harmonicStep;
    return {
      id: `harmonic-${index}`,
      label: `n=${order}`,
      frequency: frequency * order,
      amplitude: amplitude / ((index + 1) ** decay),
      phase: 0,
      color: COLORS[index % COLORS.length],
      custom: false,
    };
  }), [amplitude, count, decay, frequency, harmonicStep]);

  const components = useMemo<RotatingComponent[]>(() => [
    ...harmonicComponents,
    ...customComponents.map((component, index) => ({
      ...component,
      label: `f${index + 1}`,
      color: COLORS[(harmonicComponents.length + index) % COLORS.length],
      custom: true,
    })),
  ], [customComponents, harmonicComponents]);

  const amplitudeLimit = Math.max(0.2, components.reduce((total, component) => total + component.amplitude, 0));
  const scale = 138 / amplitudeLimit;
  const pointAt = (instant: number) => {
    let x = ORIGIN_X;
    let y = ORIGIN_Y;
    const anchors: ScreenPoint[] = [{ x, y }];
    for (const component of components) {
      const angle = -TAU * component.frequency * instant - Math.PI / 2 + component.phase;
      x += Math.cos(angle) * component.amplitude * scale;
      y += Math.sin(angle) * component.amplitude * scale;
      anchors.push({ x, y });
    }
    return { x, y, anchors };
  };

  const endpoint = pointAt(time);
  const wave = useMemo(() => Array.from({ length: 260 }, (_, index) => {
    const ratio = index / 259;
    const instant = time - (1 - ratio) * WAVE_WINDOW_SECONDS;
    const endpointAtInstant = pointAt(instant);
    return { x: WAVE_LEFT + ratio * (WAVE_RIGHT - WAVE_LEFT), y: endpointAtInstant.y };
  }), [components, time, scale]);

  const addCustomComponent = () => {
    if (customComponents.length >= MAX_CUSTOM_COMPONENTS) return;
    const nextFrequency = clamp(frequency * (count + customComponents.length + 1), 0.05, 12);
    setCustomComponents((current) => [...current, {
      id: `custom-frequency-${Date.now()}-${current.length}`,
      frequency: Number(nextFrequency.toFixed(2)),
      amplitude: Number(Math.max(0.1, amplitude * 0.5).toFixed(2)),
      phase: 0,
    }]);
  };
  const updateCustomComponent = (id: string, update: Partial<Pick<CustomComponent, "frequency" | "amplitude">>) => {
    setCustomComponents((current) => current.map((component) => component.id === id ? { ...component, ...update } : component));
  };
  const removeCustomComponent = (id: string) => setCustomComponents((current) => current.filter((component) => component.id !== id));
  const resetAll = () => {
    setCount(DEFAULTS.count);
    setAmplitude(DEFAULTS.amplitude);
    setDecay(DEFAULTS.decay);
    setFrequency(DEFAULTS.frequency);
    setHarmonicStep(DEFAULTS.harmonicStep);
    setCustomComponents([]);
    setTime(0);
  };
  const formula = customComponents.length
    ? "x(t) = Σ Aₙsin(2π·n·h·f₀·t) + Σ Bᵢsin(2π·fᵢ·t)"
    : "x(t) = Σ Aₙsin(2π·n·h·f₀·t)";

  return <section className="workspace geometry-workspace" aria-label="傅里叶几何合成工作台">
    <div className="geometry-intro">
      <div>
        <p>傅里叶级数的几何合成</p>
        <h1>旋转向量 · 实时叠加波形</h1>
        <span>每根彩色线段表示一个复指数分量。整数谐波与手动添加的任意频率分量都会首尾相接旋转；终点的竖直投影就是左侧不断向左滚动的合成波形。</span>
      </div>
      <div className="geometry-actions">
        <button type="button" className={running ? "mini-tab active" : "mini-tab"} onClick={() => setRunning((current) => !current)}>{running ? "暂停运动" : "继续运动"}</button>
        <button type="button" className="slider-reset" onClick={resetAll}>恢复全部默认</button>
      </div>
    </div>

    <div className="geometry-layout">
      <article className="plot-panel geometry-visual-panel">
        <div className="plot-heading"><div><p>动态几何图</p><h2>复向量链与时域投影</h2></div><span className="domain-pill">t = {time.toFixed(2)} s · {components.length} 个旋转分量</span></div>
        <svg className="geometry-svg" viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} role="img" aria-label="多个旋转复向量首尾相接，终点投影实时绘制左侧的合成波形">
          <title>旋转复向量叠加为时域波形</title>
          <desc>右侧每根彩色向量是一个谐波或自定义频率分量，首尾叠加后的终点与左侧滚动波形的最新采样点水平对齐。</desc>
          <defs><clipPath id="geometry-wave-clip"><rect x={WAVE_LEFT} y="44" width={WAVE_RIGHT - WAVE_LEFT} height="404" /></clipPath></defs>
          {Array.from({ length: 7 }, (_, index) => <line key={`horizontal-${index}`} className="geometry-grid-line" x1={WAVE_LEFT} x2={WAVE_RIGHT} y1={74 + index * 57} y2={74 + index * 57} />)}
          {Array.from({ length: 7 }, (_, index) => <line key={`vertical-${index}`} className="geometry-grid-line" x1={WAVE_LEFT + index * ((WAVE_RIGHT - WAVE_LEFT) / 6)} x2={WAVE_LEFT + index * ((WAVE_RIGHT - WAVE_LEFT) / 6)} y1="44" y2="448" />)}
          <line className="geometry-axis" x1={WAVE_LEFT} x2={WAVE_RIGHT} y1={ORIGIN_Y} y2={ORIGIN_Y} />
          <text className="geometry-label" x={WAVE_LEFT} y="32">时域投影 x(t)</text>
          <text className="geometry-label" x={WAVE_RIGHT} y="472" textAnchor="end">时间 t（新点从右侧写入，波形向左移动）</text>
          <g clipPath="url(#geometry-wave-clip)"><path className="geometry-wave" d={polyline(wave)} /></g>
          <line className="geometry-projection" x1={WAVE_RIGHT} x2={endpoint.x} y1={endpoint.y} y2={endpoint.y} />
          <circle className="geometry-current-sample" cx={WAVE_RIGHT} cy={endpoint.y} r="4.8" />

          <line className="geometry-separator" x1="696" x2="696" y1="44" y2="448" />
          <text className="geometry-label" x="726" y="32">复平面中的旋转向量链</text>
          <line className="geometry-origin-axis" x1="720" x2="1080" y1={ORIGIN_Y} y2={ORIGIN_Y} />
          <line className="geometry-origin-axis" x1={ORIGIN_X} x2={ORIGIN_X} y1="66" y2="426" />
          {components.map((component, index) => {
            const anchor = endpoint.anchors[index];
            const tip = endpoint.anchors[index + 1];
            const radius = component.amplitude * scale;
            return <g key={component.id} style={{ color: component.color }}>
              <circle className="geometry-orbit" cx={anchor.x} cy={anchor.y} r={radius} />
              <line className="geometry-vector" x1={anchor.x} y1={anchor.y} x2={tip.x} y2={tip.y} />
              <circle className="geometry-vector-joint" cx={anchor.x} cy={anchor.y} r="3.8" />
              <text className="geometry-harmonic-tag" x={(anchor.x + tip.x) / 2} y={(anchor.y + tip.y) / 2 - 10}>{component.custom ? `${component.frequency.toFixed(2)} Hz` : component.label}</text>
            </g>;
          })}
          <circle className="geometry-endpoint" cx={endpoint.x} cy={endpoint.y} r="6.5" />
          <text className="geometry-endpoint-label" x={endpoint.x + 10} y={endpoint.y - 12}>Σ Aᵢe<tspan baselineShift="super" fontSize="10">j·2πfᵢt</tspan></text>
          <text className="geometry-label" x="1080" y="472" textAnchor="end">Re</text>
          <text className="geometry-label" x={ORIGIN_X + 9} y="74">Im</text>
        </svg>
        <div className="geometry-legend" aria-label="旋转分量图例">{components.map((component) => <span key={component.id} style={{ "--harmonic-color": component.color } as CSSProperties}><i aria-hidden="true" />{component.custom ? `${component.label} · ${component.frequency.toFixed(2)} Hz` : `${component.label} · A=${component.amplitude.toFixed(2)}`}</span>)}</div>
      </article>

      <aside className="geometry-controls" aria-label="谐波参数控制">
        <div className="geometry-controls-heading"><p>实时参数</p><h2>谐波与旋转</h2></div>
        <RangeControl label="谐波个数" value={count} valueText={`${count} 根向量`} minimum={1} maximum={8} step={1} onChange={(value) => setCount(Math.round(value))} onReset={() => setCount(DEFAULTS.count)} />
        <RangeControl label="基频 f₀ / 旋转速度" value={frequency} valueText={`${frequency.toFixed(2)} Hz`} minimum={0.1} maximum={2.4} step={0.01} onChange={setFrequency} onReset={() => setFrequency(DEFAULTS.frequency)} />
        <RangeControl label="基准幅值 A" value={amplitude} valueText={amplitude.toFixed(2)} minimum={0.1} maximum={1.4} step={0.01} onChange={setAmplitude} onReset={() => setAmplitude(DEFAULTS.amplitude)} />
        <RangeControl label="幅值衰减 p" value={decay} valueText={`1 / n^${decay.toFixed(2)}`} minimum={0} maximum={2.4} step={0.05} onChange={setDecay} onReset={() => setDecay(DEFAULTS.decay)} />
        <RangeControl label="谐波阶差 h" value={harmonicStep} valueText={`n = ${harmonicStep}, ${harmonicStep * 2}, …`} minimum={1} maximum={4} step={1} onChange={(value) => setHarmonicStep(Math.round(value))} onReset={() => setHarmonicStep(DEFAULTS.harmonicStep)} />
        <div className="geometry-custom-components">
          <div className="geometry-custom-heading"><span>自定义频率分量</span><button className="add-component" type="button" disabled={customComponents.length >= MAX_CUSTOM_COMPONENTS} onClick={addCustomComponent}>＋ 添加频率</button></div>
          {customComponents.length === 0 ? <p className="geometry-custom-empty">可加入任意非整数频率；它会立刻加入右侧向量链与左侧合成信号。</p> : customComponents.map((component, index) => <div key={component.id} className="geometry-custom-row">
            <label><span>f{index + 1} / Hz</span><input aria-label={`自定义分量 f${index + 1} 的频率`} type="number" min="0.01" max="12" step="0.01" value={component.frequency} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) updateCustomComponent(component.id, { frequency: clamp(value, 0.01, 12) }); }} /></label>
            <label><span>幅值 B</span><input aria-label={`自定义分量 f${index + 1} 的幅度`} type="range" min="0" max="1.4" step="0.01" value={component.amplitude} onChange={(event) => updateCustomComponent(component.id, { amplitude: Number(event.target.value) })} /></label>
            <output>B {component.amplitude.toFixed(2)}</output>
            <button type="button" className="slider-reset" aria-label={`删除自定义分量 f${index + 1}`} onClick={() => removeCustomComponent(component.id)}>删除</button>
          </div>)}
        </div>
        <div className="geometry-formula"><span>当前模型</span><code>{formula}</code><small>Aₙ = A / n<sup>p</sup>，谐波 ωₙ = 2π·n·h·f₀；自定义分量使用独立的 fᵢ 和 Bᵢ。所有参数会同步改变向量轨迹与合成波形。</small></div>
        <div className="geometry-note"><b>与你的图对应：</b><span>图中的圆周运动来自复指数；这里显示的是“已知频率分量如何合成信号”的几何图，即逆傅里叶级数。正傅里叶变换则是用不同旋转频率去测量信号在这些方向上的投影。</span></div>
      </aside>
    </div>
  </section>;
}
