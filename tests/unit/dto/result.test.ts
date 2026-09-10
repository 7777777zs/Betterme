import { describe, expect, it } from "vitest";
import type { AssessmentResult } from "@/generated/prisma/client";
import {
  PROTECTED_RESULT_FIELDS,
  type PremiumResultDto,
  serializeResult,
} from "@/lib/dto/result";

/**
 * 结果脱敏是本项目最关键的安全边界，测试策略也随之不同：
 *
 * 断言的是「受保护字段不在响应的键集合里」，
 * 而不是「受保护字段的值为空」。
 *
 * 后者对 `targetDate: null` 这种实现是通过的，但那并不安全 ——
 * 它说明后端存在一条会把真值填进去的分支，只是这次没走到。
 */

const fixture = {
  id: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  gender: "MALE",
  goal: "LOSE_WEIGHT",
  activityLevel: "MODERATE",
  inputAge: 30,
  inputHeightCm: 180,
  inputWeightKg: 85,
  inputGoalWeightKg: 75,
  bmi: 26.23,
  bmiCategory: "OVERWEIGHT",
  bmr: 1830,
  tdee: 2837,
  recommendedCalories: 1902,
  proteinG: 135,
  carbsG: 180,
  fatG: 53,
  warnings: [],
  targetDate: new Date("2026-03-26T00:00:00.000Z"),
  weeksToGoal: 12,
  effectiveWeeklyRateKg: 0.85,
  weeklyProjection: [
    { week: 1, weightKg: 84.2, date: "2026-01-08" },
    { week: 2, weightKg: 83.3, date: "2026-01-15" },
  ],
  algorithmVersion: "1.0.0",
  computedAt: new Date("2026-01-01T00:00:00.000Z"),
} as unknown as AssessmentResult;

describe("非会员序列化", () => {
  const dto = serializeResult(fixture, "FREE");
  const keys = Object.keys(dto);

  it.each(PROTECTED_RESULT_FIELDS)("响应里不存在受保护字段 %s", (field) => {
    expect(keys).not.toContain(field);
    expect(Object.hasOwn(dto, field)).toBe(false);
  });

  it("序列化成 JSON 之后受保护字段依然不出现", () => {
    // 走一遍真实的 JSON 序列化，确保没有任何自定义 toJSON 把字段带回来
    const json = JSON.parse(JSON.stringify(dto)) as Record<string, unknown>;
    for (const field of PROTECTED_RESULT_FIELDS) {
      expect(Object.hasOwn(json, field)).toBe(false);
    }
  });

  it("整个响应文本里不含任何一个付费数值", () => {
    // 最粗暴也最可靠的一层：付费数据的任何痕迹都不该出现在响应体里。
    // 注意 locked 里出现的是字段「名」，那是给前端渲染遮罩用的，不是数据泄漏；
    // 这里断言的是「值」。
    const text = JSON.stringify(dto);
    expect(text).not.toContain("84.2");
    expect(text).not.toContain("83.3");
    expect(text).not.toContain("2026-03-26");
    expect(text).not.toContain("2026-01-08");
    expect(text).not.toContain("0.85");
  });

  it("免费字段照常返回", () => {
    expect(dto.bmi).toBe(26.23);
    expect(dto.bmiCategory).toBe("OVERWEIGHT");
    expect(dto.bmr).toBe(1830);
    expect(dto.tdee).toBe(2837);
    expect(dto.recommendedCalories).toBe(1902);
    expect(dto.macros).toEqual({ proteinG: 135, carbsG: 180, fatG: 53 });
  });

  it("明确标注 access 与被锁字段，供前端渲染遮罩", () => {
    expect(dto.access).toBe("FREE");
    if (dto.access === "FREE") {
      expect(dto.locked).toEqual(PROTECTED_RESULT_FIELDS);
      expect(dto.paywall.title.length).toBeGreaterThan(0);
    }
  });
});

describe("会员序列化", () => {
  const dto = serializeResult(fixture, "PREMIUM") as PremiumResultDto;

  it("返回全部受保护字段", () => {
    expect(dto.access).toBe("PREMIUM");
    expect(dto.targetDate).toBe("2026-03-26");
    expect(dto.weeksToGoal).toBe(12);
    expect(dto.effectiveWeeklyRateKg).toBe(0.85);
    expect(dto.weeklyProjection).toHaveLength(2);
  });

  it("不再返回 locked 与 paywall", () => {
    expect(Object.hasOwn(dto, "locked")).toBe(false);
    expect(Object.hasOwn(dto, "paywall")).toBe(false);
  });

  it("免费字段与非会员完全一致，付费与否不改变基础数据", () => {
    const free = serializeResult(fixture, "FREE");
    expect(dto.bmi).toBe(free.bmi);
    expect(dto.tdee).toBe(free.tdee);
    expect(dto.recommendedCalories).toBe(free.recommendedCalories);
    expect(dto.macros).toEqual(free.macros);
  });
});

describe("类型转换", () => {
  it("Decimal 被转成原生 number，而不是对象或字符串", () => {
    const dto = serializeResult(fixture, "PREMIUM") as PremiumResultDto;
    expect(typeof dto.bmi).toBe("number");
    expect(typeof dto.effectiveWeeklyRateKg).toBe("number");
  });

  it("Date 被转成 ISO 字符串", () => {
    const dto = serializeResult(fixture, "PREMIUM") as PremiumResultDto;
    expect(dto.computedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(dto.targetDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("targetDate 为空时返回 null 而不是崩溃", () => {
    const maintain = { ...fixture, targetDate: null } as AssessmentResult;
    const dto = serializeResult(maintain, "PREMIUM") as PremiumResultDto;
    expect(dto.targetDate).toBeNull();
  });

  it("warnings 为空时返回空数组而不是 undefined", () => {
    const noWarnings = { ...fixture, warnings: null } as unknown as AssessmentResult;
    expect(serializeResult(noWarnings, "FREE").warnings).toEqual([]);
  });
});
