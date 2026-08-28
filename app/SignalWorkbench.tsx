"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import {
  SIGNAL_PRESETS,
  approximateComplexTransform,
  clamp,
  compileExpression,
  convolve,
  convolutionFrame,
  defaultPreset,
  differentiateSignal,
  expressionForPreset,
  frequencyScaleSpectrum,
  frequencyShiftSpectrum,
  forwardFourier,
  integrateSignal,
  inverseFromExpression,
  inverseFromFourier,
  linearCombineSignals,
  modulateSignal,
  parsevalEnergy,
  sampleSignal,
  timeScaleSignal,
  timeShiftSignal,
  visibleSpectrum,
  type ComplexPoint,
  type DomainMode,
  type Point,
} from "./signalEngine";
import { FourierGeometryLab } from "./FourierGeometryLab";
import { TimeFrequencyCube } from "./TimeFrequencyCube";
import { DspConceptLab } from "./DspConceptLab";

type ToolMode = "transform" | "convolution" | "cube" | "geometry" | "dsp";
type TransformKind = "fourier" | "laplace" | "z";
type TransformDirection = "forward" | "inverse";
type InverseSource = "current" | "formula";
type PropertyId = "free" | "linear" | "timeShift" | "frequencyShift" | "scale" | "convolution" | "product" | "differentiate" | "integrate" | "parseval" | "duality" | "conjugate";
type PlotAccent = "cyan" | "pink" | "violet" | "amber" | "mint";
type SignalSeries = { id: string; label: string; points: Point[]; accent: PlotAccent };
type SpectrumSeries = { id: string; label: string; points: ComplexPoint[]; accent: PlotAccent };
type DomainSnapshot = {
  preset: string; expression: string; inverseExpression: string; inverseSource: InverseSource;
  transformKind: TransformKind; direction: TransformDirection; propertyId: PropertyId;
  propertyShift: number; frequencyShift: number; scaleFactor: number;
  linearA: number; linearB: number; linearFirstPreset: string; linearSecondPreset: string; linearFirstExpression: string; linearSecondExpression: string;
  timeZoom: number; frequencyZoom: number; discreteSampleCount: number;
  firstPreset: string; secondPreset: string; firstExpression: string; secondExpression: string; shift: number;
};

const WIDTH = 620;
const HEIGHT = 300;
const PAD = { left: 48, right: 20, top: 24, bottom: 38 };
const DEFAULT_ZOOM = 1;
const MAX_ZOOM = 16;
const DEFAULT_DISCRETE_SAMPLE_COUNT = 128;

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

function fallbackSecondPreset(mode: DomainMode) { return mode === "continuous" ? "c-rect" : "d-step"; }

function createDomainSnapshot(mode: DomainMode): DomainSnapshot {
  const primary = defaultPreset(mode);
  const secondary = fallbackSecondPreset(mode);
  return {
    preset: primary,
    expression: expressionForPreset(primary, mode),
    inverseExpression: "exp(-0.08*omega^2)", inverseSource: "current",
    transformKind: "fourier", direction: "forward", propertyId: "timeShift",
    propertyShift: 0, frequencyShift: 0, scaleFactor: 1,
    linearA: 1, linearB: 0.65,
    linearFirstPreset: primary, linearSecondPreset: secondary,
    linearFirstExpression: expressionForPreset(primary, mode), linearSecondExpression: expressionForPreset(secondary, mode),
    timeZoom: DEFAULT_ZOOM, frequencyZoom: DEFAULT_ZOOM, discreteSampleCount: DEFAULT_DISCRETE_SAMPLE_COUNT,
    firstPreset: primary, secondPreset: secondary,
    firstExpression: expressionForPreset(primary, mode), secondExpression: expressionForPreset(secondary, mode), shift: 0,
  };
}

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

function pointwise(first: Point[], second: Point[], operation: (a: number, b: number) => number) {
  return first.map((point, index) => ({ x: point.x, y: operation(point.y, second[index]?.y ?? 0) }));
}

function differentiatePoints(points: Point[], mode: DomainMode) {
  const step = mode === "continuous" ? Math.abs((points[1]?.x ?? 1) - (points[0]?.x ?? 0)) || 1 : 1;
  return points.map((point, index) => {
    const before = points[Math.max(0, index - 1)]?.y ?? point.y;
    const after = points[Math.min(points.length - 1, index + 1)]?.y ?? point.y;
    return { x: point.x, y: mode === "continuous" && index > 0 && index < points.length - 1 ? (after - before) / (2 * step) : index === 0 ? (after - point.y) / step : (point.y - before) / step };
  });
}

function integratePoints(points: Point[], mode: DomainMode) {
  const step = mode === "continuous" ? Math.abs((points[1]?.x ?? 1) - (points[0]?.x ?? 0)) || 1 : 1;
  let total = 0;
  return points.map((point, index) => {
    if (index > 0) total += mode === "continuous" ? ((points[index - 1]?.y ?? 0) + point.y) * step / 2 : point.y;
    return { x: point.x, y: total };
  });
}

function signalEnergy(points: Point[], mode: DomainMode) {
  const step = mode === "continuous" ? Math.abs((points[1]?.x ?? 1) - (points[0]?.x ?? 0)) || 1 : 1;
  return points.reduce((sum, point) => sum + (Number.isFinite(point.y) ? point.y ** 2 : 0), 0) * step;
}

function spectralEnergy(points: ComplexPoint[]) {
  const step = Math.abs((points[1]?.x ?? 1) - (points[0]?.x ?? 0)) || 1;
  return points.reduce((sum, point) => sum + (Number.isFinite(point.magnitude) ? point.magnitude ** 2 : 0), 0) * step / (2 * Math.PI);
}

