/*
 * Small Pine Script interpreter for indicators.
 * It is not the official Pine runtime: it covers expressions, variables,
 * if/for/while, ta/math/input/request.security, plot/plotshape/hline and
 * ignores strategy/alert side effects. Runs fully in the browser.
 */

const COLORS = {
  aqua: "#00bcd4",
  black: "#000000",
  blue: "#2962ff",
  fuchsia: "#e040fb",
  gray: "#787b86",
  green: "#089981",
  lime: "#00e676",
  maroon: "#880e4f",
  navy: "#1a237e",
  olive: "#808000",
  orange: "#ff9800",
  purple: "#9c27b0",
  red: "#f23645",
  silver: "#b2b5be",
  teal: "#00897b",
  white: "#ffffff",
  yellow: "#ffeb3b",
};

const FN_PREFIX = /^(ta|math|input|request|str|array|matrix|map|runtime|strategy|alert|label|line|box|table|log)\./;

const isNa = (value) =>
  value == null || (typeof value === "number" && !Number.isFinite(value));

const toNum = (value) => {
  if (value && value.__series) value = value.__series[value.__series.length - 1];
  if (value && typeof value === "object" && "__scalar" in value) value = value.__scalar;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
};

const truthy = (value, ctx) => {
  if (value && value.__series) value = valueAt(value, ctx.i);
  if (value && typeof value === "object" && "__scalar" in value) value = value.__scalar;
  return Boolean(value);
};

export function compilePine(source) {
  try {
    const lines = logicalLines(String(source || ""));
    const root = buildTree(lines);
    const meta = detectMeta(root.children);
    assignIds(root);
    return { ok: true, program: { root, meta } };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

export function runPine(program, candles, options = {}) {
  const ctx = createContext(candles, options);
  const meta = program.meta || { overlay: false };

  try {
    for (let i = 0; i < candles.length; i++) {
      ctx.i = i;
      prepareVars(ctx);
      execBlock(program.root.children, ctx);
      if (ctx.error) break;
    }
  } catch (error) {
    ctx.error = String((error && error.message) || error);
  }

  return {
    overlay: Boolean(meta.overlay),
    title: meta.title || "",
    error: ctx.error || "",
    plots: ctx.error ? [] : collectPlots(ctx),
    shapes: ctx.error ? [] : collectShapes(ctx),
    hlines: ctx.error ? [] : [...ctx.hlines.values()],
  };
}

/* --------------------------------------------------------------- source */

function logicalLines(source) {
  const physical = source.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let pending = null;
  let depth = 0;

  for (let index = 0; index < physical.length; index++) {
    const raw = physical[index];
    const indent = pending ? pending.indent : indentOf(raw);
    let text = stripComment(raw).trim();

    if (!pending && !text) continue;

    if (pending) {
      text = text.replace(/\\$/, "");
      pending.text += text ? " " + text : "";
    } else {
      text = text.replace(/\\$/, "");
      if (!text) continue;
      pending = { indent, text, line: index + 1 };
    }

    depth = bracketDelta(text);
    if (depth > 0 || (index + 1 < physical.length && /\\$/.test(stripComment(physical[index]).trim()))) {
      continue;
    }

    out.push(pending);
    pending = null;
    depth = 0;
  }

  if (pending) out.push(pending);
  return out;
}

function indentOf(text) {
  let width = 0;
  for (const ch of text) {
    if (ch === " ") width += 1;
    else if (ch === "\t") width += 4;
    else break;
  }
  return width;
}

function stripComment(text) {
  let quote = null;
  let out = "";

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === "\\") {
        if (i + 1 < text.length) out += text[++i];
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") break;
    out += ch;
  }
  return out;
}

function bracketDelta(text) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
  }
  return depth;
}

/* ---------------------------------------------------------------- tokens */

function tokenize(text) {
  const tokens = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") break;

    if (ch === '"' || ch === "'") {
      const quote = ch;
      let value = "";
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") {
          const next = text[++i];
          value += next === "n" ? "\n" : next === "t" ? "\t" : next || "";
          i++;
        } else {
          value += text[i++];
        }
      }
      i++;
      tokens.push({ type: "str", value });
      continue;
    }

    if (ch === "#") {
      let j = i + 1;
      while (j < text.length && /[0-9a-fA-F]/.test(text[j])) j++;
      tokens.push({ type: "str", value: text.slice(i, j) });
      i = j;
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(text[i + 1]))) {
      let j = i;
      while (j < text.length && /[0-9.]/.test(text[j])) j++;
      if (text[j] === "e" || text[j] === "E") {
        j++;
        if (text[j] === "+" || text[j] === "-") j++;
        while (j < text.length && /[0-9]/.test(text[j])) j++;
      }
      tokens.push({ type: "num", value: Number(text.slice(i, j)) });
      i = j;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
      tokens.push({ type: "id", value: text.slice(i, j) });
      i = j;
      continue;
    }

    const multi = [":=", "==", "!=", ">=", "<=", "=>"];
    let op = null;
    for (const candidate of multi) {
      if (text.startsWith(candidate, i)) {
        op = candidate;
        break;
      }
    }
    if (op) {
      tokens.push({ type: "op", value: op });
      i += op.length;
      continue;
    }

    if ("+-*/%<>=?:,.()[]{}".includes(ch)) {
      tokens.push({ type: "op", value: ch });
      i++;
      continue;
    }

    i++;
  }

  tokens.push({ type: "eof", value: "" });
  return tokens;
}

class ExpressionParser {
  constructor(tokens) {
    this.tokens = tokens;
    this.index = 0;
  }

