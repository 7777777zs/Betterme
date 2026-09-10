import type { AssessmentResult } from "@/generated/prisma/client";
import type {
  AssessmentWarning,
  ProjectionPoint,
} from "@/lib/health/types";
import type { AccessLevel } from "@/lib/subscription/access";

/**
 * 结果页的序列化层 —— 本项目里最关键的一段安全代码。
 *
 * 核心约定：非会员的响应体里，受保护字段是**根本不存在的键**，
 * 不是 null，不是空数组，不是被打码的字符串。
 *
 * 为什么不用「查出全量再 delete 掉几个字段」的写法：
 *
 * 1. 那种写法的默认行为是「泄漏」，只有显式 delete 才安全。
 *    以后新增一个付费字段，忘记加进 delete 列表就直接漏出去，
 *    而且不会有任何测试失败来提醒你。
 *    这里的默认行为是「不泄漏」，新增字段必须显式加进 premium 分支才可见。
 *
 * 2. 置为 null 的响应只能断言「值是空的」，断言不了「字段不存在」。
 *    前端 devtools 里 `targetDate: null` 和真正拿不到数据是两回事，
 *    但对绕过前端直接打接口的人来说，前者往往意味着后端某个分支会填上真值。
 *
 * 3. 两种形态是两个互斥的类型，TypeScript 在编译期就能挡住
 *    「在免费分支里不小心引用了付费字段」这类错误。
 */

/** 受保护字段清单。测试直接引用它来断言这些键不出现在免费响应中。 */
export const PROTECTED_RESULT_FIELDS = [
  "targetDate",
  "weeksToGoal",
  "effectiveWeeklyRateKg",
  "weeklyProjection",
] as const;

export type ProtectedResultField = (typeof PROTECTED_RESULT_FIELDS)[number];

interface MacroDto {
  proteinG: number;
  carbsG: number;
  fatG: number;
}

/** 免费与付费共有的部分 */
interface ResultBase {
  sessionId: string;
  bmi: number;
  bmiCategory: string;
  bmr: number;
  tdee: number;
  recommendedCalories: number;
  macros: MacroDto;
  warnings: AssessmentWarning[];
  algorithmVersion: string;
  computedAt: string;
  access: AccessLevel;
}

export interface FreeResultDto extends ResultBase {
  access: "FREE";
  /** 明确告诉客户端哪些字段因未订阅而缺失，前端据此渲染模糊遮罩 */
  locked: readonly ProtectedResultField[];
  paywall: {
    title: string;
    description: string;
    /** 免费用户可见的曲线点数，用于展示一个「被截断」的预览 */
    previewWeeks: number;
  };
}

export interface PremiumResultDto extends ResultBase {
  access: "PREMIUM";
  targetDate: string | null;
  weeksToGoal: number;
  effectiveWeeklyRateKg: number;
  weeklyProjection: ProjectionPoint[];
}

export type ResultDto = FreeResultDto | PremiumResultDto;

/** Prisma 的 Decimal 与 Json 都不是原生 JSON 类型，统一在这里落地转换 */
const toNumber = (value: unknown): number => Number(value);

function toBase(record: AssessmentResult): Omit<ResultBase, "access"> {
  return {
    sessionId: record.sessionId,
    bmi: toNumber(record.bmi),
    bmiCategory: record.bmiCategory,
    bmr: record.bmr,
    tdee: record.tdee,
    recommendedCalories: record.recommendedCalories,
    macros: {
      proteinG: record.proteinG,
      carbsG: record.carbsG,
      fatG: record.fatG,
    },
    warnings: (record.warnings as unknown as AssessmentWarning[]) ?? [],
    algorithmVersion: record.algorithmVersion,
    computedAt: record.computedAt.toISOString(),
  };
}

/**
 * 序列化结果页响应。
 *
 * 这是唯一允许把 AssessmentResult 转成对外响应的地方。
 * 任何路由都不得直接把 Prisma 记录塞进 NextResponse.json，
 * 否则整套保护形同虚设。
 */
export function serializeResult(
  record: AssessmentResult,
  access: AccessLevel,
): ResultDto {
  const base = toBase(record);

  if (access === "PREMIUM") {
    return {
      ...base,
      access: "PREMIUM",
      targetDate: record.targetDate ? record.targetDate.toISOString().slice(0, 10) : null,
      weeksToGoal: record.weeksToGoal,
      effectiveWeeklyRateKg: toNumber(record.effectiveWeeklyRateKg),
      weeklyProjection: (record.weeklyProjection as unknown as ProjectionPoint[]) ?? [],
    };
  }

  // 免费形态：只由 base 拼装，付费字段一个都不出现。
  // 注意这里没有 spread 任何包含付费字段的对象，也没有 delete。
  return {
    ...base,
    access: "FREE",
    locked: PROTECTED_RESULT_FIELDS,
    paywall: {
      title: "解锁你的完整计划",
      description:
        "订阅后可查看预计达成日期、逐周体重曲线，以及为你量身定制的完整方案。",
      previewWeeks: 0,
    },
  };
}
