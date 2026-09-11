import { defineConfig, devices } from "@playwright/test";

/**
 * 端到端测试配置。
 *
 * 与 vitest 的分工：vitest 直接调用 route handler，负责边界、异常、
 * 数据库一致性；Playwright 走真实浏览器与真实 HTTP，负责验证
 * 「用户实际能走完这条路」。两者不重叠，也都不可省。
 *
 * 这层防护不是凑数的。此前有一次故障正是 CDN 拦掉了标准的 If-Match 头，
 * 228 个测试全绿而线上第一步就点不动 —— 因为本地和 CI 的测试都直接
 * 调用处理函数，中间没有任何 HTTP 中间层。
 */
export default defineConfig({
  testDir: "./tests/e2e",

  // 用例之间共享同一个数据库，串行执行避免互相看到对方的中间状态
  fullyParallel: false,
  workers: 1,

  // CI 上不允许 test.only 混进来
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,

  timeout: 90_000,
  expect: { timeout: 15_000 },

  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  /**
   * 跑的是生产构建而不是 dev server。
   *
   * dev 模式下的热更新会在测试中途重新挂载组件、重置 React 状态，
   * 表现成随机的假失败 —— 手工验证这个漏斗时就撞到过一次，
   * 当时差点把它误判成导航逻辑的 bug。
   *
   * 端口避开 3000，免得和本地正在跑的开发服务器打架。
   */
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run start -- --port 3100",
        url: "http://127.0.0.1:3100/api/health",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
