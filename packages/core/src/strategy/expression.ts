import type { RuleInputFact } from '../entity/strategy.js';
import { InvariantError } from '../error/index.js';

/**
 * Strategy DSL mini-eval；legacy Tactic 从本模块 re-export。
 *
 * 设计取舍：
 * - 自实现 recursive-descent 解释器，**不**引第三方表达式库（expr-eval / jexl）。
 * - 禁止使用 `eval` / `new Function` / 任何动态代码生成。
 * - 支持：
 *     字面量（number / boolean / null / undefined）
 *     一元 `!` `-`
 *     二元算术 `+ - * / %`
 *     比较 `== != === !== < <= > >=`
 *     逻辑 `&& ||`
 *     括号 `(...)`
 *     路径访问 `a.b.c`（只在 context 内查找）
 *     函数调用（白名单：`Math.min` / `Math.max` / `Math.abs`）
 * - 不支持：
 *     字符串字面量
 *     函数定义、`new`、`import`、`this`、数组、对象字面量
 *     未在白名单中的全局访问（Math 之外的标识符都视作 context 字段）
 *
 * 模板替换：
 *   - `interpolate(template, ctx)` 把 `${expr}` 替换为 evaluateExpression(expr, ctx) 的字符串结果
 *   - evaluateExpression 直接接受完整表达式，无模板替换
 *
 * 错误模型：
 *   - 任何解析或求值失败抛 `DslEvalError`（继承 Error，单独命名便于上层 catch）
 *   - 调用方（run_tactic）捕获后转成「战法运行失败」的副作用，不阻塞其它战法。
 */

const FORBIDDEN_KEYWORDS = [
  'import',
  'require',
  'function ',
  '=>',
  'eval(',
  'Function(',
  'new ',
  'this',
  'globalThis',
  'window',
  'process',
];

/** 战法表达式禁用关键字（与 tactic.ts assertTacticInvariants 保持一致）。 */
export const assertExpressionSafety = (expr: string): void => {
  for (const kw of FORBIDDEN_KEYWORDS) {
    if (expr.includes(kw)) {
      throw new Error(`战法表达式禁用关键字: "${kw}"`);
    }
  }
};

/** DSL 求值错误。 */
export class DslEvalError extends Error {
  override readonly name = 'DslEvalError';
  constructor(
    message: string,
    readonly expression: string,
  ) {
    super(`${message}（expression=${expression}）`);
  }
}

// ---------- token ----------

type TokenKind =
  | 'num'
  | 'bool'
  | 'null'
  | 'ident'
  | 'op'
  | 'lparen'
  | 'rparen'
  | 'dot'
  | 'comma'
  | 'eof';

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
  readonly pos: number;
}

const isDigit = (c: string): boolean => c >= '0' && c <= '9';

const tokenize = (src: string): Token[] => {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '(') {
      tokens.push({ kind: 'lparen', value: '(', pos: i });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ kind: 'rparen', value: ')', pos: i });
      i++;
      continue;
    }
    if (c === '.') {
      tokens.push({ kind: 'dot', value: '.', pos: i });
      i++;
      continue;
    }
    if (c === ',') {
      tokens.push({ kind: 'comma', value: ',', pos: i });
      i++;
      continue;
    }
    if (c === '>' || c === '<' || c === '=' || c === '!') {
      let j = i + 1;
      if (src[j] === '=') j++;
      if (src[j] === '=') j++;
      tokens.push({ kind: 'op', value: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (c === '&' && src[i + 1] === '&') {
      tokens.push({ kind: 'op', value: '&&', pos: i });
      i += 2;
      continue;
    }
    if (c === '|' && src[i + 1] === '|') {
      tokens.push({ kind: 'op', value: '||', pos: i });
      i += 2;
      continue;
    }
    if (c === '+' || c === '-' || c === '*' || c === '/' || c === '%') {
      tokens.push({ kind: 'op', value: c, pos: i });
      i++;
      continue;
    }
    if (isDigit(c)) {
      let j = i;
      while (j < src.length) {
        const cj = src[j] as string;
        if (isDigit(cj) || cj === '.') j++;
        else break;
      }
      const literal = src.slice(i, j);
      const n = Number(literal);
      if (!Number.isFinite(n)) throw new DslEvalError(`非法数字字面量: ${literal}`, src);
      tokens.push({ kind: 'num', value: literal, pos: i });
      i = j;
      continue;
    }
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') {
      let j = i + 1;
      while (j < src.length) {
        const cj = src[j] as string;
        if ((cj >= 'a' && cj <= 'z') || (cj >= 'A' && cj <= 'Z') || isDigit(cj) || cj === '_') j++;
        else break;
      }
      const ident = src.slice(i, j);
      if (ident === 'true' || ident === 'false') {
        tokens.push({ kind: 'bool', value: ident, pos: i });
      } else if (ident === 'null' || ident === 'undefined') {
        tokens.push({ kind: 'null', value: ident, pos: i });
      } else {
        tokens.push({ kind: 'ident', value: ident, pos: i });
      }
      i = j;
      continue;
    }
    throw new DslEvalError(`无法识别的字符: '${c}'`, src);
  }
  tokens.push({ kind: 'eof', value: '', pos: src.length });
  return tokens;
};

