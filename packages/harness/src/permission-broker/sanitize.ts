// WP-07 规则清洗补齐（M1 WP-08 偏差③/跑偏②闭环；dig-02 §2.1/§2.2 A 级锚点，[CC] chunk-4svxqcrq.js 美化版
// :649-748 自测转写——pi 集合实测 65 项、包装器集合实测 30 项，与 dig-02 正文所记"61/约 31"的差值已按完整
// 枚举纪律以源码实测为准登记，见结果页 §WP-07）。
// 清洗范围=allow 侧（deny/ask 侧宽——[CC] 语义：通配/形状限制均为 allow 侧收紧）。

/** mi 段式形状（chunk-4svxqcrq 美化版 :670-674 逐字转写）：路径段或 --flag 形。 */
export const SPECIFIER_SEGMENT_RE =
  /^(?:(?:\.\/)?[A-Za-z0-9_.@*+][A-Za-z0-9_.@*+:~-]*(?:\/[A-Za-z0-9_.@*+][A-Za-z0-9_.@*+:~-]*)*\/?|-{1,2}(?:[A-Za-z0-9][A-Za-z0-9_.-]*)?)$/;

/** pi 网络命令白名单（实测 65 项）。 */
export const NETWORK_COMMANDS: ReadonlySet<string> = new Set([
  "curl", "wget", "nc", "ncat", "netcat", "telnet", "ssh", "scp", "sftp", "rsync", "ping", "ping6", "traceroute",
  "dig", "nslookup", "host", "socat", "psql", "mysql", "redis-cli", "mongosh", "ftp", "http", "https", "xh", "nmap",
  "mtr", "mosh", "grpcurl", "websocat", "aria2c", "w3m", "lynx", "whois", "iwr", "irm", "invoke-webrequest",
  "invoke-restmethod", "test-netconnection", "tnc", "test-connection", "resolve-dnsname", "pg_dump", "pg_dumpall",
  "pg_restore", "pg_isready", "createdb", "dropdb", "mysqldump", "mysqladmin", "mariadb", "mariadb-dump", "mongo",
  "mongodump", "mongorestore", "mongoexport", "mongoimport", "redis-benchmark", "pgcli", "mycli", "mysqlsh",
  "clickhouse-client", "mongostat", "mongotop", "mongofiles",
]);

/** gn 包装器/前缀集合（实测 30 项）——Ee() 穿透找真正网络命令。 */
export const WRAPPER_PREFIXES: ReadonlySet<string> = new Set([
  "sudo", "doas", "env", "time", "timeout", "gtimeout", "watch", "xargs", "command", "builtin", "exec", "nohup",
  "nice", "caffeinate", "setsid", "stdbuf", "ionice", "chrt", "strace", "unbuffer", "sshpass", "proxychains",
  "proxychains4", "torsocks", "tsocks", "taskset", "numactl", "setpriv", "flock", "runuser",
]);

/** 穿透包装器前缀找命令首词（dig-02 §2.2 Ee() 语义）。 */
export function unwrapCommandHead(tokens: string[]): string | null {
  let i = 0;
  while (i < tokens.length && WRAPPER_PREFIXES.has(tokens[i]!)) i++;
  return tokens[i] ?? null;
}

/**
 * rooted/home 锚定拒绝（dig-02 §2.1：Hi(r) 判 machine/home 且方向 allow → rooted 拒绝——allow 不能锚定全机/家目录）：
 * 盘符绝对路径、`/` 开头绝对路径、`..` 段、`~`/`~user` 形态。
 */
export function isRootedSpecifier(specifier: string): boolean {
  const s = specifier.trim();
  if (/^[A-Za-z]:/.test(s)) return true; // Windows 盘符
  if (s.startsWith("/") || s.startsWith("\\")) return true; // 绝对路径
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\") || /^~[A-Za-z0-9_-]/.test(s)) return true; // 家目录/其他用户
  const segs = s.split(/[\\/]/);
  return segs.includes(".."); // 越目录上跳
}

/** mi 段式形状校验（WP-07 切片：路径类 specifier 逐段过 mi；网络命令参数段同源——[自定] 保守切片登记）。 */
export function matchesSegmentShape(specifier: string): boolean {
  const segs = specifier.split("/");
  return segs.every((seg) => seg === "" ? true : SPECIFIER_SEGMENT_RE.test(seg));
}

export interface SanitizeFinding {
  ok: boolean;
  reason?: string;
}

/**
 * allow 规则 specifier 清洗（三件，任一命中即 invalid）：
 * ① rooted/home 锚定拒绝；
 * ② 网络命令白名单：Bash specifier 穿透包装器后首词 ∈ NETWORK_COMMANDS → 其余部分（参数段）逐段过 mi（`*` 通配段合法）；
 * ③ 段式形状校验：路径类 specifier（含 `/`）逐段过 mi。
 */
export function sanitizeAllowSpecifier(tool: string, specifier: string): SanitizeFinding {
  if (isRootedSpecifier(specifier)) {
    return { ok: false, reason: `allow rule may not anchor machine/home paths (rooted): ${tool}(${specifier})` };
  }
  if (specifier.includes("/")) {
    if (!matchesSegmentShape(specifier)) {
      return { ok: false, reason: `allow rule specifier fails segment shape (mi): ${tool}(${specifier})` };
    }
  }
  if (tool === "Bash") {
    const tokens = specifier.split(/\s+/).filter(Boolean);
    const head = unwrapCommandHead(tokens);
    if (head !== null && NETWORK_COMMANDS.has(head.toLowerCase())) {
      const args = tokens.slice(tokens.indexOf(head) + 1);
      for (const a of args) {
        if (a === "*" || a === "**") continue; // 通配段合法（`Bash(curl *)` 先例形态）
        if (!SPECIFIER_SEGMENT_RE.test(a)) {
          return { ok: false, reason: `network command allow args must match segment shape (mi): ${tool}(${specifier})` };
        }
      }
    }
  }
  return { ok: true };
}
