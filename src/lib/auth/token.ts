import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * 匿名访问凭证。
 *
 * 题目允许「随机 UserID 或简易 Session 识别」，但如果直接把 userId
 * 当凭证用，那么任何拿到别人 sessionId 的人都能读走对方的结果页。
 * 这里把「身份标识」和「访问凭证」拆开：
 *
 *   sessionId  可以出现在 URL、日志、分享链接里，泄漏无害
 *   token      只在 Authorization 头里传，服务端只存 SHA-256 摘要
 *
 * 拖库拿到的是摘要，无法反推出明文 token，也就无法冒充用户。
 */

const TOKEN_BYTES = 32;

/** 生成明文 token，只在创建会话时返回给客户端一次 */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** 计算存库用的摘要。定长 64 位十六进制，对应 schema 里的 Char(64)。 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * 定长常量时间比较。
 *
 * 直接用 === 比较摘要会在字符逐位比对时提前返回，
 * 理论上可被计时攻击逐字节还原。这里的成本几乎为零，没有理由不做。
 */
const HEX_RE = /^[0-9a-f]+$/i;

export function safeCompareHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  // 必须先校验是不是合法十六进制。Buffer.from("zz", "hex") 不会抛错，
  // 而是安静地返回空 buffer，两个空 buffer 比较的结果是 true。
  // 少了这一行，任意两个等长的非法输入就会被判定为「匹配」。
  if (!HEX_RE.test(a) || !HEX_RE.test(b)) return false;

  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/** 从 Authorization 头里取出 Bearer token，格式不对返回 null */
export function extractBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1]!.trim();
  return token.length > 0 ? token : null;
}
