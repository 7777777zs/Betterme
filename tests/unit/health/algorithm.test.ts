import { describe, expect, it } from "vitest";
import {
  InvalidAssessmentInputError,
  calculateBmi,
  calculateBmr,
  calculateTdee,
  classifyBmi,
  computeAssessment,
  validateAssessmentInput,
} from "@/lib/health/algorithm";
import {
  ALGORITHM_VERSION,
  CALORIE_FLOOR,
  LIMITS,
  MAX_PROJECTION_WEEKS,
} from "@/lib/health/constants";
import type { AssessmentInput } from "@/lib/health/types";

/** 固定时间，让所有涉及目标日期的断言可确定性复现 */
const NOW = new Date("2026-01-01T00:00:00.000Z");

const baseInput: AssessmentInput = {
  gender: "MALE",
  age: 30,
  heightCm: 180,
  weightKg: 85,
  goalWeightKg: 75,
  goal: "LOSE_WEIGHT",
  activityLevel: "MODERATE",
};

const withInput = (patch: Partial<AssessmentInput>): AssessmentInput => ({
  ...baseInput,
  ...patch,
});

const warningCodes = (input: AssessmentInput) =>
  computeAssessment(input, NOW).warnings.map((w) => w.code);

// ---------------------------------------------------------------------------

describe("calculateBmi", () => {
  it("按公制公式计算并保留两位小数", () => {
    expect(calculateBmi(85, 180)).toBe(26.23);
    expect(calculateBmi(50, 160)).toBe(19.53);
  });

  it("身高相同时体重越大 BMI 越大", () => {
    expect(calculateBmi(90, 175)).toBeGreaterThan(calculateBmi(70, 175));
  });

  it("在生理区间的端点上仍给出有限数值", () => {
    expect(Number.isFinite(calculateBmi(LIMITS.weightKg.min, LIMITS.heightCm.max))).toBe(true);
    expect(Number.isFinite(calculateBmi(LIMITS.weightKg.max, LIMITS.heightCm.min))).toBe(true);
  });
});

describe("classifyBmi", () => {
  // WHO 分界点是左闭右开，边界值归属必须精确，差一个等号就会误判整档人群
  it.each([
    [10, "UNDERWEIGHT"],
    [18.49, "UNDERWEIGHT"],
    [18.5, "NORMAL"],
    [24.99, "NORMAL"],
    [25, "OVERWEIGHT"],
    [29.99, "OVERWEIGHT"],
    [30, "OBESE"],
    [60, "OBESE"],
  ] as const)("BMI %s 归类为 %s", (bmi, expected) => {
    expect(classifyBmi(bmi)).toBe(expected);
  });
});

describe("calculateBmr", () => {
  it("对男性套用 Mifflin-St Jeor 的 +5 常数", () => {
    // 10*85 + 6.25*180 - 5*30 + 5
    expect(calculateBmr({ gender: "MALE", weightKg: 85, heightCm: 180, age: 30 })).toBe(1830);
  });

  it("对女性套用 -161 常数", () => {
    expect(calculateBmr({ gender: "FEMALE", weightKg: 85, heightCm: 180, age: 30 })).toBe(1664);
  });

  it("OTHER 落在男女之间", () => {
    const male = calculateBmr({ gender: "MALE", weightKg: 70, heightCm: 170, age: 25 });
    const female = calculateBmr({ gender: "FEMALE", weightKg: 70, heightCm: 170, age: 25 });
    const other = calculateBmr({ gender: "OTHER", weightKg: 70, heightCm: 170, age: 25 });
    expect(other).toBeLessThan(male);
    expect(other).toBeGreaterThan(female);
  });

  it("年龄越大 BMR 越低", () => {
    const young = calculateBmr({ gender: "MALE", weightKg: 70, heightCm: 175, age: 20 });
    const old = calculateBmr({ gender: "MALE", weightKg: 70, heightCm: 175, age: 60 });
    expect(old).toBeLessThan(young);
  });
});

