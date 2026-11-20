# TrueForge VS Code Extension

**Autonomous Editor-Native AI Coding Assistant**  
*Techfest Forge-a-thon 2026 Project*

---

## Overview

The TrueForge VS Code Extension integrates the TrueForge autonomous agent platform directly into Visual Studio Code. TrueForge acts as the sole agent harness and execution engine (`http://localhost:8790`), providing model inference, reasoning, and context-driven software engineering capabilities.

## Current Architecture & Implementation

- **Sole Agent Harness**: TrueForge server runs all model inference and session management. Zero direct LLM vendor SDKs are loaded in the extension.
- **Local Autonomous Workspace Tools**: Autonomous repository operations are executed locally within the VS Code extension by `WorkspaceTools.ts` and orchestrated by `AutonomousAgentCoordinator.ts`. (Note: `run_tests` and autonomous terminal execution do not exist in the current codebase; `WorkspaceTools.ts` implements file exploration, reading, searching, and diff proposals only).
- **Structured Text Protocol**: Multi-step agent execution uses a structured text protocol. The coordinator prompts the agent, parses `PLAN:`, `TOOL_CALL:`, and `COMPLETION:` text blocks, executes tools locally (`list_files`, `read_file`, `search_code`, `propose_edit`), and streams results back into subsequent turns (`[TOOL RESULT for <tool>]`). This operates via structured prompt interaction, not native provider function calling or remote MCP execution.
- **Safe Inline Diff Proposals**: Proposed file modifications are staged into a virtual document provider (`trueforge-diff://`) via `InlineEditManager.ts`. Changes are presented in VS Code's native side-by-side diff editor for human review. No original project files are modified until explicit human acceptance.
- **Workspace Boundary Enforcement**: Fail-closed workspace root resolution (`resolveAuthoritativeWorkspaceRoot`) ensures tools only operate within the active project workspace. Path traversal, junction escapes, and attempts to modify protected files are blocked.
- **Strict Database Boundary**: `data/trueforge.sqlite` is owned exclusively by the TrueForge runtime. The extension never directly accesses, reads, or modifies SQLite files.
- **Remote MCP Architecture (Proposed / Blocked)**: The original intended architecture included registering a local loopback MCP server (`127.0.0.1`) with TrueForge. Remote MCP registration was blocked by TrueForge server's outbound URL policy restricting connections to loopback/private IP addresses (`127.0.0.1`), and the experimental registration was cleanly rolled back. The extension does not currently register a remote MCP server, attach MCP tools to sessions, or use MCP for autonomous workspace operations. The current local tool protocol does not satisfy native MCP integration. The MCP bridge design is preserved as a proposed future integration path pending platform-level resolution.
- **HTTP Transport Retries**: Basic HTTP retries (`maxRetries: 2`) are configured via the TrueForge SDK, covering initial HTTP request fetching. They do not guarantee mid-stream SSE connection recovery or model-turn replay on capacity errors.

## Verification Status

- [x] **TrueForge Health & Chat Streaming**: Live verified against running TrueForge server (`http://localhost:8790`).
- [x] **Authoritative Workspace Root Isolation**: Live verified with fail-closed protection and dedicated workspace configuration.
- [x] **Autonomous Read-Only Tool Chaining**: Live verified across successive turns (`list_files`, `read_file`, `search_code`).
- [x] **Inline Diff Proposal Staging**: Live verified (`propose_edit` stages diffs in memory without touching disk).
- [x] **Diff Review Reject Workflow**: Visually verified in Extension Development Host (discards proposal; original file remained unchanged in the observed test; no automated hash assertion is claimed for the live extension).
- [x] **Diff Review Accept Workflow**: Visually verified and saved (applies changes via `vscode.WorkspaceEdit`; fault-tested atomicity is not claimed).
- [x] **Client-Side Cooperative Cancellation**: Live verified (coordinator flag halts execution loop and unlocks UI).
- [ ] **Server-Side Cancellation Confirmation**: Pending verification (confirmation of server turn cancellation state).
- [ ] **Resilience Testing (Turn-Level 503 Retries)**: Pending implementation.
- [ ] **Remote MCP Registration & Tool Attachment**: **BLOCKED / NOT VERIFIED** (TrueForge outbound 127.0.0.1 policy).
- [ ] **Process Execution (`run_tests`)**: Unimplemented in current release.

## Development Scripts

- `npm run compile` — Bundles the TypeScript extension using esbuild into `dist/extension.js`.
- `npm run watch` — Runs esbuild in watch mode for active development.
- `npm run package` — Creates a minified production bundle.
- `npm run check-types` — Runs TypeScript type-checking without emitting files.
