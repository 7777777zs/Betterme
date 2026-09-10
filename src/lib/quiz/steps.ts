import { z } from "zod";
import { LIMITS, MAX_GOAL_DEVIATION_RATIO } from "@/lib/health/constants";

/**
 * 测评步骤的单一真相来源。
 *
 * 每一步的 zod schema 定义在这里，前端渲染、后端校验、类型推导共用同一份，
 * 新增步骤只需要往 STEP_DEFINITIONS 里加一条，接口层不用改。
 */

/**
 * 有界数字。
 *
 * 显式拒绝 NaN 与 Infinity：JSON 里传不出这两个字面量，
 * 但 1e400 会被 JSON.parse 解析成 Infinity，这是个真实可达的注入路径。
 * 同时限制小数位，挡住 85.000000000000001 这类会污染存储的值。
 */
const boundedNumber = (min: number, max: number, label: string) =>
  z
    .number({ message: `${label} 必须是数字` })
    .refine((v) => Number.isFinite(v), { message: `${label} 必须是有限数字` })
    .refine((v) => Math.abs(v * 10) < Number.MAX_SAFE_INTEGER, {
      message: `${label} 数值过大`,
    })
    .refine((v) => v >= min && v <= max, {
      message: `${label} 必须在 ${min} 到 ${max} 之间`,
    })
    .transform((v) => Math.round(v * 10) / 10);

export const genderSchema = z.enum(["MALE", "FEMALE", "OTHER"]);
export const goalSchema = z.enum(["LOSE_WEIGHT", "MAINTAIN_WEIGHT", "GAIN_MUSCLE"]);
export const activityLevelSchema = z.enum([
  "SEDENTARY",
  "LIGHT",
  "MODERATE",
  "VERY_ACTIVE",
]);

const CM_PER_INCH = 2.54;
const KG_PER_POUND = 0.45359237;

/**
 * 身体数据。支持公制与英制两种输入形态，用判别联合区分，
 * 转换后统一以公制落库 —— 同一列里绝不允许出现两种量纲。
 *
 * 校验顺序很关键：先各字段独立校验区间，再做跨字段的目标合理性检查。
 * 反过来的话，一个 -70 的体重会先触发「目标偏离过大」这种误导性报错。
 */
const metricBody = z.object({
  unitSystem: z.literal("METRIC"),
  age: boundedNumber(LIMITS.age.min, LIMITS.age.max, "年龄"),
  heightCm: boundedNumber(LIMITS.heightCm.min, LIMITS.heightCm.max, "身高"),
  weightKg: boundedNumber(LIMITS.weightKg.min, LIMITS.weightKg.max, "体重"),
  goalWeightKg: boundedNumber(LIMITS.goalWeightKg.min, LIMITS.goalWeightKg.max, "目标体重"),
}).strict();

const imperialBody = z.object({
  unitSystem: z.literal("IMPERIAL"),
  age: boundedNumber(LIMITS.age.min, LIMITS.age.max, "年龄"),
  heightIn: boundedNumber(
    LIMITS.heightCm.min / CM_PER_INCH,
    LIMITS.heightCm.max / CM_PER_INCH,
    "身高",
  ),
  weightLb: boundedNumber(
    LIMITS.weightKg.min / KG_PER_POUND,
    LIMITS.weightKg.max / KG_PER_POUND,
    "体重",
  ),
  goalWeightLb: boundedNumber(
    LIMITS.goalWeightKg.min / KG_PER_POUND,
    LIMITS.goalWeightKg.max / KG_PER_POUND,
    "目标体重",
  ),
}).strict();

