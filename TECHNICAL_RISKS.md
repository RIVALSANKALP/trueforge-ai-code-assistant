# Technical Risks & Mitigation Strategies
**Techfest Forge-a-thon 2026 Competition Project**  
**Document Version:** 2.2.9 (Pre-Commit Operational & Implementation Alignment)  

This document evaluates the critical technical risks, failure modes, root causes, severity ratings, concrete architectural mitigations, and explicit verification tiers for the TrueForge VS Code Extension.

---

## 1. Verification Tier Classification

Every risk analysis finding is grounded in our five-tier verification framework:
* **Tier 1: Source-Code Verified** — Confirmed by reading package implementation code in `trueforge-core` / `trueforge`.
* **Tier 2: SDK Declaration Verified** — Confirmed by reading TypeScript `.d.ts` declaration files in `@truefoundry/trueforge-sdk`.
* **Tier 3: Runtime Verified / Blocked** — Confirmed by live execution or active probing against running TrueForge server or OS (including identified policy blocks).
* **Tier 4: Live Verified / End-to-End Tested** — Confirmed by complete automated, live model execution, or visual interactive test passing.
* **Tier 5: Pending Implementation / Unimplemented** — Architecture specified, verified against interfaces, scheduled for implementation.

---

## 2. Risk Matrix Summary

| Risk ID | Risk Description | Severity | Probability | Impact | Verification Tier | Primary Mitigation Strategy |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **TR-01** | TrueForge `LocalSandboxProvider` `win32` incompatibility | **CRITICAL** | **CONFIRMED** | High | **Tier 3: Runtime Verified** | Keep TrueForge container sandbox disabled; execute workspace tools locally within extension boundary checks. |
| **TR-02** | Gemini API 503 "Model Experiencing High Demand" | **HIGH** | **HIGH** | High | **Tier 3: Runtime Verified** | SDK handles initial HTTP retries (`maxRetries: 2`); turn-level partial-turn inspection designed for future resilience. |
| **TR-03** | TrueForge Issue #508 (Duplicate turn cancels in-flight turn) | **HIGH** | **MEDIUM** | High | **Tier 1: Source-Code Verified** | Enforce client-side `TurnLock` mutex; submit approvals via `createTurnEvents` (never `createTurn`). |
| **TR-04** | Remote MCP Loopback Blocked by TrueForge Outbound URL Policy | **HIGH** | **CONFIRMED** | High | **BLOCKED / NOT VERIFIED (Tier 3 Runtime Blocked)** | Remote MCP registration is blocked by TrueForge's outbound SSRF policy on `127.0.0.1` and rolled back. Autonomous operations are executed via local in-process tools (`WorkspaceTools.ts`). Local protocol does not satisfy native MCP integration. |
| **TR-05** | Symlink, junction, UNC, and path traversal escapes on Windows | **HIGH** | **LOW** | High | **Tier 4: Live Verified** | Fail-closed workspace root resolution and `WorkspaceTools` boundary checks validate containment before any disk read or edit proposal. |
| **TR-06** | Windows Process Execution / Unsupported Test Execution | **MEDIUM** | **LOW** | Medium | **Tier 5: Unimplemented in Current Release** | `run_tests` and autonomous terminal execution are not implemented in current codebase (`WorkspaceTools.ts` implements file and diff tools only). Process execution safeguards remain specified for future implementation. |
| **TR-07** | Dropped SSE streams and state desynchronization | **MEDIUM** | **LOW** | Medium | **Tier 1: Source-Code Verified** | Handled by SDK's built-in `Stream.js` reconnection logic (`DEFAULT_MAX_RECONNECTION_ATTEMPTS = 5`). |

---

## 3. In-Depth Technical Risk Analyses

