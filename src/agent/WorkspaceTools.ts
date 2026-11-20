import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceContextDiscovery } from '../context/WorkspaceContextDiscovery.js';

export interface ToolExecutionResult {
  success: boolean;
  toolName: string;
  output: string;
  error?: string;
  data?: any;
}

export interface ProposeEditResult {
  relativePath: string;
  absolutePath: string;
  replacementCode: string;
  explanation: string;
  originalText: string;
  fullProposedText: string;
}

export class WorkspaceTools {
  private readonly discovery: WorkspaceContextDiscovery;
  private readonly workspaceRoot: string;

  constructor(discovery: WorkspaceContextDiscovery) {
    this.discovery = discovery;
    this.workspaceRoot = discovery.getWorkspaceRoot();
  }

  public getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  /**
   * Tool 1: list_files
   * Lists files in the workspace or subfolder, filtering out ignored and secret files.
   */
  public async listFiles(args: { directory?: string; recursive?: boolean }): Promise<ToolExecutionResult> {
    try {
      if (!this.discovery.isWorkspaceAvailable()) {
        return {
          success: false,
          toolName: 'list_files',
          output: 'Access denied: No workspace folder is open. Please open a project folder in VS Code to use TrueForge workspace tools.',
          error: 'NO_WORKSPACE'
        };
      }

      const subDir = args.directory ? path.resolve(this.workspaceRoot, args.directory) : this.workspaceRoot;

      if (!this.discovery.isPathWithinWorkspace(subDir)) {
        return {
          success: false,
          toolName: 'list_files',
          output: 'Access denied: Target directory is outside the active workspace boundary.',
          error: 'OUT_OF_BOUNDS'
        };
      }

      const allFiles = await this.discovery.discoverFiles({ maxFiles: 100 });
      let filtered = allFiles;

      if (args.directory && args.directory !== '.' && args.directory !== '/') {
        const normalizedSub = args.directory.replace(/\\/g, '/').replace(/^\//, '').replace(/\/$/, '');
        filtered = allFiles.filter((f) => f.relativePath.startsWith(normalizedSub + '/'));
      }

      if (filtered.length === 0) {
        return {
          success: true,
          toolName: 'list_files',
          output: 'No files found matching criteria (or all matching files are ignored).'
        };
      }

      const outputLines = filtered.map((f) => `- ${f.relativePath} (${Math.round(f.sizeBytes / 1024)} KB)`);
      return {
        success: true,
        toolName: 'list_files',
        output: `Discovered ${filtered.length} files:\n${outputLines.join('\n')}`,
        data: filtered.map((f) => f.relativePath)
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, toolName: 'list_files', output: `Error listing files: ${msg}`, error: msg };
    }
  }

  /**
   * Tool 2: read_file
   * Reads file content within workspace boundaries with line numbers and optional range.
   */
  public async readFile(args: { path: string; startLine?: number; endLine?: number }): Promise<ToolExecutionResult> {
    try {
      if (!this.discovery.isWorkspaceAvailable()) {
        return {
          success: false,
          toolName: 'read_file',
          output: 'Access denied: No workspace folder is open. Please open a project folder in VS Code to use TrueForge workspace tools.',
          error: 'NO_WORKSPACE'
        };
      }

      if (!args.path) {
        return { success: false, toolName: 'read_file', output: 'Missing required argument: path', error: 'MISSING_ARG' };
      }

      const targetPath = path.resolve(this.workspaceRoot, args.path);

      // Boundary check
      if (!this.discovery.isPathWithinWorkspace(targetPath)) {
        return {
          success: false,
          toolName: 'read_file',
          output: `Access denied: Path "${args.path}" resolves outside the active workspace boundary.`,
          error: 'OUT_OF_BOUNDS'
        };
      }

      // Secret & Ignore check
      const relative = path.relative(this.workspaceRoot, targetPath).replace(/\\/g, '/');
      const fileName = path.basename(targetPath);
      if (this.discovery.shouldIgnoreFile(fileName, relative)) {
        return {
          success: false,
          toolName: 'read_file',
          output: `Access denied: File "${relative}" is an ignored or protected secret file.`,
          error: 'ACCESS_RESTRICTED'
        };
      }

      if (!fs.existsSync(targetPath)) {
        return {
          success: false,
          toolName: 'read_file',
          output: `File not found: "${relative}"`,
          error: 'FILE_NOT_FOUND'
        };
      }

      const content = fs.readFileSync(targetPath, 'utf8');
      const lines = content.split(/\r?\n/);
      const totalLines = lines.length;

      const start = Math.max(1, args.startLine ?? 1);
      const end = Math.min(totalLines, args.endLine ?? totalLines);

      if (start > totalLines) {
        return {
          success: false,
          toolName: 'read_file',
          output: `startLine (${start}) exceeds file length (${totalLines} lines).`,
          error: 'OUT_OF_RANGE'
        };
      }

      const selectedLines = lines.slice(start - 1, end);
      const formatted = selectedLines
        .map((line, idx) => `${(start + idx).toString().padStart(4, ' ')} | ${line}`)
        .join('\n');

      return {
        success: true,
        toolName: 'read_file',
        output: `File: ${relative} (Lines ${start}-${end} of ${totalLines}):\n${formatted}`,
        data: { relativePath: relative, startLine: start, endLine: end, totalLines, rawContent: content }
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, toolName: 'read_file', output: `Error reading file: ${msg}`, error: msg };
    }
  }

  /**
   * Tool 3: search_code
   * Searches for matching text in workspace files.
   */
  public async searchCode(args: { query: string; maxMatches?: number }): Promise<ToolExecutionResult> {
    try {
      if (!this.discovery.isWorkspaceAvailable()) {
        return {
          success: false,
          toolName: 'search_code',
          output: 'Access denied: No workspace folder is open. Please open a project folder in VS Code to use TrueForge workspace tools.',
          error: 'NO_WORKSPACE'
        };
      }

      if (!args.query || args.query.trim().length === 0) {
        return { success: false, toolName: 'search_code', output: 'Missing search query', error: 'MISSING_QUERY' };
      }

      const maxMatches = args.maxMatches ?? 20;
      const allFiles = await this.discovery.discoverFiles({ maxFiles: 100 });
      const results: Array<{ file: string; line: number; text: string }> = [];
      const lowerQuery = args.query.toLowerCase();

      for (const file of allFiles) {
        if (results.length >= maxMatches) break;

        try {
          const content = fs.readFileSync(file.absolutePath, 'utf8');
          const lines = content.split(/\r?\n/);

          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(lowerQuery)) {
              results.push({
                file: file.relativePath,
                line: i + 1,
                text: lines[i].trim()
              });
              if (results.length >= maxMatches) break;
            }
          }
        } catch {
          // Skip unreadable files
        }
      }

      if (results.length === 0) {
        return {
          success: true,
          toolName: 'search_code',
          output: `No occurrences of "${args.query}" found in workspace text files.`
        };
      }

      const formatted = results
        .map((r) => `${r.file}:${r.line}: ${r.text}`)
        .join('\n');

      return {
        success: true,
        toolName: 'search_code',
        output: `Found ${results.length} matches for "${args.query}":\n${formatted}`,
        data: results
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, toolName: 'search_code', output: `Error searching code: ${msg}`, error: msg };
    }
  }

  /**
   * Tool 4: propose_edit
   * Validates target file, prepares replacement, and stages a safe diff proposal.
   */
  public async proposeEdit(args: {
    path: string;
    replacementCode: string;
    explanation: string;
  }): Promise<ToolExecutionResult> {
    try {
      if (!this.discovery.isWorkspaceAvailable()) {
        return {
          success: false,
          toolName: 'propose_edit',
          output: 'Access denied: No workspace folder is open. Please open a project folder in VS Code to use TrueForge workspace tools.',
          error: 'NO_WORKSPACE'
        };
      }

      if (!args.path || args.replacementCode === undefined) {
        return {
          success: false,
          toolName: 'propose_edit',
          output: 'Missing required arguments: path and replacementCode',
          error: 'MISSING_ARG'
        };
      }

      const targetPath = path.resolve(this.workspaceRoot, args.path);

      if (!this.discovery.isPathWithinWorkspace(targetPath)) {
        return {
          success: false,
          toolName: 'propose_edit',
          output: `Access denied: Path "${args.path}" resolves outside the active workspace boundary.`,
          error: 'OUT_OF_BOUNDS'
        };
      }

      const relative = path.relative(this.workspaceRoot, targetPath).replace(/\\/g, '/');
      const fileName = path.basename(targetPath);

      if (this.discovery.shouldIgnoreFile(fileName, relative)) {
        return {
          success: false,
          toolName: 'propose_edit',
          output: `Access denied: Cannot modify protected file "${relative}".`,
          error: 'PROTECTED_FILE'
        };
      }

      if (!fs.existsSync(targetPath)) {
        return {
          success: false,
          toolName: 'propose_edit',
          output: `Target file not found: "${relative}". TrueForge edits require an existing file.`,
          error: 'FILE_NOT_FOUND'
        };
      }

      const originalText = fs.readFileSync(targetPath, 'utf8');
      const editResult: ProposeEditResult = {
        relativePath: relative,
        absolutePath: targetPath,
        replacementCode: args.replacementCode,
        explanation: args.explanation || 'Proposed code modifications',
        originalText,
        fullProposedText: args.replacementCode
      };

      return {
        success: true,
        toolName: 'propose_edit',
        output: `Proposed modifications staged for "${relative}". User diff review required.`,
        data: editResult
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, toolName: 'propose_edit', output: `Error staging edit: ${msg}`, error: msg };
    }
  }

  /**
   * Executes a tool by name with arguments.
   */
  public async executeTool(name: string, args: any): Promise<ToolExecutionResult> {
    switch (name) {
      case 'list_files':
        return this.listFiles(args || {});
      case 'read_file':
        return this.readFile(args || {});
      case 'search_code':
        return this.searchCode(args || {});
      case 'propose_edit':
        return this.proposeEdit(args || {});
      default:
        return {
          success: false,
          toolName: name,
          output: `Unknown tool: "${name}". Available tools: list_files, read_file, search_code, propose_edit.`,
          error: 'UNKNOWN_TOOL'
        };
    }
  }
}
