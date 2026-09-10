import "dotenv/config";
import { bootstrapTestSchema, hasTestDatabase } from "./helpers/db";

/**
 * 整个测试套件运行前执行一次：重建 test schema 并应用迁移。
 *
 * 没有配置数据库时不报错，只打印提示并让集成测试自行跳过。
 * 让「没配库」表现为整套测试崩溃，会掩盖掉单元测试本可以提供的反馈。
 */
export default async function setup(): Promise<void> {
  if (!hasTestDatabase()) {
    console.warn(
      "\n[集成测试] 未检测到可用的 TEST_DATABASE_URL，本次仅运行单元测试。" +
        "\n[集成测试] 配置方式见 .env.example。\n",
    );
    return;
  }

  const startedAt = Date.now();
  await bootstrapTestSchema();
  console.info(`[集成测试] test schema 已重建并应用迁移，耗时 ${Date.now() - startedAt}ms`);
}
