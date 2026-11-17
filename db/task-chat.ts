import { env } from "cloudflare:workers";
import {
  createTaskChatStore,
  type ChatConversation,
  type ChatTurn,
  type TaskChatRepository,
} from "../lib/task-chat";

const CONVERSATION_COLUMNS = `user_id AS userId, task_id AS taskId, memory,
  memory_revision AS memoryRevision, active_operation_id AS activeOperationId,
  lease_token AS leaseToken, lease_until AS leaseUntil, updated_at AS updatedAt`;
const TURN_COLUMNS = `id, user_id AS userId, task_id AS taskId, operation_id AS operationId,
  message, reply, status, lease_token AS leaseToken, created_at AS createdAt,
  finished_at AS finishedAt, error`;
const TASK_EXISTS = `EXISTS (
  SELECT 1 FROM study_workspaces w, json_each(w.state_json, '$.tasks') task
  WHERE w.user_id = ? AND json_extract(task.value, '$.id') = ?
)`;

function database(): D1Database {
  if (!env.DB) throw new Error("学习对话数据库暂时无法连接");
  return env.DB;
}

function ensureConversation(userId: string, taskId: string, now: number) {
  return database().prepare(`
    INSERT INTO task_chat_conversations (user_id, task_id, updated_at)
    SELECT ?, ?, ? WHERE ${TASK_EXISTS}
    ON CONFLICT (user_id, task_id) DO NOTHING
  `).bind(userId, taskId, now, userId, taskId);
}

