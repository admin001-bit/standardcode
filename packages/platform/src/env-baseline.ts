// WP-08（M4）：SEC-080 env 基线剥离共享最小实现（platform 侧——ARCH-001 分层，不依赖 executor 的
// sanitizeToolEnv；规则集对位 executor/src/env.ts 缺省基线，自 WP-09 installer 就地实现提取共享 [自定]）。
// 消费者：plugin/installer.ts（git clone 子进程）+ updater.ts（npm 子进程，DoD①"清洗同面"）。
export const ENV_BASELINE_STRIP = /^(STANDARD_CODE_.*|.*_KEY|.*_TOKEN|.*_SECRET|GIT_CONFIG_.*|NODE_OPTIONS|BASH_ENV|ENV)$/;

/** 剥离 SECRET/KEY/TOKEN/STANDARD_CODE_* 等基线键（就地新建对象，不改源）。 */
export function stripEnvBaseline(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) if (!ENV_BASELINE_STRIP.test(k)) out[k] = v;
  return out;
}
