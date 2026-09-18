// M6-WP-09：团队共享任务看板（owner/status/blockedBy）——注册表字段的**共享读写仲裁层**。
//
// 依据：v2.8 ORC-040~042（行 296：任务注册表 + 结果回传防伪造）、ORC-032（行 297 任务面板语义）；
// 边界 BLK-08=①：**复用 M3 既有任务注册表与 /tasks 面并扩展 owner/status/blockedBy，对外工具集零增量**
// （本文件系 teams 目录下**新增第 8 个文件**——七件（events/send-message/prompt/roster/mailbox/
// protocol/runner）一行未改，零回退）。
//
// 逐字锚点（`_440.js`，均在 `D:\StandardCode\evidence\claude-src-extracted\_440.js` 取行核对）：
//   §8.2（A 级）：「Your work is coordinated through the task system」——**任务列表是团队共享工作看板；
//     消息工具负责通知，任务工具负责状态**（接缝⑲ 的分工出处）。
//   L190966-190968：TaskCreate 初始形 `status:"pending", owner: void 0, blocks: [], blockedBy: []`。
//   L191027-191031：TaskGet 输出 `status: 'pending'|'in_progress'|'completed'` + blocks + blockedBy。
//   L191035：`- After fetching a task, verify its blockedBy list is empty before beginning work.`
//   L191478：`2. Look for tasks with status 'pending', no owner, and empty blockedBy`（可认领条件）。
//   L191500-191501：`- **owner**: Agent ID if assigned, empty if available` /
//        `- **blockedBy**: List of open task IDs that must be resolved first (…cannot be claimed until dependencies resolve)`
//   L191526-191528：TaskList outputSchema `status` / `owner: I().optional()` / `blockedBy: Me(I())`。
//   L191577-191578：`blockedBy: i.blockedBy.filter((a) => !o.has(a))`（`o`=completed 集）——**open 依赖的程序化定义**。
//   L191597：渲染形 `#${id} [${status}] ${subject}${owner?' (owner)':''}${blockedBy?' [blocked by #…]':''}`。
//
// [自定] 口径（供 V 核验）：
//   ① **不引入 [CC] 的 `pending` 态**：`pending` 在本仓无对应态（本仓 running=已注册执行中），引入必改既有
//      `/tasks` 面板语义（违反边界）。映射登记：pending ↔ 未设 owner 且 open 依赖为空且 status==="running"；
//      in_progress ↔ running 且已设 owner；completed ↔ running 之外（含 failed——**本仓 failed 也是终态**，
//      [CC] 无 failed，故 open 判定以"非终态"为准而非仅排除 completed，见 ③）。
//   ② **团队共享 = 所有已注册成员可读可写，无 per-member ACL**（卡 §6.3）；身份用 `actor`：必须在 roster
//      可寻址集内，否则**拒绝并点名**（fail-closed，禁静默成功或静默回落）。
//   ③ open 依赖过滤：**终态（completed/failed）视为已消解**（L191578 只滤 completed；本仓 failed 亦不可再等待，
//      [自定] 并入）；**被逐出的 taskId 视为已消解**——逐出只发生在终态之后（task-registry `settle` 的
//      evict 链），而非终态删除面只有 `remove()`（槽竞态清理，运行前），故缺席=已终态而非悬空。
//   ④ `owner` 可取值=roster 可寻址集（成员名/agentId + "main" + lead 别名）——L191500「Agent ID if assigned」
//      的成员系版本；agentId 与成员名两种写法都收。
//   ⑤ 写入侧界线（接缝⑲）：**本文件不 import mailbox/message 面**，写入只经注册表 `setOwner/setBlockedBy`
//      （其 emit `updated` 进程内事件——事件≠消息：不落 mailbox、不进消息泵），状态变更**零消息**；
//      反向同理（收消息不改任务字段）——双向举证见 `packages/capabilities/test/wp09-teams-task-board.test.ts`。
//   ⑥ 悬空 `blockedBy` 引用=拒绝并点名（卡 §6.2），不静默忽略。
//   ⑦ 列名映射：TaskList/TaskGet 的外部列名 `subject`（L191498/L191027）↔ 本仓既有列名 `description`；
//      视图面给 `subject`（便于对齐 [CC]），底层字段名一字不改（零回归）。

