import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { buildRequest, call, type ErrorBody } from "../helpers/api";
import { hasTestDatabase, resetDatabase } from "../helpers/db";
import { disconnectTestPrisma, prismaModuleMock, testPrisma } from "../helpers/test-prisma";

vi.mock("@/lib/db/prisma", () => prismaModuleMock);

const { POST: createSessionRoute } = await import("@/app/api/v1/sessions/route");
const { GET: getSessionRoute } = await import("@/app/api/v1/sessions/[id]/route");
const { PATCH: saveAnswerRoute } = await import(
  "@/app/api/v1/sessions/[id]/answers/[stepKey]/route"
);

interface CreatedSessionBody {
  sessionId: string;
  token: string;
  version: number;
  currentStep: string | null;
}

interface SessionStateBody {
  sessionId: string;
  status: string;
  version: number;
  currentStep: string | null;
  progressPercent: number;
  answeredSteps: string[];
  missingRequiredSteps: string[];
  answers: Record<string, unknown>;
  hasResult: boolean;
}

interface SaveAnswerBody {
  stepKey: string;
  revision: number;
  version: number;
  currentStep: string | null;
  answeredSteps: string[];
}

const body = {
  gender: { gender: "FEMALE" },
  goal: { goal: "LOSE_WEIGHT" },
  activity_level: { activityLevel: "LIGHT" },
  body_metrics: {
    unitSystem: "METRIC",
    age: 28,
    heightCm: 165,
    weightKg: 70,
    goalWeightKg: 60,
  },
} as const;

async function newSession(): Promise<CreatedSessionBody> {
  const response = await call<CreatedSessionBody>(
    createSessionRoute as never,
    buildRequest("POST", "/api/v1/sessions"),
  );
  expect(response.status).toBe(201);
  return response.body;
}

function saveAnswer(
  session: CreatedSessionBody,
  stepKey: keyof typeof body,
  options: { value?: unknown; ifMatch?: string; token?: string } = {},
) {
  return call<SaveAnswerBody & ErrorBody>(
    saveAnswerRoute as never,
    buildRequest("PATCH", `/api/v1/sessions/${session.sessionId}/answers/${stepKey}`, {
      body: options.value ?? body[stepKey],
      token: options.token ?? session.token,
      headers: options.ifMatch === undefined ? {} : { "if-match": options.ifMatch },
    }),
    { id: session.sessionId, stepKey },
  );
}

function readSession(session: CreatedSessionBody, token?: string) {
  return call<SessionStateBody & ErrorBody>(
    getSessionRoute as never,
    buildRequest("GET", `/api/v1/sessions/${session.sessionId}`, {
      token: token ?? session.token,
    }),
    { id: session.sessionId },
  );
}

