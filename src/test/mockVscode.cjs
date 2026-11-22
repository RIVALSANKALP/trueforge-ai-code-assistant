const Module = require('module');
const originalResolveFilename = Module._resolveFilename;

const vscodeMock = {
  EventEmitter: class {
    event = () => {};
    fire = () => {};
  },
  Uri: {
    parse: (str) => ({ toString: () => str, fsPath: str, path: str }),
    file: (str) => ({ toString: () => 'file://' + str, fsPath: str, path: str })
  },
  Range: class {
    constructor(start, end) { this.start = start; this.end = end; }
  },
  Position: class {
    constructor(line, character) { this.line = line; this.character = character; }
  },
  Selection: class {
    constructor(start, end) { this.start = start; this.end = end; }
    get isEmpty() { return false; }
  },
  ThemeColor: class {
    constructor(id) { this.id = id; }
  },
  StatusBarAlignment: {
    Left: 1,
    Right: 2
  },
  QuickPickItemKind: {
    Separator: -1,
    Default: 0
  },
  WorkspaceEdit: class {
    constructor() {
      this._edits = [];
    }
    replace(uri, range, text) {
      this._edits.push({ type: 'replace', uri, range, text });
    }
    createFile(uri, options) {
      this._edits.push({ type: 'create', uri, options });
    }
    insert(uri, position, text) {
      this._edits.push({ type: 'insert', uri, position, text });
    }
  },
  ProgressLocation: { Notification: 15 },
  CancellationTokenSource: class {
    constructor() {
      this._token = {
        isCancellationRequested: false,
        onCancellationRequested: (listener) => {
          this._listeners.push(listener);
          return {
            dispose: () => {
              this._listeners = this._listeners.filter((l) => l !== listener);
            }
          };
        }
      };
      this._listeners = [];
    }
    get token() { return this._token; }
    cancel() {
      this._token.isCancellationRequested = true;
      for (const listener of this._listeners) {
        try { listener(); } catch {}
      }
    }
    dispose() {
      this._listeners = [];
    }
  },
  workspace: {
    _config: {},
    _documentVersions: {},
    _dirtyDocuments: {},
    textDocuments: [],
    _closeTextDocument: (uriOrDoc) => {
      const fsPath = (uriOrDoc && uriOrDoc.uri) ? (uriOrDoc.uri.fsPath || String(uriOrDoc.uri)) : (uriOrDoc && uriOrDoc.fsPath ? uriOrDoc.fsPath : String(uriOrDoc));
      const idx = vscodeMock.workspace.textDocuments.findIndex(
        (d) => d.uri.fsPath === fsPath || d.fileName === fsPath || d.uri.toString() === String(uriOrDoc)
      );
      if (idx !== -1) {
        vscodeMock.workspace.textDocuments.splice(idx, 1);
      }
    },
    getConfiguration: (section) => {
      return {
        get: (key, defaultValue) => {
          const fullKey = section ? `${section}.${key}` : key;
          if (vscodeMock.workspace._config && vscodeMock.workspace._config[fullKey] !== undefined) {
            return vscodeMock.workspace._config[fullKey];
          }
          if (vscodeMock.workspace._config && vscodeMock.workspace._config[key] !== undefined) {
            return vscodeMock.workspace._config[key];
          }
          return defaultValue;
        },
        has: (key) => {
          const fullKey = section ? `${section}.${key}` : key;
          return (
            (vscodeMock.workspace._config && vscodeMock.workspace._config[fullKey] !== undefined) ||
            (vscodeMock.workspace._config && vscodeMock.workspace._config[key] !== undefined)
          );
        },
        update: async (key, value) => {
          const fullKey = section ? `${section}.${key}` : key;
          if (!vscodeMock.workspace._config) {
            vscodeMock.workspace._config = {};
          }
          vscodeMock.workspace._config[fullKey] = value;
        }
      };
    },
    registerTextDocumentContentProvider: () => ({ dispose: () => {} }),
    applyEdit: async (edit) => {
      if (edit && edit._edits && Array.isArray(edit._edits)) {
        const fs = require('fs');
        for (const op of edit._edits) {
          const fsPath = op.uri ? (op.uri.fsPath || String(op.uri)) : '';
          if (op.type === 'create' && fsPath) {
            try { fs.writeFileSync(fsPath, '', 'utf8'); } catch {}
          } else if (op.type === 'replace' && fsPath && fs.existsSync(fsPath)) {
            const content = fs.readFileSync(fsPath, 'utf8');
            const lineStarts = [0];
            for (let i = 0; i < content.length; i++) {
              if (content[i] === '\n') {
                lineStarts.push(i + 1);
              } else if (content[i] === '\r') {
                if (i + 1 < content.length && content[i + 1] === '\n') {
                  lineStarts.push(i + 2);
                  i++;
                } else {
                  lineStarts.push(i + 1);
                }
              }
            }
            const startLine = op.range && op.range.start ? op.range.start.line : 0;
            const startChar = op.range && op.range.start ? op.range.start.character : 0;
            const endLine = op.range && op.range.end ? op.range.end.line : 0;
            const endChar = op.range && op.range.end ? op.range.end.character : 0;

            const startOffset = Math.min(content.length, (lineStarts[startLine] !== undefined ? lineStarts[startLine] : content.length) + startChar);
            const endOffset = Math.min(content.length, (lineStarts[endLine] !== undefined ? lineStarts[endLine] : content.length) + endChar);
            const newContent = content.slice(0, startOffset) + (op.text || '') + content.slice(endOffset);
            fs.writeFileSync(fsPath, newContent, 'utf8');

            const openDoc = vscodeMock.workspace.textDocuments.find(d => d.uri.fsPath === fsPath || d.fileName === fsPath);
            if (openDoc) {
              openDoc._content = newContent;
              openDoc.isDirty = true;
              openDoc.version++;
            }
          }
        }
      }
      return true;
    },
    openTextDocument: async (uri) => {
      const fsPath = uri.fsPath || String(uri);
      const existing = vscodeMock.workspace.textDocuments.find(
        (d) => d.uri.fsPath === fsPath || d.fileName === fsPath || d.uri.toString() === String(uri)
      );
      if (existing) {
        return existing;
      }
      const fs = require('fs');
      const content = fs.existsSync(fsPath) ? fs.readFileSync(fsPath, 'utf8') : '';
      const lines = content.split(/\r?\n/);
      const doc = {
        _content: content,
        getText: (range) => {
          const curContent = doc._content !== undefined ? doc._content : (fs.existsSync(fsPath) ? fs.readFileSync(fsPath, 'utf8') : '');
          if (!range) return curContent;
          const lineStarts = [0];
          for (let i = 0; i < curContent.length; i++) {
            if (curContent[i] === '\n') {
              lineStarts.push(i + 1);
            } else if (curContent[i] === '\r') {
              if (i + 1 < curContent.length && curContent[i + 1] === '\n') {
                lineStarts.push(i + 2);
                i++;
              } else {
                lineStarts.push(i + 1);
              }
            }
          }
          const startLine = range.start ? range.start.line : 0;
          const startChar = range.start ? range.start.character : 0;
          const endLine = range.end ? range.end.line : 0;
          const endChar = range.end ? range.end.character : 0;
          const startOffset = Math.min(curContent.length, (lineStarts[startLine] !== undefined ? lineStarts[startLine] : curContent.length) + startChar);
          const endOffset = Math.min(curContent.length, (lineStarts[endLine] !== undefined ? lineStarts[endLine] : curContent.length) + endChar);
          return curContent.slice(startOffset, endOffset);
        },
        save: async () => {
          doc._saveCalled = true;
          doc.isDirty = false;
          if (doc._content !== undefined) {
            fs.writeFileSync(fsPath, doc._content, 'utf8');
          }
          return true;
        },
        _saveCalled: false,
        lineCount: lines.length,
        uri: typeof uri === 'string' ? vscodeMock.Uri.file(uri) : (uri || vscodeMock.Uri.file(fsPath)),
        fileName: fsPath,
        languageId: 'typescript',
        version: vscodeMock.workspace._documentVersions[fsPath] !== undefined
          ? vscodeMock.workspace._documentVersions[fsPath]
          : 1,
        isDirty: Boolean(vscodeMock.workspace._dirtyDocuments && vscodeMock.workspace._dirtyDocuments[fsPath]),
        offsetAt: (pos) => {
          const line = pos ? pos.line : 0;
          const char = pos ? pos.character : 0;
          const curContent = doc._content !== undefined ? doc._content : (fs.existsSync(fsPath) ? fs.readFileSync(fsPath, 'utf8') : '');
          const lineStarts = [0];
          for (let i = 0; i < curContent.length; i++) {
            if (curContent[i] === '\n') {
              lineStarts.push(i + 1);
            } else if (curContent[i] === '\r') {
              if (i + 1 < curContent.length && curContent[i + 1] === '\n') {
                lineStarts.push(i + 2);
                i++;
              } else {
                lineStarts.push(i + 1);
              }
            }
          }
          const base = lineStarts[line] !== undefined ? lineStarts[line] : curContent.length;
          return Math.min(curContent.length, base + char);
        },
        lineAt: (lineIndex) => {
          const curContent = doc._content !== undefined ? doc._content : (fs.existsSync(fsPath) ? fs.readFileSync(fsPath, 'utf8') : '');
          const curLines = curContent.split(/\r?\n/);
          return {
            text: curLines[lineIndex] || '',
            range: {
              start: { line: lineIndex, character: 0 },
              end: { line: lineIndex, character: (curLines[lineIndex] || '').length }
            }
          };
        }
      };
      vscodeMock.workspace.textDocuments.push(doc);
      return doc;
    }
  },
  window: {
    _lastInfoMessage: undefined,
    _lastErrorMessage: undefined,
    _lastWarningMessage: undefined,
    showInformationMessage: async (msg) => { vscodeMock.window._lastInfoMessage = msg; },
    showErrorMessage: async (msg) => { vscodeMock.window._lastErrorMessage = msg; },
    showWarningMessage: async (msg) => { vscodeMock.window._lastWarningMessage = msg; },
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined,
    createStatusBarItem: () => ({
      show: () => {},
      dispose: () => {},
      text: '',
      tooltip: '',
      command: '',
      backgroundColor: undefined
    }),
    withProgress: async (_options, task) => {
      const cts = new vscodeMock.CancellationTokenSource();
      return task({ report: () => {} }, cts.token);
    }
  },
  commands: {
    _registeredCommands: new Map(),
    _executedCommands: [],
    registerCommand: (cmd, callback) => {
      vscodeMock.commands._registeredCommands.set(cmd, callback);
      return {
        dispose: () => {
          vscodeMock.commands._registeredCommands.delete(cmd);
        }
      };
    },
    executeCommand: async (cmd, ...args) => {
      vscodeMock.commands._executedCommands.push({ cmd, args });
      const handler = vscodeMock.commands._registeredCommands.get(cmd);
      if (handler) {
        return handler(...args);
      }
    }
  }
};

Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'vscode') {
    return 'vscode';
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

require.cache['vscode'] = {
  id: 'vscode',
  filename: 'vscode',
  loaded: true,
  exports: vscodeMock
};