  peek(offset = 0) {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)];
  }

  next() {
    return this.tokens[this.index++] || this.tokens[this.tokens.length - 1];
  }

  isOp(value) {
    const token = this.peek();
    return token.type === "op" && token.value === value;
  }

  isId(value) {
    const token = this.peek();
    return token.type === "id" && token.value === value;
  }

  match(value) {
    if (!this.isOp(value)) return false;
    this.next();
    return true;
  }

  expect(value) {
    if (!this.match(value)) throw new Error(`expected "${value}"`);
  }

  parse() {
    const node = this.parseTernary();
    if (this.peek().type !== "eof") {
      throw new Error(`unexpected "${this.peek().value}"`);
    }
    return node;
  }

  parseTernary() {
    let node = this.parseOr();
    if (this.match("?")) {
      const yes = this.parseTernary();
      this.expect(":");
      const no = this.parseTernary();
      node = { type: "ternary", cond: node, yes, no };
    }
    return node;
  }

  parseOr() {
    let node = this.parseAnd();
    while (this.isId("or")) {
      this.next();
      node = { type: "binary", op: "or", left: node, right: this.parseAnd() };
    }
    return node;
  }

  parseAnd() {
    let node = this.parseEquality();
    while (this.isId("and")) {
      this.next();
      node = { type: "binary", op: "and", left: node, right: this.parseEquality() };
    }
    return node;
  }

  parseEquality() {
    let node = this.parseCompare();
    while (this.isOp("==") || this.isOp("!=")) {
      const op = this.next().value;
      node = { type: "binary", op, left: node, right: this.parseCompare() };
    }
    return node;
  }

  parseCompare() {
    let node = this.parseAdd();
    while (this.isOp(">") || this.isOp("<") || this.isOp(">=") || this.isOp("<=")) {
      const op = this.next().value;
      node = { type: "binary", op, left: node, right: this.parseAdd() };
    }
    return node;
  }

  parseAdd() {
    let node = this.parseMul();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.next().value;
      node = { type: "binary", op, left: node, right: this.parseMul() };
    }
    return node;
  }

  parseMul() {
    let node = this.parseUnary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
      const op = this.next().value;
      node = { type: "binary", op, left: node, right: this.parseUnary() };
    }
    return node;
  }

  parseUnary() {
    if (this.isOp("-") || this.isOp("+")) {
      const op = this.next().value;
      return { type: "unary", op, value: this.parseUnary() };
    }
    if (this.isId("not")) {
      this.next();
      return { type: "unary", op: "not", value: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  parsePostfix() {
    let node = this.parsePrimary();

    while (true) {
      if (this.match("(")) {
        const args = [];
        const named = {};
        while (!this.isOp(")")) {
          if (this.peek().type === "id" && this.peek(1).type === "op" && this.peek(1).value === "=") {
            const name = this.next().value;
            this.next();
            named[name] = this.parseTernary();
          } else {
            args.push(this.parseTernary());
          }
          if (!this.match(",")) break;
        }
        this.expect(")");
        node = { type: "call", callee: node, args, named };
        continue;
      }

      if (this.match("[")) {
        const index = this.parseTernary();
        this.expect("]");
        node = { type: "index", base: node, index };
        continue;
      }

      if (this.match(".")) {
        const name = this.next();
        if (name.type !== "id") throw new Error("member name expected");
        node = { type: "member", object: node, name: name.value };
        continue;
      }

      break;
    }

    return node;
  }

  parsePrimary() {
    const token = this.next();

    if (token.type === "num") return { type: "num", value: token.value };
    if (token.type === "str") return { type: "str", value: token.value };
    if (token.type === "id") return { type: "id", name: token.value };

    if (token.type === "op" && token.value === "(") {
      const node = this.parseTernary();
      this.expect(")");
      return node;
    }

    if (token.type === "op" && token.value === "[") {
      const items = [];
      while (!this.isOp("]")) {
        items.push(this.parseTernary());
        if (!this.match(",")) break;
      }
      this.expect("]");
      return { type: "array", items };
    }

    throw new Error(`unexpected "${token.value}"`);
  }
}

function parseExpression(text) {
  return new ExpressionParser(tokenize(text)).parse();
}

/* ------------------------------------------------------------- statements */

function parseStatement(text) {
  if (!text) return { kind: "skip" };

  if (/^else\s+if\b/.test(text)) {
    return {
      kind: "if",
      isElse: true,
      cond: parseExpression(text.replace(/^else\s+if\s+/, "")),
    };
  }
  if (/^else\b/.test(text)) return { kind: "else" };
  if (/^if\b/.test(text)) {
    return { kind: "if", cond: parseExpression(text.replace(/^if\s+/, "")) };
  }
  if (/^while\b/.test(text)) {
    return { kind: "while", cond: parseExpression(text.replace(/^while\s+/, "")) };
  }
  if (/^for\b/.test(text)) {
    const match = text.match(
      /^for\s+([A-Za-z_]\w*)\s*=\s*(.+?)\s+to\s+(.+?)(?:\s+by\s+(.+))?$/,
    );
    if (!match) throw new Error("bad for loop");
    return {
      kind: "for",
      name: match[1],
      from: parseExpression(match[2]),
      to: parseExpression(match[3]),
      by: match[4] ? parseExpression(match[4]) : null,
    };
  }
  if (/^switch\b/.test(text)) return { kind: "skip" };
  if (/^(type|method|struct)\b/.test(text)) return { kind: "skip" };
  if (/^[A-Za-z_]\w*\s*\([^)]*\)\s*=>/.test(text)) return { kind: "skip" };

  const varMatch = text.match(/^(var|varip)\s+([\s\S]+)$/);
  if (varMatch) {
    const inner = parseAssignment(varMatch[2]);
    if (inner.kind === "assign") inner.isVar = true;
    return inner;
  }

  return parseAssignment(text);
}

function parseAssignment(text) {
  let match = text.match(/^([A-Za-z_]\w*)\s*(:=|=(?!=))\s*([\s\S]+)$/);
  let names = null;

  if (match) {
    names = [match[1]];
  } else {
    match = text.match(/^\[([^\]]+)\]\s*(:=|=(?!=))\s*([\s\S]+)$/);
    if (match) {
      names = match[1].split(",").map((name) => name.trim());
      if (names.some((name) => !/^[A-Za-z_]\w*$/.test(name))) {
        throw new Error("bad tuple assignment");
      }
    }
  }

  if (match) {
    return {
      kind: "assign",
      names,
      op: match[2],
      expr: parseExpression(match[3]),
    };
  }

  return { kind: "expr", expr: parseExpression(text) };
}

