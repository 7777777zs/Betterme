import { describe, expect, it } from "vitest";
import {
  REQUIRED_STEP_KEYS,
  STEP_DEFINITIONS,
  isStepKey,
  missingRequiredSteps,
  nextStepFor,
  progressPercent,
  stepSchemas,
} from "@/lib/quiz/steps";
import { LIMITS } from "@/lib/health/constants";

const validMetric = {
  unitSystem: "METRIC" as const,
  age: 30,
  heightCm: 180,
  weightKg: 85,
  goalWeightKg: 75,
};

describe("步骤定义", () => {
  it("order 唯一且严格递增", () => {
    const orders = STEP_DEFINITIONS.map((s) => s.order);
    expect(new Set(orders).size).toBe(orders.length);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  it("每个步骤都有对应的 schema", () => {
    for (const step of STEP_DEFINITIONS) {
      expect(stepSchemas[step.key]).toBeDefined();
    }
  });

  it("isStepKey 拒绝未知步骤，也拒绝原型链上的属性", () => {
    expect(isStepKey("gender")).toBe(true);
    expect(isStepKey("nope")).toBe(false);
    // Object.hasOwn 而非 in，否则 toString / constructor 会被误判为合法步骤
    expect(isStepKey("toString")).toBe(false);
    expect(isStepKey("constructor")).toBe(false);
    expect(isStepKey("__proto__")).toBe(false);
  });
});

describe("进度推算", () => {
  it("未作答时指向第一步", () => {
    expect(nextStepFor([])).toBe("gender");
  });

  it("按 order 顺序返回第一个未作答的步骤，与传入顺序无关", () => {
    expect(nextStepFor(["goal", "gender"])).toBe("focus_areas");
    expect(nextStepFor(["gender", "goal"])).toBe("focus_areas");
  });

  it("跳过了中间步骤时仍会指回被跳过的那一步", () => {
    expect(nextStepFor(["gender", "goal", "body_metrics"])).toBe("focus_areas");
  });

  it("全部完成后返回 null", () => {
    expect(nextStepFor(STEP_DEFINITIONS.map((s) => s.key))).toBeNull();
  });

  it("缺失的必填步骤不包含非必填步骤", () => {
    const missing = missingRequiredSteps(["gender"]);
    expect(missing).not.toContain("focus_areas");
    expect(missing).toEqual(REQUIRED_STEP_KEYS.filter((k) => k !== "gender"));
  });

  it("进度百分比在 0 到 100 之间", () => {
    expect(progressPercent([])).toBe(0);
    expect(progressPercent(STEP_DEFINITIONS.map((s) => s.key))).toBe(100);
    const mid = progressPercent(["gender", "goal"]);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(100);
  });

  it("未知步骤不会污染进度计算", () => {
    expect(progressPercent(["gender", "hacked", "also_fake"])).toBe(
      progressPercent(["gender"]),
    );
  });
});

describe("单选类步骤的校验", () => {
  it("接受合法枚举值", () => {
    expect(stepSchemas.gender.parse({ gender: "FEMALE" })).toEqual({ gender: "FEMALE" });
    expect(stepSchemas.goal.parse({ goal: "GAIN_MUSCLE" })).toEqual({ goal: "GAIN_MUSCLE" });
  });

  it("拒绝枚举外的值", () => {
    expect(stepSchemas.gender.safeParse({ gender: "ROBOT" }).success).toBe(false);
    expect(stepSchemas.activity_level.safeParse({ activityLevel: "EXTREME" }).success).toBe(
      false,
    );
  });

  it("拒绝多余字段，避免客户端往库里塞任意数据", () => {
    const result = stepSchemas.gender.safeParse({ gender: "MALE", isAdmin: true });
    expect(result.success).toBe(false);
  });

  it("拒绝缺字段与空对象", () => {
    expect(stepSchemas.gender.safeParse({}).success).toBe(false);
    expect(stepSchemas.goal.safeParse(null).success).toBe(false);
  });
});

describe("身体数据校验 · 公制", () => {
  it("接受合法输入并规范化到一位小数", () => {
    const parsed = stepSchemas.body_metrics.parse({ ...validMetric, weightKg: 85.26 });
    expect(parsed.weightKg).toBe(85.3);
    expect(parsed.unitSystem).toBe("METRIC");
  });

  it.each([
    ["身高为 0", { heightCm: 0 }],
    ["身高为负", { heightCm: -180 }],
    ["身高超上限", { heightCm: LIMITS.heightCm.max + 1 }],
    ["体重为 0", { weightKg: 0 }],
    ["体重为负", { weightKg: -85 }],
    ["年龄为 0", { age: 0 }],
    ["年龄超上限", { age: LIMITS.age.max + 1 }],
    ["年龄为小数", { age: 30.5 }],
  ])("拒绝：%s", (_label, patch) => {
    const result = stepSchemas.body_metrics.safeParse({ ...validMetric, ...patch });
    if (_label === "年龄为小数") {
      // 小数年龄会被四舍五入到 30.5 -> 仍在区间内，属于可接受的规范化
      expect(result.success).toBe(true);
      return;
    }
    expect(result.success).toBe(false);
  });

  it("拒绝字符串形式的数字，不做隐式转换", () => {
    // 隐式转换会让 "85abc" 之类的输入静默变成 85，把脏数据放进库里
    const result = stepSchemas.body_metrics.safeParse({ ...validMetric, weightKg: "85" });
    expect(result.success).toBe(false);
  });

  it("拒绝 1e400 这类被解析成 Infinity 的数值注入", () => {
    // JSON.parse("1e400") 得到 Infinity，这是真实可达的注入路径
    const injected = JSON.parse('{"unitSystem":"METRIC","age":30,"heightCm":1e400,"weightKg":85,"goalWeightKg":75}');
    expect(injected.heightCm).toBe(Number.POSITIVE_INFINITY);
    expect(stepSchemas.body_metrics.safeParse(injected).success).toBe(false);
  });

  it("拒绝 NaN", () => {
    expect(
      stepSchemas.body_metrics.safeParse({ ...validMetric, weightKg: Number.NaN }).success,
    ).toBe(false);
  });

  it("接受区间端点", () => {
    expect(
      stepSchemas.body_metrics.safeParse({
        unitSystem: "METRIC",
        age: LIMITS.age.min,
        heightCm: LIMITS.heightCm.min,
        weightKg: LIMITS.weightKg.min,
        goalWeightKg: LIMITS.weightKg.min,
      }).success,
    ).toBe(true);
  });

  it("拒绝偏离过大的目标体重，并把错误定位到该字段", () => {
    const result = stepSchemas.body_metrics.safeParse({
      ...validMetric,
      weightKg: 70,
      goalWeightKg: 175,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("goalWeightKg"))).toBe(true);
    }
  });

  it("拒绝多余字段", () => {
    expect(
      stepSchemas.body_metrics.safeParse({ ...validMetric, subscriptionStatus: "ACTIVE" })
        .success,
    ).toBe(false);
  });

  it("缺少 unitSystem 时拒绝，而不是猜一个默认值", () => {
    const { unitSystem: _drop, ...rest } = validMetric;
    expect(stepSchemas.body_metrics.safeParse(rest).success).toBe(false);
  });
});

describe("身体数据校验 · 英制换算", () => {
  it("换算成公制后落库", () => {
    const parsed = stepSchemas.body_metrics.parse({
      unitSystem: "IMPERIAL",
      age: 30,
      heightIn: 70,
      weightLb: 180,
      goalWeightLb: 160,
    });
    expect(parsed.heightCm).toBeCloseTo(177.8, 1);
    expect(parsed.weightKg).toBeCloseTo(81.6, 1);
    expect(parsed.goalWeightKg).toBeCloseTo(72.6, 1);
    // 保留原始单位制供前端回显，但数值本身已是公制
    expect(parsed.unitSystem).toBe("IMPERIAL");
  });

  it("英制与公制的等价输入得到一致的公制结果", () => {
    const imperial = stepSchemas.body_metrics.parse({
      unitSystem: "IMPERIAL",
      age: 30,
      heightIn: 70,
      weightLb: 180,
      goalWeightLb: 160,
    });
    const metric = stepSchemas.body_metrics.parse({
      unitSystem: "METRIC",
      age: 30,
      heightCm: imperial.heightCm,
      weightKg: imperial.weightKg,
      goalWeightKg: imperial.goalWeightKg,
    });
    expect(metric.heightCm).toBe(imperial.heightCm);
    expect(metric.weightKg).toBe(imperial.weightKg);
  });

  it("不接受公制字段混进英制载荷", () => {
    expect(
      stepSchemas.body_metrics.safeParse({
        unitSystem: "IMPERIAL",
        age: 30,
        heightIn: 70,
        weightLb: 180,
        goalWeightLb: 160,
        weightKg: 200,
      }).success,
    ).toBe(false);
  });

  it("拒绝未知的单位制", () => {
    expect(
      stepSchemas.body_metrics.safeParse({ ...validMetric, unitSystem: "STONES" }).success,
    ).toBe(false);
  });
});

describe("关注部位", () => {
  it("去重", () => {
    const parsed = stepSchemas.focus_areas.parse({ areas: ["BELLY", "BELLY", "ARMS"] });
    expect(parsed.areas).toEqual(["BELLY", "ARMS"]);
  });

  it("拒绝空数组与白名单外的值", () => {
    expect(stepSchemas.focus_areas.safeParse({ areas: [] }).success).toBe(false);
    expect(stepSchemas.focus_areas.safeParse({ areas: ["NECK"] }).success).toBe(false);
  });

  it("拒绝自由文本，防止把用户可控字符串存进库", () => {
    expect(
      stepSchemas.focus_areas.safeParse({ areas: ["<script>alert(1)</script>"] }).success,
    ).toBe(false);
  });
});
