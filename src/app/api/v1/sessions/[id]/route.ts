import { authenticateSession } from "@/lib/auth/authenticate";
import { prisma } from "@/lib/db/prisma";
import { ok, withRoute } from "@/lib/http/respond";
import { getSessionState } from "@/lib/quiz/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/v1/sessions/:id
 *
 * 进度恢复。用户关掉页面再回来时，前端用这个响应还原整个表单。
 * 会话过期也允许读取（只是不能再写），否则用户连自己填过什么都看不到。
 */
export const GET = withRoute(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await authenticateSession(prisma, id, request.headers.get("authorization"));
  const state = await getSessionState(prisma, id);
  return ok(state);
});
