// M6-WP-06：Teams 消息面导出（DoD② 直接载体）。
// 本卡范围=消息泵（五事件分发）+ SendMessage 工具（schema/失败分类/协议白名单）+ teammate 提示词附录与层级限制。
// M6-WP-07 增：团队/成员注册表与命名校验（roster）+ 文件 mailbox（inbox schema 校验与告警）+ 通讯录寻址与
// to:"main" 路由落点；shutdown/plan approval 协议消息生成与处理链=WP-08；团队共享任务系统=WP-09。
export * from "./events.ts";
export * from "./send-message.ts";
export * from "./prompt.ts";
export * from "./roster.ts";
export * from "./mailbox.ts";
export * from "./protocol.ts";
export * from "./runner.ts";
// M6-WP-09：共享任务看板（接缝⑲；**新增文件**，teams 七件一行未改）+ 停止 worker 续聊恢复。
export * from "./task-board.ts";
export * from "./worker-resume.ts";
