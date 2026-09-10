import { authenticateSession } from "@/lib/auth/authenticate";
import { prisma } from "@/lib/db/prisma";
import { errors } from "@/lib/http/errors";
import { ok, withRoute } from "@/lib/http/respond";
import { resolveAccessLevel } from "@/lib/subscription/access";
import { PLAN_CATALOG } from "@/lib/subscription/pay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/me/subscription?sessionId=...
 *
 * 查询当前订阅状态。前端用它决定是否弹付费墙，
 * 以及支付完成后轮询确认状态已生效。
 *
 * 身份仍然由 sessionId + token 这一对确定，没有独立的用户端点，
 * 因为本系统里用户是匿名的，会话就是他唯一的入口。
 */
export const GET = withRoute(async (request: Request) => {
  const sessionId = new URL(request.url).searchParams.get("sessionId");

  if (!sessionId) {
    throw errors.validation([{ path: "sessionId", message: "查询参数 sessionId 必填" }]);
  }

  const { subscription } = await authenticateSession(
    prisma,
    sessionId,
    request.headers.get("authorization"),
  );

  const access = resolveAccessLevel(subscription);

  return ok({
    access,
    status: subscription?.status ?? "NONE",
    plan: subscription?.plan ?? null,
    currentPeriodEnd: subscription?.currentPeriodEnd?.toISOString() ?? null,
    availablePlans: Object.entries(PLAN_CATALOG).map(([id, plan]) => ({
      id,
      days: plan.days,
      amountCents: plan.amountCents,
      currency: "USD",
    })),
  });
});
