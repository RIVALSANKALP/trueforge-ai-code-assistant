# Phase 0 Architecture Approval Checklist
**Techfest Forge-a-thon 2026 Competition Project**  
**Document Version:** 2.2.8 (Phase 0 Final Validated Checklist)  
**Date:** November 19, 2026  
**Status:** READY FOR USER APPROVAL  

---

## 1. Verification Tier Classification Framework

Every checklist assertion is grounded in our five-tier verification framework:

* **Tier 1: Source-Code Verified** — Confirmed by reading package implementation code in `trueforge-core` / `trueforge`.
* **Tier 2: SDK Declaration Verified** — Confirmed by reading TypeScript `.d.ts` declaration files in `@truefoundry/trueforge-sdk`.
* **Tier 3: Runtime Verified** — Confirmed by live execution or active probing against running TrueForge server or OS.
* **Tier 4: End-to-End Tested** — Confirmed by complete automated or manual workflow test passing end-to-end.
* **Tier 5: Pending Implementation** — Architecture specified, verified against interfaces, scheduled for implementation.

---

## 2. Technical Assertions & Verification Status

| Checklist Item | Category | Verification Tier | Evidence Source |
| :--- | :--- | :--- | :--- |
| **Installed OS & Node Toolchain** | Environment | **Tier 3: Runtime Verified** | Windows 11 (win32, x64), Node.js 26.13.1, npm 11.20.0, Git 2.50.1 confirmed via powershell. |
| **TrueForge Server Local URL** | Environment | **Tier 3: Runtime Verified** | Running on `http://localhost:8790`; version 0.185.1 verified in `package.json`. |
| **Database Ownership & State** | Environment | **Tier 3: Runtime Verified (Baseline) / Tier 5: Pending Implementation (Extension)** | `D:\TrueForge-Forgeathon\data\trueforge.sqlite` belongs exclusively to TrueForge; read-only baseline confirmed schema during Phase 0; zero direct extension access guaranteed; server-mediated persistence occurs during MCP registration/deletion. |
| **MCP Server SQLite Persistence** | MCP Storage | **Tier 1: Source-Code Verified** | `main.js` lines 16087–16140 (`putHandler`) and lines 6453–6465 (`upsertServer`). TrueForge server persists manifest and bearer token into `mcp_server` table in `data/trueforge.sqlite` as unencrypted SQLite JSONB (`jsonbBind`). |
| **MCP Server SQLite Deletion** | MCP Storage | **Tier 1: Source-Code Verified** | `main.js` lines 16142–16190 (`deleteHandler`) and lines 6466–6470 (`deleteServer`). Calls `DELETE FROM mcp_server` to remove the row. Note: removes row from schema, but physical disk zeroing of WAL/database pages is not guaranteed by SQLite. |
| **Multi-Instance Isolation & Cleanup** | Architecture | **Tier 5: Pending Implementation** | Ephemeral `vscode-tools-${instanceId}` naming with at least 16 cryptographically random bytes prevents collisions; automatic PID cleanup marked unimplemented (stale registrations left untouched for manual review); never deletes another active window's registration. |
| **Extension Zero Direct DB Access** | Architecture | **Tier 5: Pending Implementation** | Architecture strictly isolates extension from SQLite file (zero direct operations); verified via static AST audit and file handle checks during Phase 1–7. |
| **Agent ID vs Session ID Separation** | Architecture | **Tier 3: Runtime Verified (Server) / Tier 5: Pending Implementation (Extension)** | Immutable Agent ID `01m7t1cn7kxveffccxp2exv0me` (`forgeagent`); Session IDs minted per conversation (`01m7t1rwx2rzqn9vn6zv8107nb`). Extension `SessionManager` creates all sessions via Option A inline spec attaching `vscode-tools-${instanceId}` (or Option B fallback) & `workspaceState` persistence verified upon Phase 2 implementation. |
| **TrueForge Harness Compliance** | Architecture | **Tier 3: Runtime Verified (Server) / Tier 5: Pending Implementation (Extension)** | TrueForge server runs on `http://localhost:8790`. Extension compliance (zero direct LLM imports, all inference via TrueForge) verified upon implementation. |
| **TrueForge SDK Availability** | SDK | **Tier 1: Source-Code Verified** | Located in `D:\npm-cache\_npx\18da9bb0c07c9a14\node_modules\@truefoundry\trueforge-sdk`. Version 0.185.1. |
| **Session Management Methods** | SDK | **Tier 2: SDK Declaration Verified** | `Client.d.ts` verifies: `sessions.create()`, `sessions.get()`, `sessions.update()`, `sessions.list()`, `sessions.cancel()`, `sessions.getTurn()`. |
| **Session Rebinding & Reload Lifecycle** | Architecture | **Tier 2: SDK Verified / Tier 1: Source-Code Verified (Interface) / Tier 5: Pending Implementation (Runtime Rebinding)** | `sessions.update(sessionId, { agent: { spec } })` declared in SDK and implemented in `main.js`. Runtime rebinding unverified; lifecycle policy treats prior sessions as read-only historical transcripts and creates fresh Option A sessions bound to `vscode-tools-${currentInstanceId}` upon new prompt. |
| **Streaming Turns Method** | SDK | **Tier 2: SDK Declaration Verified** | `CreateTurnSessionsStreamRequest.d.ts` verifies `client.sessions.createTurnStream(sessionId, { input: [UserMessage] })` returns `Stream<TurnStreamingEvent>`. |
| **Tool Approval Delivery (Issue #508 Fix)**| SDK / API | **Tier 2: SDK Declaration Verified** | `UserToolApprovalInputEvent.d.ts` & `Client.d.ts` verify `client.sessions.createTurnEvents(sessionId, turnId, { events: [UserToolApprovalInputEvent] })` (`POST /api/v1/sessions/:id/turns/:turnId/events`). |
| **MCP Registration Endpoint** | MCP API | **Tier 1: Source-Code Verified** | `McpServersClient.js` lines 80–140 implements `createOrUpdate` via `PUT api/v1/settings/mcp-servers`. |
| **MCP Deletion Endpoint** | MCP API | **Tier 1: Source-Code Verified** | `McpServersClient.js` lines 415–435 implements `delete(name)` via `DELETE api/v1/settings/mcp-servers/:name`. Returns `{}`. |
| **MCP Manifest Schema & Auth Support** | MCP Protocol | **Tier 2: SDK Declaration Verified** | `RemoteMcpServerManifest.d.ts` line 7: `type: "remote"; url: string; auth?: McpServerManifestAuth;`. `McpServerHeaderAuth.d.ts`: `headers: Record<string, string>; type: "header";`. |
| **TrueForge MCP Client Transports & Auth** | MCP Protocol | **Tier 1: Source-Code Verified** | `remoteMcpClient.js` line 44: `TRANSPORT_PROBE_ORDER = ["streamable-http", "sse"]`. Line 82 forwards headers on all requests. |
| **Agent Retrieval & Update** | SDK / API | **Tier 2: SDK Declaration Verified** | `AgentsClient.d.ts`: `client.agents.get(id)` and `client.agents.update(id, { manifest })`. Primary path for reversible attachment. |
| **Inline Spec Server Logic** | Runtime Logic | **Tier 1: Source-Code Verified** | `SessionHandle.js` line 345: `agent.type === "inline" ? agent.spec : ...`. Runtime tool resolution pending Phase 1 smoke test. |
| **MCP Runtime Handshake & Tool Call** | MCP Protocol | **Tier 5: Pending Implementation** | Interface, auth, and transport verified; runtime connectivity & minimal tool execution smoke test scheduled for Phase 1 (full 5 tools in Phase 3). |
| **Local Container Sandbox Incompatibility**| Runtime | **Tier 3: Runtime Verified** | Throws `LocalSandboxProvider supports macOS and Linux only (got win32)`. `forgeagent` manifest has `sandbox: { enabled: false }`. |
| **SDK Built-in Retries** | Resilience | **Tier 2: SDK Declaration Verified** | `BaseClient.d.ts` line 14: `maxRetries?: number` defaults to 2; `stream: { reconnectionEnabled: true }`. |
| **SSE Reconnection Logic** | Resilience | **Tier 1: Source-Code Verified** | `core/stream/Stream.js` lines 44–70 implements `shouldReconnect`, `delayReconnect`, and `DEFAULT_MAX_RECONNECTION_ATTEMPTS = 5`. |
| **Turn-Level 503 Recovery & Partial Checks**| Resilience | **Tier 5: Pending Implementation** | Architecture inspects `getTurn()` history before retrying to prevent duplicate tool execution; scheduled for Phase 6. |
| **Dynamic Workspace Path Security** | Security | **Tier 5: Pending Implementation** | Architecture uses `vscode.workspace.workspaceFolders`, `fs.realpathSync`, junction checks, and case normalization; scheduled for Phase 3. |
| **Loopback MCP Bearer Auth & Host Checks** | Security | **Tier 5: Pending Implementation** | Architecture uses in-memory bearer token, constant-time `timingSafeEqual`, and `Host` validation; scheduled for Phase 1. |
| **Safe Process Execution with shell: false**| Security | **Tier 5: Pending Implementation** | Architecture uses `spawn(executable, argsArray, { shell: false })`, working dir checks, 60s timeout, and `taskkill`; scheduled for Phase 3. |
| **Product Mandatory Capabilities 1–5** | Product Spec | **Tier 5: Pending Implementation** | Specification baseline verified from product requirements; full extension capability verified across Phases 1–5. |
| **Competition Round 1 Brief Alignment** | Competition | **Awaiting Source Brief Verification** | Rubric derived from published guidelines; official PDF brief awaiting local workspace archival. |

---

## 3. Mandatory Phase 1 MCP Smoke Test Checklist

Before Phase 1 is deemed complete, the following 7-step smoke test must be executed and logged using a temporary minimal read-only `read_smoke_test_file` tool strictly restricted to a fixed, extension-controlled designated test file:
- [ ] **Step 1: MCP Server Start**: Start extension-host loopback MCP server on `127.0.0.1:<dynamic_port>/mcp` with an ephemeral bearer token and instance ID (`vscode-tools-${instanceId}`), exposing only the hardened minimal read-only `read_smoke_test_file` tool (exact parameter-free schema `{ "type": "object", "properties": {}, "additionalProperties": false }`; zero write/delete/traverse/exec; token-redacted logging).
- [ ] **Step 2: MCP Registration**: Call `client.settings.mcpServers.createOrUpdate` with name `vscode-tools-${instanceId}`, remote URL `http://127.0.0.1:<dynamic_port>/mcp`, transport `streamable-http`, and `Authorization: Bearer <token>`.
- [ ] **Step 3: Transport Connection**: Confirm TrueForge server connects to the registered loopback MCP URL using `streamable-http` with the valid bearer token.
- [ ] **Step 4: Tool Discovery**: Call `client.mcpServers.listTools("vscode-tools-" + instanceId)` and verify `read_smoke_test_file` is returned with empty inputSchema `{ "type": "object", "properties": {}, "additionalProperties": false }`.
- [ ] **Step 5: Agent Attachment**: Attempt Option A (inline session spec) first: create session passing `agent: { type: "inline", spec: { ...agentManifest, mcpServers: [{ name: "vscode-tools-" + instanceId }] } }`. If inline tool resolution fails or is unsupported at runtime, prompt for explicit user confirmation, backup original manifest, and use Option B (registry update fallback).
- [ ] **Step 6: Execution Trigger**: Safe provisioning writes `<workspaceRoot>/.trueforge-smoke-test.txt` with marker `TRUEFORGE_SMOKE_TEST_OK_2026` using exclusive flag `{ flag: "wx" }` (aborts if file exists); extension initiates a single turn prompting `forgeagent` to inspect the designated test file using `read_smoke_test_file`.
- [ ] **Step 7: End-to-End Result Verification**: Assert loopback server receives the authenticated tool call, reads the designated test file, records returned marker `TRUEFORGE_SMOKE_TEST_OK_2026`, TrueForge streams response citing the marker, and teardown cleanly removes the test file and deletes `vscode-tools-${instanceId}` registration row.

> [!NOTE]
> **Temporary Tool Hardening, Safe Provisioning & Lifecycle**:
> * **Schema**: Exact parameter-free schema `{ "type": "object", "properties": {}, "additionalProperties": false }`. Zero arguments accepted; no aliases.
> * **Safe Provisioning**: Designated file `<workspaceRoot>/.trueforge-smoke-test.txt` is provisioned prior to the test by the test harness via `fs.writeFileSync(smokeTestFilePath, "TRUEFORGE_SMOKE_TEST_OK_2026", { flag: "wx" })`. If the file already exists (`EEXIST`), the harness aborts immediately to avoid modifying existing files. Sets in-memory flag `createdSmokeTestFile = true`.
> * **Strictly Read-Only MCP Tool**: The MCP tool is strictly read-only and never creates, modifies, writes, or deletes files.
> * **Safe Teardown**: Teardown checks content and removes `.trueforge-smoke-test.txt` only if `createdSmokeTestFile === true` and content matches `TRUEFORGE_SMOKE_TEST_OK_2026`.
> * **Lifecycle**: In Phase 3, `read_smoke_test_file` is cleanly removed, superseded and replaced by the complete five-tool suite (`read_file`, `list_directory`, `search_code`, `propose_diff`, `run_tests`) backed by full `SecurityGuard`.

---

## 4. Phase 1 Mandatory Rollback Checklist

If the smoke test fails, or on extension deactivation:
- [ ] **Rollback 1: Delete MCP Registration**: Call `await client.settings.mcpServers.delete("vscode-tools-" + instanceId)` (deletes only own registration row from SQLite `mcp_server`).
- [ ] **Rollback 2: Restore Agent Manifest**: If Option B was used, call `client.agents.update("01m7t1cn7kxveffccxp2exv0me", { manifest: originalManifest })`.
- [ ] **Rollback 3: Stop HTTP/SSE Server**: Call `mcpServer.close()` and destroy all open sockets (`socket.destroy()`).
- [ ] **Rollback 4: Dispose Auth Token**: Set token pointer to `undefined` / `null` to allow V8 garbage collection; ensure the extension never independently persisted the token (TrueForge server-side registration persists it in SQLite).
- [ ] **Rollback 5: Dispose Extension Resources**: Dispose all active subscriptions, timers, and child processes.
- [ ] **Rollback 6: Verify Database Cleanup & Non-Interference**: Confirm TrueForge server deleted the `mcp_server` row upon `delete()`. Note that physical disk zeroing of WAL/database pages is not guaranteed by SQLite. Confirm extension performed zero direct database operations.

---

## 5. Final Phase 0 Readiness Assessment

* **Phase 0 Status**: **ARCHITECTURE AND PLANNING COMPLETED & VALIDATED**.
* **Phase 1 Implementation**: **PENDING EXPLICIT USER APPROVAL**.
* **MCP Runtime Handshake**: **PENDING PHASE 1 IMPLEMENTATION (TIER 5)**.
* **MCP Tool Execution**: **PENDING PHASE 1 IMPLEMENTATION (TIER 5)**.
* **TrueForge SQLite Database Ownership**: **EXCLUSIVELY TRUEFORGE-OWNED**. Phase 0 baseline confirmed untouched (`19-11-2026 19:01:02`). Extension zero-direct-access guaranteed by design (never directly reads, writes, locks, or modifies SQLite). TrueForge server legitimately modifies its database during MCP registration (persisting manifest/token as unencrypted JSONB) and deletion (removing row; physical disk zeroing of WAL/database pages not guaranteed by SQLite).

---

## 6. Revision History

| Version | Date | Changes / Notes |
| :--- | :--- | :--- |
| 2.2.8 | 2026-11-19 | **Session Lifecycle & Rebinding Hardening**: (1) Investigated session rebinding (`sessions.update`): classified as Tier 2 SDK / Tier 1 Code verified, but Tier 5 Unverified at runtime. (2) Defined explicit lifecycle across activations and reloads: sessions tied to a prior instance's registration must not execute repository tools; restored sessions display historical transcripts in read-only mode; active turns trigger fresh Option A sessions bound to `vscode-tools-${currentInstanceId}` with `workspaceState` migration. (3) Reaffirmed clean deactivation deletes only own registration and interrupted shutdowns remain under manual cleanup. |
| 2.2.7 | 2026-11-19 | **Phase 0 Final Refinements**: (1) Defined consistent session creation strategy across all phases (Phase 1–7): Option A inline session specification (`agent: { type: "inline", spec: ... }`) preferred for all sessions requiring workspace tools, explicitly attaching `vscode-tools-${instanceId}` without mutating registry agent; documented Option B fallback requiring in-memory backup and modal confirmation dialog. (2) Clarified stale-registration policy: automatic PID-based cleanup marked as unimplemented (no process table assumptions); stale registrations kept strictly manual and never deleted on single probe failure. |
| 2.2.6 | 2026-11-19 | **Phase 0 Final Sign-Off Hardening**: (1) Corrected database and token persistence wording: reaffirmed extension never independently persists token (TrueForge server-side registration persists it in SQLite as unencrypted JSONB); confirmed DELETE removes row without guaranteeing physical disk zeroing. (2) Hardened cleanup policy: increased instance randomness to at least 16 cryptographically random bytes (`crypto.randomBytes(16).toString("hex")`); prohibited deleting registrations on single probe failure; require conclusive ownership before removal, otherwise leave untouched for manual review. (3) Explicitly confirmed Phase 3 replaces `read_smoke_test_file` with production five-tool suite. |
| 2.2.5 | 2026-11-19 | **Phase 0 Finalization**: (1) Updated technical assertions table with unencrypted SQLite JSONB storage and physical WAL/disk zeroing caveat upon DELETE. (2) Added multi-instance isolation checklist entry. (3) Unified 7-step smoke test with single parameter-free `read_smoke_test_file` schema, collision-safe `{ flag: "wx" }` provisioning, and verified teardown. (4) Updated rollback checklist for per-instance deletion (`vscode-tools-${instanceId}`). |
| 2.2.4 | 2026-11-19 | Verified TrueForge MCP persistence in SQLite `mcp_server` table via source inspection. |
| 2.2.3 | 2026-11-19 | Hardened temporary Phase 1 smoke-test tool and corrected verification tier overclaims. |
| 2.2.2 | 2026-11-19 | Introduced temporary minimal read-only smoke-test tool to decouple Phase 1 transport verification from Phase 3 tool suite. |
| 2.2.1 | 2026-11-19 | Verified inline agent spec contract in SDK and corrected token disposal specifications. |
| 2.2.0 | 2026-11-19 | Comprehensive Phase 0 approval checklist revision for Techfest Forge-a-thon. |