function mirroredSpectrum(points: ComplexPoint[]) {
  return points.map((point) => ({ ...point, x: -point.x, re: point.re, im: -point.im, phase: -point.phase })).sort((left, right) => left.x - right.x);
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
  id: string; label: string; points: Point[]; mode: DomainMode; zoom: number; accent: PlotAccent;
  markerIndex?: number; markerLabel?: string;
  onPointerDown?: (event: PointerEvent<SVGSVGElement>) => void; onPointerMove?: (event: PointerEvent<SVGSVGElement>) => void; onPointerUp?: (event: PointerEvent<SVGSVGElement>) => void;
}) {
  const maximum = normalizeRange(points); const clipId = `clip-${id}`; const colorClass = `plot-${accent}`;
  const markerX = markerIndex === undefined ? 0 : chartX(markerIndex, points.length, zoom);
  const markerY = markerIndex === undefined ? 0 : chartY(points[markerIndex]?.y ?? 0, maximum);
  return <svg className={`signal-plot ${onPointerDown ? "draggable-plot" : ""}`} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={label} onDragStart={(event) => event.preventDefault()} onPointerDown={onPointerDown ? (event) => { event.preventDefault(); onPointerDown(event); } : undefined} onPointerMove={onPointerMove ? (event) => { event.preventDefault(); onPointerMove(event); } : undefined} onPointerUp={onPointerUp ? (event) => { event.preventDefault(); onPointerUp(event); } : undefined} onPointerCancel={onPointerUp ? (event) => { event.preventDefault(); onPointerUp(event); } : undefined}>
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

function frequencyY(value: number, maximum: number, top: number, bottom: number) {
  return bottom - (value / Math.max(maximum, 1e-8)) * (bottom - top);
}

function FrequencyPlot({ points, zoom, label, discreteBins }: { points: ComplexPoint[]; zoom: number; label: string; discreteBins: boolean }) {
  const isDiscrete = discreteBins;
  const maximum = Math.max(1e-8, ...points.map((point) => point.magnitude));
  const magnitude = frequencyPath(points, zoom, (point) => point.magnitude, 36, 172, maximum);
  const phase = frequencyPath(points, zoom, (point) => (point.phase + Math.PI) / (2 * Math.PI), 208, 264, 1);
  const x0 = chartX(0, points.length, zoom); const x1 = chartX(points.length - 1, points.length, zoom);
  const magnitudeDotRadius = points.length > 512 ? 1.25 : points.length > 256 ? 1.75 : 2.6;
  const phaseDotRadius = Math.min(magnitudeDotRadius, 2.2);
  return <svg className="signal-plot" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={label}>
    <AxisGrid label={isDiscrete ? "k" : "ω"} />
    <line className="spectrum-divider" x1={PAD.left} x2={WIDTH - PAD.right} y1="195" y2="195" />
    {isDiscrete ? <>
      <g className="spectrum-bins" aria-label="离散幅度频率格点">
        {points.map((point, index) => {
          const x = chartX(index, points.length, zoom); const y = frequencyY(point.magnitude, maximum, 36, 172);
          return <g key={`magnitude-${index}`} className="plot-pink"><line className="spectrum-bin-stem" x1={x} x2={x} y1="172" y2={y} /><circle className="spectrum-bin-dot" cx={x} cy={y} r={magnitudeDotRadius} /></g>;
        })}
      </g>
      <g className="spectrum-bins spectrum-phase-bins" aria-label="离散相位频率格点">
        {points.map((point, index) => {
          const x = chartX(index, points.length, zoom); const y = frequencyY((point.phase + Math.PI) / (2 * Math.PI), 1, 208, 264);
          return <g key={`phase-${index}`} className="plot-violet"><line className="spectrum-bin-stem" x1={x} x2={x} y1="236" y2={y} /><circle className="spectrum-bin-dot" cx={x} cy={y} r={phaseDotRadius} /></g>;
        })}
      </g>
    </> : <>
      <path className="spectrum-area" d={`${magnitude} L${x1},172 L${x0},172 Z`} />
      <path className="signal-line plot-pink" d={magnitude} />
      <path className="phase-line" d={phase} />
    </>}
    <text className="plot-label pink-text" x={PAD.left + 8} y="32">{isDiscrete ? "离散幅度 |X[k]|" : "幅度 |X|"}</text><text className="plot-label violet-text" x={PAD.left + 8} y="207">{isDiscrete ? "离散相位 ∠X[k]" : "相位 ∠X（时移时实时变化）"}</text>{isDiscrete && <text className="plot-label" x={WIDTH - PAD.right} y="32" textAnchor="end">N = {points.length} 个 DFT 频率格点</text>}
  </svg>;
}

function MultiSignalPlot({ id, label, series, mode, zoom, visible }: { id: string; label: string; series: SignalSeries[]; mode: DomainMode; zoom: number; visible: Record<string, boolean> }) {
  const active = series.filter((item) => visible[item.id] !== false);
  const maximum = Math.max(.2, ...active.flatMap((item) => item.points.map((point) => Math.abs(point.y)).filter(Number.isFinite)));
  const clipId = `clip-${id}`;
  return <svg className="signal-plot property-plot" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={label}>
    <defs><clipPath id={clipId}><rect x={PAD.left} y={PAD.top} width={WIDTH - PAD.left - PAD.right} height={HEIGHT - PAD.top - PAD.bottom} /></clipPath></defs>
    <AxisGrid label={mode === "continuous" ? "t" : "n"} />
    <g clipPath={`url(#${clipId})`}>
      {active.map((item) => mode === "continuous"
        ? <path key={item.id} className={`signal-line plot-${item.accent}`} d={seriesPath(item.points, zoom, maximum)} />
        : item.points.map((point, index) => !Number.isFinite(point.y) ? null : <g key={`${item.id}-${index}`} className={`plot-${item.accent} property-stems`}><line className="stem" x1={chartX(index, item.points.length, zoom)} x2={chartX(index, item.points.length, zoom)} y1={HEIGHT / 2} y2={chartY(point.y, maximum)} /><circle className="point" cx={chartX(index, item.points.length, zoom)} cy={chartY(point.y, maximum)} r="2.4" /></g>))}
    </g>
  </svg>;
}

function MultiSpectrumPlot({ id, label, series, mode, zoom, visible }: { id: string; label: string; series: SpectrumSeries[]; mode: DomainMode; zoom: number; visible: Record<string, boolean> }) {
  const active = series.filter((item) => visible[item.id] !== false);
  const maximum = Math.max(1e-8, ...active.flatMap((item) => item.points.map((point) => point.magnitude).filter(Number.isFinite)));
  return <svg className="signal-plot property-plot" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={label}>
    <AxisGrid label={mode === "continuous" ? "ω" : "k"} />
    {active.map((item) => mode === "continuous"
      ? <path key={item.id} className={`signal-line plot-${item.accent}`} d={frequencyPath(item.points, zoom, (point) => point.magnitude, PAD.top, HEIGHT - PAD.bottom, maximum)} />
      : <g key={item.id} className={`spectrum-bins property-spectrum-bins plot-${item.accent}`}>{item.points.map((point, index) => {
        const x = chartX(index, item.points.length, zoom); const y = frequencyY(point.magnitude, maximum, PAD.top, HEIGHT - PAD.bottom);
        return <g key={`${item.id}-${index}`}><line className="spectrum-bin-stem" x1={x} x2={x} y1={HEIGHT - PAD.bottom} y2={y} /><circle className="spectrum-bin-dot" cx={x} cy={y} r="2.1" /></g>;
      })}</g>)}
    <text className="plot-label" x={PAD.left + 8} y={PAD.top + 18}>{mode === "continuous" ? "幅度谱 |X(ω)|" : "离散幅度谱 |X[k]|"}</text>
  </svg>;
}

function SeriesVisibility({ series, visible, onChange }: { series: { id: string; label: string; accent: PlotAccent }[]; visible: Record<string, boolean>; onChange: (id: string) => void }) {
  return <div className="series-visibility" aria-label="图像显示选择"><span>显示：</span>{series.map((item) => <button type="button" key={item.id} className={`series-toggle plot-${item.accent} ${visible[item.id] !== false ? "active" : ""}`} onClick={() => onChange(item.id)}><i aria-hidden="true" />{item.label}</button>)}</div>;
}

function ZoomControl({ value, onChange, label }: { value: number; onChange: (value: number) => void; label: string }) {
  return <div className="zoom-control"><label><span>{label}</span><output>{value.toFixed(1)}×</output><input type="range" min="0.5" max={MAX_ZOOM} step="0.1" value={value} onChange={(event) => onChange(Number(event.target.value))} /></label><button type="button" className="slider-reset" aria-label={`恢复${label}为 1 倍`} onClick={() => onChange(DEFAULT_ZOOM)}>恢复默认</button></div>;
}

function SampleCountControl({ id, value, onChange }: { id: string; value: number; onChange: (value: number) => void }) {
  const labelId = `${id}-label`;
  return <div className="sample-count-control" role="group" aria-labelledby={labelId}><span id={labelId}>离散点数 N</span><input aria-labelledby={labelId} type="number" min="16" max="1024" step="1" value={value} onChange={(event) => onChange(clamp(Number(event.target.value) || 16, 16, 1024))} /><input aria-labelledby={labelId} type="range" min="16" max="1024" step="1" value={value} onChange={(event) => onChange(Number(event.target.value))} /><button type="button" className="slider-reset" aria-label="恢复离散采样点数为 128" onClick={() => onChange(DEFAULT_DISCRETE_SAMPLE_COUNT)}>恢复默认</button></div>;
}

function displayPresetOptions(mode: DomainMode) {
  return SIGNAL_PRESETS[mode].map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>);
}