import type { TaskRegistry } from "@standardcode/harness";
import type { TeamRoster } from "./roster.ts";

/** [自定]②：未知/未注册地址的写入者拒绝文案模板。 */
export function taskBoardUnknownActor(actor: string): string {
  return `shared task board: unknown actor \`${actor}\` (not in the team roster's addressable set — only registered teammates may read or write the shared board)`;
}

/** [自定]⑥：悬空依赖拒绝文案模板（ offenders 逐个点名）。 */
export function taskBoardDanglingBlockedBy(taskId: string, offenders: readonly string[]): string {
  return (
    `shared task board: task \`${taskId}\` has blockedBy references to tasks that do not exist: ` +
    `${offenders.map((o) => `\`${o}\``).join(", ")} (every blockedBy entry must resolve to a registered task — dangling references are rejected, never silently dropped)`
  );
}

/** 未知 taskId（[自定]：原语返回 false，本层点名）。 */
export function taskBoardUnknownTask(taskId: string): string {
  return `shared task board: unknown task \`${taskId}\` (no such task in the registry)`;
}

/** [自定]①：不可认领（已有 owner 或依赖未清空）文案模板。 */
export function taskBoardNotClaimable(taskId: string, owner: string | undefined, open: readonly string[]): string {
  const why = owner !== undefined ? `already claimed by \`${owner}\`` : `blocked by ${open.map((o) => `\`${o}\``).join(", ")}`;
  return `shared task board: task \`${taskId}\` is not claimable — ${why} (claim requires no owner and an empty open blockedBy list)`;
}

/** 看板一行视图（TaskList 面；[CC] L191527-191528 字段形 + L191578 open 过滤语义）。 */
export interface TaskBoardRow {
  taskId: string;
  /** TaskList 的 `subject`——本仓既有列名是 `description`，映射见 [自定]⑦。 */
  subject: string;
  status: string;
  owner?: string;
  /** **open** 前置依赖（终态/已逐出的引用不在此列，见 [自定]③）。 */
  blockedBy: string[];
}

export interface SharedTaskBoardOptions {
  registry: TaskRegistry;
  roster: TeamRoster;
  /** 告警通道（fail-closed 分支的上浮面）。缺省=写 stderr。 */
  warn?(message: string): void;
}

export interface SharedTaskBoard {
  readonly roster: TeamRoster;
  /** 看板视图（成员共享读面；`actor` 须可寻址——② fail-closed）。 */
  board(actor: string): TaskBoardRow[];
  /** 单行视图（TaskGet 面）。 */
  row(actor: string, taskId: string): TaskBoardRow;
  /** 指派/移交 owner（owner 须在可寻址集；undefined=释放）。 */
  assign(actor: string, taskId: string, owner: string | undefined): TaskBoardRow;
  /** 认领（要求无 owner 且 open 依赖为空；同 owner 重复认领=幂等 true，不报错）。返回是否认领成功。 */
  claim(actor: string, taskId: string): { claimed: boolean; row: TaskBoardRow };
  /** 写前置依赖（悬空拒；空数组=清空）。 */
  setBlockedBy(actor: string, taskId: string, taskIds: readonly string[]): TaskBoardRow;
  /** 依赖已清空（L191035「verify its blockedBy list is empty before beginning work」的程序面）。 */
  isReady(actor: string, taskId: string): boolean;
}

/** 终态判定（本仓三态；[自定]① failed 同列——open 依赖以"非终态"为准）。 */
function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed";
}

