// M6-WP-02：workflow 脚本 meta 校验（ORC-023/024 行 295 + A 级 workflow 报告 §2.1 L170996）。
//
// 约束（A 级报告 §2.1 L170996 原文口径）：脚本 MUST 以 `export const meta = {...}` 开头；`meta` 值 MUST 是
// **纯字面量**（"no variables, function calls, spreads, or template interpolation"）；必填 `name`/`description`，
// 可选 `whenToUse`/`phases`。
//
// 实现形态 **[自定]**（报告 §12 未解之谜③：`[CC]` 的逐字校验实现未定位）：手写词法 + 递归下降**静态分析**，
// 不引 `typescript` 运行时依赖——`typescript` 只在根 devDependencies（构建期），产品运行时不得依赖它
// （bundle 体积 + 运行时 deps 契约）。静态分析而非运行时取值，因为"变量引用 vs 字面量"在运行时不可区分。
//
// 两处 [自定] 口径（供 V 核验）：
//   ① 整个脚本只允许**一处** `export` 标识符记号且必须是首记号——变换层（把 `export` 抹为等长空白后包 async IIFE）
//      才成立；保守口径同时拒绝把 `export` 当属性名/键名用的写法。
//   ② 未知键**不拒绝**（元数据面向前可扩展）；已知键类型一律严格（name/description 非空字符串、whenToUse 字符串、
//      phases 非空字符串数组）。

export class WorkflowMetaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowMetaError";
  }
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: readonly string[];
  /** 其余纯字面量键原样保留（[自定]②：不拒绝未知键）。 */
  [key: string]: unknown;
}

export interface WorkflowScriptParts {
  meta: WorkflowMeta;
  /** meta 语句之后的脚本正文：`export` 关键字已抹为等长空白（行号与原文逐行对齐），供 vm 包装求值。 */
  body: string;
}

type TokenType = "ident" | "string" | "number" | "template" | "punct" | "eof";

interface Token {
  type: TokenType;
  /** ident/punct=原文；string=反转义后的值；number=原文；template=原文（仅用于拒绝）。 */
  value: string;
  start: number;
  end: number;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

class Lexer {
  private pos = 0;

  constructor(private readonly src: string) {}

  all(): Token[] {
    const out: Token[] = [];
    for (;;) {
      const token = this.next();
      out.push(token);
      if (token.type === "eof") return out;
    }
  }

  private next(): Token {
    this.skipTrivia();
    const start = this.pos;
    if (start >= this.src.length) return { type: "eof", value: "", start, end: start };
    const ch = this.src[start];
    if (ch === '"' || ch === "'") return this.readString(ch);
    if (ch === "`") return this.readTemplate();
    if (ch >= "0" && ch <= "9") return this.readNumber();
    if (IDENT_START.test(ch)) {
      let end = start + 1;
      while (end < this.src.length && IDENT_PART.test(this.src[end])) end++;
      this.pos = end;
      return { type: "ident", value: this.src.slice(start, end), start, end };
    }
    if (this.src.startsWith("...", start)) {
      this.pos = start + 3;
      return { type: "punct", value: "...", start, end: start + 3 };
    }
    this.pos = start + 1;
    return { type: "punct", value: ch, start, end: start + 1 };
  }

  private skipTrivia(): void {
    for (;;) {
      const ch = this.src[this.pos];
      if (ch === undefined) return;
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v") {
        this.pos++;
        continue;
      }
      if (ch === "/" && this.src[this.pos + 1] === "/") {
        const nl = this.src.indexOf("\n", this.pos);
        this.pos = nl === -1 ? this.src.length : nl + 1;
        continue;
      }
      if (ch === "/" && this.src[this.pos + 1] === "*") {
        const close = this.src.indexOf("*/", this.pos + 2);
        this.pos = close === -1 ? this.src.length : close + 2;
        continue;
      }
      return;
    }
  }

