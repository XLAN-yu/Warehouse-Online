export type DomainMode = "continuous" | "discrete";
export type Point = { x: number; y: number };
export type ComplexPoint = Point & { re: number; im: number; magnitude: number; phase: number };
export type ExpressionAxis = "time" | "frequency";

export type SignalPreset = {
  id: string;
  label: string;
  expression: string;
  description: string;
};

export const SIGNAL_PRESETS: Record<DomainMode, SignalPreset[]> = {
  continuous: [
    { id: "c-impulse", label: "单位冲激 δ(t)", expression: "delta(t)", description: "面积为 1 的理想冲激（数值近似显示）" },
    { id: "c-step", label: "单位阶跃 u(t)", expression: "step(t)", description: "t ≥ 0 时为 1" },
    { id: "c-ramp", label: "斜坡 r(t)", expression: "t*step(t)", description: "t·u(t)" },
    { id: "c-rect", label: "矩形脉冲 Gτ(t)", expression: "rect(t/1.5)", description: "宽度 τ = 1.5" },
    { id: "c-triangle", label: "三角脉冲", expression: "tri(t/1.5)", description: "三角形有限时宽脉冲" },
    { id: "c-exponential", label: "指数信号 e^{st}", expression: "exp(-t)*step(t)", description: "默认显示实部的衰减指数" },
    { id: "c-sine", label: "正弦信号", expression: "sin(2*pi*2*t)", description: "A·sin(ωt+φ)" },
    { id: "c-cosine", label: "余弦信号", expression: "cos(2*pi*2*t)", description: "A·cos(ωt+φ)" },
    { id: "c-complex", label: "复指数（实部）", expression: "cos(2*pi*2*t)", description: "Re{e^{jωt}}，实值视图显示实部" },
    { id: "c-sa", label: "抽样信号 Sa(t)", expression: "sa(t)", description: "sin(t)/t，t = 0 时为 1" },
    { id: "c-sign", label: "符号函数 sgn(t)", expression: "sgn(t)", description: "正负极性函数" },
    { id: "c-gaussian", label: "高斯信号", expression: "exp(-0.8*t^2)", description: "e^{-αt²}" },
  ],
  discrete: [
    { id: "d-impulse", label: "单位脉冲序列 δ[n]", expression: "delta(n)", description: "n = 0 时为 1" },
    { id: "d-step", label: "单位阶跃序列 u[n]", expression: "step(n)", description: "n ≥ 0 时为 1" },
    { id: "d-exponential", label: "指数序列 aⁿu[n]", expression: "0.88^n*step(n)", description: "默认 a = 0.88" },
    { id: "d-sine", label: "正弦序列", expression: "sin(0.25*pi*n)", description: "A·sin(Ωn+φ)" },
    { id: "d-complex", label: "复指数序列（实部）", expression: "cos(0.25*pi*n)", description: "Re{e^{jΩn}}" },
  ],
};

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function expressionForPreset(id: string, mode: DomainMode) {
  return SIGNAL_PRESETS[mode].find((preset) => preset.id === id)?.expression ?? SIGNAL_PRESETS[mode][0].expression;
}

export function defaultPreset(mode: DomainMode) {
  return mode === "continuous" ? "c-sine" : "d-sine";
}

type TokenKind = "number" | "identifier" | "operator" | "left" | "right" | "comma" | "question" | "colon" | "eof";
type Token = { kind: TokenKind; value: string; at: number };
type EvalContext = { t: number; n: number; w: number; omega: number; k: number; dt: number };
type Node = (context: EvalContext) => number;

const isIdentifierStart = (character: string) => /[a-z_]/i.test(character);
const isIdentifierPart = (character: string) => /[a-z0-9_]/i.test(character);

