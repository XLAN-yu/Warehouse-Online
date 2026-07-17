"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { clamp, type ComplexPoint, type DomainMode, type Point } from "./signalEngine";

type SliceSource = "demo" | "current";
type ViewId = "time" | "overview" | "frequency";
type Orbit = { yaw: number; pitch: number };
type FrequencyComponent = {
  id: string;
  omega: number;
  amplitude: number;
  phase: number;
  magnitude: number;
};

const CUBE_WIDTH = 520;
const CUBE_HEIGHT = 300;
const CUBE_DEPTH = 340;
const SIGNAL_AXIS_Y = CUBE_HEIGHT / 2;
const FREQUENCY_PEAK_HEIGHT = 90;
const AMPLITUDE_FLOOR = 1.5;
const SLICE_COLORS = ["#45e7ff", "#a895ff", "#54e4bc", "#ff9cda", "#ffa968", "#6bb6ff", "#e4d66a", "#ff7f9a"];

const VIEW_PRESETS: Record<ViewId, Orbit & { label: string; hint: string }> = {
  time: { yaw: -28, pitch: -8, label: "时域正视", hint: "正面 X 切片；右侧同时可见频域墙的侧面" },
  overview: { yaw: -32, pitch: -14, label: "空间总览", hint: "时域切片在正面，频域 Y–Z 面从右侧透视" },
  frequency: { yaw: -86, pitch: -3, label: "频域侧视", hint: "沿 X 轴看向 Y–Z 频域墙；同色谱线对应后方同深度的时域切片" },
};

const DEMO_CONTINUOUS: FrequencyComponent[] = [
  { id: "demo-1", omega: 2 * Math.PI * 0.55, amplitude: 0.45, phase: 0.2, magnitude: 0.45 },
  { id: "demo-2", omega: 2 * Math.PI * 1.15, amplitude: 0.76, phase: -0.85, magnitude: 0.76 },
  { id: "demo-3", omega: 2 * Math.PI * 1.9, amplitude: 0.56, phase: 0.55, magnitude: 0.56 },
  { id: "demo-4", omega: 2 * Math.PI * 2.75, amplitude: 0.34, phase: 1.05, magnitude: 0.34 },
  { id: "demo-5", omega: 2 * Math.PI * 3.55, amplitude: 0.25, phase: -0.35, magnitude: 0.25 },
  { id: "demo-6", omega: 2 * Math.PI * 4.25, amplitude: 0.17, phase: 0.75, magnitude: 0.17 },
];

const DEMO_DISCRETE: FrequencyComponent[] = [
  { id: "demo-d-1", omega: 0.14 * Math.PI, amplitude: 0.42, phase: 0.15, magnitude: 0.42 },
  { id: "demo-d-2", omega: 0.27 * Math.PI, amplitude: 0.74, phase: -0.72, magnitude: 0.74 },
  { id: "demo-d-3", omega: 0.42 * Math.PI, amplitude: 0.53, phase: 0.44, magnitude: 0.53 },
  { id: "demo-d-4", omega: 0.61 * Math.PI, amplitude: 0.31, phase: 1.12, magnitude: 0.31 },
  { id: "demo-d-5", omega: 0.78 * Math.PI, amplitude: 0.22, phase: -0.18, magnitude: 0.22 },
  { id: "demo-d-6", omega: 0.91 * Math.PI, amplitude: 0.13, phase: 0.7, magnitude: 0.13 },
];

function cloneComponents(components: FrequencyComponent[]) {
  return components.map((component) => ({ ...component }));
}

function round(value: number, digits = 2) {
  const precision = 10 ** digits;
  return Math.round(value * precision) / precision;
}

