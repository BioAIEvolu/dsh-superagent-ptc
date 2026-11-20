# SuperAgent PTC 架构

本文描述当前 `dsh-superagent-ptc` 实现，而非早期研究草案。包版本以 `package.json` 为准，目标宿主为 DSH `>=0.2.2-rc.5 <0.3.0-0`。运行时验证以 [VALIDATION.md](VALIDATION.md) 为准；架构存在不等于每项模型行为已运行验证。

## 1. 架构决策

SuperAgent PTC 是 **Preset-first、宿主原生执行、插件增量监管**：在宿主原生 Agent/Session 机制之上叠加一层监管状态机（`Run → Anchor → Mandate → Evidence → Decision`），把原生 agent 会话按角色绑定进这条监管链；PTC 的原生事件链是整条链的证据底座，监管层不产生第二套事件流。

- 包名 `dsh-superagent-ptc`（npm 公开包，仓库与安装方式见 README）；预设显示名 **SuperAgent PTC**，与标准、创造、PTC、极简完整并列。
- 稳定内部 ID 不随显示名/包名改变：preset ID `super-agent`、既有 `super_*` 工具、storageDomain `super_agent_mode`、SnapshotProof record 等持久标识保持兼容；名称变化不构成状态迁移。新增 `super_route` 是能力扩展，不改变原有 ID。
- 直接组合当前 `@deepseek-ai/dsh-tool-executor-ptc`，不使用 deprecated 的 tool-presentation PTC 包装；
- 原生 Agent/Session、Goal、subagent、Agent Teams/Task 保持执行权威；
- 插件新增 Run/Obligation/Anchor/WorkItem/Mandate/Evidence/GateDecision/AuditEvent 及监管投影；
- 不实现第二套 Agent loop、REPL、全局模型路由引擎、Team 任务板、SQLite 执行库或通用工作流画布。`super_route` 仅是当前 root Run 的策略与故障适配，与 DS Bot 无关。

baseline 与相似项目固定快照仅作研究材料，不进入运行依赖。复用决策与许可边界记录在发布说明与包内 [NOTICE.md](../NOTICE.md)。

## 2. 逻辑分层与装载

