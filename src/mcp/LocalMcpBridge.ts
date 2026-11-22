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
import { WorkspaceTools, ProposeEditResult } from '../agent/WorkspaceTools.js';
import { WorkspaceContextDiscovery } from '../context/WorkspaceContextDiscovery.js';

export type OnProposeEditCallback = (proposal: ProposeEditResult) => Promise<boolean>;

export interface LocalMcpBridgeOptions {
  instanceId: string;
  workspaceRoot: string;
  authToken?: string;
  tools?: WorkspaceTools;
  preferredPort?: number;
  onProposeEdit?: OnProposeEditCallback;
  onLog?: (message: string) => void;
}

export class LocalMcpBridge {
  private readonly instanceId: string;
  private readonly workspaceRoot: string;
  private readonly tools: WorkspaceTools;
  private authToken: string | undefined;
  private readonly onProposeEdit?: OnProposeEditCallback;
  private readonly onLog: (message: string) => void;

  private httpServer: http.Server | undefined;
  private activeSockets: Set<net.Socket> = new Set();
  private port: number | undefined;
  private preferredPort: number | undefined;
  private isFallbackPort: boolean = false;

  public static readonly SMOKE_TEST_TOOL_NAME = 'read_smoke_test_file';
  public static readonly SMOKE_TEST_FILE_NAME = '.trueforge-smoke-test.txt';
  public static readonly SMOKE_TEST_MARKER = 'TRUEFORGE_SMOKE_TEST_OK_2026';

