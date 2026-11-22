import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { TrueForgeConnection, isCancellationError } from '../connection/TrueForgeConnection.js';
import { ContextAssembler, ActiveEditorInput } from '../context/ContextAssembler.js';

/**
 * Computes a deterministic SHA-256 hash of document or selection content
 * for concurrent edit conflict detection.
 */
export function computeContentHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export interface PendingEdit {
  documentUri: vscode.Uri;
  range: vscode.Range;
  originalSelectionText: string;
  replacementText: string;
  diffUri: vscode.Uri;
  diffEditor?: vscode.TextEditor;
  originalDocumentVersion?: number;
  originalDocumentHash?: string;
  originalDiskHash?: string;
  isInitiallyDirty?: boolean;
  fileExistsInitially?: boolean;
}

export class InlineEditManager implements vscode.TextDocumentContentProvider {
  public static readonly SCHEME = 'trueforge-diff';

  private readonly connection: TrueForgeConnection;
  private readonly contextAssembler: ContextAssembler;
  private readonly proposedDocs = new Map<string, string>();
  private readonly pendingEdits = new Map<string, PendingEdit>();
  private activePendingEdit: PendingEdit | null = null;
  private reviewStatusBarItem?: vscode.StatusBarItem;

  private activeAbortController: AbortController | null = null;
  private activeSessionId: string | null = null;
  private isOperationCancelled = false;
  private isGenerationActive = false;
  private cancellationListenerDisposable?: vscode.Disposable;

  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this._onDidChange.event;

  constructor(connection: TrueForgeConnection, contextAssembler: ContextAssembler) {
    this.connection = connection;
    this.contextAssembler = contextAssembler;
  }

  public getPendingKey(uri: vscode.Uri | string): string {
    const fsPath = typeof uri === 'string' ? uri : uri.fsPath;
    return path.resolve(fsPath).toLowerCase();
  }

  public getPendingEdits(): PendingEdit[] {
    return Array.from(this.pendingEdits.values());
  }

  public getPendingEditCount(): number {
    return this.pendingEdits.size;
  }

