# SuperAgent PTC 验证记录

本文是面向使用者的验证摘要：说明当前版本实测了什么、证据在哪一层、以及哪些效果仍未发生。内部审计原件不随包发布。

## 1. 当前结论

- 自动化：`pnpm test` **176 / 176 pass**，`pnpm run typecheck` 与 `pnpm build` 均 **exit 0**。
- 桌面真实链路：在 Electron 版 DSH 中完成两个独立监督 Run，包含跨代恢复（generation 1→4）、多次 Anchor 修订、独立 Reviewer 放行与 SnapshotProof 校验。
- 发布形态：npm 公开包 + GitHub 仓库 + DSH 插件市场索引。

## 2. 自动化覆盖

| 范围 | 覆盖要点 |
| --- | --- |
| `src/core` 状态机 | CAS 冲突、anchor 版本化与失效传播、义务账本、Mandate 生命周期、证据三态、决策与放行、失败预算、recover 增代、旧证据拒绝 |
| `src/host` | 七个工具注册与 canonical 输出、原生 SessionId 绑定、Reviewer 预设校验与只读 guard、路由策略与有界切换、存储与 SnapshotProof 提交序、RPC 投影 |
| `src/client` | 投影 DTO 三态、空态渲染、slot 生命周期、composer 入口与预设隔离 |
| 契约 | 包身份/导出/files/engines、preset 唯一性、Host 全局行、客户端构建产物、许可与 NOTICE |

每个关键负向用例都要求"删除对应门禁后测试必须失败"，不允许用跳过门禁的开关冒充通过。

## 3. 桌面真实验收

两个独立会话，均由 Lead 真实调用工具、由独立 standard Reviewer 做出决定：

| 项 | 会话 A | 会话 B |
| --- | --- | --- |
| 目的 | 最小监管闭环 + 多轮迭代 | 只读 shell 分类修复复验 |
| Run 终态 | revision 65 / generation 4 | revision 11 / generation 1 |
| 恢复次数 | 3（generation 1→4） | 0 |
| Anchor 版本 | 10 | 1 |
| 工作项 | W1、W4、W5、W6 accepted；W3 superseded；W2 未派发 | W1 accepted（attempt 1） |
| Decision | 4 次 `pass`，均未失效 | 1 次 `pass` |
| Proof | 与原生会话日志逐条对齐 | 与原生会话日志逐条对齐 |

两次验收都确认：`reported_done` 不会自动变成 `accepted`；Reviewer 的 `super_snapshot → 只读核验 → super_evidence → evaluate/decide/release` 是真实工具调用，而不是 Lead 代写。

### 3.1 发现并修复的缺陷

Reviewer 执行纯读取命令 `pwsh "$env:NAME"` 时，旧版 shell 分类器把首个 token 当作未知可执行文件，误判为 `write`，导致 `super_review decide` 返回 `REVIEWER_NOT_READONLY`。

修复：新增只读环境变量白名单（`$env:NAME`、`Write-Output $env:NAME`、`echo $env:NAME`、`Get-Item env:NAME`、`Get-ChildItem env:`、`Get-Variable NAME`），并把该判定放到危险命令名启发式之前；仍拒绝分号、管道、重定向、命令替换、赋值与危险动词。

复验：同一桌面环境下，Reviewer 真实执行 `pwsh "$env:NAME"` 后，`super_evidence`、`evaluate`、`decide`、`release` 全部返回 `ok=true`，W1 一次通过，proof 与原生记录一致。

## 4. 未覆盖与边界

| 项 | 状态 |
| --- | --- |
| 真实 provider 故障 → 自动切换 | 未在实机发生，unknown；仅单元测试覆盖 |
| 预算耗尽 → blocked | 未在实机发生，unknown |
| 原生 `model.select` 成功/失败/读回不符 | 未在实机发生，unknown |
| 全局文件权限沙箱 | 不提供；写域是协作契约，不是 OS 级隔离 |
| 恶意宿主 / 直接篡改原生日志 | SnapshotProof 不防御该类攻击 |
| `complete` 收尾动作 | 桌面 Run 仍为 active（W2 未派发），未执行 complete |

## 5. 复现方式

```bash
pnpm install
pnpm typecheck && pnpm build && pnpm test
```

桌面复现：安装插件 → 完全重启 DSH → 新建会话选择 `SuperAgent PTC` → 按 [README](../README.md) 的监管闭环示例执行，最后用 `super_snapshot` 核对 revision / generation / proof。