function normalizeSource(source: string) {
  const superscripts: Record<string, string> = { "⁰": "^0", "¹": "^1", "²": "^2", "³": "^3", "⁴": "^4", "⁵": "^5", "⁶": "^6", "⁷": "^7", "⁸": "^8", "⁹": "^9" };
  const normalized = source
    .trim()
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (character) => superscripts[character])
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/^\s*(?:x|y|f)\s*(?:\(\s*[tn]\s*\)|\[\s*n\s*\])\s*=\s*/i, "")
    .replace(/\\(sin|cos|tan|exp|sqrt|pi|omega|delta|ln|log)/gi, "$1")
    .replace(/[Ππ]/g, " pi ")
    .replace(/[ωΩ]/g, " omega ")
    .replace(/δ/g, " delta ")
    .replace(/√/g, "sqrt")
    .replace(/[（【\[]/g, "(")
    .replace(/[）】\]]/g, ")")
    .replace(/[，]/g, ",")
    .replace(/≤/g, "<=")
    .replace(/≥/g, ">=")
    .replace(/≠/g, "!=")
    .replace(/[×·]/g, "*")
    .replace(/÷/g, "/")
    .replace(/[−–—]/g, "-")
    .replace(/\*\*/g, "^")
    .replace(/\bmath\./gi, "")
    .replace(/\bln\b/gi, "log")
    .replace(/\blg\b/gi, "log10")
    .replace(/\blog_?10\b/gi, "log10")
    .replace(/\barcsin\b/gi, "asin")
    .replace(/\barccos\b/gi, "acos")
    .replace(/\barctan\b/gi, "atan")
    .replace(/\bsign\b/gi, "sgn")
    .replace(/\bmod\b/gi, "rem")
    .replace(/\b(?:heaviside|unitstep)\b/gi, "step");
  return normalized
    .replace(/(^|[+\-*/^(,?:])\s*\|([^|]+)\|/g, "$1abs($2)")
    .replace(/\b(sin|cos|tan|sinh|cosh|tanh)\s*\^(\d+)\s*(\([^()]*\))/gi, "$1$3^$2");
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) { index += 1; continue; }
    if (/\d/.test(character) || (character === "." && /\d/.test(source[index + 1] ?? ""))) {
      const match = source.slice(index).match(/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i);
      if (!match) throw new Error(`第 ${index + 1} 位数字格式有误`);
      tokens.push({ kind: "number", value: match[0], at: index });
      index += match[0].length;
      continue;
    }
    if (isIdentifierStart(character)) {
      let end = index + 1;
      while (end < source.length && isIdentifierPart(source[end])) end += 1;
      tokens.push({ kind: "identifier", value: source.slice(index, end).toLowerCase(), at: index });
      index = end;
      continue;
    }
    const twoCharacter = source.slice(index, index + 2);
    if (["<=", ">=", "==", "!=", "&&", "||"].includes(twoCharacter)) {
      tokens.push({ kind: "operator", value: twoCharacter, at: index });
      index += 2;
      continue;
    }
    if ("+-*/%^<>!".includes(character)) {
      tokens.push({ kind: "operator", value: character, at: index });
      index += 1;
      continue;
    }
    if (character === "(") tokens.push({ kind: "left", value: character, at: index });
    else if (character === ")") tokens.push({ kind: "right", value: character, at: index });
    else if (character === ",") tokens.push({ kind: "comma", value: character, at: index });
    else if (character === "?") tokens.push({ kind: "question", value: character, at: index });
    else if (character === ":") tokens.push({ kind: "colon", value: character, at: index });
    else throw new Error(`第 ${index + 1} 位包含不支持的字符“${character}”`);
    index += 1;
  }
  tokens.push({ kind: "eof", value: "", at: source.length });
  return tokens;
}

const functionMap: Record<string, (args: number[], context: EvalContext) => number> = {
  sin: ([value]) => Math.sin(value), cos: ([value]) => Math.cos(value), tan: ([value]) => Math.tan(value),
  asin: ([value]) => Math.asin(value), acos: ([value]) => Math.acos(value), atan: ([value]) => Math.atan(value),
  sinh: ([value]) => Math.sinh(value), cosh: ([value]) => Math.cosh(value), tanh: ([value]) => Math.tanh(value),
  exp: ([value]) => Math.exp(value), log: ([value]) => value > 0 ? Math.log(value) : Number.NaN,
  log10: ([value]) => value > 0 ? Math.log10(value) : Number.NaN,
  sqrt: ([value]) => value >= 0 ? Math.sqrt(value) : Number.NaN, abs: ([value]) => Math.abs(value),
  floor: ([value]) => Math.floor(value), ceil: ([value]) => Math.ceil(value), round: ([value]) => Math.round(value),
  min: (values) => Math.min(...values), max: (values) => Math.max(...values), pow: ([left, right]) => Math.pow(left, right), atan2: ([left, right]) => Math.atan2(left, right),
  cot: ([value]) => Math.cos(value) / Math.sin(value), sec: ([value]) => 1 / Math.cos(value), csc: ([value]) => 1 / Math.sin(value),
  rect: ([value]) => Math.abs(value) <= 0.5 ? 1 : 0, tri: ([value]) => Math.max(1 - Math.abs(value), 0),
  step: ([value]) => value >= 0 ? 1 : 0, u: ([value]) => value >= 0 ? 1 : 0,
  sgn: ([value]) => Math.sign(value), rem: ([left, right]) => left % right,
  sa: ([value]) => Math.abs(value) < 1e-10 ? 1 : Math.sin(value) / value,
  sinc: ([value]) => Math.abs(value) < 1e-10 ? 1 : Math.sin(Math.PI * value) / (Math.PI * value),
  delta: ([value], context) => Math.abs(value) <= context.dt / 2 ? 1 / Math.max(context.dt, 1e-8) : 0,
  impulse: ([value], context) => Math.abs(value) <= context.dt / 2 ? 1 / Math.max(context.dt, 1e-8) : 0,
};

const functionArity: Record<string, { min: number; max: number }> = {
  min: { min: 1, max: Number.POSITIVE_INFINITY }, max: { min: 1, max: Number.POSITIVE_INFINITY },
  pow: { min: 2, max: 2 }, rem: { min: 2, max: 2 }, atan2: { min: 2, max: 2 },
  sin: { min: 1, max: 1 }, cos: { min: 1, max: 1 }, tan: { min: 1, max: 1 },
  asin: { min: 1, max: 1 }, acos: { min: 1, max: 1 }, atan: { min: 1, max: 1 },
  sinh: { min: 1, max: 1 }, cosh: { min: 1, max: 1 }, tanh: { min: 1, max: 1 },
  exp: { min: 1, max: 1 }, log: { min: 1, max: 1 }, log10: { min: 1, max: 1 }, sqrt: { min: 1, max: 1 }, abs: { min: 1, max: 1 },
  floor: { min: 1, max: 1 }, ceil: { min: 1, max: 1 }, round: { min: 1, max: 1 },
  cot: { min: 1, max: 1 }, sec: { min: 1, max: 1 }, csc: { min: 1, max: 1 },
  rect: { min: 1, max: 1 }, tri: { min: 1, max: 1 }, step: { min: 1, max: 1 }, u: { min: 1, max: 1 }, sgn: { min: 1, max: 1 },
  sa: { min: 1, max: 1 }, sinc: { min: 1, max: 1 }, delta: { min: 1, max: 1 }, impulse: { min: 1, max: 1 },
};

