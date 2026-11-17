import { env, waitUntil } from "cloudflare:workers";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import { workspaceStore } from "../../../../../db/workspace-store";
import { taskChatStore } from "../../../../../db/task-chat";
import { ChatConflict, ChatError, type ChatSnapshot } from "../../../../../lib/task-chat";
import { answerStudyQuestion, DEFAULT_STUDY_MODEL } from "../../../../../lib/task-chat-model";
import { readChatInput } from "../../../../../lib/chat-request";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ taskId: string }> };

function configuration() {
  return { apiKey: env.OPENAI_API_KEY?.trim() ?? "", model: env.OPENAI_MODEL?.trim() || DEFAULT_STUDY_MODEL };
}

function json(payload: unknown, status = 200) {
  return Response.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

function envelope(snapshot: ChatSnapshot) {
  const config = configuration();
  return { ...snapshot, providerConfigured: !!config.apiKey, model: config.model };
}

function failure(error: unknown) {
  if (error instanceof ChatConflict) return json({ ...envelope(error.snapshot), error: error.message }, error.status);
  if (error instanceof ChatError) return json({ error: error.message }, error.status);
  return json({ error: "暂时无法读取或保存学习对话，请稍后重试" }, 503);
}

async function taskContext(context: Context, request: Request) {
  const user = await getChatGPTUser();
  if (!user) throw new ChatError("请先登录，再打开学习对话", 401);
  const expectedUser = request.headers.get("x-study-user-key");
  if (expectedUser && expectedUser !== user.userId) throw new ChatError("登录账号已切换，请刷新页面后继续学习", 401);
  const { taskId } = await context.params;
  const workspace = await workspaceStore.read(user.userId);
  const task = workspace.state.tasks.find(item => item.id === taskId);
  if (!task) throw new ChatError("这个任务暂时无法找到，请等待同步完成或刷新学习清单", 404);
  const projectTitle = workspace.state.projects.find(project => project.id === task.projectId)?.title ?? "";
  const relatedNotes = (workspace.state.notes ?? []).filter(note => note.taskId === task.id);
  return { userId: user.userId, task, projectTitle, relatedNotes };
}

export async function GET(request: Request, context: Context) {
  try {
    const { userId, task } = await taskContext(context, request);
    const before = new URL(request.url).searchParams.get("before") ?? undefined;
    return json(envelope(await taskChatStore.read(userId, task.id, { before })));
  } catch (error) { return failure(error); }
}

export async function POST(request: Request, context: Context) {
  try {
    const { userId, task, projectTitle, relatedNotes } = await taskContext(context, request);
    const payload = await readChatInput(request, ["operationId", "message", "selectedNoteIds", "excerpt"]);
    if (payload.selectedNoteIds !== undefined && (!Array.isArray(payload.selectedNoteIds) || payload.selectedNoteIds.length > 20 || payload.selectedNoteIds.some(id => typeof id !== "string" || !relatedNotes.some(note => note.id === id)))) throw new ChatError("引用的笔记已变化，请重新选择当前任务的笔记");
    if (payload.excerpt !== undefined && (typeof payload.excerpt !== "string" || payload.excerpt.length > 20_000)) throw new ChatError("引用段落最多20000个字符");
    const config = configuration();
    if (!config.apiKey) throw new ChatError("学习助手的 OpenAI 服务尚待配置", 503);
    const result = await taskChatStore.begin(userId, task.id, { operationId: payload.operationId as string, message: payload.message as string });
    if (result.status !== "claimed") return json(envelope(result.snapshot), result.status === "pending" ? 202 : 200);
    const modelInput = {
      config, task, projectTitle, relatedNotes, claim: result.claim,
      selectedNoteIds: payload.selectedNoteIds as string[] | undefined,
      excerpt: payload.excerpt as string | undefined,
    };
    if (request.headers.get("accept")?.includes("text/event-stream")) {
      const encoder = new TextEncoder();
      let closed = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          function send(event: string, data: unknown) {
            if (closed) return;
            try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); }
            catch { closed = true; }
          }
          const heartbeat = setInterval(() => send("heartbeat", {}), 15_000);
          const work = (async () => {
            try {
              send("started", { operationId: result.claim.operationId });
              const answer = await answerStudyQuestion({ ...modelInput, onDelta: text => send("delta", { text }) });
              const snapshot = await taskChatStore.complete(userId, task.id, result.claim, answer);
              send("complete", { ...envelope(snapshot), memoryWarning: answer.memoryWarning });
            } catch (error) {
              if (error instanceof ChatConflict) send("error", { ...envelope(error.snapshot), error: error.message });
              else {
                let snapshot: ChatSnapshot | undefined;
                try { snapshot = await taskChatStore.fail(userId, task.id, result.claim); } catch { /* The lease permits a later safe retry. */ }
                send("error", { ...(snapshot ? envelope(snapshot) : {}), error: error instanceof ChatError ? error.message : "这次回答未保存，请重新连接后重试这个问题" });
              }
            } finally {
              clearInterval(heartbeat);
              if (!closed) { closed = true; controller.close(); }
            }
          })();
          // Preserve the in-flight save after the viewer disconnects.
          waitUntil(work);
        },
        cancel() { closed = true; },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "private, no-store", "X-Accel-Buffering": "no" } });
    }
    try {
      const answer = await answerStudyQuestion(modelInput);
      return json({ ...envelope(await taskChatStore.complete(userId, task.id, result.claim, answer)), memoryWarning: answer.memoryWarning });
    } catch (error) {
      if (error instanceof ChatConflict) return failure(error);
      const snapshot = await taskChatStore.fail(userId, task.id, result.claim);
      const message = error instanceof ChatError ? error.message : "回答保存未完成，请重新连接后重试这个问题";
      return json({ ...envelope(snapshot), error: message }, error instanceof ChatError ? error.status : 503);
    }
  } catch (error) { return failure(error); }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const { userId, task } = await taskContext(context, request);
    const payload = await readChatInput(request, ["memory", "baseRevision"]);
    return json(envelope(await taskChatStore.updateMemory(userId, task.id, payload as { memory: string; baseRevision: number })));
  } catch (error) { return failure(error); }
}
