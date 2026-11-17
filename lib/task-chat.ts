export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  status?: "pending" | "failed";
  operationId?: string;
};

export type ChatSnapshot = {
  messages: ChatMessage[];
  before: string | null;
  memory: string;
  memoryRevision: number;
  pending: { operationId: string; startedAt: number } | null;
};

export type ChatConversation = {
  userId: string;
  taskId: string;
  memory: string;
  memoryRevision: number;
  activeOperationId: string | null;
  leaseToken: string | null;
  leaseUntil: number;
  updatedAt: number;
};

export type ChatTurn = {
  id: number;
  userId: string;
  taskId: string;
  operationId: string;
  message: string;
  reply: string | null;
  status: "pending" | "failed" | "complete";
  leaseToken: string;
  createdAt: number;
  finishedAt: number | null;
  error: string | null;
};

export type ChatClaim = {
  operationId: string;
  token: string;
  message: string;
  memory: string;
  memoryRevision: number;
  history: ChatMessage[];
};

export type ClaimInput = {
  operationId: string;
  message: string;
  token: string;
  now: number;
  leaseUntil: number;
};

export type ChatExport = {
  taskId: string;
  memory: string;
  memoryRevision: number;
  messages: ChatMessage[];
};

/** Writes must atomically check the lease token. A deleted task cannot acquire a lease. */
export interface TaskChatRepository {
  readConversation(userId: string, taskId: string): Promise<ChatConversation | undefined>;
  readPage(userId: string, taskId: string, options: { before?: number; limit: number; includeOperationId?: string }): Promise<{
    conversation: ChatConversation | undefined;
    turns: ChatTurn[];
    includedTurn: ChatTurn | undefined;
  }>;
  findTurn(userId: string, taskId: string, operationId: string): Promise<ChatTurn | undefined>;
  claim(userId: string, taskId: string, input: ClaimInput): Promise<"claimed" | "busy" | "complete" | "missing">;
  complete(userId: string, taskId: string, claim: ChatClaim, reply: string, memory: string | undefined, now: number): Promise<boolean>;
  fail(userId: string, taskId: string, claim: ChatClaim, error: string, now: number): Promise<boolean>;
  updateMemory(userId: string, taskId: string, memory: string, baseRevision: number, now: number): Promise<"saved" | "conflict" | "missing">;
  deleteTask(userId: string, taskId: string): Promise<void>;
  exportAll(userId: string): Promise<{ conversations: ChatConversation[]; turns: ChatTurn[] }>;
}

export class ChatError extends Error {
  readonly status: number;

  constructor(message: string, status = 422) {
    super(message);
    this.name = "ChatError";
    this.status = status;
  }
}

export class ChatConflict extends ChatError {
  readonly snapshot: ChatSnapshot;

  constructor(message: string, snapshot: ChatSnapshot) {
    super(message, 409);
    this.name = "ChatConflict";
    this.snapshot = snapshot;
  }
}

export const CHAT_LEASE_MS = 120_000;
export const MAX_CHAT_MESSAGE_LENGTH = 20_000;
export const MAX_CHAT_MEMORY_LENGTH = 12_000;
const MAX_REPLY_LENGTH = 100_000;

function requireIdentity(userId: string, taskId?: string) {
  if (typeof userId !== "string" || !userId.trim()) throw new ChatError("请先登录，再打开学习对话", 401);
  if (taskId !== undefined && (typeof taskId !== "string" || !taskId || taskId.length > 200)) throw new ChatError("任务标识不正确");
}

function messagesForTurns(turns: ChatTurn[], conversation: ChatConversation | undefined, now: number): ChatMessage[] {
  return turns.flatMap((turn): ChatMessage[] => {
    const active = turn.status === "pending" && conversation?.activeOperationId === turn.operationId && conversation.leaseToken === turn.leaseToken && conversation.leaseUntil > now;
    const user: ChatMessage = {
      id: `${turn.operationId}:user`, role: "user", content: turn.message,
      createdAt: turn.createdAt, operationId: turn.operationId,
    };
    if (turn.status !== "complete") user.status = active ? "pending" : "failed";
    if (turn.status !== "complete" || turn.reply === null) return [user];
    return [user, {
      id: `${turn.operationId}:assistant`, role: "assistant", content: turn.reply,
      createdAt: turn.finishedAt ?? turn.createdAt, operationId: turn.operationId,
    }];
  });
}