function buildTree(lines) {
  const root = { indent: -1, children: [] };
  const stack = [root];

  for (const line of lines) {
    while (stack.length > 1 && line.indent <= stack[stack.length - 1].line.indent) {
      stack.pop();
    }
    const node = { line, stmt: parseStatement(line.text), children: [] };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }

  linkElse(root.children);
  return root;
}

function linkElse(nodes) {
  let previousIf = null;

  for (const node of nodes) {
    linkElse(node.children);

    if (node.stmt.kind === "if" && !node.stmt.isElse) {
      previousIf = node;
    } else if (node.stmt.kind === "if" && node.stmt.isElse) {
      if (!previousIf) continue;
      previousIf.elseNode = node;
      node.isElse = true;
      previousIf = node;
    } else if (node.stmt.kind === "else") {
      if (!previousIf) continue;
      previousIf.elseNode = node;
      node.isElse = true;
    } else {
      previousIf = null;
    }
  }
}

function detectMeta(nodes) {
  const meta = { overlay: false, title: "" };

  for (const node of nodes) {
    if (node.stmt.kind !== "expr") continue;
    const call = node.stmt.expr;
    if (call.type !== "call") continue;
    const name = call.callee.type === "id" ? call.callee.name : nodePath(call.callee);
    if (!["indicator", "strategy", "study", "library"].includes(name)) continue;

    const overlay = call.named.overlay || call.args[1];
    const title = call.named.title || call.args[0];

    if (overlay && overlay.type === "id") meta.overlay = overlay.name === "true";
    if (title && title.type === "str") meta.title = title.value;
    return meta;
  }

  return meta;
}

function assignIds(node) {
  let counter = 0;

  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value.type) value.id = ++counter;
    for (const key of Object.keys(value)) {
      if (key === "line" || key === "id") continue;
      walk(value[key]);
    }
  };

  walk(node);
  node.__counter = counter;
}

/* --------------------------------------------------------------- runtime */

function createContext(candles, options) {
  const n = candles.length;
  const source = (fn) => candles.map(fn);

  const sources = {
    open: source((candle) => candle.open),
    high: source((candle) => candle.high),
    low: source((candle) => candle.low),
    close: source((candle) => candle.close),
    volume: source((candle) => candle.volume || 0),
    hl2: source((candle) => (candle.high + candle.low) / 2),
    hlc3: source((candle) => (candle.high + candle.low + candle.close) / 3),
    ohlc4: source((candle) => (candle.open + candle.high + candle.low + candle.close) / 4),
    time: source((candle) => candle.time),
    bar_index: source((_, index) => index),
  };

  return {
    candles,
    n,
    i: 0,
    sources,
    vars: new Map(),
    scalars: new Map(),
    memo: new Map(),
    ta: new Map(),
    plots: new Map(),
    shapes: new Map(),
    hlines: new Map(),
    security: new Map(),
    symbol: options.symbol || "",
    interval: options.interval || "",
    error: "",
  };
}

function prepareVars(ctx) {
  for (const variable of ctx.vars.values()) {
    while (variable.base.length <= ctx.i) {
      variable.base.push(variable.base.length ? variable.base[variable.base.length - 1] : NaN);
    }
  }
}

function setVar(ctx, name, value) {
  let variable = ctx.vars.get(name);
  if (!variable) {
    variable = { base: [] };
    ctx.vars.set(name, variable);
  }
  while (variable.base.length <= ctx.i) {
    variable.base.push(variable.base.length ? variable.base[variable.base.length - 1] : NaN);
  }
  variable.base[ctx.i] = value;
}

function valueAt(value, index) {
  if (value && value.__series) return value.__series[index - (value.shift || 0)];
  if (value && typeof value === "object" && "__scalar" in value) return value.__scalar;
  return value;
}

function scalarValue(value, ctx) {
  return valueAt(value, ctx.i);
}

function toSeries(node, ctx) {
  if (!node) return { __scalar: NaN };

  if (node.type === "id") {
    const source = ctx.sources[node.name];
    if (source) return { __series: source };

    const variable = ctx.vars.get(node.name);
    if (variable) return { __series: variable.base };

    if (ctx.scalars.has(node.name)) return { __scalar: ctx.scalars.get(node.name) };
    return { __scalar: evalNode(node, ctx) };
  }

  if (node.type === "index") {
    const base = toSeries(node.base, ctx);
    if (base.__series) {
      const shift = Math.round(toNum(evalNode(node.index, ctx))) || 0;
      return { __series: base.__series, shift: (base.shift || 0) + shift };
    }
  }

  if (node.type === "num" || node.type === "str") {
    return { __scalar: node.value };
  }

  return memoSeries(node, ctx);
}

