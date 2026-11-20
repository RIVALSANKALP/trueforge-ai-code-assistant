import * as http from 'http';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import { McpSecurity } from './McpSecurity.js';

export interface LocalMcpBridgeOptions {
  instanceId: string;
  workspaceRoot: string;
  authToken?: string;
  onLog?: (message: string) => void;
}

export class LocalMcpBridge {
  private readonly instanceId: string;
  private readonly workspaceRoot: string;
  private authToken: string | undefined;
  private readonly onLog: (message: string) => void;

  private mcpServer: Server | undefined;
  private transport: StreamableHTTPServerTransport | undefined;
  private httpServer: http.Server | undefined;
  private activeSockets: Set<net.Socket> = new Set();
  private port: number | undefined;

  public static readonly SMOKE_TEST_TOOL_NAME = 'read_smoke_test_file';
  public static readonly SMOKE_TEST_FILE_NAME = '.trueforge-smoke-test.txt';
  public static readonly SMOKE_TEST_MARKER = 'TRUEFORGE_SMOKE_TEST_OK_2026';

  constructor(options: LocalMcpBridgeOptions) {
    this.instanceId = options.instanceId;
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.authToken = options.authToken ?? McpSecurity.generateAuthToken();
    this.onLog = options.onLog ?? (() => {});
  }

  public getInstanceId(): string {
    return this.instanceId;
  }

  public getServerName(): string {
    return `vscode-tools-${this.instanceId}`;
  }

  public getAuthToken(): string | undefined {
    return this.authToken;
  }

  public getPort(): number | undefined {
    return this.port;
  }

  public getUrl(): string | undefined {
    if (this.port === undefined) {
      return undefined;
    }
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  /**
   * Starts the loopback MCP server on 127.0.0.1 with a dynamic OS-assigned port.
   */
  public async start(): Promise<{ port: number; url: string }> {
    if (this.httpServer) {
      throw new Error('LocalMcpBridge is already running.');
    }

    this.mcpServer = new Server(
      {
        name: `vscode-tools-${this.instanceId}`,
        version: '1.0.0'
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );

    this.setupMcpTools(this.mcpServer);

    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined // Stateless mode for direct HTTP/SSE requests
    });

    await this.mcpServer.connect(this.transport);

    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleHttpRequest(req, res);
      });

      server.on('connection', (socket) => {
        this.activeSockets.add(socket);
        socket.on('close', () => {
          this.activeSockets.delete(socket);
        });
      });

      server.on('error', (err) => {
        this.log(`HTTP server error: ${err.message}`);
        reject(err);
      });

      // Bind strictly to loopback IPv4
      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as net.AddressInfo;
        this.port = address.port;
        this.httpServer = server;
        const endpointUrl = `http://127.0.0.1:${this.port}/mcp`;
        this.log(`Loopback MCP bridge listening on ${endpointUrl} (Instance: ${this.instanceId})`);
        resolve({ port: this.port, url: endpointUrl });
      });
    });
  }

  /**
   * Dispatches incoming HTTP requests after checking Bearer token and Host header.
   */
  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const port = this.port ?? 0;

    // 1. Host header validation for DNS rebinding protection
    const host = req.headers['host'];
    if (!McpSecurity.validateHostHeader(host, port)) {
      this.log(`[AUTH] Rejected invalid Host header: ${host}`);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: Invalid Host header' }));
      return;
    }

    // 2. Strict Bearer token authentication
    const authHeader = req.headers['authorization'];
    if (!this.authToken || !McpSecurity.verifyAuthToken(authHeader, this.authToken)) {
      this.log(`[AUTH] Rejected unauthorized request to ${req.url}`);
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer error="invalid_token"'
      });
      res.end(JSON.stringify({ error: 'Unauthorized: Invalid or missing bearer token' }));
      return;
    }

    // 3. Forward authenticated request to MCP transport
    if (!this.transport) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Service Unavailable: Transport not initialized' }));
      return;
    }

    this.transport.handleRequest(req, res).catch((err) => {
      this.log(`Transport handleRequest error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
    });
  }

  /**
   * Registers the temporary minimal read-only read_smoke_test_file tool.
   */
  private setupMcpTools(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: LocalMcpBridge.SMOKE_TEST_TOOL_NAME,
            description:
              'Reads the designated Phase 1 smoke-test verification file. This tool is strictly read-only, takes no arguments, and accesses only the pre-provisioned test file.',
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false
            }
          }
        ]
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (name !== LocalMcpBridge.SMOKE_TEST_TOOL_NAME) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }

      // Enforce zero parameters
      if (args && Object.keys(args).length > 0) {
        throw new McpError(ErrorCode.InvalidParams, 'read_smoke_test_file accepts zero arguments');
      }

      try {
        const designatedPath = path.join(this.workspaceRoot, LocalMcpBridge.SMOKE_TEST_FILE_NAME);

        if (!fs.existsSync(designatedPath)) {
          return {
            content: [
              {
                type: 'text',
                text: `ERROR: Designated smoke test file does not exist: ${LocalMcpBridge.SMOKE_TEST_FILE_NAME}`
              }
            ],
            isError: true
          };
        }

        // Canonical realpath containment check
        const canonicalPath = fs.realpathSync(designatedPath);
        const canonicalWorkspace = fs.realpathSync(this.workspaceRoot);

        if (!canonicalPath.toLowerCase().startsWith(canonicalWorkspace.toLowerCase())) {
          return {
            content: [
              {
                type: 'text',
                text: 'ERROR: SecurityGuard boundary violation: Designated test file outside workspace'
              }
            ],
            isError: true
          };
        }

        const fileContent = fs.readFileSync(canonicalPath, 'utf-8');
        this.log(`[TOOL_EXEC] read_smoke_test_file read ${fileContent.length} bytes successfully.`);

        return {
          content: [
            {
              type: 'text',
              text: fileContent
            }
          ]
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.log(`[TOOL_EXEC_ERROR] Failed reading smoke test file: ${errorMsg}`);
        return {
          content: [
            {
              type: 'text',
              text: `ERROR: Failed to read designated smoke test file: ${errorMsg}`
            }
          ],
          isError: true
        };
      }
    });
  }

  /**
   * Safe teardown: stops server, destroys open sockets, and disposes token.
   */
  public async stop(): Promise<void> {
    this.log(`Stopping LocalMcpBridge (${this.instanceId})...`);

    // 1. Destroy open socket connections
    for (const socket of this.activeSockets) {
      try {
        socket.destroy();
      } catch {
        // Ignore socket destroy errors during shutdown
      }
    }
    this.activeSockets.clear();

    // 2. Close HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer?.close(() => resolve());
      });
      this.httpServer = undefined;
    }

    // 3. Close MCP transport
    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        // Ignore transport close errors
      }
      this.transport = undefined;
    }

    // 4. Dispose MCP server
    if (this.mcpServer) {
      try {
        await this.mcpServer.close();
      } catch {
        // Ignore server close errors
      }
      this.mcpServer = undefined;
    }

    // 5. Dereference bearer token for V8 garbage collection
    this.authToken = undefined;
    this.port = undefined;

    this.log(`LocalMcpBridge (${this.instanceId}) stopped and resources cleaned up.`);
  }

  private log(message: string): void {
    const masked = McpSecurity.maskToken(message, this.authToken);
    this.onLog(`[${new Date().toISOString()}] ${masked}`);
  }
}
