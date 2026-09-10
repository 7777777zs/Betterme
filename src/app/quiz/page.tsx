"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ApiError,
  api,
  clearSession,
  loadSession,
  saveSession,
  type StoredSession,
} from "@/lib/client/api-client";
import type { StepKey } from "@/lib/quiz/steps";
import {
  ErrorBanner,
  NumberField,
  OptionCard,
  PrimaryButton,
  ProgressBar,
  StepHeading,
  TrustNote,
} from "@/components/funnel-ui";

/**
 * 测评漏斗。
 *
 * 状态机很简单：booting -> 某个步骤 -> submitting -> 跳转结果页。
 *
 * 「进度恢复」在这里落地：进页面时先看 localStorage 有没有会话，
 * 有就调恢复接口把已填答案灌回表单，并跳到第一个没答的步骤。
 * 用户中途关掉标签页、手机息屏、误触返回，回来都能接着填。
 *
 * 「乐观锁」也在这里落地：每次保存都带上服务端回传的版本号。
 * 同一个人开两个标签页填同一份问卷是真实会发生的，
 * 落后的那个会拿到 409，我们提示他刷新，而不是让他静默覆盖掉另一边。
 */

type UiState = "booting" | "ready" | "saving" | "submitting";

interface BodyForm {
  age: string;
  height: string;
  weight: string;
  goalWeight: string;
}

const STEP_ORDER: StepKey[] = [
  "gender",
  "goal",
  "focus_areas",
  "body_metrics",
  "activity_level",
];

const GENDERS = [
  { value: "MALE", label: "男性" },
  { value: "FEMALE", label: "女性" },
  { value: "OTHER", label: "其他 / 不愿透露" },
] as const;

const GOALS = [
  { value: "LOSE_WEIGHT", label: "减轻体重", hint: "制造热量缺口，稳步下降" },
  { value: "MAINTAIN_WEIGHT", label: "保持体重", hint: "维持当前状态，优化体成分" },
  { value: "GAIN_MUSCLE", label: "增加肌肉", hint: "小幅热量盈余，配合力量训练" },
] as const;

const FOCUS_AREAS = [
  { value: "BELLY", label: "腹部" },
  { value: "LEGS", label: "腿部" },
  { value: "ARMS", label: "手臂" },
  { value: "CHEST", label: "胸部" },
  { value: "BACK", label: "背部" },
  { value: "FULL_BODY", label: "全身" },
] as const;

const ACTIVITY_LEVELS = [
  { value: "SEDENTARY", label: "几乎不运动", hint: "以久坐为主" },
  { value: "LIGHT", label: "每周 1 到 2 次", hint: "轻度活动" },
  { value: "MODERATE", label: "每周 3 到 5 次", hint: "规律运动" },
  { value: "VERY_ACTIVE", label: "每周 6 次以上", hint: "高强度训练" },
] as const;