export function createSharedTaskBoard(options: SharedTaskBoardOptions): SharedTaskBoard {
  const { registry, roster } = options;
  const warn =
    options.warn ??
    ((m: string) => {
      try {
        process.stderr.write(`${m}\n`);
      } catch {
        /* 告警不静默，但不因写入失败而崩 */
      }
    });

  /** ② 身份仲裁：不可寻址=点名拒绝（任何读写面都过此闸）。 */
  function assertActor(actor: string): void {
    if (roster.addressable().includes(actor)) return;
    const reason = taskBoardUnknownActor(actor);
    warn(`[WP-09] ${reason}`); // fail-closed：告警不静默，再抛以强制调用方处理
    throw new Error(reason);
  }

  function requireTask(taskId: string): NonNullable<ReturnType<TaskRegistry["get"]>> {
    const t = registry.get(taskId);
    if (!t) throw new Error(taskBoardUnknownTask(taskId));
    return t;
  }

  /** open 依赖视图（③：终态与已逐出=已消解）。 */
  function openBlockedBy(task: { taskId: string; blockedBy?: string[] }): string[] {
    const refs = task.blockedBy ?? [];
    if (refs.length === 0) return [];
    return refs.filter((id) => {
      const ref = registry.get(id);
      if (!ref) return false; // 缺席=终态后已逐出（见 [自定]③）
      return !isTerminal(ref.status);
    });
  }

  function toRow(task: NonNullable<ReturnType<TaskRegistry["get"]>>): TaskBoardRow {
    const row: TaskBoardRow = {
      taskId: task.taskId,
      subject: task.description, // [自定]⑦：TaskList 列名 `subject` ↔ 本仓既有列名 `description`
      status: task.status,
      blockedBy: openBlockedBy(task),
    };
    if (task.owner !== undefined) row.owner = task.owner; // owner 缺席= available（L191500）
    return row;
  }

  const boardView = (taskId: string): TaskBoardRow => toRow(requireTask(taskId));

  return {
    roster,
    board: (actor) => {
      assertActor(actor);
      return registry.list().map(toRow); // 成员共享读面：全表（含终态），open 依赖已过滤
    },
    row: (actor, taskId) => {
      assertActor(actor);
      return boardView(taskId);
    },
    assign: (actor, taskId, owner) => {
      assertActor(actor);
      const task = requireTask(taskId);
      if (owner !== undefined && !roster.addressable().includes(owner)) {
        // ④：owner 必须在可寻址集——不可寻址=点名拒绝（不静默落成野 owner）
        const reason = taskBoardUnknownActor(owner);
        warn(`[WP-09] ${reason}`);
        throw new Error(reason);
      }
      if (!registry.setOwner(taskId, owner)) throw new Error(taskBoardUnknownTask(taskId));
      return boardView(taskId);
    },
    claim: (actor, taskId) => {
      assertActor(actor);
      const task = requireTask(taskId);
      if (task.owner === actor) return { claimed: true, row: toRow(task) }; // 幂等重复认领
      const open = openBlockedBy(task);
      if (task.owner !== undefined || open.length > 0) {
        // [自定]①：不可认领=点名拒绝（含"依赖未清空"与"已被他人认领"两因）
        const reason = taskBoardNotClaimable(taskId, task.owner, open);
        warn(`[WP-09] ${reason}`);
        throw new Error(reason);
      }
      if (!registry.setOwner(taskId, actor)) throw new Error(taskBoardUnknownTask(taskId));
      return { claimed: true, row: boardView(taskId) };
    },
    setBlockedBy: (actor, taskId, taskIds) => {
      assertActor(actor);
      requireTask(taskId);
      const offenders = taskIds.filter((id) => id !== taskId && registry.get(id) === undefined);
      if (offenders.length > 0) {
        const reason = taskBoardDanglingBlockedBy(taskId, offenders);
        warn(`[WP-09] ${reason}`);
        throw new Error(reason);
      }
      if (!registry.setBlockedBy(taskId, taskIds)) throw new Error(taskBoardUnknownTask(taskId));
      return boardView(taskId);
    },
    isReady: (actor, taskId) => {
      assertActor(actor);
      return openBlockedBy(requireTask(taskId)).length === 0;
    },
  };
}
