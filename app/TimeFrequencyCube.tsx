"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type WheelEvent } from "react";
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
const CUBE_DEPTH = 300;
const SLICE_COLORS = ["#45e7ff", "#a895ff", "#54e4bc", "#ff9cda", "#ffa968", "#6bb6ff", "#e4d66a", "#ff7f9a"];

const VIEW_PRESETS: Record<ViewId, Orbit & { label: string; hint: string }> = {
  time: { yaw: 0, pitch: -3, label: "时域面", hint: "正面：合成信号与各个时域分量" },
  overview: { yaw: -32, pitch: -12, label: "透视总览", hint: "同时查看时域切片和频谱峰" },
  frequency: { yaw: -88, pitch: -2, label: "频域面", hint: "右侧：每个切片对应的频率与幅度" },
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

function makeDemoSignal(mode: DomainMode, components: FrequencyComponent[]): Point[] {
  const { start, end, count } = timeRange(mode);
  const step = (end - start) / Math.max(count - 1, 1);
  return Array.from({ length: count }, (_, index) => {
    const x = start + index * step;
    return { x, y: components.reduce((sum, component) => sum + componentValue(component, x), 0) };
  });
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

function pointPath(points: Point[], width: number, height: number, maxValue: number) {
  const finite = points.filter((point) => Number.isFinite(point.y));
  if (!finite.length) return "";
  const minimumX = points[0]?.x ?? -1;
  const maximumX = points[points.length - 1]?.x ?? 1;
  const xSpan = Math.max(maximumX - minimumX, 1e-8);
  let drawn = false;
  return points.map((point) => {
    if (!Number.isFinite(point.y)) { drawn = false; return ""; }
    const x = 20 + ((point.x - minimumX) / xSpan) * (width - 40);
    const y = height / 2 - (point.y / Math.max(maxValue, 1e-8)) * height * 0.32;
    const command = drawn ? "L" : "M";
    drawn = true;
    return `${command}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
}

function componentPath(component: FrequencyComponent, mode: DomainMode, width: number, height: number, amplitudeScale: number) {
  const { start, end, count } = timeRange(mode);
  return Array.from({ length: count }, (_, index) => {
    const time = start + ((end - start) * index) / Math.max(count - 1, 1);
    const x = 20 + (index / Math.max(count - 1, 1)) * (width - 40);
    const y = height / 2 - (componentValue(component, time) / Math.max(amplitudeScale, 1e-8)) * height * 0.34;
    return `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
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

export function TimeFrequencyCube({ signal, spectrum, mode }: { signal: Point[]; spectrum: ComplexPoint[]; mode: DomainMode }) {
  const [source, setSource] = useState<SliceSource>("demo");
  const [selectedIndex, setSelectedIndex] = useState(1);
  const [orbit, setOrbit] = useState<Orbit>({ yaw: VIEW_PRESETS.overview.yaw, pitch: VIEW_PRESETS.overview.pitch });
  const [cubeScale, setCubeScale] = useState(1);
  const [dragging, setDragging] = useState(false);
  const orbitRef = useRef(orbit);
  const dragRef = useRef<{ x: number; y: number; orbit: Orbit; moved: boolean } | null>(null);

  const demoComponents = mode === "continuous" ? DEMO_CONTINUOUS : DEMO_DISCRETE;
  const demoSignal = useMemo(() => makeDemoSignal(mode, demoComponents), [demoComponents, mode]);
  const currentComponents = useMemo(() => extractComponents(spectrum, signal, mode), [mode, signal, spectrum]);
  const components = source === "demo" ? demoComponents : currentComponents;
  const sourceSignal = source === "demo" ? demoSignal : signal;
  const maxAmplitude = Math.max(0.05, ...components.map((component) => component.amplitude));
  const maxSourceValue = Math.max(0.05, ...sourceSignal.filter((point) => Number.isFinite(point.y)).map((point) => Math.abs(point.y)));
  const selected = components[clamp(selectedIndex, 0, Math.max(components.length - 1, 0))] ?? demoComponents[0];
  const activeView = nearestView(orbit);
  const currentIsSparse = source === "current" && components.length < 2;

  useEffect(() => {
    setSelectedIndex((index) => clamp(index, 0, Math.max(components.length - 1, 0)));
  }, [components.length]);

  const setOrbitSafely = (next: Orbit) => {
    orbitRef.current = next;
    setOrbit(next);
  };
  const selectView = (view: ViewId) => setOrbitSafely({ yaw: VIEW_PRESETS[view].yaw, pitch: VIEW_PRESETS[view].pitch });
  const selectSlice = (index: number) => setSelectedIndex(clamp(index, 0, Math.max(components.length - 1, 0)));

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
    setOrbitSafely({ yaw: clamp(drag.orbit.yaw + deltaX * 0.32, -98, 8), pitch: clamp(drag.orbit.pitch - deltaY * 0.2, -28, 18) });
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
  const zoomCube = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    setCubeScale((current) => clamp(current - event.deltaY * 0.001, 0.76, 1.22));
  };

  const sliceDepth = (index: number) => -112 + (index * 224) / Math.max(components.length - 1, 1);
  const cubeTransform = `scale(${cubeScale}) rotateX(${orbit.pitch}deg) rotateY(${orbit.yaw}deg)`;
  const sourcePath = pointPath(sourceSignal, CUBE_WIDTH, CUBE_HEIGHT, maxSourceValue);

  return <section className="workspace cube-workspace" aria-label="傅里叶分量立方体">
    <div className="cube-intro">
      <div>
        <p>独立可视化工具</p>
        <h1>傅里叶分量立方体</h1>
        <span>X 轴为时间，向内的每个平行切片是一条主要频率分量；旋转至右侧 Y 面即可看到其对应的频率峰与幅度。</span>
      </div>
      <div className="cube-source-toggle" role="group" aria-label="立方体数据源">
        <button className={source === "demo" ? "mini-tab active" : "mini-tab"} onClick={() => { setSource("demo"); setSelectedIndex(1); }}>示范多分量</button>
        <button className={source === "current" ? "mini-tab active" : "mini-tab"} onClick={() => { setSource("current"); setSelectedIndex(0); }}>当前 x({mode === "continuous" ? "t" : "n"})</button>
      </div>
    </div>

    <div className="cube-layout">
      <article className="cube-card cube-visual-card">
        <div className="cube-card-heading">
          <div><p>可拖动旋转</p><h2>{VIEW_PRESETS[activeView].label}</h2></div>
          <span className="domain-pill">{components.length} 个主要正频率分量</span>
        </div>
        <div className="cube-view-controls" role="group" aria-label="立方体预设视角">
          {(Object.keys(VIEW_PRESETS) as ViewId[]).map((view) => <button key={view} className={activeView === view ? "mini-tab active" : "mini-tab"} onClick={() => selectView(view)}>{VIEW_PRESETS[view].label}</button>)}
          <span>拖动旋转 · 滚轮缩放 · 双击总览</span>
        </div>
        <div className="cube-stage" aria-describedby="cube-instructions" onWheel={zoomCube}>
          <div className="cube-stage-hud" aria-hidden="true"><span>{VIEW_PRESETS[activeView].hint}</span><b>{source === "demo" ? "演示混合信号" : "当前编辑信号"}</b></div>
          <div className="tf-cube-wrap">
          <div
            className={`tf-cube ${dragging ? "dragging" : ""}`}
            style={{ transform: cubeTransform }}
            tabIndex={0}
            role="group"
            aria-label="可旋转的时域频域分量立方体。方向键切换分量，数字 1、2、3 切换时域、总览和频域视图。"
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
            {components.map((component, index) => {
              const selectedSlice = index === selectedIndex;
              const color = SLICE_COLORS[index % SLICE_COLORS.length];
              return <svg key={component.id} className={`cube-slice-plane ${selectedSlice ? "selected" : ""}`} style={{ transform: `translateZ(${sliceDepth(index)}px)`, color, opacity: selectedSlice ? 1 : 0.22 }} viewBox={`0 0 ${CUBE_WIDTH} ${CUBE_HEIGHT}`} aria-hidden="true">
                <rect className="slice-plane-fill" x="8" y="18" width={CUBE_WIDTH - 16} height={CUBE_HEIGHT - 36} rx="3" />
                <line className="slice-axis" x1="20" y1={CUBE_HEIGHT / 2} x2={CUBE_WIDTH - 20} y2={CUBE_HEIGHT / 2} />
                <path className="slice-wave" d={componentPath(component, mode, CUBE_WIDTH, CUBE_HEIGHT, maxAmplitude)} />
                {selectedSlice && <><text className="slice-caption" x="25" y="42">k{index + 1} · A={round(component.amplitude, 3)}</text><text className="slice-caption slice-caption-right" x={CUBE_WIDTH - 25} y="42" textAnchor="end">{componentFrequency(component, mode, true)}</text></>}
              </svg>;
            })}
            <div className="cube-face cube-face-time">
              <svg viewBox={`0 0 ${CUBE_WIDTH} ${CUBE_HEIGHT}`} aria-hidden="true">
                <rect className="front-grid-fill" x="8" y="18" width={CUBE_WIDTH - 16} height={CUBE_HEIGHT - 36} rx="3" />
                {Array.from({ length: 7 }, (_, index) => <line key={`tv-${index}`} className="cube-grid-line" x1={20 + ((CUBE_WIDTH - 40) * index) / 6} x2={20 + ((CUBE_WIDTH - 40) * index) / 6} y1="28" y2={CUBE_HEIGHT - 28} />)}
                {Array.from({ length: 5 }, (_, index) => <line key={`th-${index}`} className="cube-grid-line" x1="20" x2={CUBE_WIDTH - 20} y1={34 + ((CUBE_HEIGHT - 68) * index) / 4} y2={34 + ((CUBE_HEIGHT - 68) * index) / 4} />)}
                <line className="slice-axis source-axis" x1="20" y1={CUBE_HEIGHT / 2} x2={CUBE_WIDTH - 20} y2={CUBE_HEIGHT / 2} />
                <path className="source-wave" d={sourcePath} />
                <text className="face-title" x="24" y="45">X 面 · 合成时域 x({mode === "continuous" ? "t" : "n"})</text>
                <text className="face-axis" x={CUBE_WIDTH - 25} y={CUBE_HEIGHT - 24} textAnchor="end">{mode === "continuous" ? "t" : "n"}</text>
              </svg>
            </div>
            <div className="cube-face cube-face-frequency">
              <svg viewBox={`0 0 ${CUBE_DEPTH} ${CUBE_HEIGHT}`} aria-hidden="true">
                <rect className="frequency-face-fill" x="8" y="18" width={CUBE_DEPTH - 16} height={CUBE_HEIGHT - 36} rx="3" />
                <line className="slice-axis frequency-axis" x1="27" y1={CUBE_HEIGHT - 43} x2={CUBE_DEPTH - 20} y2={CUBE_HEIGHT - 43} />
                <text className="face-title frequency-face-title" x="24" y="43">Y 面 · |X(ω)|</text>
                <text className="face-axis" x="24" y={CUBE_HEIGHT - 18}>正频率峰</text>
                {components.map((component, index) => {
                  const selectedSlice = index === selectedIndex;
                  const color = SLICE_COLORS[index % SLICE_COLORS.length];
                  const x = components.length === 1 ? CUBE_DEPTH / 2 : 32 + (index * (CUBE_DEPTH - 62)) / (components.length - 1);
                  const y = CUBE_HEIGHT - 43 - (component.amplitude / maxAmplitude) * 172;
                  return <g key={component.id} data-slice-index={index} className={`frequency-peak ${selectedSlice ? "selected" : ""}`} style={{ color }}>
                    <line x1={x} x2={x} y1={CUBE_HEIGHT - 43} y2={y} />
                    <circle cx={x} cy={y} r={selectedSlice ? 6 : 4} />
                    <text x={x} y={CUBE_HEIGHT - 28} textAnchor="middle">k{index + 1}</text>
                    {selectedSlice && <><text className="peak-value" x={x} y={y - 12} textAnchor="middle">A {round(component.amplitude, 2)}</text><text className="peak-frequency" x={x} y={y - 28} textAnchor="middle">{componentFrequency(component, mode, true)}</text></>}
                  </g>;
                })}
              </svg>
            </div>
          </div>
          </div>
        </div>
        <p id="cube-instructions" className="cube-instructions">拖到右侧可观察 Y 频域面；点击频谱峰或下方分量可同步高亮。键盘方向键可切换当前分量。</p>
      </article>

      <aside className="cube-data-panel">
        <div className="cube-data-heading"><p>当前对应关系</p><h2>切片 k{selectedIndex + 1} ↔ 频谱峰</h2></div>
        <div className="selected-component-card" style={{ "--slice-color": SLICE_COLORS[selectedIndex % SLICE_COLORS.length] } as CSSProperties}>
          <span className="selected-component-dot" />
          <div><strong>A·cos(ωt + φ)</strong><code>{componentFrequency(selected, mode)}</code></div>
        </div>
        <dl className="component-metrics">
          <div><dt>幅度 A</dt><dd>{round(selected.amplitude, 4)}</dd></div>
          <div><dt>角频率</dt><dd>{round(selected.omega, 4)} {mode === "continuous" ? "rad/s" : "rad/sample"}</dd></div>
          <div><dt>相位 φ</dt><dd>{round(selected.phase, 4)} rad</dd></div>
          <div><dt>数据源</dt><dd>{source === "demo" ? "示范混合信号" : "当前表达式"}</dd></div>
        </dl>
        <label className="slice-picker">当前切片 <output>k{selectedIndex + 1} / {components.length}</output><input type="range" min="0" max={Math.max(components.length - 1, 0)} step="1" value={selectedIndex} onChange={(event) => selectSlice(Number(event.target.value))} /></label>
        <div className="slice-chip-row" aria-label="选择频率分量">{components.map((component, index) => <button key={component.id} className={index === selectedIndex ? "slice-chip active" : "slice-chip"} style={{ "--slice-color": SLICE_COLORS[index % SLICE_COLORS.length] } as CSSProperties} onClick={() => selectSlice(index)}><b>k{index + 1}</b><span>{componentFrequency(component, mode, true)}</span></button>)}</div>
        {currentIsSparse && <p className="cube-warning">当前信号只检测到 {components.length} 个显著正频率分量。切换到“示范多分量”可查看完整的多层切片关系。</p>}
        <p className="cube-semantic-note">数学约定：前方为合成信号；向内的平面为主要正频率分量 Aₖcos(ωₖt+φₖ)，右面峰值与切片 k 一一对应。</p>
      </aside>
    </div>
  </section>;
}
