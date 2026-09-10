import { authenticateSession } from "@/lib/auth/authenticate";
import { prisma } from "@/lib/db/prisma";
import { serializeResult } from "@/lib/dto/result";
import { errors } from "@/lib/http/errors";
import { ok, withRoute } from "@/lib/http/respond";
import { resolveAccessLevel } from "@/lib/subscription/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/v1/sessions/:id/result
 *
 * 结果页。订阅鉴权与差异化返回都发生在这里。
 *
 * 返回 200 而不是 402：结果页本身对所有人可访问，只是内容分级。
 * 402 会让前端把它当成错误分支处理，而付费墙其实是正常的产品形态。
 * 客户端通过响应体里的 access 字段判断该渲染完整视图还是遮罩视图。
 *
 * 非会员的响应里，受保护字段是不存在的键，不是 null。
 * 序列化逻辑见 src/lib/dto/result.ts 的注释。
 */
export const GET = withRoute(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;

  const { subscription } = await authenticateSession(
    prisma,
    id,
    request.headers.get("authorization"),
  );

  const result = await prisma.assessmentResult.findUnique({
    where: { sessionId: id },
  });

  if (!result) throw errors.resultNotReady();

  const access = resolveAccessLevel(subscription);

  return ok(serializeResult(result, access));
});