class Parser {
  private cursor = 0;
  constructor(private readonly tokens: Token[]) {}
  private current() { return this.tokens[this.cursor]; }
  private advance() { const token = this.current(); this.cursor += 1; return token; }
  private isOperator(...values: string[]) { return this.current().kind === "operator" && values.includes(this.current().value); }
  private matchOperator(...values: string[]) { if (this.isOperator(...values)) { this.advance(); return true; } return false; }
  private expect(kind: TokenKind, message: string) { if (this.current().kind !== kind) throw new Error(`${message}（第 ${this.current().at + 1} 位）`); return this.advance(); }
  private primaryStart(token: Token) { return token.kind === "number" || token.kind === "identifier" || token.kind === "left"; }
  parse() { const result = this.conditional(); this.expect("eof", "表达式末尾存在多余内容"); return result; }
  private conditional(): Node {
    const test = this.logicalOr();
    if (this.current().kind !== "question") return test;
    this.advance();
    const yes = this.conditional();
    this.expect("colon", "条件表达式缺少 :");
    const no = this.conditional();
    return (context) => test(context) !== 0 ? yes(context) : no(context);
  }
  private logicalOr(): Node {
    let left = this.logicalAnd();
    while (this.matchOperator("||")) { const previous = left; const right = this.logicalAnd(); left = (context) => previous(context) !== 0 || right(context) !== 0 ? 1 : 0; }
    return left;
  }
  private logicalAnd(): Node {
    let left = this.comparison();
    while (this.matchOperator("&&")) { const previous = left; const right = this.comparison(); left = (context) => previous(context) !== 0 && right(context) !== 0 ? 1 : 0; }
    return left;
  }
  private comparison(): Node {
    let left = this.sum();
    while (this.isOperator("<", "<=", ">", ">=", "==", "!=")) {
      const operator = this.advance().value; const previous = left; const right = this.sum();
      left = (context) => {
        const a = previous(context); const b = right(context);
        const result = operator === "<" ? a < b : operator === "<=" ? a <= b : operator === ">" ? a > b : operator === ">=" ? a >= b : operator === "==" ? a === b : a !== b;
        return result ? 1 : 0;
      };
    }
    return left;
  }
  private sum(): Node {
    let left = this.product();
    while (this.isOperator("+", "-")) {
      const operator = this.advance().value; const previous = left; const right = this.product();
      left = operator === "+" ? (context) => previous(context) + right(context) : (context) => previous(context) - right(context);
    }
    return left;
  }
  private product(): Node {
    let left = this.unary();
    while (true) {
      if (this.isOperator("*", "/", "%")) {
        const operator = this.advance().value; const previous = left; const right = this.unary();
        left = operator === "*" ? (context) => previous(context) * right(context) : operator === "/" ? (context) => previous(context) / right(context) : (context) => previous(context) % right(context);
      } else if (this.primaryStart(this.current())) {
        const previous = left; const right = this.unary(); left = (context) => previous(context) * right(context);
      } else break;
    }
    return left;
  }
  private unary(): Node {
    if (this.matchOperator("+")) return this.unary();
    if (this.matchOperator("-")) { const node = this.unary(); return (context) => -node(context); }
    if (this.matchOperator("!")) { const node = this.unary(); return (context) => node(context) === 0 ? 1 : 0; }
    return this.power();
  }
  private power(): Node {
    const left = this.primary();
    if (!this.matchOperator("^")) return left;
    const right = this.unary();
    return (context) => Math.pow(left(context), right(context));
  }
  private primary(): Node {
    const token = this.current();
    if (token.kind === "number") { this.advance(); const value = Number(token.value); return () => value; }
    if (token.kind === "identifier") {
      this.advance(); const name = token.value;
      if (this.current().kind === "left") {
        if (!functionMap[name]) throw new Error(`函数 ${name} 不受支持（第 ${token.at + 1} 位）`);
        this.advance(); const args: Node[] = [];
        if (this.current().kind !== "right") {
          args.push(this.conditional());
          while (this.current().kind === "comma") { this.advance(); args.push(this.conditional()); }
        }
        this.expect("right", `函数 ${name} 缺少右括号`);
        const arity = functionArity[name];
        if (args.length < arity.min || args.length > arity.max) throw new Error(`函数 ${name} 需要 ${arity.min === arity.max ? arity.min : `${arity.min} 个及以上`} 个参数（第 ${token.at + 1} 位）`);
        return (context) => functionMap[name](args.map((argument) => argument(context)), context);
      }
      if (name === "pi") return () => Math.PI;
      if (name === "e") return () => Math.E;
      if (["t", "n", "w", "omega", "k"].includes(name)) return (context) => context[name as keyof EvalContext];
      throw new Error(`变量 ${name} 不受支持（第 ${token.at + 1} 位）`);
    }
    if (token.kind === "left") { this.advance(); const node = this.conditional(); this.expect("right", "缺少右括号"); return node; }
    throw new Error(`此处应为数字、变量、函数或左括号（第 ${token.at + 1} 位）`);
  }
}

