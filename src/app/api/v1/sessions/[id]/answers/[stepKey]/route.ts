import { assertWritable, authenticateSession } from "@/lib/auth/authenticate";
import { prisma } from "@/lib/db/prisma";
import { errors } from "@/lib/http/errors";
import { ok, parseJsonBody, withRoute } from "@/lib/http/respond";
import { STEP_KEYS, isStepKey } from "@/lib/quiz/steps";
import { saveAnswer } from "@/lib/quiz/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; stepKey: string }> };

/**
 * 解析 If-Match 头里的版本号。
 *
 * 用 If-Match 而不是把 version 放进请求体：这是 HTTP 早就定义好的
 * 条件请求语义，代理和网关都认识它，不必自造一套约定。
 */
function parseIfMatch(header: string | null): number | undefined {
  if (header === null) return undefined;

  const trimmed = header.trim().replace(/^"|"$/g, "");

  // 空的 If-Match 是畸形请求，不是「版本 0」。
  // 少了这一行，Number("") 会得到 0 而被当成合法版本号放行 ——
  // 客户端发出一个空头部本意是想加锁，结果拿到的是一次无锁写入。
  if (trimmed === "") {
    throw errors.validation([
      { path: "If-Match", message: "不能为空，应为会话当前的版本号" },
    ]);
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw errors.validation([
      { path: "If-Match", message: "必须是会话当前的版本号（非负整数）" },
    ]);
  }
  return parsed;
}

/**
 * PATCH /api/v1/sessions/:id/answers/:stepKey
 *
 * 分步增量保存。用 PATCH 而不是 PUT：这是对会话资源的部分更新，
 * 请求体只描述单个步骤，不是整个会话的完整表示。
 *
 * 带 If-Match 时启用乐观锁，版本不符返回 409。
 */
export const PATCH = withRoute(async (request: Request, ctx: Ctx) => {
  const { id, stepKey } = await ctx.params;

  const { session } = await authenticateSession(
    prisma,
    id,
    request.headers.get("authorization"),
  );
  assertWritable(session);

  if (!isStepKey(stepKey)) {
    throw errors.unknownStep(stepKey, STEP_KEYS);
  }

  const expectedVersion = parseIfMatch(request.headers.get("if-match"));
  const body = await parseJsonBody(request);

  const result = await saveAnswer(prisma, {
    sessionId: id,
    stepKey,
    rawValue: body,
    expectedVersion,
  });

  // ETag 回带新版本号，客户端下一次 PATCH 直接拿它做 If-Match
  return ok(result, { headers: { ETag: String(result.version) } });
});
