# Super Agent Mode · pure core

`SuperAgentCore` 是单 Run、内存态、宿主无关的监管状态机。核心只导入 `./types.ts`；不导入 Node/Cordis/React，不创建 Agent、不写文件、不执行 shell 或访问网络。

## 最小用法

```ts
import { SuperAgentCore } from "./index.ts";

let sequence = 0;
const core = new SuperAgentCore({
  createId: kind => kind + "-" + ++sequence,
  now: () => "2026-11-18T00:00:00.000Z"
});
const created = core.createRun({
  sessionId: "session-1",
  objective: "ship the contracted change",
  definitionOfDone: "all mandatory gates pass",
  obligations: []
});
```

ID 与 clock 必须注入。除 `createRun` / `evaluateGate` / `snapshot` 外，写操作都带 `expectedRevision` 与 `expectedGeneration`；generation 不匹配使用扩展错误码 `STALE_GENERATION`。每次成功写递增 revision 并追加一条 audit event；CAS/generation 失败或领域校验失败返回 `{ok:false,error}`，原状态与审计不变。返回状态为副本，调用方不能借此改写内部状态。

## API

- `createRun`：建立 Run、初始 Anchor 与 Obligation 账本。
- `applyUserInstruction`：生成新 Anchor；支持 obligation `add/amend/waive/supersede`。只 supersede 直接引用变更义务的 WorkItem 及其依赖后继；无关 Mandate 保持有效。运行中的外部 Agent 仅标 `needsStop`，实际停止由 host 执行。
- `planWorkItems`：校验未知依赖、环、空验收、未知义务与并行写域重叠；接受 superseded item 的显式重规划。
- `prepareMandate` / `bindExecution` / `bindReviewer` / `reportWorkerDone`：准备自包含委派文本、保存原生 Team/Worker/Reviewer ID 引用、接收 Worker 完成报告。Worker 报告只进入 `reported_done`；review 要求同一 Mandate=`reported_done`，release 要求同一 Mandate=`verifying` 且存在当前 worker-done 审计前置。
- `recordEvidence`：保存分型、分 attempt/anchor/generation 的结构化回执。`timeout/unreadable/malformed` 强制降级为 `unknown`。独立证据必须来自当前 Mandate 正式绑定的 Reviewer，或带 `hostObserved=true` 的可信 Host 观测；Worker 自报 coverage 不能放行。coverage obligation 可显式声明 `verification=mandate_delivery`，此时 receipt 必须具有相同 verification 且由 Host 观测，不能用一次普通投递闭合无关义务。
- `submitReview`：校验指定独立 Reviewer、Reviewer 只读、证据引用与当前 attempt；`fail/unknown` 可记录但不能放行。
- `evaluateGate`：只读计算 `pass/fail/unknown`、缺失证据、违反义务、过期证据与原因。
- `releaseWorkItem`：唯一 `accepted` 入口；重验 Reviewer 只读和完整门禁，再解锁依赖已满足的后继。
- `recordUserFeedback`：用户拒绝使当前 attempt 永久不可重放，撤销传递依赖后继、重开相关义务并进入 rework/blocked；同 fingerprint 达到预算后拒绝下一 Mandate。用户接受只留审计，不替代技术证据。
- `completeRun`：要求未豁免义务均 met、mandatory items 均 accepted 且重验总门。
- `restoreSnapshot(snapshot, nativeReceipts?)`：仅限空实例；校验 `schemaVersion=2`、全部引用、CAS、append-only audit 及 accepted 的 decision→evidence→gate/worker-done 链，随后 generation+1 并立即按原生回执对账。无回执 running 变为 `unknown`，可显式 replan 后开新 attempt；最新 Decision=unknown 的 verifying/verifying，或 pass 后新增反证使当前门禁不再 pass，也可同合同显式 replan。原生 reported_done 回执授权新 generation 审核，但旧 evidence 不可复用。合法历史 accepted 按原 generation 重验并可 complete，也可显式 replan 重验。completed 快照必须有最终 `run.completed` 审计，恢复后一律进入 active 做最终验收，绝不直接 completed。
- `setModelPolicy`：在当前 Run 设置精确允许池、Worker/Reviewer 路由和独立重试/切换预算；locked 模式要求非空池及显式双角色路由。
- `recordRouteFailure`：记录显式模型故障分类；`targetRole` 缺省 worker，可按 reviewer 分别记录实际路由和预算。业务验收、身份、proof、写域、工具参数、认证/权限和 unknown 不自动重试或切换。
- `switchMandateRoute`：要求 allowFailureSwitch、授权目标、可切换故障记录及剩余预算；追加不可变 RouteSwitch 审计。新执行成果仍须新 Mandate/attempt 和新证据；Reviewer 的 native standard 工具预设不变。
- `pauseRun` / `resumeRun` / `reconcileRecovery`：暂停/恢复；显式恢复对账同样递增 generation，旧 generation 的 Mandate 写操作全部拒绝。

