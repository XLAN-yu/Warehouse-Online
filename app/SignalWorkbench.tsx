"use client";

import { useMemo, useRef, useState, type PointerEvent } from "react";

type DomainMode = "continuous" | "discrete";
type ToolMode = "transform" | "convolution";
type TransformKind = "fourier" | "laplace" | "z";
type Preset = "sine" | "gaussian" | "rect" | "chirp" | "decay";

const SAMPLE_COUNT = 128;
const WIDTH = 620;
const HEIGHT = 300;
const PAD = { left: 48, right: 20, top: 24, bottom: 38 };

const presetLabels: Record<Preset, string> = {
  sine: "正弦波",
  gaussian: "高斯脉冲",
  rect: "矩形脉冲",
  chirp: "线性调频",
  decay: "指数衰减",
};

const presetExpressions: Record<Preset, string> = {
  sine: "sin(2*pi*2*t)",
  gaussian: "exp(-t*t)",
  rect: "rect(t/1.5)",
  chirp: "sin(2*pi*t*t)",
  decay: "exp(-abs(t))",
};

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const asNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function presetFunction(preset: Preset) {
  switch (preset) {
    case "gaussian":
      return (x: number) => Math.exp(-x * x);
    case "rect":
      return (x: number) => (Math.abs(x) <= 0.75 ? 1 : 0);
    case "chirp":
      return (x: number) => Math.sin(2 * Math.PI * x * x);
    case "decay":
      return (x: number) => Math.exp(-Math.abs(x));
    default:
      return (x: number) => Math.sin(2 * Math.PI * 2 * x);
  }
}

function parseExpression(expression: string, fallback: Preset) {
  const value = expression
    .toLowerCase()
    .replaceAll("π", "pi")
    .replace(/[·×]/g, "*")
    .replaceAll(" ", "");

  const trig = value.match(
    /^(sin|cos)\(2\*pi\*?([0-9.]+)?\*?[tn](?:\+([0-9.]+))?\)$/,
  );
  if (trig) {
    const frequency = asNumber(trig[2], 1);
    const phase = asNumber(trig[3], 0);
    return (x: number) =>
      trig[1] === "sin"
        ? Math.sin(2 * Math.PI * frequency * x + phase)
        : Math.cos(2 * Math.PI * frequency * x + phase);
  }

  const gaussian = value.match(/^exp\(-([0-9.]+)?\*?[tn]\*?[tn]\)$/);
  if (gaussian) {
    const width = asNumber(gaussian[1], 1);
    return (x: number) => Math.exp(-width * x * x);
  }

  const decay = value.match(/^exp\(-abs\([tn]\)\)$/);
  if (decay) return (x: number) => Math.exp(-Math.abs(x));

  const rect = value.match(/^rect\([tn]\/([0-9.]+)\)$/);
  if (rect) {
    const width = asNumber(rect[1], 1.5);
    return (x: number) => (Math.abs(x) <= width / 2 ? 1 : 0);
  }

  const sinc = value.match(/^sinc\(([0-9.]+)?\*?[tn]\)$/);
  if (sinc) {
    const scale = asNumber(sinc[1], 1);
    return (x: number) => {
      const y = Math.PI * scale * x;
      return Math.abs(y) < 1e-6 ? 1 : Math.sin(y) / y;
    };
  }

  return presetFunction(fallback);
}

function sampleSignal(fn: (x: number) => number, mode: DomainMode) {
  return Array.from({ length: SAMPLE_COUNT }, (_, index) => {
    const x = mode === "continuous" ? -4 + (8 * index) / (SAMPLE_COUNT - 1) : index - 64;
    const sourceX = mode === "continuous" ? x : x / 16;
    return { x, y: fn(sourceX) };
  });
}

