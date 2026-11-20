# SuperAgent PTC

[![English](https://img.shields.io/badge/English-current-blue)](README.en.md) [![Chinese](https://img.shields.io/badge/Chinese-README-red)](README.md)

[![npm version](https://img.shields.io/npm/v/dsh-superagent-ptc?color=cb3837)](https://www.npmjs.com/package/dsh-superagent-ptc)
[![npm downloads](https://img.shields.io/npm/dm/dsh-superagent-ptc?color=blue)](https://www.npmjs.com/package/dsh-superagent-ptc)
[![license MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.5-6f42c1)](https://github.com/deepseek-ai/deepseek-harness)
[![tests](https://img.shields.io/badge/tests-176%2F176-brightgreen)](docs/VALIDATION.md)

> **Long-task supervision layer for DeepSeek Harness** — versioned anchors, bounded delegation, independent acceptance, evidence-gated release.

SuperAgent PTC turns "the agent says it is done" into "an independent reviewer proved it is done". It is a **preset-first** plugin: it adds a supervision plane on top of the native PTC / Agent / Goal / Teams runtime instead of building a second agent loop, task board or router.

```
You:  split this research into three items, accept each one, then write the summary
PTC:  Run + Anchor  ->  Mandate per item  ->  standard Reviewer verifies independently
      ->  gate passes  ->  super_snapshot returns revision and proof
```

![Layered architecture](docs/images/en/architecture-layers.png)

## Contents

- [Why](#why-superagent-ptc)
- [Features](#features)
- [Dual-layer architecture](#dual-layer-architecture)
- [Supervision loop](#supervision-loop)
- [Install](#install)
- [Quick start](#quick-start)
- [Tools](#tools)
- [Right panel](#right-panel)
- [Evidence gates and boundaries](#evidence-gates-and-boundaries)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [FAQ](#faq)
- [Development](#development)
- [Acknowledgements](#acknowledgements)
- [License](#license)

## Why SuperAgent PTC

Long tasks rarely fail because the model cannot write code. They fail because four things stay unconstrained:

| Problem | Consequence | What SuperAgent PTC does |
| --- | --- | --- |
| The goal drifts across a long conversation | Half the work targets the wrong thing | **Versioned Anchor**: objective, DoD and obligations have versions; corrections explicitly invalidate affected work |
| The agent declares itself done | "Done" without verification | `reported_done != accepted`: an independent Reviewer and an evidence gate must pass first |
| Delegation has no boundary | Workers overreach or duplicate effort | **Mandate contract**: work item, write scope, model route and attempt count are frozen at prepare time |
| Crash leaves an unknown state | You cannot tell what is trustworthy | **SnapshotProof + RunState v2**: write the native proof, then storage, then swap the live core |

## Features

- **Preset-first**: one agent preset (`SuperAgent PTC`) alongside Standard, Creative, PTC and Minimal; it does not change default models, permissions or other sessions.
- **Seven supervision tools**: `super_run`, `super_anchor`, `super_mandate`, `super_evidence`, `super_review`, `super_route`, `super_snapshot`, all called through PTC `run_code` instead of adding new script tools.
- **Native identity binding**: Worker and Reviewer are real native subagents; the Host wakes a bound Reviewer through native `sendMessage`, so the Lead can never play the Reviewer.
- **Independent read-only review**: the Reviewer must use the native `standard` preset; the guard fails closed on writes and unknown shell operations, while `pwsh` read commands (including `$env:` reads) are classified by their actual arguments.
- **Typed evidence gates**: evidence is `pass / fail / unknown` only; `unknown` never releases; build logs, unit tests and screenshots cannot replace runtime evidence.
- **Failure budgets and recoverable audit**: the same fingerprint reaching its budget blocks the run; `super_run recover` increases the generation and keeps the full audit trail.
- **Client visualization**: a right-side supervision panel and a composer entry over a read-only projection.
- **No global side effects**: ordinary sessions get no `super_*` tools, no prompt section and no panel.

### What it deliberately does not do

| Not doing | Reason |
| --- | --- |
| Rebuilding an agent loop, task board or global router | Native Session, Agent, Goal and Teams remain the execution authority |
| Providing an OS-level file permission sandbox | Write scopes are a coordination contract, not kernel isolation |
| Automatic model downgrade | Only explicit, allowlisted, budgeted bounded failover is supported |
| Treating `reported_done` as acceptance | Only an independent Reviewer plus the evidence gate produces `accepted` |

## Dual-layer architecture

**One-sentence positioning**: SuperAgent PTC layers a supervision state machine (`Run -> Anchor -> Mandate -> Evidence -> Decision`) on top of the native Agent/Session mechanism, binds native agent sessions into that chain by role (Lead / Worker / Reviewer), and treats the **native PTC event chain** (`run_code` calls and tool receipts) as the **evidence substrate** of the whole chain. The supervision layer never produces a second event stream.

The supervision plane only answers "may this ship"; the execution plane only answers "what actually happened". Between them sits a single contract membrane: `super_*` tools are the only writer of state and evidence.

![Dual-layer architecture](docs/images/en/architecture-dual.png)

- **A Supervision plane**: the Lead maintains the Anchor and the obligation ledger; a Mandate freezes work item, write scope, route and attempt; evidence gates and budgets decide release.
- **Contract membrane**: every state change must pass the `super_*` CAS check; there is no second write path between the planes.
- **B Execution plane**: PTC `run_code` orchestrates host tools, native `subagent` creates Worker and Reviewer, and receipts come back as `reported_done` plus tool results.
- **Shared foundation**: the native runtime supplies identity, lifecycle and proof; `storageDomain RunState v2` and `SnapshotProof` make the run recoverable.

## Supervision loop

![Supervision loop](docs/images/en/lifecycle.png)

```text
super_run create            # objective + definition of done + gate policy
super_run plan              # work items / dependencies / obligations (open ledger)
super_anchor                # versioned anchor; corrections invalidate affected work
super_mandate prepare       # freeze work item, write scope, model route, attempt
super_mandate bind          # bind the native Worker SessionId
super_mandate bindReviewer  # bind a standard Reviewer and wake it natively
super_evidence record       # typed, traceable evidence
super_review evaluate       # gate evaluation
super_review decide/release # release only when the gate passes
super_snapshot              # read-only check of revision / generation / proof
```

## Install

Requires DSH `>=0.2.2-rc.3 <0.3.0-0` and Node `^22.19.0 || >=24`.

```bash
# install from npm into the current profile
dsh plugin --profile desktop add dsh-superagent-ptc
```

Restart DSH completely after installing, then create a session and pick **SuperAgent PTC** in the preset selector.

### Install through the DSH plugin market index

In DSH -> Settings -> Plugins -> Discover, add this index URL and search for `SuperAgent PTC`:

```text
https://raw.githubusercontent.com/BioAIEvolu/dsh-superagent-ptc/main/market-index.json
```

The index passes the official `parseMarketIndex` validation and resolves to the current npm release shown in the badge above.

### Local development install

```bash
git clone https://github.com/BioAIEvolu/dsh-superagent-ptc.git
dsh plugin --profile desktop add link:/absolute/path/to/dsh-superagent-ptc
```

## Quick start

1. Create a session and choose the **SuperAgent PTC** preset.
2. Describe the objective and the definition of done, for example:

```text
Use SuperAgent PTC for a minimal supervision loop:
super_run create a Run; plan two work items, W1 reads the README and lists 3 points, W2 depends on W1 and stays held this phase;
let the Worker inherit super-agent and the Reviewer use agent_preset=standard;
after prepare/bind/bindReviewer, the Reviewer records coverage evidence and runs evaluate/decide/release;
finally call super_snapshot and report the real Run/WorkItem/Mandate/Evidence/Decision IDs plus revision/generation/proof.
```

3. Click **Super Agent supervision** above the composer; the right panel shows the live run and audit timeline.

## Tools

| Tool | Actions | Notes |
| --- | --- | --- |
| `super_run` | `create` `plan` `show` `recover` `complete` | Run lifecycle; `recover` increases the generation and re-reconciles |
| `super_anchor` | `show` `apply` `history` | Versioned anchors; corrections explicitly invalidate affected work |
| `super_mandate` | `prepare` `bind` `bindReviewer` `report` `show` | Delegation contract and native SessionId binding |
| `super_evidence` | `record` `observe` `list` | Typed evidence with write-scope and source-role checks |
| `super_review` | `evaluate` `decide` `release` | Independent acceptance and release |
| `super_route` | `show` `set` `inspect` `switch` | Model policy for the current run with bounded failover |
| `super_snapshot` | `{}` | Read-only check of Run / gate / proof / recovery |

Every write action carries `expectedRevision` and `expectedGeneration`; conflicts are rejected instead of silently overwritten.

## Right panel

![Right panel](docs/images/en/panel-mockup.png)

- The panel is a **read-only projection**: objective/Anchor, model policy and routing audit, work items, Mandate, evidence and gates, audit timeline, agenda/attempt.
- It never writes state; only `super_*` tools can change state, through the Host CAS check.
- The composer entry never blocks input and is invisible in ordinary sessions.

## Evidence gates and boundaries

| Rule | Behavior |
| --- | --- |
| Three evidence states | Only `pass` may release; `fail` blocks; `unknown` is never treated as success |
| Source roles | Evidence must come from an allowed role and write scope; evidence reused across items is marked stale |
| Reviewer read-only | Writes, unknown shell commands and privilege escalation fail closed; read commands are classified by arguments |
| Commit order | `SnapshotProof` -> `storageDomain` -> live core; any failed step aborts |
| Recovery | `recover` increases the generation and old evidence is not reused; only the root Lead may clear quarantine |
| Sandbox scope | This plugin does not provide an OS-level file sandbox; write scopes are a coordination contract |
| Trust boundary | SnapshotProof relies on the native session log and does not defend against a malicious host or direct log tampering |

## Compatibility

| Item | Value |
| --- | --- |
| DSH | `>=0.2.2-rc.3 <0.3.0-0` (development baseline `0.2.2-rc.5`) |
| Node | `^22.19.0 || >=24.0.0` |
| Host peers | `dsh-session`, `dsh-storage-domain`, `dsh-tools`, `react` |
| Client | web surface; `@deepseek-ai/dsh-client-connection`, `ui-conversation`, `ui-sidebar-right`, `ui-subagent` |

## Verification

- Automation: **176 / 176 pass**; `typecheck` and `build` both exit 0.
- Real desktop runs: two independent Electron sessions completed supervision loops, including recovery across generations, repeated Anchor revisions, independent Reviewer release and SnapshotProof agreement.
- Fixes recorded: the Reviewer read-only guard once classified `pwsh "$env:NAME"` as a write; it now classifies by arguments and has regression tests.
- Details: [docs/VALIDATION.md](docs/VALIDATION.md).

### Known unknown

- Live provider-failure failover, budget-exhaustion blocking and `model.select` failure branches have never occurred on real hardware and remain unknown.
- No OS-level file sandbox; no security boundary beyond session isolation.

## FAQ

**I selected the preset but there are no `super_*` tools.**
Only `super-agent` sessions and a verified, bound read-only Reviewer receive the tools. Confirm the preset actually switched and restart DSH completely.

**The Reviewer cannot decide.**
Read the gate response: `missingEvidence` / `staleEvidence` means you need new evidence; `REVIEWER_NOT_READONLY` means the Reviewer produced a write receipt and must be replaced by a fresh read-only Reviewer.

**How do I recover after a crash?**
The root Lead calls `super_run recover`; the generation increases, old evidence is not reused, and new evidence must be collected in the new generation.

**Can it act as a global router or automatic downgrade?**
No. `super_route` only manages an explicit policy for the current run; there is no out-of-the-box global auto-router.

## Development

```bash
pnpm install
pnpm typecheck && pnpm build && pnpm test
```

- Layout: `src/core` (pure state machine, no Host dependency), `src/host` (tools, guard, routing, storage), `src/client` (panel and entry), `test/`.
- Keep `typecheck`, `build` and `test` green; core state-machine changes need positive and negative cases.
- Issues and PRs: https://github.com/BioAIEvolu/dsh-superagent-ptc/issues

## Acknowledgements

This plugin did not appear from thin air. It grew out of a real group discussion and source share on 2026-11-17:

- **CC**, a community member, shared the `dsh-plugin-antidrift` plugin source and real long-run experience (setting a long-term `/goal`, a single run lasting 30+ hours, ten agents writing in parallel). We only read the source for forensics — it was never installed, executed or copied — and its "anchor + delegation + audit" framing was an early inspiration.
- **An** proposed deploying several instructions at once with a small audit every few steps, which maps directly to the work item / evidence gate / failure budget trade-off here.
- **Electron** read this shape as an extension of PTC, which pushed us to state that PTC only exposes `run_code` and that supervision must sit on its native event chain.
- **KOLA 2** proposed polling progress and releasing the next instruction plus audit on completion, and the "main router controlling workers" SuperAgent idea; these shaped Mandate unlock semantics and the Lead/Worker/Reviewer split.

Thanks also to upstream `zouyuanqing/dsh-super-ptc-mode` (MIT): we referenced its thin preset composition and Lead delegation doctrine, then rewrote the persona and composition for the current DSH contract. License and provenance are preserved in [NOTICE.md](NOTICE.md).

And thanks to everyone who kept discussing, asking and correcting in that group — those conversations turned "evidence-gated release" from a slogan into a state machine.

## License

MIT, see [LICENSE](LICENSE). Upstream DSH component notices are recorded in [NOTICE.md](NOTICE.md).