// Pine keeps history for every expression, not only for named variables.
// ta.* sources such as math.abs(hist) must therefore be materialised bar by bar.
function memoSeries(node, ctx) {
  let state = ctx.memo.get(node.id);

  if (!state) {
    state = { values: [] };
    ctx.memo.set(node.id, state);
  }

  if (state.values.length <= ctx.i) {
    while (state.values.length < ctx.i) state.values.push(NaN);
    state.values[ctx.i] = toNum(evalNode(node, ctx));
  }

  return { __series: state.values };
}

function nodePath(node) {
  if (!node) return null;
  if (node.type === "id") return node.name;
  if (node.type === "member") {
    const prefix = nodePath(node.object);
    return prefix ? `${prefix}.${node.name}` : null;
  }
  return null;
}

function evalNode(node, ctx) {
  if (!node) return NaN;

  switch (node.type) {
    case "num":
    case "str":
      return node.value;

    case "id":
      return evalIdent(node.name, ctx);

    case "member":
      return evalMember(node, ctx);

    case "call":
      return evalCall(node, ctx);

    case "index": {
      const base = toSeries(node.base, ctx);
      if (!base.__series) return NaN;
      const shift = Math.round(toNum(evalNode(node.index, ctx))) || 0;
      return valueAt(base, ctx.i - shift);
    }

    case "unary": {
      const value = scalarValue(evalNode(node.value, ctx), ctx);
      if (node.op === "not") return !truthy(value, ctx);
      if (node.op === "-") return -toNum(value);
      return toNum(value);
    }

    case "binary": {
      if (node.op === "and") {
        return truthy(evalNode(node.left, ctx), ctx) && truthy(evalNode(node.right, ctx), ctx);
      }
      if (node.op === "or") {
        return truthy(evalNode(node.left, ctx), ctx) || truthy(evalNode(node.right, ctx), ctx);
      }

      const left = scalarValue(evalNode(node.left, ctx), ctx);
      const right = scalarValue(evalNode(node.right, ctx), ctx);

      switch (node.op) {
        case "+":
          return typeof left === "string" || typeof right === "string"
            ? String(left) + String(right)
            : toNum(left) + toNum(right);
        case "-":
          return toNum(left) - toNum(right);
        case "*":
          return toNum(left) * toNum(right);
        case "/":
          return toNum(left) / toNum(right);
        case "%":
          return toNum(left) % toNum(right);
        case ">":
          return toNum(left) > toNum(right);
        case "<":
          return toNum(left) < toNum(right);
        case ">=":
          return toNum(left) >= toNum(right);
        case "<=":
          return toNum(left) <= toNum(right);
        case "==":
          return left === right || toNum(left) === toNum(right);
        case "!=":
          return !(left === right || toNum(left) === toNum(right));
        default:
          return NaN;
      }
    }

    case "ternary":
      return truthy(evalNode(node.cond, ctx), ctx)
        ? evalNode(node.yes, ctx)
        : evalNode(node.no, ctx);

    case "array":
      return node.items.map((item) => scalarValue(evalNode(item, ctx), ctx));

    default:
      return NaN;
  }
}

function evalIdent(name, ctx) {
  if (name === "true") return true;
  if (name === "false") return false;
  if (name === "na") return NaN;

  if (ctx.sources[name]) return { __series: ctx.sources[name] };
  if (ctx.scalars.has(name)) return ctx.scalars.get(name);

  const variable = ctx.vars.get(name);
  if (variable) return { __series: variable.base };

  return NaN;
}

function evalMember(node, ctx) {
  const path = nodePath(node);
  if (!path) return NaN;

  if (path === "barstate.islast") return ctx.i === ctx.n - 1;
  if (path === "barstate.isfirst") return ctx.i === 0;
  if (path === "barstate.isnew") return true;
  if (path === "syminfo.tickerid" || path === "syminfo.ticker") return ctx.symbol;
  if (path === "timeframe.period") return ctx.interval;
  if (path === "math.pi") return Math.PI;
  if (path === "math.e") return Math.E;

  if (path.startsWith("color.")) {
    const color = path.slice(6);
    if (color === "new" || color === "rgb" || color === "from_gradient") {
      return path;
    }
    return COLORS[color] || "#787b86";
  }

  return path;
}

function evalCall(node, ctx) {
  const callee = node.callee;
  const name =
    callee.type === "id"
      ? callee.name
      : callee.type === "member"
        ? nodePath(callee)
        : null;

  if (!name) return NaN;
  return callPine(name, node, ctx);
}

function arg(node, index, key, ctx) {
  const target = node.named[key] || node.args[index];
  return target ? scalarValue(evalNode(target, ctx), ctx) : undefined;
}

function sourceArg(node, index, key, ctx) {
  const target = node.named[key] || node.args[index];
  return target ? toSeries(target, ctx) : { __scalar: NaN };
}

function numberArg(node, index, key, ctx, fallback) {
  const value = arg(node, index, key, ctx);
  const number = toNum(value);
  return Number.isFinite(number) ? number : fallback;
}

function stringArg(node, index, key, ctx, fallback) {
  const value = arg(node, index, key, ctx);
  return typeof value === "string" ? value : fallback;
}

function plotState(ctx, node) {
  let plot = ctx.plots.get(node.id);
  if (!plot) {
    plot = {
      id: node.id,
      title: "",
      values: [],
      colors: [],
      color: "",
      width: 1,
      style: "line",
    };
    ctx.plots.set(node.id, plot);
  }
  while (plot.values.length <= ctx.i) plot.values.push(NaN);
  while (plot.colors.length <= ctx.i) plot.colors.push("");
  return plot;
}