```text
cordis.patch.yml
├─ 全局裸包 Host: dsh-superagent-ptc
│  ├─ 七工具 + 条件 when + Reviewer tool guard
│  ├─ 动态 Run prompt / 原生 SessionId 绑定
│  ├─ storageDomain + SnapshotProof + recovery
│  └─ 只读 projection RPC
├─ super-agent preset
│  ├─ 当前 PTC executor / goal / subagent / Teams（宿主控制）
│  └─ Lead / Worker / Reviewer 组合纪律
└─ Web Client
   ├─ conversation.session.header.actions.subagent.footer
   └─ sidebar.right.pane.tab
````

### 2.1 全局 Host 与预设隔离

[cordis.patch.yml](../cordis.patch.yml) 同时声明一个全局裸包 Host 行和一个 `super-agent` 预设。全局 Host 行让 client-modules 能发现客户端；不能只把 Host 放在 preset 子树或使用 `/host` 子路径代替。

全局装载不等于全局注入：

- 工具的异步 `when` 只接纳当前 `super-agent` 成员，或已绑定且 proof 校验通过的 standard Reviewer；
- 动态 prompt 对其他会话返回空文本；
- Client 入口根据当前会话预设显示，v4 已实测 standard/PTC 下入口与面板为 0；
- Host 的全局 `ctx.tools.guard` 只对绑定 Reviewer 生效，其他 Agent 沿用原宿主管线。

实现入口：[src/host/index.ts](../src/host/index.ts)、[src/host/access.ts](../src/host/access.ts)、[src/client/index.ts](../src/client/index.ts)。

### 2.2 Pure Core

`SuperAgentCore` 是单 Run、宿主无关状态机。ID、clock、digest 由 `CoreDrivers` 注入；core 不创建 Agent、不写文件、不执行 shell、不访问网络，也不导入 Cordis/Node/React。

除 `createRun`、只读评估与快照外，写操作都要求 `expectedRevision + expectedGeneration`。成功写递增 revision 并追加 AuditEvent；拒绝操作原子返回，不留下半次状态变更。生产构造器没有关闭硬门的 `disabledChecks` 入口，门禁删除只存在于测试 mutation helper。

### 2.3 Host Adapter

Host 负责 core 无法证明的真实世界事实：

- 从 `exec.agent` 和 `ctx.subagents.rootOf` 取得真实 actor/root；
- 校验 Worker/Reviewer 是当前 root 的原生 descendant；
- 读取当前 Session 的 `agentPreset` 投影，强制 Reviewer 为 native standard；standard 是工具预设，不决定模型、推理档或成本，不是模型降级；
- 以工具 guard 拒绝绑定 Reviewer 的写入、未知操作及任意 PTC `run_code`；
- 从原生 Session 事件生成 host-observed evidence；
- 串行事务、SnapshotProof、持久化、恢复对账与只读 RPC 投影。

Host 实际注册七项工具，而不是研究草案中的额外 `super_gate` / `super_audit`：

| 工具 | 当前动作 | 调用边界 |
| --- | --- | --- |
| `super_run` | create/show/plan/pause/resume/replan/complete | 写操作由 root Lead 执行 |
| `super_anchor` | create/show/history | 新锚点由 root Lead 创建 |
| `super_mandate` | prepare/bind/bindReviewer/report/show | Lead 准备和绑定；绑定 Worker report |
| `super_evidence` | observe/record/list | Host 观测原生事件；绑定 Worker/Reviewer 记录受限回执 |
| `super_review` | evaluate/decide/release | 决定和放行仅属绑定 standard Reviewer |
| `super_route` | show/set/inspect/switch | root Lead 设置策略、读回实际路由、授权有界切换 |
| `super_snapshot` | 无参数 | 当前 root 的只读组合投影 |

### 2.4 Client

Client 只消费 Host projection，不持有第二份权威状态：

- 无 `conversation.input.dock` 入口：2026-11-20 用户决定移除 composer 上方的“Super Agent 监管”标签，该 slot 不再注册；
- subagent footer 在对应宿主区域提供同一入口；
- 右栏注册 `super-agent` tab，展示 Run、当前 anchor、开放义务、WorkItem/Mandate、证据、决策、审计、原生 Team/Goal/subagent、恢复和 proof 状态；
- 空 Run、unavailable、fail 与 unknown 均按真实数据显示，不生成演示数据。

v4 已实测这些 GUI 集成路径；模型执行与委派链仍为 unknown，详见验证文档。

## 3. 原生 SessionId 与执行权威

### 3.1 Root Run 绑定

每个原生 root Session 最多对应一个当前监管 Run：

```text
calling exec.agent.id
        │ ctx.subagents.rootOf
        ▼
native root SessionId ── 1:1 ── RunState / proof / repository queue
        │
        └─ listDescendants 校验 Worker / Reviewer 的真实 SessionId
````

- `super_run` 的 `sessionId` 由 Host 注入，不信任模型填写；
- Mandate 保存 `workerAgentId/reviewerAgentId/nativeTaskId` 等原生引用；
- Worker report 和 Reviewer decide/release 都由真实调用者 ID 与 Mandate 绑定校验；
- 投影 RPC 只接受精确 root SessionId，拒绝 alias、descendant 或跨会话读取；
- 原生执行状态与 supervision 状态冲突时显示阻断原因，不静默互相覆盖。

### 3.2 Worker 与 Reviewer 组合

| 角色 | 预设 | 工具路径 | 核心约束 |
| --- | --- | --- | --- |
| Lead | super-agent | 当前 PTC `run_code` SDK | 建立/规划/绑定/重规划；release 由 Reviewer 执行 |
| Worker | 继承 super-agent | 当前 PTC `run_code` SDK | 仅当前 Mandate；reported_done 不等于 accepted |
| Reviewer | **`agent_preset=standard`** | native standard + 条件开放的 super 工具 | 独立、只读、读取当前 preset 投影；写/未知操作 fail closed |

