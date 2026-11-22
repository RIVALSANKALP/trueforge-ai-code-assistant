import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as http from 'http';
import * as net from 'net';
import * as vscode from 'vscode';
import { LocalMcpBridge } from '../mcp/LocalMcpBridge.js';
import { McpLifecycleManager } from '../mcp/McpLifecycleManager.js';
import { McpConnectorRegistrar } from '../mcp/McpConnectorRegistrar.js';
import { McpSecurity } from '../mcp/McpSecurity.js';
import { WorkspaceContextDiscovery } from '../context/WorkspaceContextDiscovery.js';
import { WorkspaceTools, ProposeEditResult } from '../agent/WorkspaceTools.js';
import { ContextAssembler } from '../context/ContextAssembler.js';
import { InlineEditManager } from '../diff/InlineEditManager.js';
import { TrueForgeConnection } from '../connection/TrueForgeConnection.js';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

const results: TestResult[] = [];

async function runTest(name: string, fn: () => Promise<void> | void): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, durationMs: Date.now() - start });
    console.log(`  ✅ PASS: ${name} (${Date.now() - start}ms)`);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, error: errorMsg, durationMs: Date.now() - start });
    console.error(`  ❌ FAIL: ${name}: ${errorMsg}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${message} (expected ${expected}, got ${actual})`);
  }
}

/**
 * Helper to perform raw HTTP POST JSON-RPC requests to the loopback MCP server.
 * Note: Intentionally tests standard HTTP client behavior without forcing any special Accept header.
 */
async function sendMcpRequest(
  url: string,
  token: string | undefined,
  body: any,
  customHeaders?: Record<string, string>
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const postData = JSON.stringify(body);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData).toString(),
      Host: parsedUrl.host,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(customHeaders || {})
    };

    const req = http.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname,
        method: 'POST',
        headers
      },
      (res) => {
        let resData = '';
        res.on('data', (chunk) => {
          resData += chunk;
        });
        res.on('end', () => {
          let parsedBody: any;
          try {
            parsedBody = JSON.parse(resData);
          } catch {
            parsedBody = resData;
          }
          resolve({ status: res.statusCode || 0, body: parsedBody, headers: res.headers });
        });
      }
    );

    req.on('error', (err) => reject(err));
    req.write(postData);
    req.end();
  });
}

/**
 * Helper to obtain an unused ephemeral loopback port for isolated tests.
 */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    srv.on('error', reject);
  });
}

