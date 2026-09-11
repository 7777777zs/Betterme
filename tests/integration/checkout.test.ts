import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRequest, call, type ErrorBody } from "../helpers/api";
import { hasTestDatabase, resetDatabase } from "../helpers/db";
import { disconnectTestPrisma, prismaModuleMock, testPrisma } from "../helpers/test-prisma";

vi.mock("@/lib/db/prisma", () => prismaModuleMock);

const { POST: createSessionRoute } = await import("@/app/api/v1/sessions/route");
const { PATCH: saveAnswerRoute } = await import(
  "@/app/api/v1/sessions/[id]/answers/[stepKey]/route"
);
const { POST: submitRoute } = await import("@/app/api/v1/sessions/[id]/submit/route");
const { GET: resultRoute } = await import("@/app/api/v1/sessions/[id]/result/route");
const { POST: checkoutRoute } = await import("@/app/api/v1/checkout/route");

/**
 * /checkout 的接口测试。
 *
 * 这个路由此前覆盖率为 0%。已有的支付测试打的是 /pay，
 * 而浏览器点「立即解锁」走的是 /checkout —— 后者复用 processPayment，
 * 所以业务逻辑是同一份，但**路由自己的鉴权、参数校验和错误处理
 * 完全没有被验证过**。测 /pay 不会顺带覆盖 /checkout。
 *
 * 这里补的正是那一层：身份、入参、错误路径，以及它与结果页的联动。
 */

const SECRET = "integration-test-secret";

interface Session {
  sessionId: string;
  token: string;
}