function complexSpectrum(
  samples: { x: number; y: number }[],
  mode: DomainMode,
  transform: TransformKind,
) {
  const bins = 64;
  const dt = mode === "continuous" ? 8 / (SAMPLE_COUNT - 1) : 1;
  const damping = transform === "laplace" ? 0.15 : 0;
  const radius = transform === "z" ? 1.015 : 1;

  return Array.from({ length: bins }, (_, bin) => {
    const omega = (Math.PI * bin) / (bins - 1);
    let real = 0;
    let imaginary = 0;

    samples.forEach((sample, index) => {
      const n = transform === "z" ? index : sample.x;
      const weight = Math.exp(-damping * Math.abs(n)) * Math.pow(radius, -index);
      real += sample.y * weight * Math.cos(-omega * n) * dt;
      imaginary += sample.y * weight * Math.sin(-omega * n) * dt;
    });

    return { x: bin, y: Math.hypot(real, imaginary) };
  });
}

function convolution(
  first: { x: number; y: number }[],
  second: { x: number; y: number }[],
  mode: DomainMode,
) {
  const step = mode === "continuous" ? 8 / (SAMPLE_COUNT - 1) : 1;
  const values = Array.from({ length: SAMPLE_COUNT * 2 - 1 }, (_, resultIndex) => {
    let sum = 0;
    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      const other = resultIndex - index;
      if (other >= 0 && other < SAMPLE_COUNT) sum += first[index].y * second[other].y;
    }
    return sum * step;
  });
  const start = mode === "continuous" ? -8 : -128;
  return values.map((y, index) => ({ x: start + index * step, y }));
}

function normalizeRange(points: { x: number; y: number }[]) {
  return Math.max(0.2, ...points.map((point) => Math.abs(point.y)));
}

function chartX(index: number, count: number, zoom: number) {
  const inner = WIDTH - PAD.left - PAD.right;
  return PAD.left + inner / 2 + ((index / Math.max(count - 1, 1) - 0.5) * inner * zoom);
}

function chartY(value: number, maxValue: number) {
  const inner = HEIGHT - PAD.top - PAD.bottom;
  return PAD.top + inner / 2 - (value / maxValue) * (inner * 0.42);
}

function seriesPath(points: { x: number; y: number }[], zoom: number, maxValue: number) {
  return points
    .map((point, index) => {
      const command = index === 0 ? "M" : "L";
      return `${command}${chartX(index, points.length, zoom).toFixed(2)},${chartY(point.y, maxValue).toFixed(2)}`;
    })
    .join(" ");
}

function AxisGrid({ label }: { label: string }) {
  const vertical = Array.from({ length: 8 }, (_, index) => PAD.left + ((WIDTH - PAD.left - PAD.right) * index) / 7);
  const horizontal = Array.from({ length: 5 }, (_, index) => PAD.top + ((HEIGHT - PAD.top - PAD.bottom) * index) / 4);
  return (
    <>
      {vertical.map((x) => <line key={`v-${x}`} className="grid-line" x1={x} x2={x} y1={PAD.top} y2={HEIGHT - PAD.bottom} />)}
      {horizontal.map((y) => <line key={`h-${y}`} className="grid-line" x1={PAD.left} x2={WIDTH - PAD.right} y1={y} y2={y} />)}
      <line className="axis-line" x1={PAD.left} x2={WIDTH - PAD.right} y1={HEIGHT / 2} y2={HEIGHT / 2} />
      <line className="axis-line" x1={WIDTH / 2} x2={WIDTH / 2} y1={PAD.top} y2={HEIGHT - PAD.bottom} />
      <text className="axis-caption" x={WIDTH - PAD.right} y={HEIGHT - 10} textAnchor="end">{label}</text>
    </>
  );
}

