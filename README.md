# FORGEX: Editor-Native Autonomous AI Coding Agent for VS Code

**Official Submission by Team FORGEX for the IIT Bombay Techfest 2026–27 TrueFoundry Forge-a-thon (Round 1)**

FORGEX is an autonomous, editor-native AI coding assistant built as a Visual Studio Code extension. It integrates directly with the **TrueForge Local Engine**, utilizing TrueForge as the central agent harness for session state, turn lifecycle management, instruction policies, and model provider routing.

---

## 1. Project Overview & Problem Statement

Modern AI coding assistants often suffer from two major architectural flaws:
1. **Unbounded Autonomy & Silent Writes**: Agents directly modify files on disk without presenting a side-by-side diff review, risking silent code corruption and regression.
2. **Provider Lock-In & Naive Prompting**: Assistants either hardcode specific proprietary LLM vendor SDKs inside the extension or dump the entire repository into context, causing latency spikes and context window exhaustion.

**The FORGEX Solution**:
FORGEX solves these challenges by providing an editor-native bridge to the TrueForge harness:
- **Review-First Staging**: All code proposals are staged in virtual memory (`trueforge-diff://`) and reviewed via native VS Code diff editors. Zero bytes are written to disk without explicit human approval.
- **TrueForge-as-Harness**: The extension contains zero vendor model SDKs. All model routing (Gemini, Claude, GPT, Ollama) and session streaming are managed by the local TrueForge engine.
- **Fail-Closed Security**: Traversal attacks, secret files (`.env`, `.sqlite`, `.pem`, `id_rsa`), and parent directories are strictly blocked by canonical path confinement.
- **Autonomous Multi-File Discovery**: The agent explores repositories using Model Context Protocol (MCP) tools, discovering and staging multi-file changes without requiring users to name every affected file.

---

## 2. Main Capabilities

- **Inline Edit (`Ctrl+Shift+P` -> `TrueForge: Inline Edit Selection`)**:
  - Highlights active code or targets cursor lines.
  - Generates focused diffs with enclosing function/class context within a strict 3,500 token budget.
  - Opens native VS Code diff review; accepts or rejects cleanly with zero unapproved disk writes.
- **Autonomous Multi-File Agent Mode**:
  - Multi-turn coordinator loop with tool chaining, loop detection, and configurable iteration limits (1–30, default 15).
  - Explores workspace using MCP tools (`list_files`, `read_file`, `search_code`, `propose_edit`).
  - Stages multi-file edits into a pending review queue with individual per-file review and accept/reject controls.
- **Bidirectional MCP Bridge**:
  - Local HTTP loopback MCP server listening on `127.0.0.1:8799`.
  - Authenticated via ephemeral bearer token with constant-time verification (`crypto.timingSafeEqual`).
  - Dynamic registration with TrueForge backend via `McpConnectorRegistrar`.
- **Cancellation & Responsiveness**:
  - Linked to VS Code `CancellationToken` and `AbortController`.
  - Aborting mid-generation releases all locks instantly, aborts remote turns, and leaves workspace files bit-for-bit identical to baseline.
- **Offline Resilience**:
  - When the TrueForge server is unreachable or offline, the extension fails safely with informative error toasts, releases locks immediately, and leaves workspace files 100% untouched.

---

