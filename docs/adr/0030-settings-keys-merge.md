# ADR-0030: settings 键位全集与合并语义（M2，v2.8 §13 行 3 处置）

- 状态：已接受（2026-09-08，M2-WP-01）
- 规格处置：v2.8 §13 行 3（settings 键位全集：`STANDARD_CODE_*` 与 settings.json 键位表 → M2 设计）；消费 §7.7 合并序实证段、§9.1 Q-2/Q-3 落盘布局。

## 决策

1. **两族键位**：
   - **settings.json 族**（层级文件内，嵌套对象）：`schemaVersion`（信封，ENG-080）、`permissions.{allow,deny,ask}`（列表）、`additionalDirectories`（列表）、`providers.openai.models`（列表）、`providers.{anthropic,openai}.baseUrl`、`providers.default`、`model.default`、`memory.precedence`（MEM-044）、`memory.autoRead`（MEM-042/043）、`env.<NAME>`（注入进程 env）。M2 各卡消费到哪个键、该键即随卡进入实现；本 ADR 登记键位命名空间与语义，**不做前向虚构全集**。
   - **`STANDARD_CODE_*` env 族**（§7.7 MDL-010~013 保留通道）：`STANDARD_CODE_MODEL` / `STANDARD_CODE_MODELS` / `STANDARD_CODE_PROVIDER` / `STANDARD_CODE_BASE_URL` / `STANDARD_CODE_SHELL` / `STANDARD_CODE_RIPGREP_PATH` / `STANDARD_CODE_AUTOCOMPACT_PCT_OVERRIDE`（WP-03 落地，v2.8 §7.2 原文名）/ `STANDARD_CODE_AUTO_COMPACT_WINDOW`（WP-03，值形 `auto`|`200k`|`1m`|数字≥100 视为 k）/ `STANDARD_CODE_DISABLE_AUTO_COMPACT`（WP-03）/ `STANDARD_CODE_THINKING`（WP-06，值形 `adaptive` | `budget` | `budget:<tokens>` | `off`）。
   - settings 族增补（WP-06 消费）：`model.thinking`（值形同上，env 逃逸舱同名覆盖）。settings 族增补（WP-03 消费）：`autocompact.enabled`（默认 true）/ `autocompact.window`（值形同 env）/ `autocompact.pct`。
2. **合并语义**：叶子键最高来源胜出（自末尾遍历首中即返，_704.js 同构）；**列表键跨层合并**（高→低拼接去重）；`env.*` 键注入进程 env 后**粘滞**——进程存活期不可 unset（省略/null 均不解除），同键更新允许（§7.7 原文的可操作化）。
3. **managed 路径 Linux 档**：Q-3 只给 Windows/macOS，Linux 取 `/etc/standardcode/managed-settings.json`（POSIX 系统级配置惯例）`[自定]`。
4. **容错**：坏 JSON / schemaVersion 不符 → 该来源跳过 + 告警，启动不拒（企业下发坏文件不应瘫痪 CLI，fail-open 限单文件、fail-closed 限安全语义——安全键消费方各自校验）。

## 影响的相邻机制

- `packages/platform/src/settings.ts`：实现落点；apps/cli session 装配消费（env 直读清偿点）。
- WP-03（窗口解析链的 settings 来源）、WP-07（permissions.* 列表键落盘格式）、WP-11（/config 展示合并序）。
- §12.5 差异登记：粘滞语义为 [CC] "不可 unset" 的实现口径（[CC] 源码未展示更新/解除分支细节），本 ADR 显式化。

## 参考

- v2.8 §7.7（五来源顺序+列表键跨层合并+注入 env 不可 unset，`_704.js` 锚点）、§9.1（Q-2/Q-3）、§13 行 3、ENG-080。
- B 级 `claude-code-research.md` §13（顺序已经源码复核，§7.7 标注）。
