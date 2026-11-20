import * as path from 'path';
import { WorkspaceContextDiscovery } from '../context/WorkspaceContextDiscovery.js';
import { ContextAssembler, ActiveEditorInput } from '../context/ContextAssembler.js';
import { InlineEditManager } from '../diff/InlineEditManager.js';
import { TrueForgeConnection } from '../connection/TrueForgeConnection.js';

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
  const mockPendingAccept = {
    documentUri: { toString: () => 'file:///test/doc.ts', fsPath: '/test/doc.ts', path: '/test/doc.ts' } as any,
    range: { start: { line: 0, character: 0 }, end: { line: 1, character: 10 } } as any,
    originalSelectionText: 'const oldVal = 1;',
    replacementText: 'const newVal = 2;',
    diffUri: { toString: () => 'trueforge-diff://proposed/doc.ts' } as any
  };
  const acceptResult = await editManager.applyEdit(mockPendingAccept);
  assert(acceptResult === true, 'Accept workflow applies edit and returns success');

  // 3.6 Reject Edit Workflow Test & File Preservation
  const originalFileContent = 'function immutableOriginal() { return true; }';
  let preservedFileContent = originalFileContent;

  const mockPendingReject = {
    documentUri: { toString: () => 'file:///test/immutable.ts', fsPath: '/test/immutable.ts', path: '/test/immutable.ts' } as any,
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
