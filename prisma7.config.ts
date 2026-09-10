import "dotenv/config";
import { defineConfig } from "prisma/config";

/**
 * Prisma CLI 配置（仅 CLI 使用，运行时不加载）。
 *
 * 迁移走 DIRECT_URL（5432 直连）而不是 DATABASE_URL（6543 连接池）：
 * pgbouncer 的事务池模式不支持 DDL 所需的会话级状态，
 * 用连接池跑 migrate 会出现难以排查的间歇性失败。
 *
 * 运行时的连接串则相反，必须走连接池，见 src/lib/db/prisma.ts。
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env["DIRECT_URL"],
  },
});