### TR-01: TrueForge `LocalSandboxProvider` `win32` Incompatibility
* **Context**: The user observed: `LocalSandboxProvider supports macOS and Linux only (got win32)`.
* **Root Cause (Tier 3 Verified)**: TrueForge's `LocalSandboxProvider` uses `@anthropic-ai/sandbox-runtime`, which invokes Linux bubblewrap (`bwrap`) to create user namespaces, mount points, and seccomp filters. Windows NT kernel does not implement bubblewrap or Linux namespaces.
* **Impact**: Enabling sandboxing on Windows causes all agent turns to abort immediately upon tool execution.
* **Evaluation of Alternatives**:
  1. **WSL2 (Windows Subsystem for Linux)**:
     * *Pros*: Provides real Linux kernel and bubblewrap capabilities.
     * *Cons*: Heavy prerequisite for competition evaluators; complex cross-OS filesystem translation (`/mnt/d/...` vs `D:\...`); port forwarding hurdles between Windows VS Code and WSL2 TrueForge server; permission mapping mismatches.
  2. **Remote Cloud Sandboxes (E2B / Modal / Daytona)**:
     * *Pros*: Full cloud container isolation.
     * *Cons*: Requires external cloud credentials; network latency; uploads local workspace code to third-party cloud; violates competition self-containment.
  3. **Native Windows + Local Extension Workspace Tools (Current Working Implementation)**:
     * *Pros*: Zero external dependencies; 100% native Windows compatibility; instant in-process execution with fail-closed workspace boundaries.
     * *Cons*: Does not provide OS kernel sandbox isolation.
* **Mitigation Specification**:
  * Set `sandbox: { enabled: false }` in `forgeagent` (verified and confirmed in `data/trueforge.sqlite`).
  * Run workspace operations via the extension's local tools (`WorkspaceTools.ts`), orchestrated by `AutonomousAgentCoordinator.ts`. (Remote MCP loopback was blocked by TrueForge's outbound 127.0.0.1 policy and rolled back).
  * Enforce strict application-level boundary validation:
    * Revalidate paths immediately before every read or write.
    * Enforce human-in-the-loop review before any edit proposal is applied to disk.
    * Explicitly document in architecture and presentation that this is application-level boundary enforcement, not an OS-level kernel sandbox.

---

### TR-02: Gemini API 503 Capacity Spikes & Partial-Turn Retry Safety
* **Context**: Live session logs in `data/trueforge.sqlite` contain turn failures:
  `[Model Error] Request failed (503): This model is currently experiencing high demand`.
* **Root Cause (Tier 3 Verified)**: Google Gemini endpoints (`google-gemini/gemini-3-1-flash-lite`) experience transient capacity exhaustion or rate limit spikes under peak loads.
* **Impact**: Turn terminates with status `error`, interrupting coding workflows.
* **Partial-Turn Execution Danger**:
  * If an agent executed 2 tool calls (e.g. read file A, modified file B) before the model threw a 503 on the subsequent step, naively replaying the initial prompt will re-execute tool calls, causing duplicate modifications or corrupted files!
* **Mitigation Specification**:
  1. **SDK HTTP Retry Layer**: The TrueForge SDK already configures `maxRetries: 2` on initial HTTP requests (`BaseClient.d.ts` and `core/fetcher/requestWithRetries.js:15`). Adding a second HTTP retry layer is prohibited.
     * *Scope Clarification*: These automatic retries apply strictly to initial HTTP request fetching (retrying status codes 408, 429, or >= 500); they do **not** guarantee mid-stream Server-Sent Events (SSE) connection recovery or model-turn replay once a turn is active.
  2. **Turn-Level Error Handling**: Catch `turn.done` where `state.status === "error"` and error text contains `503` or `high demand`.
  3. **Partial-Turn Inspection Before Retry**:
     * Call `client.sessions.getTurn(sessionId, turnId)`.
     * If NO tool calls were executed: Safe to auto-retry via exponential backoff (2s, 4s, 8s with full jitter, max 3 attempts).
     * If tool calls WERE executed: Do **not** auto-replay the prompt. Display a detailed status card to the user: *"Turn paused after 2 tool calls due to temporary Gemini 503 error. Click to resume from last checkpoint or review changes."*
  4. **User Feedback**: Non-intrusive status pill in chat UI showing retry attempt countdown.

---