function SignalPlot({
  id,
  label,
  points,
  mode,
  zoom,
  accent,
  markerIndex,
  markerLabel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  id: string;
  label: string;
  points: { x: number; y: number }[];
  mode: DomainMode;
  zoom: number;
  accent: "cyan" | "pink" | "violet";
  markerIndex?: number;
  markerLabel?: string;
  onPointerDown?: (event: PointerEvent<SVGSVGElement>) => void;
  onPointerMove?: (event: PointerEvent<SVGSVGElement>) => void;
  onPointerUp?: (event: PointerEvent<SVGSVGElement>) => void;
}) {
  const maxValue = normalizeRange(points);
  const clipId = `clip-${id}`;
  const colorClass = `plot-${accent}`;
  const markerX = markerIndex === undefined ? 0 : chartX(markerIndex, points.length, zoom);
  const markerY = markerIndex === undefined ? 0 : chartY(points[markerIndex]?.y ?? 0, maxValue);

  return (
    <svg
      className={`signal-plot ${onPointerDown ? "draggable-plot" : ""}`}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <defs><clipPath id={clipId}><rect x={PAD.left} y={PAD.top} width={WIDTH - PAD.left - PAD.right} height={HEIGHT - PAD.top - PAD.bottom} /></clipPath></defs>
      <AxisGrid label={mode === "continuous" ? "t" : "n"} />
      <g clipPath={`url(#${clipId})`}>
        {mode === "continuous" ? (
          <path className={`signal-line ${colorClass}`} d={seriesPath(points, zoom, maxValue)} />
        ) : (
          points.map((point, index) => {
            const x = chartX(index, points.length, zoom);
            const y = chartY(point.y, maxValue);
            return <g key={index}><line className={`stem ${colorClass}`} x1={x} x2={x} y1={HEIGHT / 2} y2={y} /><circle className={`point ${colorClass}`} cx={x} cy={y} r="3.4" /></g>;
          })
        )}
        {markerIndex !== undefined && (
          <g className="result-marker"><line x1={markerX} x2={markerX} y1={PAD.top} y2={HEIGHT - PAD.bottom} /><circle className={`point ${colorClass}`} cx={markerX} cy={markerY} r="5" /></g>
        )}
      </g>
      {markerLabel && <text className="plot-label" x={PAD.left + 8} y={PAD.top + 18}>{markerLabel}</text>}
    </svg>
  );
}

function FrequencyPlot({
  points,
  zoom,
  transform,
}: {
  points: { x: number; y: number }[];
  zoom: number;
  transform: TransformKind;
}) {
  const maxValue = normalizeRange(points);
  const label = transform === "fourier" ? "ω" : transform === "laplace" ? "Im(s)" : "∠z";
  return (
    <svg className="signal-plot" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="变换结果幅度图">
      <AxisGrid label={label} />
      <g>
        <path className="spectrum-area" d={`${seriesPath(points, zoom, maxValue)} L${chartX(points.length - 1, points.length, zoom)},${HEIGHT - PAD.bottom} L${chartX(0, points.length, zoom)},${HEIGHT - PAD.bottom} Z`} />
        <path className="signal-line plot-pink" d={seriesPath(points, zoom, maxValue)} />
      </g>
    </svg>
  );
}