const repository: TaskChatRepository = {
  async readConversation(userId, taskId) {
    return await database().prepare(`SELECT ${CONVERSATION_COLUMNS}
      FROM task_chat_conversations WHERE user_id = ? AND task_id = ?`)
      .bind(userId, taskId).first<ChatConversation>() ?? undefined;
  },

  async readPage(userId, taskId, options) {
    const db = database();
    const before = options.before ?? Number.MAX_SAFE_INTEGER;
    // D1 batches provide a transactionally consistent view of messages, memory and the generation lease.
    const [conversations, turns, included] = await db.batch([
      db.prepare(`SELECT ${CONVERSATION_COLUMNS} FROM task_chat_conversations WHERE user_id = ? AND task_id = ?`)
        .bind(userId, taskId),
      db.prepare(`SELECT ${TURN_COLUMNS} FROM task_chat_turns
        WHERE user_id = ? AND task_id = ? AND id < ? ORDER BY id DESC LIMIT ?`)
        .bind(userId, taskId, before, options.limit),
      db.prepare(`SELECT ${TURN_COLUMNS} FROM task_chat_turns WHERE user_id = ? AND task_id = ?
        AND operation_id = COALESCE(?, (SELECT active_operation_id FROM task_chat_conversations
          WHERE user_id = ? AND task_id = ?))`)
        .bind(userId, taskId, options.includeOperationId ?? null, userId, taskId),
    ]);
    return {
      conversation: conversations.results[0] as ChatConversation | undefined,
      turns: turns.results as ChatTurn[],
      includedTurn: included.results[0] as ChatTurn | undefined,
    };
  },

  async findTurn(userId, taskId, operationId) {
    return await database().prepare(`SELECT ${TURN_COLUMNS} FROM task_chat_turns
      WHERE user_id = ? AND task_id = ? AND operation_id = ?`)
      .bind(userId, taskId, operationId).first<ChatTurn>() ?? undefined;
  },

  async claim(userId, taskId, input) {
    const db = database();
    const results = await db.batch([
      ensureConversation(userId, taskId, input.now),
      db.prepare(`UPDATE task_chat_turns SET status = 'failed', error = '回答超时，请重试'
        WHERE user_id = ? AND task_id = ? AND status = 'pending'
        AND EXISTS (SELECT 1 FROM task_chat_conversations c
          WHERE c.user_id = ? AND c.task_id = ? AND c.lease_until <= ?
          AND c.active_operation_id = task_chat_turns.operation_id)
      `).bind(userId, taskId, userId, taskId, input.now),
      db.prepare(`UPDATE task_chat_conversations
        SET active_operation_id = ?, lease_token = ?, lease_until = ?, updated_at = ?
        WHERE user_id = ? AND task_id = ?
        AND (active_operation_id IS NULL OR lease_until <= ?)
        AND NOT EXISTS (SELECT 1 FROM task_chat_turns
          WHERE user_id = ? AND task_id = ? AND operation_id = ?
          AND (status = 'complete' OR message <> ?))
        AND ${TASK_EXISTS}
      `).bind(input.operationId, input.token, input.leaseUntil, input.now, userId, taskId,
        input.now, userId, taskId, input.operationId, input.message, userId, taskId),
      db.prepare(`INSERT INTO task_chat_turns
        (user_id, task_id, operation_id, message, status, lease_token, created_at)
        SELECT ?, ?, ?, ?, 'pending', ?, ? FROM task_chat_conversations
        WHERE user_id = ? AND task_id = ? AND lease_token = ?
        ON CONFLICT (user_id, task_id, operation_id) DO UPDATE
        SET status = 'pending', lease_token = excluded.lease_token, finished_at = NULL, error = NULL
        WHERE task_chat_turns.status <> 'complete' AND task_chat_turns.message = excluded.message
      `).bind(userId, taskId, input.operationId, input.message, input.token, input.now,
        userId, taskId, input.token),
    ]);
    if (results[2].meta.changes > 0 && results[3].meta.changes > 0) return "claimed";
    const existing = await this.findTurn(userId, taskId, input.operationId);
    if (existing?.status === "complete") return "complete";
    const conversation = await this.readConversation(userId, taskId);
    return conversation ? "busy" : "missing";
  },

  async complete(userId, taskId, claim, reply, memory, now) {
    const db = database();
    const results = await db.batch([
      db.prepare(`UPDATE task_chat_turns SET status = 'complete', reply = ?, finished_at = ?, error = NULL
        WHERE user_id = ? AND task_id = ? AND operation_id = ? AND lease_token = ? AND status = 'pending'
        AND EXISTS (SELECT 1 FROM task_chat_conversations c WHERE c.user_id = ? AND c.task_id = ?
          AND c.lease_token = ? AND c.active_operation_id = ? AND c.lease_until > ?)
      `).bind(reply, now, userId, taskId, claim.operationId, claim.token,
        userId, taskId, claim.token, claim.operationId, now),
      db.prepare(`UPDATE task_chat_conversations SET
        memory = CASE WHEN memory_revision = ? AND ? IS NOT NULL THEN ? ELSE memory END,
        memory_revision = CASE WHEN memory_revision = ? AND ? IS NOT NULL THEN memory_revision + 1 ELSE memory_revision END,
        active_operation_id = NULL, lease_token = NULL, lease_until = 0, updated_at = ?
        WHERE user_id = ? AND task_id = ? AND lease_token = ?
        AND EXISTS (SELECT 1 FROM task_chat_turns WHERE user_id = ? AND task_id = ?
          AND operation_id = ? AND lease_token = ? AND status = 'complete')
      `).bind(claim.memoryRevision, memory ?? null, memory ?? null, claim.memoryRevision,
        memory ?? null, now, userId, taskId, claim.token, userId, taskId, claim.operationId, claim.token),
    ]);
    return results[0].meta.changes > 0;
  },

  async fail(userId, taskId, claim, error, now) {
    const db = database();
    const results = await db.batch([
      db.prepare(`UPDATE task_chat_turns SET status = 'failed', error = ?
        WHERE user_id = ? AND task_id = ? AND operation_id = ? AND lease_token = ? AND status = 'pending'
        AND EXISTS (SELECT 1 FROM task_chat_conversations c
          WHERE c.user_id = ? AND c.task_id = ? AND c.lease_token = ?)
      `).bind(error, userId, taskId, claim.operationId, claim.token, userId, taskId, claim.token),
      db.prepare(`UPDATE task_chat_conversations SET active_operation_id = NULL,
        lease_token = NULL, lease_until = 0, updated_at = ?
        WHERE user_id = ? AND task_id = ? AND lease_token = ?
      `).bind(now, userId, taskId, claim.token),
    ]);
    return results[0].meta.changes > 0;
  },

  async updateMemory(userId, taskId, memory, baseRevision, now) {
    const db = database();
    const results = await db.batch([
      ensureConversation(userId, taskId, now),
      db.prepare(`UPDATE task_chat_conversations SET memory = ?, memory_revision = memory_revision + 1,
        updated_at = ? WHERE user_id = ? AND task_id = ? AND memory_revision = ? AND ${TASK_EXISTS}
      `).bind(memory, now, userId, taskId, baseRevision, userId, taskId),
    ]);
    if (results[1].meta.changes > 0) return "saved";
    return await this.readConversation(userId, taskId) ? "conflict" : "missing";
  },

  async deleteTask(userId, taskId) {
    await database().prepare("DELETE FROM task_chat_conversations WHERE user_id = ? AND task_id = ?")
      .bind(userId, taskId).run();
  },

  async exportAll(userId) {
    const db = database();
    const [conversations, turns] = await db.batch([
      db.prepare(`SELECT ${CONVERSATION_COLUMNS} FROM task_chat_conversations WHERE user_id = ? ORDER BY task_id`)
        .bind(userId),
      db.prepare(`SELECT ${TURN_COLUMNS} FROM task_chat_turns WHERE user_id = ? ORDER BY id`)
        .bind(userId),
    ]);
    return { conversations: conversations.results as ChatConversation[], turns: turns.results as ChatTurn[] };
  },
};

export const taskChatStore = createTaskChatStore({ repository });
