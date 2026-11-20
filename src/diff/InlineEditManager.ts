import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TrueForgeConnection } from '../connection/TrueForgeConnection.js';
import { ContextAssembler, ActiveEditorInput } from '../context/ContextAssembler.js';

export interface PendingEdit {
  documentUri: vscode.Uri;
  range: vscode.Range;
  originalSelectionText: string;
  replacementText: string;
  diffUri: vscode.Uri;
  diffEditor?: vscode.TextEditor;
}

export class InlineEditManager implements vscode.TextDocumentContentProvider {
  public static readonly SCHEME = 'trueforge-diff';

  private readonly connection: TrueForgeConnection;
  private readonly contextAssembler: ContextAssembler;
  private readonly proposedDocs = new Map<string, string>();
  private activePendingEdit: PendingEdit | null = null;
  private reviewStatusBarItem?: vscode.StatusBarItem;

  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this._onDidChange.event;

  constructor(connection: TrueForgeConnection, contextAssembler: ContextAssembler) {
    this.connection = connection;
    this.contextAssembler = contextAssembler;
  }

  /**
   * Provides content for the virtual proposed document in the diff editor.
   */
  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.proposedDocs.get(uri.toString()) ?? '';
  }

  public getActivePendingEdit(): PendingEdit | null {
    return this.activePendingEdit;
  }

  /**
   * Main entry point for the inline edit command.
   */
  public async startInlineEdit(editor?: vscode.TextEditor): Promise<void> {
    const targetEditor = editor ?? vscode.window.activeTextEditor;
    if (!targetEditor) {
      vscode.window.showWarningMessage('TrueForge: Open a file in the editor to use Inline Edit.');
      return;
    }

    const document = targetEditor.document;
    let selection = targetEditor.selection;

    // Handle empty selection: if empty, select the current line or prompt
    let isFullFile = false;
    if (selection.isEmpty) {
      const option = await vscode.window.showQuickPick(
        [
          { label: '$(whole-word) Edit Current Line', description: `Line ${selection.start.line + 1}`, value: 'line' },
          { label: '$(file-code) Edit Entire File', description: `${document.lineCount} lines (${document.languageId})`, value: 'file' }
        ],
        { placeHolder: 'No code selected. What would you like forgeagent to edit?' }
      );

      if (!option) {
        return; // Cancelled
      }

      if (option.value === 'line') {
        const line = document.lineAt(selection.start.line);
        selection = new vscode.Selection(line.range.start, line.range.end);
      } else {
        isFullFile = true;
        const lastLine = document.lineAt(document.lineCount - 1);
        selection = new vscode.Selection(new vscode.Position(0, 0), lastLine.range.end);
      }
    }

    const selectedCode = document.getText(selection);

    // Prompt user for natural language instruction
    const userInstruction = await vscode.window.showInputBox({
      title: 'TrueForge: Inline Edit Selection',
      prompt: `Instruct forgeagent on how to modify the selected ${isFullFile ? 'file' : `${selection.end.line - selection.start.line + 1} lines`}`,
      placeHolder: 'e.g., Refactor this function to handle errors asynchronously and add types',
      ignoreFocusOut: true
    });

    if (!userInstruction || userInstruction.trim().length === 0) {
      return; // Cancelled
    }

    // Execute with progress
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'TrueForge: Generating proposed edits with forgeagent...',
        cancellable: true
      },
      async (progress, token) => {
        progress.report({ message: 'Assembling workspace context...' });

        // 1. Assemble prioritized context
        const editorInput: ActiveEditorInput = {
          documentUri: document.uri.fsPath,
          documentText: document.getText(),
          languageId: document.languageId,
          selectionText: selectedCode,
          selectionStartLine: selection.start.line + 1,
          selectionEndLine: selection.end.line + 1
        };

        const assembledContext = await this.contextAssembler.assembleContext(editorInput, userInstruction);

        if (token.isCancellationRequested) {
          return;
        }

        // 2. Format LLM prompt
        const prompt = this.buildPrompt(userInstruction, assembledContext);

        progress.report({ message: 'Submitting to forgeagent...' });

        // 3. Create TrueForge session & submit turn
        let sessionId: string | null = null;
        try {
          sessionId = await this.connection.createSession();

          let rawResponse = '';
          rawResponse = await this.connection.executeTurnStream(
            sessionId,
            prompt,
            (chunk) => {
              rawResponse += chunk;
            }
          );

          if (token.isCancellationRequested) {
            return;
          }

          progress.report({ message: 'Extracting replacement code...' });

          // 4. Extract replacement code
          const replacementCode = this.extractReplacementCode(rawResponse, document.languageId);

          if (!replacementCode.trim()) {
            vscode.window.showErrorMessage('TrueForge: Agent returned an empty or unparseable code proposal.');
            return;
          }

          // 5. Compute full proposed document text
          const docText = document.getText();
          const startOffset = document.offsetAt(selection.start);
          const endOffset = document.offsetAt(selection.end);
          const fullProposedText = docText.slice(0, startOffset) + replacementCode + docText.slice(endOffset);

          // 6. Register in virtual document provider
          const fileName = document.fileName.split(/[\\/]/).pop() ?? 'file';
          const diffUri = vscode.Uri.parse(`${InlineEditManager.SCHEME}://proposed/${fileName}`);
          this.proposedDocs.set(diffUri.toString(), fullProposedText);
          this._onDidChange.fire(diffUri);

          this.activePendingEdit = {
            documentUri: document.uri,
            range: selection,
            originalSelectionText: selectedCode,
            replacementText: replacementCode,
            diffUri
          };

          // 7. Enable VS Code context key for title bar buttons
          await vscode.commands.executeCommand('setContext', 'trueforge.hasPendingEdit', true);

          // 8. Create / show prominent Review Status Bar button
          this.showReviewStatusBarItem(fileName);

          // 9. Open Diff Editor for side-by-side review
          const diffTitle = `${fileName} (Original) ↔ ${fileName} (TrueForge Proposal)`;
          await vscode.commands.executeCommand('vscode.diff', document.uri, diffUri, diffTitle, {
            preview: true
          });

          // 10. Present centered QuickPick review dialog
          await this.showReviewQuickPick();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`TrueForge Inline Edit failed: ${msg}`);
        } finally {
          if (sessionId) {
            try {
              await this.connection.deleteSession(sessionId);
            } catch {
              // Ignore session deletion errors
            }
          }
        }
      }
    );
  }

  /**
   * Displays the centered QuickPick review dialog with explicit Accept / Reject options.
   * Can be reopened at any time while the diff is active.
   */
  public async showReviewQuickPick(): Promise<void> {
    if (!this.activePendingEdit) {
      vscode.window.showInformationMessage('TrueForge: No active inline edit proposal to review.');
      return;
    }

    const pending = this.activePendingEdit;
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: '$(check) Accept Changes',
          description: 'Apply proposed code replacement to the original document',
          value: 'accept'
        },
        {
          label: '$(x) Reject Changes',
          description: 'Discard proposal and keep original document completely unchanged',
          value: 'reject'
        },
        {
          label: '$(eye) Keep Reviewing Diff',
          description: 'Leave diff open; controls remain in the status bar and editor title bar',
          value: 'keep'
        }
      ],
      {
        title: 'TrueForge Diff Review: Accept or Reject Proposed Changes?',
        placeHolder: 'Select an action (or click Accept/Reject in the editor title bar / status bar)',
        ignoreFocusOut: true
      }
    );

    if (choice?.value === 'accept') {
      await this.applyEdit(pending);
    } else if (choice?.value === 'reject') {
      this.rejectEdit(pending);
    }
    // If 'keep' or dismissed (Escape), leave diff open and controls active
  }

  /**
   * Registers an edit proposal generated by the Autonomous Agent Coordinator
   * and opens the diff editor with explicit Accept/Reject review controls.
   */
  public async registerAutonomousProposal(
    absolutePath: string,
    replacementCode: string,
    _explanation: string
  ): Promise<void> {
    const originalUri = vscode.Uri.file(absolutePath);
    let originalText = '';
    let range: vscode.Range;

    const fileExists = fs.existsSync(absolutePath);
    if (fileExists) {
      try {
        const doc = await vscode.workspace.openTextDocument(originalUri);
        originalText = doc.getText();
        const lastLineIndex = Math.max(0, doc.lineCount - 1);
        const lastLine = doc.lineAt(lastLineIndex);
        range = new vscode.Range(new vscode.Position(0, 0), lastLine.range.end);
      } catch {
        originalText = fs.readFileSync(absolutePath, 'utf8');
        const lineCount = originalText.split(/\r?\n/).length;
        range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(Math.max(0, lineCount), 0));
      }
    } else {
      originalText = '';
      range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
    }

    const fileName = path.basename(absolutePath);
    const diffUri = vscode.Uri.parse(`${InlineEditManager.SCHEME}://proposed/${fileName}`);
    this.proposedDocs.set(diffUri.toString(), replacementCode);
    this._onDidChange.fire(diffUri);

    this.activePendingEdit = {
      documentUri: originalUri,
      range,
      originalSelectionText: originalText,
      replacementText: replacementCode,
      diffUri
    };

    // Enable toolbar actions and status bar review button
    await vscode.commands.executeCommand('setContext', 'trueforge.hasPendingEdit', true);
    this.showReviewStatusBarItem(fileName);

    // Open side-by-side diff
    const diffTitle = `${fileName} (Original) ↔ ${fileName} (TrueForge Proposal)`;
    await vscode.commands.executeCommand('vscode.diff', originalUri, diffUri, diffTitle, {
      preview: true
    });

    // Present review action QuickPick
    await this.showReviewQuickPick();
  }

  /**
   * Applies the accepted replacement directly to the target document.
   */
  public async applyEdit(pending?: PendingEdit | null): Promise<boolean> {
    const target = pending ?? this.activePendingEdit;
    if (!target) {
      vscode.window.showWarningMessage('TrueForge: No active proposal to accept.');
      return false;
    }

    const workspaceEdit = new vscode.WorkspaceEdit();
    if (!fs.existsSync(target.documentUri.fsPath)) {
      if (typeof (workspaceEdit as any).createFile === 'function') {
        (workspaceEdit as any).createFile(target.documentUri, { overwrite: true, ignoreIfExists: true });
      }
      if (typeof (workspaceEdit as any).insert === 'function') {
        (workspaceEdit as any).insert(target.documentUri, new vscode.Position(0, 0), target.replacementText);
      } else {
        workspaceEdit.replace(target.documentUri, target.range, target.replacementText);
      }
    } else {
      workspaceEdit.replace(target.documentUri, target.range, target.replacementText);
    }

    const success = await vscode.workspace.applyEdit(workspaceEdit);
    if (success) {
      vscode.window.showInformationMessage('✅ TrueForge: Changes accepted and applied to document.');
    } else {
      vscode.window.showErrorMessage('❌ TrueForge: Failed to apply edit to document.');
    }

    this.cleanupPending(target);
    return success;
  }

  /**
   * Rejects the proposed edit and discards the proposal without touching the original document.
   */
  public rejectEdit(pending?: PendingEdit | null): void {
    const target = pending ?? this.activePendingEdit;
    if (!target) {
      vscode.window.showWarningMessage('TrueForge: No active proposal to reject.');
      return;
    }

    this.cleanupPending(target);
    vscode.window.showInformationMessage('TrueForge: Proposed changes rejected. Original file left completely untouched.');
  }

  private showReviewStatusBarItem(fileName: string): void {
    if (!this.reviewStatusBarItem) {
      this.reviewStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
      this.reviewStatusBarItem.command = 'trueforge.reviewPendingEdit';
    }
    this.reviewStatusBarItem.text = `$(git-compare) TrueForge: Review ${fileName} [Accept | Reject]`;
    this.reviewStatusBarItem.tooltip = 'Click to open TrueForge Accept / Reject Review dialog';
    this.reviewStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.reviewStatusBarItem.show();
  }

  private cleanupPending(pending: PendingEdit): void {
    this.proposedDocs.delete(pending.diffUri.toString());
    this._onDidChange.fire(pending.diffUri);

    if (this.reviewStatusBarItem) {
      this.reviewStatusBarItem.dispose();
      this.reviewStatusBarItem = undefined;
    }

    vscode.commands.executeCommand('setContext', 'trueforge.hasPendingEdit', false);

    if (this.activePendingEdit === pending) {
      this.activePendingEdit = null;
    }
  }

  /**
   * Formats prompt for forgeagent, strictly constraining output to replacement code only.
   */
  public buildPrompt(instruction: string, context: { formattedMarkdown: string; languageId: string }): string {
    return [
      `You are TrueForge coding agent performing an inline code replacement.`,
      `The user requested the following modification:`,
      `"${instruction}"`,
      ``,
      `### Context:`,
      context.formattedMarkdown,
      ``,
      `### MANDATORY INSTRUCTIONS:`,
      `1. Return ONLY the replacement code for the "Target Code to Replace".`,
      `2. Enclose the code inside a single markdown code block (\`\`\`${context.languageId} ... \`\`\`).`,
      `3. Do NOT include any explanations, pleasantries, markdown headings, or conversational remarks before or after the code block.`,
      `4. Preserve appropriate indentation and match surrounding style.`
    ].join('\n');
  }

  /**
   * Extracts clean replacement code from the agent's response, handling fenced blocks or raw code.
   */
  public extractReplacementCode(response: string, _languageId: string): string {
    const trimmed = response.trim();

    // 1. Look for ```<lang> ... ``` or ``` ... ```
    const codeBlockRegex = /```(?:[a-zA-Z0-9_\-+]*)\r?\n([\s\S]*?)\r?\n```/;
    const match = trimmed.match(codeBlockRegex);
    if (match && match[1] !== undefined) {
      return match[1];
    }

    // 2. Handle case where code block doesn't have closing backticks (streaming cutoff)
    const openBlockRegex = /```(?:[a-zA-Z0-9_\-+]*)\r?\n([\s\S]*)$/;
    const openMatch = trimmed.match(openBlockRegex);
    if (openMatch && openMatch[1] !== undefined) {
      return openMatch[1].replace(/```$/, '');
    }

    // 3. Fallback: if no backticks found, return bare text if it looks like code
    return trimmed;
  }
}
