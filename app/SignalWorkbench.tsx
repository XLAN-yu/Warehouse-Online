"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";

type DomainMode = "continuous" | "discrete";
type ToolMode = "transform" | "convolution";
type TransformKind = "fourier" | "laplace" | "z";
type Preset = "sine" | "gaussian" | "rect" | "chirp" | "decay";

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

function expressionForPreset(preset: Preset, mode: DomainMode) {
  if (mode === "continuous") return presetExpressions[preset];
  const discreteExpressions: Record<Preset, string> = {
    sine: "sin(2*pi*0.125*n)",
    gaussian: "exp(-0.001*n*n)",
    rect: "rect(n/24)",
    chirp: "sin(2*pi*0.003*n*n)",
    decay: "exp(-abs(n)/20)",
  };
  return discreteExpressions[preset];
}

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

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

type CompiledExpression = { fn: (x: number) => number; error: string | null };

function parseExpression(expression: string, fallback: Preset): CompiledExpression {
  const value = expression
    .toLowerCase()
    .replaceAll("π", "pi")
    .replace(/[·×]/g, "*")
    .replaceAll("math.", "")
    .replaceAll(" ", "")
    .replaceAll("ln", "log")
    .replaceAll("sign", "sgn")
    .replaceAll("mod", "rem")
    .replaceAll("^", "**");

  const fallbackResult = (error: string): CompiledExpression => ({ fn: presetFunction(fallback), error });
  if (!value) return fallbackResult("请输入函数表达式");
  if (!/^[0-9a-z_+\-*/%^().,?:<>=!&|]+$/i.test(value)) {
    return fallbackResult("表达式包含不支持的字符");
  }

  const allowedNames = new Set([
    "t", "n", "pi", "e", "sin", "cos", "tan", "asin", "acos", "atan", "sinh", "cosh", "tanh",
    "exp", "log", "sqrt", "abs", "floor", "ceil", "round", "min", "max", "pow", "rect", "sinc",
    "step", "sgn", "rem",
  ]);
  const names = value.match(/[a-z_][a-z0-9_]*/gi) ?? [];
  if (names.some((name) => !allowedNames.has(name))) {
    return fallbackResult("检测到不支持的函数或变量");
  }

  try {
    const evaluator = new Function(
      "t", "n", "pi", "e", "sin", "cos", "tan", "asin", "acos", "atan", "sinh", "cosh", "tanh",
      "exp", "log", "sqrt", "abs", "floor", "ceil", "round", "min", "max", "pow", "rect", "sinc",
      "step", "sgn", "rem",
      `"use strict"; return (${value});`,
    ) as (...args: unknown[]) => unknown;

    const fn = (x: number) => {
      const sinc = (input: number) => Math.abs(input) < 1e-8 ? 1 : Math.sin(Math.PI * input) / (Math.PI * input);
      const result = evaluator(
        x, x, Math.PI, Math.E, Math.sin, Math.cos, Math.tan, Math.asin, Math.acos, Math.atan, Math.sinh,
        Math.cosh, Math.tanh, Math.exp, Math.log, Math.sqrt, Math.abs, Math.floor, Math.ceil, Math.round,
        Math.min, Math.max, Math.pow, (input) => Math.abs(input) <= .5 ? 1 : 0, sinc,
        (input) => input >= 0 ? 1 : 0, Math.sign, (left, right) => left % right,
      );
      return typeof result === "number" && Number.isFinite(result) ? clamp(result, -1e6, 1e6) : 0;
    };
    fn(0);
    return { fn, error: null };
  } catch {
    return fallbackResult("表达式语法有误，已暂时显示标准函数");
  }
}

function sampleSignal(fn: (x: number) => number, mode: DomainMode, count: number) {
  return Array.from({ length: count }, (_, index) => {
    const x = mode === "continuous" ? -4 + (8 * index) / (count - 1) : index - count / 2;
    return { x, y: fn(x) };
  });
}