describe("calculateTdee", () => {
  it("活动系数单调递增", () => {
    const bmr = 1800;
    const sedentary = calculateTdee(bmr, "SEDENTARY");
    const light = calculateTdee(bmr, "LIGHT");
    const moderate = calculateTdee(bmr, "MODERATE");
    const veryActive = calculateTdee(bmr, "VERY_ACTIVE");
    expect(sedentary).toBeLessThan(light);
    expect(light).toBeLessThan(moderate);
    expect(moderate).toBeLessThan(veryActive);
  });

  it("TDEE 永远不低于 BMR", () => {
    expect(calculateTdee(1500, "SEDENTARY")).toBeGreaterThanOrEqual(1500);
  });
});

// ---------------------------------------------------------------------------
// 输入校验：非法数值必须响亮地失败，而不是安静地返回 NaN
// ---------------------------------------------------------------------------

describe("validateAssessmentInput 非法输入", () => {
  const bad: Array<[string, Partial<AssessmentInput>]> = [
    ["年龄低于下限", { age: LIMITS.age.min - 1 }],
    ["年龄高于上限", { age: LIMITS.age.max + 1 }],
    ["年龄为 0", { age: 0 }],
    ["年龄为负", { age: -30 }],
    ["身高低于下限", { heightCm: LIMITS.heightCm.min - 1 }],
    ["身高高于上限", { heightCm: LIMITS.heightCm.max + 1 }],
    ["身高为 0", { heightCm: 0 }],
    ["体重低于下限", { weightKg: LIMITS.weightKg.min - 1 }],
    ["体重高于上限", { weightKg: LIMITS.weightKg.max + 1 }],
    ["体重为负", { weightKg: -70 }],
    ["目标体重低于下限", { weightKg: 60, goalWeightKg: LIMITS.goalWeightKg.min - 1 }],
  ];

  it.each(bad)("拒绝：%s", (_label, patch) => {
    expect(() => validateAssessmentInput(withInput(patch))).toThrow(InvalidAssessmentInputError);
  });

  const nonFinite: Array<[string, number]> = [
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ];

  it.each(nonFinite)("拒绝体重为 %s", (_label, value) => {
    expect(() => validateAssessmentInput(withInput({ weightKg: value }))).toThrow(
      /必须是有限数字|必须在/,
    );
  });

  it.each(nonFinite)("拒绝身高为 %s", (_label, value) => {
    expect(() => validateAssessmentInput(withInput({ heightCm: value }))).toThrow(
      InvalidAssessmentInputError,
    );
  });

  it("拒绝字符串伪装的数字", () => {
    expect(() =>
      validateAssessmentInput(withInput({ weightKg: "85" as unknown as number })),
    ).toThrow(/必须是数字/);
  });

  it("拒绝 null 与 undefined", () => {
    expect(() =>
      validateAssessmentInput(withInput({ age: null as unknown as number })),
    ).toThrow(InvalidAssessmentInputError);
    expect(() =>
      validateAssessmentInput(withInput({ age: undefined as unknown as number })),
    ).toThrow(InvalidAssessmentInputError);
  });

  it("拒绝未知的性别取值", () => {
    expect(() =>
      validateAssessmentInput(withInput({ gender: "ROBOT" as AssessmentInput["gender"] })),
    ).toThrow(/gender/);
  });

  it("拒绝未知的运动频率取值", () => {
    expect(() =>
      validateAssessmentInput(
        withInput({ activityLevel: "EXTREME" as AssessmentInput["activityLevel"] }),
      ),
    ).toThrow(/activityLevel/);
  });

  it("拒绝偏离当前体重超过一半的目标体重", () => {
    // 70kg 的人把身高误填进目标体重栏
    expect(() =>
      validateAssessmentInput(withInput({ weightKg: 70, goalWeightKg: 175 })),
    ).toThrow(/偏离/);
  });

  it("恰好偏离 50% 时放行，超过才拒绝", () => {
    expect(() => validateAssessmentInput(withInput({ weightKg: 100, goalWeightKg: 50 }))).not.toThrow();
    expect(() => validateAssessmentInput(withInput({ weightKg: 100, goalWeightKg: 49 }))).toThrow();
  });

  it("接受区间端点值", () => {
    expect(() =>
      validateAssessmentInput(
        withInput({
          age: LIMITS.age.min,
          heightCm: LIMITS.heightCm.min,
          weightKg: LIMITS.weightKg.min,
          goalWeightKg: LIMITS.weightKg.min,
        }),
      ),
    ).not.toThrow();

    expect(() =>
      validateAssessmentInput(
        withInput({
          age: LIMITS.age.max,
          heightCm: LIMITS.heightCm.max,
          weightKg: LIMITS.weightKg.max,
          goalWeightKg: LIMITS.weightKg.max,
        }),
      ),
    ).not.toThrow();
  });

  it("computeAssessment 会先跑校验，非法输入不会产出 NaN 结果", () => {
    expect(() => computeAssessment(withInput({ weightKg: Number.NaN }), NOW)).toThrow(
      InvalidAssessmentInputError,
    );
  });
});

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

