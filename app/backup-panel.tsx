"use client";

import { useRef, useState } from "react";
import { backupSources, prepareRestore, type BackupPreview } from "../lib/backup";
import type { Command, Workspace } from "../lib/study";
import "./backup-panel.css";

type RestorePlan = ReturnType<typeof prepareRestore>;

async function restoreConversations(plan: RestorePlan, userKey?: string) {
  for (const raw of plan.conversations) {
    const conversation = raw as { taskId: string; memory?: string; messages?: { role: string; content: string; createdAt: number; operationId?: string }[] };
    const messages = conversation.messages ?? [];
    const turns: { operationId: string; message: string; reply: string | null; createdAt: number; finishedAt: number }[] = [];
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      if (message.role !== "user") continue;
      const next = messages[index + 1];
      const reply = next?.role === "assistant" ? next : undefined;
      turns.push({ operationId: `restored_${index}`, message: message.content, reply: reply?.content ?? null, createdAt: message.createdAt, finishedAt: Math.max(message.createdAt, reply?.createdAt ?? message.createdAt) });
    }
    // Per-turn requests also accommodate long historical answers without an oversized upload.
    for (const turn of turns.length ? turns : [null]) {
      const response = await fetch("/api/chat-backup/restore", { method: "POST", headers: { "Content-Type": "application/json", ...(userKey ? { "X-Study-User-Key": userKey } : {}) }, body: JSON.stringify({ taskId: conversation.taskId, memory: conversation.memory ?? "", turns: turn ? [turn] : [] }), signal: AbortSignal.timeout(20000) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "对话恢复尚未完成，请继续恢复");
    }
  }
}

export default function BackupPanel({ state, saveCommands, userKey }: { state: Workspace; saveCommands: (commands: Command[]) => Promise<void>; userKey?: string }) {
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [standalone, setStandalone] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [sources, setSources] = useState<ReturnType<typeof backupSources>>([]);
  const [sourceIndex, setSourceIndex] = useState(0);
  const plan = useRef<RestorePlan | null>(null);
  const queued = useRef(false);
  async function load(file?: File) {
    if (!file) return;
    try {
      if (file.size > 30000000) throw new Error("备份文件超过30 MB，请使用较小的备份文件");
      const choices = backupSources(JSON.parse(await file.text()));
      const next = choices[0].preview;
      setSources(choices); setSourceIndex(0);
      setPreview(next); setSelected(next.state.tasks.map(task => task.id));
      setMessage(""); plan.current = null; queued.current = false;
    } catch (error) { setPreview(null); setMessage(error instanceof Error ? error.message : "备份无法读取"); }
  }
  async function restore() {
    if (!preview) return;
    setBusy(true); setMessage("正在恢复学习记录…");
    try {
      plan.current ??= prepareRestore(state, preview, selected, standalone);
      if (!queued.current) {
        try { await saveCommands(plan.current.commands); queued.current = true; }
        catch (error) { if ((error as { queued?: boolean })?.queued) queued.current = true; throw error; }
      }
      else await saveCommands([]);
      await restoreConversations(plan.current, userKey);
      if (userKey) for (const draft of plan.current.chatDrafts) localStorage.setItem(`yike.chat.draft.v1:${encodeURIComponent(userKey)}:${encodeURIComponent(draft.taskId)}:restored_${crypto.randomUUID()}`, JSON.stringify(draft.draft));
      setMessage(`已恢复 ${plan.current.taskIds.size} 个任务及其笔记、历史、复习题和对话。`);
      setPreview(null); plan.current = null; queued.current = false;
    } catch (error) { setMessage(error instanceof Error ? error.message : "恢复尚未完成，可以继续恢复"); }
    finally { setBusy(false); }
  }
  return <section className="backup-panel" aria-label="恢复学习备份">
    <h3>恢复学习备份</h3>
    <p>选择 JSON 备份并预览。所选内容以恢复副本加入，正在进行的计时会保留。</p>
    <label className="backup-file-label">选择备份文件<input type="file" accept=".json,application/json" disabled={busy || queued.current} onChange={event => void load(event.target.files?.[0])} /></label>
    {preview && <div className="backup-preview"><p>{preview.state.tasks.length} 个任务 · {preview.state.notes?.length ?? 0} 篇笔记 · {preview.state.sessions.length} 次学习 · {preview.conversations.length} 份对话</p>
      {sources.length > 1 && <label>恢复来源<select value={sourceIndex} disabled={busy || queued.current} onChange={event => { const index = Number(event.target.value); setSourceIndex(index); setPreview(sources[index].preview); setSelected(sources[index].preview.state.tasks.map(task => task.id)); plan.current = null; }}>{sources.map((source, index) => <option key={index} value={index}>{source.label}</option>)}</select></label>}
      {preview.chatExportStatus === "unavailable" && <p role="status">此文件导出时未能读取云端对话，可恢复其中已有的学习数据。</p>}
      <div className="backup-task-options">{preview.state.tasks.map(task => <label key={task.id}><input type="checkbox" checked={selected.includes(task.id)} disabled={busy || queued.current} onChange={event => { plan.current = null; setSelected(previous => event.target.checked ? [...previous, task.id] : previous.filter(id => id !== task.id)); }} />{task.title}</label>)}</div>
      <label><input type="checkbox" checked={standalone} disabled={busy || queued.current} onChange={event => { plan.current = null; setStandalone(event.target.checked); }} />同时恢复未关联任务的独立笔记</label>
      <button className="secondary-button" disabled={busy} onClick={() => void restore()}>{busy ? "正在恢复…" : queued.current ? "继续恢复" : "恢复所选内容"}</button>
    </div>}
    {message && <p role="status">{message}</p>}
  </section>;
}
