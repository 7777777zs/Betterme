import type { PrismaClient, QuizSession, Subscription, User } from "@/generated/prisma/client";
import { errors } from "@/lib/http/errors";
import { extractBearerToken, hashToken, safeCompareHex } from "./token";

export interface AuthenticatedSession {
  session: QuizSession;
  user: User;
  subscription: Subscription | null;
}

/**
 * 用 sessionId + Bearer token 解析出会话上下文。
 *
 * 两个刻意的设计：
 *
 * 1. 会话不存在、token 不匹配、会话属于别人 —— 统统返回同一个 404。
 *    区分开会让攻击者能枚举出哪些 sessionId 是真实存在的。
 *
 * 2. 过期判断放在鉴权之后。先确认「你是这个会话的主人」，
 *    再告诉你「它过期了」；否则过期与否本身就成了一个信息泄漏渠道。
 */
export async function authenticateSession(
  prisma: PrismaClient,
  sessionId: string,
  authorizationHeader: string | null,
): Promise<AuthenticatedSession> {
  const token = extractBearerToken(authorizationHeader);
  if (!token) {
    throw errors.unauthorized("请在 Authorization 头中提供 Bearer token");
  }

  // UUID 之外的字符串直接判定为不存在，避免把畸形输入送进数据库
  if (!isUuid(sessionId)) {
    throw errors.sessionNotFound();
  }

  const session = await prisma.quizSession.findUnique({
    where: { id: sessionId },
    include: { user: { include: { subscription: true } } },
  });

  if (!session) {
    throw errors.sessionNotFound();
  }

  const expected = session.user.anonTokenHash;
  if (!safeCompareHex(hashToken(token), expected)) {
    throw errors.sessionNotFound();
  }

  const { user, ...sessionOnly } = session;
  const { subscription, ...userOnly } = user;

  return {
    session: sessionOnly as QuizSession,
    user: userOnly as User,
    subscription: subscription ?? null,
  };
}

/**
 * 会话是否仍可写入。读取历史进度不受限制，写入只允许 IN_PROGRESS。
 *
 * 这里用「白名单」而不是逐个排除终态：`SessionStatus` 以后再加值时，
 * 排除式写法会默认放行新状态，白名单式写法会默认拒绝。
 * 对写入路径来说，默认拒绝才是安全的那一边。
 *
 * 注意这只是第一道闸。鉴权检查与事务写入之间存在时间窗，
 * 另一个请求可能恰好在这期间把会话作废掉，所以 saveAnswer 的
 * 更新语句里还有一道 `status = IN_PROGRESS` 的条件。
 */
export function assertWritable(session: QuizSession, now: Date = new Date()): void {
  if (session.status === "COMPLETED") {
    throw errors.sessionAlreadyCompleted();
  }
  if (session.status === "ABANDONED") {
    throw errors.sessionAbandoned();
  }
  if (session.status !== "IN_PROGRESS") {
    throw errors.sessionAbandoned();
  }
  if (session.expiresAt.getTime() <= now.getTime()) {
    throw errors.sessionExpired();
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