`allowedAgentPresets: [super-agent, standard]` 只允许这两种显式组合。Reviewer 的 super-agent/PTC 组合会在 review 前被拒绝；当前 preset 投影不可读同样失败封闭。

**Lead 与模型路由边界**：不另设持有任务状态的独立 assess/route Agent。Lead 直接持有 Anchor、义务、Mandate 和原生委派上下文，避免第二权威、双份上下文、额外模型调用及恢复故障点。Worker 默认继承 super-agent 与当前有效路由；spawn 行的 `modelSelection/modelDiscovery` 允许 Lead 显式选择 Worker 模型，但不等于自动路由。未设置 Run `modelPolicy` 时无插件层自动 provider/model 降级；只有显式 `allowFailureSwitch=true` 且满足故障分类、allowlist 和预算时才切换。推荐有界同路由重试和副作用对账。详见 [策略决策](../../research/super-agent-strategy/2026-11-19-decision.md)。

### 3.3 Team 未开启的降级

Host 只调用 `agentTeams.isEnabled(root)` 读取状态，不主动开启 Team：

- enabled：可读取原生任务，并可选绑定真实 `nativeTaskId`；
- disabled：原生 Team task 列表为空，使用 subagent + Mandate/native SessionId 继续；
- disabled 时显式绑定 `nativeTaskId` 返回 `TEAM_DISABLED`；
- inactive、缺失、不可读或矛盾的成员/任务状态不能推导为成功。

## 3A. super_route：Run 级模型策略与故障适配

### 3A.1 权威范围

`super_route` 只操作当前 root Run 的可选 `modelPolicy`，与 DS Bot 无关，也不是全局路由引擎：

- 不创建独立 assess/route Agent，不持有第二任务权威；
- 不改变其他 Session、Team、模型目录、权限或 DS Bot；
- 无策略时 `modelPolicy` 缺省，Worker/Reviewer route 以 `null` 表示继承，`agent/request-error` 交还原生处理；
- `locked/balanced/economy/performance` 是显式策略模式，不是模型评分器；locked 要求 Worker/Reviewer 显式路由且 allowlist 合法，预算必须是非负整数。

### 3A.2 Mandate 冻结与真实路由读回

`prepareMandate` 将当前策略快照写入 Mandate：

