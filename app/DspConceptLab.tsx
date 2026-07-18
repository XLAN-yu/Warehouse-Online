"use client";

import { useMemo, useState, type ReactNode } from "react";

type Complex = { re: number; im: number };
type RealPoint = { x: number; y: number };
type Accent = "cyan" | "violet" | "pink" | "amber" | "mint";
type DspTab = "dft" | "sampling" | "fft" | "fm";
type DftProperty = "timeShift" | "frequencyShift" | "convolution";
type FftAlgorithm = "dit" | "dif";

const TAU = Math.PI * 2;
const PLOT_WIDTH = 620;
const PLOT_HEIGHT = 250;
const PLOT_PAD = { left: 46, right: 18, top: 24, bottom: 34 };
const DEFAULT_FFT_INPUT = [1, 0.5, -0.3, 0.9, 0, -0.65, 0.2, 0.35];

const DSP_TABS: { id: DspTab; label: string; hint: string }[] = [
  { id: "dft", label: "DFT 性质", hint: "循环时移、频移与循环卷积" },
  { id: "sampling", label: "频谱采样", hint: "混叠、栅栏效应与泄漏" },
  { id: "fft", label: "FFT 蝶形", hint: "DIT / DIF 分解与重排" },
  { id: "fm", label: "FM 频谱", hint: "调频指数、边带与带宽" },
];

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function complex(re = 0, im = 0): Complex { return { re, im }; }
function add(left: Complex, right: Complex): Complex { return { re: left.re + right.re, im: left.im + right.im }; }
function subtract(left: Complex, right: Complex): Complex { return { re: left.re - right.re, im: left.im - right.im }; }
function multiply(left: Complex, right: Complex): Complex { return { re: left.re * right.re - left.im * right.im, im: left.re * right.im + left.im * right.re }; }
function rotate(angle: number): Complex { return { re: Math.cos(angle), im: Math.sin(angle) }; }
function magnitude(value: Complex) { return Math.hypot(value.re, value.im); }
function format(value: number, digits = 2) { return Number.isFinite(value) ? value.toFixed(digits) : "0.00"; }
function clone(values: Complex[]) { return values.map((value) => ({ ...value })); }

function dft(values: Complex[]) {
  const count = values.length;
  return Array.from({ length: count }, (_, bin) => values.reduce((sum, value, sample) => add(sum, multiply(value, rotate(-TAU * bin * sample / count))), complex()));
}

function circularConvolution(left: Complex[], right: Complex[]) {
  const count = left.length;
  return Array.from({ length: count }, (_, index) => left.reduce((sum, value, sample) => add(sum, multiply(value, right[(index - sample + count) % count] ?? complex())), complex()));
}

function bitReverse(index: number, bits: number) {
  let result = 0;
  for (let bit = 0; bit < bits; bit += 1) result = (result << 1) | ((index >> bit) & 1);
  return result;
}

function fftStages(input: Complex[], algorithm: FftAlgorithm) {
  const count = input.length;
  const bits = Math.log2(count);
  const stages: Complex[][] = [];
  let current = algorithm === "dit" ? input.map((_, index) => ({ ...input[bitReverse(index, bits)] })) : clone(input);
  stages.push(current);
  for (let stage = 1; stage <= bits; stage += 1) {
    const block = algorithm === "dit" ? 2 ** stage : count / (2 ** (stage - 1));
    const half = block / 2;
    const next = clone(current);
    for (let start = 0; start < count; start += block) {
      for (let offset = 0; offset < half; offset += 1) {
        const top = current[start + offset];
        const bottom = current[start + offset + half];
        const twiddle = rotate(-TAU * offset / block);
        if (algorithm === "dit") {
          const rotated = multiply(bottom, twiddle);
          next[start + offset] = add(top, rotated);
          next[start + offset + half] = subtract(top, rotated);
        } else {
          next[start + offset] = add(top, bottom);
          next[start + offset + half] = multiply(subtract(top, bottom), twiddle);
        }
      }
    }
    current = next;
    stages.push(current);
  }
  return stages;
}