function complexSpectrum(
  samples: { x: number; y: number }[],
  mode: DomainMode,
  transform: TransformKind,
) {
  const count = samples.length;
  const bins = clamp(Math.round(Math.sqrt(count) * 4), 96, 256);
  const dt = mode === "continuous" ? 8 / (count - 1) : 1;
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

function nextPowerOfTwo(value: number) {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

function fft(real: number[], imaginary: number[], inverse: boolean) {
  const length = real.length;
  for (let index = 1, reversed = 0; index < length; index += 1) {
    let bit = length >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
    }
  }
  for (let segment = 2; segment <= length; segment <<= 1) {
    const angle = (2 * Math.PI / segment) * (inverse ? -1 : 1);
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < length; start += segment) {
      let unitReal = 1;
      let unitImaginary = 0;
      for (let offset = 0; offset < segment / 2; offset += 1) {
        const even = start + offset;
        const odd = even + segment / 2;
        const oddReal = real[odd] * unitReal - imaginary[odd] * unitImaginary;
        const oddImaginary = real[odd] * unitImaginary + imaginary[odd] * unitReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal = unitReal * stepReal - unitImaginary * stepImaginary;
        unitImaginary = unitReal * stepImaginary + unitImaginary * stepReal;
        unitReal = nextReal;
      }
    }
  }
  if (inverse) {
    for (let index = 0; index < length; index += 1) {
      real[index] /= length;
      imaginary[index] /= length;
    }
  }
}

