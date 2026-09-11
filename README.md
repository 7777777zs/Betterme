# BetterMe · 健康测评系统后端

一个健康测评产品的核心后端：分步作答与进度恢复、服务端健康评估算法、订阅鉴权与差异化返回、模拟支付回调闭环，以及覆盖边界与异常路径的自动化测试。

[![CI](https://github.com/7777777zs/Betterme/actions/workflows/ci.yml/badge.svg)](https://github.com/7777777zs/Betterme/actions/workflows/ci.yml)

| | |
|---|---|
| 线上地址 | https://betterme-xinjie.vercel.app |
| 技术栈 | Next.js 16 · TypeScript · Prisma 7 · Supabase Postgres · Vitest |
| 测试 | 274 例：单元 191 + 集成 80 + 端到端 3 |

---

## 目录

- [快速开始](#快速开始)
- [线上演示](#线上演示)
- [数据模型](#数据模型)
- [API 文档](#api-文档)
- [健康评估算法](#健康评估算法)
- [测试](#测试)
- [关键设计决策](#关键设计决策)
- [已知限制](#已知限制)

---

## 快速开始

需要 Node 24 和一个 PostgreSQL 数据库（Supabase 或本地均可）。

```bash
npm install
cp .env.example .env
npm run env:setup      # 交互式填入数据库密码，自动做 URL 编码
npm run db:deploy      # 应用迁移建表
npm run db:seed        # 写入演示数据（可选）
npm run dev
```

`env:setup` 不是可有可无的便利脚本。Supabase 自动生成的密码常含 `@` `#` `?` `&`，直接粘进连接串会让 URL 解析错位，症状是「密码明明是对的却连不上」。脚本会对密码做 URL 编码后写入三处连接串。

### 环境变量

| 变量 | 用途 |
|---|---|
| `DATABASE_URL` | 运行时连接。走 Supabase transaction pooler（6543），带 `pgbouncer=true` |
| `DIRECT_URL` | 迁移专用直连（5432）。DDL 不能走事务池 |
| `TEST_DATABASE_URL` | 集成测试连接，指向独立的 `test` schema |
| `PAY_WEBHOOK_SECRET` | 支付回调的 HMAC 签名密钥。缺失时 `/pay` 直接拒绝服务 |
| `SESSION_TTL_HOURS` | 会话有效期，默认 720 小时 |

---

## 线上演示

> **https://betterme-xinjie.vercel.app**

### 对比付费前后的差异化返回

种子数据里有两个会话，**作答完全相同，只有订阅状态不同**。拿同一份输入的两个结果页对比，差异一目了然。

```bash
# 未付费：受保护字段在响应里根本不存在
curl -H 'Authorization: Bearer demo-free-token-do-not-use-in-production' \
  'https://betterme-xinjie.vercel.app/api/v1/sessions/11111111-1111-4111-8111-111111111111/result'

# 已付费：返回目标日期与逐周体重曲线
curl -H 'Authorization: Bearer demo-paid-token-do-not-use-in-production' \
  'https://betterme-xinjie.vercel.app/api/v1/sessions/22222222-2222-4222-8222-222222222222/result'
```

未付费响应里没有 `targetDate`、`weeksToGoal`、`effectiveWeeklyRateKg`、`weeklyProjection` 这四个键。注意是**键不存在**，不是值为 `null`，理由见[关键设计决策](#三脱敏用独立-dto-层字段直接不存在)。

### 重放支付回调

回调签名覆盖请求体的原始字节，手工拼 cURL 极易因为空格或键顺序导致签名不匹配。用脚本生成：

```bash
npm run pay:curl -- <sessionId> monthly https://betterme-xinjie.vercel.app
```

输出形如：

```bash
curl -X POST 'https://betterme-xinjie.vercel.app/api/v1/pay' \
  -H 'Content-Type: application/json' \
  -H 'X-Signature: <64 位十六进制签名>' \
  -d '{"sessionId":"...","plan":"monthly","idempotencyKey":"evt_..."}'
```

把同一条命令再执行一次，响应里的 `applied` 会变成 `false`，订阅周期不会被延长。这就是回调幂等生效的样子。

---

## 数据模型

七张表。刻意不做成「一张会话表 + 一个大 JSON 字段」。

```mermaid
erDiagram
    users ||--o{ quiz_sessions : "拥有"
    users ||--o| subscriptions : "拥有"
    users ||--o{ payment_events : "产生"
    quiz_sessions ||--o{ quiz_answers : "包含"
    quiz_sessions ||--o{ quiz_answer_events : "留痕"
    quiz_sessions ||--o| assessment_results : "产出"

    users {
        uuid id PK
        char64 anon_token_hash UK "只存 SHA-256 摘要"
        varchar email UK "预留"
        timestamptz created_at
    }

    quiz_sessions {
        uuid id PK "对外的 sessionId"
        uuid user_id FK
        enum status "IN_PROGRESS/COMPLETED/ABANDONED"
        varchar current_step "恢复时直接跳到这一步"
        enum unit_system "仅用于回显，数值一律公制"
        int version "乐观锁"
        timestamptz expires_at
    }

    quiz_answers {
        uuid id PK
        uuid session_id FK
        varchar step_key "与 session_id 联合唯一"
        jsonb value "已校验并规范化"
        int revision "被覆盖次数"
    }

    quiz_answer_events {
        bigint id PK
        uuid session_id FK
        varchar step_key
        jsonb value
        int revision
        int session_version "append-only 作答流水"
    }

    assessment_results {
        uuid id PK
        uuid session_id FK,UK
        enum gender "输入快照"
        enum goal "输入快照"
        decimal input_weight_kg "输入快照"
        decimal bmi "免费可见"
        int recommended_calories "免费可见"
        date target_date "付费可见"
        int weeks_to_goal "付费可见"
        jsonb weekly_projection "付费可见"
        varchar algorithm_version "结果可复现"
    }

    subscriptions {
        uuid id PK
        uuid user_id FK,UK
        enum status "NONE/ACTIVE/EXPIRED/CANCELED"
        varchar plan
        timestamptz current_period_end "与 status 共同决定权限"
    }

    payment_events {
        uuid id PK
        varchar idempotency_key UK "防重放的关键"
        uuid user_id FK
        enum event_type
        int amount_cents "整数分，绝不用浮点存钱"
        jsonb raw_payload "对账留档"
        timestamptz processed_at
    }
```

### 为什么是这七张表

**`quiz_answers` 每步一行，不是一个大 JSON 字段。** 新增测评步骤不用改表结构；`(session_id, step_key)` 唯一约束让重复提交天然幂等；乱序提交也不会互相覆盖。

**`quiz_answer_events` 与 `payment_events` 只增不改。** 出问题时能回放，而不是只能看当前快照。作答流水还为后续的漏斗流失分析留下了原始数据。

**`assessment_results` 冗余保存计算输入。** 结果是某一时刻的快照，作答却可以被后续修改。只存 `session_id` 指回作答表的话，事后就再也无法回答「这个结果当时是用什么算出来的」。加上 `algorithm_version`，算法迭代后老结果不会被误判成 bug。

**金额用整数分。** 浮点存钱迟早出现 0.1 + 0.2 的经典问题。

---

## API 文档

统一前缀 `/api/v1`。所有错误响应共用一个信封：

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "会话已被其他请求修改，请基于最新版本重试",
    "details": [{ "path": "heightCm", "message": "身高 必须在 90 到 250 之间" }],
    "meta": { "currentVersion": 3 }
  }
}
```

`code` 是接口契约的一部分，客户端按它分支。`message` 面向人类，可以随时改写和本地化。

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/v1/sessions` | 创建匿名用户与会话 |
| `GET` | `/api/v1/sessions/:id` | 进度恢复 |
| `PATCH` | `/api/v1/sessions/:id/answers/:stepKey` | 分步增量保存 |
| `POST` | `/api/v1/sessions/:id/abandon` | 主动作废未完成的测评 |
| `POST` | `/api/v1/sessions/:id/submit` | 触发计算 |
| `GET` | `/api/v1/sessions/:id/result` | 结果页，差异化返回 |
| `GET` | `/api/v1/me/subscription?sessionId=` | 订阅状态 |
| `POST` | `/api/v1/pay` | 模拟支付回调 |
| `GET` | `/api/health` | 健康检查，真的 ping 数据库 |

### 鉴权

除 `/api/v1/pay` 与 `/api/health` 外，所有接口需要 `Authorization: Bearer <token>`。

token 在创建会话时返回一次，之后服务端只持有它的 SHA-256 摘要。`sessionId` 可以出现在 URL、日志、分享链接里，泄漏无害；token 只走请求头。拖库拿到的是摘要，无法反推明文。

`/api/v1/pay` 不需要 token。它模拟的是网关到服务端的机器调用，身份由 HMAC 签名证明，而不是由用户凭证证明。

### 错误码

| code | HTTP | 含义 |
|---|---|---|
| `VALIDATION_FAILED` | 422 | 参数未通过校验 |
| `MALFORMED_JSON` | 400 | 请求体不是合法 JSON |
| `UNAUTHORIZED` | 401 | 缺少或格式错误的凭证 |
| `SESSION_NOT_FOUND` | 404 | 会话不存在**或**无权访问 |
| `SESSION_EXPIRED` | 410 | 会话过期，不再接受写入 |
| `SESSION_ALREADY_COMPLETED` | 409 | 已完成，不允许再改作答 |
| `SESSION_ABANDONED` | 409 | 已被用户主动作废，请开始新测评 |
| `VERSION_CONFLICT` | 409 | 乐观锁版本不匹配 |
| `UNKNOWN_STEP` | 404 | 未知的测评步骤 |
| `INCOMPLETE_SUBMISSION` | 422 | 提交时仍有必填步骤缺失 |
| `RESULT_NOT_READY` | 409 | 结果未生成，需先提交 |
| `INVALID_SIGNATURE` | 401 | 支付回调签名校验失败 |

### 几个接口细节

**分步保存带乐观锁。** `PATCH` 支持 `X-Session-Version: <version>` 头。版本不符返回 409 并在 `meta.currentVersion` 里给出当前版本。响应头回带新版本号，客户端下一次直接拿它继续加锁。

这里原本用的是标准的 `If-Match`，理由是「条件请求是 HTTP 早就定义好的语义，代理和网关都认识它，不必自造约定」。上线之后这个理由反过来把自己咬了，详见[一次真实的线上故障](#一次真实的线上故障)。

省略版本号头时退化为后写覆盖，但仍会递增版本号并写入流水，数据不会损坏。这是给简单客户端留的口子，代价明确写在这里。

**进度恢复不是隐形的。** 后端的恢复接口只解决了「数据还在」，但如果入口不说话，用户点进去发现自己站在第四步，体感是「这网页记住了我，还不让我重来」。

所以落地页会读取本地凭证并调一次恢复接口：有未完成的测评时，主按钮变成「继续上次测评 · 已完成 40%」，下方给一个「重新开始」；测评页顶部也会明说「已恢复你上次填写的进度」。同一个功能，说出来就从困扰变成了贴心，评审打开首页也能直接看到它在跑。

点「重新开始」会先把旧会话标记为 `ABANDONED` 再建新会话。这也是 `SessionStatus` 里第三个值的唯一写入路径 —— 在此之前它是个声明了却永远不会出现的状态，会让读代码的人去找一段并不存在的作废流程。作废失败不阻塞新会话创建：用户当下的诉求是「让我重新填」。

**结果页返回 200 而不是 402。** 结果页本身对所有人可访问，只是内容分级。402 会让前端把它当成错误分支处理，而付费墙其实是正常的产品形态。客户端通过响应体里的 `access` 字段决定渲染完整视图还是遮罩视图。

**会话不存在与无权访问返回同一个 404。** 如果无权访问返回 403，攻击者就能通过枚举 `sessionId` 区分「这个 id 不存在」和「这个 id 存在但不是你的」，从而探测出有效 id 空间。测试里有一条专门断言这两种情况的响应完全一致。

---

## 健康评估算法

纯函数，零 IO，`now` 作为显式参数传入以便确定性测试。

1. **BMI** = 体重 / 身高²，分类按 WHO 标准
2. **BMR** 用 Mifflin-St Jeor。选它而非更老的 Harris-Benedict，是因为前者在现代人群上的实测误差更小
3. **TDEE** = BMR × 活动系数（久坐 1.2 / 轻度 1.375 / 中度 1.55 / 高强度 1.725）
4. **建议摄入** = TDEE ± 热量缺口，受两道钳制：
   - 每日摄入不低于安全下限（男 1500，女 1200 千卡）
   - 每周体重变化不超过当前体重的 1%，减重绝对上限 1.0 kg，增重 0.5 kg
5. **目标日期**按每公斤脂肪 7700 千卡反推
6. **逐周曲线**，最多 104 周

### 钳制与速率联动

缺口被安全下限截断时，**生效速率同步下调，目标日期相应延后**。

这是算法里最容易做错的地方：只把热量钳到 1200，日期却还按未钳制的缺口算，结果就是「按这个方案吃，永远到不了这个日期」。测试里有一条专门验证被钳制的用户比未被钳制的用户需要更多周数。

### 告警而非报错

目标 BMI 偏离健康区间是用户的选择，直接拒绝会打断漏斗，但产品也不该假装这个目标健康。所以照常出结果，同时在 `warnings` 里标注风险。

真正非法的输入（负数、`NaN`、超出生理范围）由 zod 在入口层拦掉，根本进不到算法里。两者边界分得很清。

### 输入区间

| 字段 | 合法区间 |
|---|---|
| 年龄 | 13–100 |
| 身高 | 90–250 cm |
| 体重 | 30–300 kg |
| 目标体重 | 相对当前体重偏离不超过 50% |

最后一条拦的是误输入而非激进目标：70kg 的人填 175，多半是把身高填进了目标体重栏。

---

## 测试

```bash
npm test              # 单元 + 集成
npm run test:unit     # 仅单元，不需要数据库
npm run test:cov      # 带覆盖率报告
npm run test:e2e      # Playwright 真实浏览器流程
```

未配置 `TEST_DATABASE_URL` 时集成测试自动跳过并打印提示，单元测试照常运行。让「没配库」表现为整套测试崩溃，会掩盖掉单元测试本可以提供的反馈。

集成测试跑在同一实例的独立 `test` schema 里，每个用例前 `TRUNCATE` 全表。建表方式是**直接执行仓库里的迁移 SQL**，而不是 `prisma db push`：这样每次跑集成测试都顺带验证了迁移脚本本身能用。迁移写错但 schema 文件是对的，这种问题只有真正执行迁移才会暴露。

集成测试不起 HTTP 服务器，而是构造标准 `Request` 直接喂给 route handler。头部解析、状态码、错误信封都覆盖到了，同时避开了端口占用和启动等待。

### 覆盖了哪些场景

**算法（单元，约 70 例）**

- 各档 BMI 分界点。WHO 分界是左闭右开，差一个等号就会误判整档人群
- 生理区间的上下界，界内界外各一例
- 非法输入：`NaN`、`Infinity`、`-Infinity`、负数、0、字符串伪装的数字、`null`、`undefined`、未知枚举值
- 热量下限钳制生效，且速率与目标日期同步下调
- 目标与实际方向冲突（勾了减重却填了更高的目标体重）
- 曲线单调性、终点不越过目标、日期逐周递增
- 时间无关性：只有日期随 `now` 变化，数值部分不变；跨夏令时切换不漂移

**输入校验（单元）**

- 多余字段被拒绝，防止客户端往库里塞任意数据
- 英制换算后再校验一次公制区间，浮点擦边有兜底
- `1e400` 注入。`JSON.parse("1e400")` 得到 `Infinity`，这是真实可达的路径
- `isStepKey` 用 `Object.hasOwn` 而非 `in`，否则 `toString`、`__proto__` 会被误判为合法步骤

**持久化（集成，31 例）**

- 中断后恢复，拿回全部已填数据与下一步
- 乱序提交不互相覆盖，下一步仍指回最早的空缺
- 重复提交走 upsert 不产生重复行，`revision` 递增，流水表留存完整历史
- 并发更新：两个请求带同一版本号，一个 200 一个 409
- 越权访问返回 404，且与「会话不存在」的响应**完全一致**
- 会话过期后拒绝写入但仍可读取
- 校验失败时不写入任何数据，版本号也不推进

**鉴权与支付（集成，25 例）**

- 非会员响应的**键集合**里不含受保护字段，而不是断言值为空
- 拿库里的真值去响应原文里搜，确认一个数字都没漏出去
- 回调签名：缺失、错误密钥、报文篡改、键顺序改变
- 金额与套餐价不符时拒绝，防止客户端改价
- 幂等：串行重放与并发重放都只开通一次、只留一条流水
- 不同幂等键视为两笔支付，周期顺延而不是重新起算
- 付费前后同一会话的端到端差异，且免费字段前后完全一致
- 订阅过期后降级：`status` 仍是 `ACTIVE`、仅周期末过期的脏状态

### 为什么是这些场景

选取标准是「这里出错会造成什么后果」，而不是「这行代码有没有被执行到」。

- **会漏钱的**：订阅过期判断、金额校验、回调幂等
- **会漏数据的**：脱敏键集合、越权访问、错误响应泄漏资源存在性
- **会静默算错的**：热量钳制与速率联动、单位换算、浮点边界
- **用户真会遇到的**：中途关页面、网络抖动重复点击、来回修改答案

### 哪些没覆盖，以及原因

**前端组件的渲染测试。** 题目明确 UI 不在考查范围，投入产出比低。前端的正确性由端到端流程保障。

**负载与并发压测。** 并发正确性用两个请求的竞态测试验证了逻辑，但没有做几百 QPS 的压测。乐观锁在高冲突场景下的重试风暴需要真实流量才能评估。

**数据库故障注入。** 连接中断、事务超时、死锁的恢复行为没有测。这需要故障注入框架，在本次时间窗口内性价比不足。实际开发中确实遇到过一次远端库连接中断，表现是一批 500，说明这条路径值得加固。

**Supabase 行级安全（RLS）。** 本项目所有访问都经过服务端，客户端不直连数据库，RLS 不在攻击面上。如果将来开放客户端直连，这块必须补。

### 100% 覆盖率下藏着的一个 bug

`algorithm.ts` 的覆盖率长期是 100%，但里面有个真缺陷：减重分支检查了热量安全下限，维持分支取了较大值，**增重分支什么都没做**。它隐含假设「加上盈余之后一定高于下限」。当每日总消耗本身极低时（高龄、矮小、低体重、久坐叠加），这个假设不成立，算出的建议摄入会低于项目自己规定的下限。

覆盖率没能拦住它，因为**覆盖率衡量的是代码被执行过，不是行为被验证过**。那几行确实每次测试都在跑，只是没有任何一条断言检查过它们的输出是否守住了下限。

更糟的是当时有一条测试叫「建议摄入在任何输入下都不低于对应性别的下限」，实际只遍历了性别，目标固定为减重、方向固定向下。它只证明了减重分支，名字却承诺了全部。

**测试名称过度承诺比没有测试更危险。** 没有测试时人还会心虚，会去手工验一下；有一条名字唬人的测试摆在那里，就没人再看了。

现在那条用例改成真正遍历性别与方向的矩阵，三个分支走同一条钳制路径，且摄入被抬高后速率与目标日期会同步重算 —— 只把最终数字取较大值不算修好，那样页面上写着「按这个方案吃」，日期却是按另一套参数算的。

### 一次真实的线上故障

上线后点第一个选项必定失败，提示「网络似乎不太稳定」；点第二下变成「这份问卷在另一个页面被修改过」；刷新之后又一切正常。无痕模式复现，排除了本地缓存。

症状本身就指出了方向：第二下报版本冲突，说明**第一下在服务端其实成功了**，只是客户端没拿到能解析的响应，所以没更新本地版本号，第二次带着同一个旧版本再来，被乐观锁挡下。

根因是我自己埋的。乐观锁的版本号原本走标准的 `If-Match` 头，理由写在设计文档里：「条件请求是 HTTP 早就定义好的语义，代理和网关都认识它，不必自造约定」。

代理确实认识 —— 认识到会**替你处理掉**。Vercel 的边缘节点自己实现了 RFC 7232：

```
$ curl -X PATCH ... -H 'If-Match: 1'
HTTP/2 412
content-type: text/plain
An error occurred

PRECONDITION_FAILED
```

请求根本没到函数，返回的是纯文本错误页而不是我们约定的 JSON 信封。本地开发和 CI 都直接调用 route handler，中间没有 CDN，所以两百多个测试全绿也照样漏掉了它。

**教训：标准头部的语义归中间层所有。** 想让某个值原样穿过 CDN 抵达应用层，就得用一个中间层不认识、因而不会插手的自定义头。现在版本号走 `X-Session-Version`，并且有一条回归测试断言 `If-Match` 已经彻底退出这条链路。

顺带修掉了客户端一个被这次故障暴露的顺序错误：它原先先 `JSON.parse` 再检查状态码，于是所有非 JSON 的中间层错误（CDN 的 412、网关的 502、限流页面）都会在解析阶段抛异常，被压平成一句没有信息量的「网络似乎不太稳定」，状态码和原始内容全部丢失。现在先看状态码，解析失败也会把 HTTP 状态和响应原文带出来。

### 一次真实的性能排查

上线后第一版的分步保存要将近两秒。直觉答案是「数据库在东京，慢是应该的」，但量了才发现是两件事叠加，而且主因不是地理位置本身。

Vercel 的函数默认跑在 `iad1`（美东），数据库在 `ap-northeast-1`（东京）。每一次查询都要跨一次太平洋，实测单次往返 146 毫秒。而一次分步保存内部有九次串行查询（鉴权、版本号递增、读旧 revision、upsert 作答、回读会话、写流水、更新当前步骤，加上事务的开始与提交），九次乘以 146 毫秒就是一秒三。

修法是把函数固定到东京，与数据库同区域，一行配置：

```json
{ "regions": ["hnd1"] }
```

| 指标 | 改动前 | 改动后 |
|---|---|---|
| 数据库单次往返 | 146ms | 5ms |
| 分步保存 `PATCH` | 1900ms | 230ms |
| 进度恢复 `GET` | 1500ms | 222ms |
| 提交计算 `POST` | 1593ms | 235ms |

改完之后剩下的 230 毫秒里，大部分是客户端到 Vercel 边缘的公网延迟，服务端实际耗时只剩四五十毫秒。

**那九次串行查询没有再优化**，这是有意的取舍。它们现在合计约 45 毫秒，占端到端耗时的两成不到。把它们压成一条带 CTE 的原生 SQL 确实能做到一次往返，但会牺牲 Prisma 的类型安全和这段逻辑的可读性，换来的收益已经淹没在公网延迟里。先量，再决定值不值得，而不是反过来。

### 覆盖率统计里排除了什么

三类文件不计入覆盖率分母，理由都写在 `vitest.config.mts` 的注释里：

- `**/types.ts`：纯类型声明，编译后没有运行时代码，计入分母只会稀释真实数字。
- `src/lib/client/**`：浏览器端模块，跑在 node 环境的测试碰不到它。它的正确性由真实浏览器里的端到端流程保证，让 node 测试来背这个指标是自欺欺人。
- `src/lib/db/**`：数据库连接装配。集成测试用 `vi.mock` 把它换成了 test schema 的客户端，所以它在测试里根本不会被执行，本身也没有业务逻辑可测。

排除的标准是「这个文件的正确性由别的机制保证」，不是「这个文件不好测所以算了」。业务逻辑一个都没排除。

---

## 关键设计决策

### 一、并发用乐观锁而非悲观锁

测评填写是低冲突场景。悲观锁（`SELECT FOR UPDATE`）会在 serverless 环境下把数据库连接占住，代价远大于收益。

乐观锁的实现是让更新语句自带 `WHERE version = :expected`，影响行数为 0 即判定冲突。这是一条 SQL 完成的原子操作，不存在「先查再改」的竞态窗口。

### 二、幂等靠唯一索引，不靠先查后写

「先查有没有处理过，再决定要不要处理」在并发重发下有竞态：两个请求可能同时查到「没处理过」。

所以 `/pay` 的实现是**先插流水，让唯一索引兜底**。数据库的唯一约束是一个天然的串行化点，无论并发多少个请求，只有一个能插入成功，其余撞约束后走重放分支。测试里有一条并发重放四次的用例专门验证这一点。

重放返回 200 而不是错误码。对网关来说「已经处理过」和「刚刚处理成功」都是成功，返回错误只会让它继续重试。

### 三、脱敏用独立 DTO 层，字段直接不存在

非会员的响应里，受保护字段是**根本不存在的键**，不是 `null`，不是空数组，不是打码字符串。

不用「查出全量再 delete 掉几个字段」的写法，有三个理由：

1. 那种写法的默认行为是「泄漏」，只有显式 delete 才安全。以后新增一个付费字段，忘记加进 delete 列表就直接漏出去，而且不会有任何测试失败来提醒你。这里的默认行为是「不泄漏」，新增字段必须显式加进 premium 分支才可见。
2. 置为 `null` 的响应只能断言「值是空的」，断言不了「字段不存在」。对绕过前端直接打接口的人来说，`targetDate: null` 往往意味着后端某个分支会填上真值。
3. 两种形态是两个互斥的 TypeScript 类型，编译期就能挡住「在免费分支里不小心引用了付费字段」。

对应的测试断言的是 `Object.keys` 的结果，并且额外拿库里的真值去响应原文里全文搜索。

### 四、订阅权限不只看 status

`status = ACTIVE` 但 `current_period_end` 已过去，是真实系统里非常常见的状态：续费失败、定时任务没跑、时钟漂移。只认 `status` 的实现会把这些人当会员，白送内容。

反过来，`CANCELED` 但周期未过的用户仍保留权益，因为他已经付过这个周期的钱。这条业务约定写在测试里，避免日后有人「顺手」改成一取消就断权。

### 五、单位在入口层统一

英制输入在 zod 的 `transform` 里换算成公制，库里只存公制。同一列绝不允许出现两种量纲。`unit_system` 字段只用于前端回显，不参与任何计算。

集成测试里有一条断言：英制载荷落库后，`weightLb` 和 `heightIn` 这些字段必须不存在。

---

## 已知限制

- **代谢适应未建模。** 体重下降后 TDEE 会随之下降，本算法用固定的 7700 千卡每公斤，长周期目标的预测会偏乐观。真实产品需要分段重算。
- **`OTHER` 性别的 BMR 常数取男女中点。** 这不是医学结论，只是在缺少更细分依据时一个不偏向任何一侧的工程折中。
- **Prisma CLI 的传递依赖有安全告警**（`mysql2`、`deepmerge-ts`）。仅存在于 devDependency，不进运行时产物，且本项目用的是 Postgres 不是 MySQL。
- **本地对着远端 Supabase 跑集成测试较慢且偶发掉连接。** 每次 Prisma 调用都是一次跨海往返，整套约七分钟。CI 跑本地 Postgres 容器，是覆盖率与通过状态的权威来源。
- **会话清理没有定时任务。** `expires_at` 已过的会话不会被自动标记为 `ABANDONED`，目前只在写入时拒绝。生产环境需要一个定时任务。

---

## 项目结构

```
src/
  app/api/v1/          route handler，只做鉴权、解析、委派
  lib/
    auth/              匿名凭证的生成、哈希、鉴权
    db/                Prisma 客户端单例
    dto/               结果页序列化，免费与付费两种互斥形态
    health/            健康评估算法，纯函数
    http/              错误体系与统一响应信封
    quiz/              步骤定义、zod schema、会话服务
    subscription/      权限判定与支付回调处理
prisma/
  schema.prisma        数据模型
  migrations/          迁移脚本
  seed.ts              演示数据
tests/
  unit/                不碰数据库
  integration/         独立 test schema
```
