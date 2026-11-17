"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { applyCommand, type Command, type Workspace } from "./study";
import { applyDiscardNotices, type Cache, type DiscardNotice, type Snapshot } from "./outbox";
import { rebaseCommands, type SyncDifference } from "./sync-merge";
import { readWorkspaceCaches, writeWorkspaceCache, removeWorkspaceCache } from "./workspace-cache";

type SyncStatus = "loading" | "synced" | "saving" | "offline" | "conflict" | "error" | "auth";

function nextBatch(pending: Command[]): Command[] {
  const encoder = new TextEncoder();
  const commands: Command[] = [];
  let size = 256;
  for (const command of pending.slice(0, 100)) {
    const bytes = encoder.encode(JSON.stringify(command)).length + 1;
    if (size + bytes > 320_000) break;
    commands.push(command);
    size += bytes;
  }
  return commands;
}

export function useWorkspace(userKey: string) {
  const [state, setState] = useState<Workspace | null>(null);
  const [status, setStatus] = useState<SyncStatus>("loading");
  const [message, setMessage] = useState("");
  const [exportMessage, setExportMessage] = useState("");
  const [now, setNow] = useState(Date.now());
  const [conflictDetails, setConflictDetails] = useState<SyncDifference[]>([]);
  const cache = useRef<Cache | null>(null);
  const cloud = useRef<Snapshot | null>(null);
  const offset = useRef(0);
  const busy = useRef(false);
  const statusRef = useRef<SyncStatus>("loading");
  const storageKey = useRef("");
  const storageProblem = useRef(false);
  const syncRef = useRef<() => Promise<void>>(async () => {});
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cacheWrites = useRef(Promise.resolve());
  const hydrated = useRef(false);

  const readDiscards = useCallback((): DiscardNotice[] => {
    const prefix = `yike.workspace.discard.v1:${encodeURIComponent(userKey)}:`;
    const notices: DiscardNotice[] = [];
    try {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith(prefix)) continue;
        try {
          const notice = JSON.parse(localStorage.getItem(key) || "null") as DiscardNotice | null;
          if (notice?.id && notice.lineage && Number.isInteger(notice.baseRevision) && Array.isArray(notice.commands)) notices.push(notice);
        } catch { /* Ignore a damaged notification, never unrelated drafts. */ }
      }
    } catch { /* Disabling browser storage must not disable online editing. */ }
    return notices;
  }, [userKey]);

  const readResolvedSnapshot = useCallback((): Snapshot | null => {
    try {
      const snapshot = JSON.parse(localStorage.getItem(`yike.workspace.resolved.v1:${encodeURIComponent(userKey)}`) || "null") as Snapshot | null;
      return snapshot?.state && Number.isInteger(snapshot.revision) ? snapshot : cloud.current;
    } catch { return cloud.current; }
  }, [userKey]);

  const reconcileDiscards = useCallback(() => {
    if (!cache.current) return false;
    cache.current.lineage ??= storageKey.current;
    return applyDiscardNotices(cache.current, readDiscards(), readResolvedSnapshot());
  }, [readDiscards, readResolvedSnapshot]);

  const updateStatus = useCallback((next: SyncStatus, text = "") => {
    statusRef.current = next;
    setStatus(next);
    setMessage(cache.current?.base.storage === "local" ? text.replaceAll("云端", "本机服务") : text);
  }, []);

  const persist = useCallback(() => {
    if (!cache.current || !storageKey.current) return;
    try {
      reconcileDiscards();
      cache.current.savedAt = Date.now();
      const durable = structuredClone(cache.current);
      const key = storageKey.current;
      // Keep immediate small drafts compatible with older tabs. Large snapshots use IndexedDB.
      const large = (durable.base.state.notes ?? []).reduce((size, note) => size + note.body.length, 0) + durable.base.state.tasks.reduce((size, task) => size + task.notes.length, 0) > 40000 || durable.base.state.sessions.length > 200;
      if (!large || typeof indexedDB === "undefined") localStorage.setItem(key, JSON.stringify(durable));
      if (typeof indexedDB !== "undefined") {
        cacheWrites.current = cacheWrites.current.catch(() => {}).then(() => writeWorkspaceCache(key, durable)).then(() => {
          if (large) localStorage.setItem(key, JSON.stringify({ version: 2, indexedDB: true, savedAt: durable.savedAt }));
        }).catch(() => {
          try { localStorage.setItem(key, JSON.stringify(durable)); }
          catch { storageProblem.current = true; setMessage("本机离线存储空间不足，请保持页面打开并导出备份。"); }
        });
      }
      storageProblem.current = false;
    } catch {
      storageProblem.current = true;
      setMessage("浏览器暂存空间不可用，请保持页面打开，联网后完成保存。");
    }
  }, [reconcileDiscards]);

  const paint = useCallback(() => {
    const current = cache.current;
    if (!current) return;
    let next = current.base.state;
    for (const command of current.pending) next = applyCommand(next, command);
    setState(next);
  }, []);

  const sync = useCallback(async () => {
    if (busy.current || !hydrated.current) return;
    try {
      if (reconcileDiscards()) { persist(); paint(); updateStatus("loading"); }
    } catch { /* A storage failure does not prevent an already queued cloud save. */ }
    if (statusRef.current === "conflict") return;
    busy.current = true;
    try {
      const current = cache.current;
      let flight = current?.flight;
      if (current && !flight && current.pending.length) {
        flight = { baseRevision: current.base.revision, mutationId: crypto.randomUUID(), commands: nextBatch(current.pending) };
        current.flight = flight;
        persist();
      }
      if (flight) updateStatus("saving", "正在同步到云端…");
      const response = await fetch("/api/workspace", {
        method: flight ? "POST" : "GET",
        headers: flight ? { "Content-Type": "application/json", "X-Study-User-Key": userKey } : { "X-Study-User-Key": userKey, ...(current ? { "If-None-Match": `"workspace-${current.base.revision}"` } : {}) },
        body: flight ? JSON.stringify(flight) : undefined,
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      });
      // Another tab may resolve this recovered draft while its old request is still in flight.
      if (reconcileDiscards() || (flight && current?.flight?.mutationId !== flight.mutationId)) {
        persist(); paint(); updateStatus("loading");
        setTimeout(() => void syncRef.current(), 0);
        return;
      }
      const responseUser = response.headers?.get("X-Study-User");
      if (response.status === 401 || response.status === 403 || responseUser && responseUser !== userKey) {
        updateStatus("auth", "登录已失效，本机待同步内容仍保留。请重新登录。");
        return;
      }
      if (response.status === 304 && current) {
        updateStatus(current.pending.length ? "saving" : "synced", "所有修改已自动保存");
        if (current.pending.length) setTimeout(() => void syncRef.current(), 0);
        return;
      }
      const data = await response.json() as Snapshot & { error?: string };
      if (response.status === 409) {
        cloud.current = data;
        const merge = current ? rebaseCommands(current.base.state, data.state, current.pending) : null;
        if (current && merge && !merge.differences.length) {
          if (current.flight) current.rebasedFlights = [...(current.rebasedFlights ?? []), { mutationId: current.flight.mutationId, count: current.flight.commands.length }];
          current.base = data; current.pending = merge.commands; current.flight = null;
          setConflictDetails([]); persist(); paint(); updateStatus("saving", "已合并另一台设备的独立修改…");
          setTimeout(() => void syncRef.current(), 0);
          return;
        }
        setConflictDetails(merge?.differences ?? []);
        updateStatus("conflict", "同一内容在两台设备上有不同修改，请核对差异并选择保留的版本。");
        return;
      }
      if (!response.ok) {
        if (response.status === 400 || response.status === 422) {
          updateStatus("error", data.error || "这次修改无法同步。可先导出本机备份，再载入云端记录。");
          return;
        }
        throw new Error(data.error || "云端暂时未连接");
      }
      const snapshot = data as Snapshot;
      if (!snapshot.state || !Number.isInteger(snapshot.revision)) throw new Error("云端返回的数据不完整");
      if (!flight && current?.pending.length && snapshot.revision !== current.base.revision) {
        cloud.current = snapshot;
        const merge = rebaseCommands(current.base.state, snapshot.state, current.pending);
        if (!merge.differences.length) {
          current.base = snapshot; current.pending = merge.commands; current.flight = null;
          persist(); paint(); updateStatus("saving"); setTimeout(() => void syncRef.current(), 0); return;
        }
        setConflictDetails(merge.differences);
        updateStatus("conflict", "同一内容在两台设备上有不同修改，请核对差异并选择保留的版本。");
        return;
      }
      offset.current = snapshot.serverNow - Date.now();
      if (current) {
        if (flight) current.pending.splice(0, flight.commands.length);
        current.flight = null;
        current.base = snapshot;
      } else {
        cache.current = { version: 1, base: snapshot, pending: [], flight: null };
      }
      cloud.current = snapshot;
      setConflictDetails([]);
      if (flight) {
        const acknowledged = [{ mutationId: flight.mutationId, count: flight.commands.length }, ...(current?.rebasedFlights ?? [])];
        // Retire a recovered copy of the same outbox without deleting later edits in its original tab.
        try {
          const prefix = `yike.workspace.v1:${encodeURIComponent(userKey)}:`;
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key?.startsWith(prefix) || key === storageKey.current) continue;
            const other = JSON.parse(localStorage.getItem(key) || "null") as Cache | null;
            const retired = acknowledged.find(item => item.mutationId === other?.flight?.mutationId);
            if (!other || !retired) continue;
            other.pending.splice(0, retired.count);
            other.flight = null;
            other.base = snapshot;
            localStorage.setItem(key, JSON.stringify(other));
          }
        } catch { /* The current tab's outbox remains the authoritative retry copy. */ }
        if (typeof indexedDB !== "undefined") {
          try {
            for (const other of await readWorkspaceCaches(`yike.workspace.v1:${encodeURIComponent(userKey)}:`)) {
              const retired = acknowledged.find(item => item.mutationId === other.value.flight?.mutationId);
              if (other.key === storageKey.current || !retired) continue;
              other.value.pending.splice(0, retired.count); other.value.flight = null; other.value.base = snapshot;
              await writeWorkspaceCache(other.key, other.value);
            }
          } catch { /* Keep the acknowledged snapshot available in the current tab. */ }
        }
        if (current) current.rebasedFlights = [];
      }
      persist();
      paint();
      try {
        const prefix = `yike.workspace.v1:${encodeURIComponent(userKey)}:`;
        for (const key of Object.keys(localStorage)) {
          if (!key.startsWith(prefix) || key === storageKey.current) continue;
          const old = JSON.parse(localStorage.getItem(key) || "null") as Cache | null;
          if (old && !old.pending.length && (old.closed || (old.savedAt && old.savedAt < Date.now() - 86400000))) localStorage.removeItem(key);
        }
      } catch { /* Never let housekeeping block a successful save. */ }
      if (typeof indexedDB !== "undefined") void readWorkspaceCaches(`yike.workspace.v1:${encodeURIComponent(userKey)}:`).then(async entries => {
        for (const entry of entries) if (entry.key !== storageKey.current && !entry.value.pending.length && (entry.value.closed || (entry.value.savedAt ?? 0) < Date.now() - 86400000)) await removeWorkspaceCache(entry.key);
      }).catch(() => {});
      const hasPending = !!cache.current?.pending.length;
      updateStatus(hasPending ? "saving" : "synced", hasPending ? "正在保存后续修改…" : storageProblem.current ? "云端已保存；此浏览器无法暂存离线修改。" : "所有修改已自动保存");
      if (hasPending) setTimeout(() => void syncRef.current(), 100);
    } catch (error) {
      updateStatus("offline", cache.current ? "暂时无法连接云端，修改已在本机暂存，联网后自动补传。" : "暂时无法连接云端。首次使用需要联网载入工作台。");
      if (storageProblem.current) setMessage("云端未连接，且浏览器暂存不可用。请保持此页打开并导出备份。");
    } finally {
      busy.current = false;
    }
  }, [paint, persist, reconcileDiscards, updateStatus, userKey]);
  syncRef.current = sync;

  useEffect(() => {
    // Each tab has its own durable outbox, so concurrent tabs cannot overwrite an offline draft.
    const prefix = `yike.workspace.v1:${encodeURIComponent(userKey)}:`;
    // A fresh key on every page boot also handles browsers duplicating sessionStorage with a tab.
    const tabId = crypto.randomUUID();
    storageKey.current = prefix + tabId;
    let mounted = true;
    const boot = async () => {
    let durableChoices: { key: string; value: Cache }[] = [];
    if (typeof indexedDB !== "undefined") {
      try { durableChoices = await readWorkspaceCaches(prefix); }
      catch { /* Retain the synchronous fallback when IndexedDB is unavailable. */ }
    }
    if (!mounted) return;
    const latestDurable = [...durableChoices].sort((a, b) => b.value.base.revision - a.value.base.revision)[0];
    if (latestDurable) cloud.current = latestDurable.value.base;
    try {
      const own = localStorage.getItem(storageKey.current);
      let saved: Cache | null = own ? JSON.parse(own) : null;
      if (!saved) {
        // Recover the newest durable draft after a full browser close, retaining the original outbox id.
        const choices: { key: string; value: Cache }[] = durableChoices;
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key?.startsWith(prefix)) continue;
          try {
            const value = JSON.parse(localStorage.getItem(key) || "null") as Cache | null;
            if (value?.version === 1 && value.base?.state && Array.isArray(value.pending)) {
              value.lineage ??= key;
              if (applyDiscardNotices(value, readDiscards(), readResolvedSnapshot())) localStorage.setItem(key, JSON.stringify(value));
              const duplicate = choices.findIndex(choice => choice.key === key);
              if (duplicate < 0) choices.push({key, value});
              else if ((value.savedAt ?? 0) > (choices[duplicate].value.savedAt ?? 0)) choices[duplicate] = { key, value };
            }
          } catch { /* Ignore unrelated or damaged entries. */ }
        }
        for (const choice of choices) applyDiscardNotices(choice.value, readDiscards(), readResolvedSnapshot());
        choices.sort((a, b) => (b.value.pending.at(-1)?.at || b.value.base.serverNow) - (a.value.pending.at(-1)?.at || a.value.base.serverNow));
        const draft = choices.find(x => x.value.pending.length);
        if (draft) {
          // Copy, do not remove: the original tab may still be open. Identical mutation IDs make retries safe.
          saved = structuredClone(draft.value);
          if (!saved.flight && saved.pending.length) {
            saved.flight = { baseRevision: saved.base.revision, mutationId: crypto.randomUUID(), commands: nextBatch(saved.pending) };
            if (typeof indexedDB !== "undefined") await writeWorkspaceCache(draft.key, saved);
            else localStorage.setItem(draft.key, JSON.stringify(saved));
          }
        } else if (choices[0]) saved = { ...choices[0].value, pending: [], flight: null };
      }
      if (saved?.version === 1 && saved.base?.state && Array.isArray(saved.pending)) {
        saved.closed = false;
        cache.current = saved;
        paint();
      }
    } catch {
      const saved = durableChoices.sort((a, b) => (b.value.pending.at(-1)?.at || b.value.base.serverNow) - (a.value.pending.at(-1)?.at || a.value.base.serverNow)).find(entry => entry.value.pending.length) ?? latestDurable;
      if (saved) { cache.current = structuredClone(saved.value); cache.current.closed = false; paint(); }
      else setMessage("本机缓存读取失败，正在尝试从云端恢复。");
    }
    hydrated.current = true;
    void syncRef.current();
    };
    void boot();
    const shouldUpdate = () => document.visibilityState === "visible" || window.matchMedia?.("(display-mode: standalone)").matches === true;
    const refresh = () => {
      if (!shouldUpdate()) return;
      setNow(Date.now() + offset.current);
      void syncRef.current();
    };
    const save = () => { if (cache.current) cache.current.closed = true; persist(); };
    const resumePage = () => { if (cache.current) cache.current.closed = false; persist(); refresh(); };
    const onStorage = (event: StorageEvent) => {
      if (event.key?.startsWith(`yike.workspace.discard.v1:${encodeURIComponent(userKey)}:`)) void syncRef.current();
    };
    const timer = setInterval(() => { if (shouldUpdate()) setNow(Date.now() + offset.current); }, 1000);
    const poll = setInterval(() => { if (shouldUpdate() && statusRef.current !== "error" && statusRef.current !== "auth") void syncRef.current(); }, 5000);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("pagehide", save);
    window.addEventListener("pageshow", resumePage);
    window.addEventListener("storage", onStorage);
    return () => {
      mounted = false;
      clearInterval(timer); clearInterval(poll);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("pagehide", save);
      window.removeEventListener("pageshow", resumePage);
      window.removeEventListener("storage", onStorage);
      if (debounce.current) clearTimeout(debounce.current);
      persist();
    };
  }, [userKey, paint, persist, readDiscards, readResolvedSnapshot]);

  const dispatch = useCallback((command: Command): boolean => {
    if (!cache.current || ["conflict", "auth", "error"].includes(statusRef.current)) return false;
    try {
      if (reconcileDiscards()) {
        persist(); paint(); updateStatus("loading"); void syncRef.current();
        return false;
      }
      command = { ...command, at: Math.round(Date.now() + offset.current) };
      let current = cache.current.base.state;
      for (const queued of cache.current.pending) current = applyCommand(current, queued);
      const next = applyCommand(current, command);
      if (command.type === "note.update" && command.projectId !== undefined && command.taskId === undefined) {
        // Preserve automatic detachment when several project edits share one queued update.
        const noteId = command.id;
        command = { ...command, taskId: next.notes?.find(note => note.id === noteId)?.taskId ?? null };
      }
      const last = cache.current.pending.at(-1);
      if ((command.type === "task.update" || command.type === "note.update") && last?.type === command.type && last.id === command.id && cache.current.pending.length > (cache.current.flight?.commands.length ?? 0)) {
        cache.current.pending[cache.current.pending.length - 1] = { ...last, ...command, at: Math.max(last.at, command.at) };
      } else cache.current.pending.push(command);
      setState(next);
      persist();
      updateStatus(navigator.onLine ? "saving" : "offline", storageProblem.current ? "本机暂存失败，请保持页面打开并导出备份。" : navigator.onLine ? "正在自动保存…" : "离线修改已暂存在此设备");
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(() => void syncRef.current(), 400);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作未完成，请重试。");
      return false;
    }
  }, [persist, paint, reconcileDiscards, updateStatus]);

  const exportBackup = useCallback(async () => {
    setExportMessage("正在准备学习备份…");
    const workspaceBackup = structuredClone(cache.current);
    const deviceDrafts: Cache[] = [];
    const chatDrafts: { taskId: string; draft: unknown }[] = [];
    try {
      const prefix = `yike.workspace.v1:${encodeURIComponent(userKey)}:`;
      for (const key of Object.keys(localStorage)) {
        const chatPrefix = `yike.chat.draft.v1:${encodeURIComponent(userKey)}:`;
        if (key.startsWith(chatPrefix)) {
          const draft = JSON.parse(localStorage.getItem(key) || "null");
          chatDrafts.push({ taskId: typeof draft?.taskId === "string" ? draft.taskId : decodeURIComponent(key.slice(chatPrefix.length).split(":", 1)[0]), draft });
          continue;
        }
        if (!key.startsWith(prefix) || key === storageKey.current) continue;
        const draft = JSON.parse(localStorage.getItem(key) || "null") as Cache | null;
        if (draft?.pending?.length) deviceDrafts.push(draft);
      }
    } catch { /* Export the current in-memory state even when browser storage is unavailable. */ }
    if (typeof indexedDB !== "undefined") {
      try {
        const drafts = await readWorkspaceCaches(`yike.workspace.v1:${encodeURIComponent(userKey)}:`);
        for (const entry of drafts) {
          if (entry.key === storageKey.current || !entry.value.pending.length) continue;
          if (!deviceDrafts.some(draft => draft.lineage === entry.value.lineage && JSON.stringify(draft.pending) === JSON.stringify(entry.value.pending))) deviceDrafts.push(entry.value);
        }
      } catch { /* The active tab and synchronous drafts still form a usable backup. */ }
    }
    let conversations: unknown[] = [];
    let chatExportStatus = "complete";
    try {
      const response = await fetch("/api/chat-backup", { headers: { "X-Study-User-Key": userKey }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (response.headers?.get("X-Study-User") && response.headers.get("X-Study-User") !== userKey) throw new Error("Account changed");
      const payload = await response.json() as { conversations?: unknown };
      if (!response.ok || !Array.isArray(payload.conversations)) throw new Error("Chat backup unavailable");
      conversations = payload.conversations;
    } catch { chatExportStatus = "unavailable"; }
    const data = { exportedAt: new Date().toISOString(), timeZone: "Asia/Shanghai", ...workspaceBackup, otherDeviceDrafts: deviceDrafts, conversations, chatDrafts, chatExportStatus };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `一刻学习备份-${new Date().toISOString().slice(0, 10)}.json`; link.click();
    setExportMessage(chatExportStatus === "complete" ? "备份已导出，包含学习对话、任务记忆和本机草稿。" : "本机备份已导出，云端学习对话暂时无法读取，请联网后重新导出完整备份。");
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [userKey]);

  const keepLocalConflict = useCallback(() => {
    const current = cache.current;
    const latest = cloud.current;
    if (!current || !latest || !window.confirm("将本机修改应用到最新云端记录？同一字段会使用本机内容。")) return;
    const merge = rebaseCommands(current.base.state, latest.state, current.pending, true);
    if (merge.commands.length !== current.pending.length) {
      setMessage("部分关联记录已经删除，无法直接保留本机修改。请先导出备份，再恢复需要的记录。");
      return;
    }
    current.base = latest; current.pending = merge.commands; current.flight = null;
    setConflictDetails([]); persist(); paint(); updateStatus("saving"); void syncRef.current();
  }, [persist, paint, updateStatus]);

  const resolveConflict = useCallback(() => {
    if (!window.confirm("确定载入云端记录？这会放弃此页尚未同步的修改。建议先点击“导出本机备份”。")) return;
    if (cache.current?.pending.length) {
      const current = cache.current;
      const notice: DiscardNotice = {
        id: crypto.randomUUID(), lineage: current.lineage ?? storageKey.current,
        baseRevision: current.base.revision, mutationId: current.flight?.mutationId,
        commands: structuredClone(current.pending),
      };
      try {
        // One latest confirmed snapshot per user, shared by all notices instead of duplicating it.
        const previous = readResolvedSnapshot();
        const resolved = cloud.current && (!previous || cloud.current.revision >= previous.revision) ? cloud.current : previous;
        if (resolved) {
          const serialized = JSON.stringify(resolved);
          if (serialized.length < 500000) localStorage.setItem(`yike.workspace.resolved.v1:${encodeURIComponent(userKey)}`, serialized);
          else localStorage.removeItem(`yike.workspace.resolved.v1:${encodeURIComponent(userKey)}`);
        }
        // Persist the decision before changing any copy, so a suspended tab cannot resurrect it.
        localStorage.setItem(`yike.workspace.discard.v1:${encodeURIComponent(userKey)}:${notice.id}`, JSON.stringify(notice));
        const prefix = `yike.workspace.v1:${encodeURIComponent(userKey)}:`;
        for (const key of Object.keys(localStorage)) {
          if (!key.startsWith(prefix) || key === storageKey.current) continue;
          try {
            const other = JSON.parse(localStorage.getItem(key) || "null") as Cache | null;
            if (!other?.base?.state || !Array.isArray(other.pending)) continue;
            other.lineage ??= key;
            if (applyDiscardNotices(other, [notice], resolved)) localStorage.setItem(key, JSON.stringify(other));
          } catch { /* The durable notice will be applied when this copy next opens or saves. */ }
        }
      } catch {
        setMessage("浏览器无法保存这次处理结果。请先导出备份，释放浏览器存储空间后再载入云端。");
        return;
      }
    }
    if (cache.current) { cache.current.pending = []; cache.current.flight = null; if (cloud.current) cache.current.base = cloud.current; }
    setConflictDetails([]);
    persist(); paint(); updateStatus("loading"); void syncRef.current();
  }, [persist, paint, readResolvedSnapshot, updateStatus, userKey]);

  const saveCommands = useCallback(async (commands: Command[]) => {
    const current = cache.current;
    if (!current || ["offline", "conflict", "auth", "error"].includes(statusRef.current)) throw new Error("请先完成同步或处理冲突，再恢复备份");
    if (commands.length) {
      let next = current.base.state;
      for (const command of current.pending) next = applyCommand(next, command);
      const timestamp = Math.round(Date.now() + offset.current);
      const imported = commands.map(command => ({ ...command, at: timestamp }));
      for (const command of imported) next = applyCommand(next, command);
      current.pending.push(...imported); setState(next); persist(); updateStatus("saving");
    }
    const queuedError = (message: string) => Object.assign(new Error(message), { queued: true });
    await cacheWrites.current;
    await syncRef.current();
    for (let attempt = 0; cache.current?.pending.length && attempt < 100; attempt++) {
      if (["offline", "conflict", "auth", "error"].includes(statusRef.current)) throw queuedError("恢复内容已在本机暂存，请联网并完成同步后继续恢复对话");
      await new Promise(resolve => setTimeout(resolve, 150));
      await syncRef.current();
    }
    if (cache.current?.pending.length) throw queuedError("恢复内容正在同步，请稍后继续");
  }, [persist, updateStatus]);

  return { state, now, status, message, exportMessage, conflictDetails, keepLocalConflict, saveCommands, localPreview: cache.current?.base.storage === "local", dispatch, retry: () => { updateStatus("loading"); void syncRef.current(); }, resolveConflict, exportBackup };
}
