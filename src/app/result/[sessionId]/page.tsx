"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ApiError,
  api,
  loadSession,
  type ResultResponse,
  type StoredSession,
} from "@/lib/client/api-client";
import { ErrorBanner, PrimaryButton } from "@/components/funnel-ui";

/**
 * 结果页。
 *
 * 付费墙的产品逻辑：先把免费部分实打实地给足 —— BMI、基础代谢、
 * 每日热量目标、营养配比都是真数据 —— 让用户先确认「这东西算得靠谱」，
 * 再对着被模糊的曲线说明还差什么。
 *
 * 工程上要强调的是：模糊只是视觉效果，**被遮住的数据根本没有下发到浏览器**。
 * 打开 devtools 看网络响应，那几个字段的键都不存在。
 * 见 src/lib/dto/result.ts 里的注释。
 */

interface Plan {
  id: string;
  label: string;
  price: string;
  per: string;
  /** 只有一档标「最受欢迎」，所以这个字段是可选的 */
  best?: boolean;
}

const PLANS: readonly Plan[] = [
  { id: "weekly", label: "周卡", price: "$9.99", per: "每周" },
  { id: "monthly", label: "月卡", price: "$29.99", per: "每月", best: true },
  { id: "quarterly", label: "季卡", price: "$59.99", per: "每季" },
];

const BMI_LABEL: Record<ResultResponse["bmiCategory"], string> = {
  UNDERWEIGHT: "偏瘦",
  NORMAL: "正常",
  OVERWEIGHT: "超重",
  OBESE: "肥胖",
};

