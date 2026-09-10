import { createHmac } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { safeCompareHex } from "@/lib/auth/token";
import { errors } from "@/lib/http/errors";

/**
 * 模拟支付回调。
 *
 * 真实网关（Stripe / Paddle）的回调有三个必须处理的特性，这里全部实现：
 *
 * 1. **签名**：回调来自公网，任何人都能 POST。没有签名校验的 /pay
 *    等于「谁调谁变会员」，整套鉴权直接失效。
 * 2. **幂等**：网关会重发，重发是常态不是异常。同一个 idempotencyKey
 *    落到唯一索引上，第二次插入必然失败，据此识别重放。
 * 3. **留痕**：原始报文进 payment_events，对账时能回放。
 */

export const PLAN_CATALOG = {
  weekly: { days: 7, amountCents: 999 },
  monthly: { days: 30, amountCents: 2999 },
  quarterly: { days: 90, amountCents: 5999 },
} as const;

export type PlanId = keyof typeof PLAN_CATALOG;

export const payPayloadSchema = z
  .object({
    /** 触发支付的测评会话，用于归因并定位用户 */
    sessionId: z.uuid({ message: "sessionId 必须是合法 UUID" }),
    plan: z.enum(["weekly", "monthly", "quarterly"]),
    /**
     * 幂等键。真实场景由网关下发；这里要求调用方提供，
     * 以便测试可以精确地重放同一笔回调。
     */
    idempotencyKey: z.string().min(8).max(128),
    eventType: z
      .enum(["CHECKOUT_COMPLETED", "SUBSCRIPTION_RENEWED"])
      .default("CHECKOUT_COMPLETED"),
    /** 金额必须是正整数分。允许传入以便校验与套餐价一致，防止篡改。 */
    amountCents: z.int().positive().max(1_000_000).optional(),
    currency: z.string().length(3).default("USD"),
  })
  .strict();

export type PayPayload = z.infer<typeof payPayloadSchema>;

/** 对原始请求体计算 HMAC-SHA256 签名，十六进制小写 */
export function signPayload(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/**
 * 校验签名。
 *
 * 必须对**原始字节**计算，不能先 JSON.parse 再 stringify：
 * 键顺序、空格、数字格式的任何差异都会让签名对不上。
 */
export function verifySignature(
  rawBody: string,
  providedSignature: string | null,
  secret: string,
): void {
  if (!providedSignature) {
    throw errors.invalidSignature();
  }
  const expected = signPayload(rawBody, secret);
  if (!safeCompareHex(providedSignature.trim().toLowerCase(), expected)) {
    throw errors.invalidSignature();
  }
}

export interface PayResult {
  /** true 表示这次调用真正开通了订阅；false 表示是一次被识别出的重放 */
  applied: boolean;
  idempotencyKey: string;
  userId: string;
  subscription: {
    status: string;
    plan: string | null;
    currentPeriodEnd: string | null;
  };
}

/** Prisma 唯一约束冲突 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

/**
 * 处理一次支付回调。
 *
 * 幂等的实现方式是「先插流水，靠唯一索引兜底」，
 * 而不是「先查有没有处理过，再决定要不要处理」。
 * 后者在并发重发下有竞态：两个请求可能同时查到「没处理过」。
 * 唯一索引是数据库层面的串行化点，无论并发多少都只有一个能插入成功。
 */
export async function processPayment(
  prisma: PrismaClient,
  payload: PayPayload,
  rawPayload: unknown,
  now: Date = new Date(),
): Promise<PayResult> {
  const session = await prisma.quizSession.findUnique({
    where: { id: payload.sessionId },
    select: { id: true, userId: true },
  });

  if (!session) throw errors.sessionNotFound();

  const plan = PLAN_CATALOG[payload.plan];

  // 传了金额就必须与套餐价一致，防止客户端把 2999 改成 1
  if (payload.amountCents !== undefined && payload.amountCents !== plan.amountCents) {
    throw errors.validation([
      {
        path: "amountCents",
        message: `与套餐 ${payload.plan} 的价格 ${plan.amountCents} 不符`,
      },
    ]);
  }

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.paymentEvent.create({
        data: {
          idempotencyKey: payload.idempotencyKey,
          userId: session.userId,
          sessionId: session.id,
          provider: "mock",
          eventType: payload.eventType,
          amountCents: plan.amountCents,
          currency: payload.currency.toUpperCase(),
          rawPayload: rawPayload as Prisma.InputJsonValue,
          processedAt: now,
        },
      });

      // 续费应当从当前周期末顺延，而不是从今天重新起算，
      // 否则提前续费的用户会白白损失剩余天数。
      const existing = await tx.subscription.findUnique({
        where: { userId: session.userId },
        select: { currentPeriodEnd: true },
      });

      const anchor =
        existing?.currentPeriodEnd && existing.currentPeriodEnd.getTime() > now.getTime()
          ? existing.currentPeriodEnd
          : now;

      const periodEnd = new Date(anchor.getTime() + plan.days * 24 * 3600 * 1000);

      const subscription = await tx.subscription.upsert({
        where: { userId: session.userId },
        create: {
          userId: session.userId,
          status: "ACTIVE",
          plan: payload.plan,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          activatedAt: now,
        },
        update: {
          status: "ACTIVE",
          plan: payload.plan,
          currentPeriodStart: existing?.currentPeriodEnd ?? now,
          currentPeriodEnd: periodEnd,
          activatedAt: now,
          canceledAt: null,
        },
      });

      return {
        applied: true,
        idempotencyKey: payload.idempotencyKey,
        userId: session.userId,
        subscription: {
          status: subscription.status,
          plan: subscription.plan,
          currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
        },
      };
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    // 重放：返回当前订阅状态，HTTP 200。
    // 对网关来说「已经处理过」和「刚刚处理成功」都是成功，
    // 返回错误码只会让网关继续重试。
    const subscription = await prisma.subscription.findUnique({
      where: { userId: session.userId },
    });

    return {
      applied: false,
      idempotencyKey: payload.idempotencyKey,
      userId: session.userId,
      subscription: {
        status: subscription?.status ?? "NONE",
        plan: subscription?.plan ?? null,
        currentPeriodEnd: subscription?.currentPeriodEnd?.toISOString() ?? null,
      },
    };
  }
}