function shapeState(ctx, node) {
  let shape = ctx.shapes.get(node.id);
  if (!shape) {
    shape = {
      id: node.id,
      title: "",
      values: [],
      colors: [],
      color: "",
      style: "",
      location: "",
    };
    ctx.shapes.set(node.id, shape);
  }
  while (shape.values.length <= ctx.i) shape.values.push(false);
  return shape;
}

function callPine(name, node, ctx) {
  switch (name) {
    case "plot":
    case "plotcandle":
    case "plotbar": {
      const plot = plotState(ctx, node);
      const value = scalarValue(evalNode(node.args[0], ctx), ctx);
      plot.values[ctx.i] =
        typeof value === "boolean" ? (value ? 1 : 0) : Number.isFinite(value) ? value : NaN;
      plot.title = stringArg(node, 1, "title", ctx, plot.title) || plot.title;
      const color = arg(node, 2, "color", ctx);
      if (typeof color === "string" && color) {
        plot.color = color;
        plot.colors[ctx.i] = color;
      }
      const width = numberArg(node, 3, "linewidth", ctx, NaN);
      if (Number.isFinite(width)) plot.width = Math.max(1, Math.min(4, width));
      const style = stringArg(node, 4, "style", ctx, plot.style);
      if (style) plot.style = style;
      return value;
    }

    case "plotshape":
    case "plotchar": {
      const shape = shapeState(ctx, node);
      shape.values[ctx.i] = truthy(evalNode(node.args[0], ctx), ctx);
      shape.title = stringArg(node, 1, "title", ctx, shape.title) || shape.title;
      const style = stringArg(node, 2, "style", ctx, shape.style);
      if (style) shape.style = style;
      const location = stringArg(node, 3, "location", ctx, shape.location);
      if (location) shape.location = location;
      const color = arg(node, 4, "color", ctx);
      if (typeof color === "string") {
        shape.color = color;
        shape.colors[ctx.i] = color;
      }
      return shape.values[ctx.i] ? 1 : NaN;
    }

    case "plotarrow": {
      const shape = shapeState(ctx, node);
      const value = toNum(evalNode(node.args[0], ctx));
      shape.values[ctx.i] = Number.isFinite(value) && value !== 0;
      shape.style = value < 0 ? "triangledown" : "triangleup";
      shape.location = value < 0 ? "location.abovebar" : "location.belowbar";
      const color = arg(node, 2, "colorup", ctx) || arg(node, 3, "colordown", ctx);
      if (typeof color === "string") {
        shape.color = color;
        shape.colors[ctx.i] = color;
      }
      return value;
    }

    case "hline": {
      const price = toNum(evalNode(node.args[0], ctx));
      if (!Number.isFinite(price)) return NaN;
      const title = stringArg(node, 1, "title", ctx, "");
      const color = stringArg(node, 2, "color", ctx, "#787b86");
      const style = stringArg(node, 3, "linestyle", ctx, "hline.style_solid");
      const width = numberArg(node, 4, "linewidth", ctx, 1);
      const key = `${title}:${price}`;
      ctx.hlines.set(key, { price, title, color, style, width });
      return price;
    }

    case "indicator":
    case "strategy":
    case "study":
    case "library":
    case "fill":
    case "bgcolor":
    case "barcolor":
    case "alertcondition":
    case "alert":
    case "strategy.entry":
    case "strategy.exit":
    case "strategy.close":
    case "strategy.close_all":
    case "strategy.cancel":
    case "strategy.order":
    case "label.new":
    case "label.delete":
    case "line.new":
    case "line.delete":
    case "box.new":
    case "box.delete":
    case "table.new":
    case "table.cell":
    case "log.info":
    case "log.warning":
    case "log.error":
      return NaN;

    case "request.security": {
      const expression = node.args[2];
      if (!expression) return NaN;
      const timeframe = stringArg(node, 1, "timeframe", ctx, "");
      return securityValue(expression, timeframe, ctx);
    }

    case "color.new": {
      const color = stringArg(node, 0, "color", ctx, "#787b86");
      const transparency = numberArg(node, 1, "transp", ctx, 0);
      return withAlpha(color, 1 - Math.max(0, Math.min(100, transparency)) / 100);
    }

    case "color.rgb": {
      const r = Math.round(numberArg(node, 0, "red", ctx, 0));
      const g = Math.round(numberArg(node, 1, "green", ctx, 0));
      const b = Math.round(numberArg(node, 2, "blue", ctx, 0));
      const transparency = numberArg(node, 3, "transp", ctx, 0);
      const alpha = 1 - Math.max(0, Math.min(100, transparency)) / 100;
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    case "nz": {
      const value = scalarValue(evalNode(node.args[0], ctx), ctx);
      if (!isNa(value)) return value;
      return node.args[1] ? scalarValue(evalNode(node.args[1], ctx), ctx) : 0;
    }

    case "na":
      return isNa(scalarValue(evalNode(node.args[0], ctx), ctx));

    case "fixnan": {
      const value = scalarValue(evalNode(node.args[0], ctx), ctx);
      if (!isNa(value)) {
        ctx.scalars.set("__fixnan_" + node.id, value);
        return value;
      }
      return ctx.scalars.get("__fixnan_" + node.id) ?? NaN;
    }

    case "str.tostring":
    case "tostring": {
      const value = scalarValue(evalNode(node.args[0], ctx), ctx);
      return isNa(value) ? "na" : String(value);
    }

    case "runtime.error":
      ctx.error = String(scalarValue(evalNode(node.args[0], ctx), ctx) || "runtime.error");
      return NaN;

    default:
      break;
  }

  if (name.startsWith("input.") || name === "input") {
    const target = node.args[0] || node.named.defval;
    if (name === "input.source") return target ? evalNode(target, ctx) : { __series: ctx.sources.close };
    return target ? evalNode(target, ctx) : NaN;
  }

  if (name.startsWith("ta.")) return taFunction(name.slice(3), node, ctx);
  if (name.startsWith("math.")) return mathFunction(name.slice(5), node, ctx);

  return NaN;
}

/* -------------------------------------------------------------------- ta */

function taState(node, ctx) {
  let state = ctx.ta.get(node.id);
  if (!state) {
    state = { out: [] };
    ctx.ta.set(node.id, state);
  }
  return state;
}

function ensureOut(state, index) {
  while (state.out.length <= index) {
    state.out.push(state.out.length ? state.out[state.out.length - 1] : NaN);
  }
}

function windowValues(source, index, length) {
  const values = [];
  for (let i = index - length + 1; i <= index; i++) {
    if (i < 0) return null;
    const value = valueAt(source, i);
    if (isNa(value)) return null;
    values.push(value);
  }
  return values;
}

function wmaWindow(source, index, length) {
  const values = windowValues(source, index, length);
  if (!values) return NaN;
  let sum = 0;
  let weight = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i] * (i + 1);
    weight += i + 1;
  }
  return sum / weight;
}