function componentFrequency(component: FrequencyComponent, mode: DomainMode, compact = false) {
  if (mode === "discrete") return compact ? `${round(component.omega / Math.PI, 2)}π` : `Ω = ${round(component.omega / Math.PI, 3)}π rad/sample`;
  const hertz = component.omega / (2 * Math.PI);
  return compact ? `${round(hertz, 2)} Hz` : `ω = ${round(component.omega, 3)} rad/s · f = ${round(hertz, 3)} Hz`;
}

function timeRange(mode: DomainMode) {
  return mode === "continuous" ? { start: -4, end: 4, count: 240 } : { start: -32, end: 32, count: 65 };
}

function componentValue(component: FrequencyComponent, time: number) {
  return component.amplitude * Math.cos(component.omega * time + component.phase);
}

function componentAmplitude(point: ComplexPoint, signal: Point[], mode: DomainMode) {
  if (signal.length < 2) return 0;
  const step = Math.abs(signal[1].x - signal[0].x) || 1;
  const scale = mode === "continuous" ? signal.length * step : signal.length;
  return (2 * point.magnitude) / Math.max(scale, 1e-9);
}

function extractComponents(spectrum: ComplexPoint[], signal: Point[], mode: DomainMode): FrequencyComponent[] {
  const positives = spectrum.filter((point) => point.x > 1e-7 && Number.isFinite(point.x) && Number.isFinite(point.magnitude));
  if (!positives.length) return [];
  const binWidth = positives.length > 1 ? Math.abs(positives[1].x - positives[0].x) : 0.01;
  const peak = Math.max(...positives.map((point) => point.magnitude));
  if (!Number.isFinite(peak) || peak <= 1e-9) return [];
  const localPeaks = positives.filter((point, index) => {
    const before = positives[index - 1]?.magnitude ?? -Infinity;
    const after = positives[index + 1]?.magnitude ?? -Infinity;
    return point.magnitude >= before && point.magnitude >= after;
  });
  const candidates = (localPeaks.length ? localPeaks : positives).sort((left, right) => right.magnitude - left.magnitude);
  const selected: ComplexPoint[] = [];
  for (const point of candidates) {
    if (selected.length >= 8) break;
    if (selected.length > 0 && point.magnitude < peak * 0.006) continue;
    if (selected.every((existing) => Math.abs(existing.x - point.x) > binWidth * 2.5)) selected.push(point);
  }
  return selected
    .sort((left, right) => left.x - right.x)
    .map((point, index) => ({
      id: `peak-${index}-${round(point.x, 5)}`,
      omega: point.x,
      amplitude: componentAmplitude(point, signal, mode),
      phase: point.phase,
      magnitude: point.magnitude,
    }));
}

type PlotPoint = { x: number; y: number };

function componentPlotPoints(component: FrequencyComponent, mode: DomainMode, amplitudeScale: number): PlotPoint[] {
  const { start, end, count } = timeRange(mode);
  return Array.from({ length: count }, (_, index) => {
    const time = start + ((end - start) * index) / Math.max(count - 1, 1);
    const x = 26 + (index / Math.max(count - 1, 1)) * (CUBE_WIDTH - 64);
    const y = SIGNAL_AXIS_Y - (componentValue(component, time) / Math.max(amplitudeScale, 1e-8)) * 96;
    return { x, y };
  });
}

function plotPath(points: PlotPoint[]) {
  return points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
}

function componentPath(component: FrequencyComponent, mode: DomainMode, amplitudeScale: number) {
  return plotPath(componentPlotPoints(component, mode, amplitudeScale));
}

function compositeSamples(components: FrequencyComponent[], mode: DomainMode): Point[] {
  const { start, end, count } = timeRange(mode);
  return Array.from({ length: count }, (_, index) => {
    const x = start + ((end - start) * index) / Math.max(count - 1, 1);
    return { x, y: components.reduce((total, component) => total + componentValue(component, x), 0) };
  });
}