  public getPendingEditForUri(uri: vscode.Uri | string): PendingEdit | undefined {
    return this.pendingEdits.get(this.getPendingKey(uri));
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

  public getReviewStatusBarItem(): vscode.StatusBarItem | undefined {
    return this.reviewStatusBarItem;
  }

  public isGenerating(): boolean {
    return this.isGenerationActive;
  }

  /**
   * Cancels any active inline edit generation operation.
   * Aborts client streaming, sends cancelTurn to TrueForge, deletes session, and cancels in-progress generation
   * without affecting staged proposals awaiting user review.
   * Safe to invoke repeatedly.
   */
  public async cancel(): Promise<void> {
    this.isOperationCancelled = true;

    if (this.activeAbortController) {
      try {
        this.activeAbortController.abort();
      } catch {
        // Safe: ignore abort errors
      }
      this.activeAbortController = null;
    }

    if (this.activeSessionId) {
      const sessId = this.activeSessionId;
      this.activeSessionId = null;
      try {
        await this.connection.cancelTurn(sessId);
      } catch {
        // Server-side cancellation may fail or already be cancelled; safely ignore
      }
      try {
        await this.connection.deleteSession(sessId);
      } catch {
        // Session cleanup is best-effort on cancel
      }
    }
  }

  /**
   * Cleans up any active or staged proposal without leaving stale state.
   */
  public cleanupActiveProposal(): void {
    if (this.activePendingEdit) {
      this.cleanupPending(this.activePendingEdit);
    } else {
      this.cleanupPending(null);
    }
  }

  /**
   * Generates an inline edit proposal with genuine end-to-end cancellation support.
   * Returns the generated PendingEdit on success, or null if cancelled or empty.
   */
  public async generateInlineEdit(
    document: vscode.TextDocument,
    selection: vscode.Selection,
    userInstruction: string,
    cancellationToken?: vscode.CancellationToken,
    progress?: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<PendingEdit | null> {
    // 1. Pending proposal guard: reject new generation if a proposal is already awaiting review
    if (this.activePendingEdit) {
      vscode.window.showWarningMessage(
        'TrueForge: A proposed edit is already awaiting review. Please accept or reject the current proposal before generating a new edit.'
      );
      return null;
    }

    // 2. Single-operation guard against concurrent overlapping generation
    if (this.isGenerationActive) {
      vscode.window.showWarningMessage(
        'TrueForge: An inline edit operation is already in progress. Please wait for it to complete or cancel it.'
      );
      return null;
    }

    // 3. Pre-flight check before doing any work
    if (cancellationToken?.isCancellationRequested) {
      return null;
    }

    this.isGenerationActive = true;
    this.isOperationCancelled = false;

    // 3. Setup AbortController and link to CancellationToken
    const abortController = new AbortController();
    this.activeAbortController = abortController;

    if (cancellationToken) {
      this.cancellationListenerDisposable?.dispose();
      this.cancellationListenerDisposable = cancellationToken.onCancellationRequested(async () => {
        this.isOperationCancelled = true;
        try {
          abortController.abort();
        } catch { }
        if (this.activeSessionId) {
          try {
            await this.connection.cancelTurn(this.activeSessionId);
          } catch {
            // Server-side cancellation error ignored
          }
        }
      });
    }

    let sessionId: string | null = null;
    let registeredDiffUri: vscode.Uri | null = null;

    try {
      progress?.report({ message: 'Assembling workspace context...' });

      const originalDocumentText = document.getText();
      const originalDocumentVersion = typeof document.version === 'number' ? document.version : undefined;
      const originalDocumentHash = computeContentHash(originalDocumentText);
      const isInitiallyDirty = Boolean(document.isDirty);
      const fileExistsInitially = fs.existsSync(document.uri.fsPath);
      let originalDiskHash: string | undefined;
      if (fileExistsInitially) {
        try {
          const diskContent = fs.readFileSync(document.uri.fsPath, 'utf8');
          originalDiskHash = computeContentHash(diskContent);
        } catch {
          originalDiskHash = undefined;
        }
      }
      const originalSelectionText = document.getText(selection);

      const editorInput: ActiveEditorInput = {
        documentUri: document.uri.fsPath,
        documentText: originalDocumentText,
        languageId: document.languageId,
        selectionText: originalSelectionText,
        selectionStartLine: selection.start.line + 1,
        selectionEndLine: selection.end.line + 1
      };

      const assembledContext = await this.contextAssembler.assembleContext(editorInput, userInstruction);

      // Check cancellation after context assembly
      if (cancellationToken?.isCancellationRequested || this.isOperationCancelled || abortController.signal.aborted) {
        return null;
      }

      const prompt = this.buildPrompt(userInstruction, assembledContext);

      // Check cancellation before creating session
      if (cancellationToken?.isCancellationRequested || this.isOperationCancelled || abortController.signal.aborted) {
        return null;
      }

      progress?.report({ message: 'Submitting to forgeagent...' });

      sessionId = await this.connection.createSession();
      this.activeSessionId = sessionId;

      // Check cancellation immediately after session creation
      if (cancellationToken?.isCancellationRequested || this.isOperationCancelled || abortController.signal.aborted) {
        if (sessionId) {
          try { await this.connection.cancelTurn(sessionId); } catch { }
        }
        return null;
      }

      let rawResponse = '';
      rawResponse = await this.connection.executeTurnStream(
        sessionId,
        prompt,
        {
          onDelta: (chunk) => {
            if (!this.isOperationCancelled && !cancellationToken?.isCancellationRequested && !abortController.signal.aborted) {
              rawResponse += chunk;
            }
          },
          abortSignal: abortController.signal
        }
      );

      // Check cancellation immediately after turn response received
      if (cancellationToken?.isCancellationRequested || this.isOperationCancelled || abortController.signal.aborted) {
        return null;
      }

      progress?.report({ message: 'Extracting replacement code...' });

      const replacementCode = this.extractReplacementCode(rawResponse, document.languageId);
      if (!replacementCode.trim()) {
        vscode.window.showErrorMessage('TrueForge: Agent returned an empty or unparseable code proposal.');
        return null;
      }

      // Check cancellation before computing full text
      if (cancellationToken?.isCancellationRequested || this.isOperationCancelled || abortController.signal.aborted) {
        return null;
      }

      const docText = document.getText();
      const startOffset = document.offsetAt(selection.start);
      const endOffset = document.offsetAt(selection.end);
      const fullProposedText = docText.slice(0, startOffset) + replacementCode + docText.slice(endOffset);

      // Final check: prevent any proposed edit from being registered if cancelled
      if (cancellationToken?.isCancellationRequested || this.isOperationCancelled || abortController.signal.aborted) {
        return null;
      }

      // Guard: ensure no proposal was staged while generation was in-flight
      if (this.activePendingEdit) {
        vscode.window.showWarningMessage(
          'TrueForge: A proposed edit is already awaiting review. Please accept or reject the current proposal before generating a new edit.'
        );
        return null;
      }

      const fileName = document.fileName.split(/[\\/]/).pop() ?? 'file';
      const diffUri = vscode.Uri.parse(`${InlineEditManager.SCHEME}://proposed/${fileName}`);
      this.proposedDocs.set(diffUri.toString(), fullProposedText);
      this._onDidChange.fire(diffUri);
      registeredDiffUri = diffUri;

      const pendingEdit: PendingEdit = {
        documentUri: document.uri,
        range: selection,
        originalSelectionText,
        replacementText: replacementCode,
        diffUri,
        originalDocumentVersion,
        originalDocumentHash,
        originalDiskHash,
        isInitiallyDirty,
        fileExistsInitially
      };
      this.pendingEdits.set(this.getPendingKey(document.uri), pendingEdit);
      this.activePendingEdit = pendingEdit;

      return pendingEdit;
    } catch (err: unknown) {
      if (
        cancellationToken?.isCancellationRequested ||
        this.isOperationCancelled ||
        abortController.signal.aborted ||
        isCancellationError(err)
      ) {
        this.isOperationCancelled = true;
        if (registeredDiffUri) {
          this.proposedDocs.delete(registeredDiffUri.toString());
          this._onDidChange.fire(registeredDiffUri);
        }
        return null;
      }
      throw err;
    } finally {
      if (this.cancellationListenerDisposable) {
        try {
          this.cancellationListenerDisposable.dispose();
        } catch { }
        this.cancellationListenerDisposable = undefined;
      }
      if (this.activeAbortController === abortController) {
        this.activeAbortController = null;
      }
      if (sessionId) {
        if (this.activeSessionId === sessionId) {
          this.activeSessionId = null;
        }
        try {
          await this.connection.deleteSession(sessionId);
        } catch {
          // Session deletion error ignored
        }
      }
      this.isGenerationActive = false;
    }
  }

  /**
   * Main entry point for the inline edit command.
   */
  public async startInlineEdit(editor?: vscode.TextEditor): Promise<void> {
    // 1. Pending proposal guard: reject starting inline edit if a proposal is already awaiting review
    if (this.activePendingEdit) {
      vscode.window.showWarningMessage(
        'TrueForge: A proposed edit is already awaiting review. Please accept or reject the current proposal before generating a new edit.'
      );
      return;
    }

    // 2. Single-operation guard: check if generation is already in progress
    if (this.isGenerationActive) {
      vscode.window.showWarningMessage(
        'TrueForge: An inline edit operation is already in progress. Please wait for it to complete or cancel it.'
      );
      return;
    }

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

    const resultHolder: { pendingEdit: PendingEdit | null } = { pendingEdit: null };
    let wasCancelled = false;

    // Execute with progress
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'TrueForge: Generating proposed edits with forgeagent...',
        cancellable: true
      },
      async (progress, token) => {
        try {
          resultHolder.pendingEdit = await this.generateInlineEdit(document, selection, userInstruction, token, progress);
          if (!resultHolder.pendingEdit && (token.isCancellationRequested || this.isOperationCancelled)) {
            wasCancelled = true;
          }
        } catch (err: unknown) {
          if (token.isCancellationRequested || this.isOperationCancelled || isCancellationError(err)) {
            wasCancelled = true;
          } else {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`TrueForge Inline Edit failed: ${msg}`);
          }
        }
      }
    );

