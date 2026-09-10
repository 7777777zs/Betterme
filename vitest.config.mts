import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * 单元测试与集成测试跑在同一个 vitest 进程里，但通过目录区分：
 * tests/unit 不碰数据库，tests/integration 连 TEST_DATABASE_URL 指向的独立 schema。
 *
 * 集成测试串行执行（见下方 fileParallelism），因为它们共享同一个数据库 schema，
 * 并行会互相看到对方的中间状态，产生假失败。
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    globalSetup: ["tests/global-setup.ts"],
    fileParallelism: false,
    // 集成测试打的是远端 Supabase（东京），每次 Prisma 调用都是一次跨海往返。
    // 构造一个「已完成测评」的夹具要六七次往返，两个夹具就逼近半分钟。
    // CI 里跑的是本地 Postgres 容器，实际耗时只有零头。
    testTimeout: 90_000,
    hookTimeout: 90_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/lib/**/*.ts", "src/app/api/**/*.ts"],
      exclude: ["src/generated/**", "**/*.d.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
