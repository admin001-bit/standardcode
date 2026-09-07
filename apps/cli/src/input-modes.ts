// L0 输入四模式解析（v2.8 §8.1：Prompt 默认 / Shell 行首 `!` / @file 引用 / 斜杠命令；剪贴板 Ctrl+V 属 UI 层非解析）。
export type ParsedInput =
  | { kind: "prompt"; text: string }
  | { kind: "shell"; command: string }
  | { kind: "file"; path: string; rest: string }
  | { kind: "slash"; name: string; args: string };

export function parseInput(line: string): ParsedInput {
  if (line.startsWith("!")) return { kind: "shell", command: line.slice(1).trim() };
  if (line.startsWith("@")) {
    const m = /^@(\S*)(?:\s+([\s\S]*))?$/.exec(line);
    return { kind: "file", path: m?.[1] ?? "", rest: m?.[2] ?? "" };
  }
  if (line.startsWith("/")) {
    const m = /^\/(\S*)(?:\s+([\s\S]*))?$/.exec(line);
    return { kind: "slash", name: m?.[1] ?? "", args: m?.[2] ?? "" };
  }
  return { kind: "prompt", text: line };
}
