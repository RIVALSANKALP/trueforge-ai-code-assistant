import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TrueForgeConnection } from './connection/TrueForgeConnection.js';
import { LocalMcpBridge } from './mcp/LocalMcpBridge.js';
import { McpLifecycleManager } from './mcp/McpLifecycleManager.js';
import { McpConnectorRegistrar } from './mcp/McpConnectorRegistrar.js';
import { McpSecurity } from './mcp/McpSecurity.js';
import { SidebarChatProvider } from './ui/SidebarChatProvider.js';
import { WorkspaceContextDiscovery } from './context/WorkspaceContextDiscovery.js';
import { ContextAssembler } from './context/ContextAssembler.js';
import { InlineEditManager } from './diff/InlineEditManager.js';
import { WorkspaceTools, ProposeEditResult } from './agent/WorkspaceTools.js';
import { AutonomousAgentCoordinator } from './agent/AutonomousAgentCoordinator.js';

let outputChannel: vscode.OutputChannel | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let connection: TrueForgeConnection | undefined;
let localBridge: LocalMcpBridge | undefined;
let mcpLifecycleManager: McpLifecycleManager | undefined;
let mcpRegistrar: McpConnectorRegistrar | undefined;
let instanceId: string | undefined;
let chatProvider: SidebarChatProvider | undefined;
let inlineEditManager: InlineEditManager | undefined;
let contextDiscovery: WorkspaceContextDiscovery | undefined;
let contextAssembler: ContextAssembler | undefined;
let workspaceTools: WorkspaceTools | undefined;
let autonomousCoordinator: AutonomousAgentCoordinator | undefined;

/**
 * Resolves the authoritative workspace root from the first valid VS Code workspace folder.
 * Returns undefined if no workspace folder exists or if the path is invalid, ensuring
 * that the extension fails closed rather than falling back to process.cwd() or an arbitrary directory.
 */
export function resolveAuthoritativeWorkspaceRoot(
  workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined
): string | undefined {
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return undefined;
  }
  const first = workspaceFolders[0];
  if (!first || !first.uri || first.uri.scheme !== 'file') {
    return undefined;
  }
  const fsPath = first.uri.fsPath;
  if (!fsPath || typeof fsPath !== 'string' || !fsPath.trim() || !fs.existsSync(fsPath)) {
    return undefined;
  }
  return path.resolve(fsPath);
}

