import * as fs from 'fs';
import * as path from 'path';

export interface DiscoveredFile {
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
}

export interface RelevantFileResult {
  relativePath: string;
  score: number;
  content: string;
  lineCount: number;
}

export class WorkspaceContextDiscovery {
  private readonly workspaceRoot: string;
  private readonly ignoreRules: string[] = [];

  // Built-in directory exclusions
  private static readonly DEFAULT_IGNORED_DIRS = new Set([
    'node_modules',
    '.git',
    'dist',
    'out',
    'build',
    '.vscode',
    '.vscode-test',
    'coverage',
    '.nyc_output',
    '.turbo',
    '.next',
    'data',
    '.backup',
    '__pycache__'
  ]);

  // Binary file extensions to exclude
  private static readonly BINARY_EXTENSIONS = new Set([
    '.exe', '.dll', '.so', '.dylib', '.bin',
    '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar', '.iso',
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.svg', '.bmp',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.wasm', '.mp3', '.mp4', '.avi', '.mov',
    '.sqlite', '.sqlite-wal', '.sqlite-shm', '.db'
  ]);

  // Secret file patterns to exclude
  private static readonly SECRET_PATTERNS = [
    /^\.env/i,
    /\.(pem|key|token|cert|pfx|pkcs12)$/i,
    /id_rsa/i,
    /credentials/i,
    /secret/i
  ];

  constructor(workspaceRoot?: string) {
    if (!workspaceRoot || !workspaceRoot.trim()) {
      this.workspaceRoot = '';
      return;
    }
    this.workspaceRoot = path.resolve(workspaceRoot);
    if (fs.existsSync(this.workspaceRoot)) {
      this.loadGitignore();
    }
  }

  public isWorkspaceAvailable(): boolean {
    return Boolean(this.workspaceRoot && this.workspaceRoot.length > 0 && fs.existsSync(this.workspaceRoot));
  }

  public getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  /**
   * Enforces that the target path is strictly within the workspace boundary
   * and prevents directory traversal attacks.
   */
  public isPathWithinWorkspace(targetPath: string): boolean {
    if (!this.isWorkspaceAvailable() || !targetPath || !targetPath.trim()) {
      return false;
    }
    const resolved = path.resolve(this.workspaceRoot, targetPath);
    const rootWithSep = this.workspaceRoot.endsWith(path.sep)
      ? this.workspaceRoot
      : this.workspaceRoot + path.sep;
    return resolved === this.workspaceRoot || resolved.startsWith(rootWithSep);
  }

  /**
   * Discovers text files in the workspace, respecting gitignore and security rules.
   */
  public async discoverFiles(options?: { maxFiles?: number; maxFileSizeBytes?: number }): Promise<DiscoveredFile[]> {
    if (!this.isWorkspaceAvailable()) {
      return [];
    }
    const maxFiles = options?.maxFiles ?? 500;
    const maxSizeBytes = options?.maxFileSizeBytes ?? 256 * 1024; // 256 KB default limit
    const results: DiscoveredFile[] = [];

    const scanDirectory = (dir: string) => {
      if (results.length >= maxFiles) {
        return;
      }

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (results.length >= maxFiles) {
          break;
        }

        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(this.workspaceRoot, fullPath).replace(/\\/g, '/');

        if (!this.isPathWithinWorkspace(fullPath)) {
          continue;
        }

        if (entry.isDirectory()) {
          if (this.shouldIgnoreDirectory(entry.name, relativePath)) {
            continue;
          }
          scanDirectory(fullPath);
        } else if (entry.isFile()) {
          if (this.shouldIgnoreFile(entry.name, relativePath)) {
            continue;
          }

          try {
            const stat = fs.statSync(fullPath);
            if (stat.size <= maxSizeBytes) {
              results.push({
                relativePath,
                absolutePath: fullPath,
                sizeBytes: stat.size
              });
            }
          } catch {
            // Ignore unreadable files
          }
        }
      }
    };