export type CompiledExpression = { fn: (value: number, axis?: ExpressionAxis, dt?: number) => number; error: string | null };

export function compileExpression(source: string): CompiledExpression {
  try {
    if (source.trim().length > 2000) throw new Error("表达式过长");
    const tokens = tokenize(normalizeSource(source));
    if (tokens.length > 512) throw new Error("表达式过于复杂");
    const tree = new Parser(tokens).parse();
    return {
      fn: (value, axis = "time", dt = 1) => {
        const context: EvalContext = axis === "time"
          ? { t: value, n: value, w: 0, omega: 0, k: 0, dt }
          : { t: 0, n: 0, w: value, omega: value, k: value, dt };
        const result = tree(context);
        return Number.isFinite(result) ? clamp(result, -1e8, 1e8) : Number.NaN;
      },
      error: null,
    };
  } catch (error) {
    return { fn: () => Number.NaN, error: error instanceof Error ? error.message : "表达式无法解析" };
  }
}

export function sampleSignal(fn: CompiledExpression["fn"], mode: DomainMode, count: number, shift = 0): Point[] {
  const safeCount = Math.max(2, Math.round(count));
  const step = mode === "continuous" ? 8 / (safeCount - 1) : 1;
  const start = mode === "continuous" ? -4 : -Math.floor(safeCount / 2);
  return Array.from({ length: safeCount }, (_, index) => {
    const x = start + index * step;
    return { x, y: fn(x - shift, "time", step) };
  });
}

function isPowerOfTwo(value: number) {
  return value > 0 && (value & (value - 1)) === 0;
}

export function fft(real: number[], imaginary: number[], inverse: boolean) {
  const length = real.length;
  if (imaginary.length !== length) throw new Error("FFT 的实部和虚部长度必须一致");
  if (!isPowerOfTwo(length)) throw new Error("FFT 仅接收 2 的整数次幂长度；请先用零填充");
  for (let index = 1, reversed = 0; index < length; index += 1) {
    let bit = length >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) { [real[index], real[reversed]] = [real[reversed], real[index]]; [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]]; }
  }
  for (let segment = 2; segment <= length; segment <<= 1) {
    const angle = (2 * Math.PI / segment) * (inverse ? 1 : -1);
    const stepReal = Math.cos(angle); const stepImaginary = Math.sin(angle);
    for (let start = 0; start < length; start += segment) {
      let unitReal = 1; let unitImaginary = 0;
      for (let offset = 0; offset < segment / 2; offset += 1) {
        const even = start + offset; const odd = even + segment / 2;
        const oddReal = real[odd] * unitReal - imaginary[odd] * unitImaginary;
        const oddImaginary = real[odd] * unitImaginary + imaginary[odd] * unitReal;
        real[odd] = real[even] - oddReal; imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal; imaginary[even] += oddImaginary;
        const nextReal = unitReal * stepReal - unitImaginary * stepImaginary;
        unitImaginary = unitReal * stepImaginary + unitImaginary * stepReal; unitReal = nextReal;
      }
    }
  }
  if (inverse) for (let index = 0; index < length; index += 1) { real[index] /= length; imaginary[index] /= length; }
}

function rotate(real: number, imaginary: number, angle: number) {
  return { re: real * Math.cos(angle) - imaginary * Math.sin(angle), im: real * Math.sin(angle) + imaginary * Math.cos(angle) };
}

export type FourierResult = {
  points: ComplexPoint[];
  rawReal: number[];
  rawImaginary: number[];
  mode: DomainMode;
  step: number;
  start: number;
  /** Number of real samples before zero padding. */
  sampleCount: number;
  /** Power-of-two length used by the numerical FFT. */
  fftLength: number;
};

export function forwardFourier(samples: Point[], mode: DomainMode): FourierResult {
  const sampleCount = Math.max(1, samples.length);
  const fftLength = nextPowerOfTwo(sampleCount);
  const rawReal = Array.from({ length: fftLength }, (_, index) => Number.isFinite(samples[index]?.y) ? samples[index].y : 0);
  const rawImaginary = Array.from({ length: fftLength }, () => 0);
  fft(rawReal, rawImaginary, false);
  const step = mode === "continuous" ? 8 / Math.max(sampleCount - 1, 1) : 1;
  const start = samples[0]?.x ?? 0;
  const points = Array.from({ length: fftLength }, (_, index) => {
    const signed = index <= fftLength / 2 ? index : index - fftLength;
    const omega = (2 * Math.PI * signed) / (fftLength * step);
    const shiftAngle = -omega * start;
    const scaled = rotate(rawReal[index] * (mode === "continuous" ? step : 1), rawImaginary[index] * (mode === "continuous" ? step : 1), shiftAngle);
    return { x: omega, re: scaled.re, im: scaled.im, y: Math.hypot(scaled.re, scaled.im), magnitude: Math.hypot(scaled.re, scaled.im), phase: Math.atan2(scaled.im, scaled.re) };
  }).sort((left, right) => left.x - right.x);
  return { points, rawReal, rawImaginary, mode, step, start, sampleCount, fftLength };
}

