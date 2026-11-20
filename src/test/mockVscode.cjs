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
  WorkspaceEdit: class {
    replace() {}
    createFile() {}
    insert() {}
  },
  ProgressLocation: { Notification: 15 },
  workspace: {
    registerTextDocumentContentProvider: () => ({ dispose: () => {} }),
    applyEdit: async () => true,
    openTextDocument: async (uri) => {
      const fsPath = uri.fsPath || String(uri);
      const fs = require('fs');
      const content = fs.existsSync(fsPath) ? fs.readFileSync(fsPath, 'utf8') : '';
      const lines = content.split(/\r?\n/);
      return {
        getText: () => content,
        lineCount: lines.length,
        lineAt: (lineIndex) => ({
          range: {
            start: { line: lineIndex, character: 0 },
            end: { line: lineIndex, character: (lines[lineIndex] || '').length }
          }
        })
      };
    }
  },
  window: {
    showInformationMessage: async () => {},
    showErrorMessage: async () => {},
    showWarningMessage: async () => {},
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
    withProgress: async (_options, task) => task({ report: () => {} }, { isCancellationRequested: false })
  },
  commands: {
    executeCommand: async () => {}
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
