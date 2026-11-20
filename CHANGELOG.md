# Changelog

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