export function visibleSpectrum(points: ComplexPoint[], mode: DomainMode) {
  const range = mode === "continuous" ? 42 : Math.PI;
  return points.filter((point) => Math.abs(point.x) <= range + 1e-9);
}

export function inverseFromFourier(result: FourierResult): Point[] {
  const real = [...result.rawReal]; const imaginary = [...result.rawImaginary];
  fft(real, imaginary, true);
  return real.slice(0, result.sampleCount).map((value, index) => ({ x: result.start + index * result.step, y: value }));
}

export function inverseFromExpression(fn: CompiledExpression["fn"], mode: DomainMode, count: number) {
  const sampleCount = Math.max(2, Math.round(count));
  const fftLength = nextPowerOfTwo(sampleCount);
  const step = mode === "continuous" ? 8 / (sampleCount - 1) : 1;
  const start = mode === "continuous" ? -4 : -Math.floor(sampleCount / 2);
  const rawReal = Array.from({ length: fftLength }, () => 0);
  const rawImaginary = Array.from({ length: fftLength }, () => 0);
  const physical: ComplexPoint[] = [];
  for (let index = 0; index < fftLength; index += 1) {
    const signed = index <= fftLength / 2 ? index : index - fftLength;
    const omega = (2 * Math.PI * signed) / (fftLength * step);
    const value = fn(omega, "frequency", (2 * Math.PI) / (fftLength * step));
    const safeValue = Number.isFinite(value) ? value : 0;
    const raw = mode === "continuous"
      ? rotate(safeValue / step, 0, omega * start)
      : rotate(safeValue, 0, -omega * (count / 2));
    rawReal[index] = raw.re; rawImaginary[index] = raw.im;
    physical.push({ x: omega, re: safeValue, im: 0, y: Math.abs(safeValue), magnitude: Math.abs(safeValue), phase: safeValue >= 0 ? 0 : Math.PI });
  }
  fft(rawReal, rawImaginary, true);
  return { time: rawReal.slice(0, sampleCount).map((y, index) => ({ x: start + index * step, y })), spectrum: physical.sort((left, right) => left.x - right.x) };
}

export function approximateComplexTransform(samples: Point[], mode: DomainMode, kind: "laplace" | "z") {
  const count = samples.length; const step = mode === "continuous" ? 8 / (count - 1) : 1; const bins = 192;
  return Array.from({ length: bins }, (_, index) => {
    const omega = -Math.PI + (2 * Math.PI * index) / (bins - 1); let re = 0; let im = 0;
    samples.forEach((sample, sampleIndex) => {
      const base = kind === "laplace" ? sample.x : sampleIndex; const weight = kind === "laplace" ? Math.exp(-0.15 * Math.abs(base)) : Math.pow(1.012, -sampleIndex);
      const value = Number.isFinite(sample.y) ? sample.y * weight : 0; re += value * Math.cos(-omega * base) * step; im += value * Math.sin(-omega * base) * step;
    });
    return { x: omega, re, im, y: Math.hypot(re, im), magnitude: Math.hypot(re, im), phase: Math.atan2(im, re) };
  });
}

function nextPowerOfTwo(value: number) { let result = 1; while (result < value) result *= 2; return result; }

export function convolve(first: Point[], second: Point[], mode: DomainMode): Point[] {
  const firstCount = first.length; const secondCount = second.length;
  if (!firstCount || !secondCount) return [];
  const length = firstCount + secondCount - 1; const fftLength = nextPowerOfTwo(length);
  const firstReal = Array.from({ length: fftLength }, (_, index) => Number.isFinite(first[index]?.y) ? first[index].y : 0);
  const secondReal = Array.from({ length: fftLength }, (_, index) => Number.isFinite(second[index]?.y) ? second[index].y : 0);
  const firstImaginary = Array.from({ length: fftLength }, () => 0); const secondImaginary = Array.from({ length: fftLength }, () => 0);
  fft(firstReal, firstImaginary, false); fft(secondReal, secondImaginary, false);
  for (let index = 0; index < fftLength; index += 1) {
    const real = firstReal[index] * secondReal[index] - firstImaginary[index] * secondImaginary[index];
    firstImaginary[index] = firstReal[index] * secondImaginary[index] + firstImaginary[index] * secondReal[index]; firstReal[index] = real;
  }
  fft(firstReal, firstImaginary, true);
  const step = mode === "continuous" ? sampleSpacing(first, 8 / Math.max(firstCount - 1, 1)) : 1;
  const start = (first[0]?.x ?? 0) + (second[0]?.x ?? 0);
  return firstReal.slice(0, length).map((y, index) => ({ x: start + index * step, y: y * step }));
}

/** A weighted real-valued signal used by the linearity visualisation. */
export type SignalTerm = { samples: readonly Point[]; coefficient: number };

export type ConvolutionFrame = {
  /** h(τ − t), sampled at the same time locations as the first signal. */
  kernel: Point[];
  /** x(t)h(τ − t), the values being integrated or summed. */
  integrand: Point[];
  /** True only where h(τ − t) is inside the sampled support of h. */
  overlap: boolean[];
  /** The numerical value of the convolution at τ. */
  value: number;
};

