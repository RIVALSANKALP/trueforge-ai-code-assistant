import * as path from 'path';
import { WorkspaceContextDiscovery } from './WorkspaceContextDiscovery.js';

export interface ContextAssemblerOptions {
  maxTokenBudget?: number;
  approxCharsPerToken?: number;
  surroundingContextLines?: number;
}

export interface ActiveEditorInput {
  documentUri: string;
  documentText: string;
  languageId: string;
  selectionText: string;
  selectionStartLine: number;
  selectionEndLine: number;
}

export interface AssembledContext {
  activeFilePath: string;
  languageId: string;
  selectionText: string;
  selectionStartLine: number;
  selectionEndLine: number;
  isFullFile: boolean;
  surroundingPrefix: string;
  surroundingSuffix: string;
  relevantFiles: Array<{ relativePath: string; score: number; lineCount: number }>;
  estimatedTokens: number;
  formattedMarkdown: string;
}

export class ContextAssembler {
  private readonly discovery: WorkspaceContextDiscovery;
  private readonly maxTokenBudget: number;
  private readonly approxCharsPerToken: number;
  private readonly surroundingLines: number;

  constructor(discovery: WorkspaceContextDiscovery, options?: ContextAssemblerOptions) {
    this.discovery = discovery;
    this.maxTokenBudget = options?.maxTokenBudget ?? 3500;
    this.approxCharsPerToken = options?.approxCharsPerToken ?? 4;
    this.surroundingLines = options?.surroundingContextLines ?? 20;
  }

  /**
   * Assembles prioritized context for code editing, enforcing the token budget.
   */
  public async assembleContext(
    input: ActiveEditorInput,
    userInstruction: string
  ): Promise<AssembledContext> {
    const totalCharBudget = this.maxTokenBudget * this.approxCharsPerToken;
    let remainingBudget = totalCharBudget;

    const workspaceRoot = this.discovery.getWorkspaceRoot();
    const relativeActivePath = path.relative(workspaceRoot, input.documentUri).replace(/\\/g, '/');

    // 1. Determine Selection vs Entire Document
    const allLines = input.documentText.split(/\r?\n/);
    let selectionText = input.selectionText;
    let isFullFile = false;
    let startLine = input.selectionStartLine;
    let endLine = input.selectionEndLine;

    if (!selectionText || selectionText.trim().length === 0) {
      // Empty selection: use full file if within budget, otherwise notify
      isFullFile = true;
      selectionText = input.documentText;
      startLine = 1;
      endLine = allLines.length;
    }

    // Deduct selection from budget (Priority 1)
    remainingBudget -= selectionText.length;

    // 2. Extract Surrounding Context (Priority 2)
    let surroundingPrefix = '';
    let surroundingSuffix = '';

    if (!isFullFile && remainingBudget > 500) {
      const prefixStart = Math.max(0, startLine - 1 - this.surroundingLines);
      const prefixEnd = Math.max(0, startLine - 1);
      if (prefixEnd > prefixStart) {
        surroundingPrefix = allLines.slice(prefixStart, prefixEnd).join('\n');
      }

      const suffixStart = Math.min(allLines.length, endLine);
      const suffixEnd = Math.min(allLines.length, endLine + this.surroundingLines);
      if (suffixEnd > suffixStart) {
        surroundingSuffix = allLines.slice(suffixStart, suffixEnd).join('\n');
      }

      // Truncate surrounding context if needed
      const surroundingTotal = surroundingPrefix.length + surroundingSuffix.length;
      if (surroundingTotal > remainingBudget * 0.4) {
        surroundingPrefix = surroundingPrefix.slice(-Math.floor(remainingBudget * 0.2));
        surroundingSuffix = surroundingSuffix.slice(0, Math.floor(remainingBudget * 0.2));
      }

      remainingBudget -= surroundingPrefix.length + surroundingSuffix.length;
    }

    // 3. Find and Append Relevant Workspace Files (Priority 3)
    const relevantFilesSummary: Array<{ relativePath: string; score: number; lineCount: number }> = [];
    const formattedRelatedFiles: string[] = [];

    if (remainingBudget > 800) {
      const foundFiles = await this.discovery.findRelevantFiles(userInstruction, relativeActivePath, 4);

      for (const file of foundFiles) {
        if (remainingBudget < 400) {
          break;
        }

        // Allocate a slice of remaining budget to each file
        const maxSnippetLength = Math.min(file.content.length, Math.floor(remainingBudget * 0.5));
        let snippet = file.content.slice(0, maxSnippetLength);
        if (snippet.length < file.content.length) {
          snippet += '\n// ... [truncated for context budget]';
        }

        remainingBudget -= snippet.length;
        relevantFilesSummary.push({
          relativePath: file.relativePath,
          score: file.score,
          lineCount: file.lineCount
        });

        const ext = path.extname(file.relativePath).slice(1) || 'text';
        formattedRelatedFiles.push(
          `### Related File: \`${file.relativePath}\` (Score: ${file.score})\n\`\`\`${ext}\n${snippet}\n\`\`\``
        );
      }
    }

    // 4. Build Structured Markdown Representation
    const markdownParts: string[] = [];
    markdownParts.push(`## Active File: \`${relativeActivePath}\` (${input.languageId})`);
    markdownParts.push(`Line range: ${startLine} to ${endLine} ${isFullFile ? '(Entire File)' : ''}`);

    if (surroundingPrefix) {
      markdownParts.push(`### Preceding Context (lines ${Math.max(1, startLine - this.surroundingLines)} to ${startLine - 1}):`);
      markdownParts.push(`\`\`\`${input.languageId}\n${surroundingPrefix}\n\`\`\``);
    }

    markdownParts.push(`### Target Code to Replace (lines ${startLine} to ${endLine}):`);
    markdownParts.push(`\`\`\`${input.languageId}\n${selectionText}\n\`\`\``);

    if (surroundingSuffix) {
      markdownParts.push(`### Following Context (lines ${endLine + 1} to ${Math.min(allLines.length, endLine + this.surroundingLines)}):`);
      markdownParts.push(`\`\`\`${input.languageId}\n${surroundingSuffix}\n\`\`\``);
    }

    if (formattedRelatedFiles.length > 0) {
      markdownParts.push(`## Related Workspace Files:\n${formattedRelatedFiles.join('\n\n')}`);
    }

    const fullMarkdown = markdownParts.join('\n\n');
    const estimatedTokens = Math.ceil(fullMarkdown.length / this.approxCharsPerToken);

    return {
      activeFilePath: relativeActivePath,
      languageId: input.languageId,
      selectionText,
      selectionStartLine: startLine,
      selectionEndLine: endLine,
      isFullFile,
      surroundingPrefix,
      surroundingSuffix,
      relevantFiles: relevantFilesSummary,
      estimatedTokens,
      formattedMarkdown: fullMarkdown
    };
  }

  public estimateTokens(text: string): number {
    return Math.ceil(text.length / this.approxCharsPerToken);
  }
}