    scanDirectory(this.workspaceRoot);
    return results;
  }

  /**
   * Ranks workspace files by relevance to a user query or editing instruction.
   */
  public async findRelevantFiles(
    query: string,
    activeFilePath?: string,
    maxResults = 5
  ): Promise<RelevantFileResult[]> {
    if (!this.isWorkspaceAvailable()) {
      return [];
    }
    const allFiles = await this.discoverFiles({ maxFiles: 200 });
    const keywords = this.extractKeywords(query);

    const scoredResults: RelevantFileResult[] = [];
    const activeExt = activeFilePath ? path.extname(activeFilePath).toLowerCase() : '';
    const normalizedActivePath = activeFilePath ? activeFilePath.replace(/\\/g, '/') : '';

    for (const file of allFiles) {
      // Don't include the active file itself in the "related files" list
      if (normalizedActivePath && file.relativePath.toLowerCase() === normalizedActivePath.toLowerCase()) {
        continue;
      }

      let score = 0;
      const lowerRelPath = file.relativePath.toLowerCase();
      const fileExt = path.extname(file.relativePath).toLowerCase();

      // 1. Same extension as active editor
      if (activeExt && fileExt === activeExt) {
        score += 3;
      }

      // 2. Keyword matches in filename / path (high weight)
      for (const kw of keywords) {
        if (lowerRelPath.includes(kw)) {
          score += 10;
        }
      }

      // 3. Keyword matches in content (sampled from first 30KB)
      let content = '';
      try {
        content = fs.readFileSync(file.absolutePath, 'utf8');
      } catch {
        continue;
      }

      const lowerContent = content.slice(0, 30000).toLowerCase();
      for (const kw of keywords) {
        const matches = (lowerContent.match(new RegExp('\\b' + this.escapeRegex(kw) + '\\b', 'g')) || []).length;
        score += Math.min(matches * 2, 10);
      }

      if (score > 0) {
        const lines = content.split('\n');
        scoredResults.push({
          relativePath: file.relativePath,
          score,
          content,
          lineCount: lines.length
        });
      }
    }

    // Sort descending by score
    scoredResults.sort((a, b) => b.score - a.score);
    return scoredResults.slice(0, maxResults);
  }

  private loadGitignore(): void {
    if (!this.workspaceRoot) {
      return;
    }
    const gitignorePath = path.join(this.workspaceRoot, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      return;
    }

    try {
      const content = fs.readFileSync(gitignorePath, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let line of lines) {
        line = line.trim();
        if (line && !line.startsWith('#')) {
          this.ignoreRules.push(line);
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  public shouldIgnoreDirectory(dirName: string, relativePath: string): boolean {
    if (WorkspaceContextDiscovery.DEFAULT_IGNORED_DIRS.has(dirName.toLowerCase())) {
      return true;
    }

    const normalized = relativePath.replace(/\\/g, '/');
    for (const rule of this.ignoreRules) {
      const cleanRule = rule.replace(/\/$/, '').replace(/^\//, '');
      if (normalized === cleanRule || normalized.startsWith(cleanRule + '/')) {
        return true;
      }
      if (dirName.toLowerCase() === cleanRule.toLowerCase()) {
        return true;
      }
    }

    return false;
  }

  public shouldIgnoreFile(fileName: string, relativePath: string): boolean {
    // 1. Binary extensions
    const ext = path.extname(fileName).toLowerCase();
    if (WorkspaceContextDiscovery.BINARY_EXTENSIONS.has(ext)) {
      return true;
    }

    // 2. Secret patterns
    for (const pattern of WorkspaceContextDiscovery.SECRET_PATTERNS) {
      if (pattern.test(fileName)) {
        return true;
      }
    }

    // 3. Gitignore rules
    const normalized = relativePath.replace(/\\/g, '/');
    for (const rule of this.ignoreRules) {
      let cleanRule = rule.trim();
      if (!cleanRule) continue;

      if (cleanRule.startsWith('/')) {
        cleanRule = cleanRule.slice(1);
        if (normalized === cleanRule) return true;
      }

      if (cleanRule.startsWith('*.')) {
        const suffix = cleanRule.slice(1).toLowerCase();
        if (fileName.toLowerCase().endsWith(suffix)) return true;
      }

      if (normalized === cleanRule || normalized.endsWith('/' + cleanRule)) {
        return true;
      }
    }

    return false;
  }

  private extractKeywords(query: string): string[] {
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'with', 'by',
      'is', 'are', 'was', 'were', 'be', 'been', 'this', 'that', 'it', 'of',
      'refactor', 'edit', 'change', 'fix', 'update', 'modify', 'code', 'function'
    ]);

    return query
      .toLowerCase()
      .split(/[^a-zA-Z0-9_]+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
