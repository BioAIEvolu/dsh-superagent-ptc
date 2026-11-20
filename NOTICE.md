# Third-party reference notice

## Package identity and provenance

`dsh-superagent-ptc` (display name **SuperAgent PTC**) is the renamed continuation of this workspace's original `dsh-super-agent-mode` implementation. The rename on 2026-11-19 changes the package, global bare Host Loader row, Host export name, client `data-plugin`, and ModuleLoader id. It intentionally preserves the established `super_agent_mode` storage domain, `plugin:dsh-super-agent-mode/proof` native record, `dsh-super-agent-mode/projection` RPC endpoint, and right-sidebar internal identifiers so existing Runs and proofs remain readable.

Development-only `@deepseek-ai/*` pins are aligned to DSH 0.2.2-rc.5; the declared runtime compatibility range remains `>=0.2.2-rc.5 <0.3.0-0`.

## dsh-super-ptc-mode

- Upstream: https://github.com/zouyuanqing/dsh-super-ptc-mode
- Copyright: Copyright (c) 2026 zouyuanqing
- License: MIT
- Local reference snapshot used during development (not redistributed).
- Reference files: `cordis.patch.yml` and `LICENSE`
- Reuse: the thin preset-composition approach and Lead delegation doctrine informed this package. The Super Agent persona and composition are rewritten for the current DSH rc.5 contract, including direct use of `@deepseek-ai/dsh-tool-executor-ptc`.

The upstream MIT notice is preserved below:

> MIT License
>
> Copyright (c) 2026 zouyuanqing
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Additional implementation references

- `@khorsheed/dsh-taskpilot` 0.3.7 (MIT, https://github.com/Khorsheed/dsh-taskpilot): behavior-only reference for attaching session supervision to existing composer/right-sidebar surfaces. No TaskPilot implementation is copied.
- Local `dsh-codeflow` (MIT): reference for narrowing the slots interface structurally instead of importing the unrelated hoisted pre-rc.3 slots declarations. `scripts/build-client.mjs` adapts its MIT esbuild CJS + `window.__ModuleLoader__.load` recipe for this package. No CodeGraph implementation is copied.

No implementation is copied from the UNLICENSED dsh-task-supervisor reference.


## Community references (no code redistributed)

- `dsh-plugin-antidrift` plugin source shared by community member **CC** in a 2026-11-17 group chat; reviewed read-only for design inspiration. Not installed, not executed, not copied.
- Group discussion on long-running supervision in the same chat (桉, Electron, CC, KOLA 2) informed the work-item, audit cadence, and evidence-gate design.
- Upstream `zouyuanqing/dsh-super-ptc-mode` (MIT) is credited above.
