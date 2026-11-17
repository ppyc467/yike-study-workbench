import { getChatGPTUser } from "../../chatgpt-auth";
import { workspaceStore } from "../../../db/workspace-store";
import { StudyError } from "../../../lib/study";
import { WorkspaceConflict } from "../../../lib/workspace-store";

export const dynamic = "force-dynamic";
const MAX_BODY_BYTES = 384_000;

function json(payload: unknown, status = 200, userId?: string) {
  const revision = (payload as { revision?: number } | null)?.revision;
  return Response.json(payload, { status, headers: { "Cache-Control": "private, no-store", ...(userId ? { "X-Study-User": userId } : {}), ...(typeof revision === "number" ? { ETag: `"workspace-${revision}"` } : {}) } });
}

export async function GET(request?: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: "请先登录，再查看云端学习进度" }, 401);
  const expectedUser = request?.headers.get("x-study-user-key");
  if (expectedUser && expectedUser !== user.userId) return json({ error: "登录账号已切换，请刷新页面后继续学习" }, 401, user.userId);
  try {
    const conditional = request?.headers.get("if-none-match");
    if (conditional) {
      const version = await workspaceStore.readVersion(user.userId);
      const etag = `"workspace-${version.revision}"`;
      if (conditional === etag) return new Response(null, { status: 304, headers: { "Cache-Control": "private, no-store", ETag: etag, "X-Study-User": user.userId } });
    }
    return json(await workspaceStore.read(user.userId), 200, user.userId);
  } catch {
    return json({ error: "暂时无法读取云端进度，请稍后重试" }, 503, user.userId);
  }
}

/** Read with a hard streaming limit, including when Content-Length is absent. */
async function readBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) throw new StudyError("一次同步的内容过大，请减少笔记内容后重试");
  if (!request.body) throw new StudyError("请求内容不能为空");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new StudyError("一次同步的内容过大，请减少笔记内容后重试");
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  body += decoder.decode();
  try { return JSON.parse(body); } catch { throw new StudyError("请求内容不是有效的 JSON"); }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: "请先登录，再同步学习进度" }, 401);
  const expectedUser = request.headers.get("x-study-user-key");
  if (expectedUser && expectedUser !== user.userId) return json({ error: "登录账号已切换，本机草稿已保留，请刷新页面后继续" }, 401, user.userId);
  // Browsers set Origin on same-origin POSTs; never accept a foreign-origin write.
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site") {
    return json({ error: "此同步请求的来源无效" }, 403, user.userId);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ error: "请使用 JSON 同步学习进度" }, 415, user.userId);
  try {
    const payload = await readBody(request);
    return json(await workspaceStore.mutate(user.userId, payload), 200, user.userId);
  } catch (error) {
    if (error instanceof WorkspaceConflict) return json({ ...error.snapshot, error: error.message }, 409, user.userId);
    if (error instanceof StudyError) return json({ error: error.message }, 422, user.userId);
    return json({ error: "暂时无法同步到云端，本机进度可稍后重试" }, 503, user.userId);
  }
}
