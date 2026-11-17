import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import { workspaceStore } from "../../../../../db/workspace-store";
import { taskChatStore } from "../../../../../db/task-chat";
import { ChatError } from "../../../../../lib/task-chat";
import { readChatInput } from "../../../../../lib/chat-request";
import { DEFAULT_STUDY_MODEL, generateStudyQuiz } from "../../../../../lib/task-chat-model";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
  try {
    const user = await getChatGPTUser();
    if (!user) throw new ChatError("请先登录，再生成自测题", 401);
    const expectedUser = request.headers.get("x-study-user-key");
    if (expectedUser && expectedUser !== user.userId) throw new ChatError("登录账号已切换，请刷新页面后继续学习", 401);
    const { taskId } = await context.params;
    const workspace = await workspaceStore.read(user.userId);
    const task = workspace.state.tasks.find(item => item.id === taskId);
    if (!task) throw new ChatError("这个任务已变化，请刷新后重试", 404);
    const payload = await readChatInput(request, ["noteId", "sourceText"]);
    if (payload.noteId !== undefined && (typeof payload.noteId !== "string" || payload.noteId.length > 200)) throw new ChatError("笔记标识不正确");
    if (payload.sourceText !== undefined && (typeof payload.sourceText !== "string" || !payload.sourceText.trim() || payload.sourceText.length > 20_000)) throw new ChatError("自测材料应为1到20000个字符");
    let sourceText = payload.sourceText as string | undefined;
    if (payload.noteId !== undefined) {
      const note = (workspace.state.notes ?? []).find(item => item.id === payload.noteId && item.taskId === task.id);
      if (!note) throw new ChatError("这篇笔记不属于当前任务，请重新选择", 404);
      sourceText = [note.title, sourceText ?? note.body].join("\n\n");
    }
    if (sourceText === undefined) {
      const conversation = await taskChatStore.read(user.userId, task.id);
      sourceText = [task.notes, ...conversation.messages.filter(message => !message.status).slice(-12).map(message => message.content)].join("\n\n");
    }
    if (!sourceText.trim()) throw new ChatError("请先补充笔记或完成一轮学习对话", 422);
    const questions = await generateStudyQuiz({
      config: { apiKey: env.OPENAI_API_KEY?.trim() ?? "", model: env.OPENAI_MODEL?.trim() || DEFAULT_STUDY_MODEL },
      taskTitle: task.title, sourceText,
    });
    return json({ questions });
  } catch (error) {
    return json({ error: error instanceof ChatError ? error.message : "自测题暂时无法生成，请稍后重试" }, error instanceof ChatError ? error.status : 503);
  }
}