function taFunction(name, node, ctx) {
  const source = sourceArg(node, 0, "source", ctx);
  const length = Math.max(1, Math.round(numberArg(node, 1, "length", ctx, 14)));

  switch (name) {
    case "ema":
    case "rma": {
      const state = taState(node, ctx);
      ensureOut(state, ctx.i);
      const current = valueAt(source, ctx.i);
      const previous = state.out[ctx.i - 1];
      const alpha = name === "ema" ? 2 / (length + 1) : 1 / length;
      state.out[ctx.i] = isNa(current)
        ? previous
        : ctx.i === 0 || isNa(previous)
          ? current
          : current * alpha + previous * (1 - alpha);
      return state.out[ctx.i];
    }

    case "sma":
    case "sum": {
      const values = windowValues(source, ctx.i, length);
      if (!values) return NaN;
      const total = values.reduce((sum, value) => sum + value, 0);
      return name === "sma" ? total / values.length : total;
    }

    case "wma":
      return wmaWindow(source, ctx.i, length);

    case "hma": {
      const half = Math.max(1, Math.floor(length / 2));
      const root = Math.max(1, Math.round(Math.sqrt(length)));
      let sum = 0;
      let weight = 0;
      for (let offset = 0; offset < root; offset++) {
        const index = ctx.i - root + 1 + offset;
        if (index < 0) return NaN;
        const raw = 2 * wmaWindow(source, index, half) - wmaWindow(source, index, length);
        if (isNa(raw)) return NaN;
        sum += raw * (offset + 1);
        weight += offset + 1;
      }
      return sum / weight;
    }

    case "rsi": {
      const state = taState(node, ctx);
      ensureOut(state, ctx.i);
      const current = valueAt(source, ctx.i);
      if (isNa(current)) return NaN;
      if (ctx.i === 0) {
        state.prev = current;
        state.gain = 0;
        state.loss = 0;
        state.out[ctx.i] = NaN;
        return NaN;
      }

      const gain = Math.max(current - state.prev, 0);
      const loss = Math.max(state.prev - current, 0);
      const period = Math.min(length, ctx.i + 1);
      state.gain = (state.gain * (period - 1) + gain) / period;
      state.loss = (state.loss * (period - 1) + loss) / period;
      state.prev = current;

      state.out[ctx.i] =
        state.loss === 0 ? 100 : 100 - 100 / (1 + state.gain / state.loss);
      return state.out[ctx.i];
    }

    case "stdev":
    case "variance": {
      const values = windowValues(source, ctx.i, length);
      if (!values) return NaN;
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      const variance =
        values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
      return name === "variance" ? variance : Math.sqrt(variance);
    }

    case "highest":
    case "lowest": {
      const values = windowValues(source, ctx.i, length);
      if (!values) return NaN;
      return name === "highest" ? Math.max(...values) : Math.min(...values);
    }

    case "change": {
      const current = valueAt(source, ctx.i);
      const previous = valueAt(source, ctx.i - length);
      return isNa(current) || isNa(previous) ? NaN : current - previous;
    }

    case "roc": {
      const current = valueAt(source, ctx.i);
      const previous = valueAt(source, ctx.i - length);
      return isNa(current) || isNa(previous) || previous === 0
        ? NaN
        : ((current - previous) / previous) * 100;
    }

    case "crossover":
    case "crossunder":
    case "cross": {
      const other = sourceArg(node, 1, "source2", ctx);
      const a = valueAt(source, ctx.i);
      const b = valueAt(other, ctx.i);
      const aPrev = valueAt(source, ctx.i - 1);
      const bPrev = valueAt(other, ctx.i - 1);
      if ([a, b, aPrev, bPrev].some(isNa)) return false;
      if (name === "crossover") return aPrev <= bPrev && a > b;
      if (name === "crossunder") return aPrev >= bPrev && a < b;
      return (aPrev < bPrev && a > b) || (aPrev > bPrev && a < b);
    }

    case "cum": {
      const state = taState(node, ctx);
      ensureOut(state, ctx.i);
      const current = valueAt(source, ctx.i);
      state.out[ctx.i] = isNa(current)
        ? state.out[ctx.i - 1] || 0
        : (state.out[ctx.i - 1] || 0) + current;
      return state.out[ctx.i];
    }

    case "barssince": {
      const state = taState(node, ctx);
      const condition = truthy(evalNode(node.args[0], ctx), ctx);
      state.count = condition ? 0 : Number.isFinite(state.count) ? state.count + 1 : NaN;
      return state.count;
    }

    case "valuewhen": {
      const state = taState(node, ctx);
      if (!state.conditions) {
        state.conditions = [];
        state.values = [];
      }
      state.conditions[ctx.i] = truthy(evalNode(node.args[0], ctx), ctx);
      state.values[ctx.i] = valueAt(source, ctx.i);
      const occurrence = Math.max(0, Math.round(numberArg(node, 2, "occurrence", ctx, 0)));
      let seen = 0;
      for (let i = ctx.i; i >= 0; i--) {
        if (!state.conditions[i]) continue;
        if (seen === occurrence) return state.values[i];
        seen++;
      }
      return NaN;
    }

    case "rising":
    case "falling": {
      for (let i = 0; i < length; i++) {
        const current = valueAt(source, ctx.i - i);
        const previous = valueAt(source, ctx.i - i - 1);
        if (isNa(current) || isNa(previous)) return false;
        if (name === "rising" ? current <= previous : current >= previous) return false;
      }
      return true;
    }

    case "tr": {
      const index = ctx.i;
      const candle = ctx.candles[index];
      if (!candle) return NaN;
      const previousClose = index > 0 ? ctx.candles[index - 1].close : candle.close;
      return Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - previousClose),
        Math.abs(candle.low - previousClose),
      );
    }

    case "atr": {
      const state = taState(node, ctx);
      ensureOut(state, ctx.i);
      const candle = ctx.candles[ctx.i];
      if (!candle) return NaN;
      const previousClose = ctx.i > 0 ? ctx.candles[ctx.i - 1].close : candle.close;
      const tr = Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - previousClose),
        Math.abs(candle.low - previousClose),
      );
      state.out[ctx.i] =
        ctx.i === 0
          ? tr
          : (state.out[ctx.i - 1] * (length - 1) + tr) / length;
      return state.out[ctx.i];
    }

    case "vwap": {
      const state = taState(node, ctx);
      ensureOut(state, ctx.i);
      const candle = ctx.candles[ctx.i];
      if (!candle) return NaN;
      const price = (candle.high + candle.low + candle.close) / 3;
      state.price = (state.price || 0) + price * (candle.volume || 0);
      state.volume = (state.volume || 0) + (candle.volume || 0);
      state.out[ctx.i] = state.volume ? state.price / state.volume : NaN;
      return state.out[ctx.i];
    }

    case "obv": {
      const state = taState(node, ctx);
      ensureOut(state, ctx.i);
      const candle = ctx.candles[ctx.i];
      if (!candle) return NaN;
      const previous = ctx.i > 0 ? ctx.candles[ctx.i - 1] : candle;
      const delta = candle.close > previous.close ? candle.volume : candle.close < previous.close ? -candle.volume : 0;
      state.out[ctx.i] = (state.out[ctx.i - 1] || 0) + delta;
      return state.out[ctx.i];
    }

    case "linreg": {
      const values = windowValues(source, ctx.i, length);
      if (!values) return NaN;
      const offset = numberArg(node, 2, "offset", ctx, 0);
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let sxy = 0;
      for (let i = 0; i < values.length; i++) {
        sx += i;
        sy += values[i];
        sxx += i * i;
        sxy += i * values[i];
      }
      const denominator = values.length * sxx - sx * sx;
      if (!denominator) return NaN;
      const slope = (values.length * sxy - sx * sy) / denominator;
      const intercept = (sy - slope * sx) / values.length;
      return intercept + slope * (values.length - 1 - offset);
    }

    default:
      return NaN;
  }
}

