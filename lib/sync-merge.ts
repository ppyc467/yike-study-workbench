import { applyCommand, type Command, type Workspace } from "./study.ts";

export type SyncDifference = { label: string; local: string; remote: string };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const display = (value: unknown) => typeof value === "string" ? value : value === undefined ? "已移除" : JSON.stringify(value);

/** Rebase independent edits and leave competing changes for an explicit decision. */
export function rebaseCommands(base: Workspace, remote: Workspace, commands: Command[], preferLocal = false): { commands: Command[]; differences: SyncDifference[] } {
  let original = base;
  let rebased = remote;
  const result: Command[] = [];
  const differences: SyncDifference[] = [];
  for (const command of commands) {
    const changes: SyncDifference[] = [];
    let skip = false;
    if (command.type.endsWith(".update")) {
      const update = command as Extract<Command, { type: "task.update" | "note.update" | "project.update" }>;
      const collection = command.type.startsWith("task.") ? "tasks" : command.type.startsWith("note.") ? "notes" : "projects";
      const previous = (original[collection] ?? []).find(item => item.id === update.id) as Record<string, unknown> | undefined;
      const latest = (rebased[collection] ?? []).find(item => item.id === update.id) as Record<string, unknown> | undefined;
      if (!previous || !latest) changes.push({ label: String(previous?.title ?? "记录已删除"), local: JSON.stringify(command), remote: "这条记录已被另一台设备删除" });
      else {
        for (const [key, desired] of Object.entries(update)) {
          if (["type", "id", "at"].includes(key) || desired === undefined) continue;
          const normalized = desired === null ? undefined : desired;
          if (!same(previous[key], latest[key]) && !same(normalized, latest[key])) changes.push({ label: `${previous.title ?? "记录"} · ${key}`, local: display(normalized), remote: display(latest[key]) });
        }
      }
    } else if (command.type === "settings.goal") {
      if (original.goalMinutes !== rebased.goalMinutes && command.minutes !== rebased.goalMinutes) changes.push({ label: "每日目标", local: `${command.minutes} 分钟`, remote: `${rebased.goalMinutes} 分钟` });
    } else if (command.type.endsWith(".delete")) {
      const deletion = command as Extract<Command, { type: "task.delete" | "note.delete" | "project.delete" | "review.delete" }>;
      const collection = command.type.startsWith("task.") ? "tasks" : command.type.startsWith("note.") ? "notes" : command.type.startsWith("review.") ? "reviews" : "projects";
      const previous = (original[collection] ?? []).find(item => item.id === deletion.id);
      const latest = (rebased[collection] ?? []).find(item => item.id === deletion.id);
      skip = !latest;
      if (latest && !same(previous, latest)) changes.push({ label: "删除的记录已有新修改", local: "删除记录", remote: display(latest) });
      if (command.type === "task.delete" && !same(original.sessions.filter(item => item.taskId === command.id), rebased.sessions.filter(item => item.taskId === command.id))) changes.push({ label: "任务新增了学习记录", local: "删除任务及记录", remote: "另一台设备修改了学习记录" });
      if (command.type === "task.delete" && !same((original.reviews ?? []).filter(item => item.taskId === command.id), (rebased.reviews ?? []).filter(item => item.taskId === command.id))) changes.push({ label: "任务有新的复习结果", local: "删除任务及复习题", remote: "另一台设备更新了复习记录" });
      if (command.type === "project.delete" && (!same(original.tasks.filter(item => item.projectId === command.id), rebased.tasks.filter(item => item.projectId === command.id)) || !same((original.notes ?? []).filter(item => item.projectId === command.id), (rebased.notes ?? []).filter(item => item.projectId === command.id)))) changes.push({ label: "项目内容已有新修改", local: "删除并转移项目内容", remote: "另一台设备更新了项目内容" });
    } else if (command.type.startsWith("session.")) {
      const getActive = (state: Workspace) => state.sessions.find(item => item.id === state.activeSessionId);
      if (command.type === "session.correct") {
        if (!same(original.sessions.find(item => item.id === command.id), rebased.sessions.find(item => item.id === command.id))) changes.push({ label: "学习时长", local: `${command.minutes} 分钟`, remote: "另一台设备修改了同一次学习记录" });
      } else if (!same(getActive(original), getActive(rebased))) changes.push({ label: "当前计时", local: "本机计时操作", remote: "另一台设备修改了计时" });
    } else if (command.type === "task.add" || command.type === "note.add" || command.type === "project.add") {
      const collection = command.type === "task.add" ? rebased.tasks : command.type === "note.add" ? rebased.notes ?? [] : rebased.projects;
      const existing = collection.find(item => item.id === command.id);
      if (existing) {
        const originallyApplied = applyCommand(original, command);
        const expectedCollection = command.type === "task.add" ? originallyApplied.tasks : command.type === "note.add" ? originallyApplied.notes ?? [] : originallyApplied.projects;
        skip = same(existing, expectedCollection.find(item => item.id === command.id));
        if (!skip) changes.push({ label: command.title, local: "新增记录", remote: "已有相同标识的不同记录" });
      }
    }
    original = applyCommand(original, command);
    differences.push(...changes);
    if (changes.length && !preferLocal) continue;
    if (skip) continue;
    try {
      rebased = applyCommand(rebased, command);
      result.push(command);
    } catch (error) {
      differences.push({ label: "关联记录需要核对", local: JSON.stringify(command), remote: error instanceof Error ? error.message : "当前云端状态无法接收此修改" });
    }
  }
  return { commands: result, differences };
}