interface CheckoutBody {
  ok: boolean;
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

async function completedSession(): Promise<Session> {
  const created = await call<Session>(
    createSessionRoute as never,
    buildRequest("POST", "/api/v1/sessions"),
  );
  const session = created.body;

  for (const [stepKey, value] of Object.entries(answers)) {
    await call(
      saveAnswerRoute as never,
      buildRequest("PATCH", `/api/v1/sessions/${session.sessionId}/answers/${stepKey}`, {
        body: value,
        token: session.token,
      }),
      { id: session.sessionId, stepKey },
    );
  }

  await call(
    submitRoute as never,
    buildRequest("POST", `/api/v1/sessions/${session.sessionId}/submit`, {
      token: session.token,
    }),
    { id: session.sessionId },
  );

  return session;
}

function checkout(
  body: unknown,
  token?: string,
): Promise<{ status: number; body: CheckoutBody & ErrorBody }> {
  return call<CheckoutBody & ErrorBody>(
    checkoutRoute as never,
    buildRequest("POST", "/api/v1/checkout", { body, token }),
  );
}

function readResult(session: Session) {
  return call<{ access: string } & ErrorBody>(
    resultRoute as never,
    buildRequest("GET", `/api/v1/sessions/${session.sessionId}/result`, {
      token: session.token,
    }),
    { id: session.sessionId },
  );
}

describe.skipIf(!hasTestDatabase())("浏览器端的模拟购买 /checkout", () => {
  beforeAll(() => {
    process.env.PAY_WEBHOOK_SECRET = SECRET;
  });

  beforeEach(async () => {
    await resetDatabase(testPrisma());
  });

  afterAll(async () => {
    await disconnectTestPrisma();
  });

  describe("正常路径", () => {
    it("开通订阅并让结果页从脱敏变完整", async () => {
      const session = await completedSession();

      expect((await readResult(session)).body.access).toBe("FREE");

      const response = await checkout(
        { sessionId: session.sessionId, plan: "monthly" },
        session.token,
      );

      expect(response.status).toBe(200);
      expect(response.body.applied).toBe(true);
      expect(response.body.subscription.status).toBe("ACTIVE");
      expect(response.body.subscription.plan).toBe("monthly");

      expect((await readResult(session)).body.access).toBe("PREMIUM");
    });

    it("复用与真实回调同一条落库路径，流水照常留存", async () => {
      const session = await completedSession();
      await checkout({ sessionId: session.sessionId, plan: "weekly" }, session.token);

      const event = await testPrisma().paymentEvent.findFirstOrThrow();
      expect(event.provider).toBe("mock");
      expect(event.eventType).toBe("CHECKOUT_COMPLETED");
      expect(event.amountCents).toBe(999);
      expect(event.processedAt).not.toBeNull();
      // 原始报文里标注了来源，对账时能区分网关回调与站内购买
      expect(event.rawPayload).toMatchObject({ source: "web_checkout" });
    });

    it("连续两次购买，周期顺延而不是重新起算", async () => {
      const session = await completedSession();

      const first = await checkout(
        { sessionId: session.sessionId, plan: "weekly" },
        session.token,
      );
      const second = await checkout(
        { sessionId: session.sessionId, plan: "weekly" },
        session.token,
      );

      // 提前续费不该让用户损失已付费的剩余天数
      expect(new Date(second.body.subscription.currentPeriodEnd!).getTime()).toBeGreaterThan(
        new Date(first.body.subscription.currentPeriodEnd!).getTime(),
      );
      expect(await testPrisma().paymentEvent.count()).toBe(2);
    });
  });

  describe("身份校验", () => {
    it("缺少 Bearer token 时拒绝", async () => {
      const session = await completedSession();

      const response = await checkout({
        sessionId: session.sessionId,
        plan: "monthly",
      });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("UNAUTHORIZED");
      expect((await readResult(session)).body.access).toBe("FREE");
    });

    it("拿别人的 token 无法给自己或对方开通", async () => {
      // 少了这道检查，任何人拿到一个 sessionId 就能给对方开会员，
      // 或者更糟 —— 用别人的会话给自己开
      const victim = await completedSession();
      const attacker = await completedSession();

      const response = await checkout(
        { sessionId: victim.sessionId, plan: "monthly" },
        attacker.token,
      );

      expect(response.status).toBe(404);
      expect((await readResult(victim)).body.access).toBe("FREE");
      expect((await readResult(attacker)).body.access).toBe("FREE");
    });

    it("不存在的会话返回 404，与越权访问表现一致", async () => {
      const session = await completedSession();

      const response = await checkout(
        { sessionId: "00000000-0000-4000-8000-000000000000", plan: "monthly" },
        session.token,
      );

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("SESSION_NOT_FOUND");
    });
  });

  describe("入参校验", () => {
    it("拒绝未知套餐", async () => {
      const session = await completedSession();
      const response = await checkout(
        { sessionId: session.sessionId, plan: "lifetime" },
        session.token,
      );
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe("VALIDATION_FAILED");
    });

    it("拒绝非 UUID 的 sessionId", async () => {
      const session = await completedSession();
      const response = await checkout(
        { sessionId: "not-a-uuid", plan: "monthly" },
        session.token,
      );
      expect(response.status).toBe(422);
    });

    it("拒绝多余字段，防止客户端塞进自造的订阅状态", async () => {
      const session = await completedSession();
      const response = await checkout(
        { sessionId: session.sessionId, plan: "monthly", status: "ACTIVE", amountCents: 1 },
        session.token,
      );
      expect(response.status).toBe(422);

      const subscription = await testPrisma().subscription.findFirstOrThrow({
        where: { user: { sessions: { some: { id: session.sessionId } } } },
      });
      expect(subscription.status).toBe("NONE");
    });

    it("拒绝缺字段与空请求体", async () => {
      const session = await completedSession();
      expect((await checkout({}, session.token)).status).toBe(422);
      expect(
        (await checkout({ sessionId: session.sessionId }, session.token)).status,
      ).toBe(422);
    });

    it("拒绝畸形 JSON", async () => {
      const session = await completedSession();
      const response = await checkout("{not json", session.token);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("MALFORMED_JSON");
    });
  });

  describe("与会话状态的联动", () => {
    it("尚未提交的会话也能购买，订阅挂在用户而不是结果上", async () => {
      // 订阅属于用户。允许先付费再完成测评，不该因为结果还没生成就拒绝收钱。
      const created = await call<Session>(
        createSessionRoute as never,
        buildRequest("POST", "/api/v1/sessions"),
      );
      const session = created.body;

      const response = await checkout(
        { sessionId: session.sessionId, plan: "monthly" },
        session.token,
      );
      expect(response.status).toBe(200);
      expect(response.body.subscription.status).toBe("ACTIVE");
    });
  });
});
