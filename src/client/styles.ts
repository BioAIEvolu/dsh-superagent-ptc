/** Kept as a JS string so the single client bundle owns injection and disposal. */
export const superAgentStyles = String.raw`
.sam-panel {
  --sam-text: var(--dsh-text-primary, var(--color-text-primary, light-dark(#17202a, #e7ecf2)));
  --sam-muted: var(--dsh-text-secondary, var(--color-text-secondary, light-dark(#64707d, #a8b3c0)));
  --sam-border: var(--dsh-border-color, var(--color-border, light-dark(#d8dee6, #36404c)));
  --sam-surface: var(--dsh-bg-primary, var(--color-bg-primary, light-dark(#ffffff, #171c22)));
  --sam-subtle: var(--dsh-bg-secondary, var(--color-bg-secondary, light-dark(#f5f7fa, #202731)));
  color: var(--sam-text);
  color-scheme: light dark;
  container-type: inline-size;
  display: grid;
  gap: 10px;
  min-width: 0;
  padding: 12px;
  font-size: 12px;
  line-height: 1.5;
}
.sam-panel *, .sam-panel *::before, .sam-panel *::after { box-sizing: border-box; }
.sam-panel h2, .sam-panel h3, .sam-panel p, .sam-panel dl, .sam-panel dd { margin: 0; }
.sam-panel h2 { font-size: 15px; line-height: 1.3; }
.sam-panel h3 { font-size: 12px; line-height: 1.4; }
.sam-header, .sam-goal-heading, .sam-work-heading, .sam-evidence-heading, .sam-gate {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: space-between;
  min-width: 0;
}
.sam-header p { color: var(--sam-muted); margin-top: 2px; }
.sam-refresh, .sam-entry {
  border: 1px solid var(--sam-border);
  border-radius: 6px;
  color: inherit;
  cursor: pointer;
  font: inherit;
}
.sam-refresh { background: var(--sam-subtle); min-height: 30px; padding: 3px 10px; }
.sam-refresh:disabled { cursor: wait; color: var(--sam-muted); }
.sam-refresh:focus-visible, .sam-entry:focus-visible, .sam-panel summary:focus-visible {
  outline: 2px solid light-dark(#1769aa, #72b7ff);
  outline-offset: 2px;
}
.sam-entry {
  align-items: center;
  background: transparent;
  display: inline-flex;
  gap: 6px;
  min-height: 30px;
  padding: 4px 8px;
  width: 100%;
}
.sam-section {
  background: var(--sam-surface);
  border: 1px solid var(--sam-border);
  border-radius: 8px;
  display: grid;
  gap: 8px;
  min-width: 0;
  padding: 10px;
}
.sam-objective { overflow-wrap: anywhere; white-space: pre-wrap; }
.sam-facts {
  display: grid;
  gap: 6px;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 108px), 1fr));
}
.sam-facts > div { background: var(--sam-subtle); border-radius: 5px; min-width: 0; padding: 5px 7px; }
.sam-facts dt { color: var(--sam-muted); font-size: 10px; }
.sam-facts dd { overflow-wrap: anywhere; }
.sam-note, .sam-empty, .sam-observed { color: var(--sam-muted); }
.sam-empty { border: 1px dashed var(--sam-border); border-radius: 6px; padding: 8px; }
.sam-alert { background: light-dark(#fff6e5, #352a17); border-radius: 6px; color: light-dark(#7c4a03, #ffd58a); padding: 8px; overflow-wrap: anywhere; }
.sam-alert code { display: inline-block; margin-top: 4px; }
.sam-blocked { border-color: light-dark(#d22f2f, #ff7a72); }
.sam-list { display: grid; gap: 5px; margin: 0; padding-left: 18px; }
.sam-list li, .sam-work, .sam-evidence li { overflow-wrap: anywhere; }
.sam-item-id { color: var(--sam-muted); font-family: ui-monospace, monospace; }
.sam-prohibitions { color: light-dark(#9f2929, #ff9b94); }
.sam-agenda, .sam-evidence, .sam-members, .sam-audit { display: grid; gap: 8px; list-style: none; margin: 0; padding: 0; }
.sam-work { background: var(--sam-subtle); border-left: 3px solid var(--sam-border); border-radius: 5px; display: grid; gap: 7px; padding: 8px; }
.sam-work[data-status="reported_done"] { border-left-color: light-dark(#a86100, #f0ad4e); }
.sam-work[data-status="accepted"] { border-left-color: light-dark(#1c7c43, #5ac887); }
.sam-work[data-status="blocked"], .sam-work[data-status="rework"] { border-left-color: light-dark(#c92a2a, #ff7a72); }
.sam-work-facts { grid-template-columns: repeat(auto-fit, minmax(min(100%, 88px), 1fr)); }
.sam-badge { border-radius: 999px; display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 600; padding: 2px 7px; white-space: normal; }
.sam-badge[data-tone="pass"] { background: light-dark(#e6f5eb, #173c27); color: light-dark(#176738, #79d69b); }
.sam-badge[data-tone="fail"] { background: light-dark(#fdebec, #421f24); color: light-dark(#a52730, #ff9b9f); }
.sam-badge[data-tone="unknown"] { background: light-dark(#fff2d9, #3d301b); color: light-dark(#855200, #f3c26d); }
.sam-badge[data-tone="active"] { background: light-dark(#e7f1fb, #1b334a); color: light-dark(#1b5f9e, #8bc4ff); }
.sam-badge[data-tone="muted"] { background: var(--sam-subtle); color: var(--sam-muted); }
.sam-members li { align-items: baseline; display: flex; flex-wrap: wrap; gap: 6px; border-bottom: 1px solid var(--sam-border); padding-bottom: 6px; }
.sam-members li:last-child { border-bottom: 0; padding-bottom: 0; }
.sam-members span, .sam-members small { color: var(--sam-muted); }
.sam-members li[data-activity="inactive"] span { color: light-dark(#855200, #f3c26d); }
.sam-evidence li { border-top: 1px solid var(--sam-border); display: grid; gap: 5px; padding-top: 8px; }
.sam-evidence li:first-child { border-top: 0; padding-top: 0; }
.sam-evidence-heading { justify-content: flex-start; }
.sam-evidence small { color: var(--sam-muted); }
.sam-details { min-width: 0; }
.sam-details summary { border-radius: 3px; cursor: pointer; color: var(--sam-muted); width: fit-content; }
.sam-details pre { background: var(--sam-subtle); border-radius: 5px; margin: 6px 0 0; max-height: 220px; max-width: 100%; overflow: auto; padding: 7px; white-space: pre-wrap; overflow-wrap: anywhere; }
.sam-audit li { border-left: 2px solid var(--sam-border); display: grid; gap: 3px; padding-left: 8px; }
.sam-audit time { color: var(--sam-muted); font-size: 10px; }
.sam-observed { text-align: right; }
.sam-routing h4 { font-size: 11px; margin: 0; }
.sam-policy, .sam-route-mandates, .sam-route-failures { display: grid; gap: 7px; min-width: 0; }
.sam-route-record, .sam-route-failure { background: var(--sam-subtle); border-radius: 6px; display: grid; gap: 6px; min-width: 0; padding: 8px; }
.sam-route-record dd, .sam-route-failure p, .sam-route-failure code { overflow-wrap: anywhere; }
.sam-route-reason span { color: var(--sam-muted); }
.sam-route-readback { color: var(--sam-muted); overflow-wrap: anywhere; }
.sam-route-readback[data-readback="matched"], .sam-route-readback[data-readback="inherited"] { color: light-dark(#176738, #79d69b); }
.sam-route-readback[data-readback="unknown"] { color: light-dark(#855200, #f3c26d); }
.sam-route-failure { border-left: 3px solid var(--sam-border); }
.sam-route-failure[data-failure-kind="authentication"], .sam-route-failure[data-failure-kind="permission"],
.sam-route-failure[data-failure-kind="business_acceptance"], .sam-route-failure[data-failure-kind="snapshot_proof"],
.sam-route-failure[data-failure-kind="write_scope"], .sam-route-failure[data-failure-kind="identity"] { border-left-color: light-dark(#c92a2a, #ff7a72); }
.sam-route-failure-heading { align-items: center; display: flex; flex-wrap: wrap; gap: 6px; }
.sam-route-switches ol { display: grid; gap: 7px; list-style: none; margin: 7px 0 0; padding: 0; }
.sam-route-switches li { border-left: 2px solid var(--sam-border); padding-left: 8px; overflow-wrap: anywhere; }
.sam-route-switches li[data-switch-status="rejected"], .sam-route-switches li[data-switch-status="exhausted"] { border-left-color: light-dark(#c92a2a, #ff7a72); }
.sam-route-switches p { margin-top: 3px; }
.sam-route-switches small { color: var(--sam-muted); }
@container (max-width: 340px) {
  .sam-panel { padding: 8px; }
  .sam-facts, .sam-work-facts { grid-template-columns: 1fr 1fr; }
  .sam-header { align-items: flex-start; }
}
`
