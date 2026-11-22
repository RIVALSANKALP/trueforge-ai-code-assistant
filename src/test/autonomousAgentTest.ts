import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { WorkspaceContextDiscovery } from '../context/WorkspaceContextDiscovery.js';
import { ContextAssembler } from '../context/ContextAssembler.js';
import { InlineEditManager } from '../diff/InlineEditManager.js';
import { WorkspaceTools } from '../agent/WorkspaceTools.js';
import {
  AutonomousAgentCoordinator,
  AgentTaskEvent,
  DEFAULT_MAX_ITERATIONS,
  MIN_MAX_ITERATIONS,
  MAX_MAX_ITERATIONS
} from '../agent/AutonomousAgentCoordinator.js';
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

  // -----------------------------------------------------------------
  // SEC-01: Symlink, Junction & Canonical Path Traversal Security
  // -----------------------------------------------------------------
  const testSandboxRoot = path.join(workspaceRoot, '.test-sec01-sandbox');
  if (fs.existsSync(testSandboxRoot)) {
    fs.rmSync(testSandboxRoot, { recursive: true, force: true });
  }
  fs.mkdirSync(testSandboxRoot, { recursive: true });

  const outsideTempDir = path.join(os.tmpdir(), `tf-sec01-outside-${Date.now()}`);
  fs.mkdirSync(outsideTempDir, { recursive: true });
  const outsideSecretFile = path.join(outsideTempDir, 'secret_host_data.txt');
  fs.writeFileSync(outsideSecretFile, 'CONFIDENTIAL_EXTERNAL_DATA', 'utf8');

  const internalSubdir = path.join(testSandboxRoot, 'internal_sub');
  fs.mkdirSync(internalSubdir, { recursive: true });
  const internalFile = path.join(internalSubdir, 'legit_code.ts');
  fs.writeFileSync(internalFile, 'export const validCode = true;\n', 'utf8');

  const extJunction = path.join(testSandboxRoot, 'ext_dir_link');
  const intJunction = path.join(testSandboxRoot, 'int_dir_link');
  const brokenJunction = path.join(testSandboxRoot, 'broken_dir_link');

  fs.symlinkSync(outsideTempDir, extJunction, 'junction');
  fs.symlinkSync(internalSubdir, intJunction, 'junction');
  fs.symlinkSync(path.join(testSandboxRoot, 'nonexistent_target_123'), brokenJunction, 'junction');

  let fileSymlinkSupported = false;
  const extFileSymlink = path.join(testSandboxRoot, 'ext_file_symlink.txt');
  const intFileSymlink = path.join(testSandboxRoot, 'int_file_symlink.ts');
  try {
    fs.symlinkSync(outsideSecretFile, extFileSymlink, 'file');
    fs.symlinkSync(internalFile, intFileSymlink, 'file');
    fileSymlinkSupported = true;
  } catch {
    fileSymlinkSupported = false;
  }

  try {
    await runTest('Security 2.8: read_file rejects external directory symlink/junction', async () => {
      const relExtSecret = path.relative(workspaceRoot, path.join(extJunction, 'secret_host_data.txt')).replace(/\\/g, '/');
      const res = await tools.readFile({ path: relExtSecret });
      assert(!res.success, 'readFile must reject external junction traversal');
      assertEqual(res.error, 'OUT_OF_BOUNDS', 'Expected OUT_OF_BOUNDS error code');
    });

    await runTest('Security 2.9: list_files rejects external directory symlink/junction', async () => {
      const relExtDir = path.relative(workspaceRoot, extJunction).replace(/\\/g, '/');
      const res = await tools.listFiles({ directory: relExtDir });
      assert(!res.success, 'listFiles must reject external junction');
      assertEqual(res.error, 'OUT_OF_BOUNDS', 'Expected OUT_OF_BOUNDS error code');
    });

    await runTest('Security 2.10: propose_edit rejects external directory symlink/junction', async () => {
      const relExtSecret = path.relative(workspaceRoot, path.join(extJunction, 'secret_host_data.txt')).replace(/\\/g, '/');
      const res = await tools.proposeEdit({
        path: relExtSecret,
        replacementCode: 'hacked content',
        explanation: 'symlink attack'
      });
      assert(!res.success, 'proposeEdit must reject external junction');
      assertEqual(res.error, 'OUT_OF_BOUNDS', 'Expected OUT_OF_BOUNDS error code');
    });

    await runTest('Security 2.11: read_file rejects external file symlink (when supported)', async () => {
      if (!fileSymlinkSupported) {
        console.log('    ℹ️ Skipped file symlink creation (unprivileged Windows environment; verified via junction)');
        return;
      }
      const relExtFile = path.relative(workspaceRoot, extFileSymlink).replace(/\\/g, '/');
      const res = await tools.readFile({ path: relExtFile });
      assert(!res.success, 'readFile must reject external file symlink');
      assertEqual(res.error, 'OUT_OF_BOUNDS', 'Expected OUT_OF_BOUNDS error code');
    });

    await runTest('Security 2.12: read_file permits internal in-workspace symlink/junction', async () => {
      const relIntFile = path.relative(workspaceRoot, path.join(intJunction, 'legit_code.ts')).replace(/\\/g, '/');
      const res = await tools.readFile({ path: relIntFile });
      assert(res.success, `Expected readFile on internal junction to succeed: ${res.error}`);
      assert(res.output.includes('export const validCode = true;'), 'Must return internal file content');
    });

    await runTest('Security 2.13: read_file permits internal in-workspace file symlink (when supported)', async () => {
      if (!fileSymlinkSupported) {
        console.log('    ℹ️ Skipped internal file symlink (unprivileged Windows environment; verified via junction)');
        return;
      }
      const relIntFile = path.relative(workspaceRoot, intFileSymlink).replace(/\\/g, '/');
      const res = await tools.readFile({ path: relIntFile });
      assert(res.success, `Expected readFile on internal file symlink to succeed: ${res.error}`);
    });

    await runTest('Security 2.14: broken symlinks fail safely without crashing', async () => {
      const relBroken = path.relative(workspaceRoot, brokenJunction).replace(/\\/g, '/');
      const res = await tools.readFile({ path: relBroken });
      assert(!res.success, 'readFile must fail on broken symlink');

      const isWithin = discovery.isPathWithinWorkspace(brokenJunction);
      assert(!isWithin, 'Broken symlink must return false for isPathWithinWorkspace');

      const isChildWithin = discovery.isPathWithinWorkspace(path.join(brokenJunction, 'nonexistent_child.txt'));
      assert(!isChildWithin, 'Child of broken symlink must return false');
    });

    await runTest('Security 2.15: canonical workspace root fails closed on non-existent path', async () => {
      const deadDiscovery = new WorkspaceContextDiscovery(path.join(workspaceRoot, 'nonexistent_ws_root_9999'));
      assert(!deadDiscovery.isWorkspaceAvailable(), 'isWorkspaceAvailable must be false when root cannot be canonically resolved');
      assert(!deadDiscovery.isPathWithinWorkspace('any_file.ts'), 'isPathWithinWorkspace must be false when workspace is unavailable');
    });

    await runTest('Security 2.16: InlineEditManager rejects out-of-workspace proposal during registration and application', async () => {
      const inlineEditManager = new InlineEditManager(new TrueForgeConnection(), assembler);

      // Part 1: Registration security gate - out-of-workspace proposal cannot be staged
      (vscode.window as any)._lastErrorMessage = undefined;
      const regOutsideResult = await inlineEditManager.registerAutonomousProposal(outsideSecretFile, 'hacked', 'test');
      assert(!regOutsideResult, 'Registration must return false for out-of-workspace file');
      assert(inlineEditManager.getActivePendingEdit() === null, 'InlineEditManager must not stage proposal outside workspace');
      assert(
        (vscode.window as any)._lastErrorMessage?.includes('outside the active workspace boundary'),
        'Registration-time security error message produced'
      );

      // Part 2: Application security gate - active proposal targeting external file is rejected at apply-time
      // 1. Register a genuine proposal targeting an existing in-workspace test file
      const regInternalResult = await inlineEditManager.registerAutonomousProposal(
        internalFile,
        'export const validCode = false;\n',
        'Valid inside-workspace proposal'
      );
      assert(regInternalResult === true, 'In-workspace proposal registered successfully');

      // 2. Retrieve the actual active proposal and assert that it exists
      const activeProposal = inlineEditManager.getActivePendingEdit();
      assert(activeProposal !== null, 'Active proposal must be staged and non-null');
      assert(inlineEditManager.getReviewStatusBarItem() !== undefined, 'Review status bar active');

      // Helper to check last setContext command
      const getLastContextValue = () => {
        const cmds = (vscode.commands as any)._executedCommands || [];
        for (let i = cmds.length - 1; i >= 0; i--) {
          if (cmds[i].cmd === 'setContext' && cmds[i].args[0] === 'trueforge.hasPendingEdit') {
            return cmds[i].args[1];
          }
        }
        return undefined;
      };
      assert(getLastContextValue() === true, 'trueforge.hasPendingEdit context is true');

      // 3. Mutate active proposal's documentUri to point to external secret file, preserving object identity
      const externalSecretBaseline = fs.readFileSync(outsideSecretFile, 'utf8');
      (activeProposal as any).documentUri = vscode.Uri.file(outsideSecretFile);

      // 4. Call applyEdit(activeProposal)
      (vscode.window as any)._lastWarningMessage = undefined;
      (vscode.window as any)._lastErrorMessage = undefined;

      const applied = await inlineEditManager.applyEdit(activeProposal);

      // 5. Assertions:
      // - The operation returns false
      assert(applied === false, 'applyEdit must return false for out-of-workspace target');

      // - The stale-proposal guard did not reject it
      assert(
        !(vscode.window as any)._lastWarningMessage?.includes('Cannot apply stale proposal'),
        'Stale-proposal guard did not reject the active proposal'
      );

      // - The apply-time workspace boundary error was produced
      assert(
        (vscode.window as any)._lastErrorMessage?.includes('outside the active workspace boundary'),
        'Apply-time workspace boundary error was produced'
      );

      // - The external file remains byte-for-byte unchanged
      const externalSecretCurrent = fs.readFileSync(outsideSecretFile, 'utf8');
      assertEqual(externalSecretCurrent, externalSecretBaseline, 'External secret file remains byte-for-byte unchanged');

      // - The active proposal is safely cleaned up
      assert(inlineEditManager.getActivePendingEdit() === null, 'Active proposal is cleaned up after security rejection');

      // - The status bar and trueforge.hasPendingEdit context are reset
      assert(inlineEditManager.getReviewStatusBarItem() === undefined, 'Review status bar item was disposed');
      assert(getLastContextValue() === false, 'Context key trueforge.hasPendingEdit reset to false');
    });

    await runTest('Security 2.17: normal workspace file operations continue to succeed', async () => {
      const normRes = await tools.readFile({ path: 'package.json', startLine: 1, endLine: 3 });
      assert(normRes.success, 'Normal readFile on package.json must succeed');

      const listRes = await tools.listFiles({ directory: 'src' });
      assert(listRes.success, 'Normal listFiles on src directory must succeed');
    });
  } finally {
    try {
      fs.rmSync(testSandboxRoot, { recursive: true, force: true });
    } catch { }
    try {
      fs.rmSync(outsideTempDir, { recursive: true, force: true });
    } catch { }
  }

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
  // SUITE 6: Targeted Autonomous Edits & Diff Scoping (Flask helpers.py Regression)
  // ----------------------------------------------------
  console.log('\n--- Suite 6: Targeted Autonomous Edits & Diff Scoping ---');

  const multiFunctionFilePath = path.join(workspaceRoot, 'src', 'test', 'temp_targeted_multi_func.ts');
  const multiFunctionCode = [
    '// Header comment',
    'import * as path from "path";',
    'import * as fs from "fs";',
    '',
    'export function helperAlpha(val: number): number {',
    '  return val + 1;',
    '}',
    '',
    'export function targetFunction(name: string): string {',
    '  const prefix = "Hello";',
    '  return `${prefix}, ${name}!`;',
    '}',
    '',
    'export function helperBeta(text: string): boolean {',
    '  return text.length > 0;',
    '}',
    '',
    'export function helperGamma(): void {',
    '  console.log("Gamma executed");',
    '}'
  ].join('\n') + '\n';

  await runTest('Targeted 6.1: Setup multi-function test file', () => {
    fs.writeFileSync(multiFunctionFilePath, multiFunctionCode, 'utf8');
    assert(fs.existsSync(multiFunctionFilePath), 'Multi-function sample file must exist');
  });

  await runTest('Targeted 6.2: Rejects partial range (only startLine provided)', async () => {
    const res = await tools.proposeEdit({
      path: 'src/test/temp_targeted_multi_func.ts',
      replacementCode: 'tamper',
      explanation: 'partial range',
      startLine: 9
    });
    assert(!res.success, 'Partial range with only startLine must be rejected');
    assertEqual(res.error, 'INVALID_RANGE', 'Expected INVALID_RANGE error');
  });

  await runTest('Targeted 6.3: Rejects partial range (only endLine provided)', async () => {
    const res = await tools.proposeEdit({
      path: 'src/test/temp_targeted_multi_func.ts',
      replacementCode: 'tamper',
      explanation: 'partial range',
      endLine: 12
    });
    assert(!res.success, 'Partial range with only endLine must be rejected');
    assertEqual(res.error, 'INVALID_RANGE', 'Expected INVALID_RANGE error');
  });

  await runTest('Targeted 6.4: Rejects non-integer range values', async () => {
    const res = await tools.proposeEdit({
      path: 'src/test/temp_targeted_multi_func.ts',
      replacementCode: 'tamper',
      explanation: 'float range',
      startLine: 9.5,
      endLine: 12
    });
    assert(!res.success, 'Non-integer startLine must be rejected');
    assertEqual(res.error, 'INVALID_RANGE', 'Expected INVALID_RANGE error');
  });

  await runTest('Targeted 6.5: Rejects startLine < 1', async () => {
    const res = await tools.proposeEdit({
      path: 'src/test/temp_targeted_multi_func.ts',
      replacementCode: 'tamper',
      explanation: 'zero line',
      startLine: 0,
      endLine: 12
    });
    assert(!res.success, 'startLine < 1 must be rejected');
    assertEqual(res.error, 'INVALID_RANGE', 'Expected INVALID_RANGE error');
  });

  await runTest('Targeted 6.6: Rejects reversed range (startLine > endLine)', async () => {
    const res = await tools.proposeEdit({
      path: 'src/test/temp_targeted_multi_func.ts',
      replacementCode: 'tamper',
      explanation: 'reversed range',
      startLine: 15,
      endLine: 10
    });
    assert(!res.success, 'startLine > endLine must be rejected');
    assertEqual(res.error, 'INVALID_RANGE', 'Expected INVALID_RANGE error');
  });

  await runTest('Targeted 6.7: Rejects out-of-bounds range (endLine > file length)', async () => {
    const res = await tools.proposeEdit({
      path: 'src/test/temp_targeted_multi_func.ts',
      replacementCode: 'tamper',
      explanation: 'out of bounds range',
      startLine: 5,
      endLine: 9999
    });
    assert(!res.success, 'endLine exceeding line count must be rejected');
    assertEqual(res.error, 'INVALID_RANGE', 'Expected INVALID_RANGE error');
  });

  await runTest('Targeted 6.8: Existing full-file proposal without range still functions', async () => {
    const res = await tools.proposeEdit({
      path: 'src/test/temp_targeted_multi_func.ts',
      replacementCode: '// Entire file replaced',
      explanation: 'full file test'
    });
    assert(res.success, 'Full file proposeEdit must succeed');
    assert(res.data.startLine === undefined, 'startLine must be undefined for full-file');
    assert(res.data.endLine === undefined, 'endLine must be undefined for full-file');
    assertEqual(res.data.fullProposedText, '// Entire file replaced', 'fullProposedText equals replacementCode');
  });

  const replacementTargetFunction = [
    'export function targetFunction(name: string): string {',
    '  const greeting = "Greetings";',
    '  return `${greeting}, ${name}! (improved)`;',
    '}'
  ].join('\n');

  let stagedResult: any = null;

  await runTest('Targeted 6.9: Targeted proposal preserves lines before and after exactly', async () => {
    const res = await tools.proposeEdit({
      path: 'src/test/temp_targeted_multi_func.ts',
      replacementCode: replacementTargetFunction,
      explanation: 'Refactor targetFunction',
      startLine: 9,
      endLine: 12
    });
    assert(res.success, 'Targeted proposeEdit must succeed');
    stagedResult = res.data;

    const originalLines = multiFunctionCode.split('\n');
    const proposedLines = stagedResult.fullProposedText.split('\n');

    // Lines 1-8 before target must be identical
    for (let i = 0; i < 8; i++) {
      assertEqual(proposedLines[i], originalLines[i], `Line ${i + 1} before target must be unchanged`);
    }

    // Suffix after target must be identical
    const originalSuffix = originalLines.slice(12).join('\n');
    const proposedSuffix = proposedLines.slice(12).join('\n');
    assertEqual(proposedSuffix, originalSuffix, 'Suffix lines after target must be bit-for-bit identical');

    assert(stagedResult.fullProposedText.includes('Greetings'), 'Proposed file must include replacement content');
    assert(stagedResult.fullProposedText.includes('helperAlpha'), 'Proposed file must retain helperAlpha');
    assert(stagedResult.fullProposedText.includes('helperBeta'), 'Proposed file must retain helperBeta');
    assert(stagedResult.fullProposedText.includes('helperGamma'), 'Proposed file must retain helperGamma');
  });

  await runTest('Targeted 6.10: Virtual diff document contains the complete proposed file', async () => {
    await inlineEditManager.registerAutonomousProposal(
      multiFunctionFilePath,
      stagedResult.replacementCode,
      stagedResult.explanation,
      {
        startLine: stagedResult.startLine,
        endLine: stagedResult.endLine,
        fullProposedText: stagedResult.fullProposedText
      }
    );

    const pending = inlineEditManager.getActivePendingEdit();
    assert(pending !== null, 'Active pending edit must be staged');

    const diffContent = inlineEditManager.provideTextDocumentContent(pending!.diffUri);
    assertEqual(diffContent, stagedResult.fullProposedText, 'Diff content must match fullProposedText');
    assert(diffContent.includes('import * as path'), 'Diff view must include imports (not shown as deleted)');
    assert(diffContent.includes('helperAlpha'), 'Diff view must include helperAlpha');
    assert(diffContent.includes('helperGamma'), 'Diff view must include helperGamma');
  });

  const multiHashBefore = crypto.createHash('sha256').update(fs.readFileSync(multiFunctionFilePath)).digest('hex');

  await runTest('Targeted 6.11: Rejecting targeted proposal leaves original file 100% untouched', async () => {
    inlineEditManager.rejectEdit();
    assertEqual(inlineEditManager.getActivePendingEdit(), null, 'Pending edit must be cleared after reject');

    const contentAfterReject = fs.readFileSync(multiFunctionFilePath, 'utf8');
    const hashAfterReject = crypto.createHash('sha256').update(contentAfterReject).digest('hex');
    assertEqual(contentAfterReject, multiFunctionCode, 'File content must match original baseline');
    assertEqual(hashAfterReject, multiHashBefore, 'File SHA-256 hash must be identical after reject');
  });

  await runTest('Targeted 6.12: Accepting targeted proposal modifies only the targeted function', async () => {
    await inlineEditManager.registerAutonomousProposal(
      multiFunctionFilePath,
      stagedResult.replacementCode,
      stagedResult.explanation,
      {
        startLine: stagedResult.startLine,
        endLine: stagedResult.endLine,
        fullProposedText: stagedResult.fullProposedText
      }
    );

    const acceptSuccess = await inlineEditManager.applyEdit();
    assert(acceptSuccess, 'applyEdit must report success');
    assertEqual(inlineEditManager.getActivePendingEdit(), null, 'Pending edit must be cleared after accept');

    const updatedContent = fs.readFileSync(multiFunctionFilePath, 'utf8');
    const updatedLines = updatedContent.split('\n');
    const originalLines = multiFunctionCode.split('\n');

    for (let i = 0; i < 8; i++) {
      assertEqual(updatedLines[i], originalLines[i], `Line ${i + 1} before target must be unchanged on disk`);
    }

    assert(updatedContent.includes('Greetings'), 'Target function must contain replacement code');
    assert(updatedContent.includes('(improved)'), 'Target function must contain replacement details');

    const originalSuffix = originalLines.slice(12).join('\n');
    const updatedSuffix = updatedLines.slice(12).join('\n');
    assertEqual(updatedSuffix, originalSuffix, 'Suffix lines after target must remain untouched on disk');
    assert(updatedContent.includes('helperAlpha'), 'File must retain helperAlpha');
    assert(updatedContent.includes('helperBeta'), 'File must retain helperBeta');
    assert(updatedContent.includes('helperGamma'), 'File must retain helperGamma');
  });

  // ----------------------------------------------------
  // Flask helpers.py Realistic Regression Test
  // ----------------------------------------------------
  const flaskHelpersPath = path.join(workspaceRoot, 'src', 'test', 'temp_flask_helpers_simulation.py');
  const flaskHelpersCode = [
    '# Flask helpers simulation',
    'import os',
    'import sys',
    'import typing as t',
    '',
    '# Docstring line 1',
    '# Docstring line 2',
    '# Docstring line 3',
    '',
    'def get_debug_flag() -> bool:',
    '    """Get whether debug mode should be enabled."""',
    '    val = os.environ.get("FLASK_DEBUG")',
    '    if not val:',
    '        return False',
    '    return val.lower() in ("1", "t", "true", "on", "yes")',
    '',
    'def find_package(import_name: str):',
    '    """Finds package location."""',
    '    return path.dirname(import_name)',
    '',
    'def get_load_dotenv(default: bool = True) -> bool:',
    '    """Check whether dotenv should be loaded."""',
    '    val = os.environ.get("FLASK_SKIP_DOTENV")',
    '    if not val:',
    '        return default',
    '    return val.lower() in ("0", "f", "false", "off", "no")',
    ''
  ].join('\n');

  await runTest('Targeted 6.13: Flask helpers.py regression — replace get_debug_flag without touching find_package', async () => {
    fs.writeFileSync(flaskHelpersPath, flaskHelpersCode, 'utf8');

    const newDebugFlag = [
      'def get_debug_flag() -> bool:',
      '    """Get whether debug mode should be enabled (updated for False check)."""',
      '    val = os.environ.get("FLASK_DEBUG")',
      '    if val is not None:',
      '        return val.lower() in ("1", "t", "true", "on", "yes")',
      '    return False'
    ].join('\n');

    const editRes = await tools.proposeEdit({
      path: 'src/test/temp_flask_helpers_simulation.py',
      replacementCode: newDebugFlag,
      explanation: 'Fix get_debug_flag default behavior',
      startLine: 10,
      endLine: 15
    });

    assert(editRes.success, 'Flask proposeEdit must succeed');
    const proposed = editRes.data;

    assertEqual(proposed.fullProposedText.includes('import os'), true, 'Diff must preserve import os');
    assertEqual(proposed.fullProposedText.includes('import typing as t'), true, 'Diff must preserve import typing');
    assertEqual(proposed.fullProposedText.includes('def find_package'), true, 'Diff must NOT delete find_package');
    assertEqual(proposed.fullProposedText.includes('def get_load_dotenv'), true, 'Diff must NOT delete get_load_dotenv');
    assertEqual(proposed.fullProposedText.includes('if val is not None:'), true, 'Diff must contain new logic');

    await inlineEditManager.registerAutonomousProposal(
      flaskHelpersPath,
      proposed.replacementCode,
      proposed.explanation,
      {
        startLine: proposed.startLine,
        endLine: proposed.endLine,
        fullProposedText: proposed.fullProposedText
      }
    );

    const applyOk = await inlineEditManager.applyEdit();
    assert(applyOk, 'applyEdit must succeed on Flask helpers');

    const finalDiskContent = fs.readFileSync(flaskHelpersPath, 'utf8');
    assert(finalDiskContent.includes('import typing as t'), 'Imports must remain on disk');
    assert(finalDiskContent.includes('def find_package'), 'find_package must remain on disk');
    assert(finalDiskContent.includes('def get_load_dotenv'), 'get_load_dotenv must remain on disk');
    assert(finalDiskContent.includes('if val is not None:'), 'get_debug_flag update must be on disk');
  });

  await runTest('Targeted 6.14: Cleanup temporary test files', () => {
    if (fs.existsSync(multiFunctionFilePath)) fs.unlinkSync(multiFunctionFilePath);
    if (fs.existsSync(flaskHelpersPath)) fs.unlinkSync(flaskHelpersPath);
  });

  // ----------------------------------------------------
  // SUITE 7: Live Execution Resilience & Multi-Turn Execution
  // ----------------------------------------------------
  console.log('\n--- Suite 7: Live Execution Resilience & Multi-Turn Execution ---');

  // 7.1: Flask repo search finds get_debug_flag at src/flask/helpers.py:28
  const flaskEvaluationRoot = 'D:\\Forgeathon-Evaluation\\flask';
  const hasFlaskEvaluation = fs.existsSync(flaskEvaluationRoot);

  if (hasFlaskEvaluation) {
    const flaskDiscovery = new WorkspaceContextDiscovery(flaskEvaluationRoot);
    const flaskTools = new WorkspaceTools(flaskDiscovery);

    await runTest('Resilience 7.1: Flask repo search finds get_debug_flag at src/flask/helpers.py:28', async () => {
      const res = await flaskTools.searchCode({ query: 'def get_debug_flag()' });
      assert(res.success, `searchCode in Flask repo must succeed: ${res.output}`);
      assert(Array.isArray(res.data) && res.data.length > 0, 'Expected at least 1 match for get_debug_flag');

      const match = res.data.find((m: any) => m.file === 'src/flask/helpers.py');
      assert(match !== undefined, 'Match must be in src/flask/helpers.py');
      assertEqual(match.line, 28, 'Function definition must be on line 28 of helpers.py');
      assert(match.text.includes('def get_debug_flag()'), 'Matched line text must contain definition signature');
    });

    await runTest('Resilience 7.2: Flask repo search fallback finds symbol get_debug_flag()', async () => {
      const res = await flaskTools.searchCode({ query: 'get_debug_flag()' });
      assert(res.success, 'searchCode fallback must succeed');
      const match = res.data.find((m: any) => m.file === 'src/flask/helpers.py' && m.line === 28);
      assert(match !== undefined, 'Fallback symbol search must find helpers.py line 28');
    });
  }

  // 7.3: Multi-turn autonomous sequence: list_files -> read_file -> search_code -> propose_edit
  const multiTurnFilePath = path.join(workspaceRoot, 'src', 'test', 'temp_multiturn_target.ts');
  const multiTurnCode = [
    '// Multi-turn target file',
    'export function fnAlpha(): string {',
    '  return "alpha";',
    '}',
    '',
    'export function fnBeta(): number {',
    '  return 42;',
    '}',
    '',
    'export function fnGamma(): boolean {',
    '  return true;',
    '}',
    '',
    'export function fnDelta(): void {',
    '  console.log("delta");',
    '}',
    ''
  ].join('\n');

  await runTest('Resilience 7.3: Setup multi-turn test target file', () => {
    fs.writeFileSync(multiTurnFilePath, multiTurnCode, 'utf8');
    assert(fs.existsSync(multiTurnFilePath), 'Multi-turn target file must exist');
  });

  const multiTurnOriginalHash = crypto.createHash('sha256').update(fs.readFileSync(multiTurnFilePath)).digest('hex');

  await runTest('Resilience 7.4: Multi-turn autonomous execution (list_files -> read_file -> search_code -> propose_edit)', async () => {
    const mockConnection = new TrueForgeConnection();
    let turnCount = 0;

    // Mock createSession
    (mockConnection.getClient().sessions as any).create = async () => ({
      data: { id: 'mock_session_multiturn' }
    });

    // Mock deleteSession
    let sessionDeleted = false;
    (mockConnection.getClient().sessions as any).delete = async () => {
      sessionDeleted = true;
    };

    // Mock createTurnStream to execute 4 distinct sequential steps
    (mockConnection.getClient().sessions as any).createTurnStream = async function* () {
      turnCount++;
      if (turnCount === 1) {
        // Step 1: PLAN and list_files
        yield {
          type: 'model.message.delta',
          id: 'delta_1',
          content: 'PLAN:\n1. List files\n2. Read target\n3. Search symbol\n4. Propose edit\nTOOL_CALL:\n```json\n{ "tool": "list_files", "arguments": { "directory": "src/test" } }\n```'
        };
      } else if (turnCount === 2) {
        // Step 2: read_file
        yield {
          type: 'model.message.delta',
          id: 'delta_2',
          content: 'TOOL_CALL:\n```json\n{ "tool": "read_file", "arguments": { "path": "src/test/temp_multiturn_target.ts", "startLine": 1, "endLine": 10 } }\n```'
        };
      } else if (turnCount === 3) {
        // Step 3: search_code
        yield {
          type: 'model.message.delta',
          id: 'delta_3',
          content: 'TOOL_CALL:\n```json\n{ "tool": "search_code", "arguments": { "query": "fnBeta" } }\n```'
        };
      } else if (turnCount === 4) {
        // Step 4: propose_edit for lines 6-8 (fnBeta)
        yield {
          type: 'model.message.delta',
          id: 'delta_4',
          content: 'TOOL_CALL:\n```json\n{ "tool": "propose_edit", "arguments": { "path": "src/test/temp_multiturn_target.ts", "replacementCode": "export function fnBeta(): number {\\n  return 999;\\n}", "startLine": 6, "endLine": 8, "explanation": "Optimize fnBeta" } }\n```'
        };
      }
      yield {
        type: 'turn.update',
        id: `update_${turnCount}`,
        state: { status: 'paused' }
      };
    };

    const multiTurnCoordinator = new AutonomousAgentCoordinator(mockConnection, tools, inlineEditManager, 6);
    const result = await multiTurnCoordinator.executeTask('Refactor fnBeta in temp_multiturn_target.ts');

    assert(result.success, `Coordinator multi-turn sequence must succeed: ${result.summary}`);
    assert(sessionDeleted, 'Completed session must be safely cleaned up');
    assertEqual(turnCount, 4, 'Coordinator must execute exactly 4 sequential turns');
    assert(result.proposedEdit !== undefined, 'Coordinator must produce proposedEdit');
    assertEqual(result.proposedEdit?.startLine, 6, 'Proposed edit startLine must be 6');
    assertEqual(result.proposedEdit?.endLine, 8, 'Proposed edit endLine must be 8');

    // Verify rejection: SHA-256 hash proves file is 100% untouched
    inlineEditManager.rejectEdit();
    assertEqual(inlineEditManager.getActivePendingEdit(), null, 'Pending edit cleared after rejection');
    const diskContentAfterReject = fs.readFileSync(multiTurnFilePath, 'utf8');
    const hashAfterReject = crypto.createHash('sha256').update(diskContentAfterReject).digest('hex');
    assertEqual(diskContentAfterReject, multiTurnCode, 'File content must be identical to original baseline');
    assertEqual(hashAfterReject, multiTurnOriginalHash, 'File SHA-256 hash must be identical after reject');

    // Re-stage proposal and verify acceptance: modifies ONLY fnBeta
    await inlineEditManager.registerAutonomousProposal(
      result.proposedEdit!.absolutePath,
      result.proposedEdit!.replacementCode,
      result.proposedEdit!.explanation,
      {
        startLine: result.proposedEdit!.startLine,
        endLine: result.proposedEdit!.endLine,
        fullProposedText: result.proposedEdit!.fullProposedText
      }
    );

    const acceptOk = await inlineEditManager.applyEdit();
    assert(acceptOk, 'applyEdit must succeed on multi-turn target');

    const updatedDiskContent = fs.readFileSync(multiTurnFilePath, 'utf8');
    assert(updatedDiskContent.includes('return 999;'), 'fnBeta must contain updated return 999');
    assert(updatedDiskContent.includes('export function fnAlpha'), 'fnAlpha must remain untouched');
    assert(updatedDiskContent.includes('export function fnGamma'), 'fnGamma must remain untouched');
    assert(updatedDiskContent.includes('export function fnDelta'), 'fnDelta must remain untouched');

    // Verify lines before target (lines 1-5) and after target (lines 9+) are identical
    const originalLines = multiTurnCode.split('\n');
    const updatedLines = updatedDiskContent.split('\n');
    for (let i = 0; i < 5; i++) {
      assertEqual(updatedLines[i], originalLines[i], `Line ${i + 1} before fnBeta must be unchanged`);
    }
    const suffixOriginal = originalLines.slice(8).join('\n');
    const suffixUpdated = updatedLines.slice(8).join('\n');
    assertEqual(suffixUpdated, suffixOriginal, 'Lines after fnBeta must remain bit-for-bit identical');
  });

  await runTest('Resilience 7.5: Native tool-call event handling in coordinator loop', async () => {
    const mockNativeConnection = new TrueForgeConnection();
    (mockNativeConnection.getClient().sessions as any).create = async () => ({
      data: { id: 'mock_session_native_coord' }
    });
    (mockNativeConnection.getClient().sessions as any).delete = async () => { };

    let step = 0;
    (mockNativeConnection.getClient().sessions as any).createTurnStream = async function* () {
      step++;
      if (step === 1) {
        // Native tool call event
        yield {
          type: 'model.message',
          id: 'msg_native_1',
          threadId: 'main',
          content: null,
          toolCalls: [
            {
              id: 'call_native_1',
              type: 'function',
              function: {
                name: 'search_code',
                arguments: JSON.stringify({ query: 'fnDelta' })
              }
            }
          ]
        };
        yield {
          type: 'tool.response_required',
          id: 'evt_resp_req_1',
          toolCalls: [{ id: 'call_native_1', sourceEventId: 'msg_native_1' }]
        };
        yield {
          type: 'turn.update',
          id: 'evt_update_1',
          state: { status: 'paused' }
        };
      } else {
        // Completion
        yield {
          type: 'model.message.delta',
          id: 'delta_comp',
          content: 'COMPLETION:\nFound fnDelta and finished analysis.'
        };
        yield {
          type: 'turn.done',
          id: 'done_1',
          state: { status: 'done' }
        };
      }
    };

    const nativeCoord = new AutonomousAgentCoordinator(mockNativeConnection, tools, inlineEditManager, 4);
    const nativeRes = await nativeCoord.executeTask('Inspect fnDelta');
    assert(nativeRes.success, 'Coordinator must handle native tool call and complete');
    assertEqual(step, 2, 'Coordinator must execute 2 steps (native tool call + completion)');
    assert(nativeRes.summary.includes('Found fnDelta'), 'Summary must contain completion message');
  });

  await runTest('Resilience 7.6: Genuine user-input pause preserves session without premature deletion', async () => {
    const mockPauseConnection = new TrueForgeConnection();
    (mockPauseConnection.getClient().sessions as any).create = async () => ({
      data: { id: 'mock_session_user_pause' }
    });

    let sessionDeleted = false;
    (mockPauseConnection.getClient().sessions as any).delete = async () => {
      sessionDeleted = true;
    };

    (mockPauseConnection.getClient().sessions as any).createTurnStream = async function* () {
      yield {
        type: 'turn.update',
        id: 'evt_user_pause_1',
        state: { status: 'paused' }
      };
    };

    const pauseCoord = new AutonomousAgentCoordinator(mockPauseConnection, tools, inlineEditManager, 3);
    const pauseRes = await pauseCoord.executeTask('Ask user confirmation');

    assert(!pauseRes.success, 'Pause task must return non-success');
    assert(Boolean(pauseRes.pausedForInput), 'Task must be flagged as pausedForInput');
    assert(!sessionDeleted, 'Session must NOT be deleted during resumable user-input pause');
    assertEqual(pauseCoord.getCurrentSessionId(), 'mock_session_user_pause', 'Session ID must be preserved for resume');
  });

  await runTest('Resilience 7.7: Cleanup multi-turn test target file', () => {
    if (fs.existsSync(multiTurnFilePath)) fs.unlinkSync(multiTurnFilePath);
  });

  // ----------------------------------------------------
  // SUITE 8: TrueForge Native Tool Calling Lifecycle (Milestone 3 Integration)
  // ----------------------------------------------------
  console.log('\n--- Suite 8: TrueForge Native Tool Calling Lifecycle ---');

  const nativeTestFilePath = path.join(workspaceRoot, 'src', 'test', 'temp_native_target.ts');
  const nativeOriginalCode = [
    'export function computeAlpha(): number {',
    '  return 10;',
    '}',
    '',
    'export function computeBeta(): number {',
    '  return 20;',
    '}',
    '',
    'export function computeGamma(): number {',
    '  return 30;',
    '}'
  ].join('\n');

  await runTest('Native 8.1: Setup native test target file', () => {
    fs.writeFileSync(nativeTestFilePath, nativeOriginalCode, 'utf8');
    assert(fs.existsSync(nativeTestFilePath), 'Target file must exist');
  });

  await runTest('Native 8.2: End-to-end native tool calling with propose_edit', async () => {
    const mockNativeConn = new TrueForgeConnection();
    (mockNativeConn.getClient().sessions as any).create = async () => ({
      data: { id: 'session_native_e2e_1' }
    });
    let deletedSessionId: string | null = null;
    (mockNativeConn.getClient().sessions as any).delete = async (id: string) => {
      deletedSessionId = id;
    };

    let submittedEventsPayload: any = null;
    let subscribedCursor: string | null = null;

    (mockNativeConn.getClient().sessions as any).createTurnStream = async function* () {
      yield {
        type: 'turn.created',
        id: 'evt_tc_native_e2e',
        turnId: 'turn_native_e2e_100'
      };
      yield {
        type: 'model.message',
        id: 'msg_native_e2e_1',
        threadId: 'main',
        toolCalls: [
          {
            id: 'call_native_pe_1',
            type: 'function',
            function: {
              name: 'propose_edit',
              arguments: JSON.stringify({
                path: 'src/test/temp_native_target.ts',
                startLine: 5,
                endLine: 7,
                replacementCode: 'export function computeBeta(): number {\n  return 200;\n}',
                explanation: 'Update computeBeta return value to 200'
              })
            }
          }
        ]
      };
      yield {
        type: 'tool.response_required',
        id: 'evt_tr_req_native_1',
        threadId: 'main',
        toolCalls: [
          { id: 'call_native_pe_1', sourceEventId: 'msg_native_e2e_1' }
        ]
      };
    };

    (mockNativeConn.getClient().sessions as any).createTurnEvents = async (
      sessionId: string,
      turnId: string,
      request: any
    ) => {
      submittedEventsPayload = { sessionId, turnId, request };
      return { success: true };
    };

    (mockNativeConn.getClient().sessions as any).subscribeToTurn = async function* (
      _sessionId: string,
      _turnId: string,
      req: any
    ) {
      subscribedCursor = req?.afterEventId ?? null;
      yield {
        type: 'model.message.delta',
        id: 'delta_native_e2e_done',
        content: 'COMPLETION:\nSuccessfully proposed targeted modification for computeBeta.'
      };
      yield {
        type: 'turn.done',
        id: 'done_native_e2e',
        state: { status: 'done' }
      };
    };

    const nativeCoordinator = new AutonomousAgentCoordinator(mockNativeConn, tools, inlineEditManager, 4);
    const nativeResult = await nativeCoordinator.executeTask('Update computeBeta to return 200');

    assert(nativeResult.success, 'Task must succeed');
    assert(nativeResult.proposedEdit !== undefined, 'proposedEdit must be populated');
    assertEqual(nativeResult.proposedEdit!.startLine, 5, 'Start line must be 5');
    assertEqual(nativeResult.proposedEdit!.endLine, 7, 'End line must be 7');
    assert(nativeResult.proposedEdit!.fullProposedText.includes('return 200;'), 'Proposed text must contain 200');
    assert(nativeResult.proposedEdit!.fullProposedText.includes('computeAlpha'), 'Proposed text preserves computeAlpha');
    assert(nativeResult.proposedEdit!.fullProposedText.includes('computeGamma'), 'Proposed text preserves computeGamma');

    // Verify turn events submission
    assert(submittedEventsPayload !== null, 'createTurnEvents must have been called');
    assertEqual(submittedEventsPayload.turnId, 'turn_native_e2e_100', 'Turn ID must match turn.created');
    assertEqual(submittedEventsPayload.request.events.length, 1, 'Exactly 1 event submitted');
    assertEqual(submittedEventsPayload.request.events[0].type, 'user.tool_response', 'Event type user.tool_response');
    assertEqual(submittedEventsPayload.request.events[0].toolCallId, 'call_native_pe_1', 'Tool call ID matches');
    assert(submittedEventsPayload.request.events[0].content.includes('Proposed modifications staged'), 'Content indicates staged proposal');

    // Verify turn resumption cursor
    assertEqual(subscribedCursor, 'evt_tr_req_native_1', 'subscribeToTurn used verified event cursor');

    // Verify original file on disk is completely untouched before review
    const diskBeforeAccept = fs.readFileSync(nativeTestFilePath, 'utf8');
    assertEqual(diskBeforeAccept, nativeOriginalCode, 'Original disk file must remain bit-for-bit unchanged before acceptance');

    // Verify session cleanup
    assertEqual(deletedSessionId, 'session_native_e2e_1', 'Session must be cleaned up after successful completion');
  });

  await runTest('Native 8.3: Sequential multi-tool native execution (search_code -> propose_edit)', async () => {
    const mockSeqConn = new TrueForgeConnection();
    (mockSeqConn.getClient().sessions as any).create = async () => ({
      data: { id: 'session_seq_native' }
    });
    (mockSeqConn.getClient().sessions as any).delete = async () => { };

    let cycleNum = 0;
    const executedToolNames: string[] = [];

    (mockSeqConn.getClient().sessions as any).createTurnStream = async function* () {
      yield {
        type: 'turn.created',
        id: 'evt_tc_seq',
        turnId: 'turn_seq_multi_tool'
      };
      yield {
        type: 'model.message',
        id: 'msg_seq_s1',
        toolCalls: [
          {
            id: 'call_seq_search',
            type: 'function',
            function: {
              name: 'search_code',
              arguments: JSON.stringify({ query: 'computeBeta' })
            }
          }
        ]
      };
      yield {
        type: 'tool.response_required',
        id: 'evt_req_seq_1',
        toolCalls: [{ id: 'call_seq_search', sourceEventId: 'msg_seq_s1' }]
      };
    };

    (mockSeqConn.getClient().sessions as any).createTurnEvents = async () => ({ success: true });

    (mockSeqConn.getClient().sessions as any).subscribeToTurn = async function* (_s: string, _t: string, req: any) {
      cycleNum++;
      if (cycleNum === 1) {
        assertEqual(req.afterEventId, 'evt_req_seq_1', 'First resume cursor match');
        yield {
          type: 'model.message',
          id: 'msg_seq_s2',
          toolCalls: [
            {
              id: 'call_seq_edit',
              type: 'function',
              function: {
                name: 'propose_edit',
                arguments: JSON.stringify({
                  path: 'src/test/temp_native_target.ts',
                  startLine: 1,
                  endLine: 3,
                  replacementCode: 'export function computeAlpha(): number {\n  return 999;\n}',
                  explanation: 'Update computeAlpha'
                })
              }
            }
          ]
        };
        yield {
          type: 'tool.response_required',
          id: 'evt_req_seq_2',
          toolCalls: [{ id: 'call_seq_edit', sourceEventId: 'msg_seq_s2' }]
        };
      } else {
        assertEqual(req.afterEventId, 'evt_req_seq_2', 'Second resume cursor match');
        yield {
          type: 'turn.done',
          id: 'done_seq_all',
          state: { status: 'done' }
        };
      }
    };

    const seqCoordinator = new AutonomousAgentCoordinator(mockSeqConn, tools, inlineEditManager, 4);
    const eventsEmitted: string[] = [];
    const seqResult = await seqCoordinator.executeTask('Search and edit computeAlpha', (evt) => {
      if (evt.type === 'tool_call') {
        executedToolNames.push(evt.payload.toolName);
      }
      eventsEmitted.push(evt.type);
    });

    assert(seqResult.success, 'Sequential task must succeed');
    assertEqual(executedToolNames.length, 2, 'Two tools must be executed');
    assertEqual(executedToolNames[0], 'search_code', 'First tool is search_code');
    assertEqual(executedToolNames[1], 'propose_edit', 'Second tool is propose_edit');
    assert(eventsEmitted.includes('diff_ready'), 'diff_ready event must be emitted');
    assert(seqResult.proposedEdit !== undefined, 'proposedEdit must be staged');
  });

  await runTest('Native 8.4: Multiple pending tool calls in single tool.response_required', async () => {
    const mockMultiToolConn = new TrueForgeConnection();
    (mockMultiToolConn.getClient().sessions as any).create = async () => ({
      data: { id: 'session_multi_native' }
    });
    (mockMultiToolConn.getClient().sessions as any).delete = async () => { };

    let submittedToolEvents: any[] = [];

    (mockMultiToolConn.getClient().sessions as any).createTurnStream = async function* () {
      yield {
        type: 'turn.created',
        id: 'evt_tc_multi_batch',
        turnId: 'turn_batch_1'
      };
      yield {
        type: 'model.message',
        id: 'msg_batch_1',
        threadId: 'worker_thread',
        toolCalls: [
          {
            id: 'call_batch_list',
            type: 'function',
            function: {
              name: 'list_files',
              arguments: JSON.stringify({ directory: 'src/test' })
            }
          },
          {
            id: 'call_batch_read',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: 'src/test/temp_native_target.ts', startLine: 1, endLine: 3 })
            }
          }
        ]
      };
      yield {
        type: 'tool.response_required',
        id: 'evt_req_batch_1',
        threadId: 'worker_thread',
        toolCalls: [
          { id: 'call_batch_list', sourceEventId: 'msg_batch_1' },
          { id: 'call_batch_read', sourceEventId: 'msg_batch_1' }
        ]
      };
    };

    (mockMultiToolConn.getClient().sessions as any).createTurnEvents = async (_s: string, _t: string, req: any) => {
      submittedToolEvents = req.events;
      return { success: true };
    };

    (mockMultiToolConn.getClient().sessions as any).subscribeToTurn = async function* () {
      yield {
        type: 'model.message.delta',
        id: 'delta_batch_done',
        content: 'COMPLETION:\nInspected both files and contents.'
      };
      yield {
        type: 'turn.done',
        id: 'done_batch',
        state: { status: 'done' }
      };
    };

    const batchCoord = new AutonomousAgentCoordinator(mockMultiToolConn, tools, inlineEditManager, 3);
    const batchResult = await batchCoord.executeTask('Batch inspect src/test');

    assert(batchResult.success, 'Batch inspection task must succeed');
    assertEqual(submittedToolEvents.length, 2, 'Both tool responses submitted in one createTurnEvents call');
    assertEqual(submittedToolEvents[0].toolCallId, 'call_batch_list', 'First tool call id matches list');
    assertEqual(submittedToolEvents[1].toolCallId, 'call_batch_read', 'Second tool call id matches read');
    assertEqual(submittedToolEvents[0].threadId, 'worker_thread', 'Thread ID matches source thread');
    assertEqual(submittedToolEvents[1].threadId, 'worker_thread', 'Thread ID matches source thread');
  });

  await runTest('Native 8.5: Malformed JSON arguments and unmatched tool-call references', async () => {
    const mockErrConn = new TrueForgeConnection();
    (mockErrConn.getClient().sessions as any).create = async () => ({
      data: { id: 'session_err_native' }
    });
    (mockErrConn.getClient().sessions as any).delete = async () => { };

    let errorResponses: any[] = [];

    (mockErrConn.getClient().sessions as any).createTurnStream = async function* () {
      yield {
        type: 'turn.created',
        id: 'evt_tc_err',
        turnId: 'turn_err_1'
      };
      yield {
        type: 'model.message',
        id: 'msg_err_source_1',
        toolCalls: [
          {
            id: 'call_bad_json_coord',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: '{ invalid json...'
            }
          }
        ]
      };
      yield {
        type: 'tool.response_required',
        id: 'evt_req_err_combo',
        toolCalls: [
          { id: 'call_bad_json_coord', sourceEventId: 'msg_err_source_1' },
          { id: 'call_unmatched_coord', sourceEventId: 'msg_ghost_source' }
        ]
      };
    };

    (mockErrConn.getClient().sessions as any).createTurnEvents = async (_s: string, _t: string, req: any) => {
      errorResponses = req.events;
      return { success: true };
    };

    (mockErrConn.getClient().sessions as any).subscribeToTurn = async function* () {
      yield {
        type: 'model.message.delta',
        id: 'delta_err_recovered',
        content: 'COMPLETION:\nModel handled argument and reference errors gracefully.'
      };
      yield {
        type: 'turn.done',
        id: 'done_err_rec',
        state: { status: 'done' }
      };
    };

    const errCoord = new AutonomousAgentCoordinator(mockErrConn, tools, inlineEditManager, 3);
    const errResult = await errCoord.executeTask('Test error resilience');

    assert(errResult.success, 'Coordinator must handle error responses without crashing');
    assertEqual(errorResponses.length, 2, 'Submitted 2 error responses to TrueForge server');
    assert(errorResponses[0].content.includes('MALFORMED_ARGUMENTS'), 'First response reports MALFORMED_ARGUMENTS');
    assert(errorResponses[1].content.includes('UNMATCHED_TOOL_CALL'), 'Second response reports UNMATCHED_TOOL_CALL');
  });

  await runTest('Native 8.6: User cancellation during native tool execution', async () => {
    const mockCancelConn = new TrueForgeConnection();
    (mockCancelConn.getClient().sessions as any).create = async () => ({
      data: { id: 'session_cancel_native' }
    });
    let cancelCalledOnSession = false;
    (mockCancelConn.getClient().sessions as any).cancel = async () => {
      cancelCalledOnSession = true;
    };
    (mockCancelConn.getClient().sessions as any).delete = async () => { };

    (mockCancelConn.getClient().sessions as any).createTurnStream = async function* () {
      yield {
        type: 'turn.created',
        id: 'evt_tc_cancel',
        turnId: 'turn_cancel_1'
      };
      yield {
        type: 'model.message',
        id: 'msg_cancel_1',
        toolCalls: [
          {
            id: 'call_cancel_pe',
            type: 'function',
            function: {
              name: 'propose_edit',
              arguments: JSON.stringify({
                path: 'src/test/temp_native_target.ts',
                replacementCode: 'SHOULD NEVER BE WRITTEN',
                explanation: 'cancelled edit'
              })
            }
          }
        ]
      };
      yield {
        type: 'tool.response_required',
        id: 'evt_req_cancel',
        toolCalls: [{ id: 'call_cancel_pe', sourceEventId: 'msg_cancel_1' }]
      };
    };

    const cancelCoord = new AutonomousAgentCoordinator(mockCancelConn, tools, inlineEditManager, 3);

    // Trigger cancel during task execution when tool_call is dispatched
    const cancelResult = await cancelCoord.executeTask('Cancel mid-flight', (evt) => {
      if (evt.type === 'tool_call') {
        cancelCoord.cancel().catch(() => { });
      }
    });

    assert(!cancelResult.success, 'Cancelled task must not be marked success');
    assert(Boolean(cancelResult.cancelled), 'Task result must be flagged cancelled');
    assert(cancelCalledOnSession, 'Cancel request must have been sent to TrueForge session');

    const diskAfterCancel = fs.readFileSync(nativeTestFilePath, 'utf8');
    assertEqual(diskAfterCancel, nativeOriginalCode, 'Target file must remain 100% untouched after cancellation');
  });

  await runTest('Native 8.7: Apply accepted proposal and cleanup target file', async () => {
    inlineEditManager.rejectAllPendingEdits();
    // Stage proposal on native target file
    await inlineEditManager.registerAutonomousProposal(
      nativeTestFilePath,
      'export function computeBeta(): number {\n  return 200;\n}',
      'Targeted update computeBeta to 200',
      {
        startLine: 5,
        endLine: 7,
        fullProposedText: nativeOriginalCode.replace('return 20;', 'return 200;')
      }
    );

    const applySuccess = await inlineEditManager.applyEdit();
    assert(applySuccess, 'applyEdit must succeed');

    const diskAfterApply = fs.readFileSync(nativeTestFilePath, 'utf8');
    assert(diskAfterApply.includes('return 200;'), 'computeBeta must contain updated return 200');
    assert(diskAfterApply.includes('export function computeAlpha'), 'computeAlpha must remain intact');
    assert(diskAfterApply.includes('export function computeGamma'), 'computeGamma must remain intact');

    // Cleanup
    if (fs.existsSync(nativeTestFilePath)) fs.unlinkSync(nativeTestFilePath);
  });

  // ----------------------------------------------------
  // SUITE 9: Configurable Autonomous Iteration Limit
  // ----------------------------------------------------
  console.log('\n--- Suite 9: Configurable Autonomous Iteration Limit ---');

  await runTest('Config 9.1: Default value 15 when unconfigured and unpassed', async () => {
    // Clear any prior vscode mock configuration
    if ((vscode.workspace as any)._config) {
      delete (vscode.workspace as any)._config['trueforge.maxAutonomousIterations'];
      delete (vscode.workspace as any)._config['maxAutonomousIterations'];
    }

    assertEqual(DEFAULT_MAX_ITERATIONS, 15, 'DEFAULT_MAX_ITERATIONS constant must be 15');
    assertEqual(MIN_MAX_ITERATIONS, 1, 'MIN_MAX_ITERATIONS constant must be 1');
    assertEqual(MAX_MAX_ITERATIONS, 30, 'MAX_MAX_ITERATIONS constant must be 30');
    assertEqual(AutonomousAgentCoordinator.DEFAULT_MAX_ITERATIONS, 15, 'Coordinator static DEFAULT_MAX_ITERATIONS must be 15');
    assertEqual(AutonomousAgentCoordinator.MIN_MAX_ITERATIONS, 1, 'Coordinator static MIN_MAX_ITERATIONS must be 1');
    assertEqual(AutonomousAgentCoordinator.MAX_MAX_ITERATIONS, 30, 'Coordinator static MAX_MAX_ITERATIONS must be 30');

    const defaultCoord = new AutonomousAgentCoordinator(connection, tools, inlineEditManager);
    assertEqual(defaultCoord.getMaxIterations(), 15, 'Coordinator with no maxIterations param must default to 15');
    assertEqual(AutonomousAgentCoordinator.resolveMaxIterations(), 15, 'resolveMaxIterations() without params must return 15');
  });

  await runTest('Config 9.2: Custom value via constructor injection and boundaries (1 to 30)', async () => {
    const customCoord = new AutonomousAgentCoordinator(connection, tools, inlineEditManager, 20);
    assertEqual(customCoord.getMaxIterations(), 20, 'Constructor injected value 20 must be respected');

    const minCoord = new AutonomousAgentCoordinator(connection, tools, inlineEditManager, 1);
    assertEqual(minCoord.getMaxIterations(), 1, 'Minimum bound value 1 must be respected');

    const maxCoord = new AutonomousAgentCoordinator(connection, tools, inlineEditManager, 30);
    assertEqual(maxCoord.getMaxIterations(), 30, 'Maximum bound value 30 must be respected');
  });

  await runTest('Config 9.3: Custom value read from vscode.workspace.getConfiguration', async () => {
    // Set custom setting in workspace config
    if (!(vscode.workspace as any)._config) {
      (vscode.workspace as any)._config = {};
    }
    (vscode.workspace as any)._config['trueforge.maxAutonomousIterations'] = 22;

    const configCoord = new AutonomousAgentCoordinator(connection, tools, inlineEditManager);
    assertEqual(configCoord.getMaxIterations(), 22, 'Coordinator must read custom value 22 from vscode configuration');
    assertEqual(AutonomousAgentCoordinator.resolveMaxIterations(), 22, 'resolveMaxIterations must resolve 22 from configuration');

    // Clean up
    delete (vscode.workspace as any)._config['trueforge.maxAutonomousIterations'];
    assertEqual(configCoord.getMaxIterations(), 15, 'Coordinator must dynamically fall back to 15 when config is cleared');
  });

  await runTest('Config 9.4: Invalid and out-of-range values safely fall back to 15', async () => {
    // Out of range low
    assertEqual(AutonomousAgentCoordinator.validateIterations(0), 15, 'Value 0 must fall back to 15');
    assertEqual(AutonomousAgentCoordinator.validateIterations(-1), 15, 'Value -1 must fall back to 15');
    assertEqual(AutonomousAgentCoordinator.validateIterations(-100), 15, 'Negative value must fall back to 15');

    // Out of range high
    assertEqual(AutonomousAgentCoordinator.validateIterations(31), 15, 'Value 31 must fall back to 15');
    assertEqual(AutonomousAgentCoordinator.validateIterations(50), 15, 'Value 50 must fall back to 15');
    assertEqual(AutonomousAgentCoordinator.validateIterations(9999), 15, 'Value 9999 must fall back to 15');

    // Non-integer and invalid types
    assertEqual(AutonomousAgentCoordinator.validateIterations(12.5), 15, 'Float value 12.5 must fall back to 15');
    assertEqual(AutonomousAgentCoordinator.validateIterations(NaN), 15, 'NaN must fall back to 15');
    assertEqual(AutonomousAgentCoordinator.validateIterations(Infinity), 15, 'Infinity must fall back to 15');
    assertEqual(AutonomousAgentCoordinator.validateIterations('20' as any), 15, 'String value must fall back to 15');
    assertEqual(AutonomousAgentCoordinator.validateIterations(null as any), 15, 'null must fall back to 15');
    assertEqual(AutonomousAgentCoordinator.validateIterations(undefined as any), 15, 'undefined must fall back to 15');

    // Injected into constructor
    const invalidCoord0 = new AutonomousAgentCoordinator(connection, tools, inlineEditManager, 0);
    assertEqual(invalidCoord0.getMaxIterations(), 15, 'Injected 0 must fall back to 15');

    const invalidCoord35 = new AutonomousAgentCoordinator(connection, tools, inlineEditManager, 35);
    assertEqual(invalidCoord35.getMaxIterations(), 15, 'Injected 35 must fall back to 15');

    // Out of range in vscode configuration
    (vscode.workspace as any)._config['trueforge.maxAutonomousIterations'] = 50;
    assertEqual(AutonomousAgentCoordinator.resolveMaxIterations(), 15, 'Config value 50 must fall back to 15');

    (vscode.workspace as any)._config['trueforge.maxAutonomousIterations'] = 0;
    assertEqual(AutonomousAgentCoordinator.resolveMaxIterations(), 15, 'Config value 0 must fall back to 15');

    (vscode.workspace as any)._config['trueforge.maxAutonomousIterations'] = -10;
    assertEqual(AutonomousAgentCoordinator.resolveMaxIterations(), 15, 'Config value -10 must fall back to 15');

    (vscode.workspace as any)._config['trueforge.maxAutonomousIterations'] = 'not-a-number';
    assertEqual(AutonomousAgentCoordinator.resolveMaxIterations(), 15, 'Invalid config type must fall back to 15');

    // Clean up
    delete (vscode.workspace as any)._config['trueforge.maxAutonomousIterations'];
  });

  await runTest('Config 9.5: Stopping at the configured limit (constructor injection)', async () => {
    let sessionDeleted = false;
    let turnCount = 0;
    const iterationThoughts: string[] = [];

    const mockLimitConn = {
      createSession: async () => 'sess_limit_test',
      deleteSession: async () => {
        sessionDeleted = true;
      },
      cancelTurn: async () => { },
      executeTurnStream: async (_sessId: string, _prompt: string, options: any) => {
        turnCount++;
        const delta = `TOOL_CALL:\n\`\`\`json\n{ "tool": "search_code", "arguments": { "query": "test_turn_${turnCount}" } }\n\`\`\``;
        if (options && options.onDelta) {
          options.onDelta(delta);
        }
        return delta;
      }
    } as unknown as TrueForgeConnection;

    const limitCoord = new AutonomousAgentCoordinator(mockLimitConn, tools, inlineEditManager, 3);
    assertEqual(limitCoord.getMaxIterations(), 3, 'Coordinator limit must be 3');

    const result = await limitCoord.executeTask('Task that reaches limit', (event: AgentTaskEvent) => {
      if (event.type === 'thought' && event.payload.includes('[Iteration')) {
        iterationThoughts.push(event.payload);
      }
    });

    assert(result.success, 'Result must be flagged success when reaching iteration limit');
    assertEqual(result.summary, 'Reached maximum autonomous execution steps (3).', 'Summary message must match');
    assertEqual(turnCount, 3, 'Must stop executing after exactly 3 turns');
    assertEqual(iterationThoughts.length, 3, 'Must emit exactly 3 iteration thought events');
    assert(iterationThoughts[0].includes('[Iteration 1/3]'), 'First iteration log correct');
    assert(iterationThoughts[1].includes('[Iteration 2/3]'), 'Second iteration log correct');
    assert(iterationThoughts[2].includes('[Iteration 3/3]'), 'Third iteration log correct');
    assert(sessionDeleted, 'Session must be safely cleaned up on limit completion');
  });

  await runTest('Config 9.6: Stopping at configured limit read from vscode workspace setting', async () => {
    let sessionDeleted = false;
    let turnCount = 0;

    (vscode.workspace as any)._config['trueforge.maxAutonomousIterations'] = 2;

    const mockConfigLimitConn = {
      createSession: async () => 'sess_config_limit_test',
      deleteSession: async () => {
        sessionDeleted = true;
      },
      cancelTurn: async () => { },
      executeTurnStream: async (_sessId: string, _prompt: string, options: any) => {
        turnCount++;
        const delta = `TOOL_CALL:\n\`\`\`json\n{ "tool": "search_code", "arguments": { "query": "test_config_turn_${turnCount}" } }\n\`\`\``;
        if (options && options.onDelta) {
          options.onDelta(delta);
        }
        return delta;
      }
    } as unknown as TrueForgeConnection;

    const configLimitCoord = new AutonomousAgentCoordinator(mockConfigLimitConn, tools, inlineEditManager);
    assertEqual(configLimitCoord.getMaxIterations(), 2, 'Max iterations must be 2 from config');

    const result = await configLimitCoord.executeTask('Task with config limit');
    assert(result.success, 'Result must succeed on reaching iteration limit');
    assertEqual(result.summary, 'Reached maximum autonomous execution steps (2).', 'Summary message must match limit of 2');
    assertEqual(turnCount, 2, 'Must stop executing after exactly 2 turns');
    assert(sessionDeleted, 'Session must be cleaned up');

    delete (vscode.workspace as any)._config['trueforge.maxAutonomousIterations'];
  });

  await runTest('Config 9.7: Cancellation behavior before execution starts', async () => {
    let sessionCreated = false;
    const mockPreCancelConn = {
      createSession: async () => {
        sessionCreated = true;
        return 'sess_precancel';
      },
      deleteSession: async () => { },
      cancelTurn: async () => { },
      executeTurnStream: async function* () { }
    } as unknown as TrueForgeConnection;

    const cancelCoord = new AutonomousAgentCoordinator(mockPreCancelConn, tools, inlineEditManager, 5);
    await cancelCoord.cancel();

    let cancelledEventFired = false;
    const result = await cancelCoord.executeTask('Task cancelled beforehand', (event) => {
      if (event.type === 'task_cancelled') {
        cancelledEventFired = true;
      }
    });

    assert(!result.success, 'Result must not be marked success');
    assert(Boolean(result.cancelled), 'Result must have cancelled = true');
    assertEqual(result.summary, 'Task was cancelled by user.', 'Summary must indicate user cancellation');
    assert(cancelledEventFired, 'task_cancelled event must be emitted');
    assert(!sessionCreated, 'Session must not be created if cancelled prior to start');
  });

  await runTest('Config 9.8: Cancellation behavior during execution loop', async () => {
    let sessionDeleted = false;
    let cancelTurnCalled = false;
    let turnCount = 0;

    let coordRef: AutonomousAgentCoordinator;

    const mockMidCancelConn = {
      createSession: async () => 'sess_midcancel',
      deleteSession: async () => {
        sessionDeleted = true;
      },
      cancelTurn: async () => {
        cancelTurnCalled = true;
      },
      executeTurnStream: async (_sessId: string, _prompt: string, options: any) => {
        turnCount++;
        if (turnCount === 2) {
          // Trigger user cancellation on turn 2
          await coordRef.cancel();
        }
        const delta = `TOOL_CALL:\n\`\`\`json\n{ "tool": "search_code", "arguments": { "query": "mid_cancel_${turnCount}" } }\n\`\`\``;
        if (options && options.onDelta) {
          options.onDelta(delta);
        }
        return delta;
      }
    } as unknown as TrueForgeConnection;

    coordRef = new AutonomousAgentCoordinator(mockMidCancelConn, tools, inlineEditManager, 5);

    let cancelledEventEmitted = false;
    const result = await coordRef.executeTask('Task cancelled mid-execution', (event) => {
      if (event.type === 'task_cancelled') {
        cancelledEventEmitted = true;
      }
    });

    assert(!result.success, 'Task should not succeed when cancelled mid-run');
    assert(Boolean(result.cancelled), 'Task result must be flagged as cancelled');
    assertEqual(result.summary, 'Task was cancelled by user.', 'Summary must indicate cancellation');
    assert(cancelledEventEmitted, 'task_cancelled event must be emitted');
    assertEqual(turnCount, 2, 'Execution loop must halt and not run turn 3');
    assert(cancelTurnCalled, 'cancelTurn must be invoked on the active session');
    assert(sessionDeleted, 'Active session must be cleaned up on cancellation');
  });

  // ----------------------------------------------------
  // SUITE 10: Multi-File Autonomous Loop & Queue Management
  // ----------------------------------------------------
  console.log('\n--- Suite 10: Multi-File Autonomous Loop & Queue Management ---');

  const multiFile1 = path.join(workspaceRoot, 'src', 'test', 'temp_multi_1.ts');
  const multiFile2 = path.join(workspaceRoot, 'src', 'test', 'temp_multi_2.ts');
  const multiFile3 = path.join(workspaceRoot, 'src', 'test', 'temp_multi_3.ts');

  const origContent1 = 'export const val1 = "original_1";\n';
  const origContent2 = 'export const val2 = "original_2";\n';
  const origContent3 = 'export const val3 = "original_3";\n';

  const replaceContent1 = 'export const val1 = "modified_1";\n';
  const replaceContent2 = 'export const val2 = "modified_2";\n';
  const replaceContent3 = 'export const val3 = "modified_3";\n';

  await runTest('MultiFile 10.1: Autonomous multi-file loop stages 3 distinct files without early termination', async () => {
    // Write initial files to disk
    fs.writeFileSync(multiFile1, origContent1, 'utf8');
    fs.writeFileSync(multiFile2, origContent2, 'utf8');
    fs.writeFileSync(multiFile3, origContent3, 'utf8');

    // Reset pending edits
    inlineEditManager.rejectAllPendingEdits();

    const mockMultiConn = new TrueForgeConnection();
    (mockMultiConn.getClient().sessions as any).create = async () => ({
      data: { id: 'session_multi_file_10_1' }
    });
    (mockMultiConn.getClient().sessions as any).delete = async () => { };
    (mockMultiConn.getClient().sessions as any).createTurnEvents = async () => ({ success: true });

    let turnStep = 0;
    (mockMultiConn.getClient().sessions as any).createTurnStream = async function* () {
      yield {
        type: 'turn.created',
        id: 'evt_tc_mf_1',
        turnId: 'turn_mf_1'
      };
      yield {
        type: 'model.message',
        id: 'msg_mf_1',
        toolCalls: [
          {
            id: 'call_mf_1',
            type: 'function',
            function: {
              name: 'propose_edit',
              arguments: JSON.stringify({
                path: 'src/test/temp_multi_1.ts',
                replacementCode: replaceContent1,
                explanation: 'Update multiFile1'
              })
            }
          }
        ]
      };
      yield {
        type: 'tool.response_required',
        id: 'evt_req_mf_1',
        toolCalls: [{ id: 'call_mf_1', sourceEventId: 'msg_mf_1' }]
      };
    };

    (mockMultiConn.getClient().sessions as any).subscribeToTurn = async function* (_s: string, _t: string, req: any) {
      turnStep++;
      if (turnStep === 1) {
        assertEqual(req.afterEventId, 'evt_req_mf_1', 'Cursor after 1st propose_edit');
        yield {
          type: 'model.message',
          id: 'msg_mf_2',
          toolCalls: [
            {
              id: 'call_mf_2',
              type: 'function',
              function: {
                name: 'propose_edit',
                arguments: JSON.stringify({
                  path: 'src/test/temp_multi_2.ts',
                  replacementCode: replaceContent2,
                  explanation: 'Update multiFile2'
                })
              }
            }
          ]
        };
        yield {
          type: 'tool.response_required',
          id: 'evt_req_mf_2',
          toolCalls: [{ id: 'call_mf_2', sourceEventId: 'msg_mf_2' }]
        };
      } else if (turnStep === 2) {
        assertEqual(req.afterEventId, 'evt_req_mf_2', 'Cursor after 2nd propose_edit');
        yield {
          type: 'model.message',
          id: 'msg_mf_3',
          toolCalls: [
            {
              id: 'call_mf_3',
              type: 'function',
              function: {
                name: 'propose_edit',
                arguments: JSON.stringify({
                  path: 'src/test/temp_multi_3.ts',
                  replacementCode: replaceContent3,
                  explanation: 'Update multiFile3'
                })
              }
            }
          ]
        };
        yield {
          type: 'tool.response_required',
          id: 'evt_req_mf_3',
          toolCalls: [{ id: 'call_mf_3', sourceEventId: 'msg_mf_3' }]
        };
      } else {
        assertEqual(req.afterEventId, 'evt_req_mf_3', 'Cursor after 3rd propose_edit');
        yield {
          type: 'turn.done',
          id: 'done_mf_all',
          state: { status: 'done' }
        };
      }
    };

    const multiCoord = new AutonomousAgentCoordinator(mockMultiConn, tools, inlineEditManager, 5);
    const events: string[] = [];
    const res = await multiCoord.executeTask('Modify 3 files sequentially', (evt) => {
      events.push(evt.type);
    });

    assert(res.success, `Task must succeed: ${res.error}`);
    assertEqual(res.proposedEdits?.length ?? 0, 3, 'Must record 3 proposed edits in result');
    assertEqual(inlineEditManager.getPendingEditCount(), 3, 'InlineEditManager must stage all 3 proposals in queue');

    // Verify diff_ready event emitted for each proposed edit
    const diffReadyCount = events.filter((t) => t === 'diff_ready').length;
    assertEqual(diffReadyCount, 3, 'Must emit diff_ready 3 times');

    // Critical safety check: zero disk writes before explicit approval!
    assertEqual(fs.readFileSync(multiFile1, 'utf8'), origContent1, 'File 1 must be untouched on disk');
    assertEqual(fs.readFileSync(multiFile2, 'utf8'), origContent2, 'File 2 must be untouched on disk');
    assertEqual(fs.readFileSync(multiFile3, 'utf8'), origContent3, 'File 3 must be untouched on disk');
  });

  await runTest('MultiFile 10.2: Individual proposal acceptance and rejection from queue', async () => {
    assertEqual(inlineEditManager.getPendingEditCount(), 3, 'Precondition: 3 pending edits queued');

    // 1. Accept file 1
    const p1 = inlineEditManager.getPendingEditForUri(vscode.Uri.file(multiFile1));
    assert(p1 !== undefined, 'Pending proposal for file 1 must exist');
    const accepted1 = await inlineEditManager.applyEdit(p1);
    assert(accepted1, 'Accepting file 1 must succeed');

    // Verify file 1 modified on disk, others untouched
    assertEqual(fs.readFileSync(multiFile1, 'utf8'), replaceContent1, 'File 1 on disk must now have modified content');
    assertEqual(fs.readFileSync(multiFile2, 'utf8'), origContent2, 'File 2 on disk must remain untouched');
    assertEqual(fs.readFileSync(multiFile3, 'utf8'), origContent3, 'File 3 on disk must remain untouched');
    assertEqual(inlineEditManager.getPendingEditCount(), 2, 'Pending queue count must decrease to 2');

    // 2. Reject file 2
    const p2 = inlineEditManager.getPendingEditForUri(vscode.Uri.file(multiFile2));
    assert(p2 !== undefined, 'Pending proposal for file 2 must exist');
    inlineEditManager.rejectEdit(p2);

    // Verify file 2 untouched on disk, queue decreases to 1
    assertEqual(fs.readFileSync(multiFile2, 'utf8'), origContent2, 'File 2 on disk must still have original content');
    assertEqual(inlineEditManager.getPendingEditCount(), 1, 'Pending queue count must decrease to 1');

    // File 3 still pending in queue
    const p3 = inlineEditManager.getPendingEditForUri(vscode.Uri.file(multiFile3));
    assert(p3 !== undefined, 'Pending proposal for file 3 must still exist');

    // Clean up remaining file 3
    inlineEditManager.rejectEdit(p3);
    assertEqual(inlineEditManager.getPendingEditCount(), 0, 'Queue must be empty after rejecting file 3');
  });

  await runTest('MultiFile 10.3: Batch acceptance via applyAllPendingEdits applies all queued files and resets queue', async () => {
    // Re-stage proposals for file 2 and file 3
    await inlineEditManager.registerAutonomousProposal(
      multiFile2,
      replaceContent2,
      'Batch edit for file 2',
      { allowQueue: true }
    );
    await inlineEditManager.registerAutonomousProposal(
      multiFile3,
      replaceContent3,
      'Batch edit for file 3',
      { allowQueue: true }
    );

    assertEqual(inlineEditManager.getPendingEditCount(), 2, '2 proposals queued');

    // Batch apply
    const batchRes = await inlineEditManager.applyAllPendingEdits();
    assertEqual(batchRes.failed, 0, 'No failures in batch apply');
    assertEqual(batchRes.successful, 2, 'Both proposals applied');
    assertEqual(inlineEditManager.getPendingEditCount(), 0, 'Queue must be empty after batch apply');

    // Verify both files modified on disk
    assertEqual(fs.readFileSync(multiFile2, 'utf8'), replaceContent2, 'File 2 must be modified');
    assertEqual(fs.readFileSync(multiFile3, 'utf8'), replaceContent3, 'File 3 must be modified');

    // Cleanup disk files
    if (fs.existsSync(multiFile1)) fs.unlinkSync(multiFile1);
    if (fs.existsSync(multiFile2)) fs.unlinkSync(multiFile2);
    if (fs.existsSync(multiFile3)) fs.unlinkSync(multiFile3);
  });

  await runTest('MultiFile 10.4: Loop detector detects 4 consecutive identical tool calls and halts with LOOP_DETECTED', async () => {
    const mockLoopConn = new TrueForgeConnection();
    (mockLoopConn.getClient().sessions as any).create = async () => ({
      data: { id: 'session_loop_detect' }
    });
    (mockLoopConn.getClient().sessions as any).delete = async () => { };
    (mockLoopConn.getClient().sessions as any).createTurnEvents = async () => ({ success: true });

    let loopStep = 0;
    (mockLoopConn.getClient().sessions as any).createTurnStream = async function* () {
      yield {
        type: 'turn.created',
        id: 'evt_tc_loop_0',
        turnId: 'turn_loop_0'
      };
      yield {
        type: 'model.message',
        id: 'msg_loop_0',
        toolCalls: [
          {
            id: 'call_loop_0',
            type: 'function',
            function: {
              name: 'search_code',
              arguments: JSON.stringify({ query: 'stuck_loop_marker' })
            }
          }
        ]
      };
      yield {
        type: 'tool.response_required',
        id: 'evt_req_loop_0',
        toolCalls: [{ id: 'call_loop_0', sourceEventId: 'msg_loop_0' }]
      };
    };

    (mockLoopConn.getClient().sessions as any).subscribeToTurn = async function* (_s: string, _t: string, _req: any) {
      loopStep++;
      yield {
        type: 'model.message',
        id: `msg_loop_${loopStep}`,
        toolCalls: [
          {
            id: `call_loop_${loopStep}`,
            type: 'function',
            function: {
              name: 'search_code',
              arguments: JSON.stringify({ query: 'stuck_loop_marker' })
            }
          }
        ]
      };
      yield {
        type: 'tool.response_required',
        id: `evt_req_loop_${loopStep}`,
        toolCalls: [{ id: `call_loop_${loopStep}`, sourceEventId: `msg_loop_${loopStep}` }]
      };
    };

    const loopCoord = new AutonomousAgentCoordinator(mockLoopConn, tools, inlineEditManager, 10);
    const loopResult = await loopCoord.executeTask('Repeatedly run identical search_code');

    assert(!loopResult.success, 'Looping task must fail');
    assert(Boolean(loopResult.error?.includes('LOOP_DETECTED')), `Error must mention LOOP_DETECTED, got: ${loopResult.error}`);
  });

  await runTest('MultiFile 10.5: Mid-flight cancellation halts the multi-file loop cleanly without disk changes', async () => {
    const cancelMultiTarget = path.join(workspaceRoot, 'src', 'test', 'temp_cancel_multi.ts');
    fs.writeFileSync(cancelMultiTarget, 'export const untouched = true;\n', 'utf8');

    const mockCancelConn = new TrueForgeConnection();
    (mockCancelConn.getClient().sessions as any).create = async () => ({
      data: { id: 'session_cancel_mf' }
    });
    (mockCancelConn.getClient().sessions as any).delete = async () => { };
    (mockCancelConn.getClient().sessions as any).cancel = async () => { };
    (mockCancelConn.getClient().sessions as any).createTurnEvents = async () => ({ success: true });

    let cStep = 0;
    (mockCancelConn.getClient().sessions as any).createTurnStream = async function* () {
      yield {
        type: 'turn.created',
        id: 'evt_tc_cmf_0',
        turnId: 'turn_cmf_0'
      };
      yield {
        type: 'model.message',
        id: 'msg_cmf_0',
        toolCalls: [
          {
            id: 'call_cmf_0',
            type: 'function',
            function: {
              name: 'search_code',
              arguments: JSON.stringify({ query: 'untouched' })
            }
          }
        ]
      };
      yield {
        type: 'tool.response_required',
        id: 'evt_req_cmf_0',
        toolCalls: [{ id: 'call_cmf_0', sourceEventId: 'msg_cmf_0' }]
      };
    };

    let cancelCoordRef: AutonomousAgentCoordinator;
    (mockCancelConn.getClient().sessions as any).subscribeToTurn = async function* () {
      cStep++;
      if (cStep === 1) {
        // Cancel when 2nd turn starts
        await cancelCoordRef.cancel();
      }
      yield {
        type: 'model.message',
        id: `msg_cmf_${cStep}`,
        toolCalls: [
          {
            id: `call_cmf_${cStep}`,
            type: 'function',
            function: {
              name: 'propose_edit',
              arguments: JSON.stringify({
                path: 'src/test/temp_cancel_multi.ts',
                replacementCode: 'export const untouched = false;\n',
                explanation: 'Should be cancelled'
              })
            }
          }
        ]
      };
      yield {
        type: 'tool.response_required',
        id: `evt_req_cmf_${cStep}`,
        toolCalls: [{ id: `call_cmf_${cStep}`, sourceEventId: `msg_cmf_${cStep}` }]
      };
    };

    cancelCoordRef = new AutonomousAgentCoordinator(mockCancelConn, tools, inlineEditManager, 5);
    const cancelResult = await cancelCoordRef.executeTask('Cancel mid-run');

    assert(!cancelResult.success, 'Task must not succeed after cancellation');
    assert(Boolean(cancelResult.cancelled), 'Task result must flag cancelled = true');
    assertEqual(fs.readFileSync(cancelMultiTarget, 'utf8'), 'export const untouched = true;\n', 'File on disk must remain untouched');

    if (fs.existsSync(cancelMultiTarget)) fs.unlinkSync(cancelMultiTarget);
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
    console.log('\n🎉 ALL MILESTONE 3 & TARGETED EDIT TESTS PASSED PERFECTLY!\n');
  }
}

runMilestone3TestSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