  private readString(quote: string): Token {
    const start = this.pos;
    let i = start + 1;
    let raw = "";
    while (i < this.src.length) {
      const ch = this.src[i];
      if (ch === "\\") {
        raw += ch + (this.src[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (ch === quote) {
        this.pos = i + 1;
        return { type: "string", value: unescapeLiteral(raw), start, end: this.pos };
      }
      if (ch === "\n") break;
      raw += ch;
      i++;
    }
    throw new WorkflowMetaError(`meta 校验：字符串字面量未闭合（偏移 ${start}）`);
  }

  private readTemplate(): Token {
    const start = this.pos;
    let i = start + 1;
    while (i < this.src.length) {
      const ch = this.src[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        this.pos = i + 1;
        return { type: "template", value: this.src.slice(start, this.pos), start, end: this.pos };
      }
      i++;
    }
    throw new WorkflowMetaError(`meta 校验：模板字符串未闭合（偏移 ${start}）`);
  }

  private readNumber(): Token {
    const start = this.pos;
    let i = start;
    while (i < this.src.length) {
      const ch = this.src[i];
      if (/[0-9a-fA-FxXoObB._]/.test(ch)) {
        i++;
        continue;
      }
      if ((ch === "+" || ch === "-") && /[eE]/.test(this.src[i - 1] ?? "")) {
        i++;
        continue;
      }
      break;
    }
    this.pos = i;
    return { type: "number", value: this.src.slice(start, i), start, end: i };
  }
}

function unescapeLiteral(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = raw[++i];
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "\t";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "v":
        out += "\v";
        break;
      case "0":
        out += "\0";
        break;
      case "\n":
        break; // 行继续
      case "u": {
        if (raw[i + 1] === "{") {
          const close = raw.indexOf("}", i + 2);
          const hex = close === -1 ? raw.slice(i + 2) : raw.slice(i + 2, close);
          out += String.fromCodePoint(Number.parseInt(hex, 16));
          i = close === -1 ? raw.length : close;
        } else {
          out += String.fromCharCode(Number.parseInt(raw.slice(i + 1, i + 5), 16));
          i += 4;
        }
        break;
      }
      case "x":
        out += String.fromCharCode(Number.parseInt(raw.slice(i + 1, i + 3), 16));
        i += 2;
        break;
      case undefined:
        break;
      default:
        out += next;
        break;
    }
  }
  return out;
}

interface LiteralResult {
  value: unknown;
  next: number;
}

function numberLiteral(token: Token): number {
  const value = Number(token.value);
  if (Number.isNaN(value)) throw new WorkflowMetaError(`meta 必须是纯字面量：非法数字字面量 \`${token.value}\``);
  return value;
}

function parseLiteral(tokens: Token[], start: number, where: string): LiteralResult {
  const token = tokens[start];
  if (!token || token.type === "eof") throw new WorkflowMetaError(`meta 值不完整：\`${where}\` 处以字面量意外结束`);
  if (token.type === "template") {
    throw new WorkflowMetaError(`meta 必须是纯字面量：\`${where}\` 处不允许模板字符串（A 级报告 §2.1 L170996）`);
  }
  if (token.type === "string") return { value: token.value, next: start + 1 };
  if (token.type === "number") return { value: numberLiteral(token), next: start + 1 };
  if (token.type === "ident") {
    if (token.value === "true") return { value: true, next: start + 1 };
    if (token.value === "false") return { value: false, next: start + 1 };
    if (token.value === "null") return { value: null, next: start + 1 };
    if (token.value === "undefined") return { value: undefined, next: start + 1 };
    if (tokens[start + 1]?.value === "(") {
      throw new WorkflowMetaError(
        `meta 必须是纯字面量：\`${where}\` 处不允许函数调用（\`${token.value}(...)\`）——A 级报告 §2.1 L170996`,
      );
    }
    throw new WorkflowMetaError(
      `meta 必须是纯字面量：\`${where}\` 处不允许变量引用（\`${token.value}\`）——A 级报告 §2.1 L170996`,
    );
  }
  if (token.value === "{") return parseObject(tokens, start + 1, where);
  if (token.value === "[") return parseArray(tokens, start + 1, where);
  if (token.value === "...") {
    throw new WorkflowMetaError(`meta 必须是纯字面量：\`${where}\` 处不允许展开语法 \`...\``);
  }
  if (token.value === "(") {
    throw new WorkflowMetaError(`meta 必须是纯字面量：\`${where}\` 处不允许函数调用/括号表达式`);
  }
  if (token.value === "-" || token.value === "+") {
    const inner = tokens[start + 1];
    if (inner && inner.type === "number") {
      const magnitude = numberLiteral(inner);
      return { value: token.value === "-" ? -magnitude : magnitude, next: start + 2 };
    }
    throw new WorkflowMetaError(`meta 必须是纯字面量：\`${where}\` 处不允许一元表达式 \`${token.value}\``);
  }
  throw new WorkflowMetaError(`meta 必须是纯字面量：\`${where}\` 处出现不允许的记号 \`${token.value}\``);
}

function parseObject(tokens: Token[], start: number, where: string): LiteralResult {
  const out: Record<string, unknown> = {};
  let i = start;
  if (tokens[i]?.value === "}") return { value: out, next: i + 1 };
  for (;;) {
    const keyToken = tokens[i];
    if (!keyToken || keyToken.type === "eof") {
      throw new WorkflowMetaError(`meta 对象未闭合（\`${where}\`）`);
    }
    if (keyToken.value === "...") {
      throw new WorkflowMetaError(`meta 必须是纯字面量：\`${where}\` 处不允许展开语法 \`...\``);
    }
    if (keyToken.value === "[") {
      throw new WorkflowMetaError(`meta 必须是纯字面量：\`${where}\` 处不允许计算属性名`);
    }
    let key: string;
    if (keyToken.type === "ident") key = keyToken.value;
    else if (keyToken.type === "string") key = keyToken.value;
    else if (keyToken.type === "number") key = keyToken.value;
    else throw new WorkflowMetaError(`meta 对象键不合法：\`${where}\` 处出现 \`${keyToken.value}\``);
    if (tokens[i + 1]?.value !== ":") {
      throw new WorkflowMetaError(`meta 对象键 \`${key}\` 后缺少 \`:\`（\`${where}\`）`);
    }
    const parsed = parseLiteral(tokens, i + 2, `${where}.${key}`);
    out[key] = parsed.value;
    i = parsed.next;
    const sep = tokens[i]?.value;
    if (sep === ",") {
      i++;
      if (tokens[i]?.value === "}") return { value: out, next: i + 1 };
      continue;
    }
    if (sep === "}") return { value: out, next: i + 1 };
    if (sep === undefined || tokens[i]?.type === "eof") {
      throw new WorkflowMetaError(`meta 对象未闭合（\`${where}\`）`);
    }
    throw new WorkflowMetaError(`meta 对象缺少 \`,\` 或 \`}\`（\`${where}\`）`);
  }
}

function parseArray(tokens: Token[], start: number, where: string): LiteralResult {
  const out: unknown[] = [];
  let i = start;
  if (tokens[i]?.value === "]") return { value: out, next: i + 1 };
  for (;;) {
    const parsed = parseLiteral(tokens, i, `${where}[${out.length}]`);
    out.push(parsed.value);
    i = parsed.next;
    const sep = tokens[i]?.value;
    if (sep === ",") {
      i++;
      if (tokens[i]?.value === "]") return { value: out, next: i + 1 };
      continue;
    }
    if (sep === "]") return { value: out, next: i + 1 };
    if (sep === undefined || tokens[i]?.type === "eof") {
      throw new WorkflowMetaError(`meta 数组未闭合（\`${where}\`）`);
    }
    throw new WorkflowMetaError(`meta 数组缺少 \`,\` 或 \`]\`（\`${where}\`）`);
  }
}

/** 解析并校验脚本的 meta 段；失败抛 WorkflowMetaError（消息含具体拒绝理由）。 */
export function parseWorkflowMeta(script: string): WorkflowScriptParts {
  const tokens = new Lexer(script).all();
  const first = tokens[0]!;
  if (first.type !== "ident" || first.value !== "export") {
    throw new WorkflowMetaError(
      "workflow 脚本必须以 `export const meta = {...}` 开头（A 级报告 §2.1 L170996：每个脚本以 export const meta 开头）",
    );
  }
  const exportTokens = tokens.filter((t) => t.type === "ident" && t.value === "export");
  if (exportTokens.length !== 1) {
    throw new WorkflowMetaError(
      "workflow 脚本只允许 `export const meta` 一处 `export`（[自定]①：变换层只抹首个 export，其余 export 一律拒绝）",
    );
  }
  if (tokens[1]?.value !== "const" || tokens[2]?.value !== "meta" || tokens[3]?.value !== "=") {
    throw new WorkflowMetaError("workflow 脚本首句必须是 `export const meta = <纯字面量>`（A 级报告 §2.1 L170996）");
  }
  const parsed = parseLiteral(tokens, 4, "meta");
  if (parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    throw new WorkflowMetaError("meta 值必须是对象字面量（A 级报告 §2.1 L170996）");
  }
  const meta = parsed.value as Record<string, unknown>;
  assertMetaShape(meta);
  const body = `${script.slice(0, first.start)}${" ".repeat(first.end - first.start)}${script.slice(first.end)}`;
  return { meta: meta as WorkflowMeta, body };
}

function assertMetaShape(meta: Record<string, unknown>): void {
  if (typeof meta.name !== "string" || meta.name.length === 0) {
    throw new WorkflowMetaError("meta 必填 `name`（非空字符串字面量）——A 级报告 §2.1 L170996");
  }
  if (typeof meta.description !== "string" || meta.description.length === 0) {
    throw new WorkflowMetaError("meta 必填 `description`（非空字符串字面量）——A 级报告 §2.1 L170996");
  }
  if (meta.whenToUse !== undefined && typeof meta.whenToUse !== "string") {
    throw new WorkflowMetaError("meta 可选 `whenToUse` 必须是字符串字面量");
  }
  if (meta.phases !== undefined) {
    if (!Array.isArray(meta.phases) || meta.phases.some((p) => typeof p !== "string" || p.length === 0)) {
      throw new WorkflowMetaError("meta 可选 `phases` 必须是非空字符串数组字面量");
    }
  }
}