### TR-03: TrueForge Issue #508 (Premature Turn Cancellation on Duplicate Input)
* **Context**: In TrueForge's server codebase (`truefoundry/trueforge#508`), `SessionHandle.createTurn` unconditionally cancels the in-flight turn with reason `cancelled-for-next-turn` *before* validating incoming requests.
* **Root Cause (Tier 1 Verified)**:
  * When a user double-clicks "Approve", or if UI approvals invoke `createTurn`, the running turn is terminated mid-stream, truncating assistant output and losing tool results.
* **Impact**: Abruptly stopped turns, lost tool responses, and corrupted session states.
* **Mitigation Specification**:
  1. **Deliver Approvals via `createTurnEvents` (Tier 2 Verified)**:
     * Never call `createTurn` to submit tool approvals.
     * Deliver approvals via:
       `client.sessions.createTurnEvents(sessionId, turnId, { events: [{ type: "user.tool_approval", toolCallId, threadId, approval: { status: "allow" } }] })`.
     * This endpoint (`POST /api/v1/sessions/:id/turns/:turnId/events`) delivers the approval event directly into the running turn without triggering turn cancellation.
  2. **Client-Side `TurnLock` Mutex**:
     * Maintain `isTurnActive: boolean` in `SessionManager`.
     * Disable prompt input and approval buttons immediately upon click.
     * Debounce all user input by at least 500ms.
     * Enqueue any secondary user prompts until `turn.done` completes.

---

### TR-04: Remote MCP Registration Blocked by TrueForge Outbound URL Policy & Local Autonomous Execution
* **Context**: The original architectural plan specified exposing editor workspace tools to TrueForge via a local HTTP/SSE loopback MCP server (`127.0.0.1:<dynamic_port>/mcp`).
* **Runtime Block Discovery (Tier 3 Runtime Blocked - BLOCKED / NOT VERIFIED)**:
  * When attempting to connect to registered loopback MCP servers, TrueForge server enforces an outbound URL security policy (SSRF protection) that restricts outbound requests to `127.0.0.1`, `localhost`, and private network IP ranges.
  * Consequently, TrueForge's internal remote MCP client could not establish connections to the loopback MCP server on `127.0.0.1`.
  * The experimental registration was cleanly rolled back using `client.settings.mcpServers.delete()`.
  * **Status**: Remote MCP end-to-end integration is explicitly classified as **BLOCKED / NOT VERIFIED** (Tier 3 Runtime Blocked).
  * **Current Reality**: The extension does **not** currently register a remote MCP server, attach MCP tools to sessions, or use MCP for autonomous workspace operations. The current local tool protocol does **not** satisfy native MCP integration.
* **Current Working Autonomous Architecture (Tier 4 Live Verified for Local Chaining)**:
  * Autonomous workspace tools are implemented locally in the VS Code extension using `src/agent/WorkspaceTools.ts` (`list_files`, `read_file`, `search_code`, `propose_edit`) and orchestrated by `src/agent/AutonomousAgentCoordinator.ts`.
  * The coordinator communicates with TrueForge via standard multi-turn session streaming:
    1. Formats user task with available tool schemas and protocol.
    2. Model emits structured text: `PLAN:`, `TOOL_CALL: { "tool": "<name>", "arguments": { ... } }`, and `COMPLETION:`.
    3. Coordinator parses the tool call from text, executes the tool locally in-process through `WorkspaceTools.ts` within validated workspace boundaries, and feeds tool output back into the next model turn as `[TOOL RESULT for <name>]: ...`.
    4. When `propose_edit` is called, the coordinator routes the proposal to `InlineEditManager.ts` to stage the diff in VS Code's native diff editor.
  * **Protocol Transparency**: This workflow operates via structured prompt protocol parsing and multi-turn streaming; it is **not** native provider function calling and **not** remote MCP execution.