/** 规范化后的身体数据，落库形态 */
export interface NormalizedBodyMetrics {
  unitSystem: "METRIC" | "IMPERIAL";
  age: number;
  heightCm: number;
  weightKg: number;
  goalWeightKg: number;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

export const bodyMetricsSchema = z
  .discriminatedUnion("unitSystem", [metricBody, imperialBody])
  .transform((raw): NormalizedBodyMetrics => {
    if (raw.unitSystem === "METRIC") {
      return {
        unitSystem: "METRIC",
        age: raw.age,
        heightCm: raw.heightCm,
        weightKg: raw.weightKg,
        goalWeightKg: raw.goalWeightKg,
      };
    }
    return {
      unitSystem: "IMPERIAL",
      age: raw.age,
      heightCm: round1(raw.heightIn * CM_PER_INCH),
      weightKg: round1(raw.weightLb * KG_PER_POUND),
      goalWeightKg: round1(raw.goalWeightLb * KG_PER_POUND),
    };
  })
  .superRefine((value, ctx) => {
    // 换算之后再校验一次公制区间：英制的合法区间是由公制换算而来的，
    // 浮点运算可能让边缘值擦出界，这里兜底。
    if (value.heightCm < LIMITS.heightCm.min || value.heightCm > LIMITS.heightCm.max) {
      ctx.addIssue({
        code: "custom",
        path: ["heightCm"],
        message: `换算后的身高 ${value.heightCm}cm 超出合理范围`,
      });
    }
    if (value.weightKg < LIMITS.weightKg.min || value.weightKg > LIMITS.weightKg.max) {
      ctx.addIssue({
        code: "custom",
        path: ["weightKg"],
        message: `换算后的体重 ${value.weightKg}kg 超出合理范围`,
      });
    }

    const deviation = Math.abs(value.goalWeightKg - value.weightKg) / value.weightKg;
    if (deviation > MAX_GOAL_DEVIATION_RATIO) {
      ctx.addIssue({
        code: "custom",
        path: ["goalWeightKg"],
        message: `目标体重相对当前体重偏离 ${Math.round(
          deviation * 100,
        )}%，超出允许的 ${MAX_GOAL_DEVIATION_RATIO * 100}%，请检查是否填错`,
      });
    }
  });

/**
 * 关注部位。非必填步骤，用来让漏斗更有代入感。
 * 用白名单枚举而不是自由文本，避免存储用户可控的任意字符串。
 */
export const focusAreasSchema = z.object({
  areas: z
    .array(z.enum(["BELLY", "ARMS", "LEGS", "CHEST", "BACK", "FULL_BODY"]))
    .min(1, "至少选择一个关注部位")
    .max(6)
    // 去重，前端重复点击不该产生重复项
    .transform((areas) => [...new Set(areas)]),
});

export const stepSchemas = {
  gender: z.object({ gender: genderSchema }).strict(),
  goal: z.object({ goal: goalSchema }).strict(),
  focus_areas: focusAreasSchema.strict(),
  body_metrics: bodyMetricsSchema,
  activity_level: z.object({ activityLevel: activityLevelSchema }).strict(),
} as const;

export type StepKey = keyof typeof stepSchemas;

export interface StepDefinition {
  key: StepKey;
  /** 漏斗中的顺序，用于计算进度百分比与「下一步」 */
  order: number;
  /** 是否为提交所必需。非必需步骤缺失不阻塞 submit。 */
  required: boolean;
  title: string;
}

/**
 * 步骤顺序即漏斗顺序。order 与数组下标解耦，
 * 是为了日后在中间插入新步骤时不必重排所有数字。
 */
export const STEP_DEFINITIONS: readonly StepDefinition[] = [
  { key: "gender", order: 10, required: true, title: "你的性别" },
  { key: "goal", order: 20, required: true, title: "你的目标" },
  { key: "focus_areas", order: 30, required: false, title: "重点关注部位" },
  { key: "body_metrics", order: 40, required: true, title: "身体数据" },
  { key: "activity_level", order: 50, required: true, title: "运动频率" },
] as const;

export const STEP_KEYS: readonly StepKey[] = STEP_DEFINITIONS.map((s) => s.key);

export const REQUIRED_STEP_KEYS: readonly StepKey[] = STEP_DEFINITIONS.filter(
  (s) => s.required,
).map((s) => s.key);

export function isStepKey(value: string): value is StepKey {
  return Object.hasOwn(stepSchemas, value);
}

export function getStepDefinition(key: StepKey): StepDefinition {
  const found = STEP_DEFINITIONS.find((s) => s.key === key);
  if (!found) throw new Error(`步骤定义缺失：${key}`);
  return found;
}

/**
 * 根据已作答的步骤推算下一步。
 * 全部必填步骤完成后返回 null，表示可以提交了。
 */
export function nextStepFor(answered: readonly string[]): StepKey | null {
  const done = new Set(answered);
  const sorted = [...STEP_DEFINITIONS].sort((a, b) => a.order - b.order);
  for (const step of sorted) {
    if (!done.has(step.key)) return step.key;
  }
  return null;
}

/** 缺失的必填步骤，提交前的完整性检查用 */
export function missingRequiredSteps(answered: readonly string[]): StepKey[] {
  const done = new Set(answered);
  return REQUIRED_STEP_KEYS.filter((key) => !done.has(key));
}

/** 漏斗完成度百分比，前端进度条用 */
export function progressPercent(answered: readonly string[]): number {
  const done = new Set(answered);
  const total = STEP_DEFINITIONS.length;
  const count = STEP_DEFINITIONS.filter((s) => done.has(s.key)).length;
  return Math.round((count / total) * 100);
}