function normalizeComplex(values: Complex[]) { return Math.max(.001, ...values.map(magnitude)); }
function linePath(points: RealPoint[], maximum: number, xMinimum?: number, xMaximum?: number) {
  const left = PLOT_PAD.left; const right = PLOT_WIDTH - PLOT_PAD.right;
  const top = PLOT_PAD.top; const bottom = PLOT_HEIGHT - PLOT_PAD.bottom;
  const minX = xMinimum ?? points[0]?.x ?? 0; const maxX = xMaximum ?? points.at(-1)?.x ?? 1;
  return points.map((point, index) => {
    const x = left + ((point.x - minX) / Math.max(maxX - minX, 1e-8)) * (right - left);
    const y = (top + bottom) / 2 - (point.y / Math.max(maximum, 1e-8)) * (bottom - top) * .42;
    return `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
}
function plotX(value: number, min: number, max: number) { return PLOT_PAD.left + ((value - min) / Math.max(max - min, 1e-8)) * (PLOT_WIDTH - PLOT_PAD.left - PLOT_PAD.right); }
function plotY(value: number, maximum: number) { return PLOT_HEIGHT - PLOT_PAD.bottom - (value / Math.max(maximum, 1e-8)) * (PLOT_HEIGHT - PLOT_PAD.top - PLOT_PAD.bottom) * .82; }

function PlotFrame({ label, children, frequency = false }: { label: string; children: ReactNode; frequency?: boolean }) {
  const vertical = Array.from({ length: 7 }, (_, index) => PLOT_PAD.left + index * ((PLOT_WIDTH - PLOT_PAD.left - PLOT_PAD.right) / 6));
  const horizontal = Array.from({ length: 5 }, (_, index) => PLOT_PAD.top + index * ((PLOT_HEIGHT - PLOT_PAD.top - PLOT_PAD.bottom) / 4));
  return <svg className="dsp-plot" viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`} role="img" aria-label={label}>
    {vertical.map((x) => <line key={`v-${x}`} className="dsp-grid" x1={x} x2={x} y1={PLOT_PAD.top} y2={PLOT_HEIGHT - PLOT_PAD.bottom} />)}
    {horizontal.map((y) => <line key={`h-${y}`} className="dsp-grid" x1={PLOT_PAD.left} x2={PLOT_WIDTH - PLOT_PAD.right} y1={y} y2={y} />)}
    <line className="dsp-axis" x1={PLOT_PAD.left} x2={PLOT_WIDTH - PLOT_PAD.right} y1={frequency ? PLOT_HEIGHT - PLOT_PAD.bottom : PLOT_HEIGHT / 2} y2={frequency ? PLOT_HEIGHT - PLOT_PAD.bottom : PLOT_HEIGHT / 2} />
    <line className="dsp-axis" x1={PLOT_PAD.left} x2={PLOT_PAD.left} y1={PLOT_PAD.top} y2={PLOT_HEIGHT - PLOT_PAD.bottom} />
    {children}
  </svg>;
}

function SequencePlot({ id, label, values, accent = "cyan", continuous, reference, xLabel = "n" }: { id: string; label: string; values: RealPoint[]; accent?: Accent; continuous?: boolean; reference?: RealPoint[]; xLabel?: string }) {
  const all = [...values, ...(reference ?? [])];
  const maximum = Math.max(.2, ...all.map((point) => Math.abs(point.y)));
  const xMinimum = Math.min(...all.map((point) => point.x)); const xMaximum = Math.max(...all.map((point) => point.x));
  const line = reference ? linePath(reference, maximum, xMinimum, xMaximum) : "";
  const ownLine = continuous ? linePath(values, maximum, xMinimum, xMaximum) : "";
  return <PlotFrame label={label}>
    <defs><clipPath id={`clip-${id}`}><rect x={PLOT_PAD.left} y={PLOT_PAD.top} width={PLOT_WIDTH - PLOT_PAD.left - PLOT_PAD.right} height={PLOT_HEIGHT - PLOT_PAD.top - PLOT_PAD.bottom} /></clipPath></defs>
    <g clipPath={`url(#clip-${id})`}>
      {reference && <path className="dsp-reference-line" d={line} />}
      {continuous ? <path className={`dsp-line dsp-${accent}`} d={ownLine} /> : values.map((point, index) => {
        const x = plotX(point.x, xMinimum, xMaximum); const y = PLOT_HEIGHT / 2 - (point.y / maximum) * (PLOT_HEIGHT - PLOT_PAD.top - PLOT_PAD.bottom) * .42;
        return <g key={`${id}-${index}`} className={`dsp-${accent}`}><line className="dsp-stem" x1={x} x2={x} y1={PLOT_HEIGHT / 2} y2={y} /><circle className="dsp-dot" cx={x} cy={y} r="3" /></g>;
      })}
    </g>
    <text className="dsp-label" x={PLOT_PAD.left + 7} y={PLOT_PAD.top + 17}>{label}</text><text className="dsp-axis-label" x={PLOT_WIDTH - PLOT_PAD.right} y={PLOT_HEIGHT - 10} textAnchor="end">{xLabel}</text>
  </PlotFrame>;
}

function SpectrumPlot({ id, label, series, frequencies, unit = "k" }: { id: string; label: string; series: { values: number[]; accent: Accent; label: string }[]; frequencies?: number[]; unit?: string }) {
  const maximum = Math.max(.001, ...series.flatMap((item) => item.values));
  const count = Math.max(...series.map((item) => item.values.length));
  const positions = frequencies ?? Array.from({ length: count }, (_, index) => index);
  const minimum = Math.min(...positions); const maxFrequency = Math.max(...positions);
  return <PlotFrame label={label} frequency>
    <defs><clipPath id={`spectrum-${id}`}><rect x={PLOT_PAD.left} y={PLOT_PAD.top} width={PLOT_WIDTH - PLOT_PAD.left - PLOT_PAD.right} height={PLOT_HEIGHT - PLOT_PAD.top - PLOT_PAD.bottom} /></clipPath></defs>
    <g clipPath={`url(#spectrum-${id})`}>
      {series.map((item, seriesIndex) => item.values.map((value, index) => {
        const baseX = plotX(positions[index] ?? index, minimum, maxFrequency || 1);
        const offset = series.length === 1 ? 0 : (seriesIndex - (series.length - 1) / 2) * 3.4;
        const y = plotY(value, maximum);
        return <g className={`dsp-${item.accent}`} key={`${item.label}-${index}`}><line className="dsp-spectrum-stem" x1={baseX + offset} x2={baseX + offset} y1={PLOT_HEIGHT - PLOT_PAD.bottom} y2={y} /><circle className="dsp-spectrum-dot" cx={baseX + offset} cy={y} r={count > 40 ? 1.7 : 2.8} /></g>;
      }))}
    </g>
    <text className="dsp-label" x={PLOT_PAD.left + 7} y={PLOT_PAD.top + 17}>{label}</text>
    <text className="dsp-axis-label" x={PLOT_PAD.left} y={PLOT_HEIGHT - 10}>{format(minimum, minimum % 1 ? 1 : 0)}</text><text className="dsp-axis-label" x={PLOT_WIDTH - PLOT_PAD.right} y={PLOT_HEIGHT - 10} textAnchor="end">{format(maxFrequency, maxFrequency % 1 ? 1 : 0)} {unit}</text>
  </PlotFrame>;
}

function DspRange({ label, value, text, minimum, maximum, step, onChange, onReset }: { label: string; value: number; text: string; minimum: number; maximum: number; step: number; onChange: (value: number) => void; onReset: () => void }) {
  return <div className="dsp-range-control"><label><span>{label}</span><output>{text}</output><input type="range" min={minimum} max={maximum} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label><button type="button" className="slider-reset" onClick={onReset}>恢复默认</button></div>;
}

function DftUnitCircle({ length, selectedBin, values }: { length: number; selectedBin: number; values: Complex[] }) {
  const width = 350; const height = 218; const centerX = 118; const centerY = 112; const radius = 70;
  const angle = TAU * selectedBin / length - Math.PI / 2;
  const selectedX = centerX + radius * Math.cos(angle); const selectedY = centerY + radius * Math.sin(angle);
  return <svg className="dsp-unit-circle" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`DFT 在单位圆上等角采样，当前选择 k 等于 ${selectedBin}`}>
    <line className="dsp-axis" x1="30" x2="206" y1={centerY} y2={centerY} /><line className="dsp-axis" x1={centerX} x2={centerX} y1="22" y2="202" />
    <circle className="dsp-unit-circle-ring" cx={centerX} cy={centerY} r={radius} /><line className="dsp-unit-circle-ray" x1={centerX} y1={centerY} x2={selectedX} y2={selectedY} />
    {Array.from({ length }, (_, index) => { const pointAngle = TAU * index / length - Math.PI / 2; const x = centerX + radius * Math.cos(pointAngle); const y = centerY + radius * Math.sin(pointAngle); return <g key={index} className={index === selectedBin ? "dsp-unit-circle-point selected" : "dsp-unit-circle-point"}><circle cx={x} cy={y} r={index === selectedBin ? "5.5" : "3.2"} />{(index === 0 || index === selectedBin || index === Math.floor(length / 2)) && <text x={x + 7} y={y - 6}>k{index}</text>}</g>; })}
    <text className="dsp-unit-circle-title" x="226" y="46">zₖ = e<tspan baselineShift="super" fontSize="10">j2πk/N</tspan></text>
    <text className="dsp-unit-circle-copy" x="226" y="83">单位圆采样</text><text className="dsp-unit-circle-copy" x="226" y="105">ωₖ = 2π·{selectedBin}/{length}</text>
    <text className="dsp-unit-circle-value" x="226" y="143">|X[{selectedBin}]| = {format(magnitude(values[selectedBin] ?? complex()), 3)}</text>
    <text className="dsp-unit-circle-copy" x="226" y="174">DTFT 的 N 个</text><text className="dsp-unit-circle-copy" x="226" y="193">等角频率采样点</text>
  </svg>;
}