export function createTaskChatStore({
  repository,
  now = Date.now,
  createToken = () => crypto.randomUUID(),
}: {
  repository: TaskChatRepository;
  now?: () => number;
  createToken?: () => string;
}) {
  async function read(userId: string, taskId: string, options: { before?: string; limit?: number; includeOperationId?: string } = {}): Promise<ChatSnapshot> {
    requireIdentity(userId, taskId);
    const limit = options.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ChatError("每次读取应为 1 到 50 轮对话");
    if (options.before !== undefined && !/^[1-9]\d{0,14}$/.test(options.before)) throw new ChatError("对话分页位置不正确");
    if (options.includeOperationId !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(options.includeOperationId)) throw new ChatError("提问标识不正确");
    const before = options.before === undefined ? undefined : Number(options.before);
    const { conversation, turns: rows, includedTurn } = await repository.readPage(userId, taskId, {
      before, limit: limit + 1, includeOperationId: options.includeOperationId,
    });
    const page = rows.slice(0, limit).reverse();
    const turns = [...page];
    // Keep a retried old question visible without moving the pagination cursor past unloaded history.
    if (includedTurn && !turns.some(turn => turn.id === includedTurn.id)) {
      turns.push(includedTurn);
      turns.sort((first, second) => first.id - second.id);
    }
    const timestamp = now();
    const pending = conversation?.activeOperationId && conversation.leaseUntil > timestamp
      ? { operationId: conversation.activeOperationId, startedAt: conversation.leaseUntil - CHAT_LEASE_MS }
      : null;
    return {
      messages: messagesForTurns(turns, conversation, timestamp),
      before: rows.length > limit && page.length ? String(page[0].id) : null,
      memory: conversation?.memory ?? "", memoryRevision: conversation?.memoryRevision ?? 0, pending,
    };
  }

  async function begin(userId: string, taskId: string, input: { operationId: string; message: string }) {
    requireIdentity(userId, taskId);
    if (typeof input?.operationId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.operationId)) throw new ChatError("提问标识不正确");
    if (typeof input.message !== "string" || !input.message.trim() || input.message.length > MAX_CHAT_MESSAGE_LENGTH) throw new ChatError(`问题应为 1 到 ${MAX_CHAT_MESSAGE_LENGTH} 个字符`);
    const existing = await repository.findTurn(userId, taskId, input.operationId);
    if (existing && existing.message !== input.message) throw new ChatError("同一次提问的内容已改变，请使用新的提问标识", 409);
    if (existing?.status === "complete") return { status: "complete" as const, snapshot: await read(userId, taskId, { includeOperationId: input.operationId }) };
    const timestamp = now();
    const token = createToken();
    const result = await repository.claim(userId, taskId, {
      ...input, token, now: timestamp, leaseUntil: timestamp + CHAT_LEASE_MS,
    });
    if (result === "missing") throw new ChatError("这个任务已被删除，请刷新学习清单", 404);
    const turn = await repository.findTurn(userId, taskId, input.operationId);
    if (turn && turn.message !== input.message) throw new ChatError("同一次提问的内容已改变，请使用新的提问标识", 409);
    if (result === "complete" || turn?.status === "complete") return { status: "complete" as const, snapshot: await read(userId, taskId, { includeOperationId: input.operationId }) };
    if (result !== "claimed") {
      const snapshot = await read(userId, taskId, { includeOperationId: input.operationId });
      if (snapshot.pending?.operationId === input.operationId) return { status: "pending" as const, snapshot };
      throw new ChatConflict("这个任务正在回答另一个问题，请稍后再发", snapshot);
    }
    const snapshot = await read(userId, taskId, { includeOperationId: input.operationId });
    return {
      status: "claimed" as const,
      claim: {
        operationId: input.operationId, token, message: input.message,
        memory: snapshot.memory, memoryRevision: snapshot.memoryRevision,
        history: snapshot.messages.filter(message => message.operationId !== input.operationId && !message.status),
      } satisfies ChatClaim,
    };
  }

  async function complete(userId: string, taskId: string, claim: ChatClaim, output: { reply: string; memory?: string }): Promise<ChatSnapshot> {
    requireIdentity(userId, taskId);
    if (typeof output.reply !== "string" || !output.reply.trim() || output.reply.length > MAX_REPLY_LENGTH) throw new ChatError("学习助手返回的回答格式不正确", 502);
    if (output.memory !== undefined && (typeof output.memory !== "string" || output.memory.length > MAX_CHAT_MEMORY_LENGTH)) throw new ChatError("学习助手返回的记忆格式不正确", 502);
    const saved = await repository.complete(userId, taskId, claim, output.reply, output.memory, now());
    if (!saved) {
      const turn = await repository.findTurn(userId, taskId, claim.operationId);
      if (turn?.status !== "complete") throw new ChatConflict("这次回答已超时或任务状态已改变，请重新打开对话", await read(userId, taskId, { includeOperationId: claim.operationId }));
    }
    return read(userId, taskId, { includeOperationId: claim.operationId });
  }

  async function fail(userId: string, taskId: string, claim: ChatClaim, error = "回答未完成，请重试"): Promise<ChatSnapshot> {
    requireIdentity(userId, taskId);
    await repository.fail(userId, taskId, claim, error.slice(0, 500), now());
    return read(userId, taskId, { includeOperationId: claim.operationId });
  }

  async function updateMemory(userId: string, taskId: string, input: { memory: string; baseRevision: number }): Promise<ChatSnapshot> {
    requireIdentity(userId, taskId);
    if (typeof input?.memory !== "string" || input.memory.length > MAX_CHAT_MEMORY_LENGTH) throw new ChatError(`学习记忆最多 ${MAX_CHAT_MEMORY_LENGTH} 个字符`);
    if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) throw new ChatError("学习记忆版本不正确");
    const result = await repository.updateMemory(userId, taskId, input.memory, input.baseRevision, now());
    if (result === "missing") throw new ChatError("这个任务已被删除，请刷新学习清单", 404);
    const snapshot = await read(userId, taskId);
    if (result === "conflict") throw new ChatConflict("学习记忆已更新，请核对最新内容后再保存", snapshot);
    return snapshot;
  }

  async function deleteTask(userId: string, taskId: string): Promise<void> {
    requireIdentity(userId, taskId);
    await repository.deleteTask(userId, taskId);
  }

  async function exportAll(userId: string): Promise<ChatExport[]> {
    requireIdentity(userId);
    const { conversations, turns } = await repository.exportAll(userId);
    const timestamp = now();
    return conversations.map(conversation => ({
      taskId: conversation.taskId, memory: conversation.memory, memoryRevision: conversation.memoryRevision,
      messages: messagesForTurns(turns.filter(turn => turn.taskId === conversation.taskId), conversation, timestamp),
    }));
  }

  return { read, begin, complete, fail, updateMemory, deleteTask, exportAll };
}

export type TaskChatStore = ReturnType<typeof createTaskChatStore>;
