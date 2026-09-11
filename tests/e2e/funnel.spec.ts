import { expect, test, type Page } from "@playwright/test";

/**
 * 完整用户路径的端到端验证。
 *
 * 这条用例覆盖的是服务端测试**碰不到**的那一层：真实浏览器事件、
 * localStorage 里的凭证传递、跨页面导航，以及请求真的经过 HTTP 栈。
 *
 * 它的价值有过一次实证。此前版本用标准的 If-Match 头传版本号，
 * 228 个服务端测试全绿，线上却第一步就点不动 —— CDN 在边缘拦下了
 * 这个头，请求根本到不了应用。服务端测试直接调用 route handler，
 * 中间没有任何 HTTP 中间层，这类问题它永远看不见。
 */

/** 结果接口的响应会被逐一记下来，用于断言脱敏字段从未下发 */
interface CapturedResult {
  access: string;
  keys: string[];
  raw: string;
}

function captureResultResponses(page: Page): CapturedResult[] {
  const captured: CapturedResult[] = [];

  page.on("response", (response) => {
    if (!/\/api\/v1\/sessions\/[^/]+\/result/.test(response.url())) return;
    void response
      .text()
      .then((raw) => {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        captured.push({ access: String(parsed.access), keys: Object.keys(parsed), raw });
      })
      .catch(() => {
        /* 非 JSON 响应不参与断言 */
      });
  });

  return captured;
}

const PROTECTED_FIELDS = [
  "targetDate",
  "weeksToGoal",
  "effectiveWeeklyRateKg",
  "weeklyProjection",
];

async function fillBodyMetrics(page: Page): Promise<void> {
  await page.getByPlaceholder("28").fill("29");
  await page.getByPlaceholder("170").fill("166");
  await page.getByPlaceholder("68").fill("72");
  await page.getByPlaceholder("62").fill("61");
  await page.getByRole("button", { name: "继续" }).click();
}

