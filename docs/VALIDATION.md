# SuperAgent PTC 验证记录

本文是面向使用者的验证摘要：区分历史实现证据、本轮监管修复和真实运行边界。历史会话中的测试计数不自动视为当前工作树结果。

## 1. 当前状态（2026-11-25）

- 当前工作树包含 A 的六条 Worker 执行契约，以及一组监管修复：同合同重规划、用户授权的合同修订、原生交付核验、Reviewer 完成后唤醒和只读守卫兼容。
- **独立对抗性审查已确认原 P0/P1 全部关闭；当前 214/214 为自动化回执，隔离真实链和原 A 放行仍按第 6–7 节单独验收。**
- 本轮完整自动化、隔离真实链和原 A 放行结果以第 5–7 节为准；未填写的项目不得从历史记录推断为通过。
- B dispatch 未实施；版本号、npm/GitHub 发布和市场索引未因本轮修改而变化。

## 2. 历史实现与自动化证据

2026-11-22 的 A 实现曾取得：

| 检查 | 历史结果 |
| --- | --- |
| 聚焦 core/preset 契约 | 25/25 |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | 178/178 |
| `pnpm build` | exit 0；Host 与 Client 构建完成 |

这些是当时工作树的本机回执，不是独立 Reviewer 验收，也不是当前监管修复包的测试结果。六条 Worker 契约和 Lead 原样转发纪律保留在当前源码中。

## 3. 历史桌面真实验收

早期两个独立 Electron 会话完成了真实监管回路，包含跨代恢复、Anchor 修订、独立 standard Reviewer 放行和 SnapshotProof 对齐：

| 项 | 会话 A | 会话 B |
| --- | --- | --- |
| Run 终态 | revision 65 / generation 4 | revision 11 / generation 1 |
| 恢复次数 | 3 | 0 |
| 工作项 | W1、W4、W5、W6 accepted；W3 superseded；W2 未派发 | W1 accepted |
| Decision | 4 次有效 pass | 1 次 pass |
| Proof | 与原生日志对齐 | 与原生日志对齐 |

当时还修复了 Reviewer 执行只读 `$env:NAME` 被误判为写操作的问题；当前守卫继续按实际操作分类，写操作、索引重建和 `run_code` 不允许。

## 4. A 阶段历史对照与未决原因

2026-11-22 的隔离对照修正了测试夹具并固定请求路由：

| 场景 | 基线 | A |
| --- | --- | --- |
| 待命后开工、独立验收 | accepted | accepted |
| 只报告已有结果 | accepted | accepted |
| 过期指令 | 未写目标文件、旧 Mandate 失效 | 未写目标文件、旧 Mandate 失效；独立 Reviewer 未观测原生 `MANDATE_STALE` 回执 |

这些是小样本观察，不证明 A 在所有长任务上优于基线，也不构成启动 B dispatch 的依据。

主 Run 的原工作项 A 在最后可核对记录中仍为 `verifying`，未 accepted。后续源码复核发现：

- `unknown` 决定后，双方进入 `verifying`，再次 decide 与 release 的条件形成死端；
- 恢复重规划没有覆盖 `verifying/verifying` 与旧 generation 的组合；
- 通用 `host_contract` 没有直接证明六条契约、原样转发或三个行为场景；
- PTC 与普通工具回执结构不同，通用 `result=pass` 不能证明真实交付。

原始对照保存在 `.artifacts/execution-contract-ab/`（工作区级审计材料，不随 npm 包发布）。

## 5. 本轮监管修复范围与验证矩阵

### 5.1 实现范围