describe("computeAssessment 减重路径", () => {
  const result = computeAssessment(baseInput, NOW);

  it("产出完整且数值合理的结果", () => {
    expect(result.bmi).toBe(26.23);
    expect(result.bmiCategory).toBe("OVERWEIGHT");
    expect(result.bmr).toBe(1830);
    expect(result.tdee).toBe(2837);
    expect(result.algorithmVersion).toBe(ALGORITHM_VERSION);
  });

  it("建议摄入低于 TDEE 且高于安全下限", () => {
    expect(result.recommendedCalories).toBeLessThan(result.tdee);
    expect(result.recommendedCalories).toBeGreaterThanOrEqual(CALORIE_FLOOR.MALE);
  });

  it("每周减重速率不超过体重的 1%", () => {
    expect(result.effectiveWeeklyRateKg).toBeLessThanOrEqual(baseInput.weightKg * 0.01);
    expect(result.effectiveWeeklyRateKg).toBeGreaterThan(0);
  });

  it("目标日期与所需周数一致", () => {
    expect(result.weeksToGoal).toBeGreaterThan(0);
    const expected = new Date(NOW.getTime() + result.weeksToGoal * 7 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(result.targetDate).toBe(expected);
  });

  it("预测曲线单调下降且终点不越过目标体重", () => {
    const curve = result.weeklyProjection;
    expect(curve).toHaveLength(result.weeksToGoal);
    expect(curve[0]!.week).toBe(1);

    for (let i = 1; i < curve.length; i += 1) {
      expect(curve[i]!.weightKg).toBeLessThanOrEqual(curve[i - 1]!.weightKg);
    }
    expect(curve.at(-1)!.weightKg).toBeGreaterThanOrEqual(baseInput.goalWeightKg);
    expect(curve.at(-1)!.weightKg).toBeCloseTo(baseInput.goalWeightKg, 1);
  });

  it("宏量营养素的热量之和接近建议摄入", () => {
    const { proteinG, carbsG, fatG } = result.macros;
    const total = proteinG * 4 + carbsG * 4 + fatG * 9;
    // 三项各自取整，允许几十千卡的舍入偏差
    expect(Math.abs(total - result.recommendedCalories)).toBeLessThan(30);
  });

  it("所有宏量营养素非负", () => {
    expect(result.macros.proteinG).toBeGreaterThanOrEqual(0);
    expect(result.macros.carbsG).toBeGreaterThanOrEqual(0);
    expect(result.macros.fatG).toBeGreaterThanOrEqual(0);
  });

  it("同样的输入与同样的 now 产出完全相同的结果", () => {
    expect(computeAssessment(baseInput, NOW)).toEqual(computeAssessment(baseInput, NOW));
  });
});

describe("computeAssessment 维持体重路径", () => {
  const input = withInput({ goalWeightKg: 85, goal: "MAINTAIN_WEIGHT" });
  const result = computeAssessment(input, NOW);

  it("不设目标日期", () => {
    expect(result.targetDate).toBeNull();
    expect(result.weeksToGoal).toBe(0);
    expect(result.effectiveWeeklyRateKg).toBe(0);
  });

  it("建议摄入等于 TDEE", () => {
    expect(result.recommendedCalories).toBe(result.tdee);
  });

  it("仍给出 12 周平直曲线供结果页展示", () => {
    expect(result.weeklyProjection).toHaveLength(12);
    const weights = new Set(result.weeklyProjection.map((p) => p.weightKg));
    expect(weights.size).toBe(1);
    expect([...weights][0]).toBeCloseTo(input.weightKg, 1);
  });
});

describe("computeAssessment 增肌路径", () => {
  const input = withInput({ weightKg: 60, goalWeightKg: 68, goal: "GAIN_MUSCLE" });
  const result = computeAssessment(input, NOW);

  it("建议摄入高于 TDEE", () => {
    expect(result.recommendedCalories).toBeGreaterThan(result.tdee);
  });

  it("增重速率受更严格的上限约束", () => {
    expect(result.effectiveWeeklyRateKg).toBeLessThanOrEqual(0.5);
  });

  it("预测曲线单调上升且不越过目标", () => {
    const curve = result.weeklyProjection;
    for (let i = 1; i < curve.length; i += 1) {
      expect(curve[i]!.weightKg).toBeGreaterThanOrEqual(curve[i - 1]!.weightKg);
    }
    expect(curve.at(-1)!.weightKg).toBeLessThanOrEqual(input.goalWeightKg);
  });

  it("增肌目标的蛋白质配额高于减重目标", () => {
    const lose = computeAssessment(withInput({ weightKg: 60, goalWeightKg: 55 }), NOW);
    expect(result.macros.proteinG).toBeGreaterThan(lose.macros.proteinG);
  });
});

// ---------------------------------------------------------------------------
// 边界与钳制
// ---------------------------------------------------------------------------

describe("热量安全下限", () => {
  it("低 TDEE 人群的建议摄入被钳到下限并给出告警", () => {
    // 高龄、矮小、久坐的女性，TDEE 很低，按 1% 速率算出的缺口会击穿下限
    const input: AssessmentInput = {
      gender: "FEMALE",
      age: 75,
      heightCm: 150,
      weightKg: 80,
      goalWeightKg: 60,
      goal: "LOSE_WEIGHT",
      activityLevel: "SEDENTARY",
    };
    const result = computeAssessment(input, NOW);

    expect(result.recommendedCalories).toBe(CALORIE_FLOOR.FEMALE);
    expect(result.warnings.map((w) => w.code)).toContain("CALORIE_FLOOR_APPLIED");
  });

  it("钳制后速率同步下调，目标日期相应延后", () => {
    const clamped = computeAssessment(
      {
        gender: "FEMALE",
        age: 75,
        heightCm: 150,
        weightKg: 80,
        goalWeightKg: 60,
        goal: "LOSE_WEIGHT",
        activityLevel: "SEDENTARY",
      },
      NOW,
    );
    const unclamped = computeAssessment(
      {
        gender: "FEMALE",
        age: 25,
        heightCm: 170,
        weightKg: 80,
        goalWeightKg: 60,
        goal: "LOSE_WEIGHT",
        activityLevel: "VERY_ACTIVE",
      },
      NOW,
    );

    // 同样减 20kg，被钳制的那位需要更久。
    // 这条断言存在的意义：防止有人只改热量不改速率，导致日期与建议自相矛盾。
    expect(clamped.effectiveWeeklyRateKg).toBeLessThan(unclamped.effectiveWeeklyRateKg);
    expect(clamped.weeksToGoal).toBeGreaterThan(unclamped.weeksToGoal);
  });

  it("建议摄入在任何输入下都不低于对应性别的下限", () => {
    const genders = ["MALE", "FEMALE", "OTHER"] as const;
    for (const gender of genders) {
      const result = computeAssessment(
        {
          gender,
          age: LIMITS.age.max,
          heightCm: LIMITS.heightCm.min,
          weightKg: 40,
          goalWeightKg: 32,
          goal: "LOSE_WEIGHT",
          activityLevel: "SEDENTARY",
        },
        NOW,
      );
      expect(result.recommendedCalories).toBeGreaterThanOrEqual(CALORIE_FLOOR[gender]);
    }
  });
});

describe("不健康目标的告警", () => {
  it("目标 BMI 低于健康下限时告警但仍出结果", () => {
    const input = withInput({ heightCm: 180, weightKg: 70, goalWeightKg: 55 });
    const result = computeAssessment(input, NOW);
    expect(result.warnings.map((w) => w.code)).toContain("GOAL_BMI_UNDERWEIGHT");
    expect(result.recommendedCalories).toBeGreaterThan(0);
    expect(result.targetDate).not.toBeNull();
  });

  it("目标 BMI 仍在肥胖区间时告警", () => {
    const input = withInput({ heightCm: 165, weightKg: 120, goalWeightKg: 100 });
    expect(warningCodes(input)).toContain("GOAL_BMI_OBESE");
  });

  it("勾选减重却填了更高的目标体重时告警，并按实际方向计算", () => {
    const input = withInput({ weightKg: 70, goalWeightKg: 80, goal: "LOSE_WEIGHT" });
    const result = computeAssessment(input, NOW);
    expect(result.warnings.map((w) => w.code)).toContain("GOAL_CONFLICTS_WITH_DIRECTION");
    expect(result.recommendedCalories).toBeGreaterThan(result.tdee);
  });

  it("勾选增肌却填了更低的目标体重时告警", () => {
    const input = withInput({ weightKg: 80, goalWeightKg: 70, goal: "GAIN_MUSCLE" });
    expect(warningCodes(input)).toContain("GOAL_CONFLICTS_WITH_DIRECTION");
  });

  it("当前 BMI 处于极端区间时告警", () => {
    const input = withInput({ heightCm: 160, weightKg: 110, goalWeightKg: 90 });
    expect(warningCodes(input)).toContain("CURRENT_BMI_EXTREME");
  });

  it("健康目标不产生任何告警", () => {
    const input = withInput({ heightCm: 175, weightKg: 78, goalWeightKg: 70 });
    expect(warningCodes(input)).toHaveLength(0);
  });
});

describe("预测曲线的规模控制", () => {
  it("曲线长度不超过上限，避免极端目标产出上千个点", () => {
    const result = computeAssessment(
      {
        gender: "FEMALE",
        age: 80,
        heightCm: 150,
        weightKg: 90,
        goalWeightKg: 60,
        goal: "LOSE_WEIGHT",
        activityLevel: "SEDENTARY",
      },
      NOW,
    );
    expect(result.weeklyProjection.length).toBeLessThanOrEqual(MAX_PROJECTION_WEEKS);
  });

  it("每个点都带合法的 ISO 日期且逐周递增", () => {
    const result = computeAssessment(baseInput, NOW);
    for (const point of result.weeklyProjection) {
      expect(point.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const dates = result.weeklyProjection.map((p) => p.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it("目标日期与曲线最后一点的日期一致", () => {
    const result = computeAssessment(baseInput, NOW);
    expect(result.weeklyProjection.at(-1)!.date).toBe(result.targetDate);
  });
});

describe("时间无关性", () => {
  it("只有目标日期与曲线日期随 now 变化，数值部分不变", () => {
    const a = computeAssessment(baseInput, new Date("2026-01-01T00:00:00.000Z"));
    const b = computeAssessment(baseInput, new Date("2027-06-15T00:00:00.000Z"));

    expect(a.targetDate).not.toBe(b.targetDate);
    expect(a.bmi).toBe(b.bmi);
    expect(a.recommendedCalories).toBe(b.recommendedCalories);
    expect(a.weeksToGoal).toBe(b.weeksToGoal);
    expect(a.weeklyProjection.map((p) => p.weightKg)).toEqual(
      b.weeklyProjection.map((p) => p.weightKg),
    );
  });

  it("跨越夏令时切换的日期不会漂移", () => {
    // 3 月中旬起算，覆盖北半球夏令时切换点
    const result = computeAssessment(baseInput, new Date("2026-03-01T00:00:00.000Z"));
    const first = result.weeklyProjection[0]!.date;
    const second = result.weeklyProjection[1]!.date;
    const diffDays =
      (Date.parse(`${second}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000;
    expect(diffDays).toBe(7);
  });
});