/* ------------------------------------------------------------------ math */

function mathFunction(name, node, ctx) {
  const values = node.args.map((item) => toNum(evalNode(item, ctx)));

  switch (name) {
    case "abs":
      return Math.abs(values[0]);
    case "max":
      return Math.max(...values);
    case "min":
      return Math.min(...values);
    case "round": {
      const precision = Number.isFinite(values[1]) ? values[1] : 0;
      const factor = 10 ** precision;
      return Math.round(values[0] * factor) / factor;
    }
    case "floor":
      return Math.floor(values[0]);
    case "ceil":
      return Math.ceil(values[0]);
    case "sqrt":
      return Math.sqrt(values[0]);
    case "pow":
      return values[0] ** values[1];
    case "log":
      return Math.log(values[0]);
    case "log10":
      return Math.log10(values[0]);
    case "exp":
      return Math.exp(values[0]);
    case "sign":
      return Math.sign(values[0]);
    case "avg":
      return values.reduce((sum, value) => sum + value, 0) / values.length;
    case "sum":
      return values.reduce((sum, value) => sum + value, 0);
    case "todegrees":
      return (values[0] * 180) / Math.PI;
    case "toradians":
      return (values[0] * Math.PI) / 180;
    case "random":
      return Math.random();
    default:
      return NaN;
  }
}

/* -------------------------------------------------------------- security */

function timeframeSeconds(timeframe) {
  const text = String(timeframe || "").trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) * 60;

  const match = text.match(/^(\d*)\s*([A-Za-z])$/);
  if (!match) return null;
  const unit = match[2].toUpperCase();
  const base = { S: 1, M: 60, H: 3600, D: 86400, W: 604800 }[unit];
  if (!base) return null;
  return base * Math.max(1, Number(match[1] || 1));
}