// ---------- parser / evaluator ----------
//
// Pratt 风格的递归下降解析；路径访问 + 函数调用在 parsePrimary 中处理。
// 优先级（低 → 高）：
//   ||, &&, ==/!=/===/!==, </<=/>/>=, +/-, */%/,  !/-一元,  原子

type CtxObj = Readonly<Record<string, unknown>>;

interface Cursor {
  readonly tokens: Token[];
  pos: number;
}

const peek = (c: Cursor): Token => {
  const t = c.tokens[c.pos];
  if (t === undefined) throw new DslEvalError('unexpected end', '');
  return t;
};

const eat = (c: Cursor, kind: TokenKind, value?: string): Token => {
  const t = peek(c);
  if (t.kind !== kind || (value !== undefined && t.value !== value)) {
    throw new DslEvalError(`期望 ${value ?? kind}，得到 ${t.kind}(${t.value})`, '');
  }
  c.pos++;
  return t;
};

/** 按 path segments 在 ctx 中取值；任一节点缺失返回 undefined。 */
export const resolveExpressionPath = (path: string, ctx: CtxObj): unknown => {
  const segments = path.split('.');
  if (segments.length === 0) return undefined;
  let cur: unknown = ctx[segments[0] as string];
  for (let i = 1; i < segments.length; i++) {
    if (cur === undefined || cur === null) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[segments[i] as string];
  }
  return cur;
};

const parseExpr = (c: Cursor, ctx: CtxObj): unknown => parseOr(c, ctx);
const parseOr = (c: Cursor, ctx: CtxObj): unknown => {
  let left: unknown = parseAnd(c, ctx);
  while (peek(c).kind === 'op' && peek(c).value === '||') {
    eat(c, 'op', '||');
    const right = parseAnd(c, ctx);
    left = Boolean(left) || Boolean(right);
  }
  return left;
};
const parseAnd = (c: Cursor, ctx: CtxObj): unknown => {
  let left: unknown = parseEquality(c, ctx);
  while (peek(c).kind === 'op' && peek(c).value === '&&') {
    eat(c, 'op', '&&');
    const r = parseEquality(c, ctx);
    left = Boolean(left) && Boolean(r);
  }
  return left;
};
const parseEquality = (c: Cursor, ctx: CtxObj): unknown => {
  let left: unknown = parseRelational(c, ctx);
  while (peek(c).kind === 'op' && ['==', '!=', '===', '!=='].includes(peek(c).value)) {
    const op = eat(c, 'op').value;
    const right: unknown = parseRelational(c, ctx);
    if (op === '==')
      // biome-ignore lint/suspicious/noDoubleEquals: DSL 宽松等于
      left = left == right;
    else if (op === '!=')
      // biome-ignore lint/suspicious/noDoubleEquals: DSL 宽松不等于
      left = left != right;
    else if (op === '===') left = left === right;
    else left = left !== right;
  }
  return left;
};
const parseRelational = (c: Cursor, ctx: CtxObj): unknown => {
  let left: unknown = parseAdditive(c, ctx);
  while (peek(c).kind === 'op' && ['<', '<=', '>', '>='].includes(peek(c).value)) {
    const op = eat(c, 'op').value;
    const right: unknown = parseAdditive(c, ctx);
    const a = left as number;
    const b = right as number;
    if (op === '<') left = a < b;
    else if (op === '<=') left = a <= b;
    else if (op === '>') left = a > b;
    else left = a >= b;
  }
  return left;
};
const parseAdditive = (c: Cursor, ctx: CtxObj): unknown => {
  let left: unknown = parseMultiplicative(c, ctx);
  while (peek(c).kind === 'op' && (peek(c).value === '+' || peek(c).value === '-')) {
    const op = eat(c, 'op').value;
    const right: unknown = parseMultiplicative(c, ctx);
    left = op === '+' ? (left as number) + (right as number) : (left as number) - (right as number);
  }
  return left;
};
const parseMultiplicative = (c: Cursor, ctx: CtxObj): unknown => {
  let left: unknown = parseUnary(c, ctx);
  while (peek(c).kind === 'op' && ['*', '/', '%'].includes(peek(c).value)) {
    const op = eat(c, 'op').value;
    const right: unknown = parseUnary(c, ctx);
    if (op === '*') left = (left as number) * (right as number);
    else if (op === '/') left = (left as number) / (right as number);
    else left = (left as number) % (right as number);
  }
  return left;
};
const parseUnary = (c: Cursor, ctx: CtxObj): unknown => {
  const t = peek(c);
  if (t.kind === 'op' && t.value === '!') {
    eat(c, 'op', '!');
    return !parseUnary(c, ctx);
  }
  if (t.kind === 'op' && t.value === '-') {
    eat(c, 'op', '-');
    return -(parseUnary(c, ctx) as number);
  }
  return parsePrimary(c, ctx);
};

