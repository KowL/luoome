import { InvariantError } from '../error/index.js';

/**
 * 战法 DSL mini-eval（plan-v0.2-v0.3 §2.4）。
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
const resolvePath = (segments: readonly string[], ctx: CtxObj): unknown => {
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
    left = Boolean(left) || Boolean(parseAnd(c, ctx));
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
    return resolvePath(segs, ctx);
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
