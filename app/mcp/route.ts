import { workspaceStore } from "../../db/workspace-store";
import { handleMcpRequest } from "../../lib/mcp";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleMcpRequest(request, workspaceStore);
}