## 3. System Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                 VS Code Extension Host                      │
│                                                             │
│  ┌───────────────────────┐       ┌───────────────────────┐  │
│  │  Sidebar Chat Webview │       │   Inline Edit Manager │  │
│  │   & Markdown Stream   │       │  (trueforge-diff://)  │  │
│  └───────────┬───────────┘       └───────────▲───────────┘  │
│              │                               │              │
│  ┌───────────▼───────────────────────────────┴───────────┐  │
│  │         Autonomous Agent Coordinator Loop             │  │
│  │   (Tool Dispatch, Loop Detection, Cancel Token)       │  │
│  └───────────┬───────────────────────────────▲───────────┘  │
│              │                               │              │
│  ┌───────────▼───────────┐       ┌───────────┴───────────┐  │
│  │ Context Assembler &   │       │   Local Loopback MCP  │  │
│  │ Workspace Discovery   │       │   Bridge (:8799/mcp)  │  │
│  └───────────────────────┘       └───────────▲───────────┘  │
└──────────────────────────────────────────────┼──────────────┘
                       REST / SSE              │ tools/call
                       (Turns, Sessions)       │ (Bearer Auth)
                                               │
┌──────────────────────────────────────────────▼──────────────┐
│             TrueForge Local Engine (:8790)                  │
│                                                             │
│  ┌───────────────────────┐       ┌───────────────────────┐  │
│  │ Agent Harness Engine  │       │ Turn & Session Mgr    │  │
│  │     ('forgeagent')    │       │ (SSE Event Streaming) │  │
│  └───────────┬───────────┘       └───────────▲───────────┘  │
│              │                               │              │
│  ┌───────────▼───────────────────────────────┴───────────┐  │
│  │ Remote MCP Client Connector ('vscode-tools')          │  │
│  └───────────────────────────┬───────────────────────────┘  │
└──────────────────────────────┼──────────────────────────────┘
                               │ Inference
┌──────────────────────────────▼──────────────────────────────┐
│                    Model Provider Gateway                   │
│        (Google Gemini / Anthropic Claude / OpenAI / Ollama) │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. How TrueForge is Used as the Agent Harness

TrueForge is the central execution brain and agent harness:
1. **Agent Definition**: TrueForge hosts the agent specification (`forgeagent`, ID: `01m7t1cn7kxveffccxp2exv0me`), including system instructions, tool access rules, and reasoning configurations.
2. **Session & Turn State**: The extension creates a session (`POST /api/v1/sessions`) and posts turn requests (`POST /api/v1/sessions/{id}/turns`). TrueForge maintains turn history and event logs.
3. **SSE Event Streaming**: Server-Sent Events stream real-time tokens (`model.message`), tool execution requirements (`tool.response_required`), and completion events (`turn.done`).
4. **Tool Orchestration**: TrueForge natively connects to the extension's loopback MCP connector (`vscode-tools`) to call workspace tools over HTTP.
5. **Provider Agnostic**: TrueForge handles LLM authentication and rate limiting. The extension remains decoupled from vendor SDKs.

---

## 5. Prerequisites

- **Operating System**: Windows 10/11, macOS, or Linux.
- **Node.js**: v18.0.0 or higher (v20+ / v26 LTS recommended).
- **npm**: v9.0.0 or higher.
- **Visual Studio Code**: v1.90.0 or higher.
- **Python** (optional, for running evaluation benchmarks): Python 3.10+ with `pytest`.

---

## 6. Installation Instructions

1. **Clone the repository**:
   ```bash
   git clone https://github.com/RIVALSANKALP/trueforge-ai-code-assistant.git
   cd trueforge-ai-code-assistant
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Compile the extension**:
   ```bash
   npm run compile
   ```

---

## 7. How to Start TrueForge Locally

Start the official TrueForge local daemon using `npx`:

```bash
npx @truefoundry/trueforge@latest
```

By default, TrueForge starts on `http://localhost:8790`. Verify the server is running by opening `http://localhost:8790` in your browser or executing:

```bash
curl http://localhost:8790/api/v1/capabilities
```

---

## 8. How to Configure a Model in TrueForge

TrueForge supports Google Gemini, OpenAI, Anthropic, and local Ollama models.

1. Open TrueForge web UI at `http://localhost:8790` and navigate to **Settings** -> **Model Providers**.
2. Add your provider (e.g., Google Gemini) and input your API key.
3. Example configuration templates are available in [`config/model-provider.example.json`](config/model-provider.example.json).

*(Note: API keys are securely stored in TrueForge's local database and are never accessible to the VS Code extension).*

---

## 9. How to Load the Agent Definition

The official `forgeagent` manifest is included in [`config/agent.json`](config/agent.json).

To load or update the agent definition in TrueForge:
```bash
curl -X POST http://localhost:8790/api/v1/agents \
  -H "Content-Type: application/json" \
  -d @config/agent.json
```

Or configure it via the TrueForge UI under **Agents** -> **New Agent**, setting the name to `forgeagent` and enabling the `vscode-tools` MCP server.

---

## 10. How to Run in VS Code Extension Development Host

1. Open the project root folder in VS Code:
   ```bash
   code .
   ```
2. Press **F5** (or open the **Run and Debug** view and select **"Run Extension"**).
3. A new **[Extension Development Host]** VS Code window will launch with TrueForge activated.
4. Verify the status bar displays: `TrueForge: Connected (forgeagent)`.
5. Open any project workspace in the Extension Host window to begin coding.

---

## 11. Connecting & Registering Local Workspace Tools

The extension automatically starts its local loopback MCP bridge on port `8799` (or an OS-assigned dynamic fallback port) and synchronizes the connection with TrueForge.

To manually re-synchronize or verify the MCP connector at any time:
1. In the Extension Host, open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`).
2. Run: **`TrueForge: Register Local MCP Connector`**.
3. The extension registers `vscode-tools` with TrueForge using its active ephemeral bearer token, verifying all four workspace tools:
   - `list_files`
   - `read_file`
   - `search_code`
   - `propose_edit`

---

## 12. How to Run Tests

The repository includes comprehensive automated test suites covering context discovery, inline edits, autonomous agent coordination, MCP security, and turn streaming:

```bash
# 1. Type check
npm run check-types

# 2. Compile bundle
npm run compile

# 3. Run Context & Inline Edit Test Suite (290 tests)
npm run test-milestone2

# 4. Run Autonomous Agent & Multi-File Loop Test Suite (81 tests)
npm run test-milestone3

# 5. Run MCP Server & Security Test Suite (68 tests)
npm run test-mcp

# 6. Run Turn Response & Protocol Test Suite (62 tests)
npm run test-turn-response
```

**Total Automated Tests**: **501 passed, 0 failed**.

---

## 13. Security Considerations

- **Zero Unauthorized Disk Writes**: Propose edit operations stage virtual diffs in memory; disk writes require explicit user acceptance.
- **Fail-Closed Boundary**: Workspace path checks block directory traversal (`../`), external absolute paths, and junction/symlink escapes.
- **Automatic Secret Shielding**: `.env*`, `*.pem`, `id_rsa*`, `*.sqlite`, `.git`, and `node_modules` are automatically blocked from LLM context and file tools.
- **MCP Loopback Security**: The local MCP bridge binds exclusively to `127.0.0.1`, validates `Host` headers to prevent DNS rebinding, and verifies requests using constant-time token comparison (`crypto.timingSafeEqual`).
- **Credential Masking**: All bearer tokens and keys are scrubbed from extension logs (`[REDACTED_AUTH_TOKEN]`).

---

## 14. Known Limitations

- **No Interactive `@file` / `@symbol` Autocomplete**: Context discovery is currently performed programmatically by the coordinator rather than through `@-mentions` in the chat input.
- **Terminal Execution Sandboxing**: Phase 2 command execution (`run_command`) is designed but excluded from Round 1 to prioritize diff safety.
- **Multi-Model Failover**: The extension reports connection errors gracefully under server offline conditions, but does not yet automatically retry against a secondary cloud model.

---

## 15. Repository Structure

```text
├── config/
│   ├── agent.json                    # TrueForge agent definition manifest
│   ├── model-provider.example.json   # Template for model providers (Gemini, OpenAI, Claude, Ollama)
│   └── mcp-connector.json            # vscode-tools MCP connector schema
├── media/
│   └── icon.svg                      # Extension activity bar icon
├── src/
│   ├── agent/
│   │   ├── AutonomousAgentCoordinator.ts # Multi-turn loop, tool chaining, loop detector
│   │   └── WorkspaceTools.ts         # Local file exploration, reading, diff proposals
│   ├── connection/
│   │   ├── HealthProbe.ts            # Server health polling
│   │   └── TrueForgeConnection.ts    # REST / SSE client wrapper around TrueForge SDK
│   ├── context/
│   │   ├── ContextAssembler.ts       # Token budgeting and context packaging
│   │   └── WorkspaceContextDiscovery.ts # Canonical path resolution & secret filtering
│   ├── diff/
│   │   └── InlineEditManager.ts      # Virtual diff provider & multi-file review queue
│   ├── mcp/
│   │   ├── LocalMcpBridge.ts         # Loopback MCP HTTP server on 127.0.0.1:8799
│   │   ├── McpConnectorRegistrar.ts  # TrueForge MCP connector synchronization
│   │   ├── McpLifecycleManager.ts    # Process lifecycle and port management
│   │   └── McpSecurity.ts            # Constant-time auth & token masking
│   ├── test/                         # Unit, integration, and mock test harnesses
│   ├── ui/
│   │   └── SidebarChatProvider.ts    # Webview chat UI and markdown stream renderer
│   └── extension.ts                  # Main extension activation & command registry
├── submission/                       # Official Round 1 submission documents & evidence
│   ├── TrueForge_Forgeathon_Round1_Writeup.docx # Official 3-page submission report
│   ├── TrueForge_Forgeathon_Round1_Writeup.pdf  # Official 3-page submission PDF
│   ├── ROUND1_QA_REPORT.md           # Complete QA audit report
│   ├── TEST_RESULTS.md               # Detailed breakdown of all 597 passing tests
│   ├── RECORDING_GUIDE.md            # Visual storyboard, timing script & recording guide
│   └── evidence/                     # Evidence packages for Tasks A, B, and C
├── esbuild.js                        # Bundler configuration
├── package.json                      # VS Code manifest, commands, settings, dependencies
└── tsconfig.json                     # TypeScript configuration
```
