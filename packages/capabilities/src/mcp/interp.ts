// ${VAR}/${VAR:-default} 环境变量插值（CS() 形状，dig-05 §2.1 :104973-104995）。
// stdio command/args/env 值与 sse/http url/headers 值均展开；未解析且无缺省=保留字面+告警（[自定] 严格化：
// 拒绝展开为空串静默吞键——空值让下游 UNCONFIGURED/INVALID 判定失真，字面保留使失败可诊断）。

const INTERP_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export interface InterpResult {
  value: string;
  /** 未解析（无 default 且 env 缺席）的变量名，按出现序。 */
  unresolved: string[];
}

export function interpolateEnv(input: string, env: NodeJS.ProcessEnv): InterpResult {
  const unresolved: string[] = [];
  const value = input.replace(INTERP_RE, (whole, name: string, def?: string) => {
    const v = env[name];
    if (v !== undefined) return v;
    if (def !== undefined) return def;
    unresolved.push(name);
    return whole;
  });
  return { value, unresolved };
}
