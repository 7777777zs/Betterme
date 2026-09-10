import { LandingCta } from "@/components/landing-cta";

export const metadata = {
  title: "BetterMe · 你的个人健康计划",
  description: "两分钟测评，拿到属于你的每日热量目标与体重曲线预测。",
};

/**
 * 落地页。
 *
 * 只做一件事：把人送进漏斗。所以整页只有一个行动点，
 * 没有导航栏、没有次要按钮、没有可以点走的链接。
 * 漏斗类产品的落地页每多一个出口，完成率就掉一截。
 */
export default function LandingPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center px-6 py-16">
      <div className="text-center">
        <p className="mb-6 inline-flex items-center gap-2 rounded-full border border-line bg-surface px-4 py-1.5 text-sm text-ink-soft">
          <span className="size-1.5 rounded-full bg-accent" aria-hidden />
          个人化健康测评
        </p>

        <h1 className="text-balance text-4xl font-semibold leading-[1.15] tracking-tight text-ink sm:text-5xl">
          两分钟，拿到一份
          <br />
          真正为你算过的计划
        </h1>

        <p className="mx-auto mt-5 max-w-md text-pretty text-lg leading-relaxed text-ink-soft">
          回答几个问题，我们会用你的身体数据算出每日热量目标、营养配比，
          以及达成目标体重需要多久。
        </p>

        {/*
          行动区是客户端岛：它要读 localStorage 才知道该显示
          「开始测评」还是「继续上次测评」。页面其余部分保持静态预渲染。
        */}
        <LandingCta />

        <dl className="mt-14 grid grid-cols-3 gap-4 border-t border-line pt-8 text-center">
          {[
            { value: "2 分钟", label: "完成测评" },
            { value: "5 项", label: "个人化指标" },
            { value: "逐周", label: "体重曲线预测" },
          ].map((item) => (
            <div key={item.label}>
              <dt className="text-xl font-semibold text-ink">{item.value}</dt>
              <dd className="mt-1 text-sm text-ink-faint">{item.label}</dd>
            </div>
          ))}
        </dl>
      </div>
    </main>
  );
}