function DftPropertyLab() {
  const [length, setLength] = useState(16);
  const [property, setProperty] = useState<DftProperty>("timeShift");
  const [shift, setShift] = useState(3);
  const [frequencyShift, setFrequencyShift] = useState(2);
  const [selectedBin, setSelectedBin] = useState(2);
  const base = useMemo<Complex[]>(() => Array.from({ length }, (_, index) => complex(.78 * Math.cos(TAU * 2 * index / length) + .36 * Math.sin(TAU * 5 * index / length))), [length]);
  const filter = useMemo<Complex[]>(() => Array.from({ length }, (_, index) => complex(index === 0 ? 1 : index === 1 ? .62 : index === 2 ? .24 : 0)), [length]);
  const transformed = useMemo(() => {
    if (property === "timeShift") return Array.from({ length }, (_, index) => ({ ...base[(index - shift + length) % length] }));
    if (property === "frequencyShift") return base.map((value, index) => multiply(value, rotate(TAU * frequencyShift * index / length)));
    return circularConvolution(base, filter);
  }, [base, filter, frequencyShift, length, property, shift]);
  const baseSpectrum = useMemo(() => dft(base), [base]);
  const outputSpectrum = useMemo(() => dft(transformed), [transformed]);
  const formula = property === "timeShift"
    ? `y[n] = x[(n − ${shift})]ₙ  ↔  Y[k] = Wₙ^(k·${shift})X[k]`
    : property === "frequencyShift"
      ? `y[n] = x[n]Wₙ^(−${frequencyShift}n)  ↔  Y[k] = X[(k − ${frequencyShift})]ₙ`
      : "y[n] = x[n] Ⓝ h[n]  ↔  Y[k] = X[k]·H[k]";
  return <section className="dsp-lab-panel" aria-label="DFT 性质可视化">
    <div className="dsp-panel-heading"><div><p>PDF：DFT 性质与循环卷积</p><h2>在 N 点圆周上操作序列</h2></div><span className="domain-pill">N = {length}</span></div>
    <div className="dsp-mode-tabs" role="group" aria-label="DFT 性质选择">
      <button className={property === "timeShift" ? "mini-tab active" : "mini-tab"} onClick={() => setProperty("timeShift")}>循环时移</button><button className={property === "frequencyShift" ? "mini-tab active" : "mini-tab"} onClick={() => setProperty("frequencyShift")}>循环频移</button><button className={property === "convolution" ? "mini-tab active" : "mini-tab"} onClick={() => setProperty("convolution")}>循环卷积</button>
    </div>
    <div className="dsp-control-grid">
      <label>DFT 长度 N<select value={length} onChange={(event) => { const next = Number(event.target.value); setLength(next); setSelectedBin((current) => Math.min(current, next - 1)); }}><option value="8">8</option><option value="16">16</option><option value="32">32</option></select></label>
      <DspRange label="查看频点 k" value={selectedBin} text={`k = ${selectedBin}`} minimum={0} maximum={length - 1} step={1} onChange={(value) => setSelectedBin(Math.round(value))} onReset={() => setSelectedBin(2)} />
      {property === "timeShift" && <DspRange label="循环时移 m" value={shift} text={`${shift} 点`} minimum={0} maximum={length - 1} step={1} onChange={(value) => setShift(Math.round(value))} onReset={() => setShift(3)} />}
      {property === "frequencyShift" && <DspRange label="循环频移 r" value={frequencyShift} text={`${frequencyShift} 个频率格`} minimum={0} maximum={length - 1} step={1} onChange={(value) => setFrequencyShift(Math.round(value))} onReset={() => setFrequencyShift(2)} />}
      {property === "convolution" && <span className="dsp-control-note">h[n] = [1, 0.62, 0.24, 0, …]；所有索引按模 N 回绕。若要让 DFT 卷积等于线性卷积，需补零到 N ≥ Nₓ + Nₕ − 1。</span>}
    </div>
    <div className="dsp-formula"><code>{formula}</code><span>每一步均以实际复数 DFT 重新计算。</span></div>
    <div className="dsp-dft-relationship"><div><span>离散序列</span><code>x[n] → X(z)</code><b>限制到 |z| = 1</b><code>X(e<sup>jω</sup>)</code><b>ωₖ = 2πk/N 等角采样</b><code>X[k]</code></div><DftUnitCircle length={length} selectedBin={selectedBin} values={baseSpectrum} /></div>
    <div className="dsp-plot-grid">
      <article><SequencePlot id="dft-source" label="输入序列 Re{x[n]}" values={base.map((value, index) => ({ x: index, y: value.re }))} /><span className="dsp-caption">{property === "convolution" ? "与固定 h[n] 做 N 点循环卷积" : "基础 N 点离散序列"}</span></article>
      <article><SequencePlot id="dft-output" label="输出序列 Re{y[n]}" values={transformed.map((value, index) => ({ x: index, y: value.re }))} accent="violet" /><span className="dsp-caption">{property === "timeShift" ? "幅度不变，相位被线性旋转" : property === "frequencyShift" ? "频谱格点循环平移" : "时域回绕的 N 点输出"}</span></article>
      <article className="dsp-wide-plot"><SpectrumPlot id="dft-spectrum" label="幅度谱对照：|X[k]| 与 |Y[k]|" series={[{ label: "|X[k]|", values: baseSpectrum.map(magnitude), accent: "cyan" }, { label: "|Y[k]|", values: outputSpectrum.map(magnitude), accent: "violet" }]} /><div className="dsp-legend"><span className="dsp-cyan">● |X[k]|</span><span className="dsp-violet">● |Y[k]|</span></div></article>
    </div>
  </section>;
}

