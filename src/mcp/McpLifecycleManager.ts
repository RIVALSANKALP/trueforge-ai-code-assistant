import * as vscode from 'vscode';
import { LocalMcpBridge, OnProposeEditCallback } from './LocalMcpBridge.js';
import { McpSecurity } from './McpSecurity.js';
import { WorkspaceTools } from '../agent/WorkspaceTools.js';

export type McpBridgeStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface McpBridgeHealth {
  running: boolean;
  status: McpBridgeStatus;
  port?: number;
  preferredPort?: number;
  isFallbackPort?: boolean;
  url?: string;
  instanceId?: string;
  serverName?: string;
  uptimeMs?: number;
  startedAt?: Date;
  error?: string;
}

export interface McpLifecycleManagerOptions {
  workspaceRoot: string;
  instanceId?: string;
  tools?: WorkspaceTools;
  preferredPort?: number;
  onProposeEdit?: OnProposeEditCallback;
  onLog?: (message: string) => void;
}

/**
 * Manages the lifecycle (startup, graceful shutdown, restart, and health monitoring)
 * of the local loopback MCP bridge.
 */
export class McpLifecycleManager implements vscode.Disposable {
  public static readonly DEFAULT_PORT = McpSecurity.DEFAULT_MCP_PORT;

  private bridge: LocalMcpBridge | undefined;
  private status: McpBridgeStatus = 'stopped';
  private startedAt: Date | undefined;
  private lastError: string | undefined;
  private readonly options: McpLifecycleManagerOptions;
  private preferredPort: number;

  constructor(options: McpLifecycleManagerOptions) {
    this.options = options;
    this.preferredPort = McpLifecycleManager.resolveConfiguredPort(options.preferredPort);
  }

  /**
   * Validates an MCP port configuration value.
   * Ensures the port is an integer between 1 and 65535, falling back to 8799.
   */
  public static validatePort(value: unknown, defaultPort = McpSecurity.DEFAULT_MCP_PORT): number {
    return McpSecurity.validatePort(value, defaultPort, false);
  }

  /**
   * Resolves the configured MCP preferred port from VS Code settings or injected override.
   */
  public static resolveConfiguredPort(injected?: number): number {
    if (injected !== undefined) {
      return McpLifecycleManager.validatePort(injected);
    }

    try {
      if (typeof vscode !== 'undefined' && vscode.workspace && typeof vscode.workspace.getConfiguration === 'function') {
        const config = vscode.workspace.getConfiguration('trueforge');
        const configured = config.get<number>('mcpPort');
        if (configured !== undefined && configured !== null) {
          return McpLifecycleManager.validatePort(configured);
        }
      }
    } catch {
      // Fall through to default on configuration access error
    }

    return McpLifecycleManager.DEFAULT_PORT;
  }

  /**
   * Current lifecycle status.
   */
  public getStatus(): McpBridgeStatus {
    return this.status;
  }

  /**
   * Returns current active bridge instance, if running.
   */
  public getBridge(): LocalMcpBridge | undefined {
    return this.bridge;
  }

  /**
   * Starts the local loopback MCP bridge on the preferred port, falling back to an
   * OS-assigned dynamic port if occupied.
   */
  public async start(preferredPort?: number): Promise<{ port: number; url: string; fallbackOccurred: boolean }> {
    if (this.status === 'running' && this.bridge && this.bridge.getPort() !== undefined) {
      return {
        port: this.bridge.getPort()!,
        url: this.bridge.getUrl()!,
        fallbackOccurred: this.bridge.getIsFallbackPort()
      };
    }

    this.status = 'starting';
    this.lastError = undefined;

    const targetPort = preferredPort !== undefined
      ? McpLifecycleManager.validatePort(preferredPort)
      : McpLifecycleManager.resolveConfiguredPort(this.options.preferredPort);

    this.preferredPort = targetPort;

    try {
      const instanceId = this.options.instanceId ?? McpSecurity.generateInstanceId();
      this.bridge = new LocalMcpBridge({
        instanceId,
        workspaceRoot: this.options.workspaceRoot,
        tools: this.options.tools,
        preferredPort: targetPort,
        onProposeEdit: this.options.onProposeEdit,
        onLog: this.options.onLog
      });

      const result = await this.bridge.start(targetPort);
      this.status = 'running';
      this.startedAt = new Date();
      return result;
    } catch (err: unknown) {
      this.status = 'error';
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      throw err;
    }
  }

  /**
   * Stops the running bridge and cleans up all active network sockets.
   */
  public async stop(): Promise<void> {
    if (this.bridge) {
      try {
        await this.bridge.stop();
      } finally {
        this.bridge = undefined;
        this.status = 'stopped';
        this.startedAt = undefined;
      }
    } else {
      this.status = 'stopped';
      this.startedAt = undefined;
    }
  }

  /**
   * Restarts the bridge, optionally with a new preferred port.
   */
  public async restart(preferredPort?: number): Promise<{ port: number; url: string; fallbackOccurred: boolean }> {
    await this.stop();
    return this.start(preferredPort);
  }

  /**
   * Returns a comprehensive health snapshot of the local MCP bridge.
   */
  public getHealth(): McpBridgeHealth {
    const isRunning = this.status === 'running' && this.bridge !== undefined && this.bridge.getPort() !== undefined;
    return {
      running: isRunning,
      status: this.status,
      port: this.bridge?.getPort(),
      preferredPort: this.preferredPort,
      isFallbackPort: this.bridge?.getIsFallbackPort(),
      url: this.bridge?.getUrl(),
      instanceId: this.bridge?.getInstanceId(),
      serverName: this.bridge?.getServerName(),
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt.getTime() : undefined,
      error: this.lastError
    };
  }

  /**
   * vscode.Disposable implementation.
   */
  public async dispose(): Promise<void> {
    await this.stop();
  }
}