```text
Run.modelPolicy(revision)
  → workerRoute / reviewerRoute
  → policyRevision + routeReason
  → native Agent model.current() + 最后 request header
  → matched / inherited / unknown
````

`inspect` 同时比较预期角色路由、实时 `model.current()` 和 request header。显式路由不一致、Agent 不在线、header 不可读或双方互相矛盾均为 unknown；继承路由明确标 inherited，历史 Mandate 的“未记录”不与 null 继承混同。Host 不把请求时的模型名直接当成实际运行路由。

### 3A.3 故障分类与有界处理

Host 的 `agent/request-error` adapter 只影响下一次 attempt，不改写已发出的请求，也不创建 Agent：

| 分类 | 处理 |
| --- | --- |
| transient / timeout / rate_limit | 可按 `maxSameRouteRetries` 同路由重试；等待取 policy cooldown 与 provider retry-after 的较大值，abort 即失败封闭 |
| quota / account_quota / provider_unavailable / route_incompatible | 仅在 allowFailureSwitch=true、allowlist 有可用备用路由且 `maxRouteSwitches` 未耗尽时切换 |
| authentication / permission / tool_input / business_acceptance / snapshot_proof / write_scope / identity / unknown | 不自动切换；交还原生处理或失败封闭，不能当作模型路由问题 |

同路由重试按 Mandate+route 计数，切换按 Mandate 的 requested RouteSwitch 计数，两者不共享预算。无可切换备用路由或预算耗尽会持久化 blocked，不调用 `model.select`。

### 3A.4 切换提交、读回与验收限制

授权切换先通过 Core 记录 RouteSwitch，再对绑定 Agent 调用 `model.select` 并读回 `model.current()`：

1. Agent 不在线时不写 Core switch，也不尝试选择模型；
2. Core 成功而原生选择失败时，错误明确为 `ROUTE_SELECT_FAILED_AFTER_COMMIT`，保留 durable 记录并先 inspect，不假装回滚或成功；
3. 读回不一致为 `ROUTE_MISMATCH`，不得写成 pass；
4. requested switch 后，旧 Mandate 的 Worker report、evidence observe/record 和 Reviewer decide/release 被 `ROUTE_SWITCH_REQUIRES_NEW_MANDATE` 拒绝，必须新 Mandate/attempt 和新证据；
5. Worker 的故障/切换不改变 Reviewer route、native standard 工具预设、只读 guard 或独立证据要求。

策略、预算、失败和切换历史随 RunState/SnapshotProof 恢复。该实现有自动化证据，但 super_route 的真实模型运行、故障适配和 GUI/原生读回仍待新验证，详见验证文档。

## 4. 核心数据与不变量

当前 `RunState.schemaVersion=2`；storageDomain 的 StoredRunRecord envelope 使用自身 schema/version，不应与早期草案中的编号混写。

| 对象 | 关键字段与职责 |
| --- | --- |
| Run | root sessionId、objective、definitionOfDone、status、currentAnchorId、revision、generation、gatePolicy、可选 modelPolicy |
| ModelPolicy / RouteFailure / RouteSwitch | 当前 Run 的 locked/balanced/economy/performance 策略、allowlist 与独立重试/切换预算；分类故障、授权切换历史与原因 |
| Obligation | 稳定 ID、requirement/prohibition/coverage、open/met/violated/waived/superseded、证据与显式 waiver |
| Anchor | version、supersedes/supersededBy、最新指令、DoD、约束、obligationSnapshot |
| WorkItem | 依赖、writeScopes、acceptance、obligationIds、gateProfile、mandatory、attempt、failureFingerprints |
| Mandate | 当前 anchor/generation/attempt、Worker/Reviewer、写域、验收、已知失败、原生 ID、needsStop、冻结角色 route/policyRevision/routeReason/routeSwitches |
| Evidence | kind、pass/fail/unknown、真实来源、receipt、当前 attempt/anchor/generation |
| GateDecision | Reviewer、结果、证据引用、原因、invalidated |
| AuditEvent | append-only、revision/generation、actor、payload 与诊断 changes |

关键不变量：

1. 依赖未 accepted，后继保持 held；未知依赖、依赖环和并行写域词法重叠在规划时拒绝。
2. 只有当前 Mandate、anchor、generation、attempt 可写；旧证据/决定不能放行新工作。
3. Worker 自报仅进入 reported_done；review 需要同一 Mandate 的 reported_done，release 还需 verifying 与当前 worker-done 审计前置。
4. Worker 与 Reviewer 不得相同或为 root/alias；Reviewer 写入会使决定失效。
5. `pass` 必须有所需类型和来源的有效证据；missing/timeout/unreadable/malformed/stale 均不能放行。
6. prohibition violated 不被其他 pass 抵消；open/partial/substitute/unknown coverage 无显式 waiver 不得 complete。
7. source/build/loaded hash 与宿主回执必须分别成立；restart-required/unmanaged 不等于 deployed。
8. 相同 failure fingerprint 或总 attempt 达到预算后拒绝下一普通 Mandate。
9. revision CAS + generation 阻止旧写覆盖恢复后的状态；证明/存储失败不会推进 live core。
10. core 只保证其契约边界，不把监管状态机宣传成全局权限沙箱。
11. 路由只属当前 Run；显式策略冻结进 Mandate，重试与切换分别受预算和 allowlist 限制，requested switch 后旧 Mandate 不能用于新证据/review/report 放行。

## 5. 状态机与义务传播

### 5.1 WorkItem / Mandate

```text
held → ready → mandated → running → reported_done → verifying → accepted
                   ▲                         │
                   └──── rework ←────────────┘
                              │
                       达预算 → blocked

