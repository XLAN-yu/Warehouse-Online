"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import {
  SIGNAL_PRESETS,
  approximateComplexTransform,
  clamp,
  compileExpression,
  convolve,
  defaultPreset,
  expressionForPreset,
  forwardFourier,
  inverseFromExpression,
  inverseFromFourier,
  sampleSignal,
  visibleSpectrum,
  type ComplexPoint,
  type DomainMode,
  type Point,
} from "./signalEngine";
import { TimeFrequencyCube } from "./TimeFrequencyCube";

type ToolMode = "transform" | "convolution" | "cube";
type TransformKind = "fourier" | "laplace" | "z";
type TransformDirection = "forward" | "inverse";
type InverseSource = "current" | "formula";
type PropertyId = "free" | "linear" | "timeShift" | "frequencyShift" | "scale" | "convolution" | "product" | "differentiate" | "integrate" | "parseval" | "duality" | "conjugate";

const WIDTH = 620;
const HEIGHT = 300;
const PAD = { left: 48, right: 20, top: 24, bottom: 38 };

const FOURIER_PROPERTIES: { id: PropertyId; label: string; time: string; frequency: string; note: string }[] = [
  { id: "free", label: "自由分析", time: "x(t)", frequency: "X(jω)", note: "直接编辑输入信号并观察数值变换。" },
  { id: "linear", label: "线性", time: "a·x₁(t) + b·x₂(t)", frequency: "a·X₁(jω) + b·X₂(jω)", note: "叠加原理。" },
  { id: "timeShift", label: "时移", time: "x(t − t₀)", frequency: "X(jω)e^(−jωt₀)", note: "拖动时域信号；幅度不变，相位随 t₀ 线性变化。" },
  { id: "frequencyShift", label: "频移", time: "x(t)e^(jω₀t)", frequency: "X(j(ω − ω₀))", note: "调制的基础。" },
  { id: "scale", label: "尺度变换", time: "x(at)", frequency: "(1/|a|)X(jω/a)", note: "时域压缩会带来频域展宽。" },
  { id: "convolution", label: "时域卷积", time: "x(t) * h(t)", frequency: "X(jω)H(jω)", note: "卷积定理；卷积工作台可直接验证。" },
  { id: "product", label: "时域乘积", time: "x(t)h(t)", frequency: "(1/2π)[X * H](jω)", note: "时域相乘对应频域卷积。" },
  { id: "differentiate", label: "时域微分", time: "dⁿx(t)/dtⁿ", frequency: "(jω)ⁿX(jω)", note: "微分方程可转化为代数方程。" },
  { id: "integrate", label: "时域积分", time: "∫₋∞ᵗx(τ)dτ", frequency: "X(jω)/(jω)+πX(0)δ(ω)", note: "频域表达式需要注意冲激项。" },
  { id: "parseval", label: "帕塞瓦尔", time: "∫|x(t)|²dt", frequency: "(1/2π)∫|X(jω)|²dω", note: "时域能量与频域能量相等。" },
  { id: "duality", label: "对偶性", time: "X(t)", frequency: "2πx(−ω)", note: "时域与频域之间存在对称关系。" },
  { id: "conjugate", label: "共轭对称", time: "x(t) 为实信号", frequency: "X(−jω)=X*(jω)", note: "幅度偶对称、相位奇对称。" },
];

const SHORTCUTS = [
  ["π", "pi"], ["e", "e"], ["x²", "^2"], ["eˣ", "exp()"], ["sin", "sin()"], ["cos", "cos()"],
  ["tan", "tan()"], ["√", "sqrt()"], ["|x|", "abs()"], ["Sa", "sa()"], ["u(t)", "step()"], ["δ", "delta()"],
  ["rect", "rect()"], ["tri", "tri()"], ["分段", " ?  : "],
] as const;