export default function ResultPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = use(params);

  const [session, setSession] = useState<StoredSession | null>(null);
  const [result, setResult] = useState<ResultResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [showPaywall, setShowPaywall] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<string>("monthly");

  const fetchResult = useCallback(async (stored: StoredSession) => {
    try {
      setResult(await api.getResult(stored));
      setError(null);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "无法加载结果，请刷新重试。",
      );
    }
  }, []);

  useEffect(() => {
    // 状态更新全部放进异步函数里。
    // 在 effect 主体中同步 setState 会立刻触发一次额外渲染，
    // React 的 lint 规则会拦下这种写法。
    void (async () => {
      const stored = loadSession();

      if (!stored || stored.sessionId !== sessionId) {
        setError("找不到这份测评的访问凭证。请在最初完成测评的浏览器里打开本页。");
        return;
      }

      setSession(stored);
      await fetchResult(stored);
    })();
  }, [sessionId, fetchResult]);

  async function handlePay(): Promise<void> {
    if (!session) return;
    setPaying(true);
    try {
      await api.checkout(session, selectedPlan);
      // 支付成功后重新拉一次结果。同一个接口，同一个 token，
      // 唯一的变化是服务端这次判定为会员，于是返回完整数据。
      await fetchResult(session);
      setShowPaywall(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "支付失败，请重试。");
    } finally {
      setPaying(false);
    }
  }

  if (error && !result) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center px-6">
        <ErrorBanner message={error} />
        <Link
          href="/quiz"
          className="mt-2 block rounded-full bg-accent px-6 py-4 text-center font-semibold text-accent-ink"
        >
          重新开始测评
        </Link>
      </main>
    );
  }

  if (!result) {
    return (
      <main className="flex min-h-dvh items-center justify-center px-6">
        <p className="text-ink-faint">正在加载你的方案…</p>
      </main>
    );
  }

  const premium = result.access === "PREMIUM";

  return (
    <main className="mx-auto w-full max-w-xl px-6 py-10 pb-28">
      <header className="mb-8 text-center">
        <p className="text-sm text-ink-faint">你的个人健康方案</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink">
          {premium ? "完整方案已解锁" : "方案已生成"}
        </h1>
      </header>

      {error ? <ErrorBanner message={error} /> : null}

      {result.warnings.length > 0 ? (
        <div className="mb-6 space-y-2">
          {result.warnings.map((warning) => (
            <p
              key={warning.code}
              className="rounded-xl border border-warn/25 bg-warn-soft px-4 py-3 text-sm leading-relaxed text-warn"
            >
              {warning.message}
            </p>
          ))}
        </div>
      ) : null}

      {/* --- 免费部分：给足真数据，建立信任 --- */}

      <section className="mb-4 rounded-2xl border border-line bg-surface p-6">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-ink-soft">你的 BMI</span>
          <span className="rounded-full bg-accent-soft px-3 py-1 text-sm font-medium text-accent">
            {BMI_LABEL[result.bmiCategory]}
          </span>
        </div>
        <p className="mt-2 text-5xl font-semibold tabular-nums tracking-tight text-ink">
          {result.bmi}
        </p>
      </section>

      <section className="mb-4 grid grid-cols-2 gap-4">
        <Stat label="每日建议摄入" value={result.recommendedCalories} unit="千卡" />
        <Stat label="每日总消耗" value={result.tdee} unit="千卡" />
      </section>

      <section className="mb-4 rounded-2xl border border-line bg-surface p-6">
        <h2 className="mb-4 text-sm font-medium text-ink-soft">每日营养配比</h2>
        <div className="grid grid-cols-3 gap-4 text-center">
          <Macro label="蛋白质" grams={result.macros.proteinG} />
          <Macro label="碳水" grams={result.macros.carbsG} />
          <Macro label="脂肪" grams={result.macros.fatG} />
        </div>
      </section>

      {/* --- 付费部分 --- */}

      <section className="relative overflow-hidden rounded-2xl border border-line bg-surface p-6">
        <h2 className="mb-1 text-lg font-semibold text-ink">你的体重曲线预测</h2>
        <p className="mb-5 text-sm text-ink-soft">
          {premium
            ? `按这个方案，预计 ${result.targetDate} 达成目标`
            : "看看多久能到达目标体重"}
        </p>

        <div className={premium ? "" : "paywall-blur"} aria-hidden={!premium}>
          <Projection result={result} />
        </div>

        {!premium ? (
          <div className="absolute inset-0 flex flex-col items-center justify-end bg-gradient-to-t from-surface via-surface/85 to-transparent p-6">
            <p className="mb-1 text-center text-base font-semibold text-ink">
              {result.paywall?.title ?? "解锁你的完整计划"}
            </p>
            <p className="mb-4 max-w-xs text-center text-sm leading-relaxed text-ink-soft">
              {result.paywall?.description}
            </p>
            <button
              type="button"
              onClick={() => setShowPaywall(true)}
              className="rounded-full bg-accent px-8 py-3 text-sm font-semibold text-accent-ink transition-all hover:brightness-110 active:scale-[0.99]"
            >
              解锁完整方案
            </button>
          </div>
        ) : null}
      </section>

      {premium ? (
        <section className="mt-4 grid grid-cols-2 gap-4">
          <Stat label="预计达成" value={result.weeksToGoal ?? 0} unit="周" />
          <Stat
            label="每周变化"
            value={result.effectiveWeeklyRateKg ?? 0}
            unit="kg"
          />
        </section>
      ) : null}

      <p className="mt-8 text-center text-xs leading-relaxed text-ink-faint">
        本结果由算法 v{result.algorithmVersion} 生成，仅供参考，不构成医疗建议。
      </p>

      {/* --- 付费弹窗 --- */}

      {showPaywall ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-0 sm:items-center sm:p-6"
          role="dialog"
          aria-modal="true"
        >
          <div className="animate-step-in w-full max-w-md rounded-t-3xl bg-surface p-6 sm:rounded-3xl">
            <h2 className="text-center text-2xl font-semibold tracking-tight text-ink">
              解锁你的完整计划
            </h2>
            <p className="mx-auto mt-2 max-w-xs text-center text-sm leading-relaxed text-ink-soft">
              查看预计达成日期、逐周体重曲线，以及为你量身定制的完整方案。
            </p>

            <div className="mt-6 space-y-3">
              {PLANS.map((plan) => (
                <button
                  key={plan.id}
                  type="button"
                  onClick={() => setSelectedPlan(plan.id)}
                  className={`flex w-full items-center justify-between rounded-2xl border px-5 py-4 text-left transition-all ${
                    selectedPlan === plan.id
                      ? "border-accent bg-accent-soft"
                      : "border-line hover:border-accent/40"
                  }`}
                >
                  <span>
                    <span className="block font-medium text-ink">
                      {plan.label}
                      {plan.best ? (
                        <span className="ml-2 rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-ink">
                          最受欢迎
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block text-sm text-ink-faint">{plan.per}</span>
                  </span>
                  <span className="text-lg font-semibold tabular-nums text-ink">
                    {plan.price}
                  </span>
                </button>
              ))}
            </div>

            <div className="mt-6">
              <PrimaryButton loading={paying} onClick={() => void handlePay()}>
                立即解锁
              </PrimaryButton>
            </div>

            <p className="mt-3 text-center text-xs text-ink-faint">
              演示环境，不会产生任何真实扣款
            </p>

            <button
              type="button"
              onClick={() => setShowPaywall(false)}
              className="mt-2 w-full py-2 text-sm text-ink-faint transition-colors hover:text-ink-soft"
            >
              暂时不用
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function Stat({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-5">
      <p className="text-sm text-ink-soft">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">
        {value}
        <span className="ml-1 text-sm font-normal text-ink-faint">{unit}</span>
      </p>
    </div>
  );
}

function Macro({ label, grams }: { label: string; grams: number }) {
  return (
    <div>
      <p className="text-2xl font-semibold tabular-nums text-ink">{grams}</p>
      <p className="mt-0.5 text-xs text-ink-faint">克 · {label}</p>
    </div>
  );
}

/**
 * 体重曲线。
 *
 * 非会员时 weeklyProjection 整个字段都不存在，所以这里画的是一条
 * 形状合理但与真实数据无关的占位曲线 —— 模糊之后只是一个「有东西」的暗示。
 * 真实数据从来没有到过浏览器。
 */
function Projection({ result }: { result: ResultResponse }) {
  const points =
    result.weeklyProjection ??
    Array.from({ length: 12 }, (_, i) => ({
      week: i + 1,
      weightKg: 70 - i * 0.6,
      date: "",
    }));

  const weights = points.map((p) => p.weightKg);
  const max = Math.max(...weights);
  const min = Math.min(...weights);
  const span = max - min || 1;

  const path = points
    .map((point, index) => {
      const x = (index / Math.max(1, points.length - 1)) * 100;
      const y = 100 - ((point.weightKg - min) / span) * 82 - 9;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <div>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-40 w-full">
        <path
          d={`${path} L100,100 L0,100 Z`}
          className="fill-accent/10"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={path}
          className="fill-none stroke-accent"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="mt-3 flex justify-between text-xs tabular-nums text-ink-faint">
        <span>第 1 周 · {points[0]?.weightKg} kg</span>
        <span>
          第 {points.at(-1)?.week} 周 · {points.at(-1)?.weightKg} kg
        </span>
      </div>
    </div>
  );
}