- `unknown` 后可按同合同显式 replan，新 attempt 重新取证；所有合同字段保持不变。
- `workItemRevisions` 允许经用户明确授权创建新 Anchor、修订合同并使旧 Mandate/决定失效，accepted 或当前门禁仍为 pass 不得借此绕过验收；未列入批准的下游合同不得顺带修改。
- coverage 即使未声明 `requiredEvidence`，也只接受当前正式 Reviewer 或可信 Host；`verification=mandate_delivery` 义务还要求专用 verification 与 hostObserved，普通投递不能闭合无关行为义务。
- `hostContractRequired` 可由同一专用 `mandate_delivery` Host 核验生产 `host_contract`；缺失/矛盾证据仍为 unknown/fail，不能恢复 shell 自报 pass。
- pass 后新增反证使当前门禁不再 pass 时，允许同合同重规划；当前门禁仍为 pass 时仍不得绕验收。
- `super_evidence verify` 的 `mandate_delivery` 直接核对 Lead 实发与 Worker 实收，生成带真实引用的 host-observed coverage。
- 普通 `tool/result` 与 PTC `tool/ptc-dispatch` 正文均可提取；通用 shell `pass` 不再用于 coverage/host_contract。
- Reviewer 可以提前创建待命，但只有在 Worker `reported_done` 后才能 bindReviewer 并唤醒。

### 5.2 自动化回执

| 范围 | 当前结果 |
| --- | --- |
| Core 全套 | **87/87 pass**（2026-11-25，bundled Node） |
| Host 全套 | **90/90 pass**（2026-11-25，含 PTC 实发/实收、`agent/inbox/spliced`、Reviewer 写入恢复、结果回执与负向路径） |
| Preset 合同 | **12/12 pass**（2026-11-25） |
| TypeScript typecheck | **exit 0**（2026-11-25） |
| 完整测试 | **214/214 pass**（2026-11-25） |
| 构建 | **exit 0**；`lib/host.mjs` 219.34 kB，Client bundle 重建 |

### 5.3 必测负向路径

- `unknown → 同合同 replan → 新证据 → pass → release`；旧证据不得复用。
- 修改 title/dependencies/writeScopes/acceptance/obligationIds/gateProfile/hostContractRequired/mandatory 任一字段，不得走同合同重规划。
- accepted 或已有有效 pass 不得通过 `workItemRevisions` 被替换。
- 缺失消息为 unknown；错 Worker、错发送者、错 Mandate/动作为 fail；bare tool/call 意图不等于实发成功。
- shell 打印的 `result=pass` 不得铸造 coverage/host_contract；verify 自身回执不得被再次 observe。
- Reviewer 在 prepared/running 阶段不得绑定或唤醒；只读目录导航允许，写操作和索引重建拒绝。
- Reviewer 在 pass 后产生原生写回执：release 拒绝且当前 gate=pass 时直接 replan/revise 拒绝；必须 `recover` 增代 → 同合同 replan → 新 Reviewer、新 attempt、新证据 → accepted。

## 6. 隔离真实链与 GUI 验证

### 6.1 最小真实监管链（已完成）

隔离 `super-agent-live` profile、真实 `ark-agent-plan/glm-5.3-flash/high` 路由的独立会话（run `run_1b186a1c…`）已跑通：

- W1 在 attempt 2 由独立 native standard Reviewer 放行，Decision=`decision_9c3830a0…`；W2 仅从 held 变 ready，未执行，未创建 result.md。
- `super_evidence verify(verification=mandate_delivery, kind=coverage)` 核对 Lead 实发与 Worker 实收，生成 host-observed `coverage/full`，包含真实事件引用。
- Reviewer 独立读取 fixture 并登记独立 coverage；两条 coverage 义务均为 met。
- 最终 Run=`run_1b186a1c…`，revision 18 / generation 1，SnapshotProof verified。
- 初次 fixture 尚未出现在预期路径时，Worker 如实报告缺失，没有伪造证据；补夹具后继续。首个 Reviewer 在正式绑定前做了额外只读核验，被守卫拒绝；同合同重规划、换 Reviewer、重新取证后放行。这验证了守卫与恢复路径，不作为失败被掩盖。

证据目录：`.artifacts/superagent-ptc-recovery/live-minimal/`（Host 投影、原生会话、GUI 截图）。

### 6.2 合同修订恢复链与行为场景

#### 合同修订恢复链（已完成）

