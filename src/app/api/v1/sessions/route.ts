import { prisma } from "@/lib/db/prisma";
import { created, withRoute } from "@/lib/http/respond";
import { STEP_DEFINITIONS } from "@/lib/quiz/steps";
import { createSession } from "@/lib/quiz/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/sessions
 *
 * 创建匿名用户与测评会话。响应里的 token 是唯一一次明文出现，
 * 客户端需要自行保存（localStorage），服务端只留摘要。
 *
 * 顺带把步骤定义一起返回，前端不必再单独请求一次配置。
 */
export const POST = withRoute(async () => {
  const session = await createSession(prisma);

  return created({
    ...session,
    steps: STEP_DEFINITIONS,
  });
});
