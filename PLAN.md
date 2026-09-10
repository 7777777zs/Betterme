# 全栈挑战执行计划 · 健康测评系统后端

> 目标：3 天内交付一个「站得住的工程骨架 + 扎实的测试」，而非一个能跑的表单。
> 评分五维：后端功底 / DB 设计 / 逻辑闭环 / 测试与质量 / AI 协作效率。

---

## 0. 已确定的决策

| 项 | 选择 | 理由 |
|---|---|---|
| 框架 | Next.js 15 App Router + TypeScript | 题目点名，前后端同仓，部署最省事 |
| 后端 | Next.js Route Handlers（`app/api/v1/**`） | 无需额外服务，Vercel 原生 |
| 数据库 | Supabase Postgres（区域 ap-northeast-1） | 题目点名 |
| ORM | Prisma | 题目点名；迁移脚本与类型生成成熟 |
| 校验 | zod | 边界与非法输入的单一真相来源 |
| 测试 | Vitest（单元 + 集成）、Playwright（E2E） | 一键 `npm test` |
| CI | GitHub Actions + Postgres service container | 加分项 |
| 部署 | Vercel + Supabase | 全家桶 |
| 前端 | 先够用后精致 | Day1-2 保证流程跑通，Day3 有余力再升级视觉 |

**Supabase 项目 ref**：`bxjgfzlkgktfcupkmqip`
**GitHub 账号**：`7777777zs`

---

## 1. 数据建模

七张表。刻意不做成「一张大 JSON 表」，扩展性与关系建模是 DB 维度的主要得分点。

### 1.1 `users`
匿名用户。题目允许「随机生成的 UserID 或简易 Session 识别」，但做成正式的 users 表才有扩展空间（日后接真实登录只需加 `email` / `auth_provider`）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `anon_token_hash` | text unique | 客户端持有明文 token，库里只存 sha256。防止拖库后冒充 |
| `email` | text null unique | 预留 |
| `created_at` / `updated_at` | timestamptz | |

### 1.2 `quiz_sessions`
一次测评会话。进度恢复的锚点。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | 对外的 sessionId |
| `user_id` | uuid FK → users | |
| `status` | enum(IN_PROGRESS, COMPLETED, ABANDONED) | 状态机 |
| `current_step` | text null | 恢复时前端直接跳到这一步 |
| `unit_system` | enum(METRIC, IMPERIAL) | 英制输入在入口统一换算成公制入库 |
| `version` | int default 0 | **乐观锁**。并发更新的核心 |
| `completed_at` | timestamptz null | |
| `expires_at` | timestamptz null | 会话过期策略 |

索引：`(user_id, status)`、`(status, updated_at)`。

### 1.3 `quiz_answers`
每一步一行，不是一个大 JSON 字段。这样加新步骤不用改表结构。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `session_id` | uuid FK → quiz_sessions ON DELETE CASCADE | |
| `step_key` | text | `gender` / `goal` / `body_metrics` / `activity_level` … |
| `value` | jsonb | 已通过 zod 校验后的规范化值 |
| `revision` | int | 该步被覆盖了几次 |

唯一约束 `(session_id, step_key)` → 重复提交走 upsert，天然幂等。

### 1.4 `quiz_answer_events`
append-only 审计流水。每次写入追加一行，保留完整作答历史。
用途：重复 / 乱序提交的可追溯性，也是「数据建模有没有想清楚」的加分点。

### 1.5 `assessment_results`
算法产物，与 session 一对一。

| 字段 | 说明 |
|---|---|
| `bmi` numeric(5,2) / `bmi_category` | 用 numeric 而非 float，避免浮点漂移 |
| `bmr` / `tdee` / `recommended_calories` int | |
| `protein_g` / `carbs_g` / `fat_g` int | 宏量营养素拆分 |
| `target_date` date null | 目标预测日期 |
| `weekly_projection` jsonb | **受保护字段**，非会员不返回 |
| `warnings` jsonb | 目标不合理时的提示，而不是硬算出荒谬结果 |
| `algorithm_version` text | 算法版本号，结果可复现、可回溯 |

### 1.6 `subscriptions`
| 字段 | 说明 |
|---|---|
| `status` enum(NONE, ACTIVE, EXPIRED, CANCELED) | 题目里的 `subscription_status` |
| `plan` / `current_period_start` / `current_period_end` | |
| `activated_at` | |

### 1.7 `payment_events`
支付回调流水。`idempotency_key` 唯一约束 → 同一回调重放不会重复开通会员。这是「模拟支付回调闭环」里最容易被忽略、也最能体现工程素养的一点。

---

## 2. API 设计