function SamplingLab() {
  const [samplingRate, setSamplingRate] = useState(32);
  const [signalFrequency, setSignalFrequency] = useState(11.5);
  const [sampleCount, setSampleCount] = useState(16);
  const duration = sampleCount / samplingRate;
  const samples = useMemo(() => Array.from({ length: sampleCount }, (_, index) => ({ x: index / samplingRate, y: Math.sin(TAU * signalFrequency * index / samplingRate) })), [sampleCount, samplingRate, signalFrequency]);
  const reference = useMemo(() => Array.from({ length: 360 }, (_, index) => { const time = (index / 359) * duration; return { x: time, y: Math.sin(TAU * signalFrequency * time) }; }), [duration, signalFrequency]);
  const spectrum = useMemo(() => dft(samples.map((point) => complex(point.y))).slice(0, Math.floor(sampleCount / 2) + 1).map((value) => magnitude(value) / sampleCount), [sampleCount, samples]);
  const frequencies = useMemo(() => spectrum.map((_, index) => index * samplingRate / sampleCount), [sampleCount, samplingRate, spectrum]);
  const alias = Math.abs((((signalFrequency + samplingRate / 2) % samplingRate) + samplingRate) % samplingRate - samplingRate / 2);
  const bin = signalFrequency * sampleCount / samplingRate;
  const hasAliasing = signalFrequency > samplingRate / 2;
  const hasLeakage = Math.abs(bin - Math.round(bin)) > .02;
  return <section className="dsp-lab-panel" aria-label="频谱采样误差可视化">
    <div className="dsp-panel-heading"><div><p>PDF：混叠、栅栏效应与频谱泄漏</p><h2>改变采样率与观察窗口</h2></div><span className={hasAliasing ? "domain-pill warning" : "domain-pill"}>{hasAliasing ? `混叠到 ${format(alias, 2)} Hz` : "满足奈奎斯特"}</span></div>
    <div className="dsp-control-grid dsp-control-grid-three">
      <DspRange label="原信号频率 f₀" value={signalFrequency} text={`${format(signalFrequency, 1)} Hz`} minimum={1} maximum={48} step={.5} onChange={setSignalFrequency} onReset={() => setSignalFrequency(11.5)} />
      <DspRange label="采样率 fₛ" value={samplingRate} text={`${samplingRate} Hz`} minimum={8} maximum={64} step={1} onChange={setSamplingRate} onReset={() => setSamplingRate(32)} />
      <DspRange label="观察点数 N" value={sampleCount} text={`${sampleCount} 点`} minimum={8} maximum={64} step={8} onChange={(value) => setSampleCount(Math.round(value))} onReset={() => setSampleCount(16)} />
    </div>
    <div className="dsp-metric-row"><span>奈奎斯特频率 <b>{format(samplingRate / 2, 1)} Hz</b></span><span>频率分辨率 Δf <b>{format(samplingRate / sampleCount, 3)} Hz</b></span><span>{hasLeakage ? <><b>非整格频率</b>：能量泄漏到邻近频点</> : <><b>整格频率</b>：谱线落在单一频点</>}</span></div>
    <div className="dsp-plot-grid">
      <article className="dsp-wide-plot"><SequencePlot id="sampling-time" label="连续波形（灰）与离散采样点" values={samples} reference={reference} accent="cyan" xLabel="t / s" /><span className="dsp-caption">红/青色离散点来自 fₛ 的均匀采样；当 f₀ 超过 fₛ/2 时，离散点会与低频别名不可区分。</span></article>
      <article className="dsp-wide-plot"><SpectrumPlot id="sampling-spectrum" label="N 点 DFT 正频率幅度谱" series={[{ label: "|X[k]|", values: spectrum, accent: hasAliasing ? "amber" : "pink" }]} frequencies={frequencies} unit="Hz" /><span className="dsp-caption">N 较小时频点更稀疏（栅栏效应）；观察窗口截断且 f₀ 不落在频点上时出现频谱泄漏。</span></article>
    </div>
  </section>;
}