* **Preservation of Intended MCP Architecture as Proposed Future Plan**:
  * The local loopback MCP bridge implementation (`src/mcp/LocalMcpBridge.ts`, `src/mcp/McpSecurity.ts`) is preserved in the repository as a proposed future integration plan if TrueForge introduces an explicit loopback allowlist or configuration toggle.
  * It remains documented below for future validation:
    1. **Loopback Only**: Server binds strictly to `127.0.0.1:<dynamic_port>/mcp`. Rejects any non-loopback interface.
    2. **Multi-Instance Isolation**: Standardized high-entropy naming convention `vscode-tools-${instanceId}` where `instanceId = crypto.randomBytes(16).toString("hex")`.
    3. **Safe Deactivation & Hardened Stale Cleanup Policy**: On deactivation, deletes only own registration `vscode-tools-${instanceId}`. Automatic PID-based cleanup remains marked as unimplemented; stale registrations left untouched for manual review.
    4. **Per-Instance Bearer Token**: Generated via `crypto.randomBytes(32).toString('hex')`; validated on every request via constant-time `crypto.timingSafeEqual`.
    5. **Host Header Validation**: Rejects requests where `Host` is not `127.0.0.1:<port>` or `localhost:<port>`.
    6. **Secret Redaction**: Token is masked in all logs (`[REDACTED_AUTH_TOKEN]`).
    7. **Server-Side Token Storage & Removal**: The extension never independently persists the token (held strictly in-memory); TrueForge server-side registration persists it in `data/trueforge.sqlite` as unencrypted JSONB. Calling `client.settings.mcpServers.delete("vscode-tools-" + instanceId)` removes the record and token row from SQLite.
    8. **Smoke Test Sequence**: The 7-step smoke test (`read_smoke_test_file`) remains specified as the future integration gate when loopback egress is permitted by TrueForge.

---

### TR-05: Windows Filesystem Escapes (Junctions, Symlinks, UNC, TOCTOU)
* **Context**: Operating on arbitrary user repositories across different drives (e.g. `pallets/flask`).
* **Root Cause & Live Verification (Tier 4 Live Verified)**: Windows NTFS supports directory junctions (`mklink /J`), symlinks, and UNC paths (`\\server\share`). An attacker or malicious repository file could introduce a symlink pointing to sensitive system files.
* **Mitigation Implementation (`WorkspaceTools` & `WorkspaceContextDiscovery`)**:
  1. **Dynamic Workspace Containment**: Validates all paths against authoritative workspace root resolved fail-closed from `vscode.workspace.workspaceFolders`.
  2. **Canonical Realpath Resolution**: Resolves canonical physical paths via `path.resolve(this.workspaceRoot, args.path)` and verifies containment with case-insensitive boundary checks.
  3. **Path Traversal Blocking**: Rejects path traversal attempts (e.g. `../../`, absolute paths outside root) with `OUT_OF_BOUNDS`.
  4. **Protected File Shielding**: Blocks reading or editing `.env`, `.git`, `node_modules`, and TrueForge database files (`data/trueforge.sqlite`) with `ACCESS_RESTRICTED` or `PROTECTED_FILE`.
  5. **Proposal-Only Edits**: `propose_edit` stages changes exclusively into `InlineEditManager` memory; no file writes occur without human review and acceptance. Rejection was visually verified in tests with the original file remaining untouched; edit application uses `vscode.WorkspaceEdit` without claiming fault-tested atomicity.

---

### TR-06: Windows Process Execution Vulnerabilities (`TestTools`)
* **Context**: Execution of arbitrary shell commands or test runners on Windows.
* **Current Implementation Scope (Tier 5: Unimplemented in Current Release)**:
  * The current working `WorkspaceTools.ts` implements file exploration, reading, searching, and diff proposals (`list_files`, `read_file`, `search_code`, `propose_edit`).
  * Process execution tools such as `run_tests` and autonomous terminal execution are **not implemented** in the current extension codebase.
  * Process execution risks and mitigations remain documented for future test-runner extensions:
    1. **No Shell Concatenation**: Invoking `spawn(executable, argsArray, { cwd, shell: false })`.
    2. **Exact Command Approval**: Displaying exact executable, arguments, and working directory in a modal dialog before execution.
    3. **Working Directory Containment**: Validating `cwd` is within the active workspace root.
    4. **Timeouts & Output Truncation**: Enforcing execution cutoff and buffer limits.
    5. **Windows Tree Termination**: Terminating full process tree via `taskkill /F /T /PID <pid>`.
    6. **Audit Records**: Logging command, args, cwd, timestamp, exit code, and approval in `AuditLogger`.