同一隔离 Run 中的 R 已按真实流程完成：attempt 1 的 evaluate 为 `unknown`（缺 build/unit/host_contract），随后经用户批准的 `workItemRevisions` 创建 Anchor v3，将通用 host flag 替换为 `delivery-proof` 的专用 `verification=mandate_delivery` coverage 义务；新 attempt 重新投递、Worker report、独立 Reviewer 核验后放行。

- 当前 Mandate=`mandate_d8172423…`，attempt 2。
- Host 核验证据=`evidence_1ad04d11…`：真实 Lead `tool/ptc-dispatch` 与 Worker `agent/inbox/spliced` 对齐，`coverage=full`、`verification=mandate_delivery`、`hostObserved=true`。
- 独立 Reviewer=`62cfff03…`，Decision=`decision_87a6f229…`，R accepted。
- 最终 revision 32 / generation 1，SnapshotProof verified。

首次提交 unknown 时，Reviewer 的结果消息被守卫误报为写操作；已通过本机原生事件定位并修复“结果叙述”与“文件指令”的分类，新增回归后恢复执行。未知/失败过程没有被改写为已通过。

#### 行为场景（已完成）

S1 待命后开工、S2 只报告已有结果、S3 旧指令失效均由独立 native standard Reviewer 放行。S3 对旧 Mandate 的 report 被真实 `MANDATE_STALE` 拒绝，旧指令没有驱动写入，新 attempt 重新取证后 accepted。最终 Run revision 73 / generation 2，SnapshotProof verified（nativeEventSeq=1121）；W1/R/S1/S2/S3 均 accepted，W2 保持 ready 且未执行。证据：`.artifacts/superagent-ptc-recovery/live-minimal/host-projection-behaviors-final.json`、原生 SessionGraph 记录和 GUI 截图。

Worker 的实际模型路由未始终可读，按治理要求保留 unknown；Reviewer 的已读回路由为 ark-agent-plan/glm-5.3-flash/high。小样本场景不证明所有长任务都能防漂移。

继续执行并记录真实 Run、Worker/Reviewer、路由、Decision、proof 和截图：

1. 创建前查询授权模型路由，Worker 显式选择；Reviewer 使用 `agent_preset=standard`；创建后读回实际路由，不可读标 unknown。
2. 验证待命开工、只报告已有结果、旧指令失效。
3. 验证 `unknown` 后同合同重规划、合同修订留痕、独立 Reviewer 放行。
4. 核对 GUI 中历史/当前 attempt、证据、决定和 SnapshotProof；不使用演示数据。

当前结果：**隔离真实链已完成，详见上文。**

## 7. 原工作项 A 的恢复边界

原 A 的完成标志是：在创建原 Run 的原始 Lead 会话中，按用户批准的合同创建新 Anchor，在原工作项 A 上重新取证，并由独立 standard Reviewer 正式 release，随后 proof 校验通过。

A2 是后来创建的重复验证工作项，不能替代 A；A2、其他开放义务和整个 Run 的 completed 状态属于后续收尾，不混入“A 已 accepted”的判断。

当前结果（2026-11-27）：**原 A 已 accepted。** Anchor v8、attempt 3，Mandate `mandate_1d7a5dfd…`，独立 native standard Reviewer（`47fb59a2…`，路由 kimi-coding/k3.1-pro）Decision `decision_0774d7d9…` result=pass；`a-delivery` 与 unit/build 由 Host 观测（hostObserved=true），`a-standby`/`a-report-only`/`a-stale` 由 Reviewer 独立登记 pass。Run revision 66 / generation 4，SnapshotProof verified。attempt 1 的 unknown Decision 与 superseded 历史原样保留。A2 与 Run 的 completed 收尾不在本节范围。

## 8. 复现与未覆盖边界

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm build
```

- 真实 provider 故障自动切换、预算耗尽、原生 `model.select` 的部分失败分支仍未在实机全部发生，保持 unknown。
- 写域是协作合同，不是 OS 级文件沙箱。
- SnapshotProof 不防御恶意宿主或直接篡改原生日志。
- 历史 A/B 小样本不证明长期防漂移效果；需要持续观察真实长任务的首动、越界、自验、交接遗漏和返工率。
