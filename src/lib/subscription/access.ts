import type { Subscription } from "@/generated/prisma/client";

export type AccessLevel = "FREE" | "PREMIUM";

/**
 * 判定用户当前是否享有付费权限。
 *
 * 刻意不只看 status 字段。`status = ACTIVE` 但 `currentPeriodEnd` 已过去
 * 是真实系统里非常常见的一种状态：续费失败、定时任务没跑、时钟漂移。
 * 只认 status 的实现会把这些人当会员，白送内容。
 *
 * 反过来也一样：periodEnd 在未来但 status 是 CANCELED，说明用户已取消，
 * 按业务约定这里仍视为有效（已付费周期内不应被剥夺权益）。
 * 这条规则写在测试里，避免日后有人「顺手」改掉。
 */
export function resolveAccessLevel(
  subscription: Pick<Subscription, "status" | "currentPeriodEnd"> | null,
  now: Date = new Date(),
): AccessLevel {
  if (!subscription) return "FREE";

  const { status, currentPeriodEnd } = subscription;

  if (status === "NONE" || status === "EXPIRED") return "FREE";

  // ACTIVE 与 CANCELED 都要看周期末，没有周期末视为无效
  if (!currentPeriodEnd) return "FREE";

  return currentPeriodEnd.getTime() > now.getTime() ? "PREMIUM" : "FREE";
}

export function isPremium(
  subscription: Pick<Subscription, "status" | "currentPeriodEnd"> | null,
  now: Date = new Date(),
): boolean {
  return resolveAccessLevel(subscription, now) === "PREMIUM";
}
