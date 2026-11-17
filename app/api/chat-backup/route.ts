import { getChatGPTUser } from "../../chatgpt-auth";
import { taskChatStore } from "../../../db/task-chat";

export const dynamic = "force-dynamic";

export async function GET(request?: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "请先登录，再导出学习对话" }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
  const headers = { "Cache-Control": "private, no-store", "X-Study-User": user.userId };
  const expectedUser = request?.headers.get("x-study-user-key");
  if (expectedUser && expectedUser !== user.userId) return Response.json({ error: "登录账号已切换，请刷新页面后重新导出对话" }, { status: 401, headers });
  try {
    return Response.json({ conversations: await taskChatStore.exportAll(user.userId) }, { headers });
  } catch {
    return Response.json({ error: "学习对话暂时无法导出，请稍后重试" }, { status: 503, headers });
  }
}
