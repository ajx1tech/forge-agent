import { vi } from 'vitest';
import * as fs from 'fs';

export class Disposable {
  private callOnDispose: () => any;
  constructor(callOnDispose: () => any) {
    this.callOnDispose = callOnDispose;
  }
  dispose() {
    if (this.callOnDispose) {
      this.callOnDispose();
    }
  }
}

export class Uri {
  public scheme: string;
  public path: string;
  public fsPath: string;

  constructor(scheme: string, path: string, fsPath: string) {
    this.scheme = scheme;
    this.path = path;
    this.fsPath = fsPath;
  }

  static file(filePath: string): Uri {
    const normalized = filePath.replace(/\\/g, '/');
    return new Uri('file', normalized, filePath);
  }

  static parse(val: string): Uri {
    const parts = val.split(':');
    const scheme = parts[0] || 'file';
    const clean = val.replace(/^[a-zA-Z0-9_-]+:\/\//, '').replace(/^[a-zA-Z0-9_-]+:/, '');
    const fsPath = clean.replace(/\//g, '\\');
    return new Uri(scheme, clean.replace(/\\/g, '/'), fsPath);
  }

  static from(components: { scheme: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    const p = components.path || '';
    return new Uri(components.scheme, p.replace(/\\/g, '/'), p.replace(/\//g, '\\'));
  }

  toString(): string {
    return `${this.scheme}://${this.path}`;
  }
}

export class Position {
  constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
  public readonly start: Position;
  public readonly end: Position;

  constructor(startLine: number, startChar: number, endLine: number, endChar: number);
  constructor(start: Position, end: Position);
  constructor(a: any, b: any, c?: any, d?: any) {
    if (typeof a === 'number') {
      this.start = new Position(a, b);
      this.end = new Position(c, d);
    } else {
      this.start = a;
      this.end = b;
    }
  }

  get isEmpty(): boolean {
    return this.start.line === this.end.line && this.start.character === this.end.character;
  }
}

export class Selection extends Range {
  public readonly anchor: Position;
  public readonly active: Position;

  constructor(anchor: Position, active: Position);
  constructor(anchorLine: number, anchorChar: number, activeLine: number, activeChar: number);
  constructor(a: any, b: any, c?: any, d?: any) {
    super(a, b, c, d);
    if (typeof a === 'number') {
      this.anchor = new Position(a, b);
      this.active = new Position(c, d);
    } else {
      this.anchor = a;
      this.active = b;
    }
  }
}

export class CodeLens {
  constructor(public range: Range, public command?: Command) {}
}

export interface Command {
  title: string;
  command: string;
  tooltip?: string;
  arguments?: any[];
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2
}

export class ThemeIcon {
  constructor(public readonly id: string, public readonly color?: any) {}
}

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class TreeItem {
  public label?: string;
  public collapsibleState?: TreeItemCollapsibleState;
  public description?: string;
  public tooltip?: string;
  public iconPath?: any;
  public contextValue?: string;
  public command?: Command;

  constructor(label: string, collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export class EventEmitter<T> {
  private listeners: Array<(e: T) => any> = [];

  get event(): (listener: (e: T) => any) => Disposable {
    return (listener: (e: T) => any) => {
      this.listeners.push(listener);
      return new Disposable(() => {
        const idx = this.listeners.indexOf(listener);
        if (idx >= 0) this.listeners.splice(idx, 1);
      });
    };
  }

  fire(data: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(data);
      } catch (e) {
        console.error(e);
      }
    }
  }

  dispose(): void {
    this.listeners = [];
  }
}

export class WorkspaceEdit {
  private _edits: Array<{ type: 'replace' | 'insert' | 'delete' | 'createFile' | 'deleteFile'; uri: Uri; range?: Range; newText?: string }> = [];

  replace(uri: Uri, range: Range, newText: string): void {
    this._edits.push({ type: 'replace', uri, range, newText });
  }

  insert(uri: Uri, position: Position, newText: string): void {
    this._edits.push({ type: 'insert', uri, range: new Range(position, position), newText });
  }

  delete(uri: Uri, range: Range): void {
    this._edits.push({ type: 'delete', uri, range });
  }

  createFile(uri: Uri, options?: { overwrite?: boolean; ignoreIfExists?: boolean }): void {
    this._edits.push({ type: 'createFile', uri });
  }

  deleteFile(uri: Uri, options?: { recursive?: boolean; ignoreIfNotExists?: boolean }): void {
    this._edits.push({ type: 'deleteFile', uri });
  }

  get edits(): Array<{ type: string; uri: Uri; range?: Range; newText?: string }> {
    return this._edits;
  }

  has(uri: Uri): boolean {
    return this._edits.some(e => e.uri.fsPath === uri.fsPath || e.uri.toString() === uri.toString());
  }

  entries(): [Uri, any[]][] {
    const map = new Map<string, [Uri, any[]]>();
    for (const edit of this._edits) {
      const key = edit.uri.toString();
      if (!map.has(key)) {
        map.set(key, [edit.uri, []]);
      }
      map.get(key)![1].push(edit);
    }
    return Array.from(map.values());
  }
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15
}

export const window = {
  createOutputChannel: vi.fn((name: string) => {
    const lines: string[] = [];
    return {
      name,
      lines,
      append: vi.fn((val: string) => { lines.push(val); }),
      appendLine: vi.fn((val: string) => { lines.push(val); }),
      clear: vi.fn(() => { lines.length = 0; }),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn()
    };
  }),
  showInformationMessage: vi.fn().mockResolvedValue(undefined),
  showWarningMessage: vi.fn().mockResolvedValue(undefined),
  showErrorMessage: vi.fn().mockResolvedValue(undefined),
  showInputBox: vi.fn().mockResolvedValue(undefined),
  showQuickPick: vi.fn().mockResolvedValue(undefined),
  withProgress: vi.fn(async (options: any, task: (progress: any, token: any) => Promise<any>) => {
    const progress = { report: vi.fn() };
    const token = { isCancellationRequested: false, onCancellationRequested: vi.fn() };
    return await task(progress, token);
  }),
  registerWebviewViewProvider: vi.fn((viewId: string, provider: any) => {
    return new Disposable(() => {});
  }),
  registerTreeDataProvider: vi.fn((viewId: string, provider: any) => {
    return new Disposable(() => {});
  }),
  createTreeView: vi.fn((viewId: string, options: any) => {
    return {
      reveal: vi.fn(),
      dispose: vi.fn()
    };
  }),
  activeTextEditor: undefined as any
};

export const commands = {
  registerCommand: vi.fn((cmd: string, handler: (...args: any[]) => any) => {
    return new Disposable(() => {});
  }),
  executeCommand: vi.fn().mockResolvedValue(undefined)
};

export const workspace = {
  workspaceFolders: [] as Array<{ uri: Uri; name: string; index: number }>,
  getConfiguration: vi.fn((section?: string) => {
    return {
      get: vi.fn((key: string, defaultValue?: any) => defaultValue),
      has: vi.fn(() => false),
      update: vi.fn().mockResolvedValue(undefined)
    };
  }),
  asRelativePath: (pathOrUri: string | Uri) => {
    if (typeof pathOrUri === 'string') return pathOrUri;
    return pathOrUri.fsPath;
  },
  registerTextDocumentContentProvider: vi.fn((scheme: string, provider: any) => {
    return new Disposable(() => {});
  }),
  applyEdit: vi.fn(async (edit: WorkspaceEdit): Promise<boolean> => {
    for (const e of edit.edits) {
      const fsPath = e.uri.fsPath;
      if (e.type === 'replace') {
        try {
          if (fs.existsSync(fsPath)) {
            // If full file replace
            if (!e.range || (e.range.start.line === 0 && e.range.start.character === 0)) {
              fs.writeFileSync(fsPath, e.newText ?? '', 'utf8');
            }
          }
        } catch {}
      } else if (e.type === 'createFile') {
        try {
          fs.writeFileSync(fsPath, '', 'utf8');
        } catch {}
      } else if (e.type === 'deleteFile') {
        try {
          if (fs.existsSync(fsPath)) {
            fs.unlinkSync(fsPath);
          }
        } catch {}
      }
    }
    return true;
  }),
  openTextDocument: vi.fn(async (uriOrPath: any) => {
    const fsPath = typeof uriOrPath === 'string' ? uriOrPath : uriOrPath.fsPath;
    const content = fs.existsSync(fsPath) ? fs.readFileSync(fsPath, 'utf8') : '';
    const lines = content.split(/\r?\n/);
    return {
      uri: typeof uriOrPath === 'string' ? Uri.file(uriOrPath) : uriOrPath,
      lineCount: lines.length,
      getText: (range?: Range) => {
        if (!range) return content;
        return content;
      },
      lineAt: (line: number) => ({
        lineNumber: line,
        text: lines[line] || '',
        range: new Range(line, 0, line, (lines[line] || '').length)
      })
    };
  })
};

export const languages = {
  registerCodeLensProvider: vi.fn((selector: any, provider: any) => {
    return new Disposable(() => {});
  })
};
