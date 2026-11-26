import type { JsonValue } from "../core/index.ts";
import { REVIEWER_COMPOSITION_GUIDANCE } from "./reviewer.ts";

export type ToolSafety = "read" | "write" | "supervisory" | "unknown";

const READ_TOOLS = new Set([
  "read", "read_image", "grep", "glob", "list_agents", "get_goal", "session_search", "session_event_search",
  "session_event_read", "session_event_trace", "session_trace", "web_fetch", "web_search", "deja_recall",
  "deja_session", "deja_blame", "deja_how",
]);
const WRITE_TOOLS = new Set([
  "write", "edit", "pwsh", "bash", "run_code", "terminal_open", "terminal_send", "terminal_signal", "terminal_close",
  "create_worktree", "job_kill", "team_task_create", "team_task_update", "send_message", "subagent", "subagent_fork",
  "subagent_claude_code", "subagent_codex", "create_goal", "update_goal", "schedule_create", "schedule_edit",
  "image_generate", "video_generate", "present", "evolve_add", "evolve_remove",
]);

const SESSIONGRAPH_READ_OPERATIONS = new Set([
  "search", "session", "event", "trace", "timeline", "workspaces", "status", "touched",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseArguments(args: unknown): Record<string, unknown> | undefined {
  if (typeof args === "string") {
    try { return asRecord(JSON.parse(args)); } catch { return undefined; }
  }
  return asRecord(args);
}

function actionOf(args: unknown): unknown {
  return parseArguments(args)?.action;
}

const POWERSHELL_READ_COMMANDS = new Set([
  "get-content", "get-item", "get-childitem", "get-location", "get-process", "get-service", "get-computerinfo",
  "get-date", "get-host", "get-variable", "get-psdrive", "get-command", "get-help", "get-history",
  "get-itemproperty", "get-itempropertyvalue", "get-acl", "get-executionpolicy", "get-module", "get-package",
  "test-path", "resolve-path", "select-string", "select-object", "measure-object", "compare-object",
  "get-filehash", "get-member", "get-winevent", "get-eventlog", "get-counter", "get-culture", "get-uiculture",
]);
const POWERSHELL_ENV_READ = [
  /^\$env:[A-Za-z_][A-Za-z0-9_]*$/u,
  /^write-output\s+\$env:[A-Za-z_][A-Za-z0-9_]*$/iu,
  /^echo\s+\$env:[A-Za-z_][A-Za-z0-9_]*$/iu,
  /^get-item\s+env:[A-Za-z_][A-Za-z0-9_]*$/iu,
  /^get-childitem\s+env:[A-Za-z_][A-Za-z0-9_]*$/iu,
  /^get-childitem\s+env:\s*$/iu,
  /^get-variable\s+[A-Za-z_][A-Za-z0-9_]*$/iu,
] as const;

function isPowerShellEnvironmentRead(command: string): boolean {
  const trimmed = command.trim();
  return POWERSHELL_ENV_READ.some(pattern => pattern.test(trimmed));
}

// Pure read-only .NET static calls used for environment / identity inspection.
// These never touch the filesystem or mutate state; the mutating-verb heuristic below
// would otherwise reject them because of the leading [Type]::Method shape.
const POWERSHELL_DOTNET_READONLY = [
  /^\[Environment\]::GetEnvironmentVariable\(/iu,
  /^\[Environment\]::UserName$/iu,
  /^\[Environment\]::MachineName$/iu,
  /^\[Environment\]::CurrentDirectory$/iu,
  /^\[Environment\]::OSVersion$/iu,
  /^\[System\.Environment\]::GetEnvironmentVariable\(/iu,
] as const;

function isPowerShellDotNetReadonly(command: string): boolean {
  return POWERSHELL_DOTNET_READONLY.some(pattern => pattern.test(command.trim()));
}

const BASH_READ_COMMANDS = new Set([
  "cat", "ls", "pwd", "stat", "wc", "head", "tail", "grep", "rg", "find", "file", "which", "type",
  "ps", "id", "whoami", "date", "hostname", "uname", "env", "printenv", "du", "df", "sha256sum",
]);

function shellSafety(args: unknown, name: "pwsh" | "bash"): ToolSafety {
  const input = parseArguments(args);
  if (input && Object.keys(input).some(key => !["command", "description", "workdir", "timeoutMs", "run_in_background", "signal"].includes(key))) return "write";
  const command = input?.command;
  if (typeof command !== "string" || command.trim().length === 0 || command.length > 4000) return "unknown";
  // A Reviewer is read-only even when a command uses custom commands/shell syntax not on this allowlist.
  if (/[<>|;&`]/u.test(command) || /\$(?:\()/u.test(command)) return "write";
  // Environment reads are pure reads; they must be recognised before the mutating-name heuristic below
  // (the heuristic would otherwise reject the benign `Write-Output $env:NAME` spelling).
  if (name === "pwsh" && isPowerShellEnvironmentRead(command)) return "read";
  if (name === "pwsh" && isPowerShellDotNetReadonly(command)) return "read";
  if (/\b(?:Invoke|Start|Stop|Restart|Suspend|Resume|New|Set|Add|Remove|Clear|Move|Copy|Rename|Delete|Kill|Format|Install|Uninstall|Register|Unregister|Grant|Revoke|Enable|Disable|Update|Write|Edit|Create|Mount|Dismount|Initialize|Restore|Repair|Push|Publish|Commit|Checkout|Clean|Reset|Rebase|Merge|Apply|Net|IEX|IWR|IRM)-/i.test(command)) return "write";
  const executable = command.trim().split(/\s+/u, 1)[0]?.toLowerCase().replace(/\.exe$/u, "");
  if (!executable) return "unknown";
  const allowed = (name === "pwsh" ? POWERSHELL_READ_COMMANDS : BASH_READ_COMMANDS).has(executable);
  if (!allowed) return "write";
  if (name === "bash" && /\s-[a-zA-Z]*[wim]/u.test(command)) return "write";
  return "read";
}

function isReadOnlyResultNarrative(target: string, text: string): boolean {
  if (target !== "lead" || text.length > 8000 || /[@]/u.test(text) ||
      !/(?:\breport(?:ed|ing)?\b|\breceipts?\b|\bverdict\b|\bresult\b|\baccepted\b|\breview(?:er|ing)?\b|结果|回执|验收|核验|复核|已放行|未放行)/iu.test(text)) return false;
  for (const line of text.split(/\r?\n/u)) {
    if (!/(?:\bread\b|\bwrite\b|\bedit\b|\bopen\b|\battach(?:ing)?\b|\bsend\b|\bmodify\b|\bdelete\b|\bcreate\b|读取|修改|编辑|附件|删除|创建|写入|打开)/iu.test(line)) continue;
    // Imperative intent: a directive to act on a file — e.g. "please write", "必须修改",
    // "请创建", "next: edit". Mere mentions of next steps, requests to review, or
    // read-path citations without an imperative verb+file combo are not instructions.
    if (/(?:\bplease\s+(?:write|edit|create|delete|modify|open|send|attach)\b|\bmust\s+(?:write|edit|create|delete|modify|open|send|attach)\b|\bnext\s*:?\s*(?:write|edit|create|delete|modify|open|send|attach)\b|请(?:\s*)(?:写入|创建|删除|修改|编辑|打开|发送|write\b|edit\b|create\b|delete\b|modify\b|open\b|send\b|attach\b)|必须(?:\s*)(?:写入|创建|删除|修改|编辑)|下一步(?:\s*)(?:写入|创建|删除|修改|编辑)|继续(?:\s*)(?:写入|创建|删除|修改|编辑))/iu.test(line)) return false;
    // Path/action words alone (read X, 读取 X, 复核 X) are report content only when the
    // line carries a result/report marker (→, ok, pass, 只读, 零写入, 已, 过, etc.).
    // A bare imperative like "send X as attachment" has no such marker and is an instruction.
    if (!/(?:→|只读|零写入|exactly|逐字|核对|描述|\bok\b|\bpass\b|\baccepted\b|已|过|成功|完成)/iu.test(line)) return false;
  }
  return true;
}

function messageSafety(args: unknown): ToolSafety {
  const input = parseArguments(args);
  const target = input?.agent;
  const text = input?.message;
  if (typeof target !== "string" || target.trim().length === 0 || typeof text !== "string" || text.trim().length === 0 || text.length > 8000) return "unknown";
  // Coordination text is not a filesystem or authority mutation; explicit file/attachment/permission payloads remain unsafe.
  if (Object.keys(input!).some(key => !["agent", "message"].includes(key))) return "unknown";
  // Reports to the root Lead are supervisory unless they embed actionable instructions,
  // permission payloads, or file paths with intent to act on them. Pure status/result
  // narratives (even with read-path citations) must not be classified as mutations.
  if (/(?:[a-zA-Z]:[\\/]|\.(?:\/|\\)(?:[^\s]+\/)|(?:file|attachment|image|video|document)s?\s*[:=]|https?:\/\/|\/mnt\/|\/tmp\/)/i.test(text) &&
      !isReadOnlyResultNarrative(target, text)) return "write";
  if (/\b(?:grant|allow|elevate|approve|bypass|escalat(?:e|ion)|permission|write access|full access|sandbox(?:ing)?)\b/i.test(text)) return "write";
  return "supervisory";
}

export function classifyToolSafety(name: string, args?: unknown): ToolSafety {
  if (name === "working_directory") {
    if (args === undefined) return "read";
    const input = parseArguments(args);
    if (!input) return "unknown";
    const keys = Object.keys(input);
    if (keys.length === 0 || (keys.length === 1 && keys[0] === "cd" && input.cd === undefined)) return "read";
    return keys.length === 1 && keys[0] === "cd" && typeof input.cd === "string" && input.cd.trim().length > 0 ? "read" : "unknown";
  }
  if (name === "sessiongraph") {
    if (args === undefined) return "read";
    const input = parseArguments(args);
    if (!input) return "unknown";
    const operation = input.operation ?? "search";
    if (operation === "index") return "write";
    return typeof operation === "string" && SESSIONGRAPH_READ_OPERATIONS.has(operation) ? "read" : "unknown";
  }
  if (name === "codeflow_map") {
    const action = actionOf(args);
    return action === "init" ? "write" : action === "status" || action === "graph" ? "read" : "unknown";
  }
  if (name === "super_snapshot") return "supervisory";
  if (name === "super_run" || name === "super_anchor" || name === "super_mandate" || name === "super_evidence" || name === "super_review" || name === "super_route") {
    const action = actionOf(args);
    if (name === "super_run") return action === "show" ? "supervisory" : "write";
    if (name === "super_anchor") return action === "show" || action === "history" ? "supervisory" : "write";
    if (name === "super_mandate") return action === "show" ? "supervisory" : "write";
    if (name === "super_evidence") return ["record", "observe", "verify", "list"].includes(String(action)) ? "supervisory" : "unknown";
    if (name === "super_review") return ["evaluate", "decide", "release"].includes(String(action)) ? "supervisory" : "unknown";
    if (name === "super_route") return ["show", "inspect"].includes(String(action)) ? "read" : action === "set" || action === "switch" ? "write" : "unknown";
  }
  if (name === "pwsh" || name === "bash") return shellSafety(args, name);
  if (name === "send_message") return messageSafety(args);
  if (READ_TOOLS.has(name)) return "read";
  if (WRITE_TOOLS.has(name)) return "write";
  return "unknown";
}

export function reviewerToolDenial(name: string, args?: unknown): string | undefined {
  const safety = classifyToolSafety(name, args);
  if (safety === "read" || safety === "supervisory") return undefined;
  if (name === "run_code") return `Forbidden Reviewer PTC run_code; do not retry through super-agent. ${REVIEWER_COMPOSITION_GUIDANCE}`;
  return `Reviewer is read-only; ${name} is ${safety}. ${REVIEWER_COMPOSITION_GUIDANCE}`;
}

export function successfulMutatingEvents(events: readonly { type?: unknown; data?: unknown }[]): { seq: number; toolName: string; operation: JsonValue }[] {
  const calls = new Map<string, { name: string; arguments?: unknown }>();
  for (const event of events) {
    if (event.type !== "tool/call") continue;
    const data = asRecord(event.data);
    const name = typeof data?.name === "string" ? data.name : typeof data?.toolName === "string" ? data.toolName : undefined;
    if (typeof data?.callId === "string" && name) {
      calls.set(data.callId, { name, arguments: data.arguments ?? data.args });
    }
  }
  const violations: { seq: number; toolName: string; operation: JsonValue }[] = [];
  for (const event of events) {
    if (event.type !== "tool/result" && event.type !== "tool/ptc-dispatch") continue;
    const data = asRecord(event.data);
    const message = asRecord(data?.message);
    if (data?.error !== undefined || data?.isError === true || message?.isError === true) continue;
    const source = asRecord(message?.source);
    const callId = [source?.callId, data?.callId, data?.subCallId]
      .find((value): value is string => typeof value === "string" && value.length > 0);
    const call = callId ? calls.get(callId) : undefined;
    const names = [data?.name, data?.toolName, source?.name, source?.toolName, call?.name]
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    const name = names[0];
    const identityConflict = new Set(names).size > 1;
    const args = data?.arguments ?? data?.args ?? call?.arguments;
    const safety = name && !identityConflict ? classifyToolSafety(name, args) : "unknown";
    if (safety === "write" || safety === "unknown") {
      violations.push({ seq: Number((event as { seq?: unknown }).seq), toolName: name ?? "unknown", operation: safety });
    }
  }
  return violations;
}
