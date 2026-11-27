# Changelog

## [0.1.11] - 2026-11-27

### Fixed

- The `mandateText` Worker execution contract now matches the approved design clause by clause. 0.1.10 wrote the six rule headings but shortened three rules while implementing:
  - Read-before-edit now also requires matching the existing style of the surrounding code and not refactoring unrelated code.
  - The write-scope rule now says to finish the in-scope part that can be delivered on its own and report the rest to the Lead instead of expanding scope.
  - The reporting rule now requires the final answer and any message to the Lead to carry the result and the evidence themselves, because the completion notice omits the final answer when the Worker messages the Lead just before finishing.
- The no-silent-rerouting rule states that local implementation choices are allowed, and graded ambiguity reports `NEEDS_LEAD_DECISION` for ambiguity that affects the objective, acceptance, security, public interfaces, write scopes or irreversible actions.

### Changed

- The core contract test asserts every sub-clause on its own rule line, so a shortened rule now fails the test instead of passing on its heading.
- Bilingual README and the architecture doc list the full six rules.

### Docs

- Internal ids in `docs/VALIDATION.md` use 8-character prefixes instead of full identifiers.

### Validation

- 2026-11-27: `pnpm run typecheck` exit 0; complete `pnpm test` **214/214 pass** (Core 87, Host 90, Preset 12, Client 25); `pnpm run build` exit 0 with `lib/host.mjs` 221.17 kB and the Client bundle rebuilt. The rebuilt `lib/host.mjs` contains every added clause.
- Negative check: with the 0.1.10 contract text temporarily restored in `src/core/core.ts`, the updated core contract test fails on the first missing clause; it passes again once the fix is back.
- The rules remain a core-generated message contract. This release changes text only: no state machine, persona, tool surface or persistence change, and no new live behaviour validation.
- DSH kernel requirement unchanged at the validated baseline `>=0.2.2-rc.5 <0.3.0-0`.

## [0.1.10] - 2026-11-27

### Added

- `prepareMandate` now includes six Worker execution rules in `mandateText`: no silent rerouting, read before edit, no write-scope expansion, graded ambiguity, acceptance-based verification and evidence-backed reporting.
- Preset persona defines Worker standby/evidence/stale-instruction discipline and requires the Lead to forward the current `mandateText` verbatim after `bind`, appending only one `ACTION NOW` line. No automatic `dispatch` was added.
- Core and preset contract tests cover the new text; bilingual README and architecture documentation describe the manual handoff and its validation boundary.

### Fixed

- Recovery now supports an explicit same-contract replan after an `unknown` review leaves both the work item and Mandate in `verifying`; a new attempt requires fresh evidence and all contract fields remain unchanged.
- `super_run replan` accepts user-authorized `workItemRevisions`, creating a new Anchor and preserving invalidated history instead of bypassing a work item with replacement IDs or direct state edits.
- Native evidence extraction now covers both ordinary `tool/result` and PTC `tool/ptc-dispatch` content. The dedicated `mandate_delivery` Host verification compares native outbound and inbound delegation messages and records source-bound coverage instead of trusting shell-printed `pass` values.
- Reviewer binding and wake-up now wait for `reported_done`; read-only directory navigation and Session queries are classified by operation while writes, indexing and `run_code` remain forbidden. Plain-text Reviewer result reports to the Lead may cite files already read and tool receipts, without treating those observations as writes; actual file/attachment instructions and permission changes remain forbidden.

### Validation