function ZoomControl({ value, onChange, label }: { value: number; onChange: (value: number) => void; label: string }) {
  return (
    <label className="zoom-control">
      <span>{label}</span><output>{value.toFixed(1)}×</output>
      <input type="range" min="0.5" max="2.4" step="0.1" value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

export function SignalWorkbench() {
  const [domainMode, setDomainMode] = useState<DomainMode>("continuous");
  const [toolMode, setToolMode] = useState<ToolMode>("transform");
  const [transformKind, setTransformKind] = useState<TransformKind>("fourier");
  const [preset, setPreset] = useState<Preset>("sine");
  const [expression, setExpression] = useState(presetExpressions.sine);
  const [timeZoom, setTimeZoom] = useState(1);
  const [frequencyZoom, setFrequencyZoom] = useState(1);
  const [firstPreset, setFirstPreset] = useState<Preset>("sine");
  const [secondPreset, setSecondPreset] = useState<Preset>("rect");
  const [firstExpression, setFirstExpression] = useState(presetExpressions.sine);
  const [secondExpression, setSecondExpression] = useState(presetExpressions.rect);
  const [shift, setShift] = useState(0);
  const [dragging, setDragging] = useState(false);
  const convolutionRef = useRef<SVGSVGElement>(null);

  const signal = useMemo(
    () => sampleSignal(parseExpression(expression, preset), domainMode),
    [domainMode, expression, preset],
  );
  const spectrum = useMemo(
    () => complexSpectrum(signal, domainMode, transformKind),
    [domainMode, signal, transformKind],
  );
  const firstSignal = useMemo(
    () => sampleSignal(parseExpression(firstExpression, firstPreset), domainMode),
    [domainMode, firstExpression, firstPreset],
  );
  const secondSignal = useMemo(
    () => sampleSignal(parseExpression(secondExpression, secondPreset), domainMode),
    [domainMode, secondExpression, secondPreset],
  );
  const result = useMemo(
    () => convolution(firstSignal, secondSignal, domainMode),
    [domainMode, firstSignal, secondSignal],
  );
  const marker = clamp(Math.round((shift + 4) / 8 * (result.length - 1)), 0, result.length - 1);
  const convolutionMax = normalizeRange([...firstSignal, ...secondSignal]);
  const overlayShift = (shift / 8) * (WIDTH - PAD.left - PAD.right) * timeZoom;

  const choosePreset = (next: Preset) => {
    setPreset(next);
    setExpression(presetExpressions[next]);
  };
  const chooseConvolutionPreset = (target: "first" | "second", next: Preset) => {
    if (target === "first") {
      setFirstPreset(next);
      setFirstExpression(presetExpressions[next]);
    } else {
      setSecondPreset(next);
      setSecondExpression(presetExpressions[next]);
    }
  };
  const updateShift = (event: PointerEvent<SVGSVGElement>) => {
    const svg = convolutionRef.current;
    if (!svg) return;
    const bounds = svg.getBoundingClientRect();
    const localX = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
    setShift(Number((((localX - 0.5) * 8) / timeZoom).toFixed(2)));
  };

  const transformName = transformKind === "fourier" ? "傅里叶变换" : transformKind === "laplace" ? "拉普拉斯变换" : "Z 变换";
  const outputTitle = transformKind === "fourier" ? "频域 |X(ω)|" : transformKind === "laplace" ? "s 域 |X(σ+jω)|" : "z 域 |X(re^{jω})|";

  return (
    <main className="tool-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden="true" />Signal Lab</div>
        <div className="tab-group" role="group" aria-label="信号类型">
          <button className={domainMode === "continuous" ? "tab active" : "tab"} onClick={() => setDomainMode("continuous")}>连续时间</button>
          <button className={domainMode === "discrete" ? "tab active" : "tab"} onClick={() => setDomainMode("discrete")}>离散时间</button>
        </div>
        <div className="tab-group" role="group" aria-label="分析工具">
          <button className={toolMode === "transform" ? "tab active" : "tab"} onClick={() => setToolMode("transform")}>时频变换</button>
          <button className={toolMode === "convolution" ? "tab active" : "tab"} onClick={() => setToolMode("convolution")}>卷积</button>
        </div>
      </header>

      {toolMode === "transform" ? (
        <section className="workspace" aria-label="时频变换工作台">
          <div className="control-row">
            <label>标准函数<select value={preset} onChange={(event) => choosePreset(event.target.value as Preset)}>{Object.entries(presetLabels).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
            <label className="expression-input">函数表达式<input value={expression} onChange={(event) => setExpression(event.target.value)} spellCheck="false" /></label>
            <label>变换<select value={transformKind} onChange={(event) => setTransformKind(event.target.value as TransformKind)}><option value="fourier">傅里叶变换</option><option value="laplace">拉普拉斯变换</option><option value="z">Z 变换</option></select></label>
            <span className="status-dot">实时计算</span>
          </div>
          <div className="plot-grid">
            <article className="plot-panel">
              <div className="plot-heading"><div><p>输入信号</p><h2>{domainMode === "continuous" ? "时域 x(t)" : "时域 x[n]"}</h2></div><span className="domain-pill">{domainMode === "continuous" ? "−4 … 4 s" : "n = −64 … 63"}</span></div>
              <SignalPlot id="time" label="输入信号时域图" points={signal} mode={domainMode} zoom={timeZoom} accent="cyan" markerLabel="x" />
              <ZoomControl label="时域缩放" value={timeZoom} onChange={setTimeZoom} />
            </article>
            <article className="plot-panel">
              <div className="plot-heading"><div><p>{transformName}</p><h2>{outputTitle}</h2></div><span className="domain-pill">数值计算</span></div>
              <FrequencyPlot points={spectrum} zoom={frequencyZoom} transform={transformKind} />
              <ZoomControl label="频域缩放" value={frequencyZoom} onChange={setFrequencyZoom} />
            </article>
          </div>
        </section>
      ) : (
        <section className="workspace" aria-label="卷积工作台">
          <div className="control-row convolution-controls">
            <label>x({domainMode === "continuous" ? "t" : "n"})<select value={firstPreset} onChange={(event) => chooseConvolutionPreset("first", event.target.value as Preset)}>{Object.entries(presetLabels).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
            <label className="expression-input"><span className="cyan-text">x</span> 函数<input value={firstExpression} onChange={(event) => setFirstExpression(event.target.value)} spellCheck="false" /></label>
            <label>h({domainMode === "continuous" ? "t" : "n"})<select value={secondPreset} onChange={(event) => chooseConvolutionPreset("second", event.target.value as Preset)}>{Object.entries(presetLabels).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
            <label className="expression-input"><span className="pink-text">h</span> 函数<input value={secondExpression} onChange={(event) => setSecondExpression(event.target.value)} spellCheck="false" /></label>
          </div>
          <div className="plot-grid">
            <article className="plot-panel">
              <div className="plot-heading"><div><p>叠加输入</p><h2>拖动 h({domainMode === "continuous" ? "t − τ" : "n − k"})</h2></div><span className="domain-pill">τ = {shift.toFixed(2)}</span></div>
              <div className="convolution-stage">
                <SignalPlot id="convolution-first" label="卷积输入信号 x" points={firstSignal} mode={domainMode} zoom={timeZoom} accent="cyan" markerLabel="x" />
                <svg
                  ref={convolutionRef}
                  className="signal-plot signal-overlay draggable-plot"
                  viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                  aria-label="可拖动的卷积函数 h"
                  onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); setDragging(true); updateShift(event); }}
                  onPointerMove={(event) => { if (dragging) updateShift(event); }}
                  onPointerUp={(event) => { setDragging(false); event.currentTarget.releasePointerCapture(event.pointerId); }}
                  onPointerCancel={() => setDragging(false)}
                >
                  <defs><clipPath id="clip-convolution-second"><rect x={PAD.left} y={PAD.top} width={WIDTH - PAD.left - PAD.right} height={HEIGHT - PAD.top - PAD.bottom} /></clipPath></defs>
                  <g clipPath="url(#clip-convolution-second)" transform={`translate(${overlayShift} 0)`}><path className="signal-line plot-pink" d={seriesPath(secondSignal, timeZoom, convolutionMax)} /><circle className="drag-handle" cx={chartX(Math.round(SAMPLE_COUNT / 2), SAMPLE_COUNT, timeZoom)} cy={chartY(secondSignal[Math.round(SAMPLE_COUNT / 2)]?.y ?? 0, convolutionMax)} r="8" /></g>
                  <text className="plot-label pink-text" x={PAD.left + 8} y={PAD.top + 38}>h(t − τ) · 拖动</text>
                </svg>
              </div>
              <ZoomControl label="时域缩放" value={timeZoom} onChange={setTimeZoom} />
            </article>
            <article className="plot-panel">
              <div className="plot-heading"><div><p>实时卷积</p><h2>y(τ) = x * h</h2></div><span className="domain-pill">{domainMode === "continuous" ? "数值积分" : "逐项求和"}</span></div>
              <SignalPlot id="convolution-result" label="实时卷积结果" points={result} mode={domainMode} zoom={timeZoom} accent="violet" markerIndex={marker} markerLabel="y" />
              <div className="result-readout"><span>当前位置 τ = {shift.toFixed(2)}</span><strong>y(τ) = {(result[marker]?.y ?? 0).toFixed(3)}</strong></div>
            </article>
          </div>
        </section>
      )}
    </main>
  );
}