  constructor(options: LocalMcpBridgeOptions) {
    this.instanceId = options.instanceId;
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.authToken = options.authToken ?? McpSecurity.generateAuthToken();
    this.preferredPort = options.preferredPort !== undefined ? McpSecurity.validatePort(options.preferredPort) : undefined;
    this.onProposeEdit = options.onProposeEdit;
    this.onLog = options.onLog ?? (() => { });

    if (options.tools) {
      this.tools = options.tools;
    } else {
      const discovery = new WorkspaceContextDiscovery(this.workspaceRoot);
      this.tools = new WorkspaceTools(discovery);
    }
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

  public getPreferredPort(): number | undefined {
    return this.preferredPort;
  }

  public getIsFallbackPort(): boolean {
    return this.isFallbackPort;
  }

  public getUrl(): string | undefined {
    if (this.port === undefined) {
      return undefined;
    }
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  public getOnProposeEdit(): OnProposeEditCallback | undefined {
    return this.onProposeEdit;
  }

  /**
   * Factory to create an MCP Server instance with all tools registered.
   */
  private createMcpServer(): Server {
    const server = new Server(
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
    this.setupMcpTools(server);
    return server;
  }

  /**
   * Starts the loopback MCP server on 127.0.0.1.
   * If a preferred port is specified (or configured), it attempts to bind to that port.
   * If the preferred port is occupied (EADDRINUSE), it logs a warning and falls back
   * to an OS-assigned dynamic port (0) while exposing the actual assigned port.
   */
  public async start(preferredPort?: number): Promise<{ port: number; url: string; fallbackOccurred: boolean }> {
    if (this.httpServer) {
      throw new Error('LocalMcpBridge is already running.');
    }

    const targetPort = preferredPort !== undefined
      ? McpSecurity.validatePort(preferredPort)
      : (this.preferredPort !== undefined ? this.preferredPort : 0);

    this.preferredPort = targetPort;

    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleHttpRequest(req, res).catch((err) => {
          this.log(`Unhandled HTTP error: ${err instanceof Error ? err.message : String(err)}`);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal Server Error' }));
          }
        });
      });

      server.on('connection', (socket) => {
        this.activeSockets.add(socket);
        socket.on('close', () => {
          this.activeSockets.delete(socket);
        });
      });

      const onListening = () => {
        const address = server.address() as net.AddressInfo;
        this.port = address.port;
        this.httpServer = server;
        const endpointUrl = `http://127.0.0.1:${this.port}/mcp`;
        this.log(`Loopback MCP bridge listening on ${endpointUrl} (Instance: ${this.instanceId}, Fallback: ${this.isFallbackPort})`);
        resolve({ port: this.port, url: endpointUrl, fallbackOccurred: this.isFallbackPort });
      };

      if (targetPort === 0) {
        this.isFallbackPort = false;
        server.once('error', (err) => {
          this.log(`HTTP server error: ${err.message}`);
          reject(err);
        });
        server.once('listening', () => {
          server.on('error', (err) => {
            this.log(`HTTP server runtime error: ${err.message}`);
          });
          onListening();
        });
        server.listen(0, '127.0.0.1');
      } else {
        const onError = (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            this.log(`Preferred port ${targetPort} is occupied (EADDRINUSE). Falling back to OS-assigned port...`);
            this.isFallbackPort = true;
            server.removeListener('error', onError);
            server.once('error', (fallbackErr) => {
              this.log(`Fallback HTTP server error: ${fallbackErr.message}`);
              reject(fallbackErr);
            });
            server.listen(0, '127.0.0.1');
          } else {
            this.log(`HTTP server error on port ${targetPort}: ${err.message}`);
            server.removeAllListeners('listening');
            reject(err);
          }
        };

        server.once('error', onError);
        server.once('listening', () => {
          server.removeListener('error', onError);
          server.on('error', (err) => {
            this.log(`HTTP server runtime error: ${err.message}`);
          });
          onListening();
        });
        server.listen(targetPort, '127.0.0.1');
      }
    });
  }

  /**
   * Dispatches incoming HTTP requests after checking Bearer token and Host header.
   */
  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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

    // 3. Normalize Accept header to satisfy MCP Streamable HTTP requirement
    // Streamable HTTP specification requires both application/json and text/event-stream in Accept.
    // Standard HTTP clients often send Accept: application/json, */*, or omit it entirely.
    const incomingAccept = req.headers['accept'];
    if (!incomingAccept || incomingAccept === '*/*') {
      req.headers['accept'] = 'application/json, text/event-stream';
    } else {
      let accept = incomingAccept;
      if (!accept.includes('application/json')) {
        accept += ', application/json';
      }
      if (!accept.includes('text/event-stream')) {
        accept += ', text/event-stream';
      }
      req.headers['accept'] = accept;
    }

    // 4. In stateless Streamable HTTP mode, each request must use a fresh transport
    // to prevent message ID collisions and transport reuse errors across requests.
    try {
      const server = this.createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      });

      await server.connect(transport);
      await transport.handleRequest(req, res);

      res.on('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
    } catch (err: unknown) {
      this.log(`Transport handleRequest error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
    }
  }

  /**
   * Registers the full workspace tools suite and smoke test tool on the MCP server.
   */
  private setupMcpTools(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'list_files',
            description: 'Lists files in the workspace or a specified subfolder, filtering out ignored and secret files.',
            inputSchema: {
              type: 'object',
              properties: {
                directory: {
                  type: 'string',
                  description: 'Optional relative directory path to list files within.'
                },
                recursive: {
                  type: 'boolean',
                  description: 'Whether to list files recursively (default true).'
                }
              },
              additionalProperties: false
            }
          },
          {
            name: 'read_file',
            description: 'Reads file content within workspace boundaries with line numbers and optional line range.',
            inputSchema: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: 'Relative workspace path to the file to read.'
                },
                startLine: {
                  type: 'integer',
                  description: 'Optional 1-indexed start line number (inclusive).'
                },
                endLine: {
                  type: 'integer',
                  description: 'Optional 1-indexed end line number (inclusive).'
                }
              },
              required: ['path'],
              additionalProperties: false
            }
          },
          {
            name: 'search_code',
            description: 'Searches for matching text or symbol queries across workspace text files.',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'The search query string or code symbol.'
                },
                maxMatches: {
                  type: 'integer',
                  description: 'Maximum number of search matches to return (default 20).'
                }
              },
              required: ['query'],
              additionalProperties: false
            }
          },
          {
            name: 'propose_edit',
            description: 'Proposes code modifications for user review and diff inspection without writing directly to disk.',
            inputSchema: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: 'Relative workspace path to the file to modify.'
                },
                replacementCode: {
                  type: 'string',
                  description: 'The replacement code.'
                },
                explanation: {
                  type: 'string',
                  description: 'Human-readable explanation of the proposed changes.'
                },
                startLine: {
                  type: 'integer',
                  description: 'Optional 1-indexed inclusive start line for targeted edits.'
                },
                endLine: {
                  type: 'integer',
                  description: 'Optional 1-indexed inclusive end line for targeted edits.'
                }
              },
              required: ['path', 'replacementCode'],
              additionalProperties: false
            }
          },
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

      const rawArgs = (args || {}) as Record<string, any>;

      if (name === 'list_files') {
        const result = await this.tools.listFiles({
          directory: typeof rawArgs.directory === 'string' ? rawArgs.directory : undefined,
          recursive: typeof rawArgs.recursive === 'boolean' ? rawArgs.recursive : undefined
        });
        return {
          content: [{ type: 'text', text: result.output }],
          isError: !result.success
        };
      }

      if (name === 'read_file') {
        if (!args || typeof rawArgs.path !== 'string') {
          throw new McpError(ErrorCode.InvalidParams, 'read_file requires a "path" string argument');
        }
        const result = await this.tools.readFile({
          path: rawArgs.path,
          startLine: typeof rawArgs.startLine === 'number' ? rawArgs.startLine : undefined,
          endLine: typeof rawArgs.endLine === 'number' ? rawArgs.endLine : undefined
        });
        return {
          content: [{ type: 'text', text: result.output }],
          isError: !result.success
        };
      }

      if (name === 'search_code') {
        if (!args || typeof rawArgs.query !== 'string') {
          throw new McpError(ErrorCode.InvalidParams, 'search_code requires a "query" string argument');
        }
        const result = await this.tools.searchCode({
          query: rawArgs.query,
          maxMatches: typeof rawArgs.maxMatches === 'number' ? rawArgs.maxMatches : undefined
        });
        return {
          content: [{ type: 'text', text: result.output }],
          isError: !result.success
        };
      }

      if (name === 'propose_edit') {
        if (!args || typeof rawArgs.path !== 'string' || typeof rawArgs.replacementCode !== 'string') {
          throw new McpError(
            ErrorCode.InvalidParams,
            'propose_edit requires "path" and "replacementCode" string arguments'
          );
        }
        const result = await this.tools.proposeEdit({
          path: rawArgs.path,
          replacementCode: rawArgs.replacementCode,
          explanation: typeof rawArgs.explanation === 'string' ? rawArgs.explanation : undefined,
          startLine: typeof rawArgs.startLine === 'number' ? rawArgs.startLine : undefined,
          endLine: typeof rawArgs.endLine === 'number' ? rawArgs.endLine : undefined
        });

        if (!result.success || !result.data) {
          return {
            content: [{ type: 'text', text: result.output }],
            isError: true
          };
        }

        const proposal = result.data as ProposeEditResult;
        const rangeInfo = proposal.startLine !== undefined && proposal.endLine !== undefined
          ? ` (lines ${proposal.startLine}-${proposal.endLine})`
          : '';

        if (this.onProposeEdit) {
          try {
            const accepted = await this.onProposeEdit(proposal);
            if (accepted) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Proposed modifications staged for "${proposal.relativePath}"${rangeInfo}. User diff review editor opened in VS Code. User diff review required before changes can be applied.`
                  }
                ],
                isError: false
              };
            } else {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Proposed edit could not be staged in VS Code diff review for "${proposal.relativePath}". A proposed edit is already awaiting review, or an edit operation is currently in progress. Please review or reject the active proposal first.`
                  }
                ],
                isError: true
              };
            }
          } catch (err: unknown) {
            const rawMsg = err instanceof Error ? err.message : String(err);
            const masked = McpSecurity.maskToken(rawMsg, this.authToken);
            this.log(`Error invoking onProposeEdit callback: ${masked}`);
            return {
              content: [
                {
                  type: 'text',
                  text: `Failed to open proposed modifications in VS Code review editor: ${masked}`
                }
              ],
              isError: true
            };
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: `Proposed modifications validated for "${proposal.relativePath}"${rangeInfo}, but no editor review UI is connected (headless mode). User diff review required before changes can be applied.`
            }
          ],
          isError: false
        };
      }

      if (name === LocalMcpBridge.SMOKE_TEST_TOOL_NAME) {
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
      }

      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
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

    // 3. Dereference bearer token for V8 garbage collection
    this.authToken = undefined;
    this.port = undefined;
    this.isFallbackPort = false;

    this.log(`LocalMcpBridge (${this.instanceId}) stopped and resources cleaned up.`);
  }

  private log(message: string): void {
    const masked = McpSecurity.maskToken(message, this.authToken);
    this.onLog(`[${new Date().toISOString()}] ${masked}`);
  }
}
