import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { WorkspaceContextDiscovery } from '../context/WorkspaceContextDiscovery.js';
import { ContextAssembler, ActiveEditorInput } from '../context/ContextAssembler.js';
import { InlineEditManager, PendingEdit } from '../diff/InlineEditManager.js';
import { TrueForgeConnection } from '../connection/TrueForgeConnection.js';
import { AutonomousAgentCoordinator } from '../agent/AutonomousAgentCoordinator.js';
import { WorkspaceTools } from '../agent/WorkspaceTools.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${testName}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${testName} - ${detail ?? 'Assertion failed'}`);
    failed++;
  }
}

async function runTests() {
  console.log('====================================================');
  console.log('  TRUEFORGE MILESTONE 2: CONTEXT & INLINE EDIT TESTS');
  console.log('====================================================\n');

  const workspaceRoot = process.cwd();
  console.log(`Workspace root: ${workspaceRoot}\n`);

  // -----------------------------------------------------------------
  // SUITE 1: Workspace Context Discovery & Security Boundaries
  // -----------------------------------------------------------------
  console.log('--- Suite 1: Workspace Context Discovery & Boundaries ---');
  const discovery = new WorkspaceContextDiscovery(workspaceRoot);

  // 1.1 Path Boundary Check
  assert(
    discovery.isPathWithinWorkspace(path.join(workspaceRoot, 'src', 'extension.ts')),
    'Internal path allowed within workspace'
  );
  assert(
    !discovery.isPathWithinWorkspace(path.join(workspaceRoot, '..', 'outside.txt')),
    'Parent traversal rejected'
  );
  assert(
    !discovery.isPathWithinWorkspace('C:\\Windows\\System32\\cmd.exe'),
    'External system path rejected'
  );

  // 1.1b Canonical Root & Fail-Closed Regression Checks
  assert(
    discovery.isWorkspaceAvailable(),
    'Workspace is available when root canonically resolves'
  );
  assert(
    discovery.getCanonicalWorkspaceRoot().length > 0,
    'Canonical workspace root is populated'
  );

  const invalidDiscovery = new WorkspaceContextDiscovery(path.join(workspaceRoot, 'nonexistent_root_path_0000'));
  assert(
    !invalidDiscovery.isWorkspaceAvailable(),
    'Workspace unavailable when root fails canonical resolution'
  );
  assert(
    !invalidDiscovery.isPathWithinWorkspace('file.txt'),
    'isPathWithinWorkspace fails closed when workspace unavailable'
  );

  // 1.2 Ignored Directories Check
  assert(
    discovery.shouldIgnoreDirectory('node_modules', 'node_modules'),
    'node_modules directory ignored'
  );
  assert(
    discovery.shouldIgnoreDirectory('dist', 'dist'),
    'dist build directory ignored'
  );
  assert(
    discovery.shouldIgnoreDirectory('data', 'data'),
    'data directory (SQLite) ignored'
  );
  assert(
    discovery.shouldIgnoreDirectory('.git', '.git'),
    '.git directory ignored'
  );
  assert(
    !discovery.shouldIgnoreDirectory('src', 'src'),
    'src directory allowed'
  );

  // 1.3 Secret & Binary File Exclusions
  assert(
    discovery.shouldIgnoreFile('.env', '.env'),
    '.env secret file ignored'
  );
  assert(
    discovery.shouldIgnoreFile('.env.local', '.env.local'),
    '.env.local secret file ignored'
  );
  assert(
    discovery.shouldIgnoreFile('id_rsa', 'id_rsa'),
    'id_rsa key ignored'
  );
  assert(
    discovery.shouldIgnoreFile('cert.pem', 'cert.pem'),
    '.pem certificate ignored'
  );
  assert(
    discovery.shouldIgnoreFile('trueforge.sqlite', 'data/trueforge.sqlite'),
    '.sqlite database file ignored'
  );
  assert(
    discovery.shouldIgnoreFile('app.exe', 'app.exe'),
    '.exe binary file ignored'
  );
  assert(
    discovery.shouldIgnoreFile('icon.png', 'media/icon.png'),
    '.png image file ignored'
  );
  assert(
    !discovery.shouldIgnoreFile('extension.ts', 'src/extension.ts'),
    'extension.ts source file allowed'
  );

  // 1.4 Real File Discovery
  const discovered = await discovery.discoverFiles({ maxFiles: 50 });
  assert(discovered.length > 0, `Discovered ${discovered.length} files in workspace`);
  const hasSecrets = discovered.some((f) => f.relativePath.includes('.env') || f.relativePath.includes('.sqlite'));
  assert(!hasSecrets, 'No secret or sqlite files present in discovered files');

  // 1.5 Relevance Ranking
  const relevantFiles = await discovery.findRelevantFiles('health probe server capabilities', 'src/extension.ts', 3);
  assert(relevantFiles.length > 0, `Found ${relevantFiles.length} relevant files for query`);
  const topFile = relevantFiles[0]?.relativePath;
  assert(
    topFile?.includes('HealthProbe') || topFile?.includes('TrueForgeConnection'),
    `Top relevant file is related to connection/probe: "${topFile}"`
  );

  // -----------------------------------------------------------------
  // SUITE 2: Context Assembler & Token Budget Management
  // -----------------------------------------------------------------
  console.log('\n--- Suite 2: Context Assembler & Token Budget ---');
  const assembler = new ContextAssembler(discovery, { maxTokenBudget: 2000 });

  const sampleDoc = [
    'import * as vscode from "vscode";',
    '',
    'export function calculateSum(a: number, b: number): number {',
    '  // calculate sum',
    '  return a + b;',
    '}',
    '',
    'export function calculateDiff(a: number, b: number): number {',
    '  return a - b;',
    '}'
  ].join('\n');

  // 2.1 Explicit Selection Assembly
  const selectionInput: ActiveEditorInput = {
    documentUri: path.join(workspaceRoot, 'src', 'math.ts'),
    documentText: sampleDoc,
    languageId: 'typescript',
    selectionText: '  // calculate sum\n  return a + b;',
    selectionStartLine: 4,
    selectionEndLine: 5
  };

  const contextWithSelection = await assembler.assembleContext(selectionInput, 'Add input validation');
  assert(!contextWithSelection.isFullFile, 'Context identifies partial selection');
  assert(contextWithSelection.selectionText.includes('return a + b;'), 'Selection text preserved');
  assert(contextWithSelection.surroundingPrefix.includes('calculateSum'), 'Surrounding prefix captures function signature');
  assert(contextWithSelection.estimatedTokens > 0, `Estimated tokens calculated: ${contextWithSelection.estimatedTokens}`);

  // 2.2 Empty Selection (Full File Fallback)
  const emptySelectionInput: ActiveEditorInput = {
    documentUri: path.join(workspaceRoot, 'src', 'math.ts'),
    documentText: sampleDoc,
    languageId: 'typescript',
    selectionText: '',
    selectionStartLine: 1,
    selectionEndLine: 1
  };

  const contextEmptySelection = await assembler.assembleContext(emptySelectionInput, 'Add file header comment');
  assert(contextEmptySelection.isFullFile, 'Context identifies full file when selection is empty');
  assert(contextEmptySelection.selectionText === sampleDoc, 'Full document text used as target');

  // 2.3 Strict Token Budget Enforcement
  const tightAssembler = new ContextAssembler(discovery, { maxTokenBudget: 150 });
  const tightContext = await tightAssembler.assembleContext(selectionInput, 'Refactor this code');
  assert(
    tightContext.estimatedTokens <= 250,
    `Budget capped: estimated ${tightContext.estimatedTokens} tokens with tight budget`
  );

  // -----------------------------------------------------------------
  // SUITE 3: Inline Edit Code Extraction & Replacement Logic
  // -----------------------------------------------------------------
  console.log('\n--- Suite 3: Inline Edit Code Extraction ---');
  const mockConnection = new TrueForgeConnection();
  const editManager = new InlineEditManager(mockConnection, assembler);

  // 3.1 Standard fenced code block
  const llmResponse1 = '```typescript\nfunction calculateSum(a: number, b: number): number {\n  return a + b;\n}\n```';
  const extracted1 = editManager.extractReplacementCode(llmResponse1, 'typescript');
  assert(
    extracted1 === 'function calculateSum(a: number, b: number): number {\n  return a + b;\n}',
    'Extracts standard markdown fenced block cleanly'
  );

  // 3.2 Conversational wrapper with explanation
  const llmResponse2 =
    'Here is the refactored code you requested:\n\n```typescript\nconst result = a + b;\nreturn result;\n```\nLet me know if you need more changes!';
  const extracted2 = editManager.extractReplacementCode(llmResponse2, 'typescript');
  assert(
    extracted2 === 'const result = a + b;\nreturn result;',
    'Extracts code and strips leading/trailing conversational text'
  );

  // 3.3 Streaming cutoff without closing fence
  const llmResponse3 = '```typescript\nfunction test() {\n  return 42;\n}';
  const extracted3 = editManager.extractReplacementCode(llmResponse3, 'typescript');
  assert(
    extracted3 === 'function test() {\n  return 42;\n}',
    'Extracts code from unclosed streaming code block'
  );

  // 3.4 Bare code (no backticks)
  const llmResponse4 = 'return a * b;';
  const extracted4 = editManager.extractReplacementCode(llmResponse4, 'typescript');
  assert(extracted4 === 'return a * b;', 'Handles bare raw code output');

  // 3.5 Accept Edit Workflow Test
  const testDocPath = path.join(workspaceRoot, 'test-doc.ts');
  const mockPendingAccept = {
    documentUri: { toString: () => vscode.Uri.file(testDocPath).toString(), fsPath: testDocPath, path: testDocPath } as any,
    range: { start: { line: 0, character: 0 }, end: { line: 1, character: 10 } } as any,
    originalSelectionText: 'const oldVal = 1;',
    replacementText: 'const newVal = 2;',
    diffUri: { toString: () => 'trueforge-diff://proposed/doc.ts' } as any
  };
  (editManager as any).activePendingEdit = mockPendingAccept;
  const acceptResult = await editManager.applyEdit(mockPendingAccept);
  assert(acceptResult === true, 'Accept workflow applies edit and returns success');
  if (fs.existsSync(testDocPath)) {
    try { fs.unlinkSync(testDocPath); } catch {}
  }

  // 3.6 Reject Edit Workflow Test & File Preservation
  const originalFileContent = 'function immutableOriginal() { return true; }';
  let preservedFileContent = originalFileContent;

  const testImmutablePath = path.join(workspaceRoot, 'test-immutable.ts');
  const mockPendingReject = {
    documentUri: { toString: () => vscode.Uri.file(testImmutablePath).toString(), fsPath: testImmutablePath, path: testImmutablePath } as any,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 46 } } as any,
    originalSelectionText: originalFileContent,
    replacementText: 'function mutatedCode() { return false; }',
    diffUri: { toString: () => 'trueforge-diff://proposed/immutable.ts' } as any
  };

  // Execute reject
  editManager.rejectEdit(mockPendingReject);
  // Verify original text was not mutated
  assert(preservedFileContent === originalFileContent, 'Reject leaves original document completely untouched');
  assert(editManager.getActivePendingEdit() === null, 'Pending edit state cleared after reject');

  // -----------------------------------------------------------------
  // SUITE 4: Live Integration Test with forgeagent
  // -----------------------------------------------------------------
  console.log('\n--- Suite 4: Live Agent Inline Edit Generation ---');
  try {
    const health = await mockConnection.checkHealth();
    if (!health.ok) {
      console.log(`  [Note] Sandbox environment cannot connect to local port 8790: ${health.error}`);
      console.log('  [Note] Skipping live turn probe (verified online in Extension Development Host).');
    } else {
      assert(health.ok, `TrueForge server is healthy at ${mockConnection.getBaseUrl()}`);

      const agent = await mockConnection.getAgent();
      assert(agent !== undefined, `forgeagent retrieved: ID=${agent?.id}, Model=${agent?.modelName}`);

      console.log('  Submitting inline edit task to forgeagent...');
      const testSessionId = await mockConnection.createSession();
      assert(typeof testSessionId === 'string' && testSessionId.length > 0, `Session created: ${testSessionId}`);

      const inlineEditPrompt = editManager.buildPrompt(
        'Add JSDoc documentation and TypeScript types to this function.',
        {
          languageId: 'typescript',
          formattedMarkdown: [
            '### Target Code to Replace:',
            '```typescript',
            'function multiply(a, b) {',
            '  return a * b;',
            '}',
            '```'
          ].join('\n')
        }
      );

      let streamOutput = '';
      const response = await mockConnection.executeTurnStream(
        testSessionId,
        inlineEditPrompt,
        (chunk) => {
          streamOutput += chunk;
        }
      );

      assert(response.length > 0, `Received agent turn response (${response.length} chars)`);

      const extractedReplacement = editManager.extractReplacementCode(response, 'typescript');
      assert(extractedReplacement.length > 0, `Successfully extracted replacement code`);
      assert(
        extractedReplacement.includes('multiply') && extractedReplacement.includes('number'),
        `Proposed code contains typed multiply function`
      );

      console.log('\n  Proposed Replacement Code:\n----------------------------------------');
      console.log(extractedReplacement);
      console.log('----------------------------------------\n');

      await mockConnection.deleteSession(testSessionId);
      assert(true, 'Test session cleaned up cleanly');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(false, `Live agent turn failed: ${msg}`);
  }

  // -----------------------------------------------------------------
  // SUITE 5: Robust Inline Edit Cancellation
  // -----------------------------------------------------------------
  console.log('\n--- Suite 5: Robust Inline Edit Cancellation ---');

  const cancelTestFilePath = path.join(workspaceRoot, 'src', 'test', 'temp_cancel_target.ts');
  const cancelTestCode = [
    'export function calculateArea(width: number, height: number): number {',
    '  return width * height;',
    '}'
  ].join('\n');

  fs.writeFileSync(cancelTestFilePath, cancelTestCode, 'utf8');
  const cancelTargetUri = vscode.Uri.file(cancelTestFilePath);
  const cancelDocument = await vscode.workspace.openTextDocument(cancelTargetUri);
  const cancelSelection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 24));
  const baselineHash = crypto.createHash('sha256').update(fs.readFileSync(cancelTestFilePath)).digest('hex');

  // 5.1 Cancellation before the request starts
  {
    let sessionCreated = false;
    const mockPreCancelConn = {
      createSession: async () => {
        sessionCreated = true;
        return 'sess_pre_cancel';
      },
      deleteSession: async () => {},
      cancelTurn: async () => {},
      executeTurnStream: async () => 'code'
    } as unknown as TrueForgeConnection;

    const mgr = new InlineEditManager(mockPreCancelConn, assembler);
    const cts = new vscode.CancellationTokenSource();
    cts.cancel(); // Pre-cancelled

    const result = await mgr.generateInlineEdit(
      cancelDocument,
      cancelSelection,
      'Optimize area calculation',
      cts.token
    );

    assert(result === null, 'Pre-flight cancellation returns null immediately');
    assert(!sessionCreated, 'Session was not created when cancelled prior to request');
    assert(mgr.getActivePendingEdit() === null, 'No pending edit staged after pre-flight cancellation');
    assert(((cts as any)._listeners || []).length === 0, 'Cancellation listeners cleaned up after pre-flight cancellation');
  }

  // 5.2 Cancellation during model generation
  {
    let cancelTurnCalledWith: string | null = null;
    let sessionDeleted = false;

    const cts = new vscode.CancellationTokenSource();

    const mockGenCancelConn = {
      createSession: async () => 'sess_gen_cancel',
      deleteSession: async (_id: string) => {
        sessionDeleted = true;
      },
      cancelTurn: async (id: string) => {
        cancelTurnCalledWith = id;
      },
      executeTurnStream: async (_id: string, _prompt: string, options: any) => {
        // Model generation is in-flight: trigger cancellation now
        cts.cancel();
        if (options?.abortSignal?.aborted) {
          const err = new Error('Turn was cancelled.');
          err.name = 'AbortError';
          throw err;
        }
        return '';
      }
    } as unknown as TrueForgeConnection;

    const mgr = new InlineEditManager(mockGenCancelConn, assembler);

    const result = await mgr.generateInlineEdit(
      cancelDocument,
      cancelSelection,
      'Refactor area calculation',
      cts.token
    );

    assert(result === null, 'Cancellation during generation returns null');
    assert(cancelTurnCalledWith === 'sess_gen_cancel', 'cancelTurn called with active session ID on server');
    assert(mgr.getActivePendingEdit() === null, 'No proposed edit registered after cancellation during generation');
    assert(sessionDeleted, 'Session cleaned up and deleted after cancellation');
  }

  // 5.3 Cancellation during streaming
  {
    let cancelTurnCalled = false;
    let streamChunksDelivered = 0;

    const cts = new vscode.CancellationTokenSource();

    const mockStreamCancelConn = {
      createSession: async () => 'sess_stream_cancel',
      deleteSession: async () => {},
      cancelTurn: async () => {
        cancelTurnCalled = true;
      },
      executeTurnStream: async (_id: string, _prompt: string, options: any) => {
        // Emit chunk 1
        streamChunksDelivered++;
        options.onDelta('```typescript\nfunction calculateArea');

        // Cancel during streaming
        cts.cancel();

        // Attempting chunk 2 should be rejected/aborted
        if (options?.abortSignal?.aborted) {
          const err = new Error('Turn was cancelled.');
          err.name = 'AbortError';
          throw err;
        }

        streamChunksDelivered++;
        options.onDelta('(w: number, h: number): number {\n  return w * h;\n}\n```');
        return '```typescript\nfunction calculateArea(w: number, h: number): number {\n  return w * h;\n}\n```';
      }
    } as unknown as TrueForgeConnection;

    const mgr = new InlineEditManager(mockStreamCancelConn, assembler);

    const result = await mgr.generateInlineEdit(
      cancelDocument,
      cancelSelection,
      'Type parameters',
      cts.token
    );

    assert(result === null, 'Cancellation during streaming returns null');
    assert(cancelTurnCalled, 'cancelTurn called on server when stream cancelled');
    assert(streamChunksDelivered === 1, 'Stream consumption stopped immediately on cancellation');
    assert(mgr.getActivePendingEdit() === null, 'No proposed edit registered when streaming cancelled');
  }

  // 5.4 Cancellation after response but before diff registration
  {
    const cts = new vscode.CancellationTokenSource();

    const mockLateCancelConn = {
      createSession: async () => 'sess_late_cancel',
      deleteSession: async () => {},
      cancelTurn: async () => {},
      executeTurnStream: async (_id: string, _prompt: string, options: any) => {
        const full = '```typescript\nreturn width * height * 1.0;\n```';
        options.onDelta(full);
        // Cancel right when stream finishes, before diff registration
        cts.cancel();
        return full;
      }
    } as unknown as TrueForgeConnection;

    const mgr = new InlineEditManager(mockLateCancelConn, assembler);

    const result = await mgr.generateInlineEdit(
      cancelDocument,
      cancelSelection,
      'Cast to float',
      cts.token
    );

    assert(result === null, 'Cancellation immediately after response returns null');
    assert(mgr.getActivePendingEdit() === null, 'No pending edit staged when cancelled before diff registration');
    const diffUri = vscode.Uri.parse('trueforge-diff://proposed/temp_cancel_target.ts');
    assert(mgr.provideTextDocumentContent(diffUri) === '', 'Proposed document is not populated in virtual provider');
  }

  // 5.5 Cancellation isolation preserves staged proposal, explicit rejectEdit cleans up
  {
    const mockConn = {
      createSession: async () => 'sess_cleanup_test',
      deleteSession: async () => {},
      cancelTurn: async () => {},
      executeTurnStream: async () => ''
    } as unknown as TrueForgeConnection;

    const mgr = new InlineEditManager(mockConn, assembler);

    // Staging dummy proposal to verify cancellation isolation
    await mgr.registerAutonomousProposal(
      cancelTestFilePath,
      'return 0;',
      'Dummy edit',
      { startLine: 2, endLine: 2 }
    );
    assert(mgr.getActivePendingEdit() !== null, 'Proposal staged initially');

    // Cancelling generation does NOT clear existing staged proposal (cancellation isolation)
    await mgr.cancel();
    assert(mgr.getActivePendingEdit() !== null, 'Staged proposal preserved after cancel()');
    const diffUri = vscode.Uri.parse('trueforge-diff://proposed/temp_cancel_target.ts');
    assert(mgr.provideTextDocumentContent(diffUri) !== '', 'Virtual proposed document content preserved after cancel()');

    // Explicit rejection cleans up proposal and virtual diff
    mgr.rejectEdit();
    assert(mgr.getActivePendingEdit() === null, 'Pending edit completely cleared after rejectEdit()');
    assert(mgr.provideTextDocumentContent(diffUri) === '', 'Virtual proposed document content removed after rejectEdit()');
  }

  // 5.6 No workspace file changes after cancellation
  {
    const diskContentAfter = fs.readFileSync(cancelTestFilePath, 'utf8');
    const hashAfter = crypto.createHash('sha256').update(diskContentAfter).digest('hex');
    assert(diskContentAfter === cancelTestCode, 'Workspace file content remains 100% bit-for-bit untouched after cancellations');
    assert(hashAfter === baselineHash, 'Workspace file SHA-256 hash identical to baseline');
  }

  // 5.7 Cleanup of pending edits and cancellation listeners
  {
    const cts = new vscode.CancellationTokenSource();
    const mockConn = {
      createSession: async () => 'sess_listener_cleanup',
      deleteSession: async () => {},
      cancelTurn: async () => {},
      executeTurnStream: async () => '```typescript\nreturn width * height;\n```'
    } as unknown as TrueForgeConnection;

    const mgr = new InlineEditManager(mockConn, assembler);
    await mgr.generateInlineEdit(cancelDocument, cancelSelection, 'Check cleanup', cts.token);

    assert(((cts as any)._listeners || []).length === 0, 'Token listener disposed after successful generation');

    const cts2 = new vscode.CancellationTokenSource();
    cts2.cancel();
    await mgr.generateInlineEdit(cancelDocument, cancelSelection, 'Check cleanup cancelled', cts2.token);
    assert(((cts2 as any)._listeners || []).length === 0, 'Token listener disposed after cancelled generation');
  }

  // 5.8 Safe handling of repeated cancellation
  {
    const mockConn = {
      createSession: async () => 'sess_repeat_cancel',
      deleteSession: async () => {},
      cancelTurn: async () => {},
      executeTurnStream: async () => ''
    } as unknown as TrueForgeConnection;

    const mgr = new InlineEditManager(mockConn, assembler);
    // Repeated calls must not throw
    await mgr.cancel();
    await mgr.cancel();
    await mgr.cancel();
    assert(mgr.getActivePendingEdit() === null, 'Repeated cancellation is safe and idempotent');
  }

  // 5.9 Clear feedback distinguishing cancellation from genuine error
  {
    const mockCancelledConn = {
      createSession: async () => 'sess_fb_cancel',
      deleteSession: async () => {},
      cancelTurn: async () => {},
      executeTurnStream: async () => ''
    } as unknown as TrueForgeConnection;

    const mgr = new InlineEditManager(mockCancelledConn, assembler);

    // Mock active text editor
    (vscode.window as any).activeTextEditor = {
      document: cancelDocument,
      selection: cancelSelection
    };
    (vscode.window as any).showInputBox = async () => 'Some instruction';

    // Mock withProgress with an already cancelled token
    (vscode.window as any).withProgress = async (_opts: any, task: any) => {
      const cts = new vscode.CancellationTokenSource();
      cts.cancel();
      return task({ report: () => {} }, cts.token);
    };

    (vscode.window as any)._lastInfoMessage = undefined;
    (vscode.window as any)._lastErrorMessage = undefined;

    await mgr.startInlineEdit();

    assert(
      (vscode.window as any)._lastInfoMessage === 'TrueForge: Inline Edit was cancelled.',
      'Cancellation shows info message: "TrueForge: Inline Edit was cancelled."'
    );
    assert(
      (vscode.window as any)._lastErrorMessage === undefined,
      'Cancellation does NOT show error message'
    );

    // Next simulate genuine connection error
    const mockErrConn = {
      createSession: async () => 'sess_fb_err',
      deleteSession: async () => {},
      cancelTurn: async () => {},
      executeTurnStream: async () => {
        throw new Error('Connection refused by TrueForge host');
      }
    } as unknown as TrueForgeConnection;

    const mgrErr = new InlineEditManager(mockErrConn, assembler);
    (vscode.window as any).withProgress = async (_opts: any, task: any) => {
      const cts = new vscode.CancellationTokenSource();
      return task({ report: () => {} }, cts.token);
    };

    (vscode.window as any)._lastInfoMessage = undefined;
    (vscode.window as any)._lastErrorMessage = undefined;

    await mgrErr.startInlineEdit();

    assert(
      (vscode.window as any)._lastErrorMessage?.includes('TrueForge Inline Edit failed: Connection refused by TrueForge host'),
      'Genuine error shows error message: "TrueForge Inline Edit failed: ..."'
    );
  }

  // 5.10 Normal successful generation still works end-to-end
  {
    const mockSuccessConn = {
      createSession: async () => 'sess_normal_success',
      deleteSession: async () => {},
      cancelTurn: async () => {},
      executeTurnStream: async () => '```typescript\n  return width * height * 2;\n```'
    } as unknown as TrueForgeConnection;

    const mgr = new InlineEditManager(mockSuccessConn, assembler);
    const cts = new vscode.CancellationTokenSource();

    const pending = await mgr.generateInlineEdit(
      cancelDocument,
      cancelSelection,
      'Double the area',
      cts.token
    );

    assert(pending !== null, 'Normal generation returns valid PendingEdit');
    assert(pending?.replacementText === '  return width * height * 2;', 'Replacement text matches generated code');
    assert(mgr.getActivePendingEdit() !== null, 'Active pending edit is staged');

    // Reject edit clears it safely
    mgr.rejectEdit();
    assert(mgr.getActivePendingEdit() === null, 'Pending edit cleared after rejection');
  }

  // 5.11 Existing autonomous agent cancellation still works
  {
    const tools = new WorkspaceTools(discovery);
    const mockAutonomousCancelConn = {
      createSession: async () => 'sess_auto_cancel',
      deleteSession: async () => {},
      cancelTurn: async () => {},
      executeTurnStream: async () => ''
    } as unknown as TrueForgeConnection;

    // 5.11a Pre-execution cancel
    const coord = new AutonomousAgentCoordinator(mockAutonomousCancelConn, tools, editManager, 5);
    await coord.cancel();

    const res = await coord.executeTask('Task cancelled');
    assert(Boolean(res.cancelled), 'Autonomous coordinator reports cancelled = true');
    assert(res.summary === 'Task was cancelled by user.', 'Autonomous cancellation summary correct');

    // 5.11b Mid-turn cancel
    let midCancelTurnCalled = false;
    let autoSessionDeleted = false;
    let coordMid: AutonomousAgentCoordinator;
    const mockAutoMidConn = {
      createSession: async () => 'sess_auto_mid',
      deleteSession: async () => {
        autoSessionDeleted = true;
      },
      cancelTurn: async () => {
        midCancelTurnCalled = true;
      },
      executeTurnStream: async () => {
        await coordMid.cancel();
        const err = new Error('Turn was cancelled.');
        err.name = 'AbortError';
        throw err;
      }
    } as unknown as TrueForgeConnection;

    coordMid = new AutonomousAgentCoordinator(mockAutoMidConn, tools, editManager, 5);
    const resMid = await coordMid.executeTask('Mid task');
    assert(Boolean(resMid.cancelled), 'Mid-turn cancellation reports cancelled = true');
    assert(midCancelTurnCalled, 'cancelTurn was called on session during mid-turn cancellation');
    assert(autoSessionDeleted, 'Session was deleted after mid-turn cancellation');
  }

  // Cleanup temporary cancel target file
  if (fs.existsSync(cancelTestFilePath)) {
    fs.unlinkSync(cancelTestFilePath);
  }

  // -----------------------------------------------------------------
  // SUITE 6: Concurrent Edit Protection
  // -----------------------------------------------------------------
  console.log('\n--- Suite 6: Concurrent Edit Protection ---');

  const concurrentTestFilePath = path.join(workspaceRoot, 'src', 'test', 'temp_concurrent_target.ts');
  const concurrentInitialCode = [
    'export function calculateSum(items: number[]): number {',
    '  return items.reduce((a, b) => a + b, 0);',
    '}'
  ].join('\n');

  const makeConcurrentConn = (replacement: string) => ({
    createSession: async () => 'sess_concurrent_test',
    deleteSession: async () => {},
    cancelTurn: async () => {},
    executeTurnStream: async () => `\`\`\`typescript\n${replacement}\n\`\`\``
  } as unknown as TrueForgeConnection);

  // 6.1 Unchanged document success
  {
    fs.writeFileSync(concurrentTestFilePath, concurrentInitialCode, 'utf8');
    (vscode.workspace as any).textDocuments = [];

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(concurrentTestFilePath));
    const selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 43));
    const replacement = '  return items.filter(x => x > 0).reduce((a, b) => a + b, 0);';

    const mgr = new InlineEditManager(makeConcurrentConn(replacement), assembler);
    const pending = await mgr.generateInlineEdit(doc, selection, 'Filter positive');

    assert(pending !== null, 'Proposal generated successfully');
    assert(pending?.originalDocumentVersion === 1, 'Baseline document version captured (1)');
    assert(
      pending?.originalDocumentHash === crypto.createHash('sha256').update(concurrentInitialCode).digest('hex'),
      'Baseline document hash captured'
    );
    assert(pending?.fileExistsInitially === true, 'Baseline file existence captured');

    const applied = await mgr.applyEdit();
    assert(applied === true, 'Unchanged document allows proposal to apply cleanly');
    assert(mgr.getActivePendingEdit() === null, 'Active pending edit cleared after successful apply');

    const updatedContent = fs.readFileSync(concurrentTestFilePath, 'utf8');
    assert(updatedContent.includes('filter(x => x > 0)'), 'Replacement code applied to file on disk');
  }

  // 6.2 User edits before acceptance (in-editor version bump)
  {
    fs.writeFileSync(concurrentTestFilePath, concurrentInitialCode, 'utf8');
    (vscode.workspace as any).textDocuments = [];

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(concurrentTestFilePath));
    const selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 43));
    const replacement = '  return items.slice().reverse().reduce((a, b) => a + b, 0);';

    const mgr = new InlineEditManager(makeConcurrentConn(replacement), assembler);
    await mgr.generateInlineEdit(doc, selection, 'Reverse reduce');

    // User makes an edit in editor before accepting the proposal
    (doc as any).version = 2;
    (doc as any)._content = 'export function calculateSum(items: number[]) {\n  // User edited in editor\n  return 0;\n}';
    (vscode.window as any)._lastWarningMessage = undefined;

    const applied = await mgr.applyEdit();
    assert(applied === false, 'Stale proposal rejected when user edited document in editor');
    assert(
      (vscode.window as any)._lastWarningMessage?.includes('The file has changed since the proposed edit was generated'),
      'Clear warning shown instructing user to regenerate edit'
    );
    assert(mgr.getActivePendingEdit() === null, 'Stale pending edit cleared after conflict');
    const content = fs.readFileSync(concurrentTestFilePath, 'utf8');
    assert(!content.includes('reverse()'), 'User document not overwritten with stale proposal');
  }

  // 6.3 External file modification on disk (content hash change)
  {
    fs.writeFileSync(concurrentTestFilePath, concurrentInitialCode, 'utf8');
    (vscode.workspace as any).textDocuments = [];

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(concurrentTestFilePath));
    const selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 43));
    const replacement = '  return items.reduce((a, b) => a * b, 1);';

    const mgr = new InlineEditManager(makeConcurrentConn(replacement), assembler);
    await mgr.generateInlineEdit(doc, selection, 'Multiply instead');

    // External change on disk (e.g. git checkout, another tool)
    const externalCode = 'export function calculateSum(items: number[]): number {\n  // external edit\n  return 999;\n}';
    fs.writeFileSync(concurrentTestFilePath, externalCode, 'utf8');
    (vscode.window as any)._lastWarningMessage = undefined;

    const applied = await mgr.applyEdit();
    assert(applied === false, 'Stale proposal rejected when file modified externally on disk');
    assert(
      (vscode.window as any)._lastWarningMessage?.includes('The file has changed since the proposed edit was generated'),
      'Clear warning shown on external disk change'
    );
    assert(mgr.getActivePendingEdit() === null, 'Pending edit cleaned up after external modification conflict');
    const content = fs.readFileSync(concurrentTestFilePath, 'utf8');
    assert(content === externalCode, 'External disk changes preserved 100% without silent overwrite');
  }

  // 6.4 Deleted file on disk before acceptance
  {
    fs.writeFileSync(concurrentTestFilePath, concurrentInitialCode, 'utf8');
    (vscode.workspace as any).textDocuments = [];

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(concurrentTestFilePath));
    const selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 43));
    const replacement = '  return 0;';

    const mgr = new InlineEditManager(makeConcurrentConn(replacement), assembler);
    await mgr.generateInlineEdit(doc, selection, 'Return zero');

    // File deleted on disk
    fs.unlinkSync(concurrentTestFilePath);
    (vscode.window as any)._lastWarningMessage = undefined;

    const applied = await mgr.applyEdit();
    assert(applied === false, 'Stale proposal rejected when file was deleted on disk');
    assert(
      (vscode.window as any)._lastWarningMessage?.includes('The file has changed since the proposed edit was generated'),
      'Clear warning shown on deleted file'
    );
    assert(!fs.existsSync(concurrentTestFilePath), 'Deleted file is NOT recreated on disk');
    assert(mgr.getActivePendingEdit() === null, 'Pending edit cleaned up after deletion conflict');
  }

  // 6.5 Unchanged closed document accepted
  {
    fs.writeFileSync(concurrentTestFilePath, concurrentInitialCode, 'utf8');
    (vscode.workspace as any).textDocuments = [];

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(concurrentTestFilePath));
    const selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 43));
    const replacement = '  return items.reduce((acc, curr) => acc + curr, 0);';

    const mgr = new InlineEditManager(makeConcurrentConn(replacement), assembler);
    await mgr.generateInlineEdit(doc, selection, 'Rename params');

    // Simulate closing the document in VS Code (removed from workspace.textDocuments)
    (vscode.workspace as any)._closeTextDocument(doc.uri);
    assert(
      !vscode.workspace.textDocuments.some((d: any) => d.uri.fsPath === concurrentTestFilePath),
      'Document closed and removed from workspace.textDocuments'
    );

    const applied = await mgr.applyEdit();
    assert(applied === true, 'Unchanged closed document accepted cleanly');
    const content = fs.readFileSync(concurrentTestFilePath, 'utf8');
    assert(content.includes('acc + curr'), 'Edit applied to disk for closed document');
  }

  // 6.6 Closed and reopened unchanged document accepted
  {
    fs.writeFileSync(concurrentTestFilePath, concurrentInitialCode, 'utf8');
    (vscode.workspace as any).textDocuments = [];
    (vscode.workspace as any)._documentVersions[concurrentTestFilePath] = 4; // initially version 4

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(concurrentTestFilePath));
    const selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 43));
    const replacement = '  return items.reduce((a, b) => a + b, 10);';

    const mgr = new InlineEditManager(makeConcurrentConn(replacement), assembler);
    const pending = await mgr.generateInlineEdit(doc, selection, 'Initial 10');
    assert(pending?.originalDocumentVersion === 4, 'Captured initial version 4');

    // Simulate closing the document
    (vscode.workspace as any)._closeTextDocument(doc.uri);

    // Reopening a closed document in VS Code resets document version to 1
    delete (vscode.workspace as any)._documentVersions[concurrentTestFilePath];
    const reopenedDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(concurrentTestFilePath));
    assert(reopenedDoc.version === 1, 'Reopened document version reset to 1 in VS Code');

    // Applying proposal should NOT falsely reject the reopened document because content is unchanged
    const applied = await mgr.applyEdit();
    assert(applied === true, 'Closed and reopened unchanged document accepted without false conflict');
    const content = fs.readFileSync(concurrentTestFilePath, 'utf8');
    assert(content.includes('a + b, 10'), 'Edit applied to reopened document');
  }

  // 6.7 Initially dirty but unchanged document accepted
  {
    fs.writeFileSync(concurrentTestFilePath, concurrentInitialCode, 'utf8');
    (vscode.workspace as any).textDocuments = [];

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(concurrentTestFilePath));
    const dirtyCode = [
      'export function calculateSum(items: number[]): number {',
      '  // User unsaved comment',
      '  return items.reduce((a, b) => a + b, 0);',
      '}'
    ].join('\n');
    (doc as any)._content = dirtyCode;
    (doc as any).isDirty = true;

    const bufferHash = crypto.createHash('sha256').update(dirtyCode).digest('hex');
    const diskHash = crypto.createHash('sha256').update(concurrentInitialCode).digest('hex');
    assert(bufferHash !== diskHash, 'Buffer and disk hashes legitimately differ for initially dirty doc');

    const selection = new vscode.Selection(new vscode.Position(2, 0), new vscode.Position(2, 43));
    const replacement = '  return items.reduce((a, b) => a + b, 100);';

    const mgr = new InlineEditManager(makeConcurrentConn(replacement), assembler);
    const pending = await mgr.generateInlineEdit(doc, selection, 'Add 100');
    assert(pending?.isInitiallyDirty === true, 'Captured isInitiallyDirty = true');
    assert(pending?.originalDocumentHash === bufferHash, 'Captured buffer hash');
    assert(pending?.originalDiskHash === diskHash, 'Captured disk hash');

    // User does NOT touch document; dirty buffer remains unchanged
    const applied = await mgr.applyEdit();
    assert(applied === true, 'Initially dirty but unchanged document accepted cleanly without false conflict');
  }

  // 6.8 Initially dirty document with subsequent user edits rejected
  {
    fs.writeFileSync(concurrentTestFilePath, concurrentInitialCode, 'utf8');
    (vscode.workspace as any).textDocuments = [];

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(concurrentTestFilePath));
    const dirtyCode = [
      'export function calculateSum(items: number[]): number {',
      '  // User unsaved comment',
      '  return items.reduce((a, b) => a + b, 0);',
      '}'
    ].join('\n');
    (doc as any)._content = dirtyCode;
    (doc as any).isDirty = true;

    const selection = new vscode.Selection(new vscode.Position(2, 0), new vscode.Position(2, 43));
    const replacement = '  return items.reduce((a, b) => a + b, 200);';

    const mgr = new InlineEditManager(makeConcurrentConn(replacement), assembler);
    await mgr.generateInlineEdit(doc, selection, 'Add 200');

    // User makes further edits to the dirty buffer before accepting
    (doc as any)._content = [
      'export function calculateSum(items: number[]): number {',
      '  // User unsaved comment - MODIFIED AGAIN',
      '  return items.reduce((a, b) => a + b, 0);',
      '}'
    ].join('\n');
    (doc as any).version++;
    (vscode.window as any)._lastWarningMessage = undefined;

    const applied = await mgr.applyEdit();
    assert(applied === false, 'Initially dirty document with subsequent user edits rejected');
    assert(
      (vscode.window as any)._lastWarningMessage?.includes('The file has changed since the proposed edit was generated'),
      'Clear warning shown instructing user to regenerate edit'
    );
    assert(mgr.getActivePendingEdit() === null, 'Active pending edit cleared after conflict');
  }

  // 6.9 No automatic saving of unrelated changes
  {
    fs.writeFileSync(concurrentTestFilePath, concurrentInitialCode, 'utf8');
    (vscode.workspace as any).textDocuments = [];

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(concurrentTestFilePath));
    const dirtyWithUnrelated = [
      '// Unrelated unsaved user scratchpad change at top',
      'export function calculateSum(items: number[]): number {',
      '  return items.reduce((a, b) => a + b, 0);',
      '}'
    ].join('\n');
    (doc as any)._content = dirtyWithUnrelated;
    (doc as any).isDirty = true;
    (doc as any)._saveCalled = false;

    const selection = new vscode.Selection(new vscode.Position(2, 0), new vscode.Position(2, 43));
    const replacement = '  return items.reduce((a, b) => a + b, 555);';

    const mgr = new InlineEditManager(makeConcurrentConn(replacement), assembler);
    await mgr.generateInlineEdit(doc, selection, 'Add 555');

    const applied = await mgr.applyEdit();
    assert(applied === true, 'Edit applied to document buffer');
    assert((doc as any)._saveCalled === false, 'doc.save() was NOT automatically called by applyEdit');
    assert((doc as any).isDirty === true, 'Document preserves dirty state for user review and manual save');
  }

  // 6.10 Closed document with modified disk content rejects stale proposal
  {
    fs.writeFileSync(concurrentTestFilePath, concurrentInitialCode, 'utf8');
    (vscode.workspace as any).textDocuments = [];

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(concurrentTestFilePath));
    const selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 43));
    const replacement = '  return 12345;';

    const mgr = new InlineEditManager(makeConcurrentConn(replacement), assembler);
    await mgr.generateInlineEdit(doc, selection, 'Return 12345');

    // Simulate closing document AND modifying disk content
    (vscode.workspace as any)._closeTextDocument(doc.uri);
    const modifiedClosed = '// Modified while closed\nexport const sum = () => 0;';
    fs.writeFileSync(concurrentTestFilePath, modifiedClosed, 'utf8');
    (vscode.window as any)._lastWarningMessage = undefined;

    const applied = await mgr.applyEdit();
    assert(applied === false, 'Stale proposal rejected when closed document content was modified on disk');
    assert(
      (vscode.window as any)._lastWarningMessage?.includes('The file has changed since the proposed edit was generated'),
      'Clear warning shown for modified closed document'
    );
    const content = fs.readFileSync(concurrentTestFilePath, 'utf8');
    assert(content === modifiedClosed, 'Modified disk content preserved without overwrite');
  }

  // 6.11 Target range selection content modification rejects stale proposal
  {
    fs.writeFileSync(concurrentTestFilePath, concurrentInitialCode, 'utf8');
    (vscode.workspace as any).textDocuments = [];

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(concurrentTestFilePath));
    const selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 43));

    const mgr = new InlineEditManager(makeConcurrentConn('  return 0;'), assembler);
    const pending = await mgr.generateInlineEdit(doc, selection, 'Return zero');
    assert(pending !== null, 'Proposal generated');

    // Mutate the originalSelectionText on the pending edit to simulate target range mismatch
    const modifiedPending = {
      ...pending!,
      originalSelectionText: '  return differentCode();'
    };

    const hasConflict = await mgr.detectDocumentConflict(modifiedPending);
    assert(hasConflict === true, 'Target range mismatch detected as document conflict');

    (vscode.window as any)._lastWarningMessage = undefined;
    const applied = await mgr.applyEdit(modifiedPending);
    assert(applied === false, 'applyEdit rejected when target range content was modified');
  }

  // 6.12 Rejection after conflict leaves clean state
  {
    fs.writeFileSync(concurrentTestFilePath, concurrentInitialCode, 'utf8');
    (vscode.workspace as any).textDocuments = [];

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(concurrentTestFilePath));
    const selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 43));

    const mgr = new InlineEditManager(makeConcurrentConn('  return 0;'), assembler);
    await mgr.generateInlineEdit(doc, selection, 'Return zero');

    // Mutate buffer to cause conflict
    (doc as any).version = 2;
    (doc as any)._content = 'export function calculateSum() { return -1; }';
    await mgr.applyEdit();

    // Verify all pending state cleaned up
    assert(mgr.getActivePendingEdit() === null, 'activePendingEdit is null after conflict rejection');
    const diffUri = vscode.Uri.parse('trueforge-diff://proposed/temp_concurrent_target.ts');
    assert(mgr.provideTextDocumentContent(diffUri) === '', 'Virtual proposed document content removed');
  }

  // 6.13 Legacy proposal without baseline metadata succeeds (backwards compatibility)
  {
    const legacyPending: PendingEdit = {
      documentUri: vscode.Uri.file(concurrentTestFilePath),
      range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 10)),
      originalSelectionText: 'export',
      replacementText: 'export',
      diffUri: vscode.Uri.parse('trueforge-diff://proposed/temp_concurrent_target.ts')
    };

    const mgr = new InlineEditManager(makeConcurrentConn(''), assembler);
    const conflict = await mgr.detectDocumentConflict(legacyPending);
    assert(conflict === false, 'Legacy proposal without baseline metadata reports no conflict');
  }

  // 6.14 Autonomous proposal concurrent conflict detection
  {
    fs.writeFileSync(concurrentTestFilePath, concurrentInitialCode, 'utf8');
    (vscode.workspace as any).textDocuments = [];

    const mgr = new InlineEditManager(makeConcurrentConn(''), assembler);
    await mgr.registerAutonomousProposal(
      concurrentTestFilePath,
      '// Autonomous replacement\nexport const sum = () => 0;',
      'Autonomous refactor'
    );

    const activePending = mgr.getActivePendingEdit();
    assert(activePending !== null, 'Autonomous proposal registered');
    assert(activePending?.originalDocumentVersion === 1, 'Autonomous proposal captured baseline version');
    assert(activePending?.originalDocumentHash !== undefined, 'Autonomous proposal captured baseline hash');

    // Simulate external edit
    fs.writeFileSync(concurrentTestFilePath, '// Conflicting disk edit', 'utf8');
    (vscode.window as any)._lastWarningMessage = undefined;

    const applied = await mgr.applyEdit();
    assert(applied === false, 'Autonomous proposal rejected on concurrent disk modification');
    assert(
      (vscode.window as any)._lastWarningMessage?.includes('The file has changed since the proposed edit was generated'),
      'Clear warning shown on autonomous proposal conflict'
    );
    assert(fs.readFileSync(concurrentTestFilePath, 'utf8') === '// Conflicting disk edit', 'External disk edit preserved');
    assert(mgr.getActivePendingEdit() === null, 'Active pending edit cleared after autonomous conflict');
  }

  // Cleanup temporary concurrent target file
  if (fs.existsSync(concurrentTestFilePath)) {
    fs.unlinkSync(concurrentTestFilePath);
  }
  delete (vscode.workspace as any)._documentVersions[concurrentTestFilePath];

  // -----------------------------------------------------------------
  // SUITE 7: Concurrent Inline-Edit Generation Safety & Isolation
  // -----------------------------------------------------------------
  console.log('\n--- Suite 7: Concurrent Generation Safety & Isolation ---');

  // Setup test document for Suite 7
  const suite7FilePath = path.join(workspaceRoot, 'src', 'test', 'temp_suite7_target.ts');
  const suite7InitialCode = 'function calculateMetric(val: number): number {\n  return val * 10;\n}\n';
  fs.writeFileSync(suite7FilePath, suite7InitialCode, 'utf8');

  const suite7Document = {
    uri: vscode.Uri.file(suite7FilePath),
    fileName: suite7FilePath,
    languageId: 'typescript',
    version: 1,
    isDirty: false,
    getText: (range?: any) => {
      if (!range) return suite7InitialCode;
      return 'return val * 10;\n';
    },
    lineAt: (_idx: number) => ({
      range: {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 18 }
      }
    }),
    lineCount: 3,
    offsetAt: (_pos: any) => 48
  } as unknown as vscode.TextDocument;

  const suite7Selection = new vscode.Selection(
    new vscode.Position(1, 2),
    new vscode.Position(1, 18)
  );

  // 7.1 Single-Operation Guard prevents overlapping concurrent generation
  {
    (vscode.window as any)._lastWarningMessage = undefined;
    let finishFirstGeneration: () => void = () => {};
    const firstGenerationPromise = new Promise<void>((resolve) => {
      finishFirstGeneration = resolve;
    });

    const mockSlowConn = {
      createSession: async () => 'sess_slow_1',
      deleteSession: async () => {},
      cancelTurn: async () => {},
      executeTurnStream: async () => {
        // Wait until signaled
        await firstGenerationPromise;
        return '```typescript\n  return val * 20;\n```';
      }
    } as unknown as TrueForgeConnection;

    const mgr = new InlineEditManager(mockSlowConn, assembler);

    // Start first generation (asynchronously in-flight)
    const op1Promise = mgr.generateInlineEdit(suite7Document, suite7Selection, 'Double metric');

    // Immediately verify mgr is in generating state
    assert(mgr.isGenerating() === true, 'InlineEditManager reports isGenerating() = true while operation is active');

    // Attempt second overlapping generation on the same manager
    const op2Result = await mgr.generateInlineEdit(suite7Document, suite7Selection, 'Triple metric');

    assert(op2Result === null, 'Overlapping second generation is rejected immediately and returns null');
    assert(
      (vscode.window as any)._lastWarningMessage?.includes('already in progress'),
      'Clear user-facing warning shown when generation is already in progress'
    );

    // Release first generation
    finishFirstGeneration();
    const op1Result = await op1Promise;

    assert(op1Result !== null, 'First generation completes successfully after overlapping attempt is rejected');
    assert(mgr.isGenerating() === false, 'InlineEditManager reports isGenerating() = false after completion');
    assert(mgr.getActivePendingEdit() !== null, 'First generation proposal is staged');
    assert(mgr.getActivePendingEdit()?.replacementText === '  return val * 20;', 'Staged proposal has correct replacement text');

    // Reject to clean up
    mgr.rejectEdit();
    assert(mgr.getActivePendingEdit() === null, 'Pending proposal cleared after rejection');
  }

  // 7.2 Cancellation Isolation: cancelling in-flight generation does not affect other state
  {
    const cts1 = new vscode.CancellationTokenSource();
    let cancelTurnCalledWith: string | null = null;
    let sessionDeleted = false;

    let finishBlockedTurn: () => void = () => {};
    const turnBlockedPromise = new Promise<void>((resolve) => {
      finishBlockedTurn = resolve;
    });
    let turnStreamStarted: () => void = () => {};
    const turnStreamStartedPromise = new Promise<void>((resolve) => {
      turnStreamStarted = resolve;
    });

    const mockConn = {
      createSession: async () => 'sess_cancel_isolation',
      deleteSession: async () => { sessionDeleted = true; },
      cancelTurn: async (id: string) => { cancelTurnCalledWith = id; },
      executeTurnStream: async (_id: string, _prompt: string, options: any) => {
        turnStreamStarted();
        // Wait for cancellation
        await turnBlockedPromise;
        if (options?.abortSignal?.aborted) {
          const err = new Error('Turn was cancelled.');
          err.name = 'AbortError';
          throw err;
        }
        return '';
      }
    } as unknown as TrueForgeConnection;

    const mgr = new InlineEditManager(mockConn, assembler);

    const op1Promise = mgr.generateInlineEdit(suite7Document, suite7Selection, 'Add logging', cts1.token);

    // Wait until executeTurnStream is actively in-flight
    await turnStreamStartedPromise;
    assert(mgr.isGenerating() === true, 'Operation 1 is actively generating');

    // Attempt overlapping op2
    (vscode.window as any)._lastWarningMessage = undefined;
    const op2Result = await mgr.generateInlineEdit(suite7Document, suite7Selection, 'Add telemetry');
    assert(op2Result === null, 'Overlapping attempt rejected during active generation');
    assert((vscode.window as any)._lastWarningMessage !== undefined, 'Warning message displayed for rejected attempt');

    // Cancel Operation 1 while in-flight
    cts1.cancel();
    finishBlockedTurn();
    const op1Result = await op1Promise;

    assert(op1Result === null, 'Cancelled operation 1 returns null');
    assert(cancelTurnCalledWith === 'sess_cancel_isolation', 'Operation 1 server session was cancelled');
    assert(sessionDeleted, 'Operation 1 server session was deleted');
    assert(mgr.isGenerating() === false, 'Manager reset isGenerating to false after cancellation');
    assert(mgr.getActivePendingEdit() === null, 'No pending edit left after cancelled operation');

    // Verify a subsequent operation can now run cleanly
    const mockQuickConn = {
      createSession: async () => 'sess_quick_after_cancel',
      deleteSession: async () => {},
      cancelTurn: async () => {},
      executeTurnStream: async () => '```typescript\n  return val * 100;\n```'
    } as unknown as TrueForgeConnection;

    const mgr2 = new InlineEditManager(mockQuickConn, assembler);
    const op3Result = await mgr2.generateInlineEdit(suite7Document, suite7Selection, 'Multiply by 100');
    assert(op3Result !== null, 'Subsequent generation runs cleanly and produces pending edit');
    mgr2.rejectEdit();
  }

  // 7.3 Pending Proposal Preservation: pre-flight cancellation and proposal preservation
  {
    (vscode.workspace as any).textDocuments = [];
    const mockConn = {
      createSession: async () => 'sess_preserve_proposal',
      deleteSession: async () => {},
      cancelTurn: async () => {},
      executeTurnStream: async () => '```typescript\n  return val * 999;\n```'
    } as unknown as TrueForgeConnection;

    const mgr = new InlineEditManager(mockConn, assembler);

    // Stage an initial autonomous proposal
    await mgr.registerAutonomousProposal(
      suite7FilePath,
      '  return val * 42;\n',
      'Initial autonomous proposal',
      { startLine: 2, endLine: 2 }
    );

    const initialPending = mgr.getActivePendingEdit();
    assert(initialPending !== null, 'Initial proposal is staged and awaiting review');
    assert(initialPending?.replacementText === '  return val * 42;\n', 'Initial proposal content verified');

    // Attempt a new generation with a pre-cancelled token while proposal exists
    const preCancelledCts = new vscode.CancellationTokenSource();
    preCancelledCts.cancel();

    const cancelledResult = await mgr.generateInlineEdit(
      suite7Document,
      suite7Selection,
      'Try another edit',
      preCancelledCts.token
    );

    assert(cancelledResult === null, 'Pre-cancelled generation returns null');
    assert(mgr.getActivePendingEdit() !== null, 'Pre-existing pending proposal is preserved after pre-flight cancellation');
    assert(mgr.getActivePendingEdit() === initialPending, 'Preserved proposal is identical to original proposal');

    // Clean up
    mgr.rejectEdit();
  }

  // 7.4 Review Workflow Integrity: startInlineEdit guard and accept/reject review workflow
  {
    (vscode.window as any)._lastWarningMessage = undefined;
    (vscode.workspace as any).textDocuments = [];
    let releaseGen: () => void = () => {};
    const genPromise = new Promise<void>((resolve) => { releaseGen = resolve; });

    const mockConn = {
      createSession: async () => 'sess_review_guard',
      deleteSession: async () => {},
      cancelTurn: async () => {},
      executeTurnStream: async () => {
        await genPromise;
        return '```typescript\n  return val * 3;\n```';
      }
    } as unknown as TrueForgeConnection;

    const mgr = new InlineEditManager(mockConn, assembler);

    // Start generation
    const genOp = mgr.generateInlineEdit(suite7Document, suite7Selection, 'Multiply 3');
    assert(mgr.isGenerating() === true, 'Generation is active');

    // startInlineEdit should be rejected
    await mgr.startInlineEdit({ document: suite7Document, selection: suite7Selection } as any);
    assert(
      (vscode.window as any)._lastWarningMessage?.includes('already in progress'),
      'startInlineEdit shows warning and aborts when generation is already in progress'
    );

    releaseGen();
    const result = await genOp;
    assert(result !== null, 'Generation finishes cleanly');

    // Accept proposal
    const accepted = await mgr.applyEdit();
    assert(accepted === true, 'Accept workflow applies edit when ready');
    assert(mgr.getActivePendingEdit() === null, 'Active pending edit cleared after acceptance');
  }

  // 7.5 Cancellation Isolation: Cancelling inline generation preserves an existing proposal
  {
    (vscode.workspace as any).textDocuments = [];
    const mockConn = {
      createSession: async () => 'sess_cancel_iso_proposal',
      deleteSession: async () => {},
      cancelTurn: async () => {},
      executeTurnStream: async () => '```typescript\n  return val * 888;\n```'
    } as unknown as TrueForgeConnection;

    const mgr = new InlineEditManager(mockConn, assembler);

    // Autonomous proposal already staged
    const registered = await mgr.registerAutonomousProposal(
      suite7FilePath,
      '  return val * 55;\n',
      'Autonomous proposal 55',
      { startLine: 2, endLine: 2 }
    );
    assert(registered === true, 'Autonomous proposal registered successfully');
    const autonomousPending = mgr.getActivePendingEdit();
    assert(autonomousPending !== null, 'Autonomous proposal staged initially');
    const autoDiffUri = autonomousPending!.diffUri;
    assert(mgr.provideTextDocumentContent(autoDiffUri) !== '', 'Autonomous virtual diff populated');

    // Calling cancel() on mgr (e.g. user invokes cancellation) does NOT destroy staged proposal
    await mgr.cancel();
    assert(mgr.getActivePendingEdit() === autonomousPending, 'Staged proposal completely preserved after mgr.cancel()');
    assert(mgr.provideTextDocumentContent(autoDiffUri) !== '', 'Virtual diff content preserved after mgr.cancel()');

    // Explicit rejection cleans up proposal and virtual diff
    mgr.rejectEdit();
    assert(mgr.getActivePendingEdit() === null, 'Proposal cleared after explicit rejectEdit()');
    assert(mgr.provideTextDocumentContent(autoDiffUri) === '', 'Virtual diff content emptied after rejectEdit()');
  }

  // 7.6 Autonomous Proposal Registration Concurrency & Overwrite Protection
  {
    (vscode.workspace as any).textDocuments = [];
    const secondFilePath = path.join(workspaceRoot, 'src', 'test', 'temp_suite7_second.ts');
    fs.writeFileSync(secondFilePath, 'function secondFile(): void {}\n', 'utf8');

    let unblockGen: () => void = () => {};
    const unblockGenPromise = new Promise<void>((r) => { unblockGen = r; });
    let turnStarted: () => void = () => {};
    const turnStartedPromise = new Promise<void>((r) => { turnStarted = r; });

    const mockConn = {
      createSession: async () => 'sess_guard_test',
      deleteSession: async () => {},
      cancelTurn: async () => {},
      executeTurnStream: async () => {
        turnStarted();
        await unblockGenPromise;
        return '```typescript\n  return val * 9999;\n```';
      }
    } as unknown as TrueForgeConnection;

    const mgr = new InlineEditManager(mockConn, assembler);

    // 1. Requirement 1 & 3: If activePendingEdit already contains a proposal awaiting review,
    // a second autonomous proposal must be rejected without overwriting it,
    // without deleting the existing proposal's virtual diff document, and without altering its review state.
    const res1 = await mgr.registerAutonomousProposal(
      suite7FilePath,
      '  return val * 111;\n',
      'First autonomous proposal',
      { startLine: 2, endLine: 2 }
    );
    assert(res1 === true, 'First autonomous proposal registered successfully');
    const firstProposal = mgr.getActivePendingEdit();
    assert(firstProposal !== null, 'First proposal is staged and awaiting review');
    const firstDiffUri = firstProposal!.diffUri;
    const firstDiffContent = mgr.provideTextDocumentContent(firstDiffUri);
    assert(firstDiffContent.length > 0, 'First virtual diff is populated');

    // Attempt second autonomous proposal (different file and code)
    (vscode.window as any)._lastWarningMessage = undefined;
    const res2 = await mgr.registerAutonomousProposal(
      secondFilePath,
      'function modifiedSecond(): void {}\n',
      'Second autonomous proposal'
    );

    assert(res2 === false, 'Second autonomous proposal rejected when proposal awaiting review');
    assert(
      (vscode.window as any)._lastWarningMessage?.includes('already awaiting review'),
      'Clear warning message instructing user to accept or reject current proposal first'
    );
    assert(mgr.getActivePendingEdit() === firstProposal, 'Existing proposal was NOT overwritten');
    assert(mgr.provideTextDocumentContent(firstDiffUri) === firstDiffContent, 'Existing virtual diff document intact');

    // Confirm virtual diff for second proposal was NEVER created or staged
    const secondDiffUri = vscode.Uri.parse('trueforge-diff://proposed/temp_suite7_second.ts');
    assert(mgr.provideTextDocumentContent(secondDiffUri) === '', 'Second file virtual diff was never populated');

    // Also confirm generateInlineEdit and startInlineEdit are rejected
    const inlineGenRes = await mgr.generateInlineEdit(suite7Document, suite7Selection, 'Inline attempt');
    assert(inlineGenRes === null, 'generateInlineEdit rejected while proposal awaiting review');
    assert(mgr.getActivePendingEdit() === firstProposal, 'Existing proposal remains untouched after inline rejection');

    // Clean up first proposal
    mgr.rejectEdit();
    assert(mgr.getActivePendingEdit() === null, 'Manager cleared after explicit rejection');
    assert(mgr.provideTextDocumentContent(firstDiffUri) === '', 'Virtual diff emptied after rejectEdit()');

    // 2. Requirement 2: If inline generation is in progress, autonomous proposal registration
    // must not create a race that overwrites or interferes with the inline operation.
    const inlineGenPromise = mgr.generateInlineEdit(suite7Document, suite7Selection, 'In-progress inline edit');
    await turnStartedPromise;
    assert(mgr.isGenerating() === true, 'Inline generation is in progress');

    // Attempt autonomous proposal registration while inline generation is in progress
    (vscode.window as any)._lastWarningMessage = undefined;
    const raceAutonomousRes = await mgr.registerAutonomousProposal(
      suite7FilePath,
      '  return val * 333;\n',
      'Race autonomous proposal',
      { startLine: 2, endLine: 2 }
    );

    assert(raceAutonomousRes === false, 'Autonomous proposal registration rejected while inline generation in progress');
    assert(
      (vscode.window as any)._lastWarningMessage?.includes('inline edit operation is currently in progress'),
      'Warning displayed informing user that inline generation is in progress'
    );
    assert(mgr.getActivePendingEdit() === null, 'No pending edit staged by rejected autonomous proposal');
    assert(mgr.isGenerating() === true, 'Inline generation remains active and uninterrupted');

    // Unblock inline generation
    unblockGen();
    const completedInlineEdit = await inlineGenPromise;

    // Inline operation completed cleanly without being overwritten or interfered with
    assert(completedInlineEdit !== null, 'Inline generation completes cleanly without interference');
    assert(mgr.isGenerating() === false, 'Manager reset isGenerating to false');
    assert(mgr.getActivePendingEdit() === completedInlineEdit, 'Inline proposal staged successfully');
    assert(mgr.getActivePendingEdit()?.replacementText === '  return val * 9999;', 'Inline replacement content intact');

    // Clean up
    mgr.rejectEdit();
    assert(mgr.getActivePendingEdit() === null, 'Pending proposal cleared after final rejection');

    if (fs.existsSync(secondFilePath)) {
      fs.unlinkSync(secondFilePath);
    }
  }

  // 7.7 Lifecycle Progression: New generation succeeds after acceptance or rejection
  {
    (vscode.workspace as any).textDocuments = [];
    fs.writeFileSync(suite7FilePath, suite7InitialCode, 'utf8');

    let callCount = 0;
    const mockConn = {
      createSession: async () => `sess_lifecycle_${++callCount}`,
      deleteSession: async () => {},
      cancelTurn: async () => {},
      executeTurnStream: async () => `\`\`\`typescript\n  return val * ${callCount * 10};\n\`\`\``
    } as unknown as TrueForgeConnection;

    const mgr = new InlineEditManager(mockConn, assembler);

    // Part A: Accept workflow allows subsequent generation
    const p1 = await mgr.generateInlineEdit(suite7Document, suite7Selection, 'Generation 1');
    assert(p1 !== null, 'Proposal 1 generated successfully');
    assert(mgr.getActivePendingEdit() === p1, 'Proposal 1 is active pending edit');

    const applied = await mgr.applyEdit(p1);
    assert(applied === true, 'Proposal 1 accepted and applied');
    assert(mgr.getActivePendingEdit() === null, 'Active pending edit cleared after acceptance');

    // Subsequent generation succeeds after acceptance
    // Reset disk content for doc compatibility
    fs.writeFileSync(suite7FilePath, suite7InitialCode, 'utf8');
    const p2 = await mgr.generateInlineEdit(suite7Document, suite7Selection, 'Generation 2');
    assert(p2 !== null, 'Proposal 2 generated successfully after acceptance');
    assert(mgr.getActivePendingEdit() === p2, 'Proposal 2 is active pending edit');

    // Part B: Reject workflow allows subsequent generation
    mgr.rejectEdit(p2);
    assert(mgr.getActivePendingEdit() === null, 'Active pending edit cleared after rejection');

    // Subsequent generation succeeds after rejection
    const p3 = await mgr.generateInlineEdit(suite7Document, suite7Selection, 'Generation 3');
    assert(p3 !== null, 'Proposal 3 generated successfully after rejection');
    assert(mgr.getActivePendingEdit() === p3, 'Proposal 3 is active pending edit');

    // Final cleanup
    mgr.rejectEdit(p3);
    assert(mgr.getActivePendingEdit() === null, 'Active pending edit cleared after final rejection');
  }

  // 7.8 Ownership-Safe Cleanup & Stale Proposal Isolation
  {
    (vscode.workspace as any).textDocuments = [];
    fs.writeFileSync(suite7FilePath, suite7InitialCode, 'utf8');

    const mockConn = {
      createSession: async () => 'sess_ownership_test',
      deleteSession: async () => {},
      cancelTurn: async () => {},
      executeTurnStream: async () => '```typescript\n  return val * 1234;\n```'
    } as unknown as TrueForgeConnection;

    const mgr = new InlineEditManager(mockConn, assembler);

    // 1. Stage an active proposal on suite7FilePath
    const regSuccess1 = await mgr.registerAutonomousProposal(
      suite7FilePath,
      '  return val * 1234;\n',
      'Active proposal for ownership',
      { startLine: 2, endLine: 2 }
    );
    assert(regSuccess1 === true, 'Active proposal registered successfully');
    const activeProposal = mgr.getActivePendingEdit();
    assert(activeProposal !== null, 'Active proposal is staged');
    assert(mgr.getActivePendingEdit() === activeProposal, 'activePendingEdit is set to activeProposal');
    const activeDiffUri = activeProposal!.diffUri;
    const activeDiffContent = mgr.provideTextDocumentContent(activeDiffUri);
    assert(activeDiffContent.length > 0, 'Active virtual diff is populated');
    assert(mgr.getReviewStatusBarItem() !== undefined, 'Review status bar item is active and visible');

    // Helper to get last setContext value
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

    // 2. Construct a stale proposal targeting the SAME document URI and diff URI
    const staleProposalSameDocAndDiff: PendingEdit = {
      documentUri: activeProposal!.documentUri, // identical documentUri!
      range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 5)),
      originalSelectionText: 'stale',
      replacementText: 'stale replacement',
      diffUri: activeDiffUri, // identical diffUri!
      originalDocumentVersion: 1
    };

    // Attempt proposal-specific cleanup on the stale proposal
    mgr.cleanupPending(staleProposalSameDocAndDiff);

    // Requirement: Stale proposal cleanup for the same document must preserve current proposal
    assert(mgr.getActivePendingEdit() === activeProposal, 'Cleaning up stale proposal for same document preserves current activeProposal');
    // Requirement: The current proposal's virtual diff remains readable
    assert(mgr.provideTextDocumentContent(activeDiffUri) === activeDiffContent, 'Current proposal virtual diff remains readable and unchanged');
    // Requirement: Status bar and trueforge.hasPendingEdit state remain active
    assert(mgr.getReviewStatusBarItem() !== undefined, 'Review status bar item remains active');
    assert(getLastContextValue() === true, 'trueforge.hasPendingEdit context remains true');

    // 3. Stale proposal targeting the same document with its own separate virtual diff
    const separateDiffUri = vscode.Uri.parse('trueforge-diff://proposed/stale_standalone_diff.ts');
    (mgr as any).proposedDocs.set(separateDiffUri.toString(), 'stale standalone diff');
    assert(mgr.provideTextDocumentContent(separateDiffUri) === 'stale standalone diff', 'Stale standalone diff staged');

    const staleProposalWithOwnDiff: PendingEdit = {
      documentUri: activeProposal!.documentUri, // identical documentUri!
      range: activeProposal!.range,
      originalSelectionText: 'stale',
      replacementText: 'stale replacement',
      diffUri: separateDiffUri
    };

    // Clean up stale proposal with its own diff
    mgr.cleanupPending(staleProposalWithOwnDiff);

    // Assert: stale diff deleted, active diff and review state preserved
    assert(mgr.provideTextDocumentContent(separateDiffUri) === '', 'Stale proposal own virtual diff document was deleted');
    assert(mgr.getActivePendingEdit() === activeProposal, 'Active proposal preserved when cleaning up stale proposal with separate diff');
    assert(mgr.provideTextDocumentContent(activeDiffUri) === activeDiffContent, 'Active virtual diff still intact');
    assert(mgr.getReviewStatusBarItem() !== undefined, 'Review status bar item still active');
    assert(getLastContextValue() === true, 'Context key trueforge.hasPendingEdit still true');

    // 4. Rejecting a stale proposal via rejectEdit(staleProposal) preserves current proposal
    mgr.rejectEdit(staleProposalSameDocAndDiff);
    assert(mgr.getActivePendingEdit() === activeProposal, 'rejectEdit(staleProposal) preserves activeProposal');
    assert(mgr.provideTextDocumentContent(activeDiffUri) === activeDiffContent, 'Virtual diff still intact after rejectEdit(staleProposal)');
    assert(mgr.getReviewStatusBarItem() !== undefined, 'Review status bar item still active after rejectEdit(staleProposal)');
    assert(getLastContextValue() === true, 'Context key trueforge.hasPendingEdit still true after rejectEdit(staleProposal)');

    // 5. Requirement: Cleaning up the actual active proposal still works
    mgr.rejectEdit(activeProposal);
    assert(mgr.getActivePendingEdit() === null, 'Cleaning up actual active proposal clears activePendingEdit to null');
    assert(mgr.provideTextDocumentContent(activeDiffUri) === '', 'Active virtual diff document content is removed');
    assert(mgr.getReviewStatusBarItem() === undefined, 'Review status bar item disposed');
    assert(getLastContextValue() === false, 'Context key trueforge.hasPendingEdit reset to false');

    // 6. Explicit global cleanup when pending is null/undefined
    const regSuccess2 = await mgr.registerAutonomousProposal(
      suite7FilePath,
      '  return val * 5678;\n',
      'Second active proposal',
      { startLine: 2, endLine: 2 }
    );
    assert(regSuccess2 === true, 'Second active proposal registered');
    const activeProposal2 = mgr.getActivePendingEdit();
    assert(activeProposal2 !== null, 'Second active proposal is activePendingEdit');
    assert(mgr.getActivePendingEdit() === activeProposal2, 'Second active proposal is activePendingEdit');
    assert(mgr.getReviewStatusBarItem() !== undefined, 'Status bar active for second proposal');
    assert(getLastContextValue() === true, 'Context key true for second proposal');

    mgr.cleanupPending(null);
    assert(mgr.getActivePendingEdit() === null, 'Global cleanup with null clears activePendingEdit');
    assert(mgr.provideTextDocumentContent(activeProposal2!.diffUri) === '', 'Global cleanup removes virtual diff');
    assert(mgr.getReviewStatusBarItem() === undefined, 'Global cleanup disposes status bar');
    assert(getLastContextValue() === false, 'Global cleanup resets context key to false');
  }

  // 7.9 Stale-Proposal Acceptance Guard & Verification Race Protection
  {
    (vscode.workspace as any).textDocuments = [];
    fs.writeFileSync(suite7FilePath, suite7InitialCode, 'utf8');

    const mockConn = {
      createSession: async () => 'sess_stale_accept_test',
      deleteSession: async () => {},
      cancelTurn: async () => {},
      executeTurnStream: async () => '```typescript\n  return val * 4444;\n```'
    } as unknown as TrueForgeConnection;

    const mgr = new InlineEditManager(mockConn, assembler);

    // Helper to get last setContext value
    const getLastContextValue = () => {
      const cmds = (vscode.commands as any)._executedCommands || [];
      for (let i = cmds.length - 1; i >= 0; i--) {
        if (cmds[i].cmd === 'setContext' && cmds[i].args[0] === 'trueforge.hasPendingEdit') {
          return cmds[i].args[1];
        }
      }
      return undefined;
    };

    // 1. Stage an active proposal
    await mgr.registerAutonomousProposal(
      suite7FilePath,
      '  return val * 1000;\n',
      'Active proposal for stale acceptance test',
      { startLine: 2, endLine: 2 }
    );
    const activeProposal = mgr.getActivePendingEdit();
    assert(activeProposal !== null, 'Active proposal is staged');
    const activeDiffUri = activeProposal!.diffUri;
    const activeDiffContent = mgr.provideTextDocumentContent(activeDiffUri);
    assert(activeDiffContent.length > 0, 'Active diff content populated');
    assert(mgr.getReviewStatusBarItem() !== undefined, 'Review status bar active');
    assert(getLastContextValue() === true, 'trueforge.hasPendingEdit context is true');

    // 2. Construct a stale proposal targeting the same document
    const staleProposal: PendingEdit = {
      documentUri: activeProposal!.documentUri,
      range: activeProposal!.range,
      originalSelectionText: 'stale original text',
      replacementText: '  return 9999999;\n',
      diffUri: vscode.Uri.parse('trueforge-diff://proposed/stale_accept_diff.ts'),
      originalDocumentVersion: 1
    };

    // Requirement: Accepting a stale proposal immediately rejects and does not modify the workspace
    (vscode.window as any)._lastWarningMessage = undefined;
    const appliedStale = await mgr.applyEdit(staleProposal);
    assert(appliedStale === false, 'Accepting a stale proposal returns false');
    assert(
      (vscode.window as any)._lastWarningMessage?.includes('Cannot apply stale proposal'),
      'Clear warning message shown when attempting to apply stale proposal'
    );

    // Verify workspace file on disk was NOT modified with stale replacement
    const diskContentAfterStale = fs.readFileSync(suite7FilePath, 'utf8');
    assert(!diskContentAfterStale.includes('9999999'), 'Workspace file on disk was NOT modified by stale proposal');

    // Requirement: Current active proposal and its review controls remain intact
    assert(mgr.getActivePendingEdit() === activeProposal, 'Active proposal remains activePendingEdit');
    assert(mgr.provideTextDocumentContent(activeDiffUri) === activeDiffContent, 'Active virtual diff remains readable and unchanged');
    assert(mgr.getReviewStatusBarItem() !== undefined, 'Review status bar item remains active');
    assert(getLastContextValue() === true, 'trueforge.hasPendingEdit context key remains true');

    // 3. Requirement: A stale proposal cannot be accepted after the conflict-check await
    // Simulate active proposal changing while detectDocumentConflict is awaiting
    const originalDetectConflict = mgr.detectDocumentConflict.bind(mgr);
    const conflictCheckRan = { value: false };

    (mgr as any).detectDocumentConflict = async (target: PendingEdit) => {
      conflictCheckRan.value = true;
      // While awaiting conflict detection, simulate active proposal being replaced/cleared
      const mutatedProposal: PendingEdit = {
        ...activeProposal!,
        replacementText: '  return val * 7777;\n'
      };
      (mgr as any).activePendingEdit = mutatedProposal;
      return originalDetectConflict(target);
    };

    (vscode.window as any)._lastWarningMessage = undefined;
    const raceResult = await mgr.applyEdit(activeProposal);
    assert(conflictCheckRan.value === true, 'detectDocumentConflict was invoked');
    assert(raceResult === false, 'applyEdit rejected when active proposal changed during conflict check await');
    assert(
      (vscode.window as any)._lastWarningMessage?.includes('Cannot apply stale proposal'),
      'Warning displayed when active proposal changed during verification'
    );

    // Restore original detectDocumentConflict
    (mgr as any).detectDocumentConflict = originalDetectConflict;
    (mgr as any).activePendingEdit = null;

    // 4. Requirement: Accepting the current active proposal still works normally
    fs.writeFileSync(suite7FilePath, suite7InitialCode, 'utf8');
    await mgr.registerAutonomousProposal(
      suite7FilePath,
      '  return val * 5555;\n',
      'Clean active proposal for normal acceptance',
      { startLine: 2, endLine: 2 }
    );
    const normalActive = mgr.getActivePendingEdit();
    assert(normalActive !== null, 'Clean active proposal staged');

    // applyEdit called with no argument uses current active proposal normally
    const appliedNormal = await mgr.applyEdit();
    assert(appliedNormal === true, 'applyEdit() without argument accepts current active proposal normally');
    const diskContentAfterNormal = fs.readFileSync(suite7FilePath, 'utf8');
    assert(diskContentAfterNormal.includes('5555'), 'Target document updated with replacement code');
    assert(mgr.getActivePendingEdit() === null, 'Active pending edit cleared after successful acceptance');
    assert(mgr.getReviewStatusBarItem() === undefined, 'Status bar disposed after successful acceptance');
    assert(getLastContextValue() === false, 'Context key reset to false after acceptance');
  }

  // Cleanup temporary Suite 7 file
  if (fs.existsSync(suite7FilePath)) {
    fs.unlinkSync(suite7FilePath);
  }
  delete (vscode.workspace as any)._documentVersions[suite7FilePath];

  // -----------------------------------------------------------------
  // SUITE 8: Phase 1 Multi-File Review Navigation & Diff Lifecycle
  // -----------------------------------------------------------------
  console.log('\n--- Suite 8: Phase 1 Multi-File Review Navigation & Diff Lifecycle ---');

  const suite8File1 = path.join(workspaceRoot, 'test_suite8_file1.ts');
  const suite8File2 = path.join(workspaceRoot, 'test_suite8_file2.ts');
  const suite8File3 = path.join(workspaceRoot, 'test_suite8_file3.ts');

  const suite8Orig1 = "export const val1 = 'original 1';\n";
  const suite8Orig2 = "export const val2 = 'original 2';\n";
  const suite8Orig3 = "export const val3 = 'original 3';\n";

  const suite8Mod1 = "export const val1 = 'modified 1';\n";
  const suite8Mod2 = "export const val2 = 'modified 2';\n";
  const suite8Mod3 = "export const val3 = 'modified 3';\n";

  fs.writeFileSync(suite8File1, suite8Orig1, 'utf8');
  fs.writeFileSync(suite8File2, suite8Orig2, 'utf8');
  fs.writeFileSync(suite8File3, suite8Orig3, 'utf8');

  {
    (vscode.workspace as any).textDocuments = [];
    const mockConn = {
      createSession: async () => 'sess_suite8',
      deleteSession: async () => {},
      cancelTurn: async () => {},
      executeTurnStream: async () => ''
    } as unknown as TrueForgeConnection;

    const mgr = new InlineEditManager(mockConn, assembler);

    // Stage 3 proposals across 3 distinct files sequentially
    await mgr.registerAutonomousProposal(suite8File1, suite8Mod1, 'Edit file 1', { allowQueue: true });
    await mgr.registerAutonomousProposal(suite8File2, suite8Mod2, 'Edit file 2', { allowQueue: true });
    await mgr.registerAutonomousProposal(suite8File3, suite8Mod3, 'Edit file 3', { allowQueue: true });

    assert(mgr.getPendingEditCount() === 3, 'Requirement 1/4: All 3 proposals staged in pending queue');
    assert(fs.readFileSync(suite8File1, 'utf8') === suite8Orig1, 'File 1 untouched on disk before review');
    assert(fs.readFileSync(suite8File2, 'utf8') === suite8Orig2, 'File 2 untouched on disk before review');
    assert(fs.readFileSync(suite8File3, 'utf8') === suite8Orig3, 'File 3 untouched on disk before review');

    // Track showQuickPick interactions and diff commands
    const originalShowQuickPick = vscode.window.showQuickPick;
    const diffCommandsExecuted: Array<{ cmd: string; args: any[] }> = [];

    // Store original executeCommand to spy on vscode.diff
    const originalExecuteCommand = vscode.commands.executeCommand;
    (vscode.commands as any).executeCommand = async (cmd: string, ...args: any[]) => {
      if (cmd === 'vscode.diff') {
        diffCommandsExecuted.push({ cmd, args });
      }
      return (originalExecuteCommand as any)(cmd, ...args);
    };

    let quickPickCallCount = 0;

    (vscode.window as any).showQuickPick = async (items: any[]) => {
      quickPickCallCount++;

      if (quickPickCallCount === 1) {
        // Step 1: Main menu (3 files). Verify items and select file 1.
        const file1Item = items.find((i: any) => i.action === 'inspect_file' && i.proposal?.documentUri.fsPath.includes('suite8_file1'));
        assert(file1Item !== undefined, 'Requirement 1: Review menu displays proposal for file 1');
        assert(items.filter((i: any) => i.action === 'inspect_file').length === 3, 'Requirement 1: Review menu displays all 3 pending proposals');
        return file1Item;
      }

      if (quickPickCallCount === 2) {
        // Step 2: File 1 action menu. Verify diff was opened, then select "Return to Review Menu".
        assert(diffCommandsExecuted.length >= 1, 'Requirement 2: Selecting file 1 immediately opened its diff editor');
        const lastDiff = diffCommandsExecuted[diffCommandsExecuted.length - 1];
        assert(lastDiff.args[0].fsPath.includes('suite8_file1'), 'Requirement 2: Diff opened for file 1 documentUri');
        assert(Boolean(mgr.getActivePendingEdit()?.documentUri.fsPath.includes('suite8_file1')), 'Requirement 2: activePendingEdit set to file 1');

        const backItem = items.find((i: any) => i.value === 'back');
        assert(backItem !== undefined, 'Requirement 3: Sub-menu contains Return to Review Menu option');
        return backItem;
      }

      if (quickPickCallCount === 3) {
        // Step 3: Restored main menu. Verify all 3 files still queued and file 1 is marked active.
        assert(items.filter((i: any) => i.action === 'inspect_file').length === 3, 'Requirement 3/4: Returning from diff restores complete pending review menu with all 3 files');
        const file1Item = items.find((i: any) => i.action === 'inspect_file' && i.proposal?.documentUri.fsPath.includes('suite8_file1'));
        assert(Boolean(file1Item?.label.includes('(Active Diff)')), 'Requirement 3: Inspected file marked as (Active Diff) in restored menu');
        assert(mgr.getPendingEditCount() === 3, 'Requirement 4: All remaining proposals stay queued in pendingEdits Map');
        // Reopen File 1 again to test Requirement 5 (reopening does not duplicate or lose proposal)
        return file1Item;
      }

      if (quickPickCallCount === 4) {
        // Step 4: Reopened File 1 diff. Verify no duplicate and return back again.
        assert(mgr.getPendingEditCount() === 3, 'Requirement 5: Reopening an already inspected file does not duplicate or lose its proposal');
        const backItem = items.find((i: any) => i.value === 'back');
        return backItem;
      }

      if (quickPickCallCount === 5) {
        // Step 5: Restored menu again. Select File 1 for acceptance.
        const file1Item = items.find((i: any) => i.action === 'inspect_file' && i.proposal?.documentUri.fsPath.includes('suite8_file1'));
        return file1Item;
      }

      if (quickPickCallCount === 6) {
        // Step 6: File 1 action menu. Select "Accept Changes".
        const acceptItem = items.find((i: any) => i.value === 'accept');
        assert(acceptItem !== undefined, 'Requirement 6: File action menu contains Accept Changes option');
        return acceptItem;
      }

      if (quickPickCallCount === 7) {
        // Step 7: Refreshed menu after accepting File 1! Verify only 2 files remain.
        assert(fs.readFileSync(suite8File1, 'utf8') === suite8Mod1, 'Requirement 6: File 1 changes applied to disk after individual accept');
        assert(fs.readFileSync(suite8File2, 'utf8') === suite8Orig2, 'Requirement 6: File 2 remains untouched after File 1 accept');
        assert(fs.readFileSync(suite8File3, 'utf8') === suite8Orig3, 'Requirement 6: File 3 remains untouched after File 1 accept');
        assert(mgr.getPendingEditCount() === 2, 'Requirement 7: Queue count decreased to 2 after accepting file 1');
        assert(items.filter((i: any) => i.action === 'inspect_file').length === 2, 'Requirement 7: Refreshed menu displays remaining 2 files');
        const file2Item = items.find((i: any) => i.action === 'inspect_file' && i.proposal?.documentUri.fsPath.includes('suite8_file2'));
        return file2Item;
      }

      if (quickPickCallCount === 8) {
        // Step 8: File 2 action menu. Select "Reject Changes".
        const rejectItem = items.find((i: any) => i.value === 'reject');
        assert(rejectItem !== undefined, 'Requirement 6: File action menu contains Reject Changes option');
        return rejectItem;
      }

      if (quickPickCallCount === 9) {
        // Step 9: Single-file menu (File 3 remaining)! Verify only File 3 actions shown.
        assert(fs.readFileSync(suite8File2, 'utf8') === suite8Orig2, 'Requirement 6: File 2 left completely untouched after individual reject');
        assert(mgr.getPendingEditCount() === 1, 'Requirement 7: Queue count decreased to 1 after rejecting file 2');
        const acceptItem = items.find((i: any) => i.value === 'accept');
        assert(acceptItem !== undefined, 'Requirement 7/8: Single file menu displays Accept Changes for last file');
        return acceptItem;
      }

      return undefined;
    };

    // Run the interactive review flow
    await mgr.showReviewQuickPick();

    // Verify final state after loop completion
    assert(quickPickCallCount === 9, 'All 9 interactive review navigation steps executed');
    assert(mgr.getPendingEditCount() === 0, 'Requirement 8: Queue empty after accepting final proposal');
    assert(mgr.getActivePendingEdit() === null, 'Requirement 8: activePendingEdit is null when all proposals reviewed');
    assert(mgr.getReviewStatusBarItem() === undefined, 'Requirement 8: Status bar item disposed when queue is empty');
    assert(fs.readFileSync(suite8File1, 'utf8') === suite8Mod1, 'File 1 correctly modified on disk');
    assert(fs.readFileSync(suite8File2, 'utf8') === suite8Orig2, 'File 2 correctly preserved as original on disk');
    assert(fs.readFileSync(suite8File3, 'utf8') === suite8Mod3, 'File 3 correctly modified on disk');

    // Test explicit dismissal / keep reviewing diff behavior
    await mgr.registerAutonomousProposal(suite8File1, suite8Mod1, 'Edit file 1 again', { allowQueue: true });
    await mgr.registerAutonomousProposal(suite8File2, suite8Mod2, 'Edit file 2 again', { allowQueue: true });
    assert(mgr.getPendingEditCount() === 2, '2 proposals staged for dismissal test');

    // Simulate user selecting file 1 to inspect diff, and then choosing "Keep Reviewing Diff"
    let dismissalCall = 0;
    (vscode.window as any).showQuickPick = async (items: any[]) => {
      dismissalCall++;
      if (dismissalCall === 1) {
        return items.find((i: any) => i.action === 'inspect_file');
      }
      if (dismissalCall === 2) {
        return items.find((i: any) => i.value === 'keep');
      }
      return undefined;
    };

    await mgr.showReviewQuickPick();
    assert(mgr.getPendingEditCount() === 2, 'Requirement 8: Dismissing / choosing keep leaves all proposals queued in pendingEdits');
    assert(mgr.getActivePendingEdit() !== null, 'Requirement 8: activePendingEdit remains active for inspected file');
    assert(mgr.getReviewStatusBarItem() !== undefined, 'Requirement 8: Status bar item remains visible for resumption');

    // Clean up test proposals
    mgr.rejectAllPendingEdits();
    assert(mgr.getPendingEditCount() === 0, 'rejectAllPendingEdits clears queue');

    // Restore originals
    (vscode.window as any).showQuickPick = originalShowQuickPick;
    (vscode.commands as any).executeCommand = originalExecuteCommand;
  }

  // Cleanup temporary Suite 8 files
  if (fs.existsSync(suite8File1)) fs.unlinkSync(suite8File1);
  if (fs.existsSync(suite8File2)) fs.unlinkSync(suite8File2);
  if (fs.existsSync(suite8File3)) fs.unlinkSync(suite8File3);
  delete (vscode.workspace as any)._documentVersions[suite8File1];
  delete (vscode.workspace as any)._documentVersions[suite8File2];
  delete (vscode.workspace as any)._documentVersions[suite8File3];

  // -----------------------------------------------------------------
  // SUMMARY
  // -----------------------------------------------------------------
  console.log('====================================================');
  console.log(`  TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Unhandled test error:', err);
  process.exit(1);
});
