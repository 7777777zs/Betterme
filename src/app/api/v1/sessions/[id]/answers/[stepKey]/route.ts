import { assertWritable, authenticateSession } from "@/lib/auth/authenticate";
import { prisma } from "@/lib/db/prisma";
import { errors } from "@/lib/http/errors";
import { ok, parseJsonBody, withRoute } from "@/lib/http/respond";
import { STEP_KEYS, isStepKey } from "@/lib/quiz/steps";
import { saveAnswer } from "@/lib/quiz/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; stepKey: string }> };

/** 乐观锁的版本号头。用自定义头而不是标准的 If-Match，原因见下方注释。 */
export const VERSION_HEADER = "x-session-version";

/**
 * 解析版本号头。
 *
 * 这里原本用的是标准的 `If-Match`，理由是「条件请求是 HTTP 早就定义好的语义，
 * 代理和网关都认识它，不必自造约定」。上线之后这个理由反过来把自己咬了：
 *
 * 代理确实认识 If-Match —— 认识到会**替你处理掉**。Vercel 的边缘节点
 * 自己实现了 RFC 7232，看到 If-Match 与它计算的 ETag 不符就直接返回
 * 412 Precondition Failed，请求根本到不了这个函数。而且它返回的是
 * 纯文本错误页，不是我们约定的 JSON 错误信封。
 *
 * 表现是：第一次保存在客户端看来失败了（拿到无法解析的 412），
 * 于是客户端不更新本地版本号，第二次带着同一个旧版本再来，结果被判版本冲突。
 *
 * 教训：标准头部的语义归中间层所有。想让某个值原样穿过 CDN 抵达应用层，
 * 就得用一个中间层不认识、也就不会插手的自定义头。
 */
function parseVersionHeader(header: string | null): number | undefined {
  if (header === null) return undefined;

  const trimmed = header.trim().replace(/^"|"$/g, "");

  // 空值是畸形请求，不是「版本 0」。
  // 少了这一行，Number("") 会得到 0 而被当成合法版本号放行 ——
  // 客户端发出一个空头部本意是想加锁，结果拿到的是一次无锁写入。
  if (trimmed === "") {
    throw errors.validation([
      { path: VERSION_HEADER, message: "不能为空，应为会话当前的版本号" },
    ]);
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw errors.validation([
      { path: VERSION_HEADER, message: "必须是会话当前的版本号（非负整数）" },
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
 * 带 X-Session-Version 头时启用乐观锁，版本不符返回 409。
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

  const expectedVersion = parseVersionHeader(request.headers.get(VERSION_HEADER));
  const body = await parseJsonBody(request);

  const result = await saveAnswer(prisma, {
    sessionId: id,
    stepKey,
    rawValue: body,
    expectedVersion,
  });

  // 回带新版本号，客户端下一次 PATCH 直接拿它继续加锁。
  // 刻意不用 ETag：响应头上的 ETag 同样会被 CDN 接管，
  // 既然请求侧已经因此栽过一次，响应侧就不再往同一个坑里跳。
  return ok(result, { headers: { [VERSION_HEADER]: String(result.version) } });
});
