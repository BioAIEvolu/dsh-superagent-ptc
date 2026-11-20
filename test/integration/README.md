# Isolated runtime smoke validation

Uses Playwright with the installed system Chrome. It creates and selects only a blank session in the explicitly supplied isolated test instance; it never starts/stops the service, edits a profile, or sends a model message.

## Run

Set `DSH_TEST_URL` at invocation time to the isolated instance URL supplied by the task owner. Do not save that value or its token in this repository.

Optional environment variables:

- `DSH_CHROME_PATH`: system Chrome executable. Defaults to the standard Windows installation path.
- `DSH_VALIDATION_DIR`: evidence directory. Defaults to `.validation` in the workspace.
- `DSH_EXPLORE_ONLY=1`: capture initial/onboarding DOM without selecting a preset.

From the workspace root:

```sh
node dsh-superagent-ptc/test/integration/runtime-smoke.mjs
node dsh-superagent-ptc/test/integration/summarize-evidence.mjs
```

The second command writes `validation-summary.json` and exits non-zero when a hard runtime check fails. PTC/model delegation remains `unknown` unless a real model run supplies evidence.

## Evidence handling

- Request and response URLs are reduced to paths. Non-sensitive plugin module query identifiers are retained.
- Supplied tokens and credential-like response fields are redacted.
- Request bodies are captured only for the blank-session/preset/projection RPCs needed by assertions.
- Screenshots contain page content only, not browser chrome or the address bar.
- The projection RPC is read-only. No goal, work item, mandate, evidence, or subagent is created.