import { TrueForgeApi, TrueForgeError } from '@truefoundry/trueforge-sdk';
import { LocalMcpBridge } from './LocalMcpBridge.js';
import { McpLifecycleManager } from './McpLifecycleManager.js';
import { McpSecurity } from './McpSecurity.js';
import { TrueForgeConnection } from '../connection/TrueForgeConnection.js';

export type McpRegistrationAction = 'created' | 'updated' | 'already_registered' | 'failed';

export type McpRegistrationErrorCode =
  | 'BRIDGE_NOT_RUNNING'
  | 'SERVER_OFFLINE'
  | 'SSRF_BLOCKED'
  | 'AUTH_FAILED'
  | 'REGISTRATION_FAILED';

export interface McpRegistrationResult {
  success: boolean;
  action: McpRegistrationAction;
  connectorName: string;
  url?: string;
  toolsDiscovered?: string[];
  message: string;
  error?: string;
  errorCode?: McpRegistrationErrorCode;
}

export interface McpConnectorStatus {
  exists: boolean;
  name: string;
  url?: string;
  type?: string;
  authType?: string;
  authStatus?: any;
  manifest?: any;
  error?: string;
}

export interface McpConnectorRegistrarOptions {
  connection: TrueForgeConnection;
  lifecycleManager?: McpLifecycleManager;
  bridge?: LocalMcpBridge;
  onLog?: (message: string) => void;
}

/**
 * Manages the registration and synchronization of the local VS Code MCP bridge
 * with TrueForge settings (Connectors).
 *
 * Ensures:
 * - Fixed connector name: 'vscode-tools' (valid according to TrueForge NameSchema).
 * - Idempotent registration and credential rotation without overwriting unrelated MCP servers.
 * - Strict Bearer token confidentiality: tokens are never exposed in logs, diagnostics, or error strings.
 * - Clear diagnostics for SSRF policy restriction (OUTBOUND_URL_ALLOWED_HOSTS requirement).
 * - Safe fallback to in-band tool execution on registration failure.
 */
export class McpConnectorRegistrar {
  public static readonly CONNECTOR_NAME = 'vscode-tools';
  public static readonly CONNECTOR_DESCRIPTION =
    'Local workspace tools for code search, file reading, and edit proposals';

  private readonly connection: TrueForgeConnection;
  private readonly lifecycleManager?: McpLifecycleManager;
  private directBridge?: LocalMcpBridge;
  private readonly onLog: (message: string) => void;

  constructor(options: McpConnectorRegistrarOptions) {
    this.connection = options.connection;
    this.lifecycleManager = options.lifecycleManager;
    this.directBridge = options.bridge;
    this.onLog = options.onLog ?? (() => {});
  }

  private log(message: string): void {
    const token = this.getActiveBridge()?.getAuthToken();
    const sanitized = McpSecurity.maskToken(message, token);
    this.onLog(`[${new Date().toISOString()}] [McpRegistrar] ${sanitized}`);
  }

  /**
   * Sets or updates the direct bridge instance (useful in tests or when bridge restarts).
   */
  public setBridge(bridge: LocalMcpBridge | undefined): void {
    this.directBridge = bridge;
  }

  /**
   * Resolves the current active bridge instance.
   */
  public getActiveBridge(): LocalMcpBridge | undefined {
    return this.directBridge ?? this.lifecycleManager?.getBridge();
  }

  /**
   * Checks whether the 'vscode-tools' connector currently exists in TrueForge.
   */
  public async checkConnectorExists(): Promise<McpConnectorStatus> {
    const client = this.connection.getClient();
    const token = this.getActiveBridge()?.getAuthToken();

    try {
      const response = await client.settings.mcpServers.get(McpConnectorRegistrar.CONNECTOR_NAME);
      const server = response.data;
      const manifest = server.manifest as any;
      const url = typeof manifest?.url === 'string' ? manifest.url : undefined;
      const type = typeof manifest?.type === 'string' ? manifest.type : undefined;
      const authType = typeof manifest?.auth?.type === 'string' ? manifest.auth.type : undefined;

      this.log(`Connector "${McpConnectorRegistrar.CONNECTOR_NAME}" exists (URL: ${url ?? 'unknown'}).`);
      return {
        exists: true,
        name: McpConnectorRegistrar.CONNECTOR_NAME,
        url,
        type,
        authType,
        authStatus: server.authStatus,
        manifest
      };
    } catch (err: unknown) {
      if (this.isNotFoundError(err)) {
        this.log(`Connector "${McpConnectorRegistrar.CONNECTOR_NAME}" does not exist in TrueForge.`);
        return {
          exists: false,
          name: McpConnectorRegistrar.CONNECTOR_NAME
        };
      }

      const maskedErr = McpSecurity.maskToken(this.extractErrorMessage(err), token);
      this.log(`Error checking connector status: ${maskedErr}`);
      return {
        exists: false,
        name: McpConnectorRegistrar.CONNECTOR_NAME,
        error: maskedErr
      };
    }
  }