describe.skipIf(!hasTestDatabase())("分步保存与进度恢复", () => {
  beforeAll(() => {
    process.env.PAY_WEBHOOK_SECRET ??= "integration-test-secret";
  });

  beforeEach(async () => {
    await resetDatabase(testPrisma());
  });

  afterAll(async () => {
    await disconnectTestPrisma();
  });

  // -------------------------------------------------------------------------

  describe("创建会话", () => {
    it("返回 sessionId 与一次性 token，并指向第一步", async () => {
      const session = await newSession();
      expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(session.token.length).toBeGreaterThan(20);
      expect(session.version).toBe(0);
      expect(session.currentStep).toBe("gender");
    });

    it("同时创建了用户与订阅记录，订阅初始为 NONE", async () => {
      const session = await newSession();
      const stored = await testPrisma().quizSession.findUniqueOrThrow({
        where: { id: session.sessionId },
        include: { user: { include: { subscription: true } } },
      });
      expect(stored.user.subscription?.status).toBe("NONE");
    });

    it("库里只存 token 摘要，不存明文", async () => {
      const session = await newSession();
      const user = await testPrisma().user.findFirstOrThrow();
      expect(user.anonTokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(user.anonTokenHash).not.toContain(session.token);
    });

    it("两次创建得到不同的会话与不同的 token", async () => {
      const a = await newSession();
      const b = await newSession();
      expect(a.sessionId).not.toBe(b.sessionId);
      expect(a.token).not.toBe(b.token);
    });
  });

  // -------------------------------------------------------------------------

  describe("增量保存", () => {
    it("逐步保存后进度与下一步同步推进", async () => {
      const session = await newSession();

      const first = await saveAnswer(session, "gender");
      expect(first.status).toBe(200);
      expect(first.body.currentStep).toBe("goal");
      expect(first.body.revision).toBe(1);

      const second = await saveAnswer(session, "goal");
      expect(second.body.currentStep).toBe("focus_areas");
      expect(second.body.answeredSteps).toEqual(
        expect.arrayContaining(["gender", "goal"]),
      );
    });

    it("每次保存都递增版本号，并通过 ETag 回带", async () => {
      const session = await newSession();
      const first = await saveAnswer(session, "gender");
      const second = await saveAnswer(session, "goal");

      expect(second.body.version).toBe(first.body.version + 1);
      expect(second.headers.get("etag")).toBe(String(second.body.version));
    });

    it("英制输入被换算成公制后落库", async () => {
      const session = await newSession();
      await saveAnswer(session, "body_metrics", {
        value: {
          unitSystem: "IMPERIAL",
          age: 28,
          heightIn: 65,
          weightLb: 154,
          goalWeightLb: 132,
        },
      });

      const stored = await testPrisma().quizAnswer.findFirstOrThrow({
        where: { sessionId: session.sessionId, stepKey: "body_metrics" },
      });
      const value = stored.value as Record<string, number | string>;
      expect(value.unitSystem).toBe("IMPERIAL");
      expect(Number(value.heightCm)).toBeCloseTo(165.1, 1);
      expect(Number(value.weightKg)).toBeCloseTo(69.9, 1);
      // 库里绝不能出现英制字段，否则同一列会混进两种量纲
      expect(value.weightLb).toBeUndefined();
      expect(value.heightIn).toBeUndefined();
    });

    it("拒绝未知步骤", async () => {
      const session = await newSession();
      const response = await call<ErrorBody>(
        saveAnswerRoute as never,
        buildRequest("PATCH", `/api/v1/sessions/${session.sessionId}/answers/hacked`, {
          body: { anything: true },
          token: session.token,
        }),
        { id: session.sessionId, stepKey: "hacked" },
      );
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("UNKNOWN_STEP");
    });

    it("拒绝越界数值并给出字段级错误", async () => {
      const session = await newSession();
      const response = await saveAnswer(session, "body_metrics", {
        value: { ...body.body_metrics, heightCm: 500 },
      });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe("VALIDATION_FAILED");
      expect(response.body.error.details?.some((d) => d.path.includes("heightCm"))).toBe(
        true,
      );
    });

    it("拒绝 1e400 这类被解析成 Infinity 的注入", async () => {
      const session = await newSession();
      const response = await saveAnswer(session, "body_metrics", {
        value: '{"unitSystem":"METRIC","age":28,"heightCm":1e400,"weightKg":70,"goalWeightKg":60}',
      });
      expect(response.status).toBe(422);
    });

    it("拒绝畸形 JSON", async () => {
      const session = await newSession();
      const response = await saveAnswer(session, "gender", { value: "{not json" });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("MALFORMED_JSON");
    });

    it("校验失败时不写入任何数据", async () => {
      const session = await newSession();
      await saveAnswer(session, "body_metrics", {
        value: { ...body.body_metrics, weightKg: -70 },
      });

      const count = await testPrisma().quizAnswer.count({
        where: { sessionId: session.sessionId },
      });
      expect(count).toBe(0);

      // 版本号也不该被推进，否则客户端持有的版本会平白失效
      const state = await readSession(session);
      expect(state.body.version).toBe(0);
    });
  });

  // -------------------------------------------------------------------------

  describe("进度恢复", () => {
    it("中断后重新进入能拿回全部已填数据", async () => {
      const session = await newSession();
      await saveAnswer(session, "gender");
      await saveAnswer(session, "goal");
      await saveAnswer(session, "body_metrics");

      // 模拟用户关掉页面后重新打开：只带着 sessionId 和 token 回来
      const restored = await readSession(session);

      expect(restored.status).toBe(200);
      expect(restored.body.answeredSteps.sort()).toEqual(
        ["body_metrics", "gender", "goal"].sort(),
      );
      expect(restored.body.answers.gender).toEqual({ gender: "FEMALE" });
      expect(restored.body.currentStep).toBe("focus_areas");
      expect(restored.body.progressPercent).toBeGreaterThan(0);
      expect(restored.body.hasResult).toBe(false);
    });

    it("返回缺失的必填步骤，前端据此决定能否提交", async () => {
      const session = await newSession();
      await saveAnswer(session, "gender");

      const state = await readSession(session);
      expect(state.body.missingRequiredSteps).toEqual(
        expect.arrayContaining(["goal", "body_metrics", "activity_level"]),
      );
      // 非必填步骤不该出现在阻塞列表里
      expect(state.body.missingRequiredSteps).not.toContain("focus_areas");
    });

    it("尚未作答的新会话返回空进度而不是报错", async () => {
      const session = await newSession();
      const state = await readSession(session);
      expect(state.status).toBe(200);
      expect(state.body.answeredSteps).toEqual([]);
      expect(state.body.progressPercent).toBe(0);
    });

    it("恢复响应里带当前版本号，客户端据此参与乐观锁", async () => {
      const session = await newSession();
      await saveAnswer(session, "gender");
      const state = await readSession(session);

      // 拿恢复到的版本号直接写下一步，应当成功
      const next = await saveAnswer(session, "goal", {
        ifMatch: String(state.body.version),
      });
      expect(next.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------

  describe("乱序与重复提交", () => {
    it("乱序提交不会互相覆盖", async () => {
      const session = await newSession();

      // 故意跳过中间步骤，先写第四步再回头写第二步
      await saveAnswer(session, "body_metrics");
      await saveAnswer(session, "goal");

      const state = await readSession(session);
      expect(state.body.answers.body_metrics).toBeDefined();
      expect(state.body.answers.goal).toEqual({ goal: "LOSE_WEIGHT" });
      // 下一步仍然指回最早的那个空缺
      expect(state.body.currentStep).toBe("gender");
    });

    it("重复提交同一步走 upsert，不产生重复行", async () => {
      const session = await newSession();
      await saveAnswer(session, "gender");
      await saveAnswer(session, "gender", { value: { gender: "MALE" } });
      await saveAnswer(session, "gender", { value: { gender: "OTHER" } });

      const rows = await testPrisma().quizAnswer.findMany({
        where: { sessionId: session.sessionId, stepKey: "gender" },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.value).toEqual({ gender: "OTHER" });
      expect(rows[0]!.revision).toBe(3);
    });

    it("重复提交在流水表里留下完整历史", async () => {
      const session = await newSession();
      await saveAnswer(session, "gender");
      await saveAnswer(session, "gender", { value: { gender: "MALE" } });

      const events = await testPrisma().quizAnswerEvent.findMany({
        where: { sessionId: session.sessionId, stepKey: "gender" },
        orderBy: { revision: "asc" },
      });

      // 当前值只有一行，但历史全在
      expect(events).toHaveLength(2);
      expect(events[0]!.value).toEqual({ gender: "FEMALE" });
      expect(events[1]!.value).toEqual({ gender: "MALE" });
    });

    it("完全相同的重复提交也照常递增 revision", async () => {
      const session = await newSession();
      const first = await saveAnswer(session, "gender");
      const second = await saveAnswer(session, "gender");
      expect(second.body.revision).toBe(first.body.revision + 1);
    });
  });

  // -------------------------------------------------------------------------

  describe("并发更新", () => {
    it("两个请求带同一版本号并发写入，只有一个成功", async () => {
      const session = await newSession();
      const state = await readSession(session);
      const staleVersion = String(state.body.version);

      const [a, b] = await Promise.all([
        saveAnswer(session, "gender", { ifMatch: staleVersion }),
        saveAnswer(session, "goal", { ifMatch: staleVersion }),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);

      const loser = a.status === 409 ? a : b;
      expect(loser.body.error.code).toBe("VERSION_CONFLICT");
      // 冲突响应要带上当前版本号，客户端才知道该用什么重试
      expect(loser.body.error.meta?.currentVersion).toBe(1);
    });

    it("拿旧版本号重试会被拒绝，用新版本号则成功", async () => {
      const session = await newSession();
      await saveAnswer(session, "gender", { ifMatch: "0" });

      const stale = await saveAnswer(session, "goal", { ifMatch: "0" });
      expect(stale.status).toBe(409);

      const fresh = await saveAnswer(session, "goal", {
        ifMatch: String(stale.body.error.meta?.currentVersion),
      });
      expect(fresh.status).toBe(200);
    });

    it("不带 If-Match 时退化为后写覆盖，但数据仍然一致", async () => {
      const session = await newSession();

      await Promise.all([
        saveAnswer(session, "gender", { value: { gender: "MALE" } }),
        saveAnswer(session, "gender", { value: { gender: "FEMALE" } }),
      ]);

      const rows = await testPrisma().quizAnswer.findMany({
        where: { sessionId: session.sessionId, stepKey: "gender" },
      });
      // 不加锁的代价是「谁赢不确定」，但绝不能出现重复行或版本号错乱
      expect(rows).toHaveLength(1);

      const state = await readSession(session);
      expect(state.body.version).toBe(2);

      const events = await testPrisma().quizAnswerEvent.count({
        where: { sessionId: session.sessionId, stepKey: "gender" },
      });
      expect(events).toBe(2);
    });

    it("非法的 If-Match 值被拒绝，而不是当成 0 处理", async () => {
      const session = await newSession();
      for (const value of ["abc", "-1", "1.5", ""]) {
        const response = await saveAnswer(session, "gender", { ifMatch: value });
        expect(response.status).toBe(422);
      }
    });
  });

  // -------------------------------------------------------------------------

  describe("越权与畸形访问", () => {
    it("用别人的 token 访问会话返回 404，不泄漏会话是否存在", async () => {
      const mine = await newSession();
      const other = await newSession();

      const response = await readSession(mine, other.token);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("SESSION_NOT_FOUND");
    });

    it("不存在的会话与越权访问返回完全一致的响应", async () => {
      const mine = await newSession();
      const other = await newSession();

      const crossAccess = await readSession(mine, other.token);
      const notExist = await call<ErrorBody>(
        getSessionRoute as never,
        buildRequest("GET", "/api/v1/sessions/00000000-0000-4000-8000-000000000000", {
          token: other.token,
        }),
        { id: "00000000-0000-4000-8000-000000000000" },
      );

      expect(crossAccess.status).toBe(notExist.status);
      expect(crossAccess.body.error.code).toBe(notExist.body.error.code);
    });

    it("缺少 Authorization 头返回 401", async () => {
      const session = await newSession();
      const response = await call<ErrorBody>(
        getSessionRoute as never,
        buildRequest("GET", `/api/v1/sessions/${session.sessionId}`),
        { id: session.sessionId },
      );
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("UNAUTHORIZED");
    });

    it("畸形的 sessionId 不会被送进数据库查询", async () => {
      const session = await newSession();
      const response = await call<ErrorBody>(
        getSessionRoute as never,
        buildRequest("GET", "/api/v1/sessions/not-a-uuid", { token: session.token }),
        { id: "not-a-uuid" },
      );
      expect(response.status).toBe(404);
    });

    it("越权写入同样被拒绝", async () => {
      const mine = await newSession();
      const other = await newSession();

      const response = await saveAnswer(mine, "gender", { token: other.token });
      expect(response.status).toBe(404);

      const count = await testPrisma().quizAnswer.count({
        where: { sessionId: mine.sessionId },
      });
      expect(count).toBe(0);
    });
  });

  // -------------------------------------------------------------------------

  describe("会话过期", () => {
    it("过期会话拒绝写入", async () => {
      const session = await newSession();
      await testPrisma().quizSession.update({
        where: { id: session.sessionId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const response = await saveAnswer(session, "gender");
      expect(response.status).toBe(410);
      expect(response.body.error.code).toBe("SESSION_EXPIRED");
    });

    it("过期会话仍可读取，用户至少能看到自己填过什么", async () => {
      const session = await newSession();
      await saveAnswer(session, "gender");
      await testPrisma().quizSession.update({
        where: { id: session.sessionId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const state = await readSession(session);
      expect(state.status).toBe(200);
      expect(state.body.answers.gender).toEqual({ gender: "FEMALE" });
    });
  });
});
