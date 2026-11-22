import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { TrueForgeConnection, AgentInfo } from '../connection/TrueForgeConnection.js';
import { AutonomousAgentCoordinator, AgentTaskEvent } from '../agent/AutonomousAgentCoordinator.js';

interface ChatMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  timestamp: string;
  isStreaming?: boolean;
  error?: boolean;
}

export class SidebarChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'trueforge.chatView';

  private view?: vscode.WebviewView;
  private readonly connection: TrueForgeConnection;
  private readonly extensionUri: vscode.Uri;
  private readonly onLog?: (msg: string) => void;
  private coordinator?: AutonomousAgentCoordinator;
  private currentSessionId: string | null = null;
  private activeAgentInfo: AgentInfo | null = null;
  private isProcessing = false;
  private messages: ChatMessage[] = [];

  constructor(
    extensionUri: vscode.Uri,
    connection: TrueForgeConnection,
    onLog?: (msg: string) => void
  ) {
    this.extensionUri = extensionUri;
    this.connection = connection;
    this.onLog = onLog;
  }

  private log(msg: string): void {
    if (this.onLog) {
      this.onLog(msg);
    }
  }

  public setCoordinator(coordinator: AutonomousAgentCoordinator): void {
    this.coordinator = coordinator;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.log(`SidebarChatProvider: resolving view '${webviewView.viewType}'`);
    this.view = webviewView;

    // Handle disposal
    webviewView.onDidDispose(() => {
      this.log('SidebarChatProvider: webviewView disposed');
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      this.log(`SidebarChatProvider: received webview message '${message.type}'`);
      switch (message.type) {
        case 'ready':
          await this.handleReady();
          break;
        case 'sendMessage':
          await this.handleUserMessage(message.text);
          break;
        case 'runAutonomousTask':
          await this.handleAutonomousTask(message.task);
          break;
        case 'testConnection':
          await this.handleTestConnection();
          break;
        case 'newSession':
          await this.handleNewSession();
          break;
        case 'cancelTurn':
          await this.handleCancelTurn();
          break;
        case 'explainSelection':
          await this.handleExplainSelection();
          break;
        case 'openReview':
          await vscode.commands.executeCommand('trueforge.reviewPendingEdit');
          break;
      }
    });

    webviewView.onDidChangeVisibility(async () => {
      this.log(`SidebarChatProvider: webview visibility changed to ${webviewView.visible}`);
      if (webviewView.visible) {
        await this.refreshConnectionState();
      }
    });
  }

  public async focus(): Promise<void> {
    if (this.view) {
      this.view.show(true);
    }
  }

  public async handleReady(): Promise<void> {
    this.log('SidebarChatProvider: handleReady executing');
    await this.refreshConnectionState();
    if (this.messages.length === 0) {
      this.addSystemMessage(
        'Welcome to **TrueForge Agent Studio**!\n\n' +
        '• **Agent**: `forgeagent` (`google-gemini/gemini-3-1-flash-lite`)\n' +
        '• **Chat Mode**: Direct streaming conversations & code assistance.\n' +
        '• **Autonomous Mode**: Multi-step autonomous planning, workspace inspection, and safe diff proposals.\n' +
        '• **Safety**: All file modifications require explicit user diff review (Accept/Reject).'
      );
    } else {
      for (const msg of this.messages) {
        this.postMessageToWebview({
          type: 'appendMessage',
          message: msg
        });
      }
    }
  }

  public async refreshConnectionState(): Promise<void> {
    const health = await this.connection.checkHealth();
    if (health.ok) {
      try {
        const agent = await this.connection.getAgent();
        this.activeAgentInfo = agent ?? null;
      } catch {
        this.activeAgentInfo = null;
      }
    } else {
      this.activeAgentInfo = null;
    }

    this.postMessageToWebview({
      type: 'connectionStatus',
      connected: health.ok,
      baseUrl: this.connection.getBaseUrl(),
      agentName: this.activeAgentInfo?.name ?? 'forgeagent',
      agentId: this.activeAgentInfo?.id ?? null,
      modelName: this.activeAgentInfo?.modelName ?? 'google-gemini/gemini-3-1-flash-lite',
      sessionId: this.currentSessionId,
      error: health.error
    });
  }

  public async handleTestConnection(): Promise<void> {
    this.addSystemMessage('Testing connection to TrueForge server and `forgeagent`...');
    try {
      const health = await this.connection.checkHealth();
      if (!health.ok) {
        this.addSystemMessage(`❌ Connection failed: ${health.error}`, true);
        return;
      }

      const agent = await this.connection.getAgent();
      if (!agent) {
        this.addSystemMessage('❌ Connected to server, but `forgeagent` was not found in the database.', true);
        return;
      }

      this.activeAgentInfo = agent;
      this.addSystemMessage(
        `✅ **TrueForge Connection Verified**\n\n` +
        `• **Server**: \`${this.connection.getBaseUrl()}\` (HTTP 200)\n` +
        `• **Agent ID**: \`${agent.id}\`\n` +
        `• **Agent Name**: \`${agent.name}\`\n` +
        `• **Configured Model**: \`${agent.modelName ?? 'default'}\`\n` +
        `• **Capabilities**: Connected, ready for autonomous tasks & inline editing`
      );

      await this.refreshConnectionState();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.addSystemMessage(`❌ Test failed with error: ${msg}`, true);
    }
  }

  public async handleNewSession(): Promise<void> {
    if (this.currentSessionId) {
      const oldId = this.currentSessionId;
      this.currentSessionId = null;
      try {
        await this.connection.deleteSession(oldId);
      } catch {
        // Ignore delete errors
      }
    }

    try {
      this.currentSessionId = await this.connection.createSession();
      this.messages = [];
      this.addSystemMessage(`Started new TrueForge session: \`${this.currentSessionId}\``);
      await this.refreshConnectionState();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.addSystemMessage(`Failed to create session: ${msg}`, true);
    }
  }

  public async handleExplainSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No active editor found.');
      return;
    }

    const selection = editor.selection;
    const selectedText = editor.document.getText(selection).trim();
    const fileName = editor.document.fileName.split(/[\\/]/).pop() ?? 'file';

    if (!selectedText) {
      vscode.window.showInformationMessage('Please select some code in the editor to explain.');
      return;
    }

    const prompt = `Explain the following code from ${fileName}:\n\`\`\`${editor.document.languageId}\n${selectedText}\n\`\`\``;
    await this.handleUserMessage(prompt);
  }

  public async handleUserMessage(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.isProcessing) {
      return;
    }

    // 1. Add user message
    const userMsgId = this.generateId();
    this.messages.push({
      id: userMsgId,
      role: 'user',
      content: trimmed,
      timestamp: new Date().toLocaleTimeString()
    });
    this.postMessageToWebview({
      type: 'appendMessage',
      message: this.messages[this.messages.length - 1]
    });

    // 2. Ensure session exists
    if (!this.currentSessionId) {
      try {
        this.currentSessionId = await this.connection.createSession();
        await this.refreshConnectionState();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.addSystemMessage(`Cannot send message: Failed to create session on TrueForge: ${msg}`, true);
        return;
      }
    }

    // 3. Create placeholder agent message for streaming
    const agentMsgId = this.generateId();
    const agentMsg: ChatMessage = {
      id: agentMsgId,
      role: 'agent',
      content: '',
      timestamp: new Date().toLocaleTimeString(),
      isStreaming: true
    };
    this.messages.push(agentMsg);
    this.postMessageToWebview({
      type: 'appendMessage',
      message: agentMsg
    });

    this.isProcessing = true;
    this.postMessageToWebview({ type: 'setProcessing', processing: true });

    let fullText = '';
    try {
      fullText = await this.connection.executeTurnStream(
        this.currentSessionId,
        trimmed,
        (chunk) => {
          this.postMessageToWebview({
            type: 'streamChunk',
            id: agentMsgId,
            chunk: chunk
          });
        }
      );

      const finalContent = fullText.trim() === '' ? '*(No text response generated by agent)*' : fullText;
      agentMsg.content = finalContent;
      agentMsg.isStreaming = false;
      this.postMessageToWebview({
        type: 'streamDone',
        id: agentMsgId,
        content: finalContent
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      agentMsg.content = `Error executing turn: ${errorMsg}`;
      agentMsg.error = true;
      agentMsg.isStreaming = false;
      this.postMessageToWebview({
        type: 'streamError',
        id: agentMsgId,
        error: errorMsg
      });
    } finally {
      this.isProcessing = false;
      this.postMessageToWebview({ type: 'setProcessing', processing: false });
    }
  }

  /**
   * Executes an autonomous multi-step coding task through AutonomousAgentCoordinator.
   */
  public async handleAutonomousTask(task: string): Promise<void> {
    const trimmed = task.trim();
    if (!trimmed || this.isProcessing) {
      return;
    }

    if (!this.coordinator) {
      this.addSystemMessage('Autonomous Agent Coordinator is not initialized.', true);
      return;
    }

    this.isProcessing = true;
    this.postMessageToWebview({ type: 'setProcessing', processing: true });
    this.postMessageToWebview({ type: 'clearPlan' });

    this.addSystemMessage(`⚡ Starting Autonomous Task: "${trimmed}"`);

    try {
      const result = await this.coordinator.executeTask(trimmed, (event: AgentTaskEvent) => {
        this.postMessageToWebview({
          type: 'agentEvent',
          event
        });

        if (event.type === 'thought') {
          // Log thought to chat
        } else if (event.type === 'tool_call') {
          this.addSystemMessage(`🔧 **Tool Call**: \`${event.payload.toolName}\` (${JSON.stringify(event.payload.args)})`);
        } else if (event.type === 'tool_result') {
          const preview = event.payload.output.slice(0, 150) + (event.payload.output.length > 150 ? '...' : '');
          this.addSystemMessage(`✓ **Result**: ${preview}`);
        } else if (event.type === 'diff_ready') {
          this.addSystemMessage(`📝 **Diff Ready**: Proposed modifications for \`${event.payload.file}\`. Use editor toolbar or click below to review.`);
        }
      });

      if (result.success) {
        this.addSystemMessage(`🎉 **Task Completed**: ${result.summary}`);
      } else {
        this.addSystemMessage(`❌ **Task Failed**: ${result.error ?? result.summary}`, true);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.addSystemMessage(`❌ Autonomous task execution error: ${msg}`, true);
    } finally {
      this.isProcessing = false;
      this.postMessageToWebview({ type: 'setProcessing', processing: false });
    }
  }

  public async handleCancelTurn(): Promise<void> {
    if (this.coordinator) {
      await this.coordinator.cancel();
    }
    if (this.currentSessionId && this.isProcessing) {
      try {
        await this.connection.cancelTurn(this.currentSessionId);
      } catch {
        // Ignore cancel errors
      }
    }
    this.addSystemMessage('Task cancellation requested.');
  }

  private addSystemMessage(content: string, isError = false): void {
    const msg: ChatMessage = {
      id: this.generateId(),
      role: 'system',
      content,
      timestamp: new Date().toLocaleTimeString(),
      error: isError
    };
    this.messages.push(msg);
    this.postMessageToWebview({
      type: 'appendMessage',
      message: msg
    });
  }

  private postMessageToWebview(message: any): void {
    if (this.view) {
      this.view.webview.postMessage(message);
    }
  }

  private generateId(): string {
    return Math.random().toString(36).substring(2, 10);
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TrueForge Assistant</title>
  <style>
    :root {
      --tf-border: var(--vscode-widget-border, #454545);
      --tf-bg: var(--vscode-editor-background, #1e1e1e);
      --tf-input-bg: var(--vscode-input-background, #252526);
      --tf-fg: var(--vscode-editor-foreground, #cccccc);
      --tf-btn-bg: var(--vscode-button-background, #0e639c);
      --tf-btn-fg: var(--vscode-button-foreground, #ffffff);
      --tf-btn-hover: var(--vscode-button-hoverBackground, #1177bb);
      --tf-badge-bg: var(--vscode-badge-background, #4d4d4d);
      --tf-badge-fg: var(--vscode-badge-foreground, #ffffff);
      --tf-card-bg: var(--vscode-sideBar-background, #252526);
      --tf-user-bg: var(--vscode-button-secondaryBackground, #3a3d41);
      --tf-agent-bg: var(--vscode-editor-inactiveSelectionBackground, #2a2d30);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      height: 100%;
      width: 100%;
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      background-color: var(--tf-bg);
      color: var(--tf-fg);
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }

    /* Mode Tabs */
    .mode-bar {
      display: flex;
      border-bottom: 1px solid var(--tf-border);
      background: var(--tf-card-bg);
      flex-shrink: 0;
    }
    .mode-tab {
      flex: 1;
      padding: 8px;
      text-align: center;
      font-weight: 500;
      font-size: 11.5px;
      cursor: pointer;
      color: var(--tf-fg);
      opacity: 0.7;
      border-bottom: 2px solid transparent;
      transition: all 0.15s ease;
    }
    .mode-tab:hover { opacity: 1; }
    .mode-tab.active {
      opacity: 1;
      border-bottom-color: var(--vscode-button-background, #0e639c);
      color: #ffffff;
      font-weight: 600;
    }

    /* Header */
    .header-card {
      padding: 8px 12px;
      background: var(--tf-card-bg);
      border-bottom: 1px solid var(--tf-border);
      flex-shrink: 0;
    }
    .status-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    .status-indicator {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 600;
      font-size: 11.5px;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #888; }
    .dot.connected { background: #4ec9b0; box-shadow: 0 0 6px rgba(78, 201, 176, 0.6); }
    .dot.disconnected { background: #f14c4c; box-shadow: 0 0 6px rgba(241, 76, 76, 0.6); }
    .meta-tags { display: flex; flex-wrap: wrap; gap: 4px; font-size: 10.5px; }
    .tag { background: var(--tf-badge-bg); color: var(--tf-badge-fg); padding: 1px 5px; border-radius: 3px; }
    .tag.highlight { background: rgba(14, 99, 156, 0.3); color: #4ec9b0; border: 1px solid rgba(78, 201, 176, 0.4); }

    /* Action Toolbar */
    .toolbar {
      display: flex;
      gap: 6px;
      padding: 6px 12px;
      background: var(--tf-card-bg);
      border-bottom: 1px solid var(--tf-border);
      flex-shrink: 0;
      overflow-x: auto;
    }
    .tool-btn {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ffffff);
      border: 1px solid var(--tf-border);
      padding: 3px 8px;
      border-radius: 3px;
      font-size: 11px;
      cursor: pointer;
      white-space: nowrap;
    }
    .tool-btn:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }

    /* Plan & Step Visualization Drawer */
    .plan-card {
      display: none;
      padding: 10px 12px;
      background: rgba(14, 99, 156, 0.08);
      border-bottom: 1px solid rgba(14, 99, 156, 0.3);
      flex-shrink: 0;
      max-height: 180px;
      overflow-y: auto;
    }
    .plan-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
      color: #4ec9b0;
      display: flex;
      justify-content: space-between;
    }
    .plan-step {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 3px 0;
      font-size: 11.5px;
    }
    .step-icon { font-size: 11px; }

    /* Messages Thread */
    .messages-container {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .message {
      display: flex;
      flex-direction: column;
      max-width: 95%;
      padding: 8px 10px;
      border-radius: 6px;
      font-size: 12.5px;
      line-height: 1.45;
      word-break: break-word;
    }
    .message.user { align-self: flex-end; background: var(--tf-user-bg); color: #fff; }
    .message.agent { align-self: flex-start; background: var(--tf-agent-bg); border: 1px solid var(--tf-border); }
    .message.agent.error { border-color: #f14c4c; color: #f14c4c; background: rgba(241, 76, 76, 0.08); }
    .message.system { align-self: stretch; max-width: 100%; background: rgba(255, 255, 255, 0.03); border-left: 3px solid #0e639c; font-size: 11.5px; color: #aaa; }
    .message.system.error { border-left-color: #f14c4c; background: rgba(241, 76, 76, 0.08); color: #f14c4c; }
    .msg-header { font-size: 10px; opacity: 0.7; margin-bottom: 4px; display: flex; justify-content: space-between; }
    .msg-content { white-space: pre-wrap; }
    .cursor-blink { display: inline-block; width: 6px; height: 13px; background: currentColor; margin-left: 2px; animation: blink 1s infinite; vertical-align: middle; }
    @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }

    /* Input Footer */
    .input-container {
      padding: 10px 12px;
      background: var(--tf-card-bg);
      border-top: 1px solid var(--tf-border);
      flex-shrink: 0;
    }
    textarea {
      width: 100%;
      min-height: 52px;
      max-height: 140px;
      resize: vertical;
      background: var(--tf-input-bg);
      color: var(--tf-fg);
      border: 1px solid var(--tf-border);
      border-radius: 4px;
      padding: 6px 8px;
      font-family: inherit;
      font-size: 12px;
      outline: none;
    }
    textarea:focus { border-color: var(--vscode-focusBorder, #007acc); }
    .input-actions { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; }
    .shortcut-hint { font-size: 10.5px; opacity: 0.6; }
    button.send-btn { background: var(--tf-btn-bg); color: var(--tf-btn-fg); border: none; padding: 5px 12px; border-radius: 3px; font-size: 12px; cursor: pointer; }
    button.send-btn:hover { background: var(--tf-btn-hover); }
    button.cancel-btn { background: #c72e2e; color: white; border: none; padding: 5px 10px; border-radius: 3px; font-size: 12px; cursor: pointer; }
  </style>
</head>
<body>

  <!-- Mode Bar -->
  <div class="mode-bar">
    <div class="mode-tab active" id="tabChat">💬 Chat Mode</div>
    <div class="mode-tab" id="tabAuto">⚡ Autonomous Mode</div>
  </div>

  <!-- Header -->
  <div class="header-card">
    <div class="status-row">
      <div class="status-indicator">
        <div id="statusDot" class="dot"></div>
        <span id="statusText">Checking TrueForge...</span>
      </div>
      <button class="tool-btn" id="btnTestConn">Test Conn</button>
    </div>
    <div class="meta-tags">
      <span class="tag" id="tagServer">http://localhost:8790</span>
      <span class="tag" id="tagAgent">forgeagent</span>
      <span class="tag highlight">Controlled Tools: Active</span>
    </div>
  </div>

  <!-- Plan & Execution Stepper Card -->
  <div class="plan-card" id="planCard">
    <div class="plan-title">
      <span>Autonomous Plan</span>
      <button class="tool-btn" id="btnReviewDiff" style="display: none; padding: 1px 6px;">👁 Review Diff</button>
    </div>
    <div id="planStepsContainer"></div>
  </div>

  <!-- Action Toolbar -->
  <div class="toolbar">
    <button class="tool-btn" id="btnNewSession">＋ New Session</button>
    <button class="tool-btn" id="btnExplain">📋 Explain Selection</button>
  </div>

  <!-- Messages Thread -->
  <div class="messages-container" id="messagesContainer"></div>

  <!-- Input Area -->
  <div class="input-container">
    <textarea id="promptInput" placeholder="Ask TrueForge or instruct forgeagent..." rows="2"></textarea>
    <div class="input-actions">
      <span class="shortcut-hint" id="hintText">Enter to send, Shift+Enter for newline</span>
      <div>
        <button class="cancel-btn" id="btnCancel" style="display: none;">Stop</button>
        <button class="send-btn" id="btnSend">Send</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messagesContainer = document.getElementById('messagesContainer');
    const promptInput = document.getElementById('promptInput');
    const btnSend = document.getElementById('btnSend');
    const btnCancel = document.getElementById('btnCancel');
    const btnTestConn = document.getElementById('btnTestConn');
    const btnNewSession = document.getElementById('btnNewSession');
    const btnExplain = document.getElementById('btnExplain');
    const btnReviewDiff = document.getElementById('btnReviewDiff');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const tagServer = document.getElementById('tagServer');
    const tagAgent = document.getElementById('tagAgent');
    const tabChat = document.getElementById('tabChat');
    const tabAuto = document.getElementById('tabAuto');
    const planCard = document.getElementById('planCard');
    const planStepsContainer = document.getElementById('planStepsContainer');
    const hintText = document.getElementById('hintText');

    let currentMode = 'chat';
    let isProcessing = false;

    vscode.postMessage({ type: 'ready' });

    function setMode(mode) {
      currentMode = mode;
      if (mode === 'chat') {
        tabChat.className = 'mode-tab active';
        tabAuto.className = 'mode-tab';
        promptInput.placeholder = 'Ask TrueForge or chat with forgeagent...';
        btnSend.textContent = 'Send';
        planCard.style.display = 'none';
      } else {
        tabChat.className = 'mode-tab';
        tabAuto.className = 'mode-tab active';
        promptInput.placeholder = 'Submit autonomous coding task for forgeagent to plan and execute...';
        btnSend.textContent = '⚡ Run Task';
      }
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'connectionStatus':
          updateConnectionUI(msg);
          break;
        case 'appendMessage':
          appendMessageUI(msg.message);
          break;
        case 'streamChunk':
          appendStreamChunk(msg.id, msg.chunk);
          break;
        case 'streamDone':
          finishStreaming(msg.id, msg.content);
          break;
        case 'streamError':
          finishStreamError(msg.id, msg.error);
          break;
        case 'setProcessing':
          setProcessingUI(msg.processing);
          break;
        case 'agentEvent':
          handleAgentEvent(msg.event);
          break;
        case 'clearPlan':
          planStepsContainer.innerHTML = '';
          planCard.style.display = 'none';
          btnReviewDiff.style.display = 'none';
          break;
      }
    });

    function updateConnectionUI(data) {
      statusDot.className = data.connected ? 'dot connected' : 'dot disconnected';
      statusText.textContent = data.connected ? 'TrueForge Online' : 'TrueForge Offline';
      tagServer.textContent = data.baseUrl || 'http://localhost:8790';
      tagAgent.textContent = data.agentName || 'forgeagent';
    }

    function handleAgentEvent(event) {
      if (event.type === 'plan_created') {
        planCard.style.display = 'block';
        renderPlanSteps(event.payload.steps);
      } else if (event.type === 'step_update') {
        updateStepStatus(event.payload.id, event.payload.status);
      } else if (event.type === 'diff_ready') {
        btnReviewDiff.style.display = 'inline-block';
      }
    }

    function renderPlanSteps(steps) {
      planStepsContainer.innerHTML = '';
      steps.forEach((s) => {
        const div = document.createElement('div');
        div.className = 'plan-step';
        div.id = 'step-' + s.id;
        div.innerHTML = '<span class="step-icon">' + getStepIcon(s.status) + '</span><span>' + s.id + '. ' + s.description + '</span>';
        planStepsContainer.appendChild(div);
      });
    }

    function updateStepStatus(id, status) {
      const stepDiv = document.getElementById('step-' + id);
      if (stepDiv) {
        stepDiv.querySelector('.step-icon').innerHTML = getStepIcon(status);
      }
    }

    function getStepIcon(status) {
      if (status === 'completed') return '✅';
      if (status === 'in_progress') return '🔄';
      if (status === 'failed') return '❌';
      return '⏳';
    }

    function appendMessageUI(msg) {
      const div = document.createElement('div');
      div.className = 'message ' + msg.role + (msg.error ? ' error' : '');
      div.id = 'msg-' + msg.id;

      const header = document.createElement('div');
      header.className = 'msg-header';
      header.innerHTML = '<span>' + (msg.role === 'user' ? 'You' : msg.role === 'agent' ? 'TrueForge Agent' : 'System') + '</span><span>' + msg.timestamp + '</span>';
      div.appendChild(header);

      const content = document.createElement('div');
      content.className = 'msg-content';
      content.textContent = msg.content;

      if (msg.isStreaming) {
        const cursor = document.createElement('span');
        cursor.className = 'cursor-blink';
        cursor.id = 'cursor-' + msg.id;
        content.appendChild(cursor);
      }

      div.appendChild(content);
      messagesContainer.appendChild(div);
      scrollToBottom();
    }

    function appendStreamChunk(id, chunk) {
      const msgDiv = document.getElementById('msg-' + id);
      if (!msgDiv) return;
      const content = msgDiv.querySelector('.msg-content');
      const cursor = document.getElementById('cursor-' + id);
      if (cursor) {
        content.insertBefore(document.createTextNode(chunk), cursor);
      } else {
        content.textContent += chunk;
      }
      scrollToBottom();
    }

    function finishStreaming(id, fullContent) {
      const cursor = document.getElementById('cursor-' + id);
      if (cursor) cursor.remove();
      const msgDiv = document.getElementById('msg-' + id);
      if (msgDiv) {
        msgDiv.querySelector('.msg-content').textContent = fullContent || '*(No text response generated by agent)*';
      }
      scrollToBottom();
    }

    function finishStreamError(id, errorText) {
      const cursor = document.getElementById('cursor-' + id);
      if (cursor) cursor.remove();
      const msgDiv = document.getElementById('msg-' + id);
      if (msgDiv) {
        msgDiv.className += ' error';
        msgDiv.querySelector('.msg-content').textContent = '❌ Error: ' + errorText;
      }
      scrollToBottom();
    }

    function setProcessingUI(processing) {
      isProcessing = processing;
      btnSend.disabled = processing;
      btnCancel.style.display = processing ? 'inline-block' : 'none';
      btnSend.style.display = processing ? 'none' : 'inline-block';
    }

    function scrollToBottom() {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    function submitAction() {
      const text = promptInput.value.trim();
      if (!text || isProcessing) return;
      promptInput.value = '';

      if (currentMode === 'auto') {
        vscode.postMessage({ type: 'runAutonomousTask', task: text });
      } else {
        vscode.postMessage({ type: 'sendMessage', text });
      }
    }

    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitAction();
      }
    });

    btnSend.addEventListener('click', submitAction);
    btnCancel.addEventListener('click', () => vscode.postMessage({ type: 'cancelTurn' }));
    btnTestConn.addEventListener('click', () => vscode.postMessage({ type: 'testConnection' }));
    btnNewSession.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
    btnExplain.addEventListener('click', () => vscode.postMessage({ type: 'explainSelection' }));
    btnReviewDiff.addEventListener('click', () => vscode.postMessage({ type: 'openReview' }));
    tabChat.addEventListener('click', () => setMode('chat'));
    tabAuto.addEventListener('click', () => setMode('auto'));
  </script>
</body>
</html>`;
  }
}
