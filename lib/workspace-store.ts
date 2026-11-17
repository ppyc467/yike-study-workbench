import { applyCommand, initialWorkspace, StudyError, validateCommand, type Workspace } from "./study";

export type WorkspaceSnapshot = {
  state: Workspace;
  revision: number;
  serverNow: number;
  storage: "cloud" | "local";
};

export type WorkspaceValues = {
  stateJson: string;
  revision: number;
  lastMutationId: string | null;
  updatedAt: number;
};
export type WorkspaceRow = WorkspaceValues & {
  userId: string;
  /** Present after record storage migration. Positions preserve ordering without rewriting siblings. */
  recordPositions?: Record<string, number>;
};

export type WorkspaceVersion = Omit<WorkspaceSnapshot, "state">;

/** Insert/update must check their precondition atomically and return no row on a lost race. */
export interface WorkspaceRepository {
  read(userId: string): Promise<WorkspaceRow | undefined>;
  readVersion?(userId: string): Promise<number>;
  insert(userId: string, values: WorkspaceValues): Promise<WorkspaceRow | undefined>;
  update(userId: string, expectedRevision: number, values: WorkspaceValues, previous?: WorkspaceRow): Promise<WorkspaceRow | undefined>;
}

export interface WorkspaceStore {
  read(userId: string): Promise<WorkspaceSnapshot>;
  readVersion(userId: string): Promise<WorkspaceVersion>;
  mutate(userId: string, input: unknown): Promise<WorkspaceSnapshot>;
}

export class WorkspaceConflict extends Error {
  readonly snapshot: WorkspaceSnapshot;

  constructor(snapshot: WorkspaceSnapshot) {
    super("另一台设备已更新进度，请先处理同步冲突");
    this.name = "WorkspaceConflict";
    this.snapshot = snapshot;
  }
}

function requireIdentity(userId: string): void {
  if (typeof userId !== "string" || !userId.trim()) throw new StudyError("请先登录，再访问学习进度");
}

/** The browser and MCP share validation and optimistic concurrency without sharing transport rules. */
export function createWorkspaceStore({
  repository,
  now = Date.now,
  storage = "cloud",
}: {
  repository: WorkspaceRepository;
  now?: () => number;
  storage?: WorkspaceSnapshot["storage"];
}): WorkspaceStore {
  function envelope(row: WorkspaceRow | undefined): WorkspaceSnapshot {
    return {
      state: row ? JSON.parse(row.stateJson) as Workspace : initialWorkspace(),
      revision: row?.revision ?? 0,
      serverNow: now(),
      storage,
    };
  }

  return {
    async read(userId) {
      requireIdentity(userId);
      return envelope(await repository.read(userId));
    },

    async readVersion(userId) {
      requireIdentity(userId);
      const revision = repository.readVersion
        ? await repository.readVersion(userId)
        : (await repository.read(userId))?.revision ?? 0;
      return { revision, serverNow: now(), storage };
    },

    async mutate(userId, payload) {
      requireIdentity(userId);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new StudyError("同步请求格式不正确");
      const input = payload as Record<string, unknown>;
      if (Object.keys(input).some((key) => !["baseRevision", "mutationId", "commands"].includes(key))) throw new StudyError("同步请求包含未知字段");
      if (!Number.isSafeInteger(input.baseRevision) || (input.baseRevision as number) < 0) throw new StudyError("同步版本不正确");
      if (typeof input.mutationId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.mutationId)) throw new StudyError("同步标识不正确");
      if (!Array.isArray(input.commands) || input.commands.length < 1 || input.commands.length > 100) throw new StudyError("每次同步应包含 1 到 100 个操作");
      const timestamp = now();
      for (const command of input.commands) {
        validateCommand(command);
        if (command.at > timestamp + 60_000) throw new StudyError("设备时间超前，请校准时间后重试");
      }
      const row = await repository.read(userId);
      if (row?.lastMutationId === input.mutationId) return envelope(row);
      if ((row?.revision ?? 0) !== input.baseRevision) throw new WorkspaceConflict(envelope(row));
      let state = row ? JSON.parse(row.stateJson) as Workspace : initialWorkspace();
      for (const command of input.commands) state = applyCommand(state, command);
      const stateJson = JSON.stringify(state);
      const values: WorkspaceValues = {
        stateJson,
        revision: (input.baseRevision as number) + 1,
        lastMutationId: input.mutationId,
        updatedAt: timestamp,
      };
      const saved = row
        ? await repository.update(userId, input.baseRevision as number, values, row)
        : await repository.insert(userId, values);
      if (!saved) {
        const latest = await repository.read(userId);
        if (latest?.lastMutationId === input.mutationId) return envelope(latest);
        throw new WorkspaceConflict(envelope(latest));
      }
      return envelope(saved);
    },
  };
}
