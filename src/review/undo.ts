import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface UndoRecordFile {
  path: string; // relative path
  fullPath: string;
  beforeContent: string | null; // null if newly created
  afterContent: string | null;  // null if deleted
}

export interface UndoRecord {
  id: string;
  timestamp: number;
  summary: string;
  files: UndoRecordFile[];
}

export class UndoManager {
  private globalStorageUri: vscode.Uri;
  private workspaceRoot: string;
  private historyFile: string;

  constructor(globalStorageUri: vscode.Uri, workspaceRoot: string = process.cwd()) {
    this.globalStorageUri = globalStorageUri;
    this.workspaceRoot = path.normalize(workspaceRoot);
    this.historyFile = path.join(globalStorageUri.fsPath, 'undo-records.json');
  }

  private async ensureStorageDir(): Promise<void> {
    const dir = this.globalStorageUri.fsPath;
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
  }

  public async getAllRecords(): Promise<UndoRecord[]> {
    try {
      if (!fs.existsSync(this.historyFile)) {
        return [];
      }
      const raw = await fs.promises.readFile(this.historyFile, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async writeRecords(records: UndoRecord[]): Promise<void> {
    await this.ensureStorageDir();
    await fs.promises.writeFile(this.historyFile, JSON.stringify(records, null, 2), 'utf8');
  }

  public async saveRecord(record: UndoRecord): Promise<void> {
    const records = await this.getAllRecords();
    records.push(record);
    await this.writeRecords(records);
  }

  public async peekRecord(): Promise<UndoRecord | null> {
    const records = await this.getAllRecords();
    return records.length > 0 ? records[records.length - 1] : null;
  }

  public async popRecord(): Promise<UndoRecord | null> {
    const records = await this.getAllRecords();
    if (records.length === 0) return null;
    const popped = records.pop()!;
    await this.writeRecords(records);
    return popped;
  }

  /**
   * Undoes the last applied change in one atomic WorkspaceEdit.
   */
  public async undoLastChange(): Promise<{ success: boolean; record?: UndoRecord; error?: string }> {
    const record = await this.popRecord();
    if (!record) {
      return { success: false, error: 'No applied changes found in undo history.' };
    }

    try {
      const edit = new vscode.WorkspaceEdit();

      for (const file of record.files) {
        const fileUri = vscode.Uri.file(file.fullPath);

        if (file.beforeContent === null) {
          // File was created in this change: delete it to undo
          edit.deleteFile(fileUri, { ignoreIfNotExists: true, recursive: true });
        } else {
          // File existed before: restore beforeContent
          if (fs.existsSync(file.fullPath)) {
            // Replace entire file content
            const existingText = await fs.promises.readFile(file.fullPath, 'utf8');
            const lineCount = existingText.split(/\r?\n/).length;
            const fullRange = new vscode.Range(0, 0, Math.max(0, lineCount), 0);
            edit.replace(fileUri, fullRange, file.beforeContent);
          } else {
            // File was deleted or missing: create and insert
            edit.createFile(fileUri, { ignoreIfExists: true });
            edit.insert(fileUri, new vscode.Position(0, 0), file.beforeContent);
          }
        }
      }

      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) {
        // If applyEdit fails, put record back into history
        await this.saveRecord(record);
        return { success: false, error: 'Failed to apply undo WorkspaceEdit.' };
      }

      return { success: true, record };
    } catch (err: any) {
      await this.saveRecord(record);
      return { success: false, error: err.message };
    }
  }
}