function convolution(
  first: { x: number; y: number }[],
  second: { x: number; y: number }[],
  mode: DomainMode,
) {
  const count = first.length;
  const resultLength = count * 2 - 1;
  const fftLength = nextPowerOfTwo(resultLength);
  const firstReal = Array.from({ length: fftLength }, (_, index) => first[index]?.y ?? 0);
  const secondReal = Array.from({ length: fftLength }, (_, index) => second[index]?.y ?? 0);
  const firstImaginary = Array.from({ length: fftLength }, () => 0);
  const secondImaginary = Array.from({ length: fftLength }, () => 0);
  fft(firstReal, firstImaginary, false);
  fft(secondReal, secondImaginary, false);
  for (let index = 0; index < fftLength; index += 1) {
    const real = firstReal[index] * secondReal[index] - firstImaginary[index] * secondImaginary[index];
    firstImaginary[index] = firstReal[index] * secondImaginary[index] + firstImaginary[index] * secondReal[index];
    firstReal[index] = real;
  }
  fft(firstReal, firstImaginary, true);
  const step = mode === "continuous" ? 8 / (count - 1) : 1;
  const values = firstReal.slice(0, resultLength).map((value) => value * step);
  const start = mode === "continuous" ? -8 : -count;
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

function maskedSeriesPath(points: { x: number; y: number }[], visible: boolean[], zoom: number, maxValue: number) {
  let previousVisible = false;
  return points.map((point, index) => {
    const isVisible = visible[index];
    if (!isVisible) { previousVisible = false; return ""; }
    const command = previousVisible ? "L" : "M";
    previousVisible = true;
    return `${command}${chartX(index, points.length, zoom).toFixed(2)},${chartY(point.y, maxValue).toFixed(2)}`;
  }).join(" ");
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
  const [viewportWidth, setViewportWidth] = useState(1280);
  const [pixelRatio, setPixelRatio] = useState(1);
  const convolutionRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const updateViewport = () => {
      setViewportWidth(window.innerWidth);
      setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    };
    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  const sampleCount = useMemo(() => {
    if (domainMode === "discrete") return 256;
    const target = viewportWidth * pixelRatio * Math.max(1, timeZoom) * 1.45;
    return clamp(nextPowerOfTwo(Math.round(target)), 1024, 4096);
  }, [domainMode, pixelRatio, timeZoom, viewportWidth]);

  const compiledSignal = useMemo(() => parseExpression(expression, preset), [expression, preset]);
  const compiledFirst = useMemo(() => parseExpression(firstExpression, firstPreset), [firstExpression, firstPreset]);
  const compiledSecond = useMemo(() => parseExpression(secondExpression, secondPreset), [secondExpression, secondPreset]);

  const signal = useMemo(
    () => sampleSignal(compiledSignal.fn, domainMode, sampleCount),
    [compiledSignal, domainMode, sampleCount],
  );
  const spectrum = useMemo(
    () => complexSpectrum(signal, domainMode, transformKind),
    [domainMode, signal, transformKind],
  );
  const firstSignal = useMemo(
    () => sampleSignal(compiledFirst.fn, domainMode, sampleCount),
    [compiledFirst, domainMode, sampleCount],
  );
  const secondSignal = useMemo(
    () => sampleSignal(compiledSecond.fn, domainMode, sampleCount),
    [compiledSecond, domainMode, sampleCount],
  );
  const result = useMemo(
    () => convolution(firstSignal, secondSignal, domainMode),
    [domainMode, firstSignal, secondSignal],
  );
  const offsetInSamples = domainMode === "continuous"
    ? shift / (8 / (sampleCount - 1))
    : shift * (sampleCount / 16);
  const marker = clamp(Math.round((domainMode === "continuous" ? sampleCount - 1 : sampleCount) + offsetInSamples), 0, result.length - 1);
  const convolutionMax = normalizeRange([...firstSignal, ...secondSignal]);
  const overlayShift = (shift / 8) * (WIDTH - PAD.left - PAD.right) * timeZoom;
  const overlapMask = useMemo(() => {
    const threshold = normalizeRange(firstSignal) * 0.025;
    const secondThreshold = normalizeRange(secondSignal) * 0.01;
    return secondSignal.map((point, index) => {
      const firstIndex = Math.round(index + offsetInSamples);
      return firstIndex >= 0 && firstIndex < firstSignal.length
        && Math.abs(firstSignal[firstIndex].y) >= threshold
        && Math.abs(point.y) >= secondThreshold;
    });
  }, [firstSignal, offsetInSamples, secondSignal]);

  const choosePreset = (next: Preset) => {
    setPreset(next);
    setExpression(expressionForPreset(next, domainMode));
  };
  const chooseConvolutionPreset = (target: "first" | "second", next: Preset) => {
    if (target === "first") {
      setFirstPreset(next);
      setFirstExpression(expressionForPreset(next, domainMode));
    } else {
      setSecondPreset(next);
      setSecondExpression(expressionForPreset(next, domainMode));
    }
  };
  const switchDomain = (next: DomainMode) => {
    const previousMode = domainMode;
    if (expression === expressionForPreset(preset, previousMode)) setExpression(expressionForPreset(preset, next));
    if (firstExpression === expressionForPreset(firstPreset, previousMode)) setFirstExpression(expressionForPreset(firstPreset, next));
    if (secondExpression === expressionForPreset(secondPreset, previousMode)) setSecondExpression(expressionForPreset(secondPreset, next));
    setDomainMode(next);
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
  const expressionStatus = compiledSignal.error ?? compiledFirst.error ?? compiledSecond.error;
  const shiftLabel = domainMode === "continuous" ? `τ = ${shift.toFixed(2)}` : `k = ${Math.round(shift * (sampleCount / 16))}`;

  return (
    <main className="tool-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden="true" />Signal Lab</div>
        <div className="tab-group" role="group" aria-label="信号类型">
          <button className={domainMode === "continuous" ? "tab active" : "tab"} onClick={() => switchDomain("continuous")}>连续时间</button>
          <button className={domainMode === "discrete" ? "tab active" : "tab"} onClick={() => switchDomain("discrete")}>离散时间</button>
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
            <span className={expressionStatus ? "status-dot error" : "status-dot"}>{expressionStatus ?? `${sampleCount} 点自适应采样`}</span>
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
              <div className="plot-heading"><div><p>叠加输入</p><h2>拖动 h({domainMode === "continuous" ? "t − τ" : "n − k"})</h2></div><span className="domain-pill">{shiftLabel}</span></div>
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
                  <g clipPath="url(#clip-convolution-second)" transform={`translate(${overlayShift} 0)`}><path className="signal-line plot-muted" d={seriesPath(secondSignal, timeZoom, convolutionMax)} /><path className="signal-line plot-pink" d={maskedSeriesPath(secondSignal, overlapMask, timeZoom, convolutionMax)} /><circle className="drag-handle" cx={chartX(Math.round(sampleCount / 2), sampleCount, timeZoom)} cy={chartY(secondSignal[Math.round(sampleCount / 2)]?.y ?? 0, convolutionMax)} r="8" /></g>
                  <text className="plot-label pink-text" x={PAD.left + 8} y={PAD.top + 38}>粉色：重叠部分　灰色：未重叠</text>
                </svg>
              </div>
              <ZoomControl label="时域缩放" value={timeZoom} onChange={setTimeZoom} />
            </article>
            <article className="plot-panel">
              <div className="plot-heading"><div><p>实时卷积</p><h2>y(τ) = x * h</h2></div><span className="domain-pill">{domainMode === "continuous" ? "数值积分" : "逐项求和"}</span></div>
              <SignalPlot id="convolution-result" label="实时卷积结果" points={result} mode={domainMode} zoom={timeZoom} accent="violet" markerIndex={marker} markerLabel="y" />
              <div className="result-readout"><span>当前位置 {shiftLabel}</span><strong>y = {(result[marker]?.y ?? 0).toFixed(3)}</strong></div>
            </article>
          </div>
        </section>
      )}
    </main>
  );
}