const parsePrimary = (c: Cursor, ctx: CtxObj): unknown => {
  const t = peek(c);
  if (t.kind === 'lparen') {
    eat(c, 'lparen');
    const e = parseExpr(c, ctx);
    eat(c, 'rparen');
    return e;
  }
  if (t.kind === 'num') {
    eat(c, 'num');
    return Number(t.value);
  }
  if (t.kind === 'bool') {
    eat(c, 'bool');
    return t.value === 'true';
  }
  if (t.kind === 'null') {
    eat(c, 'null');
    return t.value === 'undefined' ? undefined : null;
  }
  if (t.kind === 'ident') {
    // 收集路径段
    const segs: string[] = [eat(c, 'ident').value];
    while (peek(c).kind === 'dot') {
      eat(c, 'dot');
      segs.push(eat(c, 'ident').value);
    }
    // 检查函数调用（仅白名单 Math.X）
    if (peek(c).kind === 'lparen' && segs.length === 2 && segs[0] === 'Math') {
      const fnName = `Math.${segs[1]}`;
      eat(c, 'lparen');
      const args: unknown[] = [];
      if (peek(c).kind !== 'rparen') {
        args.push(parseExpr(c, ctx));
        while (peek(c).kind === 'comma') {
          eat(c, 'comma');
          args.push(parseExpr(c, ctx));
        }
      }
      eat(c, 'rparen');
      return callWhitelistedFunction(fnName, args);
    }
    // 普通路径解析
    return resolveExpressionPath(segs.join('.'), ctx);
  }
  throw new DslEvalError(`无法解析的 token: ${t.kind}(${t.value})`, '');
};

const callWhitelistedFunction = (name: string, args: readonly unknown[]): unknown => {
  if (name === 'Math.min') {
    if (args.length === 0) return Number.POSITIVE_INFINITY;
    return Math.min(...(args as number[]));
  }
  if (name === 'Math.max') {
    if (args.length === 0) return Number.NEGATIVE_INFINITY;
    return Math.max(...(args as number[]));
  }
  if (name === 'Math.abs') {
    if (args.length !== 1)
      throw new DslEvalError(`Math.abs 需要 1 个参数，实际 ${args.length}`, '');
    return Math.abs(args[0] as number);
  }
  throw new DslEvalError(`函数未在白名单: ${name}`, '');
};

// ---------- 公共 API ----------

/**
 * 求值表达式。context 字段访问：`a.b.c` 等价于 `context.a.b.c`。
 * 返回 number / boolean / undefined / null。
 */
export const evaluateExpression = (expression: string, context: CtxObj): unknown => {
  const trimmed = expression.trim();
  if (trimmed === '') throw new DslEvalError('表达式为空', expression);
  assertExpressionSafety(trimmed);
  const tokens = tokenize(trimmed);
  const cur: Cursor = { tokens, pos: 0 };
  const result = parseExpr(cur, context);
  if (peek(cur).kind !== 'eof') {
    throw new DslEvalError(`表达式末尾有多余 token: ${peek(cur).value}`, trimmed);
  }
  return result;
};

const TEMPLATE_RE = /\$\{([^}]+)\}/g;