export default function QuizPage() {
  const router = useRouter();

  const [uiState, setUiState] = useState<UiState>("booting");
  const [session, setSession] = useState<StoredSession | null>(null);
  const [version, setVersion] = useState(0);
  const [currentStep, setCurrentStep] = useState<StepKey>("gender");
  const [progress, setProgress] = useState(0);
  const [answered, setAnswered] = useState<Set<StepKey>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const [gender, setGender] = useState<string | null>(null);
  const [goal, setGoal] = useState<string | null>(null);
  const [areas, setAreas] = useState<string[]>([]);
  const [activity, setActivity] = useState<string | null>(null);
  const [body, setBody] = useState<BodyForm>({
    age: "",
    height: "",
    weight: "",
    goalWeight: "",
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // 严格模式下 effect 会跑两次，没有这道闸会创建两个会话
  const bootedRef = useRef(false);

  function hydrateFromAnswers(answers: Record<string, unknown>): void {
    const g = answers.gender as { gender?: string } | undefined;
    if (g?.gender) setGender(g.gender);

    const go = answers.goal as { goal?: string } | undefined;
    if (go?.goal) setGoal(go.goal);

    const fa = answers.focus_areas as { areas?: string[] } | undefined;
    if (fa?.areas) setAreas(fa.areas);

    const al = answers.activity_level as { activityLevel?: string } | undefined;
    if (al?.activityLevel) setActivity(al.activityLevel);

    const bm = answers.body_metrics as
      | { age?: number; heightCm?: number; weightKg?: number; goalWeightKg?: number }
      | undefined;
    if (bm) {
      setBody({
        age: bm.age?.toString() ?? "",
        height: bm.heightCm?.toString() ?? "",
        weight: bm.weightKg?.toString() ?? "",
        goalWeight: bm.goalWeightKg?.toString() ?? "",
      });
    }
  }

  // ---------------------------------------------------------------------
  // 启动：恢复已有会话，或创建新会话
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;

    void (async () => {
      const stored = loadSession();

      if (stored) {
        try {
          const state = await api.getSession(stored);

          // 已完成的会话直接送去结果页，不让用户重填一遍
          if (state.status === "COMPLETED" && state.hasResult) {
            router.replace(`/result/${stored.sessionId}`);
            return;
          }

          hydrateFromAnswers(state.answers);
          setSession(stored);
          setVersion(state.version);
          setAnswered(new Set(state.answeredSteps));
          setProgress(state.progressPercent);
          setCurrentStep(state.currentStep ?? "activity_level");
          setUiState("ready");
          return;
        } catch (err) {
          // 会话过期或被清库了，当新用户处理，不要把错误怼到用户脸上
          if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
            clearSession();
          } else {
            setError("无法恢复上次的进度，已为你重新开始。");
          }
        }
      }

      try {
        const created = await api.createSession();
        const next = { sessionId: created.sessionId, token: created.token };
        saveSession(next);
        setSession(next);
        setVersion(created.version);
        setCurrentStep(created.currentStep ?? "gender");
        setUiState("ready");
      } catch {
        setError("服务暂时不可用，请稍后重试。");
        setUiState("ready");
      }
    })();
  }, [router]);

  // ---------------------------------------------------------------------
  // 保存一步并前进
  // ---------------------------------------------------------------------
  const persist = useCallback(
    async (stepKey: StepKey, value: unknown): Promise<boolean> => {
      if (!session) return false;

      setError(null);
      setFieldErrors({});
      setUiState("saving");

      try {
        const saved = await api.saveAnswer(session, stepKey, value, version);
        setVersion(saved.version);
        setProgress(saved.progressPercent);
        setAnswered(new Set(saved.answeredSteps));
        setUiState("ready");
        return true;
      } catch (err) {
        setUiState("ready");

        if (err instanceof ApiError) {
          if (err.code === "VALIDATION_FAILED" && err.details) {
            const map: Record<string, string> = {};
            for (const detail of err.details) {
              const key = detail.path.split(".").pop() ?? detail.path;
              map[key] = detail.message;
            }
            setFieldErrors(map);
            return false;
          }

          if (err.code === "VERSION_CONFLICT") {
            // 另一个标签页抢先改了。不静默覆盖，让用户知道发生了什么。
            setError("这份问卷在另一个页面被修改过，请刷新后继续。");
            return false;
          }

          if (err.status === 410) {
            clearSession();
            setError("会话已过期，请刷新页面重新开始。");
            return false;
          }

          setError(err.message);
          return false;
        }

        setError("网络似乎不太稳定，请重试。");
        return false;
      }
    },
    [session, version],
  );

  function goToNextStep(from: StepKey): void {
    const nextAnswered = new Set(answered);
    nextAnswered.add(from);
    const next = STEP_ORDER.find((key) => !nextAnswered.has(key));
    if (next) setCurrentStep(next);
  }

  async function handleChoice(stepKey: StepKey, value: unknown): Promise<void> {
    const okSaved = await persist(stepKey, value);
    if (okSaved) goToNextStep(stepKey);
  }

  // ---------------------------------------------------------------------
  // 身体数据：先做本地校验，再交给服务端
  // ---------------------------------------------------------------------
  function validateBodyLocally(): Record<string, string> {
    const problems: Record<string, string> = {};
    const num = (raw: string) => (raw.trim() === "" ? Number.NaN : Number(raw));

    const age = num(body.age);
    const height = num(body.height);
    const weight = num(body.weight);
    const goalWeight = num(body.goalWeight);

    if (!Number.isFinite(age)) problems.age = "请输入年龄";
    if (!Number.isFinite(height)) problems.heightCm = "请输入身高";
    if (!Number.isFinite(weight)) problems.weightKg = "请输入体重";
    if (!Number.isFinite(goalWeight)) problems.goalWeightKg = "请输入目标体重";

    return problems;
  }

  async function handleBodySubmit(): Promise<void> {
    const local = validateBodyLocally();
    if (Object.keys(local).length > 0) {
      setFieldErrors(local);
      return;
    }

    // 本地只挡「没填」。区间与跨字段规则一律交给服务端，
    // 前端复制一份校验规则迟早会和后端漂移，那才是真正难查的 bug。
    const okSaved = await persist("body_metrics", {
      unitSystem: "METRIC",
      age: Number(body.age),
      heightCm: Number(body.height),
      weightKg: Number(body.weight),
      goalWeightKg: Number(body.goalWeight),
    });

    if (okSaved) goToNextStep("body_metrics");
  }

  async function handleFinalStep(value: string): Promise<void> {
    if (!session) return;

    const okSaved = await persist("activity_level", { activityLevel: value });
    if (!okSaved) return;

    setUiState("submitting");
    try {
      await api.submit(session);
      router.push(`/result/${session.sessionId}`);
    } catch (err) {
      setUiState("ready");
      setError(err instanceof ApiError ? err.message : "提交失败，请重试。");
    }
  }

  // ---------------------------------------------------------------------

  if (uiState === "booting") {
    return (
      <main className="flex min-h-dvh items-center justify-center px-6">
        <p className="text-ink-faint">正在准备你的测评…</p>
      </main>
    );
  }

  if (uiState === "submitting") {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
        <div
          className="size-10 animate-spin rounded-full border-2 border-line border-t-accent"
          aria-hidden
        />
        <p className="mt-6 text-lg font-medium text-ink">正在计算你的专属方案</p>
        <p className="mt-2 text-sm text-ink-faint">这需要几秒钟</p>
      </main>
    );
  }

  const busy = uiState === "saving";
  const stepIndex = STEP_ORDER.indexOf(currentStep);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col px-6 py-8">
      <header className="mb-10">
        <div className="mb-3 flex items-baseline justify-between text-sm text-ink-faint">
          <span>
            第 {stepIndex + 1} 步 / 共 {STEP_ORDER.length} 步
          </span>
          <span>{progress}%</span>
        </div>
        <ProgressBar percent={progress} />
      </header>

      <div key={currentStep} className="animate-step-in flex-1">
        {error ? <ErrorBanner message={error} /> : null}

        {currentStep === "gender" ? (
          <>
            <StepHeading
              title="先从性别开始"
              subtitle="基础代谢的计算公式因性别而异，这会直接影响你的热量目标。"
            />
            <div className="space-y-3">
              {GENDERS.map((option) => (
                <OptionCard
                  key={option.value}
                  label={option.label}
                  selected={gender === option.value}
                  onClick={() => {
                    if (busy) return;
                    setGender(option.value);
                    void handleChoice("gender", { gender: option.value });
                  }}
                />
              ))}
            </div>
            <TrustNote>已有超过 12,000 人完成这份测评</TrustNote>
          </>
        ) : null}

        {currentStep === "goal" ? (
          <>
            <StepHeading
              title="你想达成什么"
              subtitle="目标决定了我们把热量缺口往哪个方向调。"
            />
            <div className="space-y-3">
              {GOALS.map((option) => (
                <OptionCard
                  key={option.value}
                  label={option.label}
                  hint={option.hint}
                  selected={goal === option.value}
                  onClick={() => {
                    if (busy) return;
                    setGoal(option.value);
                    void handleChoice("goal", { goal: option.value });
                  }}
                />
              ))}
            </div>
          </>
        ) : null}

        {currentStep === "focus_areas" ? (
          <>
            <StepHeading title="最想改善哪些部位" subtitle="可以多选，也可以直接跳过。" />
            <div className="grid grid-cols-2 gap-3">
              {FOCUS_AREAS.map((option) => (
                <OptionCard
                  key={option.value}
                  label={option.label}
                  selected={areas.includes(option.value)}
                  onClick={() =>
                    setAreas((prev) =>
                      prev.includes(option.value)
                        ? prev.filter((a) => a !== option.value)
                        : [...prev, option.value],
                    )
                  }
                />
              ))}
            </div>
            <div className="mt-8 space-y-3">
              <PrimaryButton
                loading={busy}
                disabled={areas.length === 0}
                onClick={() => void handleChoice("focus_areas", { areas })}
              >
                继续
              </PrimaryButton>
              <button
                type="button"
                onClick={() => setCurrentStep("body_metrics")}
                className="w-full py-2 text-sm text-ink-faint transition-colors hover:text-ink-soft"
              >
                跳过这一步
              </button>
            </div>
          </>
        ) : null}

        {currentStep === "body_metrics" ? (
          <>
            <StepHeading
              title="你的身体数据"
              subtitle="这些数字只用于计算，我们不会要求你注册或留下联系方式。"
            />
            <div className="space-y-4">
              <NumberField
                label="年龄"
                suffix="岁"
                inputMode="numeric"
                placeholder="28"
                value={body.age}
                error={fieldErrors.age}
                onChange={(v) => setBody((p) => ({ ...p, age: v }))}
              />
              <NumberField
                label="身高"
                suffix="cm"
                placeholder="170"
                value={body.height}
                error={fieldErrors.heightCm}
                onChange={(v) => setBody((p) => ({ ...p, height: v }))}
              />
              <NumberField
                label="当前体重"
                suffix="kg"
                placeholder="68"
                value={body.weight}
                error={fieldErrors.weightKg}
                onChange={(v) => setBody((p) => ({ ...p, weight: v }))}
              />
              <NumberField
                label="目标体重"
                suffix="kg"
                placeholder="62"
                value={body.goalWeight}
                error={fieldErrors.goalWeightKg}
                onChange={(v) => setBody((p) => ({ ...p, goalWeight: v }))}
              />
            </div>
            <div className="mt-8">
              <PrimaryButton loading={busy} onClick={() => void handleBodySubmit()}>
                继续
              </PrimaryButton>
            </div>
            <TrustNote>数据仅用于生成你的方案</TrustNote>
          </>
        ) : null}

        {currentStep === "activity_level" ? (
          <>
            <StepHeading
              title="最后一步：运动频率"
              subtitle="活动量决定你每天实际消耗多少热量。"
            />
            <div className="space-y-3">
              {ACTIVITY_LEVELS.map((option) => (
                <OptionCard
                  key={option.value}
                  label={option.label}
                  hint={option.hint}
                  selected={activity === option.value}
                  onClick={() => {
                    if (busy) return;
                    setActivity(option.value);
                    void handleFinalStep(option.value);
                  }}
                />
              ))}
            </div>
          </>
        ) : null}
      </div>
    </main>
  );
}