统一前缀 `/api/v1`。统一错误信封：

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "...", "details": [...] } }
```

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/sessions` | 创建匿名用户 + 会话，返回 `sessionId` 与 `token` |
| GET | `/api/v1/sessions/:id` | **进度恢复**：已答步骤、`currentStep`、`version` |
| PATCH | `/api/v1/sessions/:id/answers/:stepKey` | **分步增量保存**，带 `If-Match: <version>` |
| POST | `/api/v1/sessions/:id/submit` | 校验完整性 → 触发算法 → 落库 |
| GET | `/api/v1/sessions/:id/result` | **鉴权差异化返回** |
| GET | `/api/v1/me/subscription` | 会员状态 |
| POST | `/api/v1/pay` | 模拟支付回调，幂等 |
| GET | `/api/health` | 部署健康检查 |

### 关键设计点

**鉴权**：`Authorization: Bearer <token>`，服务端比对 sha256 哈希。跨 session 访问返回 404 而非 403，不泄漏资源存在性。

**并发控制**：PATCH 带 `If-Match` 版本号。版本不匹配返回 `409 VERSION_CONFLICT` 并附当前状态，而不是静默覆盖。这条直接对应题目里的「并发更新」测试要求。

**差异化返回用独立 DTO 序列化层**：非会员的响应里 `weekly_projection`、`target_date` 等字段**根本不存在**，而不是置为 `null` 或空数组。
理由：置 null 的实现往往是先查出全量再删字段，一旦某个分支漏删就泄漏；而且测试只能断言「值为空」，断言不了「字段不存在」。独立 DTO 层让「非会员形态」成为类型系统里的一等公民。
非会员额外返回 `locked: ["weeklyProjection", "targetDate"]` 和 `paywall` 文案对象，前端据此渲染模糊遮罩。

**返回码**：非会员访问结果页返回 `200` + 脱敏体，不是 `402`。因为结果页本身是可访问的，只是内容分级。付费墙信息在 body 里。

---

## 3. 健康评估算法

`lib/health/` 下的纯函数，零 IO，便于穷举测试。

1. **BMI** = kg / m²，分类按 WHO 标准
2. **BMR** = Mifflin-St Jeor（比 Harris-Benedict 更准，README 里说明选型理由）
3. **TDEE** = BMR × 活动系数（久坐 1.2 / 轻度 1.375 / 中度 1.55 / 高强度 1.725）
4. **建议摄入** = TDEE ± 缺口，但施加安全钳制：
   - 女性不低于 1200 kcal，男性不低于 1500 kcal
   - 周变化速率不超过体重的 1%
5. **目标日期** = 每公斤脂肪 7700 kcal 反推周数
6. **周曲线** = 逐周体重预测数组（受保护字段）
7. **警告而非报错**：目标 BMI < 18.5 或 > 30 时返回 `warnings`，仍给出结果但标注不健康

### 输入边界
| 字段 | 合法区间 | 非法时 |
|---|---|---|
| 身高 | 90–250 cm | 422 |
| 体重 | 30–300 kg | 422 |
| 年龄 | 13–100 | 422 |
| 目标体重 | 与当前体重差值 ≤ 50% | 422 |

额外拦截：`NaN`、`Infinity`、字符串数字、负数、超长小数、超大整数、原型污染键（`__proto__`）。

---

## 4. 测试策略

题目原话：「写测试不是加分项，是基本盘」。四层。

### 4.1 单元测试 · 算法（约 45 例）
- happy path：多组典型身材 × 三种目标（减重 / 维持 / 增重）
- 边界：身高体重年龄各自的上下界、界内界外各一例
- 非法：NaN、Infinity、负数、0、字符串、null、undefined
- 不合理目标：目标体重高于当前 2 倍、低于健康下限
- 钳制生效：极端缺口是否被 1200/1500 下限截断
- 快照：`algorithm_version` 对应的黄金用例，防止算法被无意改动

### 4.2 集成测试 · 分步保存与恢复
真实数据库（本地走 Supabase `test` schema，CI 走 Postgres service container）。
- 中断恢复：写 3 步 → 重新 GET → 断言进度一致
- 乱序提交：先写第 4 步再写第 2 步
- 重复提交：同一步写两次，断言 upsert 且 `revision` 递增
- 并发更新：两个请求携带同一 `version` 并发 PATCH，断言一个成功一个 409
- 越权：A 的 token 访问 B 的 session，断言 404
- 未完成即 submit：断言 422 并列出缺失步骤

### 4.3 鉴权差异化测试
- 非会员结果页：断言受保护字段**不在** JSON 键集合中（用 `Object.keys` 断言，不是断言值为 null）
- 会员结果页：断言字段齐全且数值合理
- 过期会员：`current_period_end` 已过 → 按非会员处理