async function runMcpTestSuite(): Promise<void> {
  console.log('\n========================================================');
  console.log('🚀 Running TrueForge MCP Server Test Suite');
  console.log('========================================================\n');

  const workspaceRoot = process.cwd();
  const discovery = new WorkspaceContextDiscovery(workspaceRoot);
  const tools = new WorkspaceTools(discovery);

  // ----------------------------------------------------
  // SUITE 1: Server Startup, Lifecycle, and Loopback Binding
  // ----------------------------------------------------
  console.log('--- Suite 1: Server Startup & Lifecycle ---');

  const instanceId = McpSecurity.generateInstanceId();
  let bridgeLastProposal: ProposeEditResult | undefined;
  const bridge = new LocalMcpBridge({
    instanceId,
    workspaceRoot,
    tools,
    onProposeEdit: async (prop) => {
      bridgeLastProposal = prop;
      return true;
    }
  });

  let serverPort = 0;
  let endpointUrl = '';

  await runTest('Lifecycle 1.1: Binds strictly to 127.0.0.1 on OS-assigned dynamic port', async () => {
    const startResult = await bridge.start();
    serverPort = startResult.port;
    endpointUrl = startResult.url;

    assert(serverPort > 0, `Port must be > 0 (got: ${serverPort})`);
    assert(endpointUrl.startsWith(`http://127.0.0.1:${serverPort}/mcp`), `URL must start with http://127.0.0.1:${serverPort}/mcp`);
    assertEqual(bridge.getPort(), serverPort, 'bridge.getPort() matches');
    assertEqual(bridge.getUrl(), endpointUrl, 'bridge.getUrl() matches');
  });

  await runTest('Lifecycle 1.2: Generates cryptographic instanceId and bearer token', () => {
    assertEqual(bridge.getInstanceId(), instanceId, 'Instance ID matches');
    assertEqual(bridge.getServerName(), `vscode-tools-${instanceId}`, 'Server name matches');
    const token = bridge.getAuthToken();
    assert(Boolean(token && token.length === 64), 'Bearer token must be 64 hex characters (32 bytes entropy)');
  });

  await runTest('Lifecycle 1.3: Starting an already running bridge throws error', async () => {
    let threw = false;
    try {
      await bridge.start();
    } catch {
      threw = true;
    }
    assert(threw, 'Starting already running bridge must throw');
  });

  // ----------------------------------------------------
  // SUITE 2: Authentication & Host Header Security (McpSecurity)
  // ----------------------------------------------------
  console.log('\n--- Suite 2: Authentication & Host Header Security ---');

  const authToken = bridge.getAuthToken()!;

  await runTest('Security 2.1: Missing Authorization header returns HTTP 401', async () => {
    const res = await sendMcpRequest(endpointUrl, undefined, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list'
    });
    assertEqual(res.status, 401, 'Must return 401 Unauthorized');
    assert(res.body.error.includes('Unauthorized'), 'Error message indicates unauthorized');
  });

  await runTest('Security 2.2: Invalid Bearer token returns HTTP 401', async () => {
    const badToken = '0'.repeat(64);
    const res = await sendMcpRequest(endpointUrl, badToken, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list'
    });
    assertEqual(res.status, 401, 'Must return 401 Unauthorized for bad token');
  });

  await runTest('Security 2.3: Malformed scheme (Basic) returns HTTP 401', async () => {
    const res = await sendMcpRequest(
      endpointUrl,
      undefined,
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      { Authorization: `Basic dXNlcjpwYXNz` }
    );
    assertEqual(res.status, 401, 'Must return 401 for non-Bearer auth');
  });

  await runTest('Security 2.4: Constant-time comparison rejects unequal length tokens', () => {
    assert(!McpSecurity.verifyAuthToken('Bearer short', authToken), 'Rejects short token');
    assert(!McpSecurity.verifyAuthToken('Bearer ' + authToken + 'extra', authToken), 'Rejects longer token');
    assert(McpSecurity.verifyAuthToken('Bearer ' + authToken, authToken), 'Accepts identical token');
  });

  await runTest('Security 2.5: Valid Bearer token succeeds with HTTP 200', async () => {
    const res = await sendMcpRequest(endpointUrl, authToken, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/list'
    });
    assertEqual(res.status, 200, 'Must return 200 OK for valid bearer token');
    assert(res.body.result !== undefined, 'Response must contain result object');
  });

  await runTest('Security 2.6: Invalid Host header (DNS rebinding attack) returns HTTP 403', async () => {
    const res = await sendMcpRequest(
      endpointUrl,
      authToken,
      { jsonrpc: '2.0', id: 5, method: 'tools/list' },
      { Host: 'attacker.evil.com:80' }
    );
    assertEqual(res.status, 403, 'Must return 403 Forbidden for external Host header');
    assert(res.body.error.includes('Forbidden: Invalid Host header'), 'Error indicates invalid Host header');
  });

  await runTest('Security 2.7: Token redaction in logs replaces token with [REDACTED_AUTH_TOKEN]', () => {
    const rawLog = `Registered server with Bearer ${authToken} on port 49000`;
    const sanitized = McpSecurity.maskToken(rawLog, authToken);
    assert(!sanitized.includes(authToken), 'Sanitized log must NOT contain raw token');
    assert(sanitized.includes('[REDACTED_AUTH_TOKEN]'), 'Sanitized log contains [REDACTED_AUTH_TOKEN]');
  });

  // ----------------------------------------------------
  // SUITE 3: Tool Discovery (`tools/list`)
  // ----------------------------------------------------
  console.log('\n--- Suite 3: Tool Discovery (tools/list) ---');

  let discoveredTools: any[] = [];

  await runTest('Discovery 3.1: lists all 4 workspace tools plus smoke test tool', async () => {
    const res = await sendMcpRequest(endpointUrl, authToken, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/list'
    });
    assertEqual(res.status, 200, 'tools/list must return HTTP 200');
    assert(Array.isArray(res.body.result?.tools), 'Response tools must be array');
    discoveredTools = res.body.result.tools;

    const toolNames = discoveredTools.map((t) => t.name);
    assert(toolNames.includes('list_files'), 'Must contain list_files');
    assert(toolNames.includes('read_file'), 'Must contain read_file');
    assert(toolNames.includes('search_code'), 'Must contain search_code');
    assert(toolNames.includes('propose_edit'), 'Must contain propose_edit');
    assert(toolNames.includes('read_smoke_test_file'), 'Must contain read_smoke_test_file');
  });

  await runTest('Discovery 3.2: list_files inputSchema matches specification', () => {
    const tool = discoveredTools.find((t) => t.name === 'list_files');
    assert(tool !== undefined, 'list_files must exist');
    assertEqual(tool.inputSchema.type, 'object', 'Schema type object');
    assert('directory' in tool.inputSchema.properties, 'Has directory property');
  });

  await runTest('Discovery 3.3: read_file inputSchema requires path argument', () => {
    const tool = discoveredTools.find((t) => t.name === 'read_file');
    assert(tool !== undefined, 'read_file must exist');
    assert(tool.inputSchema.required.includes('path'), 'path must be required in schema');
    assert('startLine' in tool.inputSchema.properties, 'Has startLine property');
    assert('endLine' in tool.inputSchema.properties, 'Has endLine property');
  });

  await runTest('Discovery 3.4: search_code inputSchema requires query argument', () => {
    const tool = discoveredTools.find((t) => t.name === 'search_code');
    assert(tool !== undefined, 'search_code must exist');
    assert(tool.inputSchema.required.includes('query'), 'query must be required in schema');
    assert('maxMatches' in tool.inputSchema.properties, 'Has maxMatches property');
  });

  await runTest('Discovery 3.5: propose_edit inputSchema requires path and replacementCode', () => {
    const tool = discoveredTools.find((t) => t.name === 'propose_edit');
    assert(tool !== undefined, 'propose_edit must exist');
    assert(tool.inputSchema.required.includes('path'), 'path is required');
    assert(tool.inputSchema.required.includes('replacementCode'), 'replacementCode is required');
    assert('startLine' in tool.inputSchema.properties, 'Has startLine');
    assert('endLine' in tool.inputSchema.properties, 'Has endLine');
    assert('explanation' in tool.inputSchema.properties, 'Has explanation');
  });

  // ----------------------------------------------------
  // SUITE 4: Tool Invocation (`tools/call`) — Functional Verification
  // ----------------------------------------------------
  console.log('\n--- Suite 4: Tool Invocation (tools/call) ---');

  await runTest('Invocation 4.1: list_files returns workspace files', async () => {
    const res = await sendMcpRequest(endpointUrl, authToken, {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: 'list_files',
        arguments: {}
      }
    });
    assertEqual(res.status, 200, 'Must return 200');
    assert(!res.body.result?.isError, 'isError must be false');
    const text = res.body.result?.content?.[0]?.text;
    assert(text.includes('package.json'), 'Output must include package.json');
  });

  await runTest('Invocation 4.2: list_files filters by directory', async () => {
    const res = await sendMcpRequest(endpointUrl, authToken, {
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: {
        name: 'list_files',
        arguments: { directory: 'src/mcp' }
      }
    });
    assertEqual(res.status, 200, 'Must return 200');
    const text = res.body.result?.content?.[0]?.text;
    assert(text.includes('LocalMcpBridge.ts'), 'Output must include LocalMcpBridge.ts');
  });

  await runTest('Invocation 4.3: read_file reads file with line numbers', async () => {
    const res = await sendMcpRequest(endpointUrl, authToken, {
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: {
        name: 'read_file',
        arguments: { path: 'package.json', startLine: 1, endLine: 5 }
      }
    });
    assertEqual(res.status, 200, 'Must return 200');
    assert(!res.body.result?.isError, 'isError must be false');
    const text = res.body.result?.content?.[0]?.text;
    assert(text.includes('1 | {'), 'Output must format line 1 with number');
  });

  await runTest('Invocation 4.4: read_file handles out of range startLine safely', async () => {
    const res = await sendMcpRequest(endpointUrl, authToken, {
      jsonrpc: '2.0',
      id: 23,
      method: 'tools/call',
      params: {
        name: 'read_file',
        arguments: { path: 'package.json', startLine: 99999 }
      }
    });
    assertEqual(res.status, 200, 'Must return 200');
    assert(Boolean(res.body.result?.isError), 'isError must be true for out of range');
    assert(res.body.result?.content?.[0]?.text.includes('exceeds file length'), 'Output reports range error');
  });

  await runTest('Invocation 4.5: search_code finds matching query text', async () => {
    const res = await sendMcpRequest(endpointUrl, authToken, {
      jsonrpc: '2.0',
      id: 24,
      method: 'tools/call',
      params: {
        name: 'search_code',
        arguments: { query: 'LocalMcpBridge' }
      }
    });
    assertEqual(res.status, 200, 'Must return 200');
    assert(!res.body.result?.isError, 'isError must be false');
    const text = res.body.result?.content?.[0]?.text;
    assert(text.includes('LocalMcpBridge'), 'Output must contain matched query');
  });

  await runTest('Invocation 4.6: propose_edit stages valid replacement for review', async () => {
    const res = await sendMcpRequest(endpointUrl, authToken, {
      jsonrpc: '2.0',
      id: 25,
      method: 'tools/call',
      params: {
        name: 'propose_edit',
        arguments: {
          path: 'package.json',
          replacementCode: '{\n  "name": "trueforge-vscode"\n}',
          explanation: 'MCP test proposed edit'
        }
      }
    });
    assertEqual(res.status, 200, 'Must return 200');
    assert(!res.body.result?.isError, 'isError must be false');
    const text = res.body.result?.content?.[0]?.text;
    assert(text.includes('Proposed modifications staged'), 'Output reports proposed modifications staged');
    assert(text.includes('User diff review required'), 'Output enforces review requirement');
    assert(bridgeLastProposal !== undefined, 'bridgeLastProposal captured by onProposeEdit callback');
  });

  // ----------------------------------------------------
  // SUITE 5: Security Boundaries & Path Traversal Protections
  // ----------------------------------------------------
  console.log('\n--- Suite 5: Security Boundaries & Path Traversal Protections ---');

  await runTest('Security 5.1: read_file rejects relative path traversal (../)', async () => {
    const res = await sendMcpRequest(endpointUrl, authToken, {
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/call',
      params: {
        name: 'read_file',
        arguments: { path: '../../Windows/win.ini' }
      }
    });
    assertEqual(res.status, 200, 'Must return 200');
    assert(Boolean(res.body.result?.isError), 'isError must be true for traversal');
    assert(res.body.result?.content?.[0]?.text.includes('Access denied'), 'Output reports access denied');
  });

  await runTest('Security 5.2: read_file rejects absolute path outside workspace', async () => {
    const res = await sendMcpRequest(endpointUrl, authToken, {
      jsonrpc: '2.0',
      id: 31,
      method: 'tools/call',
      params: {
        name: 'read_file',
        arguments: { path: 'C:/Windows/System32/drivers/etc/hosts' }
      }
    });
    assert(Boolean(res.body.result?.isError), 'isError must be true');
    assert(res.body.result?.content?.[0]?.text.includes('Access denied'), 'Access denied on absolute path outside workspace');
  });

  await runTest('Security 5.3: list_files rejects directory traversal (../)', async () => {
    const res = await sendMcpRequest(endpointUrl, authToken, {
      jsonrpc: '2.0',
      id: 32,
      method: 'tools/call',
      params: {
        name: 'list_files',
        arguments: { directory: '../..' }
      }
    });
    assert(Boolean(res.body.result?.isError), 'isError must be true');
    assert(res.body.result?.content?.[0]?.text.includes('Access denied'), 'Access denied on directory traversal');
  });

  await runTest('Security 5.4: propose_edit rejects path traversal outside workspace', async () => {
    const res = await sendMcpRequest(endpointUrl, authToken, {
      jsonrpc: '2.0',
      id: 33,
      method: 'tools/call',
      params: {
        name: 'propose_edit',
        arguments: {
          path: '../../malicious.ts',
          replacementCode: 'console.log("hacked");'
        }
      }
    });
    assert(Boolean(res.body.result?.isError), 'isError must be true');
    assert(res.body.result?.content?.[0]?.text.includes('Access denied'), 'Access denied on propose_edit path traversal');
  });

  await runTest('Security 5.5: read_file rejects .env and secret files', async () => {
    const secretPath = path.join(workspaceRoot, '.env.secret_test');
    fs.writeFileSync(secretPath, 'SECRET_KEY=12345', 'utf8');
    try {
      const res = await sendMcpRequest(endpointUrl, authToken, {
        jsonrpc: '2.0',
        id: 34,
        method: 'tools/call',
        params: {
          name: 'read_file',
          arguments: { path: '.env.secret_test' }
        }
      });
      assert(Boolean(res.body.result?.isError), 'isError must be true for .env secret file');
      assert(res.body.result?.content?.[0]?.text.includes('Access denied'), 'Access denied for secret file');
    } finally {
      if (fs.existsSync(secretPath)) fs.unlinkSync(secretPath);
    }
  });

  await runTest('Security 5.6: read_file and propose_edit reject SQLite database files', async () => {
    const resRead = await sendMcpRequest(endpointUrl, authToken, {
      jsonrpc: '2.0',
      id: 35,
      method: 'tools/call',
      params: {
        name: 'read_file',
        arguments: { path: 'data/trueforge.sqlite' }
      }
    });
    assert(Boolean(resRead.body.result?.isError), 'isError true for sqlite read');

    const resEdit = await sendMcpRequest(endpointUrl, authToken, {
      jsonrpc: '2.0',
      id: 36,
      method: 'tools/call',
      params: {
        name: 'propose_edit',
        arguments: { path: 'data/trueforge.sqlite', replacementCode: 'corrupted' }
      }
    });
    assert(Boolean(resEdit.body.result?.isError), 'isError true for sqlite propose_edit');
  });

  // ----------------------------------------------------
  // SUITE 6: Invalid Arguments Handling (MCP Protocol Compliance)
  // ----------------------------------------------------
  console.log('\n--- Suite 6: Invalid Arguments Handling ---');

  await runTest('Protocol 6.1: read_file without path returns InvalidParams (-32602)', async () => {
    const res = await sendMcpRequest(endpointUrl, authToken, {
      jsonrpc: '2.0',
      id: 40,
      method: 'tools/call',
      params: {
        name: 'read_file',
        arguments: {}
      }
    });
    assert(res.body.error !== undefined, 'Must return JSON-RPC error');
    assertEqual(res.body.error.code, -32602, 'Error code must be -32602 (InvalidParams)');
  });

  await runTest('Protocol 6.2: search_code without query returns InvalidParams (-32602)', async () => {
    const res = await sendMcpRequest(endpointUrl, authToken, {
      jsonrpc: '2.0',
      id: 41,
      method: 'tools/call',
      params: {
        name: 'search_code',
        arguments: {}
      }
    });
    assert(res.body.error !== undefined, 'Must return JSON-RPC error');
    assertEqual(res.body.error.code, -32602, 'Error code must be -32602 (InvalidParams)');
  });

  await runTest('Protocol 6.3: propose_edit without replacementCode returns InvalidParams (-32602)', async () => {
    const res = await sendMcpRequest(endpointUrl, authToken, {
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: {
        name: 'propose_edit',
        arguments: { path: 'package.json' }
      }
    });
    assert(res.body.error !== undefined, 'Must return JSON-RPC error');
    assertEqual(res.body.error.code, -32602, 'Error code must be -32602 (InvalidParams)');
  });

  await runTest('Protocol 6.4: Unknown tool call returns MethodNotFound (-32601)', async () => {
    const res = await sendMcpRequest(endpointUrl, authToken, {
      jsonrpc: '2.0',
      id: 43,
      method: 'tools/call',
      params: {
        name: 'non_existent_tool_xyz',
        arguments: {}
      }
    });
    assert(res.body.error !== undefined, 'Must return JSON-RPC error');
    assertEqual(res.body.error.code, -32601, 'Error code must be -32601 (MethodNotFound)');
  });

  // ----------------------------------------------------
  // SUITE 7: Proposed-Edit Safety & Review-First Workflow
  // ----------------------------------------------------
  console.log('\n--- Suite 7: Proposed-Edit Safety & Review-First Workflow ---');

  const mcpTargetFile = path.join(workspaceRoot, 'src', 'test', 'temp_mcp_safety.ts');
  const mcpTargetContent = [
    'export function originalAlpha(): number {',
    '  return 100;',
    '}',
    '',
    'export function originalBeta(): string {',
    '  return "untouched";',
    '}'
  ].join('\n');

  await runTest('Safety 7.1: Setup test target file', () => {
    fs.writeFileSync(mcpTargetFile, mcpTargetContent, 'utf8');
    assert(fs.existsSync(mcpTargetFile), 'Target file must exist');
  });

  await runTest('Safety 7.2: MCP propose_edit leaves disk file 100% untouched before user accept', async () => {
    const hashBefore = crypto.createHash('sha256').update(fs.readFileSync(mcpTargetFile)).digest('hex');

    const res = await sendMcpRequest(endpointUrl, authToken, {
      jsonrpc: '2.0',
      id: 50,
      method: 'tools/call',
      params: {
        name: 'propose_edit',
        arguments: {
          path: 'src/test/temp_mcp_safety.ts',
          startLine: 1,
          endLine: 3,
          replacementCode: 'export function originalAlpha(): number {\n  return 999;\n}',
          explanation: 'Update alpha to return 999'
        }
      }
    });

    assertEqual(res.status, 200, 'propose_edit returns 200');
    assert(!res.body.result?.isError, 'propose_edit must succeed');

    // Verify disk content and SHA-256 hash are 100% untouched
    const diskContentAfter = fs.readFileSync(mcpTargetFile, 'utf8');
    const hashAfter = crypto.createHash('sha256').update(diskContentAfter).digest('hex');

    assertEqual(diskContentAfter, mcpTargetContent, 'Disk content must remain identical to original baseline');
    assertEqual(hashAfter, hashBefore, 'Disk SHA-256 hash must remain bit-for-bit identical');
  });

  await runTest('Safety 7.3: Cleanup test target file and stop bridge', async () => {
    if (fs.existsSync(mcpTargetFile)) fs.unlinkSync(mcpTargetFile);
    await bridge.stop();
    assertEqual(bridge.getPort(), undefined, 'Bridge port cleared on stop');
    assertEqual(bridge.getAuthToken(), undefined, 'Bridge auth token dereferenced on stop');
  });

  // ----------------------------------------------------
  // SUITE 8: TrueForge Live Server Registration Attempt & SSRF Policy Documentation
  // ----------------------------------------------------
  console.log('\n--- Suite 8: TrueForge Live Server Registration & SSRF Blocker Verification ---');

  const connection = new TrueForgeConnection({ baseUrl: 'http://localhost:8790' });

  await runTest('Live 8.1: TrueForge server health check returns HTTP 200 OK', async () => {
    const health = await connection.checkHealth();
    assert(health.ok, 'TrueForge health check must succeed');
  });

  await runTest('Live 8.2: Live registration of unallowed private IP is rejected by TrueForge outbound SSRF guard', async () => {
    const liveInstanceId = McpSecurity.generateInstanceId();
    const liveServerName = `vscode-tools-${liveInstanceId}`;

    let registrationBlocked = false;
    let blockedErrorMessage = '';

    try {
      await connection.getClient().settings.mcpServers.createOrUpdate({
        manifest: {
          name: liveServerName,
          description: 'Live MCP SSRF test',
          type: 'remote',
          url: 'http://10.0.0.1:8799/mcp',
          auth: {
            type: 'header',
            headers: {
              authorization: 'Bearer test'
            }
          }
        }
      });
    } catch (err: unknown) {
      registrationBlocked = true;
      blockedErrorMessage = err instanceof Error ? err.message : String(err);
    } finally {
      // Clean rollback
      try {
        await connection.getClient().settings.mcpServers.delete(liveServerName);
      } catch {
        // Ignore delete of non-existent registration
      }
    }

    assert(registrationBlocked, 'Live registration of unallowed private IP must be rejected by TrueForge');
    assert(
      blockedErrorMessage.includes('Outbound URL blocked') || blockedErrorMessage.includes('10.0.0.1'),
      `Error message must indicate outbound URL blocked: "${blockedErrorMessage}"`
    );
  });

  // ----------------------------------------------------
  // SUITE 9: Preferred Port, Fallback on Occupation, and Lifecycle Management
  // ----------------------------------------------------
  console.log('\n--- Suite 9: Preferred Port & Lifecycle Management ---');

  await runTest('Port 9.1: Port configuration validation enforces 1-65535, defaulting to 8799', () => {
    assertEqual(McpSecurity.validatePort(8799), 8799, '8799 is valid');
    assertEqual(McpSecurity.validatePort(3000), 3000, '3000 is valid');
    assertEqual(McpSecurity.validatePort(65535), 65535, '65535 is valid');
    assertEqual(McpSecurity.validatePort(1), 1, '1 is valid');
    assertEqual(McpSecurity.validatePort(0, 8799, true), 0, '0 is valid when allowZero is true');
    assertEqual(McpSecurity.validatePort(-1), 8799, '-1 falls back to default 8799');
    assertEqual(McpSecurity.validatePort(70000), 8799, '70000 falls back to default 8799');
    assertEqual(McpSecurity.validatePort(3.14), 8799, 'Float falls back to default 8799');
    assertEqual(McpSecurity.validatePort('8799'), 8799, 'String falls back to default 8799');
    assertEqual(McpSecurity.validatePort(undefined), 8799, 'undefined falls back to default 8799');
    assertEqual(McpSecurity.validatePort(null), 8799, 'null falls back to default 8799');
    assertEqual(McpSecurity.validatePort(NaN), 8799, 'NaN falls back to default 8799');

    assertEqual(McpLifecycleManager.validatePort(8799), 8799, 'LifecycleManager validates 8799');
    assertEqual(McpLifecycleManager.validatePort(0), 8799, 'LifecycleManager rejects port 0 and defaults to 8799');
    assertEqual(McpLifecycleManager.validatePort(-5), 8799, 'LifecycleManager rejects negative port');
    assertEqual(McpLifecycleManager.resolveConfiguredPort(9000), 9000, 'resolveConfiguredPort accepts valid override');
    assertEqual(McpLifecycleManager.resolveConfiguredPort(undefined), 8799, 'resolveConfiguredPort defaults to 8799');
  });

  await runTest('Port 9.2: Binds to available preferred port without fallback', async () => {
    const freePort = await getFreePort();
    const instId = McpSecurity.generateInstanceId();
    const testBridge = new LocalMcpBridge({
      instanceId: instId,
      workspaceRoot,
      tools,
      preferredPort: freePort
    });

    try {
      const res = await testBridge.start();
      assertEqual(res.port, freePort, 'Bound port must match preferred port');
      assertEqual(res.fallbackOccurred, false, 'fallbackOccurred must be false');
      assertEqual(testBridge.getPort(), freePort, 'bridge.getPort() matches');
      assertEqual(testBridge.getPreferredPort(), freePort, 'bridge.getPreferredPort() matches');
      assertEqual(testBridge.getIsFallbackPort(), false, 'bridge.getIsFallbackPort() is false');
    } finally {
      await testBridge.stop();
    }
  });

  await runTest('Port 9.3: Falls back to OS-assigned port when preferred port is occupied', async () => {
    // 1. Occupy a loopback port with a blocker HTTP server
    const occupiedPort = await getFreePort();
    const blockerServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('occupied');
    });
    await new Promise<void>((resolve, reject) => {
      blockerServer.listen(occupiedPort, '127.0.0.1', () => resolve());
      blockerServer.on('error', reject);
    });

    const instId = McpSecurity.generateInstanceId();
    const testBridge = new LocalMcpBridge({
      instanceId: instId,
      workspaceRoot,
      tools,
      preferredPort: occupiedPort
    });

    try {
      const res = await testBridge.start();
      assert(res.port > 0, 'Assigned port must be > 0');
      assert(res.port !== occupiedPort, `Assigned port (${res.port}) must differ from occupied port (${occupiedPort})`);
      assertEqual(res.fallbackOccurred, true, 'fallbackOccurred must be true');
      assertEqual(testBridge.getIsFallbackPort(), true, 'bridge.getIsFallbackPort() must be true');
      assertEqual(testBridge.getPreferredPort(), occupiedPort, 'bridge.getPreferredPort() preserves target');
      assertEqual(testBridge.getPort(), res.port, 'bridge.getPort() matches assigned port');

      // Verify the fallback port is functional and serves tools/list
      const listRes = await sendMcpRequest(
        res.url,
        testBridge.getAuthToken(),
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
      );
      assertEqual(listRes.status, 200, 'Fallback server must respond with 200');
      assert(Array.isArray(listRes.body?.result?.tools), 'Response must include tools list');
    } finally {
      await testBridge.stop();
      await new Promise<void>((resolve) => blockerServer.close(() => resolve()));
    }
  });

  await runTest('Security 9.4: Authentication and Host-header validation on fallback port', async () => {
    const occupiedPort = await getFreePort();
    const blockerServer = http.createServer((_req, res) => res.end('occupied'));
    await new Promise<void>((resolve) => blockerServer.listen(occupiedPort, '127.0.0.1', () => resolve()));

    const instId = McpSecurity.generateInstanceId();
    const testBridge = new LocalMcpBridge({
      instanceId: instId,
      workspaceRoot,
      tools,
      preferredPort: occupiedPort
    });

    try {
      const res = await testBridge.start();
      const validToken = testBridge.getAuthToken()!;

      // 1. Missing Authorization header -> 401
      const noAuth = await sendMcpRequest(res.url, undefined, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      assertEqual(noAuth.status, 401, 'Missing token on fallback port must return 401');

      // 2. Invalid Bearer token -> 401
      const badAuth = await sendMcpRequest(res.url, 'wrong-token-abc', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      assertEqual(badAuth.status, 401, 'Invalid token on fallback port must return 401');

      // 3. Spoofed Host header (DNS rebinding) -> 403
      const spoofedHost = await sendMcpRequest(
        res.url,
        validToken,
        { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
        { Host: `attacker.com:${res.port}` }
      );
      assertEqual(spoofedHost.status, 403, 'Spoofed Host header on fallback port must return 403');

      // 4. Valid Host header + Bearer token -> 200
      const validReq = await sendMcpRequest(
        res.url,
        validToken,
        { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }
      );
      assertEqual(validReq.status, 200, 'Valid request on fallback port must return 200');
    } finally {
      await testBridge.stop();
      await new Promise<void>((resolve) => blockerServer.close(() => resolve()));
    }
  });

  await runTest('Lifecycle 9.5: McpLifecycleManager start, health snapshot, stop, and cleanup', async () => {
    const preferredPort = await getFreePort();
    const manager = new McpLifecycleManager({
      workspaceRoot,
      tools,
      preferredPort
    });

    // Initial state
    assertEqual(manager.getStatus(), 'stopped', 'Initial status must be stopped');
    const initialHealth = manager.getHealth();
    assertEqual(initialHealth.running, false, 'Initial health running must be false');
    assertEqual(initialHealth.status, 'stopped', 'Initial health status must be stopped');

    // Start manager
    const startInfo = await manager.start();
    assertEqual(manager.getStatus(), 'running', 'Status after start must be running');
    assertEqual(startInfo.port, preferredPort, 'Started port matches preferred');
    assertEqual(startInfo.fallbackOccurred, false, 'No fallback occurred');

    // Running health check
    const runningHealth = manager.getHealth();
    assertEqual(runningHealth.running, true, 'Running health must be true');
    assertEqual(runningHealth.status, 'running', 'Health status must be running');
    assertEqual(runningHealth.port, preferredPort, 'Health port matches');
    assertEqual(runningHealth.preferredPort, preferredPort, 'Health preferredPort matches');
    assertEqual(runningHealth.isFallbackPort, false, 'Health isFallbackPort is false');
    assert(Boolean(runningHealth.url?.startsWith(`http://127.0.0.1:${preferredPort}`)), 'Health URL matches');
    assert(typeof runningHealth.uptimeMs === 'number' && runningHealth.uptimeMs >= 0, 'Uptime reported');

    // Second start returns existing running bridge
    const secondStart = await manager.start();
    assertEqual(secondStart.port, preferredPort, 'Idempotent start returns same port');

    // Functional call via manager bridge
    const token = manager.getBridge()?.getAuthToken();
    const pingRes = await sendMcpRequest(
      runningHealth.url!,
      token,
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
    );
    assertEqual(pingRes.status, 200, 'Bridge started by manager must respond with 200');

    // Stop manager
    await manager.stop();
    assertEqual(manager.getStatus(), 'stopped', 'Status after stop must be stopped');
    const stoppedHealth = manager.getHealth();
    assertEqual(stoppedHealth.running, false, 'Running health must be false after stop');
    assertEqual(manager.getBridge(), undefined, 'Bridge must be undefined after stop');
  });

  await runTest('Lifecycle 9.6: McpLifecycleManager restart and dispose', async () => {
    const portA = await getFreePort();
    const portB = await getFreePort();
    const manager = new McpLifecycleManager({
      workspaceRoot,
      tools,
      preferredPort: portA
    });

    try {
      const resA = await manager.start();
      assertEqual(resA.port, portA, 'Starts on portA');

      // Restart with portB
      const resB = await manager.restart(portB);
      assertEqual(resB.port, portB, 'Restarts on portB');
      assertEqual(manager.getHealth().running, true, 'Running after restart');

      // Dispose
      await manager.dispose();
      assertEqual(manager.getStatus(), 'stopped', 'Status is stopped after dispose');
      assertEqual(manager.getHealth().running, false, 'Not running after dispose');
    } finally {
      await manager.dispose();
    }
  });

  // ----------------------------------------------------
  // SUITE 10: Native TrueForge MCP Connector Registration (Phase 2)
  // ----------------------------------------------------
  console.log('\n--- Suite 10: Native TrueForge MCP Connector Registration ---');

  interface MockMcpServerEntry {
    name: string;
    manifest: any;
    authStatus?: any;
  }

  function createMockTrueForgeConnection(options?: {
    initialServers?: MockMcpServerEntry[];
    onGet?: (name: string) => any;
    onCreateOrUpdate?: (request: any) => any;
    onDelete?: (name: string) => any;
    onListTools?: (name: string) => any;
    baseUrl?: string;
  }) {
    const serversMap = new Map<string, MockMcpServerEntry>();
    if (options?.initialServers) {
      for (const s of options.initialServers) {
        serversMap.set(s.name, s);
      }
    }

    const calls = {
      get: [] as string[],
      createOrUpdate: [] as any[],
      delete: [] as string[],
      listTools: [] as string[],
      list: 0
    };

    const mockClient: any = {
      settings: {
        mcpServers: {
          get: async (name: string) => {
            calls.get.push(name);
            if (options?.onGet) {
              return options.onGet(name);
            }
            const existing = serversMap.get(name);
            if (!existing) {
              const notFoundErr: any = new Error(`MCP server not found: ${name}`);
              notFoundErr.statusCode = 404;
              notFoundErr.body = { error: { message: `MCP server not found: ${name}`, code: 'NOT_FOUND' } };
              throw notFoundErr;
            }
            return { data: existing };
          },
          createOrUpdate: async (req: any) => {
            calls.createOrUpdate.push(req);
            if (options?.onCreateOrUpdate) {
              return options.onCreateOrUpdate(req);
            }
            const serverEntry: MockMcpServerEntry = {
              name: req.manifest.name,
              manifest: req.manifest,
              authStatus: { status: 'authorized' }
            };
            serversMap.set(req.manifest.name, serverEntry);
            return { data: serverEntry };
          },
          list: async () => {
            calls.list++;
            return { data: Array.from(serversMap.values()) };
          },
          delete: async (name: string) => {
            calls.delete.push(name);
            if (options?.onDelete) {
              return options.onDelete(name);
            }
            if (!serversMap.has(name)) {
              const notFoundErr: any = new Error(`MCP server not found: ${name}`);
              notFoundErr.statusCode = 404;
              throw notFoundErr;
            }
            serversMap.delete(name);
            return { data: { success: true } };
          }
        }
      },
      mcpServers: {
        listTools: async (name: string) => {
          calls.listTools.push(name);
          if (options?.onListTools) {
            return options.onListTools(name);
          }
          return {
            data: [
              { name: 'read_smoke_test_file', description: 'smoke test tool' },
              { name: 'search_code', description: 'search code tool' },
              { name: 'read_file', description: 'read file tool' },
              { name: 'list_files', description: 'list files tool' },
              { name: 'propose_edit', description: 'propose edit tool' }
            ]
          };
        }
      }
    };

    const connection = {
      getClient: () => mockClient,
      getBaseUrl: () => options?.baseUrl ?? 'http://localhost:8790'
    } as unknown as TrueForgeConnection;

    return { connection, serversMap, calls };
  }

  await runTest('Registrar 10.1: Check connector exists when absent (404 returns exists: false)', async () => {
    const mock = createMockTrueForgeConnection();
    const registrar = new McpConnectorRegistrar({ connection: mock.connection });

    const status = await registrar.checkConnectorExists();
    assertEqual(status.exists, false, 'status.exists must be false when connector absent');
    assertEqual(status.name, 'vscode-tools', 'status.name must be vscode-tools');
    assertEqual(status.error, undefined, 'status.error must be undefined on normal 404');
    assertEqual(mock.calls.get.length, 1, 'Called client.settings.mcpServers.get once');
    assertEqual(mock.calls.get[0], 'vscode-tools', 'Called with connector name vscode-tools');
  });

  await runTest('Registrar 10.2: Register new connector (absent -> created)', async () => {
    const port = await getFreePort();
    const testBridge = new LocalMcpBridge({
      instanceId: McpSecurity.generateInstanceId(),
      workspaceRoot,
      tools,
      preferredPort: port
    });

    try {
      await testBridge.start();
      const mock = createMockTrueForgeConnection();
      const registrar = new McpConnectorRegistrar({
        connection: mock.connection,
        bridge: testBridge
      });

      const result = await registrar.registerConnector({ verifyTools: true });
      assertEqual(result.success, true, 'Registration must succeed');
      assertEqual(result.action, 'created', 'Action must be created');
      assertEqual(result.connectorName, 'vscode-tools', 'Connector name must be vscode-tools');
      assertEqual(result.url, testBridge.getUrl(), 'Result URL must match bridge URL');
      assert(Boolean(result.toolsDiscovered && result.toolsDiscovered.length > 0), 'Tools discovered must be populated');

      // Verify stored manifest in TrueForge
      assert(mock.serversMap.has('vscode-tools'), 'vscode-tools must be saved in TrueForge');
      const saved = mock.serversMap.get('vscode-tools')!;
      assertEqual(saved.manifest.type, 'remote', 'Manifest type must be remote');
      assertEqual(saved.manifest.name, 'vscode-tools', 'Manifest name must be vscode-tools');
      assertEqual(saved.manifest.url, testBridge.getUrl(), 'Manifest URL must match');
      assertEqual(saved.manifest.auth.type, 'header', 'Auth type must be header');
      assertEqual(
        saved.manifest.auth.headers.authorization,
        `Bearer ${testBridge.getAuthToken()}`,
        'Authorization header must match bearer token'
      );
    } finally {
      await testBridge.stop();
    }
  });

  await runTest('Registrar 10.3: Idempotent registration when already registered with matching URL', async () => {
    const port = await getFreePort();
    const testBridge = new LocalMcpBridge({
      instanceId: McpSecurity.generateInstanceId(),
      workspaceRoot,
      tools,
      preferredPort: port
    });

    try {
      await testBridge.start();
      const bridgeUrl = testBridge.getUrl()!;
      const token = testBridge.getAuthToken()!;

      const mock = createMockTrueForgeConnection({
        initialServers: [
          {
            name: 'vscode-tools',
            manifest: {
              type: 'remote',
              name: 'vscode-tools',
              url: bridgeUrl,
              description: 'Local workspace tools',
              auth: {
                type: 'header',
                headers: { authorization: `Bearer ${token}` }
              }
            },
            authStatus: { status: 'authorized' }
          }
        ]
      });

      const registrar = new McpConnectorRegistrar({
        connection: mock.connection,
        bridge: testBridge
      });

      const result = await registrar.registerConnector({ verifyTools: true });
      assertEqual(result.success, true, 'Registration succeeds idempotently');
      assertEqual(result.action, 'already_registered', 'Action must be already_registered');
      assertEqual(result.connectorName, 'vscode-tools', 'Name must be vscode-tools');
      assertEqual(mock.calls.createOrUpdate.length, 0, 'No redundant write made when already registered');
    } finally {
      await testBridge.stop();
    }
  });

  await runTest('Registrar 10.4: Update / token rotation on URL change or forceUpdate', async () => {
    const port = await getFreePort();
    const testBridge = new LocalMcpBridge({
      instanceId: McpSecurity.generateInstanceId(),
      workspaceRoot,
      tools,
      preferredPort: port
    });

    try {
      await testBridge.start();
      const mock = createMockTrueForgeConnection({
        initialServers: [
          {
            name: 'vscode-tools',
            manifest: {
              type: 'remote',
              name: 'vscode-tools',
              url: 'http://127.0.0.1:9999/mcp', // Stale URL
              description: 'Local workspace tools',
              auth: {
                type: 'header',
                headers: { authorization: 'Bearer stale-token-12345' }
              }
            },
            authStatus: { status: 'authorized' }
          }
        ]
      });

      const registrar = new McpConnectorRegistrar({
        connection: mock.connection,
        bridge: testBridge
      });

      // 1. Stale URL triggers update
      const res1 = await registrar.registerConnector({ verifyTools: false });
      assertEqual(res1.success, true, 'Update succeeds');
      assertEqual(res1.action, 'updated', 'Action must be updated');
      assertEqual(mock.calls.createOrUpdate.length, 1, 'createOrUpdate called once');
      const updatedManifest = mock.serversMap.get('vscode-tools')!.manifest;
      assertEqual(updatedManifest.url, testBridge.getUrl(), 'URL updated to active bridge URL');
      assertEqual(
        updatedManifest.auth.headers.authorization,
        `Bearer ${testBridge.getAuthToken()}`,
        'Token rotated to active bridge token'
      );

      // 2. forceUpdate triggers update even when URL matches
      const res2 = await registrar.registerConnector({ forceUpdate: true, verifyTools: false });
      assertEqual(res2.success, true, 'Force update succeeds');
      assertEqual(res2.action, 'updated', 'Action must be updated on forceUpdate');
      assertEqual(mock.calls.createOrUpdate.length, 2, 'createOrUpdate called again on forceUpdate');
    } finally {
      await testBridge.stop();
    }
  });

  await runTest('Registrar 10.5: Preservation and isolation of unrelated MCP servers', async () => {
    const port = await getFreePort();
    const testBridge = new LocalMcpBridge({
      instanceId: McpSecurity.generateInstanceId(),
      workspaceRoot,
      tools,
      preferredPort: port
    });

    try {
      await testBridge.start();
      const sqliteManifest = {
        type: 'remote',
        name: 'sqlite-tools',
        url: 'http://10.0.0.5:8000/mcp',
        description: 'SQLite database query tools'
      };
      const githubManifest = {
        type: 'remote',
        name: 'github-mcp',
        url: 'https://mcp.github.com/api',
        description: 'GitHub MCP integration'
      };

      const mock = createMockTrueForgeConnection({
        initialServers: [
          { name: 'sqlite-tools', manifest: sqliteManifest },
          { name: 'github-mcp', manifest: githubManifest }
        ]
      });

      const registrar = new McpConnectorRegistrar({
        connection: mock.connection,
        bridge: testBridge
      });

      // List other servers before registration
      const othersBefore = await registrar.listOtherMcpServers();
      assertEqual(othersBefore.length, 2, 'Two other servers exist before registration');
      assert(othersBefore.some((s) => s.name === 'sqlite-tools'), 'sqlite-tools listed');
      assert(othersBefore.some((s) => s.name === 'github-mcp'), 'github-mcp listed');

      // Register vscode-tools
      const regRes = await registrar.registerConnector({ verifyTools: false });
      assertEqual(regRes.success, true, 'Registration succeeds');

      // Verify other servers were completely untouched
      assertEqual(mock.serversMap.size, 3, 'Total 3 servers in TrueForge store');
      assertEqual(mock.serversMap.get('sqlite-tools')!.manifest, sqliteManifest, 'sqlite-tools untouched');
      assertEqual(mock.serversMap.get('github-mcp')!.manifest, githubManifest, 'github-mcp untouched');

      // List other servers after registration: vscode-tools is filtered out
      const othersAfter = await registrar.listOtherMcpServers();
      assertEqual(othersAfter.length, 2, 'Two other servers exist after registration');
      assert(!othersAfter.some((s) => s.name === 'vscode-tools'), 'vscode-tools excluded from other servers');
    } finally {
      await testBridge.stop();
    }
  });

  await runTest('Registrar 10.6: TrueForge server offline handling (SERVER_OFFLINE)', async () => {
    const port = await getFreePort();
    const testBridge = new LocalMcpBridge({
      instanceId: McpSecurity.generateInstanceId(),
      workspaceRoot,
      tools,
      preferredPort: port
    });

    try {
      await testBridge.start();
      const mock = createMockTrueForgeConnection({
        onGet: () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:8790');
        }
      });

      const registrar = new McpConnectorRegistrar({
        connection: mock.connection,
        bridge: testBridge
      });

      const result = await registrar.registerConnector();
      assertEqual(result.success, false, 'Result must be false on offline server');
      assertEqual(result.action, 'failed', 'Action must be failed');
      assertEqual(result.errorCode, 'SERVER_OFFLINE', 'ErrorCode must be SERVER_OFFLINE');
      assert(
        result.error?.includes('offline or unreachable') ?? false,
        'Error message must indicate offline or unreachable'
      );
    } finally {
      await testBridge.stop();
    }
  });

  await runTest('Registrar 10.7: SSRF rejection handling with OUTBOUND_URL_ALLOWED_HOSTS instruction', async () => {
    const port = await getFreePort();
    const testBridge = new LocalMcpBridge({
      instanceId: McpSecurity.generateInstanceId(),
      workspaceRoot,
      tools,
      preferredPort: port
    });

    try {
      await testBridge.start();
      const mock = createMockTrueForgeConnection({
        onCreateOrUpdate: () => {
          const ssrfErr: any = new Error('Outbound URL blocked');
          ssrfErr.statusCode = 400;
          ssrfErr.body = { error: { message: 'Outbound URL blocked', code: 'OUTBOUND_URL_BLOCKED' } };
          throw ssrfErr;
        }
      });

      const registrar = new McpConnectorRegistrar({
        connection: mock.connection,
        bridge: testBridge
      });

      const result = await registrar.registerConnector({ verifyTools: false });
      assertEqual(result.success, false, 'Result must be false on SSRF block');
      assertEqual(result.action, 'failed', 'Action must be failed');
      assertEqual(result.errorCode, 'SSRF_BLOCKED', 'ErrorCode must be SSRF_BLOCKED');
      assert(
        result.error?.includes('OUTBOUND_URL_ALLOWED_HOSTS') ?? false,
        'Error must specify OUTBOUND_URL_ALLOWED_HOSTS instruction'
      );
      assert(
        result.error?.includes('NETWORK_POLICY_ENABLED=true') ?? false,
        'Error must mention NETWORK_POLICY_ENABLED=true'
      );
    } finally {
      await testBridge.stop();
    }
  });

  await runTest('Registrar 10.8: Authentication failure handling (AUTH_FAILED)', async () => {
    const port = await getFreePort();
    const testBridge = new LocalMcpBridge({
      instanceId: McpSecurity.generateInstanceId(),
      workspaceRoot,
      tools,
      preferredPort: port
    });

    try {
      await testBridge.start();
      const mock = createMockTrueForgeConnection({
        onGet: () => {
          const authErr: any = new Error('Unauthorized');
          authErr.statusCode = 401;
          authErr.body = { error: { message: 'Invalid API key or token', code: 'UNAUTHORIZED' } };
          throw authErr;
        }
      });

      const registrar = new McpConnectorRegistrar({
        connection: mock.connection,
        bridge: testBridge
      });

      const result = await registrar.registerConnector();
      assertEqual(result.success, false, 'Result must be false on auth failure');
      assertEqual(result.action, 'failed', 'Action must be failed');
      assertEqual(result.errorCode, 'AUTH_FAILED', 'ErrorCode must be AUTH_FAILED');
      assert(
        result.error?.includes('authentication failed') ?? false,
        'Error message must indicate authentication failed'
      );
    } finally {
      await testBridge.stop();
    }
  });

  await runTest('Registrar 10.9: Strict bearer token confidentiality (token never leaked)', async () => {
    const port = await getFreePort();
    const testBridge = new LocalMcpBridge({
      instanceId: McpSecurity.generateInstanceId(),
      workspaceRoot,
      tools,
      preferredPort: port
    });

    try {
      await testBridge.start();
      const rawToken = testBridge.getAuthToken()!;
      assertEqual(rawToken.length, 64, 'Token must be 64-character hex');

      const logs: string[] = [];
      const mock = createMockTrueForgeConnection({
        onCreateOrUpdate: () => {
          // Simulate an error that reflects the header containing the raw token
          throw new Error(`Upstream rejected Authorization: Bearer ${rawToken}`);
        }
      });

      const registrar = new McpConnectorRegistrar({
        connection: mock.connection,
        bridge: testBridge,
        onLog: (msg) => logs.push(msg)
      });

      const result = await registrar.registerConnector({ verifyTools: false });
      assertEqual(result.success, false, 'Fails with reflected error');

      // Assert token is NEVER in result.error
      assert(
        !result.error?.includes(rawToken),
        `result.error must never contain raw bearer token (found: ${result.error})`
      );
      assert(
        !result.message.includes(rawToken),
        `result.message must never contain raw bearer token (found: ${result.message})`
      );

      // Assert token is NEVER in any log line
      for (const logLine of logs) {
        assert(
          !logLine.includes(rawToken),
          `Log line must never contain raw bearer token (found: ${logLine})`
        );
      }
    } finally {
      await testBridge.stop();
    }
  });

  await runTest('Registrar 10.10: Bridge not running error handling (BRIDGE_NOT_RUNNING)', async () => {
    const mock = createMockTrueForgeConnection();
    // Registrar created with no bridge and no lifecycle manager
    const registrar = new McpConnectorRegistrar({ connection: mock.connection });

    const result = await registrar.registerConnector();
    assertEqual(result.success, false, 'Result must be false when bridge not running');
    assertEqual(result.action, 'failed', 'Action must be failed');
    assertEqual(result.errorCode, 'BRIDGE_NOT_RUNNING', 'ErrorCode must be BRIDGE_NOT_RUNNING');
    assert(result.error?.includes('not running') ?? false, 'Error message indicates bridge not running');
  });

  await runTest('Registrar 10.11: Unregister connector and idempotent delete', async () => {
    const mock = createMockTrueForgeConnection({
      initialServers: [
        {
          name: 'vscode-tools',
          manifest: {
            type: 'remote',
            name: 'vscode-tools',
            url: 'http://127.0.0.1:8799/mcp',
            description: 'Local workspace tools'
          }
        }
      ]
    });

    const registrar = new McpConnectorRegistrar({ connection: mock.connection });

    // First delete succeeds
    const res1 = await registrar.unregisterConnector();
    assertEqual(res1.success, true, 'First unregister succeeds');
    assertEqual(mock.serversMap.has('vscode-tools'), false, 'vscode-tools removed from TrueForge');

    // Second delete handles 404 idempotently
    const res2 = await registrar.unregisterConnector();
    assertEqual(res2.success, true, 'Second unregister succeeds idempotently on 404');
  });

  await runTest('Registrar 10.12: Live tool verification with running LocalMcpBridge', async () => {
    const port = await getFreePort();
    const testBridge = new LocalMcpBridge({
      instanceId: McpSecurity.generateInstanceId(),
      workspaceRoot,
      tools,
      preferredPort: port
    });

    try {
      await testBridge.start();
      const bridgeUrl = testBridge.getUrl()!;
      const token = testBridge.getAuthToken()!;

      // Mock client routes listTools directly to live LocalMcpBridge over HTTP
      const mock = createMockTrueForgeConnection({
        onListTools: async (_name: string) => {
          const httpRes = await sendMcpRequest(bridgeUrl, token, {
            jsonrpc: '2.0',
            id: 100,
            method: 'tools/list',
            params: {}
          });
          assertEqual(httpRes.status, 200, 'Live bridge must respond with 200 to tools/list');
          return { data: httpRes.body.result.tools };
        }
      });

      const registrar = new McpConnectorRegistrar({
        connection: mock.connection,
        bridge: testBridge
      });

      const verify = await registrar.verifyTools();
      assertEqual(verify.success, true, 'verifyTools must succeed against live bridge');
      assert(verify.toolCount >= 4, 'Must discover at least 4 workspace tools');
      assert(verify.toolNames.includes('search_code'), 'Must include search_code');
      assert(verify.toolNames.includes('read_file'), 'Must include read_file');
      assert(verify.toolNames.includes('propose_edit'), 'Must include propose_edit');
      assert(verify.toolNames.includes('list_files'), 'Must include list_files');
      assert(verify.toolNames.includes('read_smoke_test_file'), 'Must include read_smoke_test_file');
    } finally {
      await testBridge.stop();
    }
  });

  await runTest('Registrar 10.13: Command trueforge.registerMcpConnector execution via VS Code command registry', async () => {
    const port = await getFreePort();
    const manager = new McpLifecycleManager({
      workspaceRoot,
      tools,
      preferredPort: port
    });

    try {
      await manager.start();
      const mock = createMockTrueForgeConnection();
      let infoShown = '';
      let errorShown = '';

      const registrar = new McpConnectorRegistrar({
        connection: mock.connection,
        lifecycleManager: manager
      });

      const disposable = vscode.commands.registerCommand('test.trueforge.registerMcpConnector', async () => {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'TrueForge: Registering local MCP connector (vscode-tools)...',
            cancellable: false
          },
          async () => {
            const result = await registrar.registerConnector({ forceUpdate: true, verifyTools: true });
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
              infoShown = `TrueForge: MCP connector "${result.connectorName}" is ${actionMsg}${countMsg}.`;
              vscode.window.showInformationMessage(infoShown);
            } else {
              errorShown = `TrueForge MCP Registration Failed: ${result.error || result.message}`;
              vscode.window.showErrorMessage(errorShown);
            }
          }
        );
      });

      try {
        await vscode.commands.executeCommand('test.trueforge.registerMcpConnector');
        assert(infoShown.includes('vscode-tools'), 'Info notification shown with vscode-tools');
        assertEqual(errorShown, '', 'No error notification shown on success');
        assert(mock.serversMap.has('vscode-tools'), 'Connector registered in TrueForge');
      } finally {
        disposable.dispose();
      }
    } finally {
      await manager.dispose();
    }
  });

  // ----------------------------------------------------
  // SUITE 11: MCP propose_edit -> VS Code Diff Integration
  // ----------------------------------------------------
  console.log('\n--- Suite 11: MCP propose_edit -> VS Code Diff Integration ---');

  // Re-provision target file for Suite 11 tests
  fs.writeFileSync(mcpTargetFile, mcpTargetContent, 'utf8');

  await runTest('Integration 11.1: Successful MCP proposal invokes onProposeEdit with correct structured data', async () => {
    const port = await getFreePort();
    let capturedProposal: ProposeEditResult | undefined;

    const testBridge = new LocalMcpBridge({
      instanceId: McpSecurity.generateInstanceId(),
      workspaceRoot,
      tools,
      preferredPort: port,
      onProposeEdit: async (prop) => {
        capturedProposal = prop;
        return true;
      }
    });

    try {
      await testBridge.start();
      const res = await sendMcpRequest(testBridge.getUrl()!, testBridge.getAuthToken(), {
        jsonrpc: '2.0',
        id: 1101,
        method: 'tools/call',
        params: {
          name: 'propose_edit',
          arguments: {
            path: 'src/test/temp_mcp_safety.ts',
            startLine: 1,
            endLine: 3,
            replacementCode: 'export function originalAlpha(): number {\n  return 888;\n}',
            explanation: 'Update alpha to return 888'
          }
        }
      });

      assertEqual(res.status, 200, 'propose_edit returns 200 OK');
      assert(!res.body.result?.isError, 'isError must be false on successful proposal');
      assert(capturedProposal !== undefined, 'onProposeEdit callback must be invoked');
      assertEqual(capturedProposal!.relativePath, 'src/test/temp_mcp_safety.ts', 'Relative path matches');
      assert(capturedProposal!.absolutePath.endsWith('temp_mcp_safety.ts'), 'Absolute path matches');
      assertEqual(capturedProposal!.startLine, 1, 'startLine is 1');
      assertEqual(capturedProposal!.endLine, 3, 'endLine is 3');
      assertEqual(capturedProposal!.explanation, 'Update alpha to return 888', 'Explanation matches');
      assert(capturedProposal!.replacementCode.includes('888'), 'Replacement code contains 888');
      assert(capturedProposal!.originalText.includes('originalAlpha'), 'Original text populated');
      assert(capturedProposal!.fullProposedText.includes('originalBeta'), 'Full proposed text preserves other functions');
    } finally {
      await testBridge.stop();
    }
  });

  await runTest('Integration 11.2: Successful callback returns truthful editor-review response', async () => {
    const port = await getFreePort();
    const testBridge = new LocalMcpBridge({
      instanceId: McpSecurity.generateInstanceId(),
      workspaceRoot,
      tools,
      preferredPort: port,
      onProposeEdit: async () => true
    });

    try {
      await testBridge.start();
      const res = await sendMcpRequest(testBridge.getUrl()!, testBridge.getAuthToken(), {
        jsonrpc: '2.0',
        id: 1102,
        method: 'tools/call',
        params: {
          name: 'propose_edit',
          arguments: {
            path: 'src/test/temp_mcp_safety.ts',
            replacementCode: 'export function newAll(): void {}',
            explanation: 'Replace all'
          }
        }
      });

      assertEqual(res.status, 200, 'HTTP 200');
      assert(!res.body.result?.isError, 'isError is false');
      const text = res.body.result?.content?.[0]?.text;
      assert(text.includes('Proposed modifications staged'), 'Reports proposed modifications staged');
      assert(text.includes('User diff review editor opened in VS Code'), 'Truthfully reports diff editor opened');
      assert(text.includes('User diff review required before changes can be applied'), 'Reports user diff review required');
    } finally {
      await testBridge.stop();
    }
  });

  await runTest('Integration 11.3: Callback returning false does not report success (isError: true)', async () => {
    const port = await getFreePort();
    const testBridge = new LocalMcpBridge({
      instanceId: McpSecurity.generateInstanceId(),
      workspaceRoot,
      tools,
      preferredPort: port,
      onProposeEdit: async () => false
    });

    try {
      await testBridge.start();
      const res = await sendMcpRequest(testBridge.getUrl()!, testBridge.getAuthToken(), {
        jsonrpc: '2.0',
        id: 1103,
        method: 'tools/call',
        params: {
          name: 'propose_edit',
          arguments: {
            path: 'src/test/temp_mcp_safety.ts',
            replacementCode: 'export function rejected(): void {}'
          }
        }
      });

      assertEqual(res.status, 200, 'HTTP 200');
      assertEqual(res.body.result?.isError, true, 'isError must be true when callback returns false');
      const text = res.body.result?.content?.[0]?.text;
      assert(text.includes('could not be staged in VS Code diff review'), 'Reports proposal could not be staged');
      assert(text.includes('already awaiting review'), 'Reports reason for rejection');
      assert(!text.includes('User diff review editor opened'), 'Must NOT claim diff editor was opened');
    } finally {
      await testBridge.stop();
    }
  });

  await runTest('Integration 11.4: Callback throwing an exception is handled safely and masks secrets', async () => {
    const port = await getFreePort();
    let secretToken = '';

    const testBridge = new LocalMcpBridge({
      instanceId: McpSecurity.generateInstanceId(),
      workspaceRoot,
      tools,
      preferredPort: port,
      onProposeEdit: async () => {
        throw new Error(`VS Code window crashed with secret Bearer ${secretToken}`);
      }
    });

    try {
      await testBridge.start();
      secretToken = testBridge.getAuthToken()!;

      const res = await sendMcpRequest(testBridge.getUrl()!, testBridge.getAuthToken(), {
        jsonrpc: '2.0',
        id: 1104,
        method: 'tools/call',
        params: {
          name: 'propose_edit',
          arguments: {
            path: 'src/test/temp_mcp_safety.ts',
            replacementCode: 'export function throwTest(): void {}'
          }
        }
      });

      assertEqual(res.status, 200, 'HTTP 200');
      assertEqual(res.body.result?.isError, true, 'isError must be true on callback exception');
      const text = res.body.result?.content?.[0]?.text;
      assert(text.includes('Failed to open proposed modifications in VS Code review editor'), 'Reports failure');
      assert(!text.includes(secretToken), 'Bearer token must NEVER be leaked in error message');
      assert(text.includes('[REDACTED_AUTH_TOKEN]'), 'Bearer token must be redacted');
    } finally {
      await testBridge.stop();
    }
  });

  await runTest('Integration 11.5: Missing callback does not falsely claim that an editor diff was opened', async () => {
    const port = await getFreePort();
    const testBridge = new LocalMcpBridge({
      instanceId: McpSecurity.generateInstanceId(),
      workspaceRoot,
      tools,
      preferredPort: port
      // No onProposeEdit passed (headless mode)
    });

    try {
      await testBridge.start();
      const res = await sendMcpRequest(testBridge.getUrl()!, testBridge.getAuthToken(), {
        jsonrpc: '2.0',
        id: 1105,
        method: 'tools/call',
        params: {
          name: 'propose_edit',
          arguments: {
            path: 'src/test/temp_mcp_safety.ts',
            replacementCode: 'export function headless(): void {}'
          }
        }
      });

      assertEqual(res.status, 200, 'HTTP 200');
      assertEqual(res.body.result?.isError, false, 'Validation succeeded in headless mode');
      const text = res.body.result?.content?.[0]?.text;
      assert(text.includes('headless mode') || text.includes('no editor review UI is connected'), 'Reports headless mode');
      assert(!text.includes('User diff review editor opened'), 'Must NOT claim diff editor was opened');
    } finally {
      await testBridge.stop();
    }
  });

  await runTest('Integration 11.6: Rejected proposals leave original disk file 100% untouched', async () => {
    const port = await getFreePort();
    const hashBefore = crypto.createHash('sha256').update(fs.readFileSync(mcpTargetFile)).digest('hex');

    const testBridge = new LocalMcpBridge({
      instanceId: McpSecurity.generateInstanceId(),
      workspaceRoot,
      tools,
      preferredPort: port,
      onProposeEdit: async () => false // Rejection
    });

    try {
      await testBridge.start();
      const res = await sendMcpRequest(testBridge.getUrl()!, testBridge.getAuthToken(), {
        jsonrpc: '2.0',
        id: 1106,
        method: 'tools/call',
        params: {
          name: 'propose_edit',
          arguments: {
            path: 'src/test/temp_mcp_safety.ts',
            replacementCode: 'COMPLETELY_CORRUPTED_CONTENT_THAT_MUST_NEVER_BE_WRITTEN'
          }
        }
      });

      assertEqual(res.body.result?.isError, true, 'isError must be true');

      const contentAfter = fs.readFileSync(mcpTargetFile, 'utf8');
      const hashAfter = crypto.createHash('sha256').update(contentAfter).digest('hex');
      assertEqual(hashAfter, hashBefore, 'Disk content must remain 100% bit-for-bit unchanged on rejection');
      assertEqual(contentAfter, mcpTargetContent, 'File content matches exact baseline');
    } finally {
      await testBridge.stop();
    }
  });

  await runTest('Integration 11.7: Existing path traversal and security guards reject before calling onProposeEdit', async () => {
    const port = await getFreePort();
    let callbackInvoked = false;

    const testBridge = new LocalMcpBridge({
      instanceId: McpSecurity.generateInstanceId(),
      workspaceRoot,
      tools,
      preferredPort: port,
      onProposeEdit: async () => {
        callbackInvoked = true;
        return true;
      }
    });

    try {
      await testBridge.start();

      // 1. Path traversal outside workspace
      const resTraversal = await sendMcpRequest(testBridge.getUrl()!, testBridge.getAuthToken(), {
        jsonrpc: '2.0',
        id: 1107,
        method: 'tools/call',
        params: {
          name: 'propose_edit',
          arguments: {
            path: '../../outside_workspace_attack.ts',
            replacementCode: 'evil()'
          }
        }
      });
      assertEqual(resTraversal.body.result?.isError, true, 'isError true on traversal');
      assertEqual(callbackInvoked, false, 'Callback must NOT be invoked on traversal');

      // 2. Database file protection
      const resDb = await sendMcpRequest(testBridge.getUrl()!, testBridge.getAuthToken(), {
        jsonrpc: '2.0',
        id: 1108,
        method: 'tools/call',
        params: {
          name: 'propose_edit',
          arguments: {
            path: 'data/trueforge.sqlite',
            replacementCode: 'evil()'
          }
        }
      });
      assertEqual(resDb.body.result?.isError, true, 'isError true on DB file');
      assertEqual(callbackInvoked, false, 'Callback must NOT be invoked on DB file');
    } finally {
      await testBridge.stop();
    }
  });

  await runTest('Integration 11.8: End-to-end integration with InlineEditManager via McpLifecycleManager', async () => {
    const port = await getFreePort();
    const testConn = new TrueForgeConnection({ baseUrl: 'http://localhost:8790' });
    const testAssembler = new ContextAssembler(discovery);
    const inlineEditManager = new InlineEditManager(testConn, testAssembler);

    // Lifecycle manager configured identically to src/extension.ts
    const manager = new McpLifecycleManager({
      workspaceRoot,
      tools,
      preferredPort: port,
      onProposeEdit: async (proposal: ProposeEditResult): Promise<boolean> => {
        return await inlineEditManager.registerAutonomousProposal(
          proposal.absolutePath,
          proposal.replacementCode,
          proposal.explanation,
          {
            startLine: proposal.startLine,
            endLine: proposal.endLine,
            fullProposedText: proposal.fullProposedText
          }
        );
      }
    });

    try {
      await manager.start();
      const bridgeUrl = manager.getBridge()!.getUrl()!;
      const token = manager.getBridge()!.getAuthToken()!;

      // Verify no proposal active initially
      assertEqual(inlineEditManager.getActivePendingEdit(), null, 'No pending edit initially');

      // Send propose_edit via MCP HTTP bridge
      const res = await sendMcpRequest(bridgeUrl, token, {
        jsonrpc: '2.0',
        id: 1110,
        method: 'tools/call',
        params: {
          name: 'propose_edit',
          arguments: {
            path: 'src/test/temp_mcp_safety.ts',
            startLine: 1,
            endLine: 3,
            replacementCode: 'export function originalAlpha(): number {\n  return 4242;\n}',
            explanation: 'Update alpha to return 4242'
          }
        }
      });

      assertEqual(res.status, 200, 'MCP response HTTP 200');
      assertEqual(res.body.result?.isError, false, 'MCP response isError is false');
      assert(
        res.body.result?.content?.[0]?.text.includes('User diff review editor opened in VS Code'),
        'Reports diff review editor opened in VS Code'
      );

      // Verify proposal staged in InlineEditManager
      const activePending = inlineEditManager.getActivePendingEdit();
      assert(activePending !== null, 'activePendingEdit must be non-null after MCP proposal');
      assertEqual(activePending!.documentUri.fsPath, path.resolve(workspaceRoot, 'src/test/temp_mcp_safety.ts'), 'Target document matches');
      assert(activePending!.replacementText.includes('4242'), 'Replacement text contains proposed code');
      assertEqual(activePending!.range.start.line, 0, 'Targeted edit start position line 0 (1-indexed line 1)');
      assert(Boolean(inlineEditManager.getReviewStatusBarItem()), 'Status bar item must be active');

      // Verify virtual diff content was registered in provider
      const virtualContent = inlineEditManager.provideTextDocumentContent(activePending!.diffUri);
      assert(virtualContent.includes('4242'), 'Virtual diff contains replacement code');
      assert(virtualContent.includes('originalBeta'), 'Virtual diff preserves unedited code');

      // Verify file on disk is still completely unmodified
      const diskContent = fs.readFileSync(mcpTargetFile, 'utf8');
      assertEqual(diskContent, mcpTargetContent, 'Disk content remains completely unmodified before user review');

      // Integration 11.9: Single-proposal guard rejects second concurrent proposal
      const resSecond = await sendMcpRequest(bridgeUrl, token, {
        jsonrpc: '2.0',
        id: 1111,
        method: 'tools/call',
        params: {
          name: 'propose_edit',
          arguments: {
            path: 'src/test/temp_mcp_safety.ts',
            replacementCode: 'second_concurrent_edit'
          }
        }
      });

      assertEqual(resSecond.status, 200, 'HTTP 200');
      assertEqual(resSecond.body.result?.isError, true, 'Second proposal must be rejected (isError true)');
      assert(
        resSecond.body.result?.content?.[0]?.text.includes('could not be staged in VS Code diff review'),
        'Rejection message returned to agent'
      );

      // Clean up staged proposal via user reject
      inlineEditManager.rejectEdit();
      assertEqual(inlineEditManager.getActivePendingEdit(), null, 'Pending edit cleared after user reject');
      assertEqual(inlineEditManager.provideTextDocumentContent(activePending!.diffUri), '', 'Virtual diff emptied after reject');
    } finally {
      await manager.dispose();
      if (fs.existsSync(mcpTargetFile)) {
        fs.unlinkSync(mcpTargetFile);
      }
    }
  });

  // ----------------------------------------------------
  // SUITE 12: MCP Authentication Lifecycle & Token Rotation Security
  // ----------------------------------------------------
  console.log('\n--- Suite 12: MCP Authentication Lifecycle & Token Rotation Security ---');

  await runTest('Lifecycle 12.1: Same URL but stale token requires forced registration', async () => {
    const port = await getFreePort();
    const testBridge = new LocalMcpBridge({
      instanceId: McpSecurity.generateInstanceId(),
      workspaceRoot,
      tools,
      preferredPort: port
    });

    try {
      await testBridge.start();
      const bridgeUrl = testBridge.getUrl()!;
      const freshToken = testBridge.getAuthToken()!;

      // TrueForge currently holds the same URL but an expired/stale token from previous Extension Host session
      const staleToken = 'deadbeef'.repeat(8);
      const mock = createMockTrueForgeConnection({
        initialServers: [
          {
            name: 'vscode-tools',
            manifest: {
              type: 'remote',
              name: 'vscode-tools',
              url: bridgeUrl, // Identical URL
              description: 'Local workspace tools',
              auth: {
                type: 'header',
                headers: { authorization: `Bearer ${staleToken}` }
              }
            },
            authStatus: { status: 'authorized' }
          }
        ]
      });

      const registrar = new McpConnectorRegistrar({
        connection: mock.connection,
        bridge: testBridge
      });

      // 1. Without forceUpdate and with verification bypassed, standard check skips update and retains stale token
      const resUnforced = await registrar.registerConnector({ forceUpdate: false, verifyTools: false });
      assertEqual(resUnforced.success, true, 'Unforced returns already_registered');
      assertEqual(resUnforced.action, 'already_registered', 'Action is already_registered');
      assertEqual(mock.calls.createOrUpdate.length, 0, 'No write was executed');
      assertEqual(
        mock.serversMap.get('vscode-tools')!.manifest.auth.headers.authorization,
        `Bearer ${staleToken}`,
        'TrueForge still retains stale token'
      );

      // 2. With forceUpdate: true, registrar bypasses the idempotency branch and synchronizes fresh credentials
      const resForced = await registrar.registerConnector({ forceUpdate: true, verifyTools: false });
      assertEqual(resForced.success, true, 'Forced registration succeeds');
      assertEqual(resForced.action, 'updated', 'Action must be updated');
      assertEqual(mock.calls.createOrUpdate.length, 1, 'createOrUpdate was executed on forceUpdate');
      assertEqual(
        mock.serversMap.get('vscode-tools')!.manifest.auth.headers.authorization,
        `Bearer ${freshToken}`,
        'TrueForge now stores fresh in-memory bearer token'
      );
    } finally {
      await testBridge.stop();
    }
  });

  await runTest('Lifecycle 12.2: Forced registration updates the Authorization header', async () => {
    const port = await getFreePort();
    const testBridge = new LocalMcpBridge({
      instanceId: McpSecurity.generateInstanceId(),
      workspaceRoot,
      tools,
      preferredPort: port
    });

    try {
      await testBridge.start();
      const freshToken = testBridge.getAuthToken()!;
      const previousToken = 'stale_previous_auth_token_99999999';

      const mock = createMockTrueForgeConnection({
        initialServers: [
          {
            name: 'vscode-tools',
            manifest: {
              type: 'remote',
              name: 'vscode-tools',
              url: testBridge.getUrl()!,
              description: 'Local workspace tools',
              auth: {
                type: 'header',
                headers: { authorization: `Bearer ${previousToken}` }
              }
            }
          }
        ]
      });

      const registrar = new McpConnectorRegistrar({
        connection: mock.connection,
        bridge: testBridge
      });

      const result = await registrar.registerConnector({ forceUpdate: true, verifyTools: false });
      assertEqual(result.success, true, 'Registration succeeds');
      assertEqual(result.action, 'updated', 'Action is updated');

      const storedAuthHeader = mock.serversMap.get('vscode-tools')!.manifest.auth.headers.authorization;
      assertEqual(storedAuthHeader, `Bearer ${freshToken}`, 'Authorization header strictly updated to fresh token');
      assert(!storedAuthHeader.includes(previousToken), 'Old stale token completely replaced');
    } finally {
      await testBridge.stop();
    }
  });

  await runTest('Lifecycle 12.3: Tool discovery succeeds after registration', async () => {
    const port = await getFreePort();
    const testBridge = new LocalMcpBridge({
      instanceId: McpSecurity.generateInstanceId(),
      workspaceRoot,
      tools,
      preferredPort: port
    });

    try {
      await testBridge.start();
      const bridgeUrl = testBridge.getUrl()!;
      const token = testBridge.getAuthToken()!;

      const mock = createMockTrueForgeConnection({
        onListTools: async (name: string) => {
          assertEqual(name, 'vscode-tools', 'List tools called for vscode-tools');
          const httpRes = await sendMcpRequest(bridgeUrl, token, {
            jsonrpc: '2.0',
            id: 200,
            method: 'tools/list',
            params: {}
          });
          assertEqual(httpRes.status, 200, 'Live bridge returns HTTP 200 to tools/list');
          return { data: httpRes.body.result.tools };
        }
      });

      const registrar = new McpConnectorRegistrar({
        connection: mock.connection,
        bridge: testBridge
      });

      const result = await registrar.registerConnector({ forceUpdate: true, verifyTools: true });
      assertEqual(result.success, true, 'Registration and discovery must succeed');
      assertEqual(result.action, 'created', 'Action is created');
      assert(Array.isArray(result.toolsDiscovered), 'toolsDiscovered must be an array');
      assertEqual(result.toolsDiscovered!.length, 5, 'Discovers all 5 tools (4 workspace tools + smoke test tool)');
      assert(result.toolsDiscovered!.includes('search_code'), 'Includes search_code');
      assert(result.toolsDiscovered!.includes('read_file'), 'Includes read_file');
      assert(result.toolsDiscovered!.includes('list_files'), 'Includes list_files');
      assert(result.toolsDiscovered!.includes('propose_edit'), 'Includes propose_edit');
      assert(result.toolsDiscovered!.includes('read_smoke_test_file'), 'Includes read_smoke_test_file');

      // Verify no token exposure in registration result message or connector status
      assert(!result.message.includes(token), 'Result message must never leak bearer token');
      assert(result.message.includes('vscode-tools'), 'Message references connector name');
    } finally {
      await testBridge.stop();
    }
  });

  await runTest('Lifecycle 12.4: Registration failure does not expose the token', async () => {
    const port = await getFreePort();
    const testBridge = new LocalMcpBridge({
      instanceId: McpSecurity.generateInstanceId(),
      workspaceRoot,
      tools,
      preferredPort: port
    });

    try {
      await testBridge.start();
      const rawToken = testBridge.getAuthToken()!;
      assertEqual(rawToken.length, 64, 'Token must be 64-char hex');

      const logs: string[] = [];
      const mock = createMockTrueForgeConnection({
        onCreateOrUpdate: () => {
          // Upstream error that explicitly echoes the bearer token
          throw new Error(`Upstream rejected Authorization: Bearer ${rawToken}`);
        }
      });

      const registrar = new McpConnectorRegistrar({
        connection: mock.connection,
        bridge: testBridge,
        onLog: (msg) => logs.push(msg)
      });

      const result = await registrar.registerConnector({ forceUpdate: true, verifyTools: true });
      assertEqual(result.success, false, 'Registration must fail on upstream error');
      assertEqual(result.action, 'failed', 'Action must be failed');

      // Result error and message must NOT contain rawToken
      assert(!result.error?.includes(rawToken), 'result.error must never contain raw bearer token');
      assert(!result.message.includes(rawToken), 'result.message must never contain raw bearer token');

      // Logs must NOT contain rawToken
      for (const logLine of logs) {
        assert(!logLine.includes(rawToken), `Log line must not contain raw token: ${logLine}`);
      }

      // Check redaction marker exists in logs or error
      const hasRedactedMarker = logs.some((l) => l.includes('[REDACTED_AUTH_TOKEN]')) || (result.error?.includes('[REDACTED_AUTH_TOKEN]') ?? false);
      assert(hasRedactedMarker, 'Bearer token must be redacted with [REDACTED_AUTH_TOKEN]');
    } finally {
      await testBridge.stop();
    }
  });

  await runTest('Lifecycle 12.5: Existing connector ownership is not accidentally deleted', async () => {
    const port = await getFreePort();
    const manager = new McpLifecycleManager({
      workspaceRoot,
      tools,
      preferredPort: port
    });

    try {
      await manager.start();
      const bridge = manager.getBridge()!;
      const githubManifest = {
        type: 'remote',
        name: 'github-mcp',
        url: 'https://mcp.github.com/api',
        description: 'GitHub MCP'
      };
      const slackManifest = {
        type: 'remote',
        name: 'slack-mcp',
        url: 'https://mcp.slack.com/api',
        description: 'Slack MCP'
      };

      const mock = createMockTrueForgeConnection({
        initialServers: [
          { name: 'github-mcp', manifest: githubManifest },
          { name: 'slack-mcp', manifest: slackManifest }
        ]
      });

      const registrar = new McpConnectorRegistrar({
        connection: mock.connection,
        lifecycleManager: manager
      });

      // 1. Forced registration of vscode-tools preserves unrelated connectors
      const regRes = await registrar.registerConnector({ forceUpdate: true, verifyTools: false });
      assertEqual(regRes.success, true, 'Registration succeeds');
      assertEqual(mock.serversMap.size, 3, 'Contains 3 servers');
      assertEqual(mock.serversMap.get('github-mcp')!.manifest, githubManifest, 'github-mcp untouched');
      assertEqual(mock.serversMap.get('slack-mcp')!.manifest, slackManifest, 'slack-mcp untouched');

      // 2. Stopping the local bridge does NOT delete vscode-tools or any connector from TrueForge
      await bridge.stop();
      assertEqual(mock.serversMap.size, 3, 'Servers remain in TrueForge after bridge stop');
      assertEqual(mock.serversMap.has('vscode-tools'), true, 'vscode-tools remains in TrueForge after bridge stop');

      // 3. Disposing the lifecycle manager does NOT unregister vscode-tools
      await manager.dispose();
      assertEqual(mock.serversMap.size, 3, 'Servers remain in TrueForge after lifecycle manager dispose');
      assertEqual(mock.serversMap.has('vscode-tools'), true, 'vscode-tools remains in TrueForge after manager dispose');

      // 4. Explicit unregisterConnector deletes ONLY vscode-tools, preserving other connectors
      const unregRes = await registrar.unregisterConnector();
      assertEqual(unregRes.success, true, 'Unregister succeeds');
      assertEqual(mock.serversMap.has('vscode-tools'), false, 'vscode-tools removed');
      assertEqual(mock.serversMap.size, 2, '2 other servers remain');
      assertEqual(mock.serversMap.get('github-mcp')!.manifest, githubManifest, 'github-mcp untouched after unregister');
      assertEqual(mock.serversMap.get('slack-mcp')!.manifest, slackManifest, 'slack-mcp untouched after unregister');
    } finally {
      await manager.dispose();
    }
  });

  // ----------------------------------------------------
  // Summary
  // ----------------------------------------------------
  console.log('\n========================================================');
  console.log('📊 MCP Test Run Summary');
  console.log('========================================================');
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);

  if (failed > 0) {
    console.error('\nFailed tests:');
    results.filter((r) => !r.passed).forEach((r) => console.error(`- ${r.name}: ${r.error}`));
    process.exit(1);
  } else {
    console.log('\n🎉 ALL MCP SERVER & SECURITY TESTS PASSED PERFECTLY!\n');
  }
}

runMcpTestSuite().catch((err) => {
  console.error('Fatal MCP test error:', err);
  process.exit(1);
});
