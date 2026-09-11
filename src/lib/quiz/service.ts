import type { Prisma, PrismaClient, QuizSession } from "@/generated/prisma/client";
import { generateToken, hashToken } from "@/lib/auth/token";
import { computeAssessment } from "@/lib/health/algorithm";
import type { AssessmentInput } from "@/lib/health/types";
import { errors } from "@/lib/http/errors";
import {
  type StepKey,
  missingRequiredSteps,
  nextStepFor,
  progressPercent,
  stepSchemas,
  storedStepSchemas,
} from "./steps";

const DEFAULT_TTL_HOURS = 720;

function ttlHours(): number {
  const raw = Number(process.env.SESSION_TTL_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_HOURS;
}

export interface CreatedSession {
  sessionId: string;
  /** 明文 token，只在这里返回一次，服务端不再持有 */
  token: string;
  userId: string;
  expiresAt: string;
  currentStep: StepKey | null;
  version: number;
}

/**
 * 创建匿名用户与测评会话。
 *
 * 用户、订阅记录、会话在同一个事务里创建：
 * 缺了订阅记录的用户会让后续所有权限判断多一个 null 分支，
 * 与其到处防御，不如在源头保证它一定存在。
 */
export async function createSession(prisma: PrismaClient): Promise<CreatedSession> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + ttlHours() * 3600 * 1000);

  const session = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        anonTokenHash: hashToken(token),
        subscription: { create: { status: "NONE" } },
      },
    });

    return tx.quizSession.create({
      data: {
        userId: user.id,
        expiresAt,
        currentStep: nextStepFor([]),
      },
    });
  });

  return {
    sessionId: session.id,
    token,
    userId: session.userId,
    expiresAt: session.expiresAt.toISOString(),
    currentStep: session.currentStep as StepKey | null,
    version: session.version,
  };
}