export function SignalWorkbench() {
  const domainSnapshots = useRef<Record<DomainMode, DomainSnapshot>>({ continuous: createDomainSnapshot("continuous"), discrete: createDomainSnapshot("discrete") });
  const [domainMode, setDomainMode] = useState<DomainMode>("continuous");
  const [toolMode, setToolMode] = useState<ToolMode>("geometry");
  const [transformKind, setTransformKind] = useState<TransformKind>("fourier");
  const [direction, setDirection] = useState<TransformDirection>("forward");
  const [preset, setPreset] = useState(defaultPreset("continuous"));
  const [expression, setExpression] = useState(expressionForPreset(defaultPreset("continuous"), "continuous"));
  const [inverseExpression, setInverseExpression] = useState("exp(-0.08*omega^2)");
  const [inverseSource, setInverseSource] = useState<InverseSource>("current");
  const [expressionTarget, setExpressionTarget] = useState<"time" | "frequency">("time");
  const [propertyId, setPropertyId] = useState<PropertyId>("timeShift");
  const [propertyShift, setPropertyShift] = useState(0);
  const [frequencyShift, setFrequencyShift] = useState(0);
  const [scaleFactor, setScaleFactor] = useState(1);
  const [linearA, setLinearA] = useState(1);
  const [linearB, setLinearB] = useState(.65);
  const [linearFirstPreset, setLinearFirstPreset] = useState(defaultPreset("continuous"));
  const [linearSecondPreset, setLinearSecondPreset] = useState(fallbackSecondPreset("continuous"));
  const [linearFirstExpression, setLinearFirstExpression] = useState(expressionForPreset(defaultPreset("continuous"), "continuous"));
  const [linearSecondExpression, setLinearSecondExpression] = useState(expressionForPreset(fallbackSecondPreset("continuous"), "continuous"));
  const [propertySeriesVisible, setPropertySeriesVisible] = useState<Record<string, boolean>>({});
  const [draggingTime, setDraggingTime] = useState(false);
  const [timeZoom, setTimeZoom] = useState(1);
  const [frequencyZoom, setFrequencyZoom] = useState(1);
  const [discreteSampleCount, setDiscreteSampleCount] = useState(128);
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
    if (domainMode === "discrete") return clamp(Math.round(discreteSampleCount), 16, 1024);
    const target = viewportWidth * pixelRatio * Math.max(1, timeZoom) * 1.45;
    let result = 1; while (result < target) result *= 2; return clamp(result, 1024, 4096);
  }, [discreteSampleCount, domainMode, pixelRatio, timeZoom, viewportWidth]);

  const parsedSignal = useMemo(() => compileExpression(expression), [expression]);
  const parsedInverse = useMemo(() => compileExpression(inverseExpression), [inverseExpression]);
  const parsedFirst = useMemo(() => compileExpression(firstExpression), [firstExpression]);
  const parsedSecond = useMemo(() => compileExpression(secondExpression), [secondExpression]);
  const parsedLinearFirst = useMemo(() => compileExpression(linearFirstExpression), [linearFirstExpression]);
  const parsedLinearSecond = useMemo(() => compileExpression(linearSecondExpression), [linearSecondExpression]);
  const signalFn = parsedSignal.fn;
  const firstFn = parsedFirst.fn;
  const secondFn = parsedSecond.fn;
  const linearFirstFn = parsedLinearFirst.fn;
  const linearSecondFn = parsedLinearSecond.fn;
  const baseSignal = useMemo(() => sampleSignal(signalFn, domainMode, sampleCount), [domainMode, sampleCount, signalFn]);
  const shiftedSignal = useMemo(() => timeShiftSignal(baseSignal, propertyShift, domainMode), [baseSignal, domainMode, propertyShift]);
  const scaledSignal = useMemo(() => timeScaleSignal(baseSignal, scaleFactor, domainMode), [baseSignal, domainMode, scaleFactor]);
  const modulatedSignal = useMemo(() => modulateSignal(baseSignal, frequencyShift), [baseSignal, frequencyShift]);
  const linearFirstSignal = useMemo(() => sampleSignal(linearFirstFn, domainMode, sampleCount), [domainMode, linearFirstFn, sampleCount]);
  const linearSecondSignal = useMemo(() => sampleSignal(linearSecondFn, domainMode, sampleCount), [domainMode, linearSecondFn, sampleCount]);
  const linearSumSignal = useMemo(() => linearCombineSignals([{ samples: linearFirstSignal, coefficient: linearA }, { samples: linearSecondSignal, coefficient: linearB }], domainMode), [domainMode, linearA, linearB, linearFirstSignal, linearSecondSignal]);
  const signal = propertyId === "timeShift" && direction === "forward" && transformKind === "fourier"
    ? shiftedSignal
    : propertyId === "frequencyShift" && direction === "forward" && transformKind === "fourier"
      ? modulatedSignal
      : propertyId === "scale" && direction === "forward" && transformKind === "fourier"
        ? scaledSignal
        : propertyId === "linear" && direction === "forward" && transformKind === "fourier"
          ? linearSumSignal
          : baseSignal;
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
  const currentConvolutionFrame = useMemo(() => convolutionFrame(firstSignal, secondSignal, shift, domainMode), [domainMode, firstSignal, secondSignal, shift]);
  const overlapMask = currentConvolutionFrame.overlap;

  const propertyView = useMemo(() => {
    const spectrumFor = (points: Point[]) => visibleSpectrum(forwardFourier(points, domainMode).points, domainMode);
    const baseSpectrum = spectrumFor(baseSignal);
    const make = (time: SignalSeries[], frequency: SpectrumSeries[], metrics?: { label: string; value: string }[]) => ({ time, frequency, metrics });
    if (propertyId === "linear") {
      const first = spectrumFor(linearFirstSignal); const second = spectrumFor(linearSecondSignal); const sum = spectrumFor(linearSumSignal);
      return make(
        [{ id: "linear-x1", label: `x₁ (${linearA.toFixed(2)}×)`, points: linearFirstSignal.map((point) => ({ ...point, y: linearA * point.y })), accent: "cyan" }, { id: "linear-x2", label: `x₂ (${linearB.toFixed(2)}×)`, points: linearSecondSignal.map((point) => ({ ...point, y: linearB * point.y })), accent: "pink" }, { id: "linear-sum", label: "a·x₁ + b·x₂", points: linearSumSignal, accent: "violet" }],
        [{ id: "linear-X1", label: "a·X₁", points: first.map((point) => ({ ...point, re: point.re * linearA, im: point.im * linearA, magnitude: point.magnitude * Math.abs(linearA) })), accent: "cyan" }, { id: "linear-X2", label: "b·X₂", points: second.map((point) => ({ ...point, re: point.re * linearB, im: point.im * linearB, magnitude: point.magnitude * Math.abs(linearB) })), accent: "pink" }, { id: "linear-sum-spectrum", label: "a·X₁ + b·X₂", points: sum, accent: "violet" }],
      );
    }
    if (propertyId === "timeShift") return make(
      [{ id: "shift-source", label: "x(t)", points: baseSignal, accent: "cyan" }, { id: "shifted", label: `x(t − ${propertyShift.toFixed(2)})`, points: shiftedSignal, accent: "violet" }],
      [{ id: "shift-source-spectrum", label: "|X(ω)|", points: baseSpectrum, accent: "cyan" }, { id: "shifted-spectrum", label: "时移后 |X(ω)|", points: spectrumFor(shiftedSignal), accent: "violet" }],
    );
    if (propertyId === "frequencyShift") return make(
      [{ id: "mod-source", label: "x(t)", points: baseSignal, accent: "cyan" }, { id: "modulated", label: `x(t)·cos(${frequencyShift.toFixed(2)}t)`, points: modulatedSignal, accent: "amber" }],
      [{ id: "mod-source-spectrum", label: "|X(ω)|", points: baseSpectrum, accent: "cyan" }, { id: "modulated-spectrum", label: "X(ω − ω₀)", points: frequencyShiftSpectrum(baseSpectrum, frequencyShift, domainMode), accent: "amber" }],
    );
    if (propertyId === "scale") return make(
      [{ id: "scale-source", label: "x(t)", points: baseSignal, accent: "cyan" }, { id: "scaled", label: `x(${scaleFactor.toFixed(2)}t)`, points: scaledSignal, accent: "amber" }],
      [{ id: "scale-source-spectrum", label: "|X(ω)|", points: baseSpectrum, accent: "cyan" }, { id: "scaled-spectrum", label: "(1/|a|)X(ω/a)", points: frequencyScaleSpectrum(baseSpectrum, scaleFactor, domainMode), accent: "amber" }],
    );
    if (propertyId === "convolution") {
      const convolved = convolve(baseSignal, secondSignal, domainMode);
      return make(
        [{ id: "conv-x", label: "x", points: baseSignal, accent: "cyan" }, { id: "conv-h", label: "h", points: secondSignal, accent: "pink" }, { id: "conv-y", label: "x * h", points: convolved, accent: "violet" }],
        [{ id: "conv-X", label: "X", points: baseSpectrum, accent: "cyan" }, { id: "conv-H", label: "H", points: spectrumFor(secondSignal), accent: "pink" }, { id: "conv-Y", label: "Y = X·H", points: spectrumFor(convolved), accent: "violet" }],
      );
    }
    if (propertyId === "product") {
      const product = pointwise(baseSignal, secondSignal, (a, b) => a * b);
      return make(
        [{ id: "product-x", label: "x", points: baseSignal, accent: "cyan" }, { id: "product-h", label: "h", points: secondSignal, accent: "pink" }, { id: "product-y", label: "x·h", points: product, accent: "violet" }],
        [{ id: "product-X", label: "X", points: baseSpectrum, accent: "cyan" }, { id: "product-H", label: "H", points: spectrumFor(secondSignal), accent: "pink" }, { id: "product-Y", label: "F{x·h}", points: spectrumFor(product), accent: "violet" }],
      );
    }
    if (propertyId === "differentiate") {
      const derivative = differentiateSignal(baseSignal, domainMode);
      return make([{ id: "diff-x", label: "x", points: baseSignal, accent: "cyan" }, { id: "diff-y", label: "dx/dt", points: derivative, accent: "amber" }], [{ id: "diff-X", label: "X", points: baseSpectrum, accent: "cyan" }, { id: "diff-Y", label: "F{dx/dt}", points: spectrumFor(derivative), accent: "amber" }]);
    }
    if (propertyId === "integrate") {
      const integral = integrateSignal(baseSignal, domainMode);
      return make([{ id: "int-x", label: "x", points: baseSignal, accent: "cyan" }, { id: "int-y", label: "∫x", points: integral, accent: "mint" }], [{ id: "int-X", label: "X", points: baseSpectrum, accent: "cyan" }, { id: "int-Y", label: "F{∫x}", points: spectrumFor(integral), accent: "mint" }]);
    }
    if (propertyId === "parseval") {
      const timeEnergy = baseSignal.map((point) => ({ x: point.x, y: point.y ** 2 }));
      const frequencyEnergy = baseSpectrum.map((point) => ({ ...point, magnitude: point.magnitude ** 2 / (2 * Math.PI), y: point.magnitude ** 2 / (2 * Math.PI) }));
      const energy = parsevalEnergy(baseSignal, baseSpectrum, domainMode);
      return make([{ id: "energy-time", label: "|x(t)|²", points: timeEnergy, accent: "cyan" }], [{ id: "energy-frequency", label: "|X(ω)|²/2π", points: frequencyEnergy, accent: "violet" }], [{ label: "时域能量", value: energy.time.toFixed(4) }, { label: "频域能量", value: energy.frequency.toFixed(4) }, { label: "相对误差", value: `${(energy.relativeError * 100).toFixed(3)}%` }]);
    }
    if (propertyId === "duality") {
      const reversed = [...baseSignal].reverse().map((point, index) => ({ x: baseSignal[index]?.x ?? point.x, y: 2 * Math.PI * point.y }));
      return make([{ id: "dual-x", label: "x(t)", points: baseSignal, accent: "cyan" }, { id: "dual-reverse", label: "2πx(−t)", points: reversed, accent: "pink" }], [{ id: "dual-X", label: "X(ω)", points: baseSpectrum, accent: "cyan" }, { id: "dual-mirror", label: "X 的对偶镜像", points: mirroredSpectrum(baseSpectrum), accent: "pink" }]);
    }
    if (propertyId === "conjugate") return make(
      [{ id: "conjugate-time", label: "实值 x(t)", points: baseSignal, accent: "cyan" }],
      [{ id: "conjugate-X", label: "X(ω)", points: baseSpectrum, accent: "cyan" }, { id: "conjugate-mirror", label: "X*(−ω)", points: mirroredSpectrum(baseSpectrum), accent: "pink" }],
    );
    return null;
  }, [baseSignal, domainMode, frequencyShift, linearA, linearB, linearFirstSignal, linearSecondSignal, linearSumSignal, modulatedSignal, propertyId, scaleFactor, scaledSignal, secondSignal, shiftedSignal]);
  const liveIntegrand = currentConvolutionFrame.integrand;
  const liveConvolutionValue = currentConvolutionFrame.value;

  const selectedProperty = FOURIER_PROPERTIES.find((item) => item.id === propertyId) ?? FOURIER_PROPERTIES[0];
  const propertyExpressionError = propertyId === "linear" ? parsedLinearFirst.error ?? parsedLinearSecond.error : null;
  const sourceExpressionError = direction === "inverse" && inverseSource === "formula" ? parsedInverse.error : parsedSignal.error ?? propertyExpressionError;
  const convolutionError = parsedFirst.error ?? parsedSecond.error;
  const transformTitle = transformKind === "fourier"
    ? domainMode === "continuous" ? (direction === "forward" ? "连续时间傅里叶变换 CTFT" : "连续时间逆傅里叶变换 ICTFT") : (direction === "forward" ? "离散傅里叶变换 DFT" : "离散逆傅里叶变换 IDFT")
    : transformKind === "laplace" ? "拉普拉斯变换" : "Z 变换";
  const shiftLabel = domainMode === "continuous" ? `t₀ = ${propertyShift.toFixed(2)} s` : `n₀ = ${Math.round(propertyShift)}`;
  const convolutionShiftLabel = domainMode === "continuous" ? `τ = ${shift.toFixed(2)} s` : `k = ${Math.round(shift)}`;

  const captureDomainSnapshot = (): DomainSnapshot => ({
    preset, expression, inverseExpression, inverseSource, transformKind, direction, propertyId,
    propertyShift, frequencyShift, scaleFactor, linearA, linearB, linearFirstPreset, linearSecondPreset, linearFirstExpression, linearSecondExpression,
    timeZoom, frequencyZoom, discreteSampleCount, firstPreset, secondPreset, firstExpression, secondExpression, shift,
  });
  const restoreDomainSnapshot = (snapshot: DomainSnapshot) => {
    setPreset(snapshot.preset); setExpression(snapshot.expression); setInverseExpression(snapshot.inverseExpression); setInverseSource(snapshot.inverseSource);
    setTransformKind(snapshot.transformKind); setDirection(snapshot.direction); setPropertyId(snapshot.propertyId);
    setPropertyShift(snapshot.propertyShift); setFrequencyShift(snapshot.frequencyShift); setScaleFactor(snapshot.scaleFactor);
    setLinearA(snapshot.linearA); setLinearB(snapshot.linearB); setLinearFirstPreset(snapshot.linearFirstPreset); setLinearSecondPreset(snapshot.linearSecondPreset);
    setLinearFirstExpression(snapshot.linearFirstExpression); setLinearSecondExpression(snapshot.linearSecondExpression);
    setTimeZoom(snapshot.timeZoom); setFrequencyZoom(snapshot.frequencyZoom); setDiscreteSampleCount(snapshot.discreteSampleCount);
    setFirstPreset(snapshot.firstPreset); setSecondPreset(snapshot.secondPreset); setFirstExpression(snapshot.firstExpression); setSecondExpression(snapshot.secondExpression); setShift(snapshot.shift);
  };
  const switchDomain = (next: DomainMode) => {
    if (next === domainMode) return;
    domainSnapshots.current[domainMode] = captureDomainSnapshot();
    restoreDomainSnapshot(domainSnapshots.current[next]);
    setDomainMode(next);
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
  const togglePropertySeries = (id: string) => setPropertySeriesVisible((current) => ({ ...current, [id]: current[id] === false }));
  const domainRangeLabel = domainMode === "continuous"
    ? "−4 … 4 s"
    : `n = ${signal[0]?.x ?? 0} … ${signal.at(-1)?.x ?? 0}`;

  return <main className="tool-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true" />Signal Lab</div>
      <div className="tab-group" role="group" aria-label="信号类型"><button className={domainMode === "continuous" ? "tab active" : "tab"} onClick={() => switchDomain("continuous")}>连续时间</button><button className={domainMode === "discrete" ? "tab active" : "tab"} onClick={() => switchDomain("discrete")}>离散时间</button></div>
      <div className="tab-group" role="group" aria-label="分析工具"><button className={toolMode === "transform" ? "tab active" : "tab"} onClick={() => setToolMode("transform")}>时频变换</button><button className={toolMode === "convolution" ? "tab active" : "tab"} onClick={() => setToolMode("convolution")}>卷积</button><button className={toolMode === "cube" ? "tab active" : "tab"} onClick={() => setToolMode("cube")}>时频立方体</button><button className={toolMode === "geometry" ? "tab active" : "tab"} onClick={() => setToolMode("geometry")}>傅里叶几何</button><button className={toolMode === "dsp" ? "tab active" : "tab"} onClick={() => setToolMode("dsp")}>DSP 实验</button></div>
    </header>

    {toolMode === "transform" && <section className="workspace" aria-label="傅里叶变换工作台">
      <div className="control-row transform-controls">
        <label>标准信号<select value={preset} onChange={(event) => choosePreset(event.target.value, "main")}>{displayPresetOptions(domainMode)}</select></label>
        <label className="expression-input">函数表达式 x({domainMode === "continuous" ? "t" : "n"})<input ref={expressionTarget === "time" ? timeInputRef : undefined} value={expression} onFocus={() => setExpressionTarget("time")} onChange={(event) => setExpression(event.target.value)} spellCheck="false" /></label>
        <label>变换<select value={transformKind} onChange={(event) => selectTransform(event.target.value as TransformKind)}><option value="fourier">傅里叶变换</option><option value="laplace">拉普拉斯变换</option><option value="z">Z 变换</option></select></label>
        <div className="direction-toggle" role="group" aria-label="变换方向"><button className={direction === "forward" ? "mini-tab active" : "mini-tab"} onClick={() => setDirection("forward")}>正变换</button><button disabled={transformKind !== "fourier"} className={direction === "inverse" ? "mini-tab active" : "mini-tab"} onClick={() => setDirection("inverse")}>逆变换</button></div>
        {domainMode === "discrete" && <SampleCountControl id="transform-sample-count" value={discreteSampleCount} onChange={setDiscreteSampleCount} />}
        <span className={sourceExpressionError ? "status-dot error" : "status-dot"}>{sourceExpressionError ? `采样暂停：${sourceExpressionError}` : `${sampleCount} 点实时数值采样`}</span>
      </div>
      {direction === "inverse" && transformKind === "fourier" && <div className="inverse-row"><div className="direction-toggle" role="group" aria-label="逆变换频谱来源"><button className={inverseSource === "current" ? "mini-tab active" : "mini-tab"} onClick={() => setInverseSource("current")}>使用当前频谱</button><button className={inverseSource === "formula" ? "mini-tab active" : "mini-tab"} onClick={() => setInverseSource("formula")}>输入频域函数</button></div>{inverseSource === "formula" && <label className="expression-input inverse-expression">X({domainMode === "continuous" ? "ω" : "k"})<input ref={expressionTarget === "frequency" ? frequencyInputRef : undefined} value={inverseExpression} onFocus={() => setExpressionTarget("frequency")} onChange={(event) => setInverseExpression(event.target.value)} spellCheck="false" /></label>}</div>}
      <div className="shortcut-bar" aria-label="数学符号快捷输入">{SHORTCUTS.map(([label, token]) => <button key={label} type="button" onClick={() => insertShortcut(token)}>{label}</button>)}</div>
      {transformKind === "fourier" && <>
        <aside className="property-panel"><label>傅里叶性质<select value={propertyId} onChange={(event) => setPropertyId(event.target.value as PropertyId)}>{FOURIER_PROPERTIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><div className="property-formula"><strong>{selectedProperty.label}</strong><code>{selectedProperty.time}　↔　{selectedProperty.frequency}</code><span>{selectedProperty.note}</span>{propertyId === "timeShift" && direction === "forward" && <b>拖动下方时域图或滑动 t₀：{shiftLabel}</b>}</div></aside>
        {direction === "forward" && propertyId === "linear" && <div className="property-controls linear-controls">
          <label>a<input type="number" step="0.05" value={linearA} onChange={(event) => setLinearA(Number(event.target.value) || 0)} /></label>
          <label>b<input type="number" step="0.05" value={linearB} onChange={(event) => setLinearB(Number(event.target.value) || 0)} /></label>
          <label>x₁ 标准信号<select value={linearFirstPreset} onChange={(event) => { setLinearFirstPreset(event.target.value); setLinearFirstExpression(expressionForPreset(event.target.value, domainMode)); }}>{displayPresetOptions(domainMode)}</select></label>
          <label className="expression-input">x₁({domainMode === "continuous" ? "t" : "n"})<input value={linearFirstExpression} onChange={(event) => setLinearFirstExpression(event.target.value)} spellCheck="false" /></label>
          <label>x₂ 标准信号<select value={linearSecondPreset} onChange={(event) => { setLinearSecondPreset(event.target.value); setLinearSecondExpression(expressionForPreset(event.target.value, domainMode)); }}>{displayPresetOptions(domainMode)}</select></label>
          <label className="expression-input">x₂({domainMode === "continuous" ? "t" : "n"})<input value={linearSecondExpression} onChange={(event) => setLinearSecondExpression(event.target.value)} spellCheck="false" /></label>
        </div>}
        {direction === "forward" && propertyId === "timeShift" && <div className="property-controls property-slider"><label>时移 {domainMode === "continuous" ? "t₀" : "n₀"}<output>{shiftLabel}</output><input type="range" min={domainMode === "continuous" ? -4 : -Math.floor(sampleCount / 2)} max={domainMode === "continuous" ? 4 : Math.floor(sampleCount / 2)} step={domainMode === "continuous" ? .05 : 1} value={propertyShift} onChange={(event) => setPropertyShift(Number(event.target.value))} /></label><button type="button" className="slider-reset" aria-label="恢复时移为零" onClick={() => setPropertyShift(0)}>恢复默认</button></div>}
        {direction === "forward" && propertyId === "frequencyShift" && <div className="property-controls property-slider"><label>频移 {domainMode === "continuous" ? "ω₀ (rad/s)" : "Ω₀ (rad/sample)"}<output>{frequencyShift.toFixed(2)}</output><input type="range" min={domainMode === "continuous" ? -16 : -Math.PI} max={domainMode === "continuous" ? 16 : Math.PI} step="0.05" value={frequencyShift} onChange={(event) => setFrequencyShift(Number(event.target.value))} /></label><button type="button" className="slider-reset" aria-label="恢复频移为零" onClick={() => setFrequencyShift(0)}>恢复默认</button></div>}
        {direction === "forward" && propertyId === "scale" && <div className="property-controls property-slider"><label>尺度 a：x(at)<output>{scaleFactor.toFixed(2)}</output><input type="range" min="0.25" max="3" step="0.05" value={scaleFactor} onChange={(event) => setScaleFactor(Number(event.target.value))} /></label><button type="button" className="slider-reset" aria-label="恢复尺度因子为 1" onClick={() => setScaleFactor(1)}>恢复默认</button></div>}
      </>}
      <div className="plot-grid">
        <article className="plot-panel">
          <div className="plot-heading"><div><p>{direction === "forward" ? "输入信号" : "频域输入"}</p><h2>{direction === "forward" ? (domainMode === "continuous" ? "时域 x(t)" : "时域 x[n]") : (domainMode === "continuous" ? "频域 X(ω)" : "频域 X[k]")}</h2></div><span className="domain-pill">{direction === "forward" ? domainRangeLabel : "复频谱"}</span></div>
          {direction === "forward" ? <SignalPlot id="time-main" label="时域输入信号" points={signal} mode={domainMode} zoom={timeZoom} accent="cyan" markerLabel="x" onPointerDown={propertyId === "timeShift" && transformKind === "fourier" ? (event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setDraggingTime(true); updateTimeShift(event); } : undefined} onPointerMove={draggingTime ? updateTimeShift : undefined} onPointerUp={(event) => { event.preventDefault(); if (draggingTime && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); setDraggingTime(false); }} /> : <FrequencyPlot points={displayInverseSpectrum} zoom={frequencyZoom} label="逆变换频域输入" discreteBins={domainMode === "discrete"} />}
          <ZoomControl label={direction === "forward" ? "时域缩放" : "频域缩放"} value={direction === "forward" ? timeZoom : frequencyZoom} onChange={direction === "forward" ? setTimeZoom : setFrequencyZoom} />
        </article>
        <article className="plot-panel">
          <div className="plot-heading"><div><p>{transformTitle}</p><h2>{direction === "forward" ? (transformKind === "fourier" ? (domainMode === "continuous" ? "频域 |X(ω)| 与 ∠X" : "离散频域 |X[k]| 与 ∠X[k]") : transformKind === "laplace" ? "s 域 |X(s)|" : "z 域 |X(z)|") : (domainMode === "continuous" ? "时域重建 x(t)" : "离散重建 x[n]")}</h2></div><span className="domain-pill">{direction === "forward" ? "复数数值计算" : "逆变换重建"}</span></div>
          {direction === "forward" ? <FrequencyPlot points={displaySpectrum} zoom={frequencyZoom} label="傅里叶频谱与相位" discreteBins={domainMode === "discrete" && transformKind === "fourier"} /> : <SignalPlot id="inverse-time" label="逆傅里叶重建信号" points={inverseTime} mode={domainMode} zoom={timeZoom} accent="violet" markerLabel="x" />}
          <ZoomControl label={direction === "forward" ? "频域缩放" : "时域缩放"} value={direction === "forward" ? frequencyZoom : timeZoom} onChange={direction === "forward" ? setFrequencyZoom : setTimeZoom} />
        </article>
      </div>
      {direction === "forward" && transformKind === "fourier" && propertyView && <section className="property-explorer" aria-label={`${selectedProperty.label}的图形验证`}>
        <div className="property-explorer-heading"><div><p>性质图形验证</p><h2>{selectedProperty.label}：时域与频域同步</h2></div>{propertyView.metrics && <div className="property-metrics">{propertyView.metrics.map((metric) => <span key={metric.label}><small>{metric.label}</small><b>{metric.value}</b></span>)}</div>}</div>
        <SeriesVisibility series={propertyView.time} visible={propertySeriesVisible} onChange={togglePropertySeries} />
        <div className="plot-grid property-plot-grid"><article className="plot-panel"><div className="plot-heading"><div><p>时域关系</p><h2>{selectedProperty.time}</h2></div></div><MultiSignalPlot id={`property-time-${propertyId}`} label={`${selectedProperty.label}时域关系`} series={propertyView.time} mode={domainMode} zoom={timeZoom} visible={propertySeriesVisible} /></article><article className="plot-panel"><div className="plot-heading"><div><p>频域关系</p><h2>{selectedProperty.frequency}</h2></div></div><SeriesVisibility series={propertyView.frequency} visible={propertySeriesVisible} onChange={togglePropertySeries} /><MultiSpectrumPlot id={`property-frequency-${propertyId}`} label={`${selectedProperty.label}频域关系`} series={propertyView.frequency} mode={domainMode} zoom={frequencyZoom} visible={propertySeriesVisible} /></article></div>
      </section>}
    </section>}
    {toolMode === "convolution" && <section className="workspace" aria-label="卷积工作台">
      <div className="control-row convolution-controls">
        <label>x({domainMode === "continuous" ? "t" : "n"})<select value={firstPreset} onChange={(event) => choosePreset(event.target.value, "first")}>{displayPresetOptions(domainMode)}</select></label>
        <label className="expression-input"><span className="cyan-text">x</span> 函数<input value={firstExpression} onChange={(event) => setFirstExpression(event.target.value)} spellCheck="false" /></label>
        <label>h({domainMode === "continuous" ? "t" : "n"})<select value={secondPreset} onChange={(event) => choosePreset(event.target.value, "second")}>{displayPresetOptions(domainMode)}</select></label>
        <label className="expression-input"><span className="pink-text">h</span> 函数<input value={secondExpression} onChange={(event) => setSecondExpression(event.target.value)} spellCheck="false" /></label>
        {domainMode === "discrete" && <SampleCountControl id="convolution-sample-count" value={discreteSampleCount} onChange={setDiscreteSampleCount} />}
        <span className={convolutionError ? "status-dot error" : "status-dot"}>{convolutionError ? `卷积暂停：${convolutionError}` : "FFT 数值卷积"}</span>
      </div>
      <div className="shortcut-bar convolution-shortcuts" aria-label="数学符号快捷输入">{SHORTCUTS.slice(0, 12).map(([label, token]) => <button key={label} type="button" onClick={() => setFirstExpression((current) => `${current}${token}`)}>{label}</button>)}</div>
      <div className="plot-grid">
        <article className="plot-panel">
          <div className="plot-heading"><div><p>翻转、平移与重叠</p><h2>拖动 h({domainMode === "continuous" ? "τ − t" : "k − n"})</h2></div><span className="domain-pill">{convolutionShiftLabel}</span></div>
          <div className="convolution-stage">
            <SignalPlot id="convolution-first" label="卷积输入信号 x" points={firstSignal} mode={domainMode} zoom={timeZoom} accent="cyan" markerLabel="x" />
            <svg className="signal-plot signal-overlay draggable-plot" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-label="可拖动的时间翻转卷积函数" onDragStart={(event) => event.preventDefault()} onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setDraggingConvolution(true); updateConvolutionShift(event); }} onPointerMove={draggingConvolution ? updateConvolutionShift : undefined} onPointerUp={(event) => { event.preventDefault(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); setDraggingConvolution(false); }} onPointerCancel={(event) => { event.preventDefault(); setDraggingConvolution(false); }}>
              <defs><clipPath id="clip-convolution-second"><rect x={PAD.left} y={PAD.top} width={WIDTH - PAD.left - PAD.right} height={HEIGHT - PAD.top - PAD.bottom} /></clipPath></defs>
              <g clipPath="url(#clip-convolution-second)" transform={`translate(${overlayShift} 0)`}><path className="signal-line plot-muted" d={seriesPath(reversedSecond, timeZoom, convolutionMaximum)} /><path className="signal-line plot-pink" d={seriesPath(reversedSecond, timeZoom, convolutionMaximum, overlapMask)} /><circle className="drag-handle" cx={chartX(Math.floor(sampleCount / 2), sampleCount, timeZoom)} cy={chartY(reversedSecond[Math.floor(sampleCount / 2)]?.y ?? 0, convolutionMaximum)} r="8" /></g>
              <text className="plot-label pink-text" x={PAD.left + 8} y={PAD.top + 38}>粉色：参与积分的重叠段　灰色：零填充外的未重叠段</text>
            </svg>
          </div>
          <div className="integrand-preview"><div className="integrand-heading"><span>逐点相乘</span><code>{domainMode === "continuous" ? "x(t)·h(τ−t)" : "x[n]·h[k−n]"}</code></div><SignalPlot id="convolution-integrand" label="卷积当前时刻的逐点乘积" points={liveIntegrand} mode={domainMode} zoom={timeZoom} accent="amber" markerLabel="f·g" /><div className="result-readout"><span>每个同一横坐标采样点实时相乘后{domainMode === "continuous" ? "积分" : "求和"}</span><strong>{liveConvolutionValue.toFixed(4)}</strong></div></div>
          <ZoomControl label="时域缩放" value={timeZoom} onChange={setTimeZoom} />
        </article>
        <article className="plot-panel"><div className="plot-heading"><div><p>实时卷积结果</p><h2>y(τ) = ∫x(t)h(τ − t)dt</h2></div><span className="domain-pill">{domainMode === "continuous" ? "数值积分" : "逐项求和"}</span></div><SignalPlot id="convolution-result" label="实时卷积结果" points={convolutionResult} mode={domainMode} zoom={timeZoom} accent="violet" markerIndex={resultMarker} markerLabel="y" /><div className="result-readout"><span>当前位置 {convolutionShiftLabel}</span><strong>y = {liveConvolutionValue.toFixed(4)}</strong></div></article>
      </div>
    </section>}
    <section className="geometry-host" hidden={toolMode !== "geometry"} aria-label="傅里叶几何合成工作台"><FourierGeometryLab active={toolMode === "geometry"} /></section>
    <section className="cube-host" hidden={toolMode !== "cube"} aria-label="时频立方体工作台"><TimeFrequencyCube signal={signal} spectrum={fourier.points} mode={domainMode} /></section>
    <section className="dsp-host" hidden={toolMode !== "dsp"} aria-label="数字信号处理实验室"><DspConceptLab /></section>
  </main>;
}
