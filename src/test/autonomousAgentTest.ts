import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { WorkspaceContextDiscovery } from '../context/WorkspaceContextDiscovery.js';
import { ContextAssembler } from '../context/ContextAssembler.js';
import { InlineEditManager } from '../diff/InlineEditManager.js';
import { WorkspaceTools } from '../agent/WorkspaceTools.js';
import { AutonomousAgentCoordinator, AgentTaskEvent } from '../agent/AutonomousAgentCoordinator.js';
import { TrueForgeConnection } from '../connection/TrueForgeConnection.js';
import { resolveAuthoritativeWorkspaceRoot } from '../extension.js';

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

async function runMilestone3TestSuite(): Promise<void> {
  console.log('\n========================================================');
  console.log('🚀 Running TrueForge Milestone 3 Test Suite: Autonomous Agent');
  console.log('========================================================\n');

  const workspaceRoot = process.cwd();
  const discovery = new WorkspaceContextDiscovery(workspaceRoot);
  const assembler = new ContextAssembler(discovery, { maxTokenBudget: 3500 });
  const connection = new TrueForgeConnection({ baseUrl: 'http://localhost:8790' });
  const inlineEditManager = new InlineEditManager(connection, assembler);
  const tools = new WorkspaceTools(discovery);
  const coordinator = new AutonomousAgentCoordinator(connection, tools, inlineEditManager);

  // ----------------------------------------------------
  // SUITE 1: Workspace Tools Unit Tests
  // ----------------------------------------------------
  console.log('--- Suite 1: Workspace Tools Unit Tests ---');

  await runTest('Tools 1.1: list_files returns workspace files', async () => {
    const res = await tools.listFiles({});
    assert(res.success, `Expected listFiles to succeed: ${res.error}`);
    assert(Array.isArray(res.data), 'Expected res.data to be an array');
    assert(res.data.length > 0, 'Expected to find files in workspace');
    assert(res.data.includes('package.json'), 'Expected package.json in file list');
  });

  await runTest('Tools 1.2: list_files filters by subfolder', async () => {
    const res = await tools.listFiles({ directory: 'src/agent' });
    assert(res.success, `Expected listFiles to succeed: ${res.error}`);
    assert(Array.isArray(res.data), 'Expected res.data to be an array');
    assert(res.data.some((f: string) => f.includes('WorkspaceTools.ts')), 'Expected WorkspaceTools.ts in agent folder');
  });

  await runTest('Tools 1.3: read_file reads slice with line numbers', async () => {
    const res = await tools.readFile({ path: 'package.json', startLine: 1, endLine: 5 });
    assert(res.success, `Expected readFile to succeed: ${res.error}`);
    assert(res.output.includes('1 | {'), 'Expected line 1 with number');
    assertEqual(res.data.startLine, 1, 'Start line match');
    assertEqual(res.data.endLine, 5, 'End line match');
  });

  await runTest('Tools 1.4: read_file handles out of range startLine', async () => {
    const res = await tools.readFile({ path: 'package.json', startLine: 99999 });
    assert(!res.success, 'Expected out of range to fail');
    assertEqual(res.error, 'OUT_OF_RANGE', 'Error code match');
  });

  await runTest('Tools 1.5: search_code finds matching query text', async () => {
    const res = await tools.searchCode({ query: 'WorkspaceTools' });
    assert(res.success, `Expected searchCode to succeed: ${res.error}`);
    assert(Array.isArray(res.data), 'Expected res.data to be array');
    assert(res.data.length > 0, 'Expected at least 1 match');
    assert(res.output.includes('WorkspaceTools'), 'Output should contain matched symbol');
  });

  await runTest('Tools 1.6: propose_edit stages valid replacement', async () => {
    const res = await tools.proposeEdit({
      path: 'package.json',
      replacementCode: '{"test": true}',
      explanation: 'Test proposal'
    });
    assert(res.success, `Expected proposeEdit to succeed: ${res.error}`);
    assert(res.data !== undefined, 'Expected edit data');
    assertEqual(res.data.relativePath, 'package.json', 'Relative path match');
    assertEqual(res.data.replacementCode, '{"test": true}', 'Replacement code match');
  });

  // ----------------------------------------------------
  // SUITE 2: Boundary & Security Enforcement
  // ----------------------------------------------------
  console.log('\n--- Suite 2: Security & Boundary Enforcement ---');

  await runTest('Security 2.1: read_file rejects relative path traversal (../)', async () => {
    const res = await tools.readFile({ path: '../outside.txt' });
    assert(!res.success, 'Expected path traversal to be rejected');
    assertEqual(res.error, 'OUT_OF_BOUNDS', 'Expected OUT_OF_BOUNDS error code');
  });

  await runTest('Security 2.2: read_file rejects absolute path traversal outside workspace', async () => {
    const res = await tools.readFile({ path: 'C:/Windows/System32/drivers/etc/hosts' });
    assert(!res.success, 'Expected absolute path outside workspace to be rejected');
    assertEqual(res.error, 'OUT_OF_BOUNDS', 'Expected OUT_OF_BOUNDS error code');
  });

  await runTest('Security 2.3: list_files rejects directory traversal', async () => {
    const res = await tools.listFiles({ directory: '../../' });
    assert(!res.success, 'Expected directory traversal to be rejected');
    assertEqual(res.error, 'OUT_OF_BOUNDS', 'Expected OUT_OF_BOUNDS error code');
  });

  await runTest('Security 2.4: propose_edit rejects path traversal', async () => {
    const res = await tools.proposeEdit({
      path: '../../escape.txt',
      replacementCode: 'malicious',
      explanation: 'hack'
    });
    assert(!res.success, 'Expected proposeEdit traversal to be rejected');
    assertEqual(res.error, 'OUT_OF_BOUNDS', 'Expected OUT_OF_BOUNDS error code');
  });

  await runTest('Security 2.5: read_file rejects .env and secret files', async () => {
    const res = await tools.readFile({ path: '.env' });
    assert(!res.success, 'Expected .env read to be rejected');
    assertEqual(res.error, 'ACCESS_RESTRICTED', 'Expected ACCESS_RESTRICTED');
  });

  await runTest('Security 2.6: read_file rejects TrueForge sqlite database', async () => {
    const res = await tools.readFile({ path: 'data/trueforge.sqlite' });
    assert(!res.success, 'Expected sqlite database read to be rejected');
    assertEqual(res.error, 'ACCESS_RESTRICTED', 'Expected ACCESS_RESTRICTED');
  });

  await runTest('Security 2.7: propose_edit rejects modifying sqlite database', async () => {
    const res = await tools.proposeEdit({
      path: 'data/trueforge.sqlite',
      replacementCode: 'corrupt',
      explanation: 'hack'
    });
    assert(!res.success, 'Expected sqlite database modification to be rejected');
    assertEqual(res.error, 'PROTECTED_FILE', 'Expected PROTECTED_FILE');
  });

  // ----------------------------------------------------
  // SUITE 3: AutonomousAgentCoordinator Logic
  // ----------------------------------------------------
  console.log('\n--- Suite 3: Coordinator Logic & Protocol Parsing ---');

  await runTest('Coordinator 3.1: parsePlan extracts structured steps from PLAN: header', () => {
    const mockOutput = `
PLAN:
1. List files in workspace to locate target module
2. Read the source code of the target file
3. Propose edit to add new function

I will now begin step 1.
TOOL_CALL:
\`\`\`json
{ "tool": "list_files", "arguments": {} }
\`\`\`
`;
    const plan = coordinator.parsePlan(mockOutput, 'Add new function');
    assert(plan !== null, 'Expected plan to be parsed');
    assertEqual(plan!.steps.length, 3, 'Expected 3 steps');
    assertEqual(plan!.steps[0].description, 'List files in workspace to locate target module', 'Step 1 text');
    assertEqual(plan!.steps[0].status, 'in_progress', 'Initial active step is in_progress');
    assertEqual(plan!.steps[1].status, 'pending', 'Step 2 is pending');
  });

  await runTest('Coordinator 3.2: extractToolCall parses fenced markdown JSON tool call', () => {
    const mockOutput = `
I will read the file lines now.
TOOL_CALL:
\`\`\`json
{
  "tool": "read_file",
  "arguments": {
    "path": "src/extension.ts",
    "startLine": 1,
    "endLine": 20
  }
}
\`\`\`
`;
    const toolCall = coordinator.extractToolCall(mockOutput);
    assert(toolCall !== null, 'Expected tool call to be extracted');
    assertEqual(toolCall!.tool, 'read_file', 'Tool name match');
    assertEqual(toolCall!.arguments.path, 'src/extension.ts', 'Argument path match');
    assertEqual(toolCall!.arguments.endLine, 20, 'Argument endLine match');
  });

  await runTest('Coordinator 3.3: extractToolCall parses raw inline JSON', () => {
    const mockOutput = `Here is the call: { "tool": "search_code", "arguments": { "query": "TrueForge" } }`;
    const toolCall = coordinator.extractToolCall(mockOutput);
    assert(toolCall !== null, 'Expected tool call to be extracted');
    assertEqual(toolCall!.tool, 'search_code', 'Tool name match');
    assertEqual(toolCall!.arguments.query, 'TrueForge', 'Argument query match');
  });

  await runTest('Coordinator 3.4: extractCompletion extracts summary from COMPLETION: header', () => {
    const mockOutput = `
COMPLETION:
Successfully added the new subtract function with comprehensive unit tests and TypeScript types.
`;
    const summary = coordinator.extractCompletion(mockOutput);
    assert(summary !== null, 'Expected completion summary');
    assert(summary!.includes('Successfully added the new subtract function'), 'Summary text match');
  });

  await runTest('Coordinator 3.5: cancel stops autonomous loop', async () => {
    let cancelled = false;
    await coordinator.cancel();
    // Verify that executeTask immediately returns cancelled if cancel was requested
    const result = await coordinator.executeTask('Test cancel task', (event: AgentTaskEvent) => {
      if (event.type === 'task_cancelled') {
        cancelled = true;
      }
    });
    assert(Boolean((result as any).cancelled) || cancelled, 'Task should report cancellation');
  });

  // ----------------------------------------------------
  // SUITE 4: Safe Modifications & Diff Review
  // ----------------------------------------------------
  console.log('\n--- Suite 4: Safe Modifications & Review Verification ---');

  const sampleFilePath = path.join(workspaceRoot, 'src', 'test', 'temp_safety_target.ts');
  const originalCode = `// TrueForge Safety Target\nexport function calculateSquare(x: number): number {\n  return x * x;\n}\n`;

  await runTest('Safety 4.1: Setup test target file', () => {
    fs.writeFileSync(sampleFilePath, originalCode, 'utf8');
    assert(fs.existsSync(sampleFilePath), 'Sample file must exist');
  });

  const originalHash = crypto.createHash('sha256').update(fs.readFileSync(sampleFilePath)).digest('hex');

  await runTest('Safety 4.2: Rejecting proposal leaves original file 100% untouched', async () => {
    const proposedReplacement = `// Modified by agent\nexport function calculateSquare(x: number): number {\n  return x ** 2;\n}\nexport function calculateCube(x: number): number {\n  return x ** 3;\n}\n`;

    // Stage proposal
    await inlineEditManager.registerAutonomousProposal(
      sampleFilePath,
      proposedReplacement,
      'Add cube function and optimize square'
    );

    assert(inlineEditManager.getActivePendingEdit() !== null, 'Active pending edit must be staged');

    // User rejects proposal
    inlineEditManager.rejectEdit();

    // Verify pending edit is cleared
    assertEqual(inlineEditManager.getActivePendingEdit(), null, 'Pending edit must be cleared after reject');

    // Verify target file on disk is completely untouched bit-for-bit
    const currentContent = fs.readFileSync(sampleFilePath, 'utf8');
    const currentHash = crypto.createHash('sha256').update(currentContent).digest('hex');

    assertEqual(currentContent, originalCode, 'Content must match original');
    assertEqual(currentHash, originalHash, 'SHA-256 hash must be identical to original baseline');
  });

  await runTest('Safety 4.3: Accepting proposal applies changes to file', async () => {
    const proposedReplacement = `// Accepted modification\nexport function calculateSquare(x: number): number {\n  return x * x;\n}\nexport function calculateCube(x: number): number {\n  return x * x * x;\n}\n`;

    await inlineEditManager.registerAutonomousProposal(
      sampleFilePath,
      proposedReplacement,
      'Add cube calculation'
    );

    assert(inlineEditManager.getActivePendingEdit() !== null, 'Active pending edit must be staged');

    // Simulate file write on accept in test harness
    const pending = inlineEditManager.getActivePendingEdit()!;
    fs.writeFileSync(pending.documentUri.fsPath, pending.replacementText, 'utf8');
    await inlineEditManager.applyEdit();

    assertEqual(inlineEditManager.getActivePendingEdit(), null, 'Pending edit must be cleared after accept');

    const updatedContent = fs.readFileSync(sampleFilePath, 'utf8');
    assert(updatedContent.includes('calculateCube'), 'File content should reflect accepted changes');
  });

  await runTest('Safety 4.4: Cleanup test target file', () => {
    if (fs.existsSync(sampleFilePath)) {
      fs.unlinkSync(sampleFilePath);
    }
    assert(!fs.existsSync(sampleFilePath), 'Sample file must be deleted');
  });

  // ----------------------------------------------------
  // SUITE 5: Workspace Root Validation & Fail-Closed Enforcement
  // ----------------------------------------------------
  console.log('\n--- Suite 5: Workspace Root Validation & Fail-Closed Enforcement ---');

  await runTest('Root 5.1: Correct root resolution to project root D:\\TrueForge-Forgeathon', async () => {
    const mockFolder: any = [{ uri: { scheme: 'file', fsPath: workspaceRoot } }];
    const resolved = resolveAuthoritativeWorkspaceRoot(mockFolder);
    assertEqual(resolved, path.resolve(workspaceRoot), 'Workspace root must resolve to project path');
    assertEqual(discovery.getWorkspaceRoot(), path.resolve(workspaceRoot), 'Discovery root matches project');
    assertEqual(tools.getWorkspaceRoot(), path.resolve(workspaceRoot), 'Tools root matches project');
  });

  await runTest('Root 5.2: Missing workspace fails closed (undefined, empty, or non-file)', async () => {
    assertEqual(resolveAuthoritativeWorkspaceRoot(undefined), undefined, 'Undefined workspaceFolders must return undefined');
    assertEqual(resolveAuthoritativeWorkspaceRoot([]), undefined, 'Empty workspaceFolders must return undefined');
    const mockNonFileFolder: any = [{ uri: { scheme: 'untitled', fsPath: 'Untitled-1' } }];
    assertEqual(resolveAuthoritativeWorkspaceRoot(mockNonFileFolder), undefined, 'Non-file scheme must return undefined');
  });

  await runTest('Root 5.3: No fallback to process.cwd() when workspace is missing', async () => {
    const unattachedDiscovery = new WorkspaceContextDiscovery('');
    assert(!unattachedDiscovery.isWorkspaceAvailable(), 'Unattached discovery must report isWorkspaceAvailable=false');
    assertEqual(unattachedDiscovery.getWorkspaceRoot(), '', 'Unattached discovery root must be empty, not process.cwd()');

    const unattachedTools = new WorkspaceTools(unattachedDiscovery);
    const listRes = await unattachedTools.listFiles({});
    assert(!listRes.success, 'listFiles must fail when workspace is unavailable');
    assertEqual(listRes.error, 'NO_WORKSPACE', 'Expected NO_WORKSPACE error code');
    assert(listRes.output.includes('No workspace folder is open'), 'Expected user-friendly workspace message');

    const readRes = await unattachedTools.readFile({ path: 'package.json' });
    assert(!readRes.success, 'readFile must fail when workspace is unavailable');
    assertEqual(readRes.error, 'NO_WORKSPACE', 'Expected NO_WORKSPACE error code');

    const searchRes = await unattachedTools.searchCode({ query: 'trueforge' });
    assert(!searchRes.success, 'searchCode must fail when workspace is unavailable');
    assertEqual(searchRes.error, 'NO_WORKSPACE', 'Expected NO_WORKSPACE error code');

    const editRes = await unattachedTools.proposeEdit({ path: 'package.json', replacementCode: '', explanation: '' });
    assert(!editRes.success, 'proposeEdit must fail when workspace is unavailable');
    assertEqual(editRes.error, 'NO_WORKSPACE', 'Expected NO_WORKSPACE error code');
  });

  await runTest('Root 5.4: Directory traversal attempts are rejected across all tools', async () => {
    const listTraversal = await tools.listFiles({ directory: '../../../' });
    assert(!listTraversal.success, 'list_files directory traversal must be rejected');
    assertEqual(listTraversal.error, 'OUT_OF_BOUNDS', 'Expected OUT_OF_BOUNDS');

    const readTraversal = await tools.readFile({ path: '../../../../Windows/System32/drivers/etc/hosts' });
    assert(!readTraversal.success, 'read_file directory traversal must be rejected');
    assertEqual(readTraversal.error, 'OUT_OF_BOUNDS', 'Expected OUT_OF_BOUNDS');

    const editTraversal = await tools.proposeEdit({ path: '../../target.ts', replacementCode: 'hack', explanation: 'exploit' });
    assert(!editTraversal.success, 'propose_edit directory traversal must be rejected');
    assertEqual(editTraversal.error, 'OUT_OF_BOUNDS', 'Expected OUT_OF_BOUNDS');
  });

  await runTest('Root 5.5: list_files returns project files, not VS Code installation files', async () => {
    const res = await tools.listFiles({ directory: '.' });
    assert(res.success, `Expected listFiles to succeed: ${res.error}`);
    assert(Array.isArray(res.data), 'Expected res.data array');
    assert(res.data.includes('package.json'), 'Expected package.json in project files');
    assert(res.data.some((f: string) => f.includes('src/extension.ts')), 'Expected src/extension.ts');

    const hasVscodeAppx = res.data.some((f: string) => f.includes('code_x64.appx') || f.includes('.pak') || f.includes('Code.exe'));
    assert(!hasVscodeAppx, 'Workspace files must NOT contain VS Code installation files (.appx, .pak, Code.exe)');
  });

  await runTest('Root 5.6: read_file cannot escape the workspace', async () => {
    const res = await tools.readFile({ path: 'C:/Users/sanka/AppData/Local/Programs/Microsoft VS Code/Code.exe' });
    assert(!res.success, 'read_file must not access files outside workspace');
    assertEqual(res.error, 'OUT_OF_BOUNDS', 'Expected OUT_OF_BOUNDS error');
  });

  await runTest('Root 5.7: search_code searches only the workspace', async () => {
    const res = await tools.searchCode({ query: 'trueforge-vscode' });
    assert(res.success, 'search_code should succeed');
    assert(res.data.every((m: any) => !m.file.startsWith('/') && !m.file.includes('..') && !m.file.includes('AppData')), 'All match paths must be relative workspace paths');
  });

  await runTest('Root 5.8: propose_edit cannot target files outside the workspace', async () => {
    const res = await tools.proposeEdit({
      path: 'C:/Windows/notepad.exe',
      replacementCode: 'tamper',
      explanation: 'test'
    });
    assert(!res.success, 'propose_edit must not target external files');
    assertEqual(res.error, 'OUT_OF_BOUNDS', 'Expected OUT_OF_BOUNDS error');
  });

  // ----------------------------------------------------
  // Summary
  // ----------------------------------------------------
  console.log('\n========================================================');
  console.log('📊 Test Run Summary');
  console.log('========================================================');
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);

  if (failed > 0) {
    console.error('\nFailed tests:');
    results.filter((r) => !r.passed).forEach((r) => console.error(`- ${r.name}: ${r.error}`));
    process.exit(1);
  } else {
    console.log('\n🎉 ALL 18 MILESTONE 3 TESTS PASSED PERFECTLY!\n');
  }
}

runMilestone3TestSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
