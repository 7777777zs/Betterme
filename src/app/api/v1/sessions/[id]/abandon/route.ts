import { authenticateSession } from "@/lib/auth/authenticate";
import { prisma } from "@/lib/db/prisma";
import { errors } from "@/lib/http/errors";
import { ok, withRoute } from "@/lib/http/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/sessions/:id/abandon
 *
 * 主动作废一次未完成的测评。用户点「重新开始」时调用。
 *
 * 加这个接口不只是为了前端好写。schema 里的 SessionStatus 有三个值，
 * 但在此之前 ABANDONED 从来没有任何写入路径 —— 一个声明了却永远不会出现的
 * 状态，对读代码的人是纯粹的误导：它会让人以为存在某个作废流程，
 * 然后花时间去找那段并不存在的代码。
 *
 * 要么删掉这个枚举值，要么给它一个真实的写入方。这里选后者，
 * 因为「用户主动重来」本来就是这个状态该表达的语义。
 */
export const POST = withRoute(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;

  const { session } = await authenticateSession(
    prisma,
    id,
    request.headers.get("authorization"),
  );

  // 已出结果的会话不该被作废：结果页可能已经被分享出去，
  // 订阅也可能已经挂在这次测评上。
  if (session.status === "COMPLETED") {
    throw errors.sessionAlreadyCompleted();
  }

  // 已经是 ABANDONED 就直接返回。重复点击「重新开始」是常态，
  // 第二次调用不该报错。
  if (session.status === "ABANDONED") {
    return ok({ sessionId: id, status: session.status, changed: false });
  }

  const updated = await prisma.quizSession.update({
    where: { id },
    data: {
      status: "ABANDONED",
      currentStep: null,
      version: { increment: 1 },
    },
    select: { status: true },
  });

  return ok({ sessionId: id, status: updated.status, changed: true });
});
