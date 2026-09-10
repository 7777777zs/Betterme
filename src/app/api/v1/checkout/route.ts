import { randomUUID } from "node:crypto";
import { z } from "zod";
import { authenticateSession } from "@/lib/auth/authenticate";
import { prisma } from "@/lib/db/prisma";
import { errors } from "@/lib/http/errors";
import { ok, parseJsonBody, withRoute, zodToDetails } from "@/lib/http/respond";
import { payPayloadSchema, processPayment } from "@/lib/subscription/pay";
import { ZodError } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/checkout
 *
 * 浏览器端的「购买」动作。真实产品里这一步会跳转到 Stripe / Paddle，
 * 用户在网关页面付款，网关再从服务端回调 /api/v1/pay。
 *
 * 本项目没有真实网关，所以由这个接口扮演网关的角色。关键在于**没有开后门**：
 *
 * - 它要求 Bearer token，确认调用者确实是这个会话的主人。
 *   少了这一步，任何人都能拿别人的 sessionId 给对方开会员，
 *   或者更糟 —— 给自己开。
 * - 它复用 processPayment，走的是和真实回调一模一样的落库、幂等、
 *   周期计算路径，不是另写一份「演示专用」的开通逻辑。
 * - /api/v1/pay 依然要求 HMAC 签名，没有因为多了这个接口而放宽。
 *
 * 换句话说：这里模拟的是「网关已经收到钱」这个事实，
 * 而不是绕过支付系统本身。
 */

const checkoutSchema = z
  .object({
    sessionId: z.uuid(),
    plan: z.enum(["weekly", "monthly", "quarterly"]),
  })
  .strict();

export const POST = withRoute(async (request: Request) => {
  const raw = await parseJsonBody(request);

  let input;
  try {
    input = checkoutSchema.parse(raw);
  } catch (error) {
    if (error instanceof ZodError) throw errors.validation(zodToDetails(error));
    throw error;
  }

  // 必须先鉴权：确认调用者是这个会话的主人，而不是随便谁拿着 id 来开会员
  await authenticateSession(prisma, input.sessionId, request.headers.get("authorization"));

  const payload = payPayloadSchema.parse({
    sessionId: input.sessionId,
    plan: input.plan,
    idempotencyKey: `checkout_${randomUUID()}`,
    eventType: "CHECKOUT_COMPLETED",
  });

  const result = await processPayment(prisma, payload, {
    ...payload,
    source: "web_checkout",
  });

  return ok({
    ok: true,
    applied: result.applied,
    subscription: result.subscription,
  });
});