export type ParsevalEnergy = { time: number; frequency: number; relativeError: number };

export type ConjugateSymmetry = { mirrored: ComplexPoint[]; maximumError: number; rmsError: number };

function finiteValue(point: Point | undefined) {
  return point && Number.isFinite(point.y) ? point.y : 0;
}

function finiteCoordinate(point: { x: number } | undefined) {
  return point && Number.isFinite(point.x) ? point.x : 0;
}

/**
 * Determines the native sample spacing.  The median gap tolerates a missing
 * point better than using only the first interval, while retaining O(n) cost.
 */
export function sampleSpacing(points: readonly { x: number }[], fallback = 1) {
  const gaps: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const gap = Math.abs(finiteCoordinate(points[index]) - finiteCoordinate(points[index - 1]));
    if (Number.isFinite(gap) && gap > 1e-12) gaps.push(gap);
  }
  if (!gaps.length) return fallback;
  gaps.sort((left, right) => left - right);
  return gaps[Math.floor(gaps.length / 2)] ?? fallback;
}

/**
 * Samples an existing finite signal at a coordinate.  Continuous signals use
 * linear interpolation; discrete signals use the nearest integer sample.
 * Values outside the captured window are explicitly zero padded.
 */
export function sampleSignalAt(samples: readonly Point[], coordinate: number, mode: DomainMode) {
  if (!samples.length || !Number.isFinite(coordinate)) return 0;
  const first = samples[0]; const last = samples[samples.length - 1];
  if (!first || !last || coordinate < first.x - 1e-9 || coordinate > last.x + 1e-9) return 0;
  if (mode === "discrete") {
    const index = Math.round(coordinate - first.x);
    const candidate = samples[index];
    return candidate && Math.abs(candidate.x - coordinate) <= 0.500001 ? finiteValue(candidate) : 0;
  }
  if (coordinate <= first.x) return finiteValue(first);
  if (coordinate >= last.x) return finiteValue(last);
  let left = 0; let right = samples.length - 1;
  while (right - left > 1) {
    const middle = Math.floor((left + right) / 2);
    if ((samples[middle]?.x ?? 0) <= coordinate) left = middle;
    else right = middle;
  }
  const lower = samples[left]; const upper = samples[right];
  if (!lower || !upper) return 0;
  const denominator = upper.x - lower.x;
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12) return finiteValue(lower);
  const fraction = clamp((coordinate - lower.x) / denominator, 0, 1);
  return finiteValue(lower) + (finiteValue(upper) - finiteValue(lower)) * fraction;
}

/** Resamples a signal on explicit display coordinates without changing its support. */
export function resampleSignal(samples: readonly Point[], coordinates: readonly number[], mode: DomainMode): Point[] {
  return coordinates.map((x) => ({ x, y: sampleSignalAt(samples, x, mode) }));
}

/** x(t − t₀) or x[n − n₀]; non-integer discrete shifts use nearest-neighbour resampling. */
export function timeShiftSignal(samples: readonly Point[], shift: number, mode: DomainMode): Point[] {
  return samples.map((point) => ({ x: point.x, y: sampleSignalAt(samples, point.x - shift, mode) }));
}

/** x(at) or x[an].  A zero scale produces the zero signal instead of NaN. */
export function timeScaleSignal(samples: readonly Point[], scale: number, mode: DomainMode): Point[] {
  if (!Number.isFinite(scale) || Math.abs(scale) < 1e-12) return samples.map((point) => ({ x: point.x, y: 0 }));
  return samples.map((point) => ({ x: point.x, y: sampleSignalAt(samples, scale * point.x, mode) }));
}

/** x(−t) or x[−n], useful for convolution and duality demonstrations. */
export function timeReverseSignal(samples: readonly Point[], mode: DomainMode): Point[] {
  return samples.map((point) => ({ x: point.x, y: sampleSignalAt(samples, -point.x, mode) }));
}

/**
 * Real-valued modulation x(t)cos(ω₀t + φ).  It creates the expected pair of
 * shifted sidebands for real input; use frequencyShiftSpectrum for the single
 * complex-spectrum shift X(ω − ω₀).
 */
export function modulateSignal(samples: readonly Point[], omega: number, phase = 0): Point[] {
  const safeOmega = Number.isFinite(omega) ? omega : 0;
  const safePhase = Number.isFinite(phase) ? phase : 0;
  return samples.map((point) => ({ x: point.x, y: finiteValue(point) * Math.cos(safeOmega * point.x + safePhase) }));
}

/** Computes Σᵢ aᵢxᵢ(t) on a shared coordinate grid. */
export function linearCombineSignals(terms: readonly SignalTerm[], mode: DomainMode, coordinates = terms[0]?.samples.map((point) => point.x) ?? []): Point[] {
  return coordinates.map((x) => ({
    x,
    y: terms.reduce((total, term) => total + (Number.isFinite(term.coefficient) ? term.coefficient : 0) * sampleSignalAt(term.samples, x, mode), 0),
  }));
}

/** x(t)h(t) or x[n]h[n] on the first signal's grid. */
export function multiplySignals(first: readonly Point[], second: readonly Point[], mode: DomainMode): Point[] {
  return first.map((point) => ({ x: point.x, y: finiteValue(point) * sampleSignalAt(second, point.x, mode) }));
}

