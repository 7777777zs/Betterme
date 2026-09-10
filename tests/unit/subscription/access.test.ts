import { describe, expect, it } from "vitest";
import type { Subscription } from "@/generated/prisma/client";
import { isPremium, resolveAccessLevel } from "@/lib/subscription/access";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const future = new Date("2026-07-01T00:00:00.000Z");
const past = new Date("2026-05-01T00:00:00.000Z");

const sub = (
  status: Subscription["status"],
  currentPeriodEnd: Date | null,
): Pick<Subscription, "status" | "currentPeriodEnd"> => ({ status, currentPeriodEnd });

describe("订阅权限判定", () => {
  it("没有订阅记录时为免费", () => {
    expect(resolveAccessLevel(null, NOW)).toBe("FREE");
  });

  it("状态为 ACTIVE 且周期未过时为付费", () => {
    expect(resolveAccessLevel(sub("ACTIVE", future), NOW)).toBe("PREMIUM");
  });

  it("状态为 ACTIVE 但周期已过时降级为免费", () => {
    // 这是真实系统里最常见的脏状态：续费失败或定时任务没跑。
    // 只看 status 的实现会把这些人当会员，白送付费内容。
    expect(resolveAccessLevel(sub("ACTIVE", past), NOW)).toBe("FREE");
  });

  it("状态为 ACTIVE 但没有周期末时视为免费", () => {
    expect(resolveAccessLevel(sub("ACTIVE", null), NOW)).toBe("FREE");
  });

  it("已取消但仍在已付费周期内时保留权益", () => {
    // 用户已经付过这个周期的钱，取消只影响下次续费。
    // 这条规则写进测试，避免日后有人「顺手」改成一取消就断权。
    expect(resolveAccessLevel(sub("CANCELED", future), NOW)).toBe("PREMIUM");
  });

  it("已取消且周期已过时为免费", () => {
    expect(resolveAccessLevel(sub("CANCELED", past), NOW)).toBe("FREE");
  });

  it("EXPIRED 与 NONE 无论周期末如何都是免费", () => {
    expect(resolveAccessLevel(sub("EXPIRED", future), NOW)).toBe("FREE");
    expect(resolveAccessLevel(sub("NONE", future), NOW)).toBe("FREE");
  });

  it("周期末恰好等于当前时刻时判为已过期", () => {
    // 边界取严：宁可少给一秒权益，也不要出现「已过期还能读」的窗口
    expect(resolveAccessLevel(sub("ACTIVE", NOW), NOW)).toBe("FREE");
  });

  it("周期末比当前时刻晚一毫秒时仍有权益", () => {
    const justAfter = new Date(NOW.getTime() + 1);
    expect(resolveAccessLevel(sub("ACTIVE", justAfter), NOW)).toBe("PREMIUM");
  });

  it("isPremium 与 resolveAccessLevel 结论一致", () => {
    expect(isPremium(sub("ACTIVE", future), NOW)).toBe(true);
    expect(isPremium(sub("ACTIVE", past), NOW)).toBe(false);
    expect(isPremium(null, NOW)).toBe(false);
  });
});
