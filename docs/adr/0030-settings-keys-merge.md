# ADR-0030: settings 键位全集与合并语义（M2，v2.8 §13 行 3 处置）

- 状态：已接受（2026-09-08，M2-WP-01）
- 规格处置：v2.8 §13 行 3（settings 键位全集：`STANDARD_CODE_*` 与 settings.json 键位表 → M2 设计）；消费 §7.7 合并序实证段、§9.1 Q-2/Q-3 落盘布局。

## 决策

1. **两族键位**：
   - **settings.json 族**（层级文件内，嵌套对象）：`schemaVersion`（信封，ENG-080）、`permissions.{allow,deny,ask}`（列表）、`additionalDirectories`（列表）、`providers.openai.models`（列表）、`providers.{anthropic,openai}.baseUrl`、`providers.default`、`model.default`、`memory.precedence`（MEM-044）、`memory.autoRead`（MEM-042/043）、`env.<NAME>`（注入进程 env）。M2 各卡消费到哪个键、该键即随卡进入实现；本 ADR 登记键位命名空间与语义，**不做前向虚构全集**。
   - **`STANDARD_CODE_*` env 族**（§7.7 MDL-010~013 保留通道）：`STANDARD_CODE_MODEL` / `STANDARD_CODE_MODELS` / `STANDARD_CODE_PROVIDER` / `STANDARD_CODE_BASE_URL` / `STANDARD_CODE_SHELL` / `STANDARD_CODE_RIPGREP_PATH` / `STANDARD_CODE_AUTOCOMPACT_PCT_OVERRIDE`（WP-03 落地，v2.8 §7.2 原文名）/ `STANDARD_CODE_AUTO_COMPACT_WINDOW`（WP-03，值形 `auto`|`200k`|`1m`|数字≥100 视为 k）/ `STANDARD_CODE_DISABLE_AUTO_COMPACT`（WP-03）/ `STANDARD_CODE_THINKING`（WP-06，值形 `adaptive` | `budget` | `budget:<tokens>` | `off`）/ `STANDARD_CODE_UPDATE_SOURCE`（M8-WP-06 增补，2026-09-26；值形 `npm` | `github`，trim+小写归一；缺省 `npm`；非法值=fail-closed 不静默回落；消费点 `apps/cli/src/repl.ts` 的 `updateNow`＝手动 `/update` 源选择，规格见 ADR-0053）/ `STANDARD_CODE_AUTO_UPDATE`（**M8-WP-10 补登**，2026-09-26〔承 M8-WP-06 V 的 D-V1 同族缺口——本键为 M4-WP-08 既有消费，键位表漏登〕；值形＝字面 `1` 启用、其余值取严视为关〔[自定]〕；未设＝零请求（缺省关）；消费点 `apps/cli/src/repl.ts` 的 `startAutoUpdateCheck`；常量 `packages/platform/src/updater.ts:20` `AUTO_UPDATE_ENV_KEY`）。
   - settings 族增补（WP-06 消费）：`model.thinking`（值形同上，env 逃逸舱同名覆盖）。settings 族增补（WP-03 消费）：`autocompact.enabled`（默认 true）/ `autocompact.window`（值形同 env）/ `autocompact.pct`。
   - settings 族增补（M6-WP-01 消费）：`experimental.enabled`（默认关；布尔字面 `true` 才开，非布尔=fail-closed）、`experimental.flags`（字符串数组白名单，已知名 `workflow`/`teams`/`fork`；未登记 LIST_KEYS⇒不分层合并、最高来源胜出 `[自定]`）。env 族增补（M6-WP-01）：`STANDARD_CODE_EXPERIMENTAL`（值形 `1`/`true`/`yes`/`on` 与 `0`/`false`/`no`/`off`；逃逸舱**凌驾** settings，非法非空值=fail-closed 不回退）。
   - settings 族增补（M7-WP-03 消费）：`ui.theme`（值形枚举字符串 `plain`|`light`|`dark`；层=local，命令行/共享/user 不消费；缺省=`plain` 零 ANSI；非法值=fail-closed 不回退；自定义主题文件格式=[自定] 留白不做）。读侧由 `apps/cli/src/theme.ts` 的 `themeFromSettings(loaded)` 单源解析（重启恢复入口）。
   - settings 族增补（M7-WP-04 消费）：`ui.keybindings`（值形=对象 `action -> key spec`，键集限于可绑动作全集 `permission.cycle`；key spec 形如 `shift+tab`/`ctrl+b`，**多键序 chord 不支持**；层=local；缺省=`{ "permission.cycle": "shift+tab" }`〔承 EXE-001 既有硬键位〕；未知动作/非法键位/同一键绑两动作=fail-closed 抛错不回退）。读侧由 `apps/cli/src/keybindings.ts` 的 `keybindingsFromSettings(loaded)` 单源解析（重启恢复入口）；键事件面（main.ts）只消费该单源表，不再内联硬编码键位。
   - settings 族增补（M7-WP-06 消费）：`sandbox.enabled`（布尔；层=local；缺省=不启用）、`sandbox.tier`（值形枚举字符串 `read-only`|`workspace-write`|`danger-full-access`；层=local；缺省=`workspace-write`；非法值=fail-closed 不启用）。两键均为**点路径标量键**（WP-04 实测：本仓装配把嵌套对象展开为点路径叶子，对象值取不到）。读侧由 `apps/cli/src/sandbox-config.ts` 的 `resolveSandboxSettings` 单源解析（启动装配与 `/sandbox` 命令面共用，不另立第二套判定）；env 逃逸舱 `STANDARD_CODE_SANDBOX`/`STANDARD_CODE_SANDBOX_TIER` 凌驾 settings；`/sandbox on` 时后端二进制缺席=fail-closed 拒绝且不落盘。