function compositePlotPoints(samples: Point[], amplitudeScale: number): PlotPoint[] {
  return samples.map((sample, index) => {
    const x = 26 + (index / Math.max(samples.length - 1, 1)) * (CUBE_WIDTH - 64);
    const y = SIGNAL_AXIS_Y - (sample.y / Math.max(amplitudeScale, 1e-8)) * 96;
    return { x, y };
  });
}

function compositePath(samples: Point[], amplitudeScale: number) {
  return plotPath(compositePlotPoints(samples, amplitudeScale));
}

function sliceFromTarget(target: EventTarget | null) {
  const element = target instanceof Element ? target.closest("[data-slice-index]") : null;
  const index = Number(element?.getAttribute("data-slice-index"));
  return Number.isInteger(index) ? index : null;
}

function nearestView(orbit: Orbit): ViewId {
  return (Object.keys(VIEW_PRESETS) as ViewId[]).reduce((closest, id) => {
    const current = VIEW_PRESETS[id];
    const previous = VIEW_PRESETS[closest];
    const currentDistance = (current.yaw - orbit.yaw) ** 2 + (current.pitch - orbit.pitch) ** 2;
    const previousDistance = (previous.yaw - orbit.yaw) ** 2 + (previous.pitch - orbit.pitch) ** 2;
    return currentDistance < previousDistance ? id : closest;
  }, "overview");
}

function nextOmega(components: FrequencyComponent[], mode: DomainMode) {
  const highest = Math.max(0, ...components.map((component) => component.omega));
  if (mode === "discrete") {
    const candidate = highest > 0 ? highest + 0.12 * Math.PI : 0.18 * Math.PI;
    return candidate < 0.96 * Math.PI ? candidate : 0.16 * Math.PI;
  }
  return highest > 0 ? highest + 2 * Math.PI * 0.6 : 2 * Math.PI;
}

