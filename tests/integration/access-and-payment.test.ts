import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRequest,
  buildSignedPayRequest,
  call,
  type ErrorBody,
} from "../helpers/api";
import { hasTestDatabase, resetDatabase } from "../helpers/db";
import { disconnectTestPrisma, prismaModuleMock, testPrisma } from "../helpers/test-prisma";
import { PROTECTED_RESULT_FIELDS } from "@/lib/dto/result";

vi.mock("@/lib/db/prisma", () => prismaModuleMock);

const { POST: createSessionRoute } = await import("@/app/api/v1/sessions/route");
const { PATCH: saveAnswerRoute } = await import(
  "@/app/api/v1/sessions/[id]/answers/[stepKey]/route"
);
const { POST: submitRoute } = await import("@/app/api/v1/sessions/[id]/submit/route");
const { GET: resultRoute } = await import("@/app/api/v1/sessions/[id]/result/route");
const { POST: payRoute } = await import("@/app/api/v1/pay/route");
const { GET: subscriptionRoute } = await import("@/app/api/v1/me/subscription/route");

const SECRET = "integration-test-secret";

interface Session {
  sessionId: string;
  token: string;
}

interface ResultBody {
  access: "FREE" | "PREMIUM";
  bmi: number;
  tdee: number;
  recommendedCalories: number;
  locked?: string[];
  paywall?: { title: string };
  targetDate?: string | null;
  weeksToGoal?: number;
  weeklyProjection?: Array<{ week: number; weightKg: number; date: string }>;
}

interface PayBody {
  applied: boolean;
  subscription: { status: string; plan: string | null; currentPeriodEnd: string | null };
}

const answers = {
  gender: { gender: "FEMALE" },
  goal: { goal: "LOSE_WEIGHT" },
  body_metrics: {
    unitSystem: "METRIC",
    age: 28,
    heightCm: 165,
    weightKg: 70,
    goalWeightKg: 60,
  },
  activity_level: { activityLevel: "LIGHT" },
} as const;

/** 建一个已完成测评、已生成结果、但尚未付费的会话 */
async function completedSession(): Promise<Session> {
  const createResponse = await call<Session>(
    createSessionRoute as never,
    buildRequest("POST", "/api/v1/sessions"),
  );
  const session = createResponse.body;

  for (const [stepKey, value] of Object.entries(answers)) {
    const response = await call(
      saveAnswerRoute as never,
      buildRequest("PATCH", `/api/v1/sessions/${session.sessionId}/answers/${stepKey}`, {
        body: value,
        token: session.token,
      }),
      { id: session.sessionId, stepKey },
    );
    expect(response.status).toBe(200);
  }

  const submitted = await call(
    submitRoute as never,
    buildRequest("POST", `/api/v1/sessions/${session.sessionId}/submit`, {
      token: session.token,
    }),
    { id: session.sessionId },
  );
  expect(submitted.status).toBe(200);

  return session;
}

function readResult(session: Session, token?: string) {
  return call<ResultBody & ErrorBody>(
    resultRoute as never,
    buildRequest("GET", `/api/v1/sessions/${session.sessionId}/result`, {
      token: token ?? session.token,
    }),
    { id: session.sessionId },
  );
}

function pay(
  session: Session,
  overrides: Record<string, unknown> = {},
  options: { secret?: string; signature?: string } = {},
) {
  return call<PayBody & ErrorBody>(
    payRoute as never,
    buildSignedPayRequest(
      {
        sessionId: session.sessionId,
        plan: "monthly",
        idempotencyKey: `evt_${session.sessionId.slice(0, 8)}_0001`,
        ...overrides,
      },
      options.secret ?? SECRET,
      options.signature,
    ),
  );
}

