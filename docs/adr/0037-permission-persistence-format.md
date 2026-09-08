# ADR-0037: 权限规则持久化格式（M2，v2.8 §13 行 4 处置）

- 状态：已接受（2026-09-09，M2-WP-07）
- 规格处置：v2.8 §13 行 4「权限规则持久化格式："总是允许"落 local 层已定（§8.3）；余'settings.local.json 内键位格式'待 M2 设计」；§8.3 L379「持久化：'本次允许/总是允许'——总是允许只落 local 层（`.standardcode/settings.local.json`）」。

## 决策

1. **载体=既有 settings.local.json（非旁路文件）**："总是允许"追加进 `.standardcode/settings.local.json` 的 `permissions.allow` 列表——持久化规则与静态规则**同一消费通道**（五来源合并→broker 构造期清洗），不新建平行存储。
2. **格式**：`{ "schemaVersion": 1, "permissions": { "allow": ["Bash(git status)", ...] } }`——规则串=`Tool(specifier)` 语法（§8.3 原文），与 ADR-0030 键位全集一致；列表去重追加；写侧读现有文件合并而非覆盖（坏 JSON 抛错不覆盖=写侧保守，与读侧 fail-open 相异并有意如此）。
3. **写入者**：确认 UI 的"总是允许"选择（apps/cli confirm.ts）；`persistAlwaysAllow`（platform）为唯一写函数。
4. **schemaVersion=1**（ENG-080）；与 settings 读侧既有版本门一致。

## 锚点与理由

- [CC] 先例：允许规则落用户/项目 settings 的 permissions.allow 数组（dig-02 §2.3 allowRules 侧 chunk-3sdc4pj4）；[CC] local 层=settings.local.json（B 级 internals 报告 L68）。
- 键位格式无 [CC] 逐字锚点（[CC] 无"本次/总是"二段确认的本地落盘形态可考）→ 本决策 [自定] 部分仅"追加式去重+坏文件不覆盖"两点，载体与键位均循既有锚点。

## 影响的相邻机制

- settings.ts LIST_KEYS 已含 permissions.allow（M1 WP-01）——追加即生效，无合并序新义；
- broker.addAllow（harness，运行时即时生效）+persistAlwaysAllow（platform，落盘跨会话）由 confirm UI 协同调用；
- 信任门控（trust.ts）：local 未被 git 跟踪免信任（细则）——"总是允许"写入 local 天然免信任面，符合 §8.3「settings.local.json 未被 git 跟踪时免信任」。

## 参考

- v2.8 §13 行 4、§8.3 L379-380、§12.4 ENG-080；dig-02 §2.1/§2.3（A 级）；B 级 claude_code_internals_deepdive.md L68（已复核标注）。