export function TimeFrequencyCube({ signal, spectrum, mode }: { signal: Point[]; spectrum: ComplexPoint[]; mode: DomainMode }) {
  const [source, setSource] = useState<SliceSource>("current");
  const [demoDrafts, setDemoDrafts] = useState<Record<DomainMode, FrequencyComponent[]>>(() => ({
    continuous: cloneComponents(DEMO_CONTINUOUS),
    discrete: cloneComponents(DEMO_DISCRETE),
  }));
  const [currentDrafts, setCurrentDrafts] = useState<Record<DomainMode, FrequencyComponent[]>>({ continuous: [], discrete: [] });
  const [selectedIndex, setSelectedIndex] = useState(1);
  const [orbit, setOrbit] = useState<Orbit>({ yaw: VIEW_PRESETS.overview.yaw, pitch: VIEW_PRESETS.overview.pitch });
  const [cubeScale, setCubeScale] = useState(1);
  const [dragging, setDragging] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const orbitRef = useRef(orbit);
  const dragRef = useRef<{ x: number; y: number; orbit: Orbit; moved: boolean } | null>(null);
  const previousMode = useRef(mode);

  const currentComponents = useMemo(() => extractComponents(spectrum, signal, mode), [mode, signal, spectrum]);
  const components = source === "demo" ? demoDrafts[mode] : currentDrafts[mode].length ? currentDrafts[mode] : currentComponents;
  const activeView = nearestView(orbit);
  const compositeSignal = useMemo(() => compositeSamples(components, mode), [components, mode]);
  const displayAmplitudeLimit = Math.max(AMPLITUDE_FLOOR, Math.ceil(Math.max(0, ...components.map((component) => component.amplitude), ...compositeSignal.map((point) => Math.abs(point.y))) * 2) / 2);
  const frontCompositePath = useMemo(() => compositePath(compositeSignal, displayAmplitudeLimit), [compositeSignal, displayAmplitudeLimit]);
  const frontCompositePoints = useMemo(() => compositePlotPoints(compositeSignal, displayAmplitudeLimit), [compositeSignal, displayAmplitudeLimit]);
  const selected = components[selectedIndex] ?? null;
  const selectedColor = SLICE_COLORS[selectedIndex % SLICE_COLORS.length];
  const componentCount = components.length;

  useEffect(() => {
    setSelectedIndex((index) => clamp(index, 0, Math.max(componentCount - 1, 0)));
  }, [componentCount]);

  useEffect(() => {
    if (previousMode.current === mode) return;
    previousMode.current = mode;
    setSelectedIndex(0);
  }, [mode]);

  useEffect(() => {
    if (source !== "current") return;
    setCurrentDrafts((drafts) => ({ ...drafts, [mode]: cloneComponents(currentComponents) }));
  }, [currentComponents, mode, source]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      setCubeScale((current) => clamp(current - event.deltaY * 0.001, 0.76, 1.22));
    };
    stage.addEventListener("wheel", handleWheel, { passive: false });
    return () => stage.removeEventListener("wheel", handleWheel);
  }, []);

  const setOrbitSafely = (next: Orbit) => {
    orbitRef.current = next;
    setOrbit(next);
  };
  const selectView = (view: ViewId) => setOrbitSafely({ yaw: VIEW_PRESETS[view].yaw, pitch: VIEW_PRESETS[view].pitch });
  const selectSlice = (index: number) => setSelectedIndex(clamp(index, 0, Math.max(componentCount - 1, 0)));
  const selectSource = (next: SliceSource) => {
    if (next === "current" && source !== "current") setCurrentDrafts((drafts) => ({ ...drafts, [mode]: cloneComponents(currentComponents) }));
    setSource(next);
    setSelectedIndex(0);
  };
  const updateAmplitude = (id: string, amplitude: number) => {
    const update = (items: FrequencyComponent[]) => items.map((component) => component.id === id ? { ...component, amplitude, magnitude: amplitude } : component);
    if (source === "demo") setDemoDrafts((drafts) => ({ ...drafts, [mode]: update(drafts[mode]) }));
    else setCurrentDrafts((drafts) => ({ ...drafts, [mode]: update(drafts[mode]) }));
  };
  const addComponent = () => {
    if (componentCount >= 8) return;
    const component: FrequencyComponent = {
      id: `custom-${mode}-${Date.now()}-${componentCount}`,
      omega: nextOmega(components, mode),
      amplitude: 0.5,
      phase: 0,
      magnitude: 0.5,
    };
    if (source === "demo") setDemoDrafts((drafts) => ({ ...drafts, [mode]: [...drafts[mode], component].sort((left, right) => left.omega - right.omega) }));
    else setCurrentDrafts((drafts) => ({ ...drafts, [mode]: [...drafts[mode], component].sort((left, right) => left.omega - right.omega) }));
    setSelectedIndex([...components, component].sort((left, right) => left.omega - right.omega).findIndex((item) => item.id === component.id));
  };

  const beginDrag = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, orbit: orbitRef.current, moved: false };
    setDragging(true);
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const deltaX = event.clientX - drag.x;
    const deltaY = event.clientY - drag.y;
    if (Math.abs(deltaX) + Math.abs(deltaY) > 4) drag.moved = true;
    setOrbitSafely({ yaw: clamp(drag.orbit.yaw + deltaX * 0.28, -96, 12), pitch: clamp(drag.orbit.pitch - deltaY * 0.2, -26, 18) });
  };
  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!drag.moved) {
      const index = sliceFromTarget(event.target);
      if (index !== null) selectSlice(index);
    }
    const snapped = VIEW_PRESETS[nearestView(orbitRef.current)];
    setOrbitSafely({ yaw: snapped.yaw, pitch: snapped.pitch });
    dragRef.current = null;
    setDragging(false);
  };
  const sliceGap = componentCount > 1 ? (CUBE_DEPTH - 56) / (componentCount - 1) : 0;
  const sliceDepth = (index: number) => (index - (componentCount - 1) / 2) * sliceGap;
  const cubeTransform = `scale(${cubeScale}) rotateX(${orbit.pitch}deg) rotateY(${orbit.yaw}deg)`;
  const sourceLabel = source === "demo" ? "可编辑示范分量" : "当前表达式的主分量（实时采样）";

  return <section className="workspace cube-workspace" aria-label="傅里叶分量立方体">
    <div className="cube-intro">
      <div>
        <p>独立可视化工具</p>
        <h1>时域切片 · 频域侧视</h1>
        <span>时域由多张平行切片组成；右侧 Y 面是一张与切片垂直的半透明频域墙。同色 k 标记、相同深度坐标和同一零幅度轴高度，把每个时域分量与它的频谱峰对应起来。</span>
      </div>
      <div className="cube-source-toggle" role="group" aria-label="立方体数据源">
        <button className={source === "demo" ? "mini-tab active" : "mini-tab"} onClick={() => selectSource("demo")}>示范可编辑分量</button>
        <button className={source === "current" ? "mini-tab active" : "mini-tab"} onClick={() => selectSource("current")}>当前表达式主分量</button>
      </div>
    </div>

    <div className="cube-layout">
      <article className="cube-card cube-visual-card">
        <div className="cube-card-heading">
          <div><p>可拖动旋转</p><h2>{VIEW_PRESETS[activeView].label}</h2></div>
          <span className="domain-pill">{componentCount} 个可编辑分量</span>
        </div>
        <div className="cube-view-controls" role="group" aria-label="立方体预设视角">
          {(Object.keys(VIEW_PRESETS) as ViewId[]).map((view) => <button key={view} className={activeView === view ? "mini-tab active" : "mini-tab"} onClick={() => selectView(view)}>{VIEW_PRESETS[view].label}</button>)}
          <span>拖动旋转 · 滚轮缩放 · 双击回到总览</span>
        </div>
        <div ref={stageRef} className="cube-stage" aria-describedby="cube-instructions">
          <div className="cube-stage-hud" aria-hidden="true"><span>{VIEW_PRESETS[activeView].hint}</span><b>{sourceLabel}</b></div>
          <div className="tf-cube-wrap">
            <div
              className={`tf-cube ${dragging ? "dragging" : ""} ${activeView === "time" ? "time-focus" : ""} ${activeView === "frequency" ? "frequency-focus" : ""}`}
              style={{ transform: cubeTransform }}
              tabIndex={0}
              role="group"
              aria-label="可旋转的时频正交分量立方体。平行的时域切片沿深度排列，右侧垂直频域墙显示每个切片对应的频谱峰。方向键切换分量，数字 1、2、3 切换视图。"
              onPointerDown={beginDrag}
              onPointerMove={moveDrag}
              onPointerUp={finishDrag}
              onPointerCancel={finishDrag}
              onDoubleClick={() => selectView("overview")}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowDown") { event.preventDefault(); selectSlice(selectedIndex - 1); }
                if (event.key === "ArrowRight" || event.key === "ArrowUp") { event.preventDefault(); selectSlice(selectedIndex + 1); }
                if (event.key === "1") selectView("time");
                if (event.key === "2") selectView("overview");
                if (event.key === "3") selectView("frequency");
              }}
            >
              <div className="cube-face cube-face-back" aria-hidden="true" />
              <div className="cube-face cube-face-left" aria-hidden="true" />
              <div className="cube-face cube-face-top" aria-hidden="true" />
              <div className="cube-face cube-face-bottom" aria-hidden="true" />
              <svg className="cube-face cube-face-front cube-composite-face" style={{ transform: `translateZ(${CUBE_DEPTH / 2 + 7}px)` }} viewBox={`0 0 ${CUBE_WIDTH} ${CUBE_HEIGHT}`} role="img" aria-label="最前方透明合成信号；由所有可编辑时域分量实时求和">
                <rect className="composite-face-fill" x="12" y="18" width={CUBE_WIDTH - 24} height={CUBE_HEIGHT - 36} rx="4" />
                {Array.from({ length: 4 }, (_, gridIndex) => <line key={`composite-h-${gridIndex}`} className="composite-grid" x1="28" x2={CUBE_WIDTH - 28} y1={78 + gridIndex * 54} y2={78 + gridIndex * 54} />)}
                {Array.from({ length: 6 }, (_, gridIndex) => <line key={`composite-v-${gridIndex}`} className="composite-grid" x1={28 + gridIndex * ((CUBE_WIDTH - 56) / 5)} x2={28 + gridIndex * ((CUBE_WIDTH - 56) / 5)} y1="38" y2="262" />)}
                <line className="composite-axis" x1="28" y1={SIGNAL_AXIS_Y} x2={CUBE_WIDTH - 28} y2={SIGNAL_AXIS_Y} />
                {mode === "continuous" ? <path className="composite-wave" d={frontCompositePath} /> : <g className="composite-discrete-signal" aria-label="离散合成信号采样点">
                  {frontCompositePoints.map((point, index) => <g key={`composite-sample-${index}`}>
                    <line className="composite-discrete-stem" x1={point.x} x2={point.x} y1={SIGNAL_AXIS_Y} y2={point.y} />
                    <circle className="composite-discrete-dot" cx={point.x} cy={point.y} r="2.4" />
                  </g>)}
                </g>}
                <text className="composite-title" x="28" y="53">前置合成 xΣ({mode === "continuous" ? "t" : "n"}) = Σₖxₖ</text>
                <text className="composite-title" x={CUBE_WIDTH - 28} y="53" textAnchor="end">实时数值求和</text>
                <text className="slice-axis-label" x={CUBE_WIDTH - 28} y="247" textAnchor="end">{mode === "continuous" ? "t" : "n"}</text>
              </svg>
              {components.map((component, index) => {
                const selectedSlice = index === selectedIndex;
                const color = SLICE_COLORS[index % SLICE_COLORS.length];
                const timeRight = CUBE_WIDTH;
                const discretePlotPoints = mode === "discrete" ? componentPlotPoints(component, mode, displayAmplitudeLimit) : [];
                return <svg key={component.id} data-slice-index={index} className={`cube-slice-plane cube-time-slice ${selectedSlice ? "selected" : ""}`} style={{ transform: `translateZ(${sliceDepth(index)}px)`, color, opacity: selectedSlice ? 1 : 0.3 }} viewBox={`0 0 ${CUBE_WIDTH} ${CUBE_HEIGHT}`} role="img" aria-label={`时域切片 k${index + 1}：${componentFrequency(component, mode, true)}`}>
                  <rect className="slice-plane-fill time-slice-fill" x="12" y="18" width={CUBE_WIDTH - 64} height={CUBE_HEIGHT - 36} rx="4" />
                  {Array.from({ length: 4 }, (_, gridIndex) => <line key={`time-h-${gridIndex}`} className="time-slice-grid" x1="28" x2={timeRight} y1={78 + gridIndex * 54} y2={78 + gridIndex * 54} />)}
                  {Array.from({ length: 6 }, (_, gridIndex) => <line key={`time-v-${gridIndex}`} className="time-slice-grid" x1={28 + gridIndex * ((timeRight - 28) / 5)} x2={28 + gridIndex * ((timeRight - 28) / 5)} y1="38" y2="262" />)}
                  <line className="slice-axis" x1="28" y1={SIGNAL_AXIS_Y} x2={timeRight} y2={SIGNAL_AXIS_Y} />
                  <circle className="slice-axis-joint" cx={timeRight} cy={SIGNAL_AXIS_Y} r={selectedSlice ? 3.8 : 2.4} />
                  {mode === "continuous" ? <path className="slice-wave" d={componentPath(component, mode, displayAmplitudeLimit)} /> : <g className="slice-discrete-signal" aria-label="离散时域采样点">
                    {discretePlotPoints.map((point, sampleIndex) => <g key={`slice-sample-${sampleIndex}`}>
                      <line className="slice-discrete-stem" x1={point.x} x2={point.x} y1={SIGNAL_AXIS_Y} y2={point.y} />
                      <circle className="slice-discrete-dot" cx={point.x} cy={point.y} r={selectedSlice ? 2.6 : 2} />
                    </g>)}
                  </g>}
                  <line className="slice-depth-hinge" x1={timeRight} x2={timeRight} y1="39" y2="261" />
                  {selectedSlice && <>
                    <text className="time-slice-title" x="28" y="53">时域 xₖ({mode === "continuous" ? "t" : "n"})</text>
                    <text className="time-slice-title" x={timeRight - 7} y="53" textAnchor="end">k{index + 1} · {componentFrequency(component, mode, true)}</text>
                    <text className="slice-axis-label" x={timeRight - 3} y="247" textAnchor="end">{mode === "continuous" ? "t" : "n"}</text>
                    <text className="slice-caption" x="28" y="283">A = {round(component.amplitude, 3)} · 同色峰位于右侧 Y 面</text>
                    <rect className="selected-slice-outline" x="12" y="18" width={CUBE_WIDTH - 64} height={CUBE_HEIGHT - 36} rx="4" />
                  </>}
                </svg>;
              })}
              <div className="cube-face cube-face-frequency cube-frequency-wall">
                <svg viewBox={`0 0 ${CUBE_DEPTH} ${CUBE_HEIGHT}`} role="img" aria-label="右侧频域 Y 面；每个同色频谱峰对应相同深度的时域切片">
                  <rect className="frequency-face-fill" x="8" y="18" width={CUBE_DEPTH - 16} height={CUBE_HEIGHT - 36} rx="4" />
                  {Array.from({ length: 5 }, (_, gridIndex) => <line key={`frequency-h-${gridIndex}`} className="frequency-wall-grid" x1="22" x2={CUBE_DEPTH - 22} y1={54 + gridIndex * 48} y2={54 + gridIndex * 48} />)}
                  {Array.from({ length: 5 }, (_, gridIndex) => <line key={`frequency-v-${gridIndex}`} className="frequency-wall-grid" x1={22 + gridIndex * ((CUBE_DEPTH - 44) / 4)} x2={22 + gridIndex * ((CUBE_DEPTH - 44) / 4)} y1="38" y2="262" />)}
                  <line className="frequency-wall-axis" x1="22" x2={CUBE_DEPTH - 22} y1={SIGNAL_AXIS_Y} y2={SIGNAL_AXIS_Y} />
                  <text className="frequency-face-title" x="24" y="53">Y 面 · |Xₖ(ω)|</text>
                  <text className="frequency-wall-axis-label" x="22" y="267">切片深度 k（左 → 右递增）· 峰频率见标签</text>
                  {components.map((component, index) => {
                    const selectedSlice = index === selectedIndex;
                    const color = SLICE_COLORS[index % SLICE_COLORS.length];
                    const frequencyX = CUBE_DEPTH / 2 + sliceDepth(index);
                    const peakY = SIGNAL_AXIS_Y - (component.amplitude / displayAmplitudeLimit) * FREQUENCY_PEAK_HEIGHT;
                    return <g key={component.id} data-slice-index={index} className={`frequency-wall-peak ${selectedSlice ? "selected" : ""}`} style={{ color }}>
                      <line className="frequency-depth-guide" x1={frequencyX} x2={frequencyX} y1="42" y2={SIGNAL_AXIS_Y} />
                      <line className="frequency-peak-stem" x1={frequencyX} x2={frequencyX} y1={SIGNAL_AXIS_Y} y2={peakY} />
                      <circle className="frequency-axis-joint" cx={frequencyX} cy={SIGNAL_AXIS_Y} r={selectedSlice ? 3.8 : 2.4} />
                      <circle className="frequency-peak-dot" cx={frequencyX} cy={peakY} r={selectedSlice ? 6 : 4.2} />
                      <text className="frequency-slice-tag" x={frequencyX} y={SIGNAL_AXIS_Y + 20} textAnchor="middle">k{index + 1}</text>
                      {selectedSlice && <><text className="frequency-peak-value" x={frequencyX} y={peakY - 17} textAnchor="middle">A {round(component.amplitude, 2)}</text><text className="frequency-peak-frequency" x={frequencyX} y={peakY - 32} textAnchor="middle">{componentFrequency(component, mode, true)}</text></>}
                    </g>;
                  })}
                </svg>
              </div>
            </div>
          </div>
        </div>
        <p id="cube-instructions" className="cube-instructions">时域切片与半透明右侧 Y 面互相垂直，并在同一零幅度轴高度相交；同色 k 标记和相同深度坐标对应同一分量。点击切片、频谱峰、右侧分量卡或使用方向键可同步选择。</p>
      </article>

      <aside className="cube-data-panel">
        <div className="cube-data-heading"><p>当前对应关系</p><h2>{selected ? `切片 k${selectedIndex + 1}：时域 ↔ 频域` : "尚无可编辑分量"}</h2></div>
        {selected ? <>
          <div className="selected-component-card" style={{ "--slice-color": selectedColor } as CSSProperties}>
            <span className="selected-component-dot" />
            <div><strong>A·cos(ωt + φ)</strong><code>{componentFrequency(selected, mode)}</code></div>
          </div>
          <dl className="component-metrics">
            <div><dt>幅度 A</dt><dd>{round(selected.amplitude, 4)}</dd></div>
            <div><dt>角频率</dt><dd>{round(selected.omega, 4)} {mode === "continuous" ? "rad/s" : "rad/sample"}</dd></div>
            <div><dt>相位 φ</dt><dd>{round(selected.phase, 4)} rad</dd></div>
            <div><dt>数据源</dt><dd>{source === "demo" ? "示范分量" : "导入后副本"}</dd></div>
          </dl>
        </> : <p className="cube-warning">当前信号没有检测到显著正频率分量。可直接新增一个分量，或切换至示范数据。</p>}
        <div className="component-editor">
          <div className="component-editor-heading"><span>分量幅度（实时）</span><button className="add-component" type="button" disabled={componentCount >= 8} onClick={addComponent}>＋ 增加分量</button></div>
          {components.map((component, index) => <div key={component.id} className={index === selectedIndex ? "component-editor-row selected" : "component-editor-row"} style={{ "--slice-color": SLICE_COLORS[index % SLICE_COLORS.length] } as CSSProperties}>
            <button type="button" className="component-editor-select" onClick={() => selectSlice(index)}><b>k{index + 1}</b><span>{componentFrequency(component, mode, true)}</span></button>
            <input aria-label={`分量 k${index + 1} 的幅度`} type="range" min="0" max={Math.max(AMPLITUDE_FLOOR, Math.ceil(displayAmplitudeLimit * 2) / 2)} step="0.01" value={component.amplitude} onChange={(event) => updateAmplitude(component.id, Number(event.target.value))} />
            <output>A {round(component.amplitude, 2)}</output>
          </div>)}
        </div>
        {componentCount > 0 && <label className="slice-picker">当前切片 <output>k{selectedIndex + 1} / {componentCount}</output><input type="range" min="0" max={componentCount - 1} step="1" value={selectedIndex} onChange={(event) => selectSlice(Number(event.target.value))} /></label>}
        <p className="cube-semantic-note">“当前表达式主分量”由实时采样后的频谱峰数值重建；滑块与新增分量会同步改变各切片、右侧同色频谱峰和最前方的主分量合成波形，但不会改写顶部函数表达式。</p>
      </aside>
    </div>
  </section>;
}