/**
 * Extension activation entry point.
 * Initializes the TrueForge connection, health probe, local loopback MCP bridge,
 * sidebar chat view provider, intelligent context assembler, inline diff edit manager,
 * status bar item, and commands.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel('TrueForge');
  outputChannel.appendLine(`[${new Date().toISOString()}] TrueForge extension activating (Milestone 2)...`);

  // 1. Generate high-entropy instance ID for this VS Code window
  instanceId = McpSecurity.generateInstanceId();
  outputChannel.appendLine(`[${new Date().toISOString()}] Generated Instance ID: ${instanceId}`);

  // 2. Read configuration
  const config = vscode.workspace.getConfiguration('trueforge');
  const serverUrl = config.get<string>('serverUrl', TrueForgeConnection.DEFAULT_BASE_URL);
  const tokenBudget = config.get<number>('contextTokenBudget', 3500);

  // 3. Initialize TrueForge SDK client & connection manager
  connection = new TrueForgeConnection({
    baseUrl: serverUrl,
    onLog: (msg) => outputChannel?.appendLine(msg)
  });

  // 4. Authoritative Workspace Root Resolution (Fail-Closed)
  const workspaceRoot = resolveAuthoritativeWorkspaceRoot(vscode.workspace.workspaceFolders);

  if (workspaceRoot) {
    outputChannel.appendLine(`[${new Date().toISOString()}] Validated authoritative workspace root: ${workspaceRoot}`);
    contextDiscovery = new WorkspaceContextDiscovery(workspaceRoot);
    contextAssembler = new ContextAssembler(contextDiscovery, { maxTokenBudget: tokenBudget });

    // 5. Initialize Inline Edit Manager & Virtual Document Content Provider
    inlineEditManager = new InlineEditManager(connection, contextAssembler);
    const diffProviderDisposable = vscode.workspace.registerTextDocumentContentProvider(
      InlineEditManager.SCHEME,
      inlineEditManager
    );
    context.subscriptions.push(diffProviderDisposable);

    // 6. Initialize Workspace Tools & Autonomous Agent Coordinator (Milestone 3)
    workspaceTools = new WorkspaceTools(contextDiscovery);
    autonomousCoordinator = new AutonomousAgentCoordinator(connection, workspaceTools, inlineEditManager);
  } else {
    outputChannel.appendLine(
      `[${new Date().toISOString()}] Notice: No valid workspace folder is open. Workspace discovery, inline edits, and autonomous agent mode are disabled until a project folder is opened.`
    );
    vscode.window.showWarningMessage(
      'TrueForge: No workspace folder is open. Please open a project folder in VS Code to enable workspace discovery, inline edits, and autonomous agent mode.'
    );
    contextDiscovery = undefined;
    contextAssembler = undefined;
    inlineEditManager = undefined;
    workspaceTools = undefined;
    autonomousCoordinator = undefined;
  }

  // 7. Create and configure status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'trueforge.openChat';
  statusBarItem.text = '$(sync~spin) TrueForge: Connecting...';
  statusBarItem.tooltip = `Probing TrueForge server at ${serverUrl}`;
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // 8. Register Sidebar Webview View Provider with Coordinator
  chatProvider = new SidebarChatProvider(
    context.extensionUri,
    connection,
    (msg) => outputChannel?.appendLine(msg)
  );
  if (autonomousCoordinator) {
    chatProvider.setCoordinator(autonomousCoordinator);
  }
  const webviewDisposable = vscode.window.registerWebviewViewProvider(
    SidebarChatProvider.viewType,
    chatProvider,
    { webviewOptions: { retainContextWhenHidden: true } }
  );
  context.subscriptions.push(webviewDisposable);

  // 8. Initial health probe & status bar update
  await updateHealthStatus(serverUrl);

  // 9. Start the local loopback MCP bridge via McpLifecycleManager (gated by SSRF)
  if (workspaceRoot) {
    try {
      const configuredPort = config.get<number>('mcpPort', 8799);
      mcpLifecycleManager = new McpLifecycleManager({
        instanceId,
        workspaceRoot,
        tools: workspaceTools,
        preferredPort: configuredPort,
        onProposeEdit: async (proposal: ProposeEditResult): Promise<boolean> => {
          if (!inlineEditManager) {
            outputChannel?.appendLine(
              `[${new Date().toISOString()}] [MCP propose_edit] Proposal rejected: InlineEditManager is not initialized.`
            );
            return false;
          }

          outputChannel?.appendLine(
            `[${new Date().toISOString()}] [MCP propose_edit] Opening VS Code diff review editor for "${proposal.relativePath}"...`
          );

          try {
            const staged = await inlineEditManager.registerAutonomousProposal(
              proposal.absolutePath,
              proposal.replacementCode,
              proposal.explanation,
              {
                startLine: proposal.startLine,
                endLine: proposal.endLine,
                fullProposedText: proposal.fullProposedText,
                allowQueue: true
              }
            );

            if (staged) {
              outputChannel?.appendLine(
                `[${new Date().toISOString()}] [MCP propose_edit] Diff review editor opened successfully for "${proposal.relativePath}".`
              );
            } else {
              outputChannel?.appendLine(
                `[${new Date().toISOString()}] [MCP propose_edit] Proposal for "${proposal.relativePath}" was rejected by InlineEditManager (existing proposal awaiting review or operation in progress).`
              );
            }
            return staged;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            outputChannel?.appendLine(
              `[${new Date().toISOString()}] [MCP propose_edit] Error in registerAutonomousProposal: ${msg}`
            );
            return false;
          }
        },
        onLog: (msg) => outputChannel?.appendLine(msg)
      });
      context.subscriptions.push(mcpLifecycleManager);

      const bridgeInfo = await mcpLifecycleManager.start();
      localBridge = mcpLifecycleManager.getBridge();
      const fallbackNote = bridgeInfo.fallbackOccurred
        ? ` (fell back from preferred port ${configuredPort})`
        : '';
      outputChannel.appendLine(
        `[${new Date().toISOString()}] Local loopback MCP bridge started on port ${bridgeInfo.port}${fallbackNote} (${localBridge?.getServerName()}) [Gated by SSRF]`
      );
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      outputChannel.appendLine(`[${new Date().toISOString()}] Note on local bridge: ${errorMsg}`);
    }
  }

  // 10. Register Commands
  const openChatDisposable = vscode.commands.registerCommand('trueforge.openChat', async () => {
    outputChannel?.appendLine(`[${new Date().toISOString()}] User invoked trueforge.openChat command.`);
    await vscode.commands.executeCommand('trueforge.chatView.focus');
  });

  const statusDisposable = vscode.commands.registerCommand('trueforge.status', async () => {
    outputChannel?.appendLine(`[${new Date().toISOString()}] User invoked trueforge.status command.`);
    if (!connection) {
      vscode.window.showErrorMessage('TrueForge connection is not initialized.');
      return;
    }

    const health = await connection.checkHealth();
    await updateHealthStatus(serverUrl);
    if (chatProvider) {
      await chatProvider.refreshConnectionState();
    }

    if (health.ok) {
      vscode.window.showInformationMessage(
        `TrueForge: Connected to ${serverUrl} (Instance: ${instanceId})`
      );
    } else {
      vscode.window.showErrorMessage(
        `TrueForge: Disconnected from ${serverUrl} (${health.error})`
      );
    }
  });

  const testAgentDisposable = vscode.commands.registerCommand('trueforge.testAgent', async () => {
    outputChannel?.appendLine(`[${new Date().toISOString()}] User invoked trueforge.testAgent command.`);
    if (chatProvider) {
      await chatProvider.focus();
      await chatProvider.handleTestConnection();
    }
  });

  const startSessionDisposable = vscode.commands.registerCommand('trueforge.startSession', async () => {
    outputChannel?.appendLine(`[${new Date().toISOString()}] User invoked trueforge.startSession command.`);
    if (chatProvider) {
      await chatProvider.focus();
      await chatProvider.handleNewSession();
    }
  });

  const explainSelectionDisposable = vscode.commands.registerCommand('trueforge.explainSelection', async () => {
    outputChannel?.appendLine(`[${new Date().toISOString()}] User invoked trueforge.explainSelection command.`);
    if (chatProvider) {
      await chatProvider.focus();
      await chatProvider.handleExplainSelection();
    }
  });

  const inlineEditDisposable = vscode.commands.registerCommand(
    'trueforge.inlineEdit',
    async (editor?: vscode.TextEditor) => {
      outputChannel?.appendLine(`[${new Date().toISOString()}] User invoked trueforge.inlineEdit command.`);
      if (!connection) {
        vscode.window.showErrorMessage('TrueForge connection is not initialized.');
        return;
      }
      if (!inlineEditManager) {
        vscode.window.showErrorMessage('TrueForge: Inline Edit requires an open workspace folder. Please open a project folder first.');
        return;
      }
      await inlineEditManager.startInlineEdit(editor);
    }
  );

  const reviewPendingEditDisposable = vscode.commands.registerCommand(
    'trueforge.reviewPendingEdit',
    async () => {
      outputChannel?.appendLine(`[${new Date().toISOString()}] User invoked trueforge.reviewPendingEdit command.`);
      if (!inlineEditManager) {
        vscode.window.showErrorMessage('TrueForge: No active inline edit proposal.');
        return;
      }
      await inlineEditManager.showReviewQuickPick();
    }
  );

  const acceptInlineEditDisposable = vscode.commands.registerCommand(
    'trueforge.acceptInlineEdit',
    async () => {
      outputChannel?.appendLine(`[${new Date().toISOString()}] User invoked trueforge.acceptInlineEdit command.`);
      if (!inlineEditManager) {
        vscode.window.showErrorMessage('TrueForge: No active inline edit proposal.');
        return;
      }
      await inlineEditManager.applyEdit();
    }
  );

  const rejectInlineEditDisposable = vscode.commands.registerCommand(
    'trueforge.rejectInlineEdit',
    async () => {
      outputChannel?.appendLine(`[${new Date().toISOString()}] User invoked trueforge.rejectInlineEdit command.`);
      if (!inlineEditManager) {
        vscode.window.showErrorMessage('TrueForge: No active inline edit proposal.');
        return;
      }
      inlineEditManager.rejectEdit();
    }
  );

  const autonomousTaskDisposable = vscode.commands.registerCommand(
    'trueforge.autonomousTask',
    async () => {
      outputChannel?.appendLine(`[${new Date().toISOString()}] User invoked trueforge.autonomousTask command.`);
      if (!connection) {
        vscode.window.showErrorMessage('TrueForge connection is not initialized.');
        return;
      }
      if (!autonomousCoordinator) {
        vscode.window.showErrorMessage('TrueForge: Autonomous Mode requires an open workspace folder. Please open a project folder first.');
        return;
      }
      const task = await vscode.window.showInputBox({
        title: 'TrueForge: Run Autonomous Coding Task',
        prompt: 'Enter coding task for forgeagent to plan and execute autonomously',
        placeHolder: 'e.g., Inspect src/calculator.ts and add a multiply function',
        ignoreFocusOut: true
      });
      if (task && task.trim()) {
        if (chatProvider) {
          await chatProvider.focus();
          await chatProvider.handleAutonomousTask(task.trim());
        }
      }
    }
  );

  const registerMcpConnectorDisposable = vscode.commands.registerCommand(
    'trueforge.registerMcpConnector',
    async () => {
      outputChannel?.appendLine(`[${new Date().toISOString()}] User invoked trueforge.registerMcpConnector command.`);
      if (!connection) {
        vscode.window.showErrorMessage('TrueForge connection is not initialized.');
        return;
      }
      if (!mcpLifecycleManager) {
        vscode.window.showErrorMessage(
          'TrueForge: Local MCP bridge is not initialized. Please open a workspace folder first.'
        );
        return;
      }

      if (!mcpRegistrar) {
        mcpRegistrar = new McpConnectorRegistrar({
          connection,
          lifecycleManager: mcpLifecycleManager,
          onLog: (msg) => outputChannel?.appendLine(msg)
        });
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'TrueForge: Registering local MCP connector (vscode-tools)...',
          cancellable: false
        },
        async () => {
          const result = await mcpRegistrar!.registerConnector({
            forceUpdate: true,
            verifyTools: true
          });
          if (result.success) {
            const actionMsg =
              result.action === 'already_registered'
                ? 'already registered and up-to-date'
                : result.action === 'updated'
                ? 'updated successfully'
                : 'registered successfully';
            const countMsg =
              result.toolsDiscovered !== undefined
                ? ` (${result.toolsDiscovered.length} tool${result.toolsDiscovered.length === 1 ? '' : 's'} verified)`
                : '';
            vscode.window.showInformationMessage(
              `TrueForge: MCP connector "${result.connectorName}" is ${actionMsg}${countMsg}.`
            );
          } else {
            vscode.window.showErrorMessage(
              `TrueForge MCP Registration Failed: ${result.error || result.message}`
            );
          }
        }
      );
    }
  );

  context.subscriptions.push(
    outputChannel,
    openChatDisposable,
    statusDisposable,
    testAgentDisposable,
    startSessionDisposable,
    explainSelectionDisposable,
    inlineEditDisposable,
    reviewPendingEditDisposable,
    acceptInlineEditDisposable,
    rejectInlineEditDisposable,
    autonomousTaskDisposable,
    registerMcpConnectorDisposable
  );

  outputChannel.appendLine(`[${new Date().toISOString()}] TrueForge extension activated successfully with Milestone 3 (Autonomous Agent Mode).`);
}

async function updateHealthStatus(serverUrl: string): Promise<void> {
  if (!connection || !statusBarItem) {
    return;
  }

  const health = await connection.checkHealth();
  if (health.ok) {
    statusBarItem.text = '$(hubot) TrueForge: Online';
    statusBarItem.tooltip = `Connected to TrueForge at ${serverUrl} (Agent: forgeagent)\nClick to open TrueForge chat.`;
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = '$(error) TrueForge: Offline';
    statusBarItem.tooltip = `Disconnected from ${serverUrl}: ${health.error}\nClick to open TrueForge chat.`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  }
}

/**
 * Extension deactivation lifecycle hook.
 */
export async function deactivate(): Promise<void> {
  if (outputChannel) {
    outputChannel.appendLine(`[${new Date().toISOString()}] TrueForge extension deactivating...`);
  }

  if (mcpLifecycleManager) {
    try {
      await mcpLifecycleManager.stop();
    } catch {
      // Ignore stop errors on deactivation
    }
    mcpLifecycleManager = undefined;
    localBridge = undefined;
  } else if (localBridge) {
    try {
      await localBridge.stop();
    } catch {
      // Ignore stop errors on deactivation
    }
    localBridge = undefined;
  }

  if (statusBarItem) {
    statusBarItem.dispose();
    statusBarItem = undefined;
  }

  connection = undefined;
  instanceId = undefined;
  mcpRegistrar = undefined;
  chatProvider = undefined;
  inlineEditManager = undefined;
  contextDiscovery = undefined;
  contextAssembler = undefined;
  workspaceTools = undefined;
  autonomousCoordinator = undefined;

  if (outputChannel) {
    outputChannel.appendLine(`[${new Date().toISOString()}] TrueForge extension deactivated cleanly.`);
    outputChannel.dispose();
    outputChannel = undefined;
  }
}