用户纠正：受影响 WorkItem/Mandate → superseded；依赖后继传播失效。
恢复对账：无可靠原生回执的 running Mandate → unknown。
````

Run 状态为 `active | paused | blocked | needs_user | completed`。完成要求所有 mandatory WorkItem accepted、所有未豁免义务闭合，并重新通过总门。

### 5.2 Anchor 与 ObligationDelta

新用户指令通过 `add/amend/waive/supersede` 生成新 anchor：

- 只 supersede 直接引用变更义务的工作及依赖后继；
- 无关 Mandate 可继续绑定，不因换话题被全量取消；
- 未撤回的开放义务进入新 `obligationSnapshot`；
- waiver 必须显式、有理由、留审计，且只影响指定义务；
- 用户新增 scope 记为用户扩展，不误记为 Agent 自主跑偏，也不关闭旧覆盖义务；
- 运行中的外部 Agent 只标 `needsStop`，实际停止仍由 Host/原生控制面执行。

## 6. 证据模型与门禁

### 6.1 来源与新鲜度

证据分为 `build/unit/static/simulated/host_contract/runtime_gui/animation/hover/artifact/source_hash/build_hash/loaded_hash/host_receipt/numeric_reconcile/coverage/user_feedback`。

- `super_evidence observe` 读取真实原生 `sessionId + eventSeq`，由 Host 从事实推导结果并绑定 Host 来源；
- `record` 只能由绑定 Worker/Reviewer 提交，明确是 model-reported，不能铸造 hostObserved、host receipt/contract 或 authentic user feedback；
- 独立验收证据必须来自指定 Reviewer 或可信 Host 观测，Worker 自报不能自我放行；
- receipt 采用 allowlist、大小/嵌套/文本限制与敏感键拒绝；核心校验结构和引用，不把任意回执文本当作外部真实性证明。

### 6.2 三态与 GateProfile

`pass/fail/unknown` 是证据与门禁的共同三态。缺失、超时、格式错误、来源不符、过期和不支持均不能升级为 pass。

| GateProfile | 必要条件摘要 |
| --- | --- |
| code | build exitCode=0；unit failed=0、passed>0、计数一致；可选 hostContractRequired |
| visual | code 条件 + runtime_gui；义务声明 animation/其他 requiredEvidence 时还需对应动态证据 |
| deployment | source/build/loaded hash 一致，host receipt 为 applied/loaded 或 deployed=true |
| numeric_reconcile | 同范围双端实际 left/right 值，delta 可重算且一致 |
| coverage | 证据精确绑定 obligationId 或非空 sourceId；full 或显式用户 waiver 才可闭合 |

static/simulated、artifact_exists、message_emitted、公式存在、源码字符串存在都不能跨层替代 runtime/animation/hover/numeric 证据。

### 6.3 失败预算

默认 `maxAttempts=4`、`maxSameFingerprint=2`，创建 Run 时可设正整数。用户拒绝使用 fingerprint 归并，撤销当前 self-pass、重开义务并使相关依赖后继失效；达到预算后进入 blocked，禁止继续普通自动返工。恢复或新证据本身不自动重置预算，必须显式重签/重规划。

## 7. storageDomain + SnapshotProof

### 7.1 两层职责

- **storageDomain**：`super_agent_mode`、domain version 1、single layout、zod schema，保存 RunState 与 proof 指针，是业务检查点缓存；
- **原生 root Session proof**：每次成功写追加稳定内部 record `plugin:dsh-super-agent-mode/proof`（为兼容既有持久数据，故意不随包名更改），保存 canonical SHA-256、runId、revision、generation、nativeEventSeq，是快照完整性根；
- **AuditEvent.changes**：只作诊断与语义来源校验，不能代替外部 proof。

