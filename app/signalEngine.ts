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
  const step = mode === "continuous" ? 8 / (count - 1) : 1;
  const start = mode === "continuous" ? -4 : -Math.floor(count / 2);
  return Array.from({ length: count }, (_, index) => {
    const x = start + index * step;
    return { x, y: fn(x - shift, "time", step) };
  });
}

export function fft(real: number[], imaginary: number[], inverse: boolean) {
  const length = real.length;
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

export type FourierResult = { points: ComplexPoint[]; rawReal: number[]; rawImaginary: number[]; mode: DomainMode; step: number; start: number };

export function forwardFourier(samples: Point[], mode: DomainMode): FourierResult {
  const count = samples.length;
  const rawReal = samples.map((point) => Number.isFinite(point.y) ? point.y : 0);
  const rawImaginary = Array.from({ length: count }, () => 0);
  fft(rawReal, rawImaginary, false);
  const step = mode === "continuous" ? 8 / (count - 1) : 1;
  const start = samples[0]?.x ?? 0;
  const points = Array.from({ length: count }, (_, index) => {
    const signed = index <= count / 2 ? index : index - count;
    const omega = (2 * Math.PI * signed) / (count * step);
    const shiftAngle = mode === "continuous" ? -omega * start : omega * (count / 2);
    const scaled = rotate(rawReal[index] * (mode === "continuous" ? step : 1), rawImaginary[index] * (mode === "continuous" ? step : 1), shiftAngle);
    return { x: omega, re: scaled.re, im: scaled.im, y: Math.hypot(scaled.re, scaled.im), magnitude: Math.hypot(scaled.re, scaled.im), phase: Math.atan2(scaled.im, scaled.re) };
  }).sort((left, right) => left.x - right.x);
  return { points, rawReal, rawImaginary, mode, step, start };
}

export function visibleSpectrum(points: ComplexPoint[], mode: DomainMode) {
  const range = mode === "continuous" ? 42 : Math.PI;
  return points.filter((point) => Math.abs(point.x) <= range + 1e-9);
}

export function inverseFromFourier(result: FourierResult): Point[] {
  const real = [...result.rawReal]; const imaginary = [...result.rawImaginary];
  fft(real, imaginary, true);
  return real.map((value, index) => ({ x: result.start + index * result.step, y: value }));
}

export function inverseFromExpression(fn: CompiledExpression["fn"], mode: DomainMode, count: number) {
  const step = mode === "continuous" ? 8 / (count - 1) : 1;
  const start = mode === "continuous" ? -4 : -Math.floor(count / 2);
  const rawReal = Array.from({ length: count }, () => 0);
  const rawImaginary = Array.from({ length: count }, () => 0);
  const physical: ComplexPoint[] = [];
  for (let index = 0; index < count; index += 1) {
    const signed = index <= count / 2 ? index : index - count;
    const omega = (2 * Math.PI * signed) / (count * step);
    const value = fn(omega, "frequency", (2 * Math.PI) / (count * step));
    const safeValue = Number.isFinite(value) ? value : 0;
    const raw = mode === "continuous"
      ? rotate(safeValue / step, 0, omega * start)
      : rotate(safeValue, 0, -omega * (count / 2));
    rawReal[index] = raw.re; rawImaginary[index] = raw.im;
    physical.push({ x: omega, re: safeValue, im: 0, y: Math.abs(safeValue), magnitude: Math.abs(safeValue), phase: safeValue >= 0 ? 0 : Math.PI });
  }
  fft(rawReal, rawImaginary, true);
  return { time: rawReal.map((y, index) => ({ x: start + index * step, y })), spectrum: physical.sort((left, right) => left.x - right.x) };
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
  const count = first.length; const length = count * 2 - 1; const fftLength = nextPowerOfTwo(length);
  const firstReal = Array.from({ length: fftLength }, (_, index) => Number.isFinite(first[index]?.y) ? first[index].y : 0);
  const secondReal = Array.from({ length: fftLength }, (_, index) => Number.isFinite(second[index]?.y) ? second[index].y : 0);
  const firstImaginary = Array.from({ length: fftLength }, () => 0); const secondImaginary = Array.from({ length: fftLength }, () => 0);
  fft(firstReal, firstImaginary, false); fft(secondReal, secondImaginary, false);
  for (let index = 0; index < fftLength; index += 1) {
    const real = firstReal[index] * secondReal[index] - firstImaginary[index] * secondImaginary[index];
    firstImaginary[index] = firstReal[index] * secondImaginary[index] + firstImaginary[index] * secondReal[index]; firstReal[index] = real;
  }
  fft(firstReal, firstImaginary, true);
  const step = mode === "continuous" ? 8 / (count - 1) : 1; const start = mode === "continuous" ? -8 : -count;
  return firstReal.slice(0, length).map((y, index) => ({ x: start + index * step, y: y * step }));
}