  /**
   * Lists any other configured MCP servers in TrueForge, verifying isolation.
   */
  public async listOtherMcpServers(): Promise<TrueForgeApi.ConfiguredMcpServer[]> {
    const client = this.connection.getClient();
    try {
      const response = await client.settings.mcpServers.list();
      const list = response.data ?? [];
      return list.filter((s) => s.name !== McpConnectorRegistrar.CONNECTOR_NAME);
    } catch (err: unknown) {
      const token = this.getActiveBridge()?.getAuthToken();
      this.log(`Failed to list other MCP servers: ${McpSecurity.maskToken(this.extractErrorMessage(err), token)}`);
      return [];
    }
  }

  /**
   * Verifies MCP tool discovery with the TrueForge server via tools/list.
   */
  public async verifyTools(): Promise<{
    success: boolean;
    toolCount: number;
    toolNames: string[];
    error?: string;
  }> {
    const client = this.connection.getClient();
    const token = this.getActiveBridge()?.getAuthToken();

    try {
      const response = await client.mcpServers.listTools(McpConnectorRegistrar.CONNECTOR_NAME);
      const tools = response.data ?? [];
      const toolNames: string[] = tools
        .map((t) => (typeof t.name === 'string' ? t.name : String(t.name || '')))
        .filter((n): n is string => Boolean(n));
      this.log(`Discovered ${toolNames.length} tools from TrueForge: [${toolNames.join(', ')}]`);
      return {
        success: true,
        toolCount: toolNames.length,
        toolNames
      };
    } catch (err: unknown) {
      const errorMsg = McpSecurity.maskToken(this.extractErrorMessage(err), token);
      this.log(`Tool discovery verification failed: ${errorMsg}`);
      return {
        success: false,
        toolCount: 0,
        toolNames: [],
        error: errorMsg
      };
    }
  }