/** Numerical first derivative (continuous) or first backward difference (discrete). */
export function differentiateSignal(samples: readonly Point[], mode: DomainMode): Point[] {
  if (samples.length < 2) return samples.map((point) => ({ x: point.x, y: 0 }));
  return samples.map((point, index) => {
    if (mode === "discrete") return { x: point.x, y: finiteValue(point) - finiteValue(samples[index - 1]) };
    const before = samples[Math.max(0, index - 1)]; const after = samples[Math.min(samples.length - 1, index + 1)];
    const delta = (after?.x ?? 0) - (before?.x ?? 0);
    return { x: point.x, y: Math.abs(delta) > 1e-12 ? (finiteValue(after) - finiteValue(before)) / delta : 0 };
  });
}

/** Cumulative trapezoidal integral (continuous) or cumulative sum (discrete). */
export function integrateSignal(samples: readonly Point[], mode: DomainMode, initial = 0): Point[] {
  let accumulated = Number.isFinite(initial) ? initial : 0;
  return samples.map((point, index) => {
    if (mode === "discrete") accumulated += finiteValue(point);
    else if (index > 0) {
      const previous = samples[index - 1];
      const delta = point.x - (previous?.x ?? point.x);
      accumulated += (finiteValue(previous) + finiteValue(point)) * delta / 2;
    }
    return { x: point.x, y: accumulated };
  });
}

/**
 * Exposes the exact integrand used by the definition y(τ)=∫x(t)h(τ−t)dt.
 * It lets the UI colour only the actual overlap rather than faking a mask.
 */
export function convolutionFrame(first: readonly Point[], second: readonly Point[], tau: number, mode: DomainMode): ConvolutionFrame {
  const secondStart = second[0]?.x ?? 0; const secondEnd = second[second.length - 1]?.x ?? 0;
  const kernel = first.map((point) => ({ x: point.x, y: sampleSignalAt(second, tau - point.x, mode) }));
  const overlap = first.map((point) => {
    const source = tau - point.x;
    return source >= secondStart - 1e-9 && source <= secondEnd + 1e-9;
  });
  const integrand = first.map((point, index) => ({ x: point.x, y: finiteValue(point) * finiteValue(kernel[index]) }));
  const value = mode === "continuous"
    ? integrand.reduce((total, point, index) => {
      if (index === 0) return total;
      const previous = integrand[index - 1];
      return total + (finiteValue(previous) + finiteValue(point)) * (point.x - (previous?.x ?? point.x)) / 2;
    }, 0)
    : integrand.reduce((total, point) => total + finiteValue(point), 0);
  return { kernel, integrand, overlap, value };
}

export function complexPoint(x: number, re: number, im: number): ComplexPoint {
  const safeRe = Number.isFinite(re) ? re : 0; const safeIm = Number.isFinite(im) ? im : 0;
  const magnitude = Math.hypot(safeRe, safeIm);
  return { x, y: magnitude, re: safeRe, im: safeIm, magnitude, phase: Math.atan2(safeIm, safeRe) };
}

function wrapAngularFrequency(omega: number) {
  const period = 2 * Math.PI;
  const wrapped = ((omega + Math.PI) % period + period) % period - Math.PI;
  return Math.abs(wrapped + Math.PI) < 1e-10 && omega > 0 ? Math.PI : wrapped;
}

/** Linear complex interpolation on a spectrum; discrete spectra are periodic on [−π, π]. */
export function sampleSpectrumAt(points: readonly ComplexPoint[], omega: number, mode: DomainMode): ComplexPoint {
  if (!points.length || !Number.isFinite(omega)) return complexPoint(omega, 0, 0);
  const coordinate = mode === "discrete" ? wrapAngularFrequency(omega) : omega;
  const first = points[0]; const last = points[points.length - 1];
  if (!first || !last) return complexPoint(coordinate, 0, 0);
  if (mode === "discrete" && coordinate < first.x) {
    const lowerX = last.x - 2 * Math.PI;
    const denominator = first.x - lowerX;
    const fraction = Math.abs(denominator) < 1e-12 ? 0 : clamp((coordinate - lowerX) / denominator, 0, 1);
    return complexPoint(coordinate, last.re + (first.re - last.re) * fraction, last.im + (first.im - last.im) * fraction);
  }
  if (mode === "discrete" && coordinate > last.x) {
    const upperX = first.x + 2 * Math.PI;
    const denominator = upperX - last.x;
    const fraction = Math.abs(denominator) < 1e-12 ? 0 : clamp((coordinate - last.x) / denominator, 0, 1);
    return complexPoint(coordinate, last.re + (first.re - last.re) * fraction, last.im + (first.im - last.im) * fraction);
  }
  if (coordinate < first.x - 1e-9 || coordinate > last.x + 1e-9) return complexPoint(coordinate, 0, 0);
  if (coordinate <= first.x) return complexPoint(coordinate, first.re, first.im);
  if (coordinate >= last.x) return complexPoint(coordinate, last.re, last.im);
  let left = 0; let right = points.length - 1;
  while (right - left > 1) {
    const middle = Math.floor((left + right) / 2);
    if ((points[middle]?.x ?? 0) <= coordinate) left = middle;
    else right = middle;
  }
  const lower = points[left]; const upper = points[right];
  if (!lower || !upper) return complexPoint(coordinate, 0, 0);
  const denominator = upper.x - lower.x;
  const fraction = Math.abs(denominator) < 1e-12 ? 0 : clamp((coordinate - lower.x) / denominator, 0, 1);
  return complexPoint(coordinate, lower.re + (upper.re - lower.re) * fraction, lower.im + (upper.im - lower.im) * fraction);
}

