import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { readChatInput } from "../../../../lib/chat-request";
import { ChatError, MAX_CHAT_MEMORY_LENGTH, MAX_CHAT_MESSAGE_LENGTH } from "../../../../lib/task-chat";

export const dynamic = "force-dynamic";
const validId = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const taskExists = `EXISTS (
  SELECT 1 FROM study_workspaces w, json_each(w.state_json, '$.tasks') task
  WHERE w.user_id = ? AND json_extract(task.value, '$.id') = ?
)`;
const conflictingTurn = `EXISTS (
  SELECT 1 FROM json_each(?) source JOIN task_chat_turns saved
    ON saved.user_id = ? AND saved.task_id = ? AND saved.operation_id = json_extract(source.value, '$.operationId')
  WHERE saved.message IS NOT json_extract(source.value, '$.message')
    OR saved.reply IS NOT json_extract(source.value, '$.reply')
    OR saved.created_at IS NOT json_extract(source.value, '$.createdAt')
    OR saved.finished_at IS NOT json_extract(source.value, '$.finishedAt')
)`;
const writable = `${taskExists}
  AND NOT EXISTS (SELECT 1 FROM task_chat_conversations WHERE user_id = ? AND task_id = ? AND lease_until > ?)
  AND NOT ${conflictingTurn}`;

type BackupTurn = {
  operationId: string;
  message: string;
  reply: string | null;
  createdAt: number;
  finishedAt: number;
};

export async function POST(request: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  try {
    const user = await getChatGPTUser();
    if (!user) throw new ChatError("请先登录，再恢复学习对话", 401);
    const expectedUser = request.headers.get("x-study-user-key");
    if (expectedUser && expectedUser !== user.userId) throw new ChatError("登录账号已切换，请刷新页面后继续恢复", 401);
    // One maximal valid turn can use 792 KB after JSON escaping and memory.
    const data = await readChatInput(request, ["taskId", "memory", "turns"], 850_000);
    if (!validId(data.taskId) || typeof data.memory !== "string"
      || data.memory.length > MAX_CHAT_MEMORY_LENGTH
      || !Array.isArray(data.turns) || data.turns.length > 20) {
      throw new ChatError("备份对话格式不正确");
    }
    const turns = data.turns as BackupTurn[];
    const operations = new Set<string>();
    for (const turn of turns) {
      if (!turn || !validId(turn.operationId)
        || typeof turn.message !== "string" || !turn.message.trim()
        || turn.message.length > MAX_CHAT_MESSAGE_LENGTH
        || !(turn.reply === null || typeof turn.reply === "string" && turn.reply.length <= 100_000)
        || !Number.isSafeInteger(turn.createdAt) || turn.createdAt < 0
        || !Number.isSafeInteger(turn.finishedAt) || turn.finishedAt < turn.createdAt
        || turn.finishedAt > 8_000_000_000_000) {
        throw new ChatError("备份消息格式不正确");
      }
      if (operations.has(turn.operationId)) throw new ChatError("备份中存在重复的提问标识");
      operations.add(turn.operationId);
    }
    if (!env.DB) throw new ChatError("学习对话数据库暂时无法连接", 503);
    const now = Date.now();
    const source = JSON.stringify(turns);
    const guardValues = [user.userId, data.taskId, user.userId, data.taskId, now, source, user.userId, data.taskId];
    // Every write checks the complete batch before inserting anything. A busy
    // conversation or an ID collision cannot leave a partially restored batch.
    const statements = [env.DB.prepare(`
      INSERT INTO task_chat_conversations (user_id, task_id, memory, memory_revision, updated_at)
      SELECT ?, ?, ?, 0, ? WHERE ${writable}
      ON CONFLICT (user_id, task_id) DO NOTHING
    `).bind(user.userId, data.taskId, data.memory, now, ...guardValues)];
    for (const turn of turns) {
      statements.push(env.DB.prepare(`
        INSERT INTO task_chat_turns
          (user_id, task_id, operation_id, message, reply, status, lease_token, created_at, finished_at)
        SELECT ?, ?, ?, ?, ?, ?, 'restored', ?, ?
        WHERE ${writable}
        ON CONFLICT (user_id, task_id, operation_id) DO NOTHING
      `).bind(user.userId, data.taskId, turn.operationId, turn.message, turn.reply,
        turn.reply === null ? "failed" : "complete", turn.createdAt, turn.finishedAt, ...guardValues));
    }
    statements.push(env.DB.prepare(`SELECT ${taskExists} AS task_exists,
      COALESCE((SELECT lease_until FROM task_chat_conversations WHERE user_id = ? AND task_id = ?), 0) AS lease_until,
      ${conflictingTurn} AS conflicting_turn`).bind(user.userId, data.taskId, user.userId, data.taskId, source, user.userId, data.taskId));
    const results = await env.DB.batch(statements);
    const conversation = results.at(-1)?.results[0] as {
      task_exists: number; lease_until: number; conflicting_turn: number;
    } | undefined;
    if (!conversation?.task_exists) throw new ChatError("请先完成任务恢复和同步，再恢复对话", 409);
    if (conversation.lease_until > now) throw new ChatError("该任务正在生成回答，请稍后继续恢复", 409);
    if (conversation.conflicting_turn) throw new ChatError("同一提问标识已有不同内容，请重新选择备份恢复副本", 409);
    return Response.json({ restored: true }, { headers });
  } catch (error) {
    return Response.json({
      error: error instanceof ChatError ? error.message : "对话恢复尚未完成，可以重试继续恢复",
    }, { status: error instanceof ChatError ? error.status : 503, headers });
  }
}