function FftNetwork({ stages, algorithm, activeStage }: { stages: Complex[][]; algorithm: FftAlgorithm; activeStage: number }) {
  const count = stages[0]?.length ?? 0; const bits = Math.log2(count); const width = 820; const height = 340; const left = 72; const right = 62; const top = 42; const bottom = 38;
  const nodeX = (stage: number) => left + stage * ((width - left - right) / bits);
  const nodeY = (index: number) => top + index * ((height - top - bottom) / Math.max(count - 1, 1));
  const links: { stage: number; source: number; target: number }[] = [];
  for (let stage = 1; stage <= bits; stage += 1) {
    const block = algorithm === "dit" ? 2 ** stage : count / (2 ** (stage - 1)); const half = block / 2;
    for (let start = 0; start < count; start += block) for (let offset = 0; offset < half; offset += 1) {
      links.push({ stage, source: start + offset, target: start + offset }); links.push({ stage, source: start + offset, target: start + offset + half });
      links.push({ stage, source: start + offset + half, target: start + offset }); links.push({ stage, source: start + offset + half, target: start + offset + half });
    }
  }
  return <svg className="fft-network" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${algorithm.toUpperCase()} FFT 蝶形网络，第 ${activeStage} 级被高亮`}>
    {Array.from({ length: bits + 1 }, (_, stage) => <text key={`stage-${stage}`} className={stage === activeStage ? "fft-stage-label active" : "fft-stage-label"} x={nodeX(stage)} y="21" textAnchor="middle">{stage === 0 ? algorithm === "dit" ? "倒序输入" : "自然输入" : `第 ${stage} 级`}</text>)}
    {links.map((link, index) => <line key={`link-${index}`} className={link.stage <= activeStage ? "fft-link active" : "fft-link"} x1={nodeX(link.stage - 1)} y1={nodeY(link.source)} x2={nodeX(link.stage)} y2={nodeY(link.target)} />)}
    {stages.map((values, stage) => values.map((value, index) => <g key={`node-${stage}-${index}`} className={stage === activeStage ? "fft-node active" : "fft-node"}><circle cx={nodeX(stage)} cy={nodeY(index)} r="5.3" /><text x={nodeX(stage) - 10} y={nodeY(index) + 3.5} textAnchor="end">{stage === 0 ? index : ""}</text>{stage === activeStage && <text className="fft-value" x={nodeX(stage) + 9} y={nodeY(index) + 4}>{format(value.re, 1)}{value.im >= 0 ? "+" : ""}{format(value.im, 1)}j</text>}</g>))}
    <text className="fft-order-note" x={nodeX(bits)} y={height - 9} textAnchor="middle">{algorithm === "dit" ? "自然序 X[k]" : "倒序 X[k]"}</text>
  </svg>;
}

function FftLab() {
  const [algorithm, setAlgorithm] = useState<FftAlgorithm>("dit");
  const [input, setInput] = useState(DEFAULT_FFT_INPUT);
  const [activeStage, setActiveStage] = useState(3);
  const complexInput = useMemo(() => input.map((value) => complex(value)), [input]);
  const stages = useMemo(() => fftStages(complexInput, algorithm), [algorithm, complexInput]);
  const naturalOutput = useMemo(() => algorithm === "dit" ? stages.at(-1) ?? [] : (stages.at(-1) ?? []).map((_, index, values) => values[bitReverse(index, 3)]), [algorithm, stages]);
  const direct = useMemo(() => dft(complexInput), [complexInput]);
  const error = Math.max(0, ...direct.map((value, index) => magnitude(subtract(value, naturalOutput[index] ?? complex()))));
  const currentValues = stages[clamp(activeStage, 0, 3)] ?? [];
  return <section className="dsp-lab-panel" aria-label="FFT 蝶形运算可视化">
    <div className="dsp-panel-heading"><div><p>PDF：基 2 FFT、蝶形运算与倒序</p><h2>8 点 {algorithm.toUpperCase()} 分解</h2></div><span className="domain-pill">误差 {error.toExponential(1)}</span></div>
    <div className="dsp-mode-tabs" role="group" aria-label="FFT 算法选择"><button className={algorithm === "dit" ? "mini-tab active" : "mini-tab"} onClick={() => setAlgorithm("dit")}>DIT 时域抽取</button><button className={algorithm === "dif" ? "mini-tab active" : "mini-tab"} onClick={() => setAlgorithm("dif")}>DIF 频域抽取</button></div>
    <div className="fft-input-row"><span>输入 x[n]</span>{input.map((value, index) => <label key={index}><span>{index}</span><input aria-label={`x[${index}]`} type="number" step="0.05" value={value} onChange={(event) => setInput((current) => current.map((item, itemIndex) => itemIndex === index ? Number(event.target.value) || 0 : item))} /></label>)}<button className="slider-reset" type="button" onClick={() => setInput(DEFAULT_FFT_INPUT)}>恢复默认</button></div>
    <DspRange label="显示蝶形级数" value={activeStage} text={activeStage === 0 ? "输入重排" : `第 ${activeStage} 级`} minimum={0} maximum={3} step={1} onChange={(value) => setActiveStage(Math.round(value))} onReset={() => setActiveStage(3)} />
    <FftNetwork stages={stages} algorithm={algorithm} activeStage={activeStage} />
    <div className="dsp-metric-row"><span>{algorithm === "dit" ? "输入：倒序；输出：自然序" : "输入：自然序；输出：倒序"}</span><span>复乘 <b>12</b></span><span>复加 <b>24</b></span><span>当前级：{currentValues.map((value) => format(value.re, 1)).join("，")}</span></div>
    <SpectrumPlot id="fft-spectrum" label="FFT 输出的幅度 |X[k]|" series={[{ label: "|X[k]|", values: naturalOutput.map(magnitude), accent: "violet" }]} />
  </section>;
}

function FmLab() {
  const [carrierFrequency, setCarrierFrequency] = useState(20);
  const [modulationFrequency, setModulationFrequency] = useState(3);
  const [deviation, setDeviation] = useState(7);
  const samplingRate = 256;
  const count = 512;
  const time = useMemo(() => Array.from({ length: count }, (_, index) => {
    const instant = index / samplingRate;
    const beta = deviation / modulationFrequency;
    return { x: instant, y: Math.cos(TAU * carrierFrequency * instant + beta * Math.sin(TAU * modulationFrequency * instant)) };
  }), [carrierFrequency, deviation, modulationFrequency]);
  const spectrum = useMemo(() => {
    const result = dft(time.map((point) => complex(point.y))).slice(0, count / 2 + 1).map((value) => magnitude(value) / count);
    return result;
  }, [time]);
  const frequencies = useMemo(() => spectrum.map((_, index) => index * samplingRate / count), [spectrum]);
  const beta = deviation / modulationFrequency;
  const carson = 2 * (deviation + modulationFrequency);
  return <section className="dsp-lab-panel" aria-label="调频 FM 可视化">
    <div className="dsp-panel-heading"><div><p>PDF：调频指数、频偏与边带</p><h2>FM 时域波形与频谱</h2></div><span className="domain-pill">m<sub>f</sub> = {format(beta, 2)}</span></div>
    <div className="dsp-control-grid dsp-control-grid-three">
      <DspRange label="载波频率 f_c" value={carrierFrequency} text={`${format(carrierFrequency, 1)} Hz`} minimum={5} maximum={40} step={.5} onChange={setCarrierFrequency} onReset={() => setCarrierFrequency(20)} />
      <DspRange label="调制频率 f_m" value={modulationFrequency} text={`${format(modulationFrequency, 1)} Hz`} minimum={1} maximum={12} step={.5} onChange={setModulationFrequency} onReset={() => setModulationFrequency(3)} />
      <DspRange label="最大频偏 Δf" value={deviation} text={`${format(deviation, 1)} Hz`} minimum={.5} maximum={20} step={.5} onChange={setDeviation} onReset={() => setDeviation(7)} />
    </div>
    <div className="dsp-metric-row"><span>调频指数 <b>m<sub>f</sub> = Δf / f<sub>m</sub> = {format(beta, 2)}</b></span><span>Carson 近似带宽 <b>{format(carson, 1)} Hz</b></span><span>边带间隔 <b>{format(modulationFrequency, 1)} Hz</b></span></div>
    <div className="dsp-plot-grid"><article className="dsp-wide-plot"><SequencePlot id="fm-time" label="FM 信号 x(t) = cos(2πf_ct + m_f sin(2πf_mt))" values={time} accent="mint" continuous xLabel="t / s" /></article><article className="dsp-wide-plot"><SpectrumPlot id="fm-spectrum" label="FM 正频率幅度谱：载波与等间隔边带" series={[{ label: "|X(f)|", values: spectrum, accent: "amber" }]} frequencies={frequencies} unit="Hz" /><span className="dsp-caption">拖动 Δf 或 fₘ 后，数值频谱中的边带数量、分布和 Carson 带宽会同步变化。</span></article></div>
  </section>;
}

export function DspConceptLab() {
  const [tab, setTab] = useState<DspTab>("dft");
  const selected = DSP_TABS.find((item) => item.id === tab) ?? DSP_TABS[0];
  return <section className="workspace dsp-workspace" aria-label="数字信号处理实验室">
    <div className="dsp-intro"><div><p>由《数字信号处理》笔记扩展</p><h1>DFT、FFT、频谱采样与 FM 实验</h1><span>所有图像均由当前参数实时采样和数值计算生成；用同一组控制量同时观察时域、频域和算法结构。</span></div><span className="domain-pill">{selected.hint}</span></div>
    <div className="dsp-top-tabs" role="tablist" aria-label="数字信号处理实验模块">{DSP_TABS.map((item) => <button key={item.id} role="tab" aria-selected={tab === item.id} className={tab === item.id ? "mini-tab active" : "mini-tab"} onClick={() => setTab(item.id)}>{item.label}</button>)}</div>
    {tab === "dft" && <DftPropertyLab />}{tab === "sampling" && <SamplingLab />}{tab === "fft" && <FftLab />}{tab === "fm" && <FmLab />}
  </section>;
}