const normalizeRange = (points: Point[]) => Math.max(0.2, ...points.filter((point) => Number.isFinite(point.y)).map((point) => Math.abs(point.y)));
const chartX = (index: number, count: number, zoom: number) => PAD.left + (WIDTH - PAD.left - PAD.right) / 2 + ((index / Math.max(count - 1, 1) - .5) * (WIDTH - PAD.left - PAD.right) * zoom);
const chartY = (value: number, maximum: number) => PAD.top + (HEIGHT - PAD.top - PAD.bottom) / 2 - (value / maximum) * ((HEIGHT - PAD.top - PAD.bottom) * .42);

function seriesPath(points: Point[], zoom: number, maximum: number, active?: boolean[]) {
  let previousVisible = false;
  return points.map((point, index) => {
    const visible = Number.isFinite(point.y) && (active?.[index] ?? true);
    if (!visible) { previousVisible = false; return ""; }
    const command = previousVisible ? "L" : "M";
    previousVisible = true;
    return `${command}${chartX(index, points.length, zoom).toFixed(2)},${chartY(point.y, maximum).toFixed(2)}`;
  }).join(" ");
}

function AxisGrid({ label }: { label: string }) {
  const vertical = Array.from({ length: 8 }, (_, index) => PAD.left + ((WIDTH - PAD.left - PAD.right) * index) / 7);
  const horizontal = Array.from({ length: 5 }, (_, index) => PAD.top + ((HEIGHT - PAD.top - PAD.bottom) * index) / 4);
  return <>
    {vertical.map((x) => <line key={`v-${x}`} className="grid-line" x1={x} x2={x} y1={PAD.top} y2={HEIGHT - PAD.bottom} />)}
    {horizontal.map((y) => <line key={`h-${y}`} className="grid-line" x1={PAD.left} x2={WIDTH - PAD.right} y1={y} y2={y} />)}
    <line className="axis-line" x1={PAD.left} x2={WIDTH - PAD.right} y1={HEIGHT / 2} y2={HEIGHT / 2} />
    <line className="axis-line" x1={WIDTH / 2} x2={WIDTH / 2} y1={PAD.top} y2={HEIGHT - PAD.bottom} />
    <text className="axis-caption" x={WIDTH - PAD.right} y={HEIGHT - 10} textAnchor="end">{label}</text>
  </>;
}

function SignalPlot({ id, label, points, mode, zoom, accent, markerIndex, markerLabel, onPointerDown, onPointerMove, onPointerUp }: {
  id: string; label: string; points: Point[]; mode: DomainMode; zoom: number; accent: "cyan" | "pink" | "violet";
  markerIndex?: number; markerLabel?: string;
  onPointerDown?: (event: PointerEvent<SVGSVGElement>) => void; onPointerMove?: (event: PointerEvent<SVGSVGElement>) => void; onPointerUp?: (event: PointerEvent<SVGSVGElement>) => void;
}) {
  const maximum = normalizeRange(points); const clipId = `clip-${id}`; const colorClass = `plot-${accent}`;
  const markerX = markerIndex === undefined ? 0 : chartX(markerIndex, points.length, zoom);
  const markerY = markerIndex === undefined ? 0 : chartY(points[markerIndex]?.y ?? 0, maximum);
  return <svg className={`signal-plot ${onPointerDown ? "draggable-plot" : ""}`} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={label} draggable={false} onDragStart={(event) => event.preventDefault()} onPointerDown={onPointerDown ? (event) => { event.preventDefault(); onPointerDown(event); } : undefined} onPointerMove={onPointerMove ? (event) => { event.preventDefault(); onPointerMove(event); } : undefined} onPointerUp={onPointerUp ? (event) => { event.preventDefault(); onPointerUp(event); } : undefined} onPointerCancel={onPointerUp ? (event) => { event.preventDefault(); onPointerUp(event); } : undefined}>
    <defs><clipPath id={clipId}><rect x={PAD.left} y={PAD.top} width={WIDTH - PAD.left - PAD.right} height={HEIGHT - PAD.top - PAD.bottom} /></clipPath></defs>
    <AxisGrid label={mode === "continuous" ? "t" : "n"} />
    <g clipPath={`url(#${clipId})`}>
      {mode === "continuous" ? <>
        <path className={`signal-line ${colorClass}`} d={seriesPath(points, zoom, maximum)} />
      </> : points.map((point, index) => {
        if (!Number.isFinite(point.y)) return null;
        const x = chartX(index, points.length, zoom); const y = chartY(point.y, maximum);
        return <g key={index} className={colorClass}><line className="stem" x1={x} x2={x} y1={HEIGHT / 2} y2={y} /><circle className="point" cx={x} cy={y} r="3.1" /></g>;
      })}
      {markerIndex !== undefined && <g className="result-marker"><line x1={markerX} x2={markerX} y1={PAD.top} y2={HEIGHT - PAD.bottom} /><circle className={`point ${colorClass}`} cx={markerX} cy={markerY} r="5" /></g>}
    </g>
    {markerLabel && <text className="plot-label" x={PAD.left + 8} y={PAD.top + 18}>{markerLabel}</text>}
  </svg>;
}