export interface SessionStateDto {
  sessionId: string;
  status: QuizSession["status"];
  version: number;
  currentStep: StepKey | null;
  progressPercent: number;
  answeredSteps: StepKey[];
  missingRequiredSteps: StepKey[];
  answers: Record<string, unknown>;
  hasResult: boolean;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 进度恢复。用户中途关页面再回来，前端拿这个响应就能把表单原样还原。
 *
 * 返回的是「已作答内容 + 下一步 + 当前版本号」三件套：
 * 少了版本号，客户端就无法在后续写入时参与乐观锁。
 */
export async function getSessionState(
  prisma: PrismaClient,
  sessionId: string,
): Promise<SessionStateDto> {
  const session = await prisma.quizSession.findUnique({
    where: { id: sessionId },
    include: {
      answers: { orderBy: { stepKey: "asc" } },
      result: { select: { id: true } },
    },
  });

  if (!session) throw errors.sessionNotFound();

  const answeredSteps = session.answers.map((a) => a.stepKey as StepKey);
  const answers: Record<string, unknown> = {};
  for (const answer of session.answers) {
    answers[answer.stepKey] = answer.value;
  }

  return {
    sessionId: session.id,
    status: session.status,
    version: session.version,
    currentStep: nextStepFor(answeredSteps),
    progressPercent: progressPercent(answeredSteps),
    answeredSteps,
    missingRequiredSteps: missingRequiredSteps(answeredSteps),
    answers,
    hasResult: session.result !== null,
    expiresAt: session.expiresAt.toISOString(),
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}

export interface SaveAnswerResult {
  sessionId: string;
  stepKey: StepKey;
  revision: number;
  version: number;
  currentStep: StepKey | null;
  progressPercent: number;
  answeredSteps: StepKey[];
  value: unknown;
}

/**
 * 分步增量保存。
 *
 * 并发控制用乐观锁：更新语句自带 `where version = expectedVersion`，
 * 影响行数为 0 就说明有人抢先改过，抛 409 让客户端基于最新状态重试。
 *
 * 为什么不用悲观锁（SELECT FOR UPDATE）：测评填写是低冲突场景，
 * 悲观锁会在 serverless 环境下把连接占住，代价远大于收益。
 *
 * expectedVersion 允许为 undefined。此时退化为「后写覆盖」，
 * 但仍然递增版本号并写入流水，不会破坏数据一致性。
 * 这是给简单客户端留的口子，代价写在 README 里。
 */
export async function saveAnswer(
  prisma: PrismaClient,
  params: {
    sessionId: string;
    stepKey: StepKey;
    rawValue: unknown;
    expectedVersion?: number;
  },
): Promise<SaveAnswerResult> {
  const schema = stepSchemas[params.stepKey];
  // 校验放在事务外：非法输入不该占用数据库连接和事务资源
  const value = schema.parse(params.rawValue) as Prisma.InputJsonValue;

  return prisma.$transaction(async (tx) => {
    // 状态条件写进 SQL，而不是只依赖调用前的 assertWritable。
    //
    // 那道应用层检查和这里的写入之间存在时间窗：另一个请求可能恰好在
    // 这期间把会话作废或完成掉。只靠应用层检查的话，就会出现
    // 「库里标着已放弃，答案却还在增长」这种自相矛盾的记录。
    // 把状态放进 where 条件，数据库层面就不可能出现这种状态。
    const bump = await tx.quizSession.updateMany({
      where: {
        id: params.sessionId,
        status: "IN_PROGRESS",
        ...(params.expectedVersion === undefined
          ? {}
          : { version: params.expectedVersion }),
      },
      data: { version: { increment: 1 } },
    });

    if (bump.count === 0) {
      // 影响行数为 0 有四种可能：会话不存在、已作废、已完成、版本不符。
      // 必须区分开：版本冲突该让客户端拿最新版本重试，
      // 作废该让它开一个新会话，两者的应对完全不同。
      const current = await tx.quizSession.findUnique({
        where: { id: params.sessionId },
        select: { version: true, status: true },
      });
      if (!current) throw errors.sessionNotFound();
      if (current.status === "ABANDONED") throw errors.sessionAbandoned();
      if (current.status === "COMPLETED") throw errors.sessionAlreadyCompleted();
      throw errors.versionConflict(current.version);
    }

    const existing = await tx.quizAnswer.findUnique({
      where: { sessionId_stepKey: { sessionId: params.sessionId, stepKey: params.stepKey } },
      select: { revision: true },
    });
    const revision = (existing?.revision ?? 0) + 1;

    await tx.quizAnswer.upsert({
      where: { sessionId_stepKey: { sessionId: params.sessionId, stepKey: params.stepKey } },
      create: {
        sessionId: params.sessionId,
        stepKey: params.stepKey,
        value,
        revision,
      },
      update: { value, revision },
    });

    const session = await tx.quizSession.findUniqueOrThrow({
      where: { id: params.sessionId },
      include: { answers: { select: { stepKey: true } } },
    });

    const answeredSteps = session.answers.map((a) => a.stepKey as StepKey);
    const currentStep = nextStepFor(answeredSteps);

    // 作答流水，append-only。写在同一事务里，保证「有作答就一定有流水」。
    await tx.quizAnswerEvent.create({
      data: {
        sessionId: params.sessionId,
        stepKey: params.stepKey,
        value,
        revision,
        sessionVersion: session.version,
      },
    });

    await tx.quizSession.update({
      where: { id: params.sessionId },
      data: { currentStep },
    });

    return {
      sessionId: params.sessionId,
      stepKey: params.stepKey,
      revision,
      version: session.version,
      currentStep,
      progressPercent: progressPercent(answeredSteps),
      answeredSteps,
      value,
    };
  });
}

/**
 * 把分散在各步骤里的作答拼装成算法输入。
 *
 * 这里再解析一次而不是信任库里的 JSON：作答可能是几个月前写入的，
 * 期间 schema 可能已经改过。用当前 schema 重新解析，
 * 不兼容的历史数据会在提交时明确报错，而不是悄悄算出错误结果。
 *
 * 注意用的是 storedStepSchemas 而不是 stepSchemas。
 * 后者面向 HTTP 原始请求，会按 unitSystem 要求英制字段并做换算；
 * 但库里存的已经是换算完的公制值，拿入口 schema 去解析必然失败。
 * 英制用户曾经因此永远走不到结果页，见 storedStepSchemas 的注释。
 */
export function assembleAssessmentInput(
  answers: Record<string, unknown>,
): AssessmentInput {
  const gender = storedStepSchemas.gender.parse(answers.gender);
  const goal = storedStepSchemas.goal.parse(answers.goal);
  const body = storedStepSchemas.body_metrics.parse(answers.body_metrics);
  const activity = storedStepSchemas.activity_level.parse(answers.activity_level);

  return {
    gender: gender.gender,
    goal: goal.goal,
    age: body.age,
    heightCm: body.heightCm,
    weightKg: body.weightKg,
    goalWeightKg: body.goalWeightKg,
    activityLevel: activity.activityLevel,
  };
}

/**
 * 提交测评：完整性校验 → 计算 → 落库 → 标记完成。
 *
 * 幂等：重复提交同一个已完成的会话，直接返回已有结果，
 * 不重新计算也不报错。用户网络抖动导致的重复点击是常态。
 */
export async function submitSession(
  prisma: PrismaClient,
  sessionId: string,
  now: Date = new Date(),
): Promise<{ resultId: string; recomputed: boolean }> {
  const session = await prisma.quizSession.findUnique({
    where: { id: sessionId },
    include: { answers: true, result: { select: { id: true } } },
  });

  if (!session) throw errors.sessionNotFound();

  // 已有结果的会话走幂等分支：网络抖动导致的重复点击是常态
  if (session.result) {
    return { resultId: session.result.id, recomputed: false };
  }

  // 作废的会话不能再算出结果，否则它会从 ABANDONED 变回 COMPLETED，
  // 相当于用户点了「重新开始」却又被拖回旧会话。
  if (session.status === "ABANDONED") {
    throw errors.sessionAbandoned();
  }

  const answeredSteps = session.answers.map((a) => a.stepKey);
  const missing = missingRequiredSteps(answeredSteps);
  if (missing.length > 0) {
    throw errors.incompleteSubmission(missing);
  }

  const answers: Record<string, unknown> = {};
  for (const answer of session.answers) {
    answers[answer.stepKey] = answer.value;
  }

  const input = assembleAssessmentInput(answers);
  const output = computeAssessment(input, now);

  const result = await prisma.$transaction(async (tx) => {
    const created = await tx.assessmentResult.create({
      data: {
        sessionId,
        // 输入快照：让结果行自解释，事后可复现
        gender: input.gender,
        goal: input.goal,
        activityLevel: input.activityLevel,
        inputAge: input.age,
        inputHeightCm: input.heightCm,
        inputWeightKg: input.weightKg,
        inputGoalWeightKg: input.goalWeightKg,
        bmi: output.bmi,
        bmiCategory: output.bmiCategory,
        bmr: output.bmr,
        tdee: output.tdee,
        recommendedCalories: output.recommendedCalories,
        proteinG: output.macros.proteinG,
        carbsG: output.macros.carbsG,
        fatG: output.macros.fatG,
        warnings: output.warnings as unknown as Prisma.InputJsonValue,
        targetDate: output.targetDate ? new Date(`${output.targetDate}T00:00:00.000Z`) : null,
        weeksToGoal: output.weeksToGoal,
        effectiveWeeklyRateKg: output.effectiveWeeklyRateKg,
        weeklyProjection: output.weeklyProjection as unknown as Prisma.InputJsonValue,
        algorithmVersion: output.algorithmVersion,
      },
    });

    await tx.quizSession.update({
      where: { id: sessionId },
      data: {
        status: "COMPLETED",
        completedAt: now,
        currentStep: null,
        version: { increment: 1 },
      },
    });

    return created;
  });

  return { resultId: result.id, recomputed: true };
}