- 2026-11-27: original work item A accepted in its original session by an independent native standard Reviewer (Anchor v8, attempt 3; Decision result=pass, SnapshotProof verified at revision 66 / generation 4). `a-delivery` and unit/build evidence were Host-observed (`hostObserved=true`); `a-standby`, `a-report-only` and `a-stale` were independently registered by the Reviewer. The earlier `unknown` Decision and superseded attempts are preserved unchanged.
- `pnpm run typecheck` exit 0; complete `pnpm test` **214/214 pass** (Core 87, Host 90, Preset 12, remaining Client suites); `pnpm run build` exit 0 with `lib/host.mjs` 220.41 kB and the Client bundle rebuilt. Native delivery verification also accepts the first Worker message carried by `agent/inbox/spliced`, without requiring a projected `user/message`. Coverage now requires independent sources, delivery obligations declare their verification semantics, `host_contract` has a dedicated Host producer, stale Reviewer bindings are rejected, contradicted passes can be replanned, and downstream contracts cannot be changed without approval.
- The three isolated-profile scenarios (standby before work, observed-results-only reporting, invalidating old instructions after replanning) were released by an independent native standard Reviewer in a separate isolated Run; they are small-sample live validations and do not prove drift resistance on every long task. See `docs/VALIDATION.md`.
- DSH kernel requirement unchanged at the validated baseline `>=0.2.2-rc.5 <0.3.0-0`.

## [0.1.9] - 2026-11-21

### Changed

- DSH kernel requirement tightened to the actually validated baseline: `>=0.2.2-rc.5 <0.3.0-0` in engines, host peer ranges, READMEs, architecture doc, market index and contract tests.

## [0.1.8] - 2026-11-20

### Fixed

- README links to `docs/VALIDATION.md` now resolve: the validation summary was renamed from `docs/VERIFICATION.md` to `docs/VALIDATION.md`, and the architecture doc no longer hardcodes a version.

## [0.1.7] - 2026-11-20

### Changed

- READMEs no longer hardcode a package version; the market index resolves to the current npm release so npm, GitHub release and market entry stay in lockstep.

## [0.1.6] - 2026-11-20

### Changed

- Chinese is the default README (README.md); English lives in README.en.md.
- Language switching uses badge-style hyperlink buttons on both pages.

## [0.1.5] - 2026-11-20

### Changed

- English README is fully English (language switcher and acknowledgements included); Chinese README switcher uses Chinese labels.

## [0.1.4] - 2026-11-20

### Changed

- Split documentation into single-language English (README.md) and Simplified Chinese (README.zh-CN.md) versions with a language switcher.
- Diagrams now ship in both languages under docs/images/en and docs/images/zh.
- Package files include README.zh-CN.md.

## [0.1.3] - 2026-11-20

### Added

- README acknowledgements: community member CC (dsh-plugin-antidrift source), and the 2026-11-17 group discussion (桉, Electron, CC, KOLA 2) that shaped the supervision loop.

### Changed

- NOTICE records the community references; no third-party code is redistributed.

## [0.1.2] - 2026-11-20

### Added

- README states the core positioning explicitly: a supervision state machine (Run → Anchor → Mandate → Evidence → Decision) layered on native Agent/Session, with the native PTC event chain as the evidence substrate.

### Changed

- Layered architecture diagram shows the full supervision chain.

## [0.1.1] - 2026-11-20

### Fixed

- README architecture diagrams now render everywhere: SVG roots declare the SVG namespace, PNG previews are published alongside the SVG sources.
- Lifecycle and layered diagrams reflowed to remove clipped labels.

### Changed

- README image references point at PNG previews for maximum renderer compatibility.
## [0.1.0] - 2026-11-20

### Added

- Seven `super_*` supervision tools (run, anchor, mandate, evidence, review, route, snapshot) delivered through PTC `run_code`.
- Versioned anchors, obligation ledger and explicit invalidation of affected work on correction.
- Mandate delegation contracts bound to native Worker/Reviewer SessionIds, with write scopes and routing frozen at prepare time.
- Independent read-only Reviewer acceptance on the native `standard` preset, with typed evidence gates and failure budgets.
- `storageDomain` RunState v2 plus SnapshotProof persistence; `super_run recover` increases generation and re-reconciles.
- Right-side supervision panel and composer entry, read-only projection over a Host RPC.
- Official DSH market index (`market-index.json`) and GitHub release artifact.

### Fixed

- Reviewer read-only guard misclassified `pwsh "$env:NAME"` as a write operation and blocked `decide/release`; environment reads are now classified as read-only with regression tests.

### Verification

- 176/176 automated tests, `typecheck` and `build` exit 0.
- Two real desktop supervision runs, including recovery across four generations.