/** X(ω − ω₀), the frequency-domain form of complex exponential modulation. */
export function frequencyShiftSpectrum(points: readonly ComplexPoint[], omegaShift: number, mode: DomainMode): ComplexPoint[] {
  const safeShift = Number.isFinite(omegaShift) ? omegaShift : 0;
  return points.map((point) => {
    const source = sampleSpectrumAt(points, point.x - safeShift, mode);
    return complexPoint(point.x, source.re, source.im);
  });
}

/** (1/|a|)X(ω/a), paired with timeScaleSignal. */
export function frequencyScaleSpectrum(points: readonly ComplexPoint[], scale: number, mode: DomainMode): ComplexPoint[] {
  if (!Number.isFinite(scale) || Math.abs(scale) < 1e-12) return points.map((point) => complexPoint(point.x, 0, 0));
  const gain = 1 / Math.abs(scale);
  return points.map((point) => {
    const source = sampleSpectrumAt(points, point.x / scale, mode);
    return complexPoint(point.x, source.re * gain, source.im * gain);
  });
}

/** Pointwise X(ω)H(ω), used by the convolution theorem. */
export function multiplySpectra(first: readonly ComplexPoint[], second: readonly ComplexPoint[], mode: DomainMode): ComplexPoint[] {
  return first.map((point) => {
    const other = sampleSpectrumAt(second, point.x, mode);
    return complexPoint(point.x, point.re * other.re - point.im * other.im, point.re * other.im + point.im * other.re);
  });
}

/** (jω)ⁿX(ω), the spectrum of the n-th time derivative. */
export function differentiateSpectrum(points: readonly ComplexPoint[], order = 1): ComplexPoint[] {
  const safeOrder = Math.max(0, Math.round(order));
  return points.map((point) => {
    let re = point.re; let im = point.im;
    for (let index = 0; index < safeOrder; index += 1) { const nextRe = -point.x * im; im = point.x * re; re = nextRe; }
    return complexPoint(point.x, re, im);
  });
}

/** X(ω)/(jω)ⁿ away from DC.  The required DC impulse term is omitted deliberately. */
export function integrateSpectrum(points: readonly ComplexPoint[], order = 1, dcEpsilon = 1e-8): ComplexPoint[] {
  const safeOrder = Math.max(0, Math.round(order));
  return points.map((point) => {
    if (safeOrder > 0 && Math.abs(point.x) <= dcEpsilon) return complexPoint(point.x, 0, 0);
    let re = point.re; let im = point.im;
    for (let index = 0; index < safeOrder; index += 1) {
      const denominator = point.x * point.x;
      const nextRe = im / point.x; const nextIm = -re / point.x;
      if (!Number.isFinite(denominator) || denominator <= 0) return complexPoint(point.x, 0, 0);
      re = nextRe; im = nextIm;
    }
    return complexPoint(point.x, re, im);
  });
}

/** X*(−ω), the expected spectrum of a conjugated time-domain signal. */
export function conjugateMirrorSpectrum(points: readonly ComplexPoint[], mode: DomainMode): ComplexPoint[] {
  return points.map((point) => {
    const mirrored = sampleSpectrumAt(points, -point.x, mode);
    return complexPoint(point.x, mirrored.re, -mirrored.im);
  });
}

/** Quantifies X(−ω)=X*(ω), allowing the UI to show a numerical symmetry residual. */
export function conjugateSymmetry(points: readonly ComplexPoint[], mode: DomainMode): ConjugateSymmetry {
  const mirrored = conjugateMirrorSpectrum(points, mode);
  if (!points.length) return { mirrored, maximumError: 0, rmsError: 0 };
  let maximumError = 0; let squaredError = 0;
  points.forEach((point, index) => {
    const expected = mirrored[index];
    const error = Math.hypot(point.re - (expected?.re ?? 0), point.im - (expected?.im ?? 0));
    maximumError = Math.max(maximumError, error); squaredError += error * error;
  });
  return { mirrored, maximumError, rmsError: Math.sqrt(squaredError / points.length) };
}

/** Numerically compares time and frequency energies under the app's Fourier normalisation. */
export function parsevalEnergy(samples: readonly Point[], spectrum: readonly ComplexPoint[], mode: DomainMode): ParsevalEnergy {
  const timeStep = mode === "continuous" ? sampleSpacing(samples, 1) : 1;
  const time = samples.reduce((total, point) => total + finiteValue(point) ** 2, 0) * timeStep;
  const frequency = mode === "continuous"
    ? spectrum.reduce((total, point) => total + point.magnitude ** 2, 0) * sampleSpacing(spectrum, 1) / (2 * Math.PI)
    : spectrum.reduce((total, point) => total + point.magnitude ** 2, 0) / Math.max(spectrum.length, 1);
  const relativeError = Math.abs(time - frequency) / Math.max(Math.abs(time), Math.abs(frequency), 1e-12);
  return { time, frequency, relativeError };
}