  /**
   * Registers or updates the 'vscode-tools' MCP connector with TrueForge.
   *
   * Idempotent:
   * - If already registered with identical bridge URL and functional credentials, avoids redundant writes.
   * - If unregistered, registers via client.settings.mcpServers.createOrUpdate().
   * - If URL or token rotated, updates via createOrUpdate() to refresh stored secrets.
   * - Strictly preserves other MCP connectors and settings.
   */
  public async registerConnector(options?: {
    forceUpdate?: boolean;
    verifyTools?: boolean;
  }): Promise<McpRegistrationResult> {
    const shouldVerify = options?.verifyTools ?? true;

    // 1. Ensure local MCP bridge is running
    let bridge = this.getActiveBridge();
    if (!bridge && this.lifecycleManager) {
      this.log('Local MCP bridge not active; starting via McpLifecycleManager...');
      try {
        await this.lifecycleManager.start();
        bridge = this.getActiveBridge();
      } catch (err: unknown) {
        const errorMsg = McpSecurity.maskToken(this.extractErrorMessage(err));
        return {
          success: false,
          action: 'failed',
          connectorName: McpConnectorRegistrar.CONNECTOR_NAME,
          message: 'Failed to start local MCP bridge.',
          error: `Failed to start local MCP bridge: ${errorMsg}`,
          errorCode: 'BRIDGE_NOT_RUNNING'
        };
      }
    }

    if (!bridge || !bridge.getUrl() || !bridge.getAuthToken()) {
      return {
        success: false,
        action: 'failed',
        connectorName: McpConnectorRegistrar.CONNECTOR_NAME,
        message: 'Local MCP bridge is not running.',
        error: 'Local MCP bridge is not running. Please open a workspace folder to start the bridge.',
        errorCode: 'BRIDGE_NOT_RUNNING'
      };
    }

    const bridgeUrl = bridge.getUrl()!;
    const authToken = bridge.getAuthToken()!;

    // 2. Inspect existing TrueForge configuration
    const existing = await this.checkConnectorExists();

    if (existing.error) {
      const classification = this.classifyError(existing.error);
      if (classification.errorCode === 'SERVER_OFFLINE' || classification.errorCode === 'AUTH_FAILED') {
        return {
          success: false,
          action: 'failed',
          connectorName: McpConnectorRegistrar.CONNECTOR_NAME,
          url: bridgeUrl,
          message: classification.friendlyMessage,
          error: McpSecurity.maskToken(classification.friendlyMessage, authToken),
          errorCode: classification.errorCode
        };
      }
    }

    // 3. Idempotency check: if already registered with matching URL and not forcing update
    if (existing.exists && existing.url === bridgeUrl && !options?.forceUpdate) {
      if (shouldVerify) {
        this.log(`Connector already exists at ${bridgeUrl}; verifying tool connectivity...`);
        const verifyRes = await this.verifyTools();
        if (verifyRes.success) {
          return {
            success: true,
            action: 'already_registered',
            connectorName: McpConnectorRegistrar.CONNECTOR_NAME,
            url: bridgeUrl,
            toolsDiscovered: verifyRes.toolNames,
            message: `MCP connector "${McpConnectorRegistrar.CONNECTOR_NAME}" is already registered and verified at ${bridgeUrl}.`
          };
        }

        // If verification failed because of auth failure, token rotation is needed
        if (verifyRes.error && this.classifyError(verifyRes.error).errorCode === 'AUTH_FAILED') {
          this.log('Stored credentials rejected during tool check; rotating token in TrueForge...');
        } else if (verifyRes.error && this.classifyError(verifyRes.error).errorCode === 'SSRF_BLOCKED') {
          const ssrfDiag = this.classifyError(verifyRes.error);
          return {
            success: false,
            action: 'failed',
            connectorName: McpConnectorRegistrar.CONNECTOR_NAME,
            url: bridgeUrl,
            message: ssrfDiag.friendlyMessage,
            error: ssrfDiag.friendlyMessage,
            errorCode: 'SSRF_BLOCKED'
          };
        }
      } else {
        return {
          success: true,
          action: 'already_registered',
          connectorName: McpConnectorRegistrar.CONNECTOR_NAME,
          url: bridgeUrl,
          message: `MCP connector "${McpConnectorRegistrar.CONNECTOR_NAME}" is already registered at ${bridgeUrl}.`
        };
      }
    }

    // 4. Register or Update via createOrUpdate
    const client = this.connection.getClient();
    const manifest: TrueForgeApi.RemoteMcpServerManifest = {
      type: 'remote',
      name: McpConnectorRegistrar.CONNECTOR_NAME,
      url: bridgeUrl,
      description: McpConnectorRegistrar.CONNECTOR_DESCRIPTION,
      auth: {
        type: 'header',
        headers: {
          authorization: `Bearer ${authToken}`
        }
      }
    };

    const action: McpRegistrationAction = existing.exists ? 'updated' : 'created';
    this.log(`Registering connector "${McpConnectorRegistrar.CONNECTOR_NAME}" (action: ${action}, URL: ${bridgeUrl})...`);

    try {
      await client.settings.mcpServers.createOrUpdate({ manifest });
      this.log(`Connector "${McpConnectorRegistrar.CONNECTOR_NAME}" ${action} successfully in TrueForge.`);
    } catch (err: unknown) {
      const classification = this.classifyError(err);
      const safeError = McpSecurity.maskToken(classification.friendlyMessage, authToken);
      this.log(`Connector registration failed: ${safeError}`);
      return {
        success: false,
        action: 'failed',
        connectorName: McpConnectorRegistrar.CONNECTOR_NAME,
        url: bridgeUrl,
        message: safeError,
        error: safeError,
        errorCode: classification.errorCode
      };
    }

    // 5. Tool verification post-registration
    let toolsDiscovered: string[] | undefined;
    if (shouldVerify) {
      this.log(`Verifying tool connectivity for "${McpConnectorRegistrar.CONNECTOR_NAME}"...`);
      const verifyRes = await this.verifyTools();
      if (verifyRes.success) {
        toolsDiscovered = verifyRes.toolNames;
      } else {
        const classification = this.classifyError(verifyRes.error);
        if (classification.errorCode === 'SSRF_BLOCKED') {
          const safeError = McpSecurity.maskToken(classification.friendlyMessage, authToken);
          this.log(`SSRF block encountered during tool discovery: ${safeError}`);
          return {
            success: false,
            action: 'failed',
            connectorName: McpConnectorRegistrar.CONNECTOR_NAME,
            url: bridgeUrl,
            message: safeError,
            error: safeError,
            errorCode: 'SSRF_BLOCKED'
          };
        }
        this.log(`Tool discovery warning: ${verifyRes.error}`);
      }
    }

    const verb = action === 'created' ? 'registered' : 'updated';
    return {
      success: true,
      action,
      connectorName: McpConnectorRegistrar.CONNECTOR_NAME,
      url: bridgeUrl,
      toolsDiscovered,
      message: `MCP connector "${McpConnectorRegistrar.CONNECTOR_NAME}" ${verb} successfully at ${bridgeUrl}.`
    };
  }