function frequencyPath(points: ComplexPoint[], zoom: number, value: (point: ComplexPoint) => number, top: number, bottom: number, maximum: number) {
  let started = false;
  return points.map((point, index) => {
    const current = value(point); if (!Number.isFinite(current)) { started = false; return ""; }
    const x = chartX(index, points.length, zoom); const y = bottom - ((current / maximum) * (bottom - top)); const command = started ? "L" : "M"; started = true;
    return `${command}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
}

function FrequencyPlot({ points, zoom, label }: { points: ComplexPoint[]; zoom: number; label: string }) {
  const maximum = Math.max(1e-8, ...points.map((point) => point.magnitude));
  const magnitude = frequencyPath(points, zoom, (point) => point.magnitude, 36, 172, maximum);
  const phase = frequencyPath(points, zoom, (point) => (point.phase + Math.PI) / (2 * Math.PI), 208, 264, 1);
  const x0 = chartX(0, points.length, zoom); const x1 = chartX(points.length - 1, points.length, zoom);
  return <svg className="signal-plot" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={label}>
    <AxisGrid label="ω" />
    <line className="spectrum-divider" x1={PAD.left} x2={WIDTH - PAD.right} y1="195" y2="195" />
    <path className="spectrum-area" d={`${magnitude} L${x1},172 L${x0},172 Z`} />
    <path className="signal-line plot-pink" d={magnitude} />
    <path className="phase-line" d={phase} />
    <text className="plot-label pink-text" x={PAD.left + 8} y="32">幅度 |X|</text><text className="plot-label violet-text" x={PAD.left + 8} y="207">相位 ∠X（时移时实时变化）</text>
  </svg>;
}

function ZoomControl({ value, onChange, label }: { value: number; onChange: (value: number) => void; label: string }) {
  return <label className="zoom-control"><span>{label}</span><output>{value.toFixed(1)}×</output><input type="range" min="0.5" max="2.4" step="0.1" value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function displayPresetOptions(mode: DomainMode) {
  return SIGNAL_PRESETS[mode].map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>);
}

export function SignalWorkbench() {
  const [domainMode, setDomainMode] = useState<DomainMode>("continuous");
  const [toolMode, setToolMode] = useState<ToolMode>("transform");
  const [transformKind, setTransformKind] = useState<TransformKind>("fourier");
  const [direction, setDirection] = useState<TransformDirection>("forward");
  const [preset, setPreset] = useState(defaultPreset("continuous"));
  const [expression, setExpression] = useState(expressionForPreset(defaultPreset("continuous"), "continuous"));
  const [inverseExpression, setInverseExpression] = useState("exp(-0.08*omega^2)");
  const [inverseSource, setInverseSource] = useState<InverseSource>("current");
  const [expressionTarget, setExpressionTarget] = useState<"time" | "frequency">("time");
  const [propertyId, setPropertyId] = useState<PropertyId>("timeShift");
  const [propertyShift, setPropertyShift] = useState(0);
  const [draggingTime, setDraggingTime] = useState(false);
  const [timeZoom, setTimeZoom] = useState(1);
  const [frequencyZoom, setFrequencyZoom] = useState(1);
  const [firstPreset, setFirstPreset] = useState(defaultPreset("continuous"));
  const [secondPreset, setSecondPreset] = useState("c-rect");
  const [firstExpression, setFirstExpression] = useState(expressionForPreset(defaultPreset("continuous"), "continuous"));
  const [secondExpression, setSecondExpression] = useState(expressionForPreset("c-rect", "continuous"));
  const [shift, setShift] = useState(0);
  const [draggingConvolution, setDraggingConvolution] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(1280);
  const [pixelRatio, setPixelRatio] = useState(1);
  const timeInputRef = useRef<HTMLInputElement>(null);
  const frequencyInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const updateViewport = () => { setViewportWidth(window.innerWidth); setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); };
    updateViewport(); window.addEventListener("resize", updateViewport); return () => window.removeEventListener("resize", updateViewport);
  }, []);

  const sampleCount = useMemo(() => {
    if (domainMode === "discrete") return 128;
    const target = viewportWidth * pixelRatio * Math.max(1, timeZoom) * 1.45;
    let result = 1; while (result < target) result *= 2; return clamp(result, 1024, 4096);
  }, [domainMode, pixelRatio, timeZoom, viewportWidth]);

  const parsedSignal = useMemo(() => compileExpression(expression), [expression]);
  const parsedInverse = useMemo(() => compileExpression(inverseExpression), [inverseExpression]);
  const parsedFirst = useMemo(() => compileExpression(firstExpression), [firstExpression]);
  const parsedSecond = useMemo(() => compileExpression(secondExpression), [secondExpression]);
  const signalFn = parsedSignal.fn;
  const firstFn = parsedFirst.fn;
  const secondFn = parsedSecond.fn;
  const appliedShift = propertyId === "timeShift" && direction === "forward" && transformKind === "fourier" ? propertyShift : 0;

  const signal = useMemo(() => sampleSignal(signalFn, domainMode, sampleCount, appliedShift), [appliedShift, domainMode, sampleCount, signalFn]);
  const fourier = useMemo(() => forwardFourier(signal, domainMode), [domainMode, signal]);
  const approximate = useMemo(() => transformKind === "fourier" ? null : approximateComplexTransform(signal, domainMode, transformKind), [domainMode, signal, transformKind]);
  const inverseFormula = useMemo(() => inverseFromExpression(parsedInverse.fn, domainMode, sampleCount), [domainMode, parsedInverse.fn, sampleCount]);
  const inverseTime = inverseSource === "current" ? inverseFromFourier(fourier) : inverseFormula.time;
  const inverseSpectrum = inverseSource === "current" ? fourier.points : inverseFormula.spectrum;
  const spectrum = transformKind === "fourier" ? fourier.points : approximate ?? fourier.points;
  const displaySpectrum = useMemo(() => visibleSpectrum(spectrum, domainMode), [domainMode, spectrum]);
  const displayInverseSpectrum = useMemo(() => visibleSpectrum(inverseSpectrum, domainMode), [domainMode, inverseSpectrum]);

  const firstSignal = useMemo(() => sampleSignal(firstFn, domainMode, sampleCount), [domainMode, firstFn, sampleCount]);
  const secondSignal = useMemo(() => sampleSignal(secondFn, domainMode, sampleCount), [domainMode, secondFn, sampleCount]);
  const sampleStep = domainMode === "continuous" ? 8 / Math.max(sampleCount - 1, 1) : 1;
  const reversedSecond = useMemo(() => secondSignal.map((point) => ({ x: point.x, y: secondFn(-point.x, "time", sampleStep) })), [sampleStep, secondFn, secondSignal]);
  const convolutionResult = useMemo(() => convolve(firstSignal, secondSignal, domainMode), [domainMode, firstSignal, secondSignal]);
  const shiftSamples = domainMode === "continuous" ? shift / (8 / Math.max(sampleCount - 1, 1)) : Math.round(shift);
  const resultMarker = clamp(Math.round((domainMode === "continuous" ? sampleCount - 1 : sampleCount) + shiftSamples), 0, convolutionResult.length - 1);
  const convolutionMaximum = normalizeRange([...firstSignal, ...secondSignal]);
  const overlayShift = domainMode === "continuous" ? (shift / 8) * (WIDTH - PAD.left - PAD.right) * timeZoom : (shift / sampleCount) * (WIDTH - PAD.left - PAD.right) * timeZoom;
  const overlapMask = useMemo(() => {
    const firstStart = firstSignal[0]?.x ?? 0;
    const firstEnd = firstSignal.at(-1)?.x ?? 0;
    return reversedSecond.map((point) => {
      const movedX = point.x + shift;
      return Number.isFinite(point.y) && movedX >= firstStart && movedX <= firstEnd;
    });
  }, [firstSignal, reversedSecond, shift]);

  const selectedProperty = FOURIER_PROPERTIES.find((item) => item.id === propertyId) ?? FOURIER_PROPERTIES[0];
  const sourceExpressionError = direction === "inverse" && inverseSource === "formula" ? parsedInverse.error : parsedSignal.error;
  const convolutionError = parsedFirst.error ?? parsedSecond.error;
  const transformTitle = transformKind === "fourier"
    ? domainMode === "continuous" ? (direction === "forward" ? "连续时间傅里叶变换 CTFT" : "连续时间逆傅里叶变换 ICTFT") : (direction === "forward" ? "离散傅里叶变换 DFT" : "离散逆傅里叶变换 IDFT")
    : transformKind === "laplace" ? "拉普拉斯变换" : "Z 变换";
  const shiftLabel = domainMode === "continuous" ? `t₀ = ${propertyShift.toFixed(2)} s` : `n₀ = ${Math.round(propertyShift)}`;
  const convolutionShiftLabel = domainMode === "continuous" ? `τ = ${shift.toFixed(2)} s` : `k = ${Math.round(shift)}`;

  const switchDomain = (next: DomainMode) => {
    const currentPresetStillValid = SIGNAL_PRESETS[next].some((item) => item.id === preset);
    const nextPreset = currentPresetStillValid ? preset : defaultPreset(next);
    const timeWasPreset = expression === expressionForPreset(preset, domainMode);
    const firstWasPreset = firstExpression === expressionForPreset(firstPreset, domainMode);
    const secondWasPreset = secondExpression === expressionForPreset(secondPreset, domainMode);
    const nextFirst = SIGNAL_PRESETS[next].some((item) => item.id === firstPreset) ? firstPreset : defaultPreset(next);
    const nextSecond = SIGNAL_PRESETS[next].some((item) => item.id === secondPreset) ? secondPreset : next === "continuous" ? "c-rect" : "d-step";
    if (timeWasPreset) setExpression(expressionForPreset(nextPreset, next));
    if (firstWasPreset) setFirstExpression(expressionForPreset(nextFirst, next));
    if (secondWasPreset) setSecondExpression(expressionForPreset(nextSecond, next));
    setPreset(nextPreset); setFirstPreset(nextFirst); setSecondPreset(nextSecond); setPropertyShift(0); setShift(0); setDomainMode(next);
  };
  const choosePreset = (next: string, target: "main" | "first" | "second") => {
    if (target === "main") { setPreset(next); setExpression(expressionForPreset(next, domainMode)); }
    if (target === "first") { setFirstPreset(next); setFirstExpression(expressionForPreset(next, domainMode)); }
    if (target === "second") { setSecondPreset(next); setSecondExpression(expressionForPreset(next, domainMode)); }
  };
  const insertShortcut = (token: string) => {
    const input = expressionTarget === "time" ? timeInputRef.current : frequencyInputRef.current;
    const current = expressionTarget === "time" ? expression : inverseExpression;
    if (!input) return;
    const start = input.selectionStart ?? current.length; const end = input.selectionEnd ?? current.length;
    const next = `${current.slice(0, start)}${token}${current.slice(end)}`;
    expressionTarget === "time" ? setExpression(next) : setInverseExpression(next);
    requestAnimationFrame(() => { input.focus(); const cursor = start + token.length - (token.endsWith("()") ? 1 : 0); input.setSelectionRange(cursor, cursor); });
  };
  const updateTimeShift = (event: PointerEvent<SVGSVGElement>) => {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect(); const ratio = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
    const value = ((ratio - .5) * (domainMode === "continuous" ? 8 : sampleCount)) / timeZoom;
    setPropertyShift(domainMode === "continuous" ? Number(value.toFixed(2)) : Math.round(value));
  };
  const updateConvolutionShift = (event: PointerEvent<SVGSVGElement>) => {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect(); const ratio = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
    const value = ((ratio - .5) * (domainMode === "continuous" ? 8 : sampleCount)) / timeZoom;
    setShift(domainMode === "continuous" ? Number(value.toFixed(2)) : Math.round(value));
  };
  const selectTransform = (next: TransformKind) => { setTransformKind(next); if (next !== "fourier") setDirection("forward"); };

  return <main className="tool-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true" />Signal Lab</div>
      <div className="tab-group" role="group" aria-label="信号类型"><button className={domainMode === "continuous" ? "tab active" : "tab"} onClick={() => switchDomain("continuous")}>连续时间</button><button className={domainMode === "discrete" ? "tab active" : "tab"} onClick={() => switchDomain("discrete")}>离散时间</button></div>
      <div className="tab-group" role="group" aria-label="分析工具"><button className={toolMode === "transform" ? "tab active" : "tab"} onClick={() => setToolMode("transform")}>时频变换</button><button className={toolMode === "convolution" ? "tab active" : "tab"} onClick={() => setToolMode("convolution")}>卷积</button><button className={toolMode === "cube" ? "tab active" : "tab"} onClick={() => setToolMode("cube")}>时频立方体</button></div>
    </header>

    {toolMode === "transform" ? <section className="workspace" aria-label="傅里叶变换工作台">
      <div className="control-row transform-controls">
        <label>标准信号<select value={preset} onChange={(event) => choosePreset(event.target.value, "main")}>{displayPresetOptions(domainMode)}</select></label>
        <label className="expression-input">函数表达式 x({domainMode === "continuous" ? "t" : "n"})<input ref={expressionTarget === "time" ? timeInputRef : undefined} value={expression} onFocus={() => setExpressionTarget("time")} onChange={(event) => setExpression(event.target.value)} spellCheck="false" /></label>
        <label>变换<select value={transformKind} onChange={(event) => selectTransform(event.target.value as TransformKind)}><option value="fourier">傅里叶变换</option><option value="laplace">拉普拉斯变换</option><option value="z">Z 变换</option></select></label>
        <div className="direction-toggle" role="group" aria-label="变换方向"><button className={direction === "forward" ? "mini-tab active" : "mini-tab"} onClick={() => setDirection("forward")}>正变换</button><button disabled={transformKind !== "fourier"} className={direction === "inverse" ? "mini-tab active" : "mini-tab"} onClick={() => setDirection("inverse")}>逆变换</button></div>
        <span className={sourceExpressionError ? "status-dot error" : "status-dot"}>{sourceExpressionError ? `采样暂停：${sourceExpressionError}` : `${sampleCount} 点实时数值采样`}</span>
      </div>
      {direction === "inverse" && transformKind === "fourier" && <div className="inverse-row"><div className="direction-toggle" role="group" aria-label="逆变换频谱来源"><button className={inverseSource === "current" ? "mini-tab active" : "mini-tab"} onClick={() => setInverseSource("current")}>使用当前频谱</button><button className={inverseSource === "formula" ? "mini-tab active" : "mini-tab"} onClick={() => setInverseSource("formula")}>输入频域函数</button></div>{inverseSource === "formula" && <label className="expression-input inverse-expression">X({domainMode === "continuous" ? "ω" : "k"})<input ref={expressionTarget === "frequency" ? frequencyInputRef : undefined} value={inverseExpression} onFocus={() => setExpressionTarget("frequency")} onChange={(event) => setInverseExpression(event.target.value)} spellCheck="false" /></label>}</div>}
      <div className="shortcut-bar" aria-label="数学符号快捷输入">{SHORTCUTS.map(([label, token]) => <button key={label} type="button" onClick={() => insertShortcut(token)}>{label}</button>)}</div>
      {transformKind === "fourier" && <aside className="property-panel"><label>傅里叶性质<select value={propertyId} onChange={(event) => setPropertyId(event.target.value as PropertyId)}>{FOURIER_PROPERTIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><div className="property-formula"><strong>{selectedProperty.label}</strong><code>{selectedProperty.time}　↔　{selectedProperty.frequency}</code><span>{selectedProperty.note}</span>{propertyId === "timeShift" && direction === "forward" && <b>已启用拖动：{shiftLabel}</b>}</div></aside>}
      <div className="plot-grid">
        <article className="plot-panel">
          <div className="plot-heading"><div><p>{direction === "forward" ? "输入信号" : "频域输入"}</p><h2>{direction === "forward" ? (domainMode === "continuous" ? "时域 x(t)" : "时域 x[n]") : (domainMode === "continuous" ? "频域 X(ω)" : "频域 X[k]")}</h2></div><span className="domain-pill">{direction === "forward" ? (domainMode === "continuous" ? "−4 … 4 s" : "n = −64 … 63") : "复频谱"}</span></div>
          {direction === "forward" ? <SignalPlot id="time-main" label="时域输入信号" points={signal} mode={domainMode} zoom={timeZoom} accent="cyan" markerLabel="x" onPointerDown={propertyId === "timeShift" && transformKind === "fourier" ? (event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setDraggingTime(true); updateTimeShift(event); } : undefined} onPointerMove={draggingTime ? updateTimeShift : undefined} onPointerUp={(event) => { event.preventDefault(); if (draggingTime && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); setDraggingTime(false); }} /> : <FrequencyPlot points={displayInverseSpectrum} zoom={frequencyZoom} label="逆变换频域输入" />}
          <ZoomControl label={direction === "forward" ? "时域缩放" : "频域缩放"} value={direction === "forward" ? timeZoom : frequencyZoom} onChange={direction === "forward" ? setTimeZoom : setFrequencyZoom} />
        </article>
        <article className="plot-panel">
          <div className="plot-heading"><div><p>{transformTitle}</p><h2>{direction === "forward" ? (transformKind === "fourier" ? "频域 |X(ω)| 与 ∠X" : transformKind === "laplace" ? "s 域 |X(s)|" : "z 域 |X(z)|") : (domainMode === "continuous" ? "时域重建 x(t)" : "离散重建 x[n]")}</h2></div><span className="domain-pill">{direction === "forward" ? "复数数值计算" : "逆变换重建"}</span></div>
          {direction === "forward" ? <FrequencyPlot points={displaySpectrum} zoom={frequencyZoom} label="傅里叶频谱与相位" /> : <SignalPlot id="inverse-time" label="逆傅里叶重建信号" points={inverseTime} mode={domainMode} zoom={timeZoom} accent="violet" markerLabel="x" />}
          <ZoomControl label={direction === "forward" ? "频域缩放" : "时域缩放"} value={direction === "forward" ? frequencyZoom : timeZoom} onChange={direction === "forward" ? setFrequencyZoom : setTimeZoom} />
        </article>
      </div>
    </section> : toolMode === "convolution" ? <section className="workspace" aria-label="卷积工作台">
      <div className="control-row convolution-controls">
        <label>x({domainMode === "continuous" ? "t" : "n"})<select value={firstPreset} onChange={(event) => choosePreset(event.target.value, "first")}>{displayPresetOptions(domainMode)}</select></label>
        <label className="expression-input"><span className="cyan-text">x</span> 函数<input value={firstExpression} onChange={(event) => setFirstExpression(event.target.value)} spellCheck="false" /></label>
        <label>h({domainMode === "continuous" ? "t" : "n"})<select value={secondPreset} onChange={(event) => choosePreset(event.target.value, "second")}>{displayPresetOptions(domainMode)}</select></label>
        <label className="expression-input"><span className="pink-text">h</span> 函数<input value={secondExpression} onChange={(event) => setSecondExpression(event.target.value)} spellCheck="false" /></label>
        <span className={convolutionError ? "status-dot error" : "status-dot"}>{convolutionError ? `卷积暂停：${convolutionError}` : "FFT 数值卷积"}</span>
      </div>
      <div className="shortcut-bar convolution-shortcuts" aria-label="数学符号快捷输入">{SHORTCUTS.slice(0, 12).map(([label, token]) => <button key={label} type="button" onClick={() => setFirstExpression((current) => `${current}${token}`)}>{label}</button>)}</div>
      <div className="plot-grid">
        <article className="plot-panel"><div className="plot-heading"><div><p>叠加输入</p><h2>拖动 h({domainMode === "continuous" ? "τ − t" : "k − n"})</h2></div><span className="domain-pill">{convolutionShiftLabel}</span></div><div className="convolution-stage"><SignalPlot id="convolution-first" label="卷积输入信号 x" points={firstSignal} mode={domainMode} zoom={timeZoom} accent="cyan" markerLabel="x" /><svg className="signal-plot signal-overlay draggable-plot" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-label="可拖动的时间翻转卷积函数" draggable={false} onDragStart={(event) => event.preventDefault()} onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setDraggingConvolution(true); updateConvolutionShift(event); }} onPointerMove={draggingConvolution ? updateConvolutionShift : undefined} onPointerUp={(event) => { event.preventDefault(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); setDraggingConvolution(false); }} onPointerCancel={(event) => { event.preventDefault(); setDraggingConvolution(false); }}><defs><clipPath id="clip-convolution-second"><rect x={PAD.left} y={PAD.top} width={WIDTH - PAD.left - PAD.right} height={HEIGHT - PAD.top - PAD.bottom} /></clipPath></defs><g clipPath="url(#clip-convolution-second)" transform={`translate(${overlayShift} 0)`}><path className="signal-line plot-muted" d={seriesPath(reversedSecond, timeZoom, convolutionMaximum)} /><path className="signal-line plot-pink" d={seriesPath(reversedSecond, timeZoom, convolutionMaximum, overlapMask)} /><circle className="drag-handle" cx={chartX(Math.floor(sampleCount / 2), sampleCount, timeZoom)} cy={chartY(reversedSecond[Math.floor(sampleCount / 2)]?.y ?? 0, convolutionMaximum)} r="8" /></g><text className="plot-label pink-text" x={PAD.left + 8} y={PAD.top + 38}>粉色：当前重叠　灰色：未重叠</text></svg></div><ZoomControl label="时域缩放" value={timeZoom} onChange={setTimeZoom} /></article>
        <article className="plot-panel"><div className="plot-heading"><div><p>实时卷积</p><h2>y(τ) = ∫x(t)h(τ − t)dt</h2></div><span className="domain-pill">{domainMode === "continuous" ? "数值积分" : "逐项求和"}</span></div><SignalPlot id="convolution-result" label="实时卷积结果" points={convolutionResult} mode={domainMode} zoom={timeZoom} accent="violet" markerIndex={resultMarker} markerLabel="y" /><div className="result-readout"><span>当前位置 {convolutionShiftLabel}</span><strong>y = {(convolutionResult[resultMarker]?.y ?? 0).toFixed(3)}</strong></div></article>
      </div>
    </section> : <TimeFrequencyCube signal={signal} spectrum={fourier.points} mode={domainMode} />}
  </main>;
}