const pathsFromTokens = (tokens: readonly Token[]): string[] => {
  const paths: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index]?.kind !== 'ident') continue;
    const segments = [tokens[index]?.value as string];
    while (tokens[index + 1]?.kind === 'dot' && tokens[index + 2]?.kind === 'ident') {
      segments.push(tokens[index + 2]?.value as string);
      index += 2;
    }
    if (segments[0] !== 'Math') paths.push(segments.join('.'));
  }
  return paths;
};

/** 静态提取表达式中的 context path；兼容 legacy `${path}` 与直接 path 写法。 */
export const extractExpressionPaths = (expression: string): readonly string[] => {
  const paths = new Set<string>();
  const withoutTemplates = expression.replace(TEMPLATE_RE, (_, inner: string) => {
    for (const path of pathsFromTokens(tokenize(inner))) paths.add(path);
    return '0';
  });
  for (const path of pathsFromTokens(tokenize(withoutTemplates))) paths.add(path);
  return [...paths].sort();
};

/** evidence 是普通文本，仅 `${...}` 片段属于表达式。 */
export const extractTemplatePaths = (template: string): readonly string[] => {
  const paths = new Set<string>();
  for (const match of template.matchAll(TEMPLATE_RE)) {
    for (const path of pathsFromTokens(tokenize(match[1] as string))) paths.add(path);
  }
  return [...paths].sort();
};

// ---------- compiled lazy expression ----------

type CompiledNode =
  | { readonly kind: 'literal'; readonly value: unknown }
  | { readonly kind: 'path'; readonly path: string }
  | { readonly kind: 'unary'; readonly op: '!' | '-'; readonly value: CompiledNode }
  | {
      readonly kind: 'binary';
      readonly op: string;
      readonly left: CompiledNode;
      readonly right: CompiledNode;
    }
  | { readonly kind: 'call'; readonly name: string; readonly args: readonly CompiledNode[] };

class AstParser {
  private readonly cursor: Cursor;

  constructor(private readonly expression: string) {
    this.cursor = { tokens: tokenize(expression), pos: 0 };
  }

  parse(): CompiledNode {
    const node = this.parseOr();
    if (peek(this.cursor).kind !== 'eof') {
      throw new DslEvalError(`表达式末尾有多余 token: ${peek(this.cursor).value}`, this.expression);
    }
    return node;
  }

