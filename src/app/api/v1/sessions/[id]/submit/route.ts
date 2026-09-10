import { assertWritable, authenticateSession } from "@/lib/auth/authenticate";
import { prisma } from "@/lib/db/prisma";
import { ok, withRoute } from "@/lib/http/respond";
import { submitSession } from "@/lib/quiz/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/sessions/:id/submit
 *
 * 触发服务端计算。用 POST 而不是 PUT：这是一个动作，不是资源写入，
 * 且不幂等于「同样的请求产生同样的资源状态」——虽然实现上做了幂等保护。
 *
 * 重复提交已完成的会话直接返回既有结果，不重算也不报错。
 */
export const POST = withRoute(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { session } = await authenticateSession(
    prisma,
    id,
    request.headers.get("authorization"),
  );

  // 已完成的会话走幂等分支，所以只在未完成时检查可写性
  if (session.status !== "COMPLETED") {
    assertWritable(session);
  }

  const { resultId, recomputed } = await submitSession(prisma, id);

  return ok({
    sessionId: id,
    resultId,
    recomputed,
    resultUrl: `/api/v1/sessions/${id}/result`,
  });
});