2. **合并语义**：叶子键最高来源胜出（自末尾遍历首中即返，_704.js 同构）；**列表键跨层合并**（高→低拼接去重）；`env.*` 键注入进程 env 后**粘滞**——进程存活期不可 unset（省略/null 均不解除），同键更新允许（§7.7 原文的可操作化）。
3. **managed 路径 Linux 档**：Q-3 只给 Windows/macOS，Linux 取 `/etc/standardcode/managed-settings.json`（POSIX 系统级配置惯例）`[自定]`。
4. **容错**：坏 JSON / schemaVersion 不符 → 该来源跳过 + 告警，启动不拒（企业下发坏文件不应瘫痪 CLI，fail-open 限单文件、fail-closed 限安全语义——安全键消费方各自校验）。

## 实验 flag→命令映射表（M7-WP-07 增补；[自定] 登记）

- M6-WP-01 落 `experimental.enabled`/`experimental.flags`/`STANDARD_CODE_EXPERIMENTAL`（见决策 1 第 12 行）。本段补该三键的**门消费面**：flag→命令名映射（实现点 `apps/cli/src/experimental-gate.ts` 的 `EXPERIMENTAL_FLAG_COMMANDS`），与键位合并语义正交（键位归本 ADR，映射归实验门，二者经 `resolveExperimental` 判定衔接）。
- 映射表（CLI_COMMANDS 守恒 35 不变；默认关=全部命令零注册）：

| flag | 注册表命令面（`EXPERIMENTAL_FLAG_COMMANDS`） | 工具面（`EXPERIMENTAL_FLAG_TOOLS`） | 备注 |
| --- | --- | --- | --- |
| `workflow` | `workflows`、`batch`、`loop` | （无） | M7-WP-07 增 `batch`/`loop`（M6 仅 `workflows`） |
| `fork` | `fork`、`export`、`branch` | （无） | M7-WP-07 增 `branch`（M6 仅 `fork`/`export`） |
| `teams` | （无斜杠命令面） | `SendMessage` | `teams:[]`；`/btw` 为 teams 侧信道命令，恒不注册（见 `EXPERIMENTAL_SIDECHANNEL_COMMANDS`） |

- 语义归属与差异（计数制/逐行制/侧信道/分支复制）见 mini-ADR-0049；本 ADR 只落"键位→映射"登记，不重复语义。

## 影响的相邻机制

- `packages/platform/src/settings.ts`：实现落点；apps/cli session 装配消费（env 直读清偿点）。
- WP-03（窗口解析链的 settings 来源）、WP-07（permissions.* 列表键落盘格式）、WP-11（/config 展示合并序）。
- §12.5 差异登记：粘滞语义为 [CC] "不可 unset" 的实现口径（[CC] 源码未展示更新/解除分支细节），本 ADR 显式化。

## 参考

- v2.8 §7.7（五来源顺序+列表键跨层合并+注入 env 不可 unset，`_704.js` 锚点）、§9.1（Q-2/Q-3）、§13 行 3、ENG-080。
- B 级 `claude-code-research.md` §13（顺序已经源码复核，§7.7 标注）。
