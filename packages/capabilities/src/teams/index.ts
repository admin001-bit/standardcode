// M6-WP-06：Teams 消息面导出（DoD② 直接载体）。
// 本卡范围=消息泵（五事件分发）+ SendMessage 工具（schema/失败分类/协议白名单）+ teammate 提示词附录与层级限制。
// 成员命名与保留名/文件 mailbox/通讯录=WP-07；shutdown/plan approval 协议消息生成与处理链=WP-08；
// 团队共享任务系统=WP-09。消息泵的跨 teammate 持久化载体（文件 mailbox）由 WP-07 提供，本卡只交付投递口消费面。
export * from "./events.ts";
export * from "./send-message.ts";
export * from "./prompt.ts";