---

### TR-07: Dropped SSE Streams & State Desynchronization
* **Context**: Network sleep or socket drops can interrupt the Server-Sent Events stream from `http://localhost:8790`.
* **Root Cause & Built-In Reconnection (Tier 1 Verified)**:
  * `Stream.js` in `@truefoundry/trueforge-sdk` lines 44–70 provides built-in reconnection logic with `DEFAULT_MAX_RECONNECTION_ATTEMPTS = 5` and exponential backoff respecting the `retry:` directive.
* **Mitigation Specification**:
  1. Enable SDK stream reconnection when available.
  2. If the stream disconnects unexpectedly before `turn.done` and cannot reconnect, call `client.sessions.getTurn(sessionId, turnId)` to check authoritative session state.
  3. Call `client.sessions.listTurnEvents(sessionId, turnId)` to fetch any events missed during disconnection and catch up the UI.

---

## 4. Revision History

| Version | Date | Changes / Notes |
| :--- | :--- | :--- |
| 2.2.9 | 2026-11-20 | **Pre-Commit Implementation Alignment**: (1) Updated TR-04 to reflect that remote MCP registration was blocked by TrueForge's outbound 127.0.0.1 policy and rolled back; documented working local autonomous tools (`WorkspaceTools.ts`, `AutonomousAgentCoordinator.ts`) using structured text protocol, and explicitly noted local protocol does not satisfy native MCP integration. (2) Updated TR-05 to reflect visual rejection verification and `WorkspaceEdit` application without claiming SHA-256 assertions or fault-tested atomicity. (3) Clarified TR-06 that `run_tests` and autonomous terminal execution do not exist in the codebase. (4) Qualified TR-02 to state `maxRetries: 2` applies to initial HTTP requests only. |
| 2.2.8 | 2026-11-19 | **Session Lifecycle & Rebinding Hardening**: (1) Investigated session rebinding (`sessions.update`): classified as Tier 2 SDK / Tier 1 Code verified, but Tier 5 Unverified at runtime. (2) Defined explicit lifecycle across activations and reloads: sessions tied to a prior instance's registration must not execute repository tools; restored sessions display historical transcripts in read-only mode; active turns trigger fresh Option A sessions bound to `vscode-tools-${currentInstanceId}` with `workspaceState` migration. (3) Reaffirmed clean deactivation deletes only own registration and interrupted shutdowns remain under manual cleanup. |
| 2.2.7 | 2026-11-19 | **Phase 0 Final Refinements**: (1) Defined consistent session creation strategy across all phases (Phase 1–7): Option A inline session specification preferred without mutating registry agent. (2) Clarified stale-registration policy: automatic PID-based cleanup marked as unimplemented; stale registrations kept manual. |
| 2.2.6 | 2026-11-19 | Phase 0 Final Sign-Off Hardening: Corrected database and token persistence wording; hardened cleanup policy; confirmed Phase 3 replaces smoke-test tool with production suite. |
| 2.2.5 | 2026-11-19 | Phase 0 Finalization: Updated TR-04 with verified unencrypted SQLite JSONB storage details and physical disk zeroing/WAL block caveat upon DELETE. |
| 2.2.4 | 2026-11-19 | Verified TrueForge MCP persistence in SQLite `mcp_server` table via source inspection. |
| 2.2.3 | 2026-11-19 | Hardened temporary Phase 1 smoke-test tool and separated baseline environment tiers from extension behavior. |
| 2.2.2 | 2026-11-19 | Introduced temporary minimal read-only smoke-test tool in Phase 1. |
| 2.2.1 | 2026-11-19 | Corrected token disposal specifications and inline spec contracts. |
| 2.2.0 | 2026-11-19 | Comprehensive Phase 0 technical risks revision for Techfest Forge-a-thon. |