### 7.2 提交顺序

```text
Core mutation（尚未替换 live core）
  → canonical digest / appendPluginRecord
  → 检查真实 nativeEventSeq
  → sessions.flush 必须为 true
  → sessionQuery.readEvent + pluginRecordOf + schema + digest 读回
  → storageDomain.put
  → live core replacement
````

同一 root 的写通过 Promise queue 串行。proof/storage 等待期间 live core 暂时撤出，避免读到未证明的新状态。proof 或 storage 失败会 quarantine；storage 失败留下的 orphan proof 不算成功。恢复时先验证 proof，再调用 core 的公共 `restoreSnapshot`，Host 不重复 reconcile。

实现：[storage.ts](../src/host/storage.ts)、[proof.ts](../src/host/proof.ts)、[store.ts](../src/host/store.ts)、[digest.ts](../src/host/digest.ts)。

## 8. 恢复语义

恢复不是把缓存原样当成真相，而是“验证快照 + generation+1 + 原生回执对账”：

| 场景 | 恢复行为 |
| --- | --- |
| running 但无原生完成回执 | Mandate=unknown；显式 replan 后开新 attempt，旧 generation 写拒绝 |
| 原生 reported_done | 创建新 generation 的 recovery Mandate；允许重新审核，旧 evidence 保持历史且不可复用 |
| 历史 accepted | 按原 generation 重验证据/决定/门禁/worker-done 链，可合法 complete，也可显式 replan 重验 |
| 历史 completed | 验证最终 `run.completed` 审计后重开 active，再完成一次最终验收，绝不直接恢复 completed |
| 缺 proof、proof/digest 不符、协调篡改 state+audit | fail closed，不恢复、不提交 |
| 二次恢复 | 历史 Mandate/evidence 不变，新 recovery Mandate 使用新 ID/generation；反馈证据绑定原 Mandate generation |

inactive、missing、unreadable 或矛盾的 native 状态均为 unknown，不推断外部 Agent 已完成或已停止。

## 9. 客户端投影与一致性

`super_snapshot` 和只读 RPC 返回同一类 Host projection：监管 Run、anchors、obligations、workItems、mandates、evidence、decisions、audit、gates，以及原生 goal/Team/subagent、recovery、proof 和 blockReasons。

投影读取前后比较 revision/generation；读取期间变化则返回 `PROJECTION_CONCURRENT_CHANGE`，要求重试。proof 无效/不可用会进入 recovery/blockReasons，而不是被 UI 隐藏。

## 10. 软硬边界与威胁模型

### 当前实现内的硬门

- Core 状态迁移、依赖、证据引用/新鲜度、义务覆盖、失败预算、CAS/generation；
- 原生 root/descendant 身份绑定、Worker/Reviewer 分离；
- 绑定 Reviewer 的当前 standard preset 与 Host 工具只读 guard；
- 插件自身 `super_review release` 与 `super_run complete` 的证据门；
- SnapshotProof 的 append/flush/readback/digest 一致性、失败 quarantine 与恢复校验。

### 软纪律或需要额外宿主 seam

- Lead 不直接写实现、禁止其他 goal/命令入口完成、禁止最终回答绕门，需要更全局的 Host 控制；
- writeScopes 仅词法规划合同，不是文件系统 ACL/sandbox；
- `needsStop` 不等于外部 Agent 已被强制停止；
- 工具循环频率、模型/provider 路由健康、UI watchdog/quarantine、网络/发布权限仍属宿主；
- proof seam 是原生实验接口的当前适配，受声明的 DSH 版本范围约束；
- 不抵抗恶意 Host、恶意 OS、直接篡改原生日志或用户主动绕过整个插件。

所有不可证实的宿主行为应显示 unknown/未受控，不能因 core 测试通过而升级为全局硬保证。