  private parseOr(): CompiledNode {
    let left = this.parseAnd();
    while (peek(this.cursor).kind === 'op' && peek(this.cursor).value === '||') {
      eat(this.cursor, 'op', '||');
      left = { kind: 'binary', op: '||', left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): CompiledNode {
    let left = this.parseEquality();
    while (peek(this.cursor).kind === 'op' && peek(this.cursor).value === '&&') {
      eat(this.cursor, 'op', '&&');
      left = { kind: 'binary', op: '&&', left, right: this.parseEquality() };
    }
    return left;
  }

  private parseEquality(): CompiledNode {
    let left = this.parseRelational();
    while (
      peek(this.cursor).kind === 'op' &&
      ['==', '!=', '===', '!=='].includes(peek(this.cursor).value)
    ) {
      const op = eat(this.cursor, 'op').value;
      left = { kind: 'binary', op, left, right: this.parseRelational() };
    }
    return left;
  }

  private parseRelational(): CompiledNode {
    let left = this.parseAdditive();
    while (
      peek(this.cursor).kind === 'op' &&
      ['<', '<=', '>', '>='].includes(peek(this.cursor).value)
    ) {
      const op = eat(this.cursor, 'op').value;
      left = { kind: 'binary', op, left, right: this.parseAdditive() };
    }
    return left;
  }

  private parseAdditive(): CompiledNode {
    let left = this.parseMultiplicative();
    while (
      peek(this.cursor).kind === 'op' &&
      (peek(this.cursor).value === '+' || peek(this.cursor).value === '-')
    ) {
      const op = eat(this.cursor, 'op').value;
      left = { kind: 'binary', op, left, right: this.parseMultiplicative() };
    }
    return left;
  }

  private parseMultiplicative(): CompiledNode {
    let left = this.parseUnaryAst();
    while (peek(this.cursor).kind === 'op' && ['*', '/', '%'].includes(peek(this.cursor).value)) {
      const op = eat(this.cursor, 'op').value;
      left = { kind: 'binary', op, left, right: this.parseUnaryAst() };
    }
    return left;
  }

  private parseUnaryAst(): CompiledNode {
    const token = peek(this.cursor);
    if (token.kind === 'op' && (token.value === '!' || token.value === '-')) {
      eat(this.cursor, 'op', token.value);
      return { kind: 'unary', op: token.value, value: this.parseUnaryAst() };
    }
    return this.parsePrimaryAst();
  }

  private parsePrimaryAst(): CompiledNode {
    const token = peek(this.cursor);
    if (token.kind === 'lparen') {
      eat(this.cursor, 'lparen');
      const node = this.parseOr();
      eat(this.cursor, 'rparen');
      return node;
    }
    if (token.kind === 'num') {
      eat(this.cursor, 'num');
      return { kind: 'literal', value: Number(token.value) };
    }
    if (token.kind === 'bool') {
      eat(this.cursor, 'bool');
      return { kind: 'literal', value: token.value === 'true' };
    }
    if (token.kind === 'null') {
      eat(this.cursor, 'null');
      return { kind: 'literal', value: token.value === 'undefined' ? undefined : null };
    }
    if (token.kind !== 'ident') {
      throw new DslEvalError(`无法解析的 token: ${token.kind}(${token.value})`, this.expression);
    }
    const segments: string[] = [eat(this.cursor, 'ident').value];
    while (peek(this.cursor).kind === 'dot') {
      eat(this.cursor, 'dot');
      segments.push(eat(this.cursor, 'ident').value);
    }
    const path = segments.join('.');
    if (peek(this.cursor).kind === 'lparen') {
      if (segments.length !== 2 || segments[0] !== 'Math') {
        throw new DslEvalError(`函数未在白名单: ${path}`, this.expression);
      }
      eat(this.cursor, 'lparen');
      const args: CompiledNode[] = [];
      if (peek(this.cursor).kind !== 'rparen') {
        args.push(this.parseOr());
        while (peek(this.cursor).kind === 'comma') {
          eat(this.cursor, 'comma');
          args.push(this.parseOr());
        }
      }
      eat(this.cursor, 'rparen');
      return { kind: 'call', name: path, args };
    }
    if (path === 'Math') throw new DslEvalError('Math 不能作为字段读取', this.expression);
    return { kind: 'path', path };
  }
}

const MISSING = Symbol('strategy-expression-missing');
type EvaluatedValue = unknown | typeof MISSING;

const asComparable = (value: EvaluatedValue): unknown => (value === MISSING ? undefined : value);

const truthy = (value: EvaluatedValue): boolean => Boolean(asComparable(value));

interface EvaluationState {
  readonly context: Readonly<Record<string, unknown>>;
  readonly reads: RuleInputFact[];
  readonly missingPaths: Set<string>;
}

const readPath = (path: string, state: EvaluationState): EvaluatedValue => {
  const value = resolveExpressionPath(path, state.context);
  if (value === undefined) {
    state.missingPaths.add(path);
    state.reads.push({ path, status: 'missing' });
    return MISSING;
  }
  state.reads.push({ path, status: 'available', value });
  return value;
};

const evaluateCompiledNode = (node: CompiledNode, state: EvaluationState): EvaluatedValue => {
  if (node.kind === 'literal') return node.value;
  if (node.kind === 'path') return readPath(node.path, state);
  if (node.kind === 'unary') {
    const value = evaluateCompiledNode(node.value, state);
    if (value === MISSING) return MISSING;
    if (node.op === '!') return !value;
    return -(value as number);
  }
  if (node.kind === 'call') {
    const args = node.args.map((arg) => evaluateCompiledNode(arg, state));
    if (args.some((arg) => arg === MISSING)) return MISSING;
    const resolved = args.map(asComparable);
    if (node.name === 'Math.min') return Math.min(...(resolved as number[]));
    if (node.name === 'Math.max') return Math.max(...(resolved as number[]));
    if (node.name === 'Math.abs') {
      if (resolved.length !== 1) {
        throw new DslEvalError(`Math.abs 需要 1 个参数，实际 ${resolved.length}`, node.name);
      }
      return Math.abs(resolved[0] as number);
    }
    throw new DslEvalError(`函数未在白名单: ${node.name}`, node.name);
  }
  if (node.op === '&&') {
    const left = evaluateCompiledNode(node.left, state);
    if (left !== MISSING && !truthy(left)) return false;
    const right = evaluateCompiledNode(node.right, state);
    if (left === MISSING) return right !== MISSING && !truthy(right) ? false : MISSING;
    return right;
  }
  if (node.op === '||') {
    const left = evaluateCompiledNode(node.left, state);
    if (left !== MISSING && truthy(left)) return true;
    const right = evaluateCompiledNode(node.right, state);
    if (left === MISSING) return right !== MISSING && truthy(right) ? true : MISSING;
    return right;
  }
  const left = evaluateCompiledNode(node.left, state);
  const right = evaluateCompiledNode(node.right, state);
  if (node.op === '===' || node.op === '!==') {
    const equal = asComparable(left) === asComparable(right);
    // Explicit comparisons with `undefined` are existence checks, not unknown
    // arithmetic/comparison results. Preserve the legacy DSL contract for
    // expressions such as `indicators.ma60 === undefined` while all other
    // missing operands remain three-valued.
    const explicitUndefinedComparison =
      (left === MISSING && right === undefined) || (right === MISSING && left === undefined);
    if ((left === MISSING || right === MISSING) && !explicitUndefinedComparison) {
      return MISSING;
    }
    return node.op === '===' ? equal : !equal;
  }
  if (node.op === '==' || node.op === '!=') {
    // biome-ignore lint/suspicious/noDoubleEquals: Strategy DSL explicitly supports loose equality.
    const equal = asComparable(left) == asComparable(right);
    const explicitUndefinedComparison =
      (left === MISSING && right === undefined) || (right === MISSING && left === undefined);
    if ((left === MISSING || right === MISSING) && !explicitUndefinedComparison) {
      return MISSING;
    }
    return node.op === '==' ? equal : !equal;
  }
  if (left === MISSING || right === MISSING) return MISSING;
  const a = left as number;
  const b = right as number;
  switch (node.op) {
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '*':
      return a * b;
    case '/':
      return a / b;
    case '%':
      return a % b;
    default:
      throw new DslEvalError(`不支持的运算符: ${node.op}`, node.op);
  }
};

export interface CompiledStrategyExpressionResult {
  readonly status: 'value' | 'missing' | 'error';
  readonly value?: unknown;
  readonly reads: readonly RuleInputFact[];
  readonly missingPaths: readonly string[];
  readonly error?: string;
}

export interface CompiledStrategyExpression {
  readonly referencedPaths: readonly string[];
  evaluate(context: Readonly<Record<string, unknown>>): CompiledStrategyExpressionResult;
}

/** 编译一次并惰性求值；selection/scoring/signal/evidence 共用此安全 AST。 */
export const compileStrategyExpression = (expression: string): CompiledStrategyExpression => {
  const trimmed = expression.trim();
  if (trimmed === '') throw new DslEvalError('表达式为空', expression);
  assertExpressionSafety(trimmed);
  const astExpression = trimmed.replace(TEMPLATE_RE, (_, inner: string) => `(${inner})`);
  const ast = new AstParser(astExpression).parse();
  const referencedPaths = extractExpressionPaths(trimmed);
  return {
    referencedPaths,
    evaluate: (context) => {
      const state: EvaluationState = { context, reads: [], missingPaths: new Set() };
      try {
        const value = evaluateCompiledNode(ast, state);
        if (value === MISSING) {
          return {
            status: 'missing',
            reads: state.reads,
            missingPaths: [...state.missingPaths].sort(),
          };
        }
        return {
          status: 'value',
          value,
          reads: state.reads,
          missingPaths: [...state.missingPaths].sort(),
        };
      } catch (error) {
        return {
          status: 'error',
          reads: state.reads,
          missingPaths: [...state.missingPaths].sort(),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
};

/** 仅做语法检查；字段存在性由 field registry 另行校验。 */
export const assertExpressionSyntax = (expression: string): void => {
  const withoutTemplates = expression.replace(TEMPLATE_RE, (_, inner: string) => {
    evaluateExpression(inner, {});
    return '0';
  });
  evaluateExpression(withoutTemplates, {});
};

/** evidence 普通文本中的每个 `${...}` 必须是合法表达式。 */
export const assertTemplateSyntax = (template: string): void => {
  for (const match of template.matchAll(TEMPLATE_RE)) {
    evaluateExpression(match[1] as string, {});
  }
};

/**
 * 把模板字符串里的 `${expr}` 替换为 evaluateExpression(expr, context) 的字符串结果。
 * 替换失败抛 DslEvalError。
 */
export const interpolate = (template: string, context: CtxObj): string => {
  return template.replace(TEMPLATE_RE, (_, expr: string) => {
    const value = evaluateExpression(expr, context);
    if (value === undefined || value === null) return 'undefined';
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return String(value);
      // 整数去掉小数点，便于模板里嵌入显示
      return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/\.?0+$/, '');
    }
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return String(value);
  });
};

export { InvariantError };