test.describe("测评漏斗完整流程", () => {
  test("从落地页一路走到解锁完整方案", async ({ page }) => {
    const results = captureResultResponses(page);

    // --- 新用户进入落地页 ---
    await page.goto("/");
    await expect(page.getByRole("button", { name: "开始测评" })).toBeVisible();

    await page.getByRole("button", { name: "开始测评" }).click();

    // --- 前两步 ---
    await expect(page.getByRole("heading", { name: "先从性别开始" })).toBeVisible();
    await page.getByText("女性", { exact: true }).click();

    await expect(page.getByRole("heading", { name: "你想达成什么" })).toBeVisible();
    await page.getByText("减轻体重", { exact: true }).click();

    await expect(page.getByRole("heading", { name: "最想改善哪些部位" })).toBeVisible();

    // --- 刷新页面，验证进度恢复 ---
    await page.reload();

    // 恢复到上次进度的下一步，而不是回到第一步
    await expect(page.getByRole("heading", { name: "最想改善哪些部位" })).toBeVisible();
    await expect(page.getByText("已恢复你上次填写的进度")).toBeVisible();

    // --- 落地页也要能看出有未完成的测评 ---
    await page.goto("/");
    const resumeButton = page.getByRole("button", { name: /继续上次测评/ });
    await expect(resumeButton).toBeVisible();
    await expect(page.getByRole("button", { name: "重新开始" })).toBeVisible();
    await resumeButton.click();

    // --- 填完剩余步骤 ---
    await expect(page.getByRole("heading", { name: "最想改善哪些部位" })).toBeVisible();
    await page.getByRole("button", { name: "跳过这一步" }).click();

    await expect(page.getByRole("heading", { name: "你的身体数据" })).toBeVisible();
    await fillBodyMetrics(page);

    await expect(page.getByRole("heading", { name: /运动频率/ })).toBeVisible();
    await page.getByText("每周 1 到 2 次", { exact: true }).click();

    // --- 结果页：免费形态 ---
    await expect(page.getByRole("heading", { name: "方案已生成" })).toBeVisible();
    await expect(page.getByText("你的 BMI")).toBeVisible();
    await expect(page.getByText("每日建议摄入")).toBeVisible();
    await expect(page.getByRole("button", { name: "解锁完整方案" })).toBeVisible();

    // 关键断言：受保护字段从未下发到浏览器。
    // 页面上的模糊只是 CSS，证明不了任何事；要看的是网络响应本身。
    await expect
      .poll(() => results.length, { message: "没有捕获到结果接口的响应" })
      .toBeGreaterThan(0);

    const freeResponse = results.find((r) => r.access === "FREE");
    expect(freeResponse, "应当先拿到一次未付费的结果响应").toBeDefined();
    for (const field of PROTECTED_FIELDS) {
      expect(
        freeResponse!.keys,
        `未付费响应里不应出现 ${field} 这个键`,
      ).not.toContain(field);
    }

    // --- 支付 ---
    await page.getByRole("button", { name: "解锁完整方案" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "立即解锁" }).click();

    // --- 结果页：付费形态 ---
    await expect(page.getByRole("heading", { name: "完整方案已解锁" })).toBeVisible();
    await expect(page.getByText(/预计 \d{4}-\d{2}-\d{2} 达成目标/)).toBeVisible();
    await expect(page.getByText("预计达成")).toBeVisible();

    const paidResponse = results.find((r) => r.access === "PREMIUM");
    expect(paidResponse, "支付后应当拿到一次付费的结果响应").toBeDefined();
    for (const field of PROTECTED_FIELDS) {
      expect(paidResponse!.keys, `付费响应里应当包含 ${field}`).toContain(field);
    }

    // 免费字段在付费前后必须完全一致：付费买的是更多数据，不是不同数据
    const free = JSON.parse(freeResponse!.raw) as Record<string, unknown>;
    const paid = JSON.parse(paidResponse!.raw) as Record<string, unknown>;
    expect(paid.bmi).toBe(free.bmi);
    expect(paid.tdee).toBe(free.tdee);
    expect(paid.recommendedCalories).toBe(free.recommendedCalories);

    // --- 刷新后权益仍在 ---
    await page.reload();
    await expect(page.getByRole("heading", { name: "完整方案已解锁" })).toBeVisible();
    await expect(page.getByText(/预计 \d{4}-\d{2}-\d{2} 达成目标/)).toBeVisible();
  });

  test("返回键可以回头修改已经填过的答案", async ({ page }) => {
    await page.goto("/quiz");

    await expect(page.getByRole("heading", { name: "先从性别开始" })).toBeVisible();
    await page.getByText("男性", { exact: true }).click();

    await expect(page.getByRole("heading", { name: "你想达成什么" })).toBeVisible();
    await page.getByRole("button", { name: /返回/ }).click();

    // 回到第一步，而且之前选的答案是选中态，用户能看到自己填过什么
    await expect(page.getByRole("heading", { name: "先从性别开始" })).toBeVisible();
    await expect(page.getByRole("button", { name: /男性/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // 改成另一个答案，应当正常保存并前进
    await page.getByText("女性", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "你想达成什么" })).toBeVisible();

    await page.getByRole("button", { name: /返回/ }).click();
    await expect(page.getByRole("button", { name: /女性/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("重新开始会作废旧会话并从第一步开始", async ({ page }) => {
    await page.goto("/quiz");
    await page.getByText("女性", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "你想达成什么" })).toBeVisible();

    await page.goto("/");
    await page.getByRole("button", { name: "重新开始" }).click();

    // 回到第一步，且没有任何选中态残留
    await expect(page.getByRole("heading", { name: "先从性别开始" })).toBeVisible();
    await expect(page.getByRole("button", { name: /女性/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(page.getByText("已恢复你上次填写的进度")).toBeHidden();
  });
});