## Gate receipt 约定

- `code`：build + unit；build 必须 `exitCode=0`，unit 必须 `failed=0`、`passed>0`，可选 total 必须等于 passed+failed；缺字段/矛盾不放行。`hostContractRequired=true` 时另需 host_contract。
- `visual`：code 条件 + runtime_gui；义务声明 `requiredEvidence` 或 `animation` 时另需对应动态证据。static/simulated 不替代 runtime/animation/hover。
- 动画：`{obligationId, mode}`，mode 必须与义务声明（如 `clockwise_sweep`）一致。
- 禁止项：`{obligationId, violated:true}` 使总门 fail。
- `deployment`：source_hash/build_hash/loaded_hash 的 `hash` 必须一致；host_receipt 须为 `application=applied|loaded` 或 `deployed=true`。`restart-required/unmanaged` 拒绝放行。
- `numeric_reconcile`：`leftValue/rightValue/leftScope/rightScope` 必须是同范围双端实际值；可选 `delta` 会被重算。
- `coverage`：每条 coverage 证据必须以 `obligationId` 精确关联，或以双方非空 `sourceId` 精确关联；只有 `coverage=full` 或显式用户 waiver 可闭合。

Receipt 有大小/嵌套/文本上限，规范化拒绝 token/cookie/auth/session/private-key 等敏感键变体与无关正文。Reviewer 的未知 operation 一律按 mutation 拒绝。核心只验证结构与引用，不验证外部回执内容本身的真实性。

## 测试与已知边界

```sh
node --test dsh-super-agent-mode/test/core/lifecycle.test.ts dsh-super-agent-mode/test/core/gates.test.ts dsh-super-agent-mode/test/core/security.test.ts dsh-super-agent-mode/test/core/recovery.test.ts
```

无策略时 Mandate 的 workerRoute/reviewerRoute 均为 null（继承原生模型池），policyRevision=0，既有监管行为不变。生产 `CoreDrivers` 和构造器没有硬门开关。门禁删除 mutation 仅存在于 `test/core/helpers.ts` 的测试子类；每个负向用例同时证明原断言失效且 mutation 操作成功。

- 当前实例只保存一个 Run；原子持久化与多 Run 路由由 host adapter 负责。快照通过 `restoreSnapshot` 深校验并恢复。
- WorkItem 是监管投影，不复制原生 Team 执行状态；原生 ID 只是引用。
- writeScopes 是词法重叠检查与规划合同，不是文件系统权限锁。
- 恢复后 `unknown` Mandate 保留历史，显式 replan 清除其 current 绑定并允许新 attempt；核心不会推断外部 Agent 已停止或已完成。
- 全局 Lead 写文件、其他 goal 完成入口、发布/网络权限等仍需宿主 seam，core 不宣称全局沙箱。真实 actor 认证、Reviewer 工具只读和 hostObserved 签发由 host 强制执行。