### 4.4 端到端 · 支付闭环
- Playwright 走完整 funnel → 结果页看到遮罩 → 调 `/pay` → 刷新 → 完整数据
- API 层重放测试：同一 `idempotency_key` 调两次 `/pay`，断言只开通一次、不重复计费
- 非法回调：签名错误 / 金额为负 / session 不存在

### 4.5 一键运行
```bash
npm test          # 单元 + 集成
npm run test:e2e  # Playwright
npm run test:cov  # 覆盖率报告
```

---

## 5. 三天排期

### Day 1 · 骨架与持久化
- [ ] 项目迁出 OneDrive，`create-next-app` 初始化，ESLint + Prettier + tsconfig strict
- [ ] `.env.example` 生成，你填入 Supabase 密码
- [ ] Prisma schema 全量落地 + 首次 migration 推到 Supabase
- [ ] zod schema 层（每个 step 一个 schema，共享给前后端）
- [ ] `POST /sessions`、`GET /sessions/:id`、`PATCH /answers/:stepKey`
- [ ] 鉴权中间件（token 哈希比对）
- [ ] 集成测试环境跑通（test schema + 事务回滚隔离）
- [ ] 分步保存与恢复的集成测试全绿
- [ ] 推首个 commit 到 GitHub

**Day 1 验收**：能用 cURL 创建会话、分步写入、重新读回进度，并发冲突返回 409，测试全绿。

### Day 2 · 算法、鉴权、支付闭环
- [ ] `lib/health` 纯函数算法 + 45 例单元测试
- [ ] `POST /submit` 完整性校验 + 计算 + 落库
- [ ] DTO 序列化层（会员 / 非会员两种形态）
- [ ] `GET /result` 差异化返回 + 测试
- [ ] `POST /pay` 幂等回调 + `payment_events` 流水 + 测试
- [ ] 前端 funnel「够用版」跑通全流程
- [ ] GitHub Actions CI 配置，PR 上跑绿

**Day 2 验收**：本地端到端走一遍 funnel，付费前后返回差异肉眼可见，CI 徽章变绿。

### Day 3 · 补测试、上线、交付物
- [ ] 补齐异常路径测试，覆盖率过 80%
- [ ] Playwright E2E
- [ ] Vercel 部署，环境变量配置，线上冒烟测试
- [ ] 种子脚本生成一个**已支付的测试 sessionId**（交付物要求）
- [ ] README：启动方式、API 文档、测试覆盖说明、cURL 示例
- [ ] Mermaid 版 Schema 关系图
- [ ] AI 使用复盘文档（含「否决 AI 方案」的真实案例）
- [ ] 前端视觉升级（若有余力）
- [ ] 打包发四个邮箱

**Day 3 验收**：评审点开链接能从头跑到尾，cURL 能重放 `/pay`，测试徽章绿。

---

## 6. 分工

### 我做
项目初始化、Prisma schema 与迁移、全部 API 实现、健康算法、zod 校验层、DTO 脱敏层、全套测试、GitHub Actions、Mermaid Schema 图、README 与 API 文档、AI 复盘初稿、已支付测试会话的种子脚本、前端 funnel 与付费弹窗、本地跑通并给你结果。

### 你做
1. **填数据库密码**：我生成 `.env.example` 后，你复制成 `.env` 并填入 Supabase 密码。不要贴到对话里。
2. **确认项目迁出 OneDrive**（建议 `C:\dev\betterme`）。
3. **Vercel**：注册、导入仓库、按我给的清单配环境变量、点部署。
4. **提供姓名**：文档命名 `【姓名】_全栈挑战_YYYYMMDD` 要用。
5. **审阅 AI 复盘**：其中「你否决掉 AI 方案」那段，我会记录过程中真实发生的分歧，最终措辞你定。
6. **发邮件**给 jin / bin / alex / rip 四个 @arkon-tech.com 邮箱。

---

## 7. 风险与预案

| 风险 | 预案 |
|---|---|
| Serverless 下 Prisma 连接数耗尽 | 运行时用 pooler 连接串（6543），迁移用 direct（5432），并复用全局 PrismaClient 单例 |
| OneDrive 同步 `node_modules` 导致安装失败 | Day 1 第一步迁出 |
| Supabase 免费实例休眠 | 部署后加一个轻量定时探活；README 注明 |
| 前端占用时间挤压后端 | 「先够用后精致」，前端升级放 Day 3 最后，可裁剪 |
| 测试库与开发库互相污染 | 独立 `test` schema，每个用例事务回滚 |
