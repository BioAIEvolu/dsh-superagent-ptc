# Changelog

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