function aggregate(candles, seconds) {
  const out = [];
  let bucket = null;

  for (const candle of candles) {
    const next = Math.floor(candle.time / seconds);
    if (next !== bucket) {
      bucket = next;
      out.push({
        time: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume || 0,
      });
    } else {
      const current = out[out.length - 1];
      current.high = Math.max(current.high, candle.high);
      current.low = Math.min(current.low, candle.low);
      current.close = candle.close;
      current.volume += candle.volume || 0;
    }
  }

  return out;
}

function securityValue(expression, timeframe, ctx) {
  const seconds = timeframeSeconds(timeframe);
  const spacing =
    ctx.candles.length > 1 ? ctx.candles[ctx.candles.length - 1].time - ctx.candles[ctx.candles.length - 2].time : 0;

  if (!seconds || seconds <= spacing) {
    return scalarValue(evalNode(expression, ctx), ctx);
  }

  const key = `${timeframe}:${expression.id}`;
  let cache = ctx.security.get(key);

  if (!cache) {
    const bars = aggregate(ctx.candles, seconds);
    const sub = createContext(bars, { symbol: ctx.symbol, interval: timeframe });
    const values = new Array(bars.length).fill(NaN);

    for (let i = 0; i < bars.length; i++) {
      sub.i = i;
      prepareVars(sub);
      values[i] = scalarValue(evalNode(expression, sub), sub);
    }

    cache = { times: bars.map((bar) => bar.time), values };
    ctx.security.set(key, cache);
  }

  const time = ctx.candles[ctx.i].time;
  let low = 0;
  let high = cache.times.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (cache.times[middle] <= time) low = middle + 1;
    else high = middle;
  }

  const index = low - 2;
  return index >= 0 ? cache.values[index] : NaN;
}

/* --------------------------------------------------------------- helpers */

function withAlpha(color, alpha) {
  const text = String(color || "").trim();
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);

  if (hex) {
    const value = hex[1].length === 3 ? hex[1].replace(/./g, (ch) => ch + ch) : hex[1];
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  const rgb = text.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1].split(",").map((part) => part.trim());
    return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
  }

  return color;
}

function collectPlots(ctx) {
  const plots = [];
  for (const plot of ctx.plots.values()) {
    const values = new Array(ctx.n).fill(NaN);
    for (let i = 0; i < ctx.n; i++) values[i] = plot.values[i];
    plots.push({
      id: plot.id,
      title: plot.title || "plot",
      values,
      colors: plot.colors.slice(0, ctx.n),
      color: plot.color,
      width: plot.width,
      style: plot.style,
    });
  }
  return plots;
}

function collectShapes(ctx) {
  const shapes = [];
  for (const shape of ctx.shapes.values()) {
    const values = new Array(ctx.n).fill(false);
    const colors = new Array(ctx.n).fill("");
    for (let i = 0; i < ctx.n; i++) {
      values[i] = Boolean(shape.values[i]);
      colors[i] = shape.colors[i] || shape.color || "";
    }
    shapes.push({
      id: shape.id,
      title: shape.title,
      values,
      colors,
      color: shape.color,
      style: shape.style,
      location: shape.location,
    });
  }
  return shapes;
}

/* --------------------------------------------------------------- program */

function execBlock(nodes, ctx) {
  for (const node of nodes) {
    if (node.isElse) continue;
    try {
      execStatement(node, ctx);
    } catch (error) {
      ctx.error = String((error && error.message) || error);
      return;
    }
    if (ctx.error) return;
  }
}

function execStatement(node, ctx) {
  const statement = node.stmt;

  switch (statement.kind) {
    case "assign": {
      if (statement.isVar && ctx.i > 0) return;
      const value = evalNode(statement.expr, ctx);

      if (statement.names.length > 1) {
        const values = Array.isArray(value) ? value : [value];
        statement.names.forEach((name, index) => {
          setVar(ctx, name, scalarValue(values[index], ctx));
        });
      } else {
        setVar(ctx, statement.names[0], scalarValue(value, ctx));
      }
      return;
    }

    case "if":
      execIf(node, ctx);
      return;

    case "for": {
      const from = Math.round(toNum(evalNode(statement.from, ctx)));
      const to = Math.round(toNum(evalNode(statement.to, ctx)));
      const step = statement.by ? Math.round(toNum(evalNode(statement.by, ctx))) : from <= to ? 1 : -1;
      if (!Number.isFinite(from) || !Number.isFinite(to) || !step) return;

      const previous = ctx.scalars.get(statement.name);
      let iterations = 0;
      for (let value = from; step > 0 ? value <= to : value >= to; value += step) {
        if (++iterations > 2000) break;
        ctx.scalars.set(statement.name, value);
        execBlock(node.children, ctx);
        if (ctx.error) break;
      }
      if (previous === undefined) ctx.scalars.delete(statement.name);
      else ctx.scalars.set(statement.name, previous);
      return;
    }

    case "while": {
      let iterations = 0;
      while (truthy(evalNode(statement.cond, ctx), ctx)) {
        if (++iterations > 2000) break;
        execBlock(node.children, ctx);
        if (ctx.error) break;
      }
      return;
    }

    case "expr":
      evalNode(statement.expr, ctx);
      return;

    default:
      return;
  }
}

function execIf(node, ctx) {
  if (truthy(evalNode(node.stmt.cond, ctx), ctx)) {
    execBlock(node.children, ctx);
    return;
  }

  const alternative = node.elseNode;
  if (!alternative) return;
  if (alternative.stmt.kind === "if") execIf(alternative, ctx);
  else execBlock(alternative.children, ctx);
}
