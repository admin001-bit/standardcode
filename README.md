# StandardCode

StandardCode 是一款模型无关、上下文精简、功能透明、生产级的开源 CLI 编程代理工具。

## 版本策略

- GA 前版本号为 0.x。
- minor 版本对应里程碑：每完成一个里程碑，minor 加一。

## 实验特性（experimental）

Teams / workflow 是**独立实验子项目**（ORC-050）：**发布默认关闭**——未开启时相关斜杠命令不注册、工具面零新增、无任何遥测事件。开启路径（生效序：env 逃逸舱 > settings）：环境变量 `STANDARD_CODE_EXPERIMENTAL=1`，或 settings `experimental.enabled: true`；可用 `experimental.flags` 白名单收窄（已知名 `workflow` / `teams` / `fork`）。实验特性 API/行为可在不发 major 的情况下变更，勿用于生产关键路径。