  /**
   * Unregisters the 'vscode-tools' MCP connector from TrueForge.
   */
  public async unregisterConnector(): Promise<{ success: boolean; error?: string }> {
    const client = this.connection.getClient();
    const token = this.getActiveBridge()?.getAuthToken();

    try {
      await client.settings.mcpServers.delete(McpConnectorRegistrar.CONNECTOR_NAME);
      this.log(`Connector "${McpConnectorRegistrar.CONNECTOR_NAME}" deleted successfully from TrueForge.`);
      return { success: true };
    } catch (err: unknown) {
      if (this.isNotFoundError(err)) {
        return { success: true };
      }
      const safeError = McpSecurity.maskToken(this.extractErrorMessage(err), token);
      this.log(`Failed to unregister connector: ${safeError}`);
      return { success: false, error: safeError };
    }
  }

  /**
   * Helper to inspect whether an error is a 404 / NotFoundError.
   */
  private isNotFoundError(err: unknown): boolean {
    if (!err) {
      return false;
    }
    if ((err as any).statusCode === 404) {
      return true;
    }
    if (err instanceof TrueForgeApi.NotFoundError || (err instanceof TrueForgeError && err.statusCode === 404)) {
      return true;
    }
    const msg = this.extractErrorMessage(err).toLowerCase();
    return msg.includes('not found') || msg.includes('404');
  }

  /**
   * Extracts clean error message from an unknown error object.
   */
  private extractErrorMessage(err: unknown): string {
    if (!err) {
      return 'Unknown error';
    }
    if (err instanceof Error) {
      const body = (err as any).body;
      const bodyMsg = body?.error?.message || (typeof body === 'string' ? body : '');
      if (bodyMsg && !err.message.includes(bodyMsg)) {
        return `${err.message}: ${bodyMsg}`;
      }
      return err.message;
    }
    return String(err);
  }

  /**
   * Classifies error into standard categories with actionable friendly diagnostics.
   */
  public classifyError(rawErr: unknown): {
    errorCode: McpRegistrationErrorCode;
    friendlyMessage: string;
  } {
    const msg = this.extractErrorMessage(rawErr);
    const lower = msg.toLowerCase();
    const statusCode = (rawErr as any)?.statusCode;

    // 1. SSRF restriction on loopback
    if (
      lower.includes('outbound url blocked') ||
      lower.includes('ssrf') ||
      (statusCode === 400 && lower.includes('blocked'))
    ) {
      return {
        errorCode: 'SSRF_BLOCKED',
        friendlyMessage:
          'TrueForge blocked loopback connection to 127.0.0.1 (SSRF protection). To allow the local MCP bridge while keeping NETWORK_POLICY_ENABLED=true, set OUTBOUND_URL_ALLOWED_HOSTS=\'["127.0.0.1"]\' in your TrueForge server environment.'
      };
    }

    // 2. Server offline or network unreachable
    if (
      lower.includes('econnrefused') ||
      lower.includes('fetch failed') ||
      lower.includes('enotfound') ||
      lower.includes('etimedout') ||
      lower.includes('network')
    ) {
      return {
        errorCode: 'SERVER_OFFLINE',
        friendlyMessage: `TrueForge server is offline or unreachable at ${this.connection.getBaseUrl()}. Please ensure the server is running.`
      };
    }

    // 3. Authentication failure
    if (
      statusCode === 401 ||
      statusCode === 403 ||
      lower.includes('unauthorized') ||
      lower.includes('forbidden')
    ) {
      return {
        errorCode: 'AUTH_FAILED',
        friendlyMessage: `TrueForge authentication failed (${statusCode || 'unauthorized'}). Please check API credentials.`
      };
    }

    // 4. General registration failure
    return {
      errorCode: 'REGISTRATION_FAILED',
      friendlyMessage: msg || 'An error occurred during TrueForge MCP connector registration.'
    };
  }
}