    if (wasCancelled || !resultHolder.pendingEdit) {
      if (wasCancelled) {
        vscode.window.showInformationMessage('TrueForge: Inline Edit was cancelled.');
      }
      return;
    }

    const finalPending = resultHolder.pendingEdit;

    // Enable VS Code context key for title bar buttons
    const fileName = document.fileName.split(/[\\/]/).pop() ?? 'file';
    await vscode.commands.executeCommand('setContext', 'trueforge.hasPendingEdit', true);

    // Show prominent Review Status Bar button
    this.showReviewStatusBarItem(fileName);

    // Open Diff Editor for side-by-side review
    const diffTitle = `${fileName} (Original) ↔ ${fileName} (TrueForge Proposal)`;
    await vscode.commands.executeCommand('vscode.diff', document.uri, finalPending.diffUri, diffTitle, {
      preview: true
    });

    // Present centered QuickPick review dialog
    await this.showReviewQuickPick();
  }

  /**
   * Displays the centered QuickPick review dialog with explicit Accept / Reject options.
   * Can be reopened at any time while the diff is active.
   */
  public async showReviewQuickPick(): Promise<void> {
    if (this.pendingEdits.size === 0 && !this.activePendingEdit) {
      vscode.window.showInformationMessage('TrueForge: No active inline edit proposal to review.');
      return;
    }

    if (this.pendingEdits.size === 0 && this.activePendingEdit) {
      this.pendingEdits.set(this.getPendingKey(this.activePendingEdit.documentUri), this.activePendingEdit);
    }

    // Interactive review navigation loop: persists until all proposals are handled or user dismisses
    while (this.pendingEdits.size > 0) {
      // CASE 1: Exactly 1 pending proposal remaining
      if (this.pendingEdits.size === 1) {
        const pending = this.activePendingEdit ?? this.pendingEdits.values().next().value;
        if (!pending) break;

        this.activePendingEdit = pending;
        this.updateReviewStatusBarItem();

        const fileName = path.basename(pending.documentUri.fsPath);
        const choice = await vscode.window.showQuickPick(
          [
            {
              label: '$(check) Accept Changes',
              description: `Apply proposed code replacement to ${fileName}`,
              value: 'accept'
            },
            {
              label: '$(x) Reject Changes',
              description: `Discard proposal and keep ${fileName} completely unchanged`,
              value: 'reject'
            },
            {
              label: '$(diff) Open Diff View',
              description: `Inspect ${fileName} in side-by-side diff editor`,
              value: 'diff'
            },
            {
              label: '$(eye) Keep Reviewing Diff',
              description: 'Leave diff open; controls remain in the status bar and editor title bar',
              value: 'keep'
            }
          ],
          {
            title: `TrueForge Diff Review: Accept or Reject Proposed Changes for ${fileName}`,
            placeHolder: 'Select an action (or click Accept/Reject in the editor title bar / status bar)',
            ignoreFocusOut: true
          }
        );

        if (!choice || choice.value === 'keep') {
          break;
        }

        if (choice.value === 'accept') {
          await this.applyEdit(pending);
          continue;
        } else if (choice.value === 'reject') {
          this.rejectEdit(pending);
          continue;
        } else if (choice.value === 'diff') {
          const diffTitle = `${fileName} (Original) ↔ ${fileName} (TrueForge Proposal)`;
          await vscode.commands.executeCommand('vscode.diff', pending.documentUri, pending.diffUri, diffTitle, {
            preview: true
          });
          continue;
        }
      }

      // CASE 2: Multi-file review menu (pendingEdits.size > 1)
      const items: Array<vscode.QuickPickItem & { action?: string; proposal?: PendingEdit }> = [
        {
          label: `$(check) Accept All Changes (${this.pendingEdits.size} files)`,
          description: 'Apply all staged proposals to their respective documents',
          action: 'accept_all'
        },
        {
          label: `$(x) Reject All Changes (${this.pendingEdits.size} files)`,
          description: 'Discard all staged proposals without touching files on disk',
          action: 'reject_all'
        },
        {
          label: '',
          kind: vscode.QuickPickItemKind ? vscode.QuickPickItemKind.Separator : undefined
        }
      ];

      const workspaceRoot = this.contextAssembler.getDiscovery().getWorkspaceRoot();
      for (const p of this.pendingEdits.values()) {
        const relPath = path.relative(workspaceRoot, p.documentUri.fsPath).replace(/\\/g, '/');
        const isCurrent = this.activePendingEdit === p;
        items.push({
          label: `$(file-code) ${relPath}${isCurrent ? ' (Active Diff)' : ''}`,
          description: `Lines ${p.range.start.line + 1}–${p.range.end.line + 1}`,
          action: 'inspect_file',
          proposal: p
        });
      }

      const selected = await vscode.window.showQuickPick(items, {
        title: `TrueForge Diff Review: ${this.pendingEdits.size} Files Awaiting Review`,
        placeHolder: 'Select a file to inspect diff, or accept/reject all changes',
        ignoreFocusOut: true
      });

      if (!selected || !selected.action) {
        break;
      }

      if (selected.action === 'accept_all') {
        await this.applyAllPendingEdits();
        break;
      } else if (selected.action === 'reject_all') {
        this.rejectAllPendingEdits();
        break;
      } else if (selected.action === 'inspect_file' && selected.proposal) {
        const fileProposal = selected.proposal;
        const fileName = path.basename(fileProposal.documentUri.fsPath);

        this.activePendingEdit = fileProposal;
        this.updateReviewStatusBarItem();

        // 1. Immediately open the original-versus-proposed diff editor
        const count = this.pendingEdits.size;
        const diffTitle = `${fileName} (Original) ↔ ${fileName} (TrueForge Staged [${count} files pending])`;
        await vscode.commands.executeCommand(
          'vscode.diff',
          fileProposal.documentUri,
          fileProposal.diffUri,
          diffTitle,
          { preview: true }
        );

        // 2. Present file-specific review actions with return navigation
        const fileChoice = await vscode.window.showQuickPick(
          [
            {
              label: `$(arrow-left) Return to Review Menu`,
              description: `Back to list of all pending files (${this.pendingEdits.size} files queued)`,
              value: 'back'
            },
            {
              label: `$(check) Accept Changes for ${fileName}`,
              description: `Apply modifications to ${fileName} only`,
              value: 'accept'
            },
            {
              label: `$(x) Reject Changes for ${fileName}`,
              description: `Discard modifications for ${fileName} only (leave other files queued)`,
              value: 'reject'
            },
            {
              label: `$(eye) Keep Reviewing Diff`,
              description: 'Keep this diff open in editor (use status bar or title buttons to resume)',
              value: 'keep'
            }
          ],
          {
            title: `Review Proposed Changes: ${fileName} (${this.pendingEdits.size} files pending)`,
            placeHolder: `Select action for ${fileName} or return to review menu`,
            ignoreFocusOut: true
          }
        );

        if (!fileChoice || fileChoice.value === 'keep') {
          break;
        }

        if (fileChoice.value === 'back') {
          // Restores complete pending review menu on next iteration
          continue;
        } else if (fileChoice.value === 'accept') {
          await this.applyEdit(fileProposal);
          // Refreshes menu with remaining pending files
          continue;
        } else if (fileChoice.value === 'reject') {
          this.rejectEdit(fileProposal);
          // Refreshes menu with remaining pending files
          continue;
        }
      }
    }
  }

  /**
   * Registers an edit proposal generated by the Autonomous Agent Coordinator
   * and opens the diff editor with explicit Accept/Reject review controls.
   */
  public async registerAutonomousProposal(
    absolutePath: string,
    replacementCode: string,
    _explanation: string,
    options?: {
      startLine?: number;
      endLine?: number;
      fullProposedText?: string;
      allowQueue?: boolean;
    }
  ): Promise<boolean> {
    // 1. Pending proposal guard: if activePendingEdit already contains a proposal awaiting review,
    // reject the second autonomous proposal without overwriting the existing proposal or its virtual diff,
    // unless allowQueue is enabled.
    if (this.activePendingEdit && !options?.allowQueue) {
      vscode.window.showWarningMessage(
        'TrueForge: A proposed edit is already awaiting review. Please accept or reject the current proposal before registering a new proposal.'
      );
      return false;
    }

    // 2. Inline generation guard: if inline generation is currently in progress,
    // reject autonomous proposal registration to prevent race conditions that overwrite or interfere with the inline operation.
    if (this.isGenerationActive) {
      vscode.window.showWarningMessage(
        'TrueForge: An inline edit operation is currently in progress. Autonomous proposals cannot be registered until generation completes.'
      );
      return false;
    }

    // 3. Security boundary validation: fail closed if outside workspace boundary
    if (!this.contextAssembler.getDiscovery().isPathWithinWorkspace(absolutePath)) {
      vscode.window.showErrorMessage(
        `TrueForge Security: Proposal rejected. Target "${absolutePath}" is outside the active workspace boundary.`
      );
      return false;
    }

    const originalUri = vscode.Uri.file(absolutePath);
    let originalText = '';
    let doc: vscode.TextDocument | undefined;
    let range: vscode.Range;

    const fileExists = fs.existsSync(absolutePath);
    let originalDiskHash: string | undefined;
    if (fileExists) {
      try {
        const diskContent = fs.readFileSync(absolutePath, 'utf8');
        originalDiskHash = computeContentHash(diskContent);
      } catch {
        originalDiskHash = undefined;
      }
    }

    if (fileExists) {
      try {
        doc = await vscode.workspace.openTextDocument(originalUri);
        originalText = doc.getText();
      } catch {
        originalText = fs.readFileSync(absolutePath, 'utf8');
      }
    } else {
      originalText = '';
    }

    const isTargeted = options?.startLine !== undefined && options?.endLine !== undefined;
    let replacementSnippet: string = replacementCode;
    let diffDocumentText: string;

    if (isTargeted) {
      const startLine = options!.startLine!;
      const endLine = options!.endLine!;
      const lineCount = doc ? doc.lineCount : originalText.split(/\r?\n/).length;
      const startPos = new vscode.Position(startLine - 1, 0);

      const hasCRLF = originalText.includes('\r\n');
      const eol = hasCRLF ? '\r\n' : '\n';

      let endPos: vscode.Position;
      if (endLine < lineCount) {
        endPos = new vscode.Position(endLine, 0);
        replacementSnippet = (replacementCode.endsWith('\n') || replacementCode.endsWith('\r'))
          ? replacementCode
          : replacementCode + eol;
      } else {
        const lastLineIndex = Math.max(0, lineCount - 1);
        if (doc) {
          endPos = doc.lineAt(lastLineIndex).range.end;
        } else {
          const lines = originalText.split(/\r?\n/);
          endPos = new vscode.Position(lastLineIndex, (lines[lastLineIndex] || '').length);
        }
        if (originalText.endsWith('\n') || originalText.endsWith('\r')) {
          replacementSnippet = (replacementCode.endsWith('\n') || replacementCode.endsWith('\r'))
            ? replacementCode
            : replacementCode + eol;
        } else {
          replacementSnippet = replacementCode;
        }
      }

      range = new vscode.Range(startPos, endPos);
      diffDocumentText = options?.fullProposedText !== undefined ? options.fullProposedText : replacementCode;
    } else {
      if (doc) {
        const lastLineIndex = Math.max(0, doc.lineCount - 1);
        const lastLine = doc.lineAt(lastLineIndex);
        range = new vscode.Range(new vscode.Position(0, 0), lastLine.range.end);
      } else if (originalText) {
        const lines = originalText.split(/\r?\n/);
        const lastLineIndex = Math.max(0, lines.length - 1);
        range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(lastLineIndex, (lines[lastLineIndex] || '').length));
      } else {
        range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
      }
      diffDocumentText = replacementCode;
      replacementSnippet = replacementCode;
    }

    // Guard against race conditions during async document loading
    if ((this.activePendingEdit && !options?.allowQueue) || this.isGenerationActive) {
      vscode.window.showWarningMessage(
        'TrueForge: A proposed edit is already awaiting review or in progress. Autonomous proposal registration was cancelled.'
      );
      return false;
    }

    const fileName = path.basename(absolutePath);
    const diffUri = vscode.Uri.parse(`${InlineEditManager.SCHEME}://proposed/${fileName}`);
    this.proposedDocs.set(diffUri.toString(), diffDocumentText);
    this._onDidChange.fire(diffUri);

    const originalDocumentVersion = doc && typeof doc.version === 'number' ? doc.version : undefined;
    const originalDocumentHash = computeContentHash(originalText);
    const isInitiallyDirty = Boolean(doc?.isDirty);

    const newPendingEdit: PendingEdit = {
      documentUri: originalUri,
      range,
      originalSelectionText: doc ? doc.getText(range) : originalText,
      replacementText: replacementSnippet,
      diffUri,
      originalDocumentVersion,
      originalDocumentHash,
      originalDiskHash,
      isInitiallyDirty,
      fileExistsInitially: fileExists
    };

    const key = this.getPendingKey(originalUri);
    this.pendingEdits.set(key, newPendingEdit);
    this.activePendingEdit = newPendingEdit;

    // Enable toolbar actions and status bar review button
    await vscode.commands.executeCommand('setContext', 'trueforge.hasPendingEdit', true);
    this.updateReviewStatusBarItem();

    // Open side-by-side diff
    const count = this.pendingEdits.size;
    const diffTitle = count > 1
      ? `${fileName} (Original) ↔ ${fileName} (TrueForge Staged [${count} files pending])`
      : `${fileName} (Original) ↔ ${fileName} (TrueForge Proposal)`;

    await vscode.commands.executeCommand('vscode.diff', originalUri, diffUri, diffTitle, {
      preview: true
    });

    return true;
  }

  /**
   * Detects whether the underlying document or file has changed since the proposal was generated.
   * Compares document buffer hash, selection range content, disk content hash, and version safely
   * using standard VS Code APIs without false conflicts on dirty or reopened documents.
   */
  public async detectDocumentConflict(target: PendingEdit): Promise<boolean> {
    const hasBaseline = target.originalDocumentHash !== undefined || target.originalDocumentVersion !== undefined;
    if (!hasBaseline) {
      return false;
    }

    const fsPath = target.documentUri.fsPath;
    const existsNow = fs.existsSync(fsPath);

    // If file existed initially but was deleted on disk
    if (target.fileExistsInitially === true && !existsNow) {
      return true;
    }

    // If file did not exist initially but was created on disk
    if (target.fileExistsInitially === false && existsNow) {
      return true;
    }

    // Check external disk modifications:
    // If the file exists on disk and we captured a baseline disk hash:
    if (existsNow && target.originalDiskHash !== undefined) {
      try {
        const currentDiskText = fs.readFileSync(fsPath, 'utf8');
        const currentDiskHash = computeContentHash(currentDiskText);
        if (currentDiskHash !== target.originalDiskHash) {
          // The file on disk differs from the original disk baseline!
          // If the document was initially dirty and the user subsequently saved it in the editor,
          // the disk content will now match target.originalDocumentHash. That is not an external conflict.
          // However, if currentDiskHash matches neither the original disk content nor the original buffer content,
          // it was modified by an external process or conflicting edit!
          if (currentDiskHash !== target.originalDocumentHash) {
            return true;
          }
        }
      } catch {
        return true;
      }
    }

    // Check active open document in VS Code workspace
    // Standard VS Code API: vscode.workspace.textDocuments contains all currently open documents
    const openDoc = vscode.workspace.textDocuments?.find(
      (d) => d.uri.toString() === target.documentUri.toString() || d.uri.fsPath === fsPath
    );

    if (openDoc) {
      // 1. Check in-memory buffer content hash
      if (target.originalDocumentHash !== undefined) {
        const currentBufferHash = computeContentHash(openDoc.getText());
        if (currentBufferHash !== target.originalDocumentHash) {
          return true; // Editor buffer was modified
        }
      }

      // 2. Check target selection range content
      if (target.originalSelectionText !== undefined) {
        try {
          const currentRangeText = openDoc.getText(target.range);
          if (currentRangeText !== target.originalSelectionText) {
            return true; // Target range content was modified
          }
        } catch {
          return true;
        }
      }

      // 3. Check version change safely:
      // In VS Code, openTextDocument() reopens a closed document with version 1.
      // Therefore, if openDoc.version <= target.originalDocumentVersion, the document may have
      // been closed and reopened (reopening resets version to 1). If the content hash matched above,
      // the reopened document is identical and unchanged!
      // Only when openDoc.version strictly exceeds target.originalDocumentVersion in an active session
      // does it indicate subsequent user edits in the editor.
      if (
        target.originalDocumentVersion !== undefined &&
        typeof openDoc.version === 'number' &&
        openDoc.version > target.originalDocumentVersion
      ) {
        return true;
      }
    } else {
      // Document is currently closed in the workspace.
      // In VS Code, when a document is closed, there is no active editor buffer.
      // If the file exists on disk:
      if (existsNow) {
        try {
          const currentDiskText = fs.readFileSync(fsPath, 'utf8');
          const currentDiskHash = computeContentHash(currentDiskText);
          // If the disk content does not match the proposal's baseline content hash,
          // the closed document content differs from what the proposal was generated on.
          if (target.originalDocumentHash !== undefined && currentDiskHash !== target.originalDocumentHash) {
            return true;
          }
        } catch {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Applies the accepted replacement directly to the target document.
   */
  public async applyEdit(pending?: PendingEdit | null): Promise<boolean> {
    // 1. If an explicit proposal is supplied:
    if (pending !== undefined && pending !== null) {
      const key = this.getPendingKey(pending.documentUri);
      const isQueued = this.pendingEdits.get(key) === pending;
      if (this.activePendingEdit !== pending && !isQueued) {
        vscode.window.showWarningMessage(
          'TrueForge: Cannot apply stale proposal. The proposed edit is no longer active.'
        );
        return false;
      }
      if (isQueued && this.activePendingEdit !== pending) {
        this.activePendingEdit = pending;
      }
    }

    const target = pending ?? this.activePendingEdit;
    if (!target) {
      vscode.window.showWarningMessage('TrueForge: No active proposal to accept.');
      return false;
    }

    // Security boundary validation: final application gate
    if (!this.contextAssembler.getDiscovery().isPathWithinWorkspace(target.documentUri.fsPath)) {
      this.cleanupPending(target);
      vscode.window.showErrorMessage(
        `TrueForge Security: Cannot apply edit. Target "${target.documentUri.fsPath}" is outside the active workspace boundary.`
      );
      return false;
    }

    // Concurrent edit conflict protection:
    // If the file or document changed since the proposal was generated, reject application
    if (await this.detectDocumentConflict(target)) {
      this.cleanupPending(target);
      vscode.window.showWarningMessage(
        'TrueForge: The file has changed since the proposed edit was generated. Proposed changes were rejected to prevent overwriting your edits. Please regenerate the edit.'
      );
      return false;
    }

    // Post-await active proposal verification: protect against active proposal changing while awaiting conflict detection
    if (this.activePendingEdit !== target) {
      vscode.window.showWarningMessage(
        'TrueForge: Cannot apply stale proposal. The active proposal changed during verification.'
      );
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
    if (pending !== undefined && pending !== null) {
      const key = this.getPendingKey(pending.documentUri);
      const isQueued = this.pendingEdits.get(key) === pending;
      if (isQueued && this.activePendingEdit !== pending) {
        this.activePendingEdit = pending;
      }
    }

    const target = pending ?? this.activePendingEdit;
    if (!target) {
      vscode.window.showWarningMessage('TrueForge: No active proposal to reject.');
      return;
    }

    this.cleanupPending(target);
    vscode.window.showInformationMessage('TrueForge: Proposed changes rejected. Original file left completely untouched.');
  }

  /**
   * Applies all currently queued proposals across all documents in order.
   */
  public async applyAllPendingEdits(): Promise<{ successful: number; failed: number }> {
    let successful = 0;
    let failed = 0;
    const all = Array.from(this.pendingEdits.values());
    for (const proposal of all) {
      this.activePendingEdit = proposal;
      const ok = await this.applyEdit(proposal);
      if (ok) {
        successful++;
      } else {
        failed++;
      }
    }
    return { successful, failed };
  }

  /**
   * Rejects all currently queued proposals, leaving all workspace files completely untouched.
   */
  public rejectAllPendingEdits(): void {
    const all = Array.from(this.pendingEdits.values());
    for (const proposal of all) {
      this.rejectEdit(proposal);
    }
    this.pendingEdits.clear();
    this.activePendingEdit = null;
  }

  public updateReviewStatusBarItem(): void {
    if (!this.reviewStatusBarItem) {
      this.reviewStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
      this.reviewStatusBarItem.command = 'trueforge.reviewPendingEdit';
    }
    const count = this.pendingEdits.size;
    if (count <= 1 && this.activePendingEdit) {
      const fileName = path.basename(this.activePendingEdit.documentUri.fsPath);
      this.reviewStatusBarItem.text = `$(git-compare) TrueForge: Review ${fileName} [Accept | Reject]`;
    } else if (count > 1) {
      this.reviewStatusBarItem.text = `$(git-compare) TrueForge: Review ${count} files [Accept All | Review]`;
    }
    this.reviewStatusBarItem.tooltip = 'Click to open TrueForge Accept / Reject Review dialog';
    this.reviewStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.reviewStatusBarItem.show();
  }

  private showReviewStatusBarItem(_fileName: string): void {
    this.updateReviewStatusBarItem();
  }

  /**
   * Cleans up pending proposal state in an ownership-safe manner.
   * If a specific `pending` proposal is provided:
   * - Only clears `activePendingEdit`, disposes the review status bar, and resets `trueforge.hasPendingEdit`
   *   when `this.activePendingEdit === pending`.
   * - Deletes the supplied proposal's own virtual diff document, but never deletes or invalidates
   *   another proposal's active virtual diff document.
   * If `pending` is null or undefined (explicit global cleanup):
   * - Cleans up whatever active proposal exists, clears state, disposes status bar, and resets context key.
   */
  public cleanupPending(pending?: PendingEdit | null): void {
    if (pending) {
      const isOwner = this.activePendingEdit === pending;

      // Delete the proposal's own virtual diff document,
      // but never delete or invalidate another proposal's active diff.
      if (pending.diffUri) {
        const isDiffSharedWithActive =
          !isOwner &&
          this.activePendingEdit !== null &&
          this.activePendingEdit.diffUri.toString() === pending.diffUri.toString();

        if (!isDiffSharedWithActive) {
          this.proposedDocs.delete(pending.diffUri.toString());
          this._onDidChange.fire(pending.diffUri);
        }
      }

      // If it was in the pending queue, remove it (checking values to handle mutated URIs)
      for (const [k, p] of this.pendingEdits.entries()) {
        if (p === pending) {
          this.pendingEdits.delete(k);
          break;
        }
      }

      // Only clear active review state if this proposal actually owns it
      if (isOwner) {
        if (this.pendingEdits.size > 0) {
          // Advance to the next pending proposal in queue
          const nextProposal = this.pendingEdits.values().next().value;
          this.activePendingEdit = nextProposal ?? null;
          if (this.activePendingEdit) {
            this.updateReviewStatusBarItem();
          }
        } else {
          this.activePendingEdit = null;
          if (this.reviewStatusBarItem) {
            this.reviewStatusBarItem.dispose();
            this.reviewStatusBarItem = undefined;
          }
          vscode.commands.executeCommand('setContext', 'trueforge.hasPendingEdit', false);
        }
      }
    } else {
      // Explicit global cleanup
      for (const p of this.pendingEdits.values()) {
        if (p.diffUri) {
          this.proposedDocs.delete(p.diffUri.toString());
          this._onDidChange.fire(p.diffUri);
        }
      }
      this.pendingEdits.clear();

      if (this.activePendingEdit?.diffUri) {
        this.proposedDocs.delete(this.activePendingEdit.diffUri.toString());
        this._onDidChange.fire(this.activePendingEdit.diffUri);
      }
      this.activePendingEdit = null;

      if (this.reviewStatusBarItem) {
        this.reviewStatusBarItem.dispose();
        this.reviewStatusBarItem = undefined;
      }

      vscode.commands.executeCommand('setContext', 'trueforge.hasPendingEdit', false);
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