describe.skipIf(!hasTestDatabase())("订阅鉴权、差异化返回与支付闭环", () => {
  beforeAll(() => {
    process.env.PAY_WEBHOOK_SECRET = SECRET;
  });

  beforeEach(async () => {
    await resetDatabase(testPrisma());
  });

  afterAll(async () => {
    await disconnectTestPrisma();
  });

  // -------------------------------------------------------------------------

  describe("提交测评", () => {
    it("必填步骤缺失时拒绝提交并列出缺哪几步", async () => {
      const created = await call<Session>(
        createSessionRoute as never,
        buildRequest("POST", "/api/v1/sessions"),
      );
      const session = created.body;

      await call(
        saveAnswerRoute as never,
        buildRequest("PATCH", `/api/v1/sessions/${session.sessionId}/answers/gender`, {
          body: answers.gender,
          token: session.token,
        }),
        { id: session.sessionId, stepKey: "gender" },
      );

      const response = await call<ErrorBody>(
        submitRoute as never,
        buildRequest("POST", `/api/v1/sessions/${session.sessionId}/submit`, {
          token: session.token,
        }),
        { id: session.sessionId },
      );

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe("INCOMPLETE_SUBMISSION");
      expect(response.body.error.meta?.missingSteps).toEqual(
        expect.arrayContaining(["goal", "body_metrics", "activity_level"]),
      );
    });

    it("提交后会话被标记完成，结果与输入快照一并落库", async () => {
      const session = await completedSession();

      const stored = await testPrisma().quizSession.findUniqueOrThrow({
        where: { id: session.sessionId },
        include: { result: true },
      });

      expect(stored.status).toBe("COMPLETED");
      expect(stored.completedAt).not.toBeNull();
      expect(stored.result).not.toBeNull();
      // 结果行自带算出它的那组输入，事后可复现
      expect(stored.result!.gender).toBe("FEMALE");
      expect(Number(stored.result!.inputWeightKg)).toBe(70);
      expect(stored.result!.algorithmVersion).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it("重复提交是幂等的，不重算也不报错", async () => {
      const session = await completedSession();

      const again = await call<{ recomputed: boolean; resultId: string }>(
        submitRoute as never,
        buildRequest("POST", `/api/v1/sessions/${session.sessionId}/submit`, {
          token: session.token,
        }),
        { id: session.sessionId },
      );

      expect(again.status).toBe(200);
      expect(again.body.recomputed).toBe(false);

      const count = await testPrisma().assessmentResult.count({
        where: { sessionId: session.sessionId },
      });
      expect(count).toBe(1);
    });

    it("未提交时读结果页返回 409 而不是空数据", async () => {
      const created = await call<Session>(
        createSessionRoute as never,
        buildRequest("POST", "/api/v1/sessions"),
      );
      const response = await readResult(created.body);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("RESULT_NOT_READY");
    });
  });

  // -------------------------------------------------------------------------

  describe("非会员的脱敏返回", () => {
    it("受保护字段在响应里根本不存在，而不是为 null", async () => {
      const session = await completedSession();
      const response = await readResult(session);

      expect(response.status).toBe(200);
      expect(response.body.access).toBe("FREE");

      const keys = Object.keys(response.body);
      for (const field of PROTECTED_RESULT_FIELDS) {
        expect(keys).not.toContain(field);
      }
    });

    it("响应原文里不含任何一个曲线数值", async () => {
      const session = await completedSession();
      const response = await readResult(session);

      // 直接拿库里的真值去原文里搜，比逐字段断言更难被绕过
      const stored = await testPrisma().assessmentResult.findUniqueOrThrow({
        where: { sessionId: session.sessionId },
      });
      const projection = stored.weeklyProjection as Array<{ weightKg: number; date: string }>;

      const text = JSON.stringify(response.body);
      for (const point of projection.slice(0, 5)) {
        expect(text).not.toContain(String(point.weightKg));
        expect(text).not.toContain(point.date);
      }
      expect(text).not.toContain(stored.targetDate!.toISOString().slice(0, 10));
    });

    it("免费字段照常可见", async () => {
      const session = await completedSession();
      const response = await readResult(session);

      expect(response.body.bmi).toBeGreaterThan(0);
      expect(response.body.tdee).toBeGreaterThan(0);
      expect(response.body.recommendedCalories).toBeGreaterThan(0);
      expect(response.body.paywall?.title).toBeTruthy();
      expect(response.body.locked).toEqual([...PROTECTED_RESULT_FIELDS]);
    });

    it("订阅状态接口显示为免费", async () => {
      const session = await completedSession();
      const response = await call<{ access: string; status: string }>(
        subscriptionRoute as never,
        buildRequest("GET", `/api/v1/me/subscription?sessionId=${session.sessionId}`, {
          token: session.token,
        }),
      );
      expect(response.body.access).toBe("FREE");
      expect(response.body.status).toBe("NONE");
    });
  });

  // -------------------------------------------------------------------------

  describe("支付回调", () => {
    it("签名正确时开通订阅", async () => {
      const session = await completedSession();
      const response = await pay(session);

      expect(response.status).toBe(200);
      expect(response.body.applied).toBe(true);
      expect(response.body.subscription.status).toBe("ACTIVE");
      expect(response.body.subscription.plan).toBe("monthly");
    });

    it("缺少签名头时拒绝，且不改变订阅状态", async () => {
      const session = await completedSession();

      const response = await call<ErrorBody>(
        payRoute as never,
        buildRequest("POST", "/api/v1/pay", {
          body: { sessionId: session.sessionId, plan: "monthly", idempotencyKey: "evt_x_1" },
        }),
      );

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("INVALID_SIGNATURE");

      const after = await readResult(session);
      expect(after.body.access).toBe("FREE");
    });

    it("用错误密钥签名时拒绝", async () => {
      const session = await completedSession();
      const response = await pay(session, {}, { secret: "wrong-secret" });
      expect(response.status).toBe(401);
    });

    it("报文被篡改后签名失效", async () => {
      const session = await completedSession();
      const response = await pay(
        session,
        {},
        { signature: "0".repeat(64) },
      );
      expect(response.status).toBe(401);
    });

    it("金额与套餐价不符时拒绝，防止客户端改价", async () => {
      const session = await completedSession();
      const response = await pay(session, { amountCents: 1 });
      expect(response.status).toBe(422);

      const subscription = await testPrisma().subscription.findFirstOrThrow();
      expect(subscription.status).toBe("NONE");
    });

    it("会话不存在时拒绝", async () => {
      const session = await completedSession();
      const response = await pay(session, {
        sessionId: "00000000-0000-4000-8000-000000000000",
      });
      expect(response.status).toBe(404);
    });

    it("拒绝未知套餐", async () => {
      const session = await completedSession();
      const response = await pay(session, { plan: "lifetime" });
      expect(response.status).toBe(422);
    });
  });

  // -------------------------------------------------------------------------

  describe("回调幂等", () => {
    it("同一幂等键重放只开通一次", async () => {
      const session = await completedSession();

      const first = await pay(session);
      const second = await pay(session);
      const third = await pay(session);

      expect(first.body.applied).toBe(true);
      expect(second.body.applied).toBe(false);
      expect(third.body.applied).toBe(false);

      // 重放对网关来说也是成功，返回错误码只会让它继续重试
      expect(second.status).toBe(200);

      const events = await testPrisma().paymentEvent.count();
      expect(events).toBe(1);
    });

    it("重放不会延长订阅周期", async () => {
      const session = await completedSession();

      const first = await pay(session);
      const second = await pay(session);

      expect(second.body.subscription.currentPeriodEnd).toBe(
        first.body.subscription.currentPeriodEnd,
      );
    });

    it("并发重放同一幂等键，仍然只有一条流水", async () => {
      const session = await completedSession();

      // 先查后写的实现会在这里出现竞态：两个请求可能同时查到「没处理过」。
      // 这里靠唯一索引在数据库层面串行化，无论并发多少都只有一个能插入成功。
      const responses = await Promise.all([
        pay(session),
        pay(session),
        pay(session),
        pay(session),
      ]);

      const applied = responses.filter((r) => r.body.applied);
      expect(applied).toHaveLength(1);
      expect(responses.every((r) => r.status === 200)).toBe(true);

      const events = await testPrisma().paymentEvent.count();
      expect(events).toBe(1);
    });

    it("不同幂等键视为两笔支付，周期顺延而不是重新起算", async () => {
      const session = await completedSession();

      const first = await pay(session, { idempotencyKey: "evt_first_0001" });
      const second = await pay(session, {
        idempotencyKey: "evt_second_0002",
        plan: "weekly",
      });

      expect(second.body.applied).toBe(true);
      // 提前续费不该让用户损失已付费的剩余天数
      expect(new Date(second.body.subscription.currentPeriodEnd!).getTime()).toBeGreaterThan(
        new Date(first.body.subscription.currentPeriodEnd!).getTime(),
      );

      const events = await testPrisma().paymentEvent.count();
      expect(events).toBe(2);
    });

    it("流水表留存了原始报文，可用于对账", async () => {
      const session = await completedSession();
      await pay(session);

      const event = await testPrisma().paymentEvent.findFirstOrThrow();
      expect(event.rawPayload).toMatchObject({ plan: "monthly" });
      expect(event.processedAt).not.toBeNull();
      expect(event.amountCents).toBe(2999);
      expect(event.currency).toBe("USD");
    });
  });

  // -------------------------------------------------------------------------

  describe("付费前后的端到端差异", () => {
    it("同一个会话，付费后结果页从脱敏变为完整", async () => {
      const session = await completedSession();

      const before = await readResult(session);
      expect(before.body.access).toBe("FREE");
      expect(Object.keys(before.body)).not.toContain("weeklyProjection");

      const payment = await pay(session);
      expect(payment.body.applied).toBe(true);

      const after = await readResult(session);
      expect(after.status).toBe(200);
      expect(after.body.access).toBe("PREMIUM");
      expect(after.body.weeklyProjection!.length).toBeGreaterThan(0);
      expect(after.body.targetDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(after.body.weeksToGoal).toBeGreaterThan(0);

      // 免费字段在付费前后必须完全一致，付费买的是更多数据不是不同数据
      expect(after.body.bmi).toBe(before.body.bmi);
      expect(after.body.tdee).toBe(before.body.tdee);
      expect(after.body.recommendedCalories).toBe(before.body.recommendedCalories);
    });

    it("付费用户的曲线数据与库里存的一致", async () => {
      const session = await completedSession();
      await pay(session);

      const response = await readResult(session);
      const stored = await testPrisma().assessmentResult.findUniqueOrThrow({
        where: { sessionId: session.sessionId },
      });

      expect(response.body.weeklyProjection).toEqual(stored.weeklyProjection);
    });

    it("A 付费不会让 B 也变成会员", async () => {
      const paid = await completedSession();
      const unpaid = await completedSession();

      await pay(paid);

      const paidResult = await readResult(paid);
      const unpaidResult = await readResult(unpaid);

      expect(paidResult.body.access).toBe("PREMIUM");
      expect(unpaidResult.body.access).toBe("FREE");
      expect(Object.keys(unpaidResult.body)).not.toContain("weeklyProjection");
    });

    it("订阅过期后重新降级为脱敏返回", async () => {
      const session = await completedSession();
      await pay(session);
      expect((await readResult(session)).body.access).toBe("PREMIUM");

      // 把周期末拨到过去，模拟订阅到期
      const stored = await testPrisma().quizSession.findUniqueOrThrow({
        where: { id: session.sessionId },
      });
      await testPrisma().subscription.update({
        where: { userId: stored.userId },
        // status 仍是 ACTIVE，只有周期末过期。
        // 只看 status 的实现会在这里漏判，把过期用户当会员。
        data: { currentPeriodEnd: new Date(Date.now() - 1000) },
      });

      const after = await readResult(session);
      expect(after.body.access).toBe("FREE");
      expect(Object.keys(after.body)).not.toContain("weeklyProjection");
    });

    it("付费用户的 token 泄漏给他人时，他人也拿不到数据", async () => {
      const paid = await completedSession();
      const other = await completedSession();
      await pay(paid);

      // 用别人的 token 访问付费会话
      const response = await readResult(paid, other.token);
      expect(response.status).toBe(404);
    });
  });
});
