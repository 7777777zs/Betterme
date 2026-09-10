import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { hashToken } from "../src/lib/auth/token";
import { computeAssessment } from "../src/lib/health/algorithm";
import type { AssessmentInput } from "../src/lib/health/types";

/**
 * 演示数据种子。
 *
 * 交付要求里有一条：「提供一个已支付的测试 sessionId，让我们能直接对比
 * 付费前后的差异化返回」。这个脚本生成两个除订阅状态外**完全相同**的会话，
 * 评审拿同一份输入的两个结果页一对比，差异一目了然。
 *
 * 关键取舍：结果不是手写的假数据，而是真的跑一遍生产算法算出来的。
 * 手写行能让演示看起来好看，但也能掩盖算法本身的问题。
 *
 * 幂等：固定 UUID + 先删后建。重复执行不会堆积垃圾数据，
 * README 里写死的 sessionId 也就永远有效。
 */

const DEMO = {
  free: {
    sessionId: "11111111-1111-4111-8111-111111111111",
    userId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
    token: "demo-free-token-do-not-use-in-production",
  },
  paid: {
    sessionId: "22222222-2222-4222-8222-222222222222",
    userId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
    token: "demo-paid-token-do-not-use-in-production",
  },
} as const;

/** 两个会话共用同一组作答，确保差异只来自订阅状态 */
const ANSWERS = {
  gender: { gender: "FEMALE" },
  goal: { goal: "LOSE_WEIGHT" },
  focus_areas: { areas: ["BELLY", "LEGS"] },
  body_metrics: {
    unitSystem: "METRIC",
    age: 29,
    heightCm: 166,
    weightKg: 72,
    goalWeightKg: 61,
  },
  activity_level: { activityLevel: "LIGHT" },
} as const;

const INPUT: AssessmentInput = {
  gender: "FEMALE",
  goal: "LOSE_WEIGHT",
  age: 29,
  heightCm: 166,
  weightKg: 72,
  goalWeightKg: 61,
  activityLevel: "LIGHT",
};

function client(): PrismaClient {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("需要 DIRECT_URL 或 DATABASE_URL");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

async function seedSession(
  prisma: PrismaClient,
  demo: (typeof DEMO)[keyof typeof DEMO],
  paid: boolean,
): Promise<void> {
  const now = new Date();
  const output = computeAssessment(INPUT, now);

  await prisma.$transaction(async (tx) => {
    // 先删用户，级联清掉会话、作答、流水、结果、订阅
    await tx.user.deleteMany({ where: { id: demo.userId } });

    await tx.user.create({
      data: {
        id: demo.userId,
        anonTokenHash: hashToken(demo.token),
        subscription: {
          create: paid
            ? {
                status: "ACTIVE",
                plan: "monthly",
                currentPeriodStart: now,
                currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000),
                activatedAt: now,
              }
            : { status: "NONE" },
        },
      },
    });

    await tx.quizSession.create({
      data: {
        id: demo.sessionId,
        userId: demo.userId,
        status: "COMPLETED",
        currentStep: null,
        completedAt: now,
        expiresAt: new Date(now.getTime() + 365 * 86_400_000),
        version: Object.keys(ANSWERS).length,
      },
    });

    for (const [stepKey, value] of Object.entries(ANSWERS)) {
      await tx.quizAnswer.create({
        data: { sessionId: demo.sessionId, stepKey, value, revision: 1 },
      });
      await tx.quizAnswerEvent.create({
        data: {
          sessionId: demo.sessionId,
          stepKey,
          value,
          revision: 1,
          sessionVersion: 1,
        },
      });
    }

    await tx.assessmentResult.create({
      data: {
        sessionId: demo.sessionId,
        gender: INPUT.gender,
        goal: INPUT.goal,
        activityLevel: INPUT.activityLevel,
        inputAge: INPUT.age,
        inputHeightCm: INPUT.heightCm,
        inputWeightKg: INPUT.weightKg,
        inputGoalWeightKg: INPUT.goalWeightKg,
        bmi: output.bmi,
        bmiCategory: output.bmiCategory,
        bmr: output.bmr,
        tdee: output.tdee,
        recommendedCalories: output.recommendedCalories,
        proteinG: output.macros.proteinG,
        carbsG: output.macros.carbsG,
        fatG: output.macros.fatG,
        warnings: output.warnings,
        targetDate: output.targetDate ? new Date(`${output.targetDate}T00:00:00.000Z`) : null,
        weeksToGoal: output.weeksToGoal,
        effectiveWeeklyRateKg: output.effectiveWeeklyRateKg,
        weeklyProjection: output.weeklyProjection,
        algorithmVersion: output.algorithmVersion,
      },
    });

    if (paid) {
      await tx.paymentEvent.create({
        data: {
          idempotencyKey: `seed_demo_paid_${demo.sessionId}`,
          userId: demo.userId,
          sessionId: demo.sessionId,
          provider: "mock",
          eventType: "CHECKOUT_COMPLETED",
          amountCents: 2999,
          currency: "USD",
          rawPayload: { seeded: true, plan: "monthly" },
          processedAt: now,
        },
      });
    }
  });
}

async function main(): Promise<void> {
  const prisma = client();

  try {
    await seedSession(prisma, DEMO.free, false);
    await seedSession(prisma, DEMO.paid, true);

    const result = await prisma.assessmentResult.findUniqueOrThrow({
      where: { sessionId: DEMO.paid.sessionId },
    });

    console.log("\n演示数据已写入。两个会话的作答完全相同，只有订阅状态不同。\n");
    console.log("未付费会话");
    console.log(`  sessionId  ${DEMO.free.sessionId}`);
    console.log(`  token      ${DEMO.free.token}`);
    console.log("已付费会话");
    console.log(`  sessionId  ${DEMO.paid.sessionId}`);
    console.log(`  token      ${DEMO.paid.token}`);
    console.log(`\n两者的算法结果一致：BMI ${result.bmi}，建议摄入 ${result.recommendedCalories} 千卡`);
    console.log(`付费方额外可见：目标日期与 ${(result.weeklyProjection as unknown[]).length} 周的体重曲线\n`);
  } finally {
    await prisma.$disconnect();
  }
}

await main();
