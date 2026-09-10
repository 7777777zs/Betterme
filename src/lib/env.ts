import { z } from "zod";

/**
 * 环境变量在进程启动时一次性校验。
 *
 * 为什么不直接读 process.env：缺失的环境变量如果等到第一个请求打进来才暴露，
 * 表现是运行时 500 而不是启动失败，排查成本高得多。这里让它尽早、响亮地失败。
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL 未配置"),
  DIRECT_URL: z.string().min(1).optional(),
  TEST_DATABASE_URL: z.string().min(1).optional(),

  /**
   * 模拟支付回调的签名密钥。没有它任何人都能裸调 /api/v1/pay 把自己变成会员，
   * 所以它是必填而不是可选。
   */
  PAY_WEBHOOK_SECRET: z.string().min(8, "PAY_WEBHOOK_SECRET 至少 8 位"),

  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(720),

  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`环境变量配置不合法：\n${detail}`);
  }

  cached = parsed.data;
  return cached;
}

/** 仅供测试使用：清掉缓存，让下次 getEnv 重新读取 process.env */
export function resetEnvCache(): void {
  cached = null;
}
