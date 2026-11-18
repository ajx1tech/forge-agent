import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ChangeSet } from './changeset.js';

export const SCHEME_ORIGINAL = 'forge-original';
export const SCHEME_PROPOSED = 'forge-proposed';

export class ReviewContentProvider implements vscode.TextDocumentContentProvider {
  private changeSet: ChangeSet;
  private onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange: vscode.Event<vscode.Uri> = this.onDidChangeEmitter.event;

  constructor(changeSet: ChangeSet) {
    this.changeSet = changeSet;
    this.changeSet.onDidChange(() => {
      this.refreshAll();
    });
  }

  public refresh(uri: vscode.Uri): void {
    this.onDidChangeEmitter.fire(uri);
  }

  public refreshAll(): void {
    for (const staged of this.changeSet.getAllStaged()) {
      const origUri = vscode.Uri.from({ scheme: SCHEME_ORIGINAL, path: staged.path });
      const propUri = vscode.Uri.from({ scheme: SCHEME_PROPOSED, path: staged.path });
      this.onDidChangeEmitter.fire(origUri);
      this.onDidChangeEmitter.fire(propUri);
    }
  }

  public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const rawPath = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;
    const staged = this.changeSet.getStaged(rawPath);

    if (uri.scheme === SCHEME_ORIGINAL) {
      if (staged) {
        return staged.originalContent;
      }
      const fullPath = path.resolve(this.changeSet.getWorkspaceRoot(), rawPath);
      if (fs.existsSync(fullPath)) {
        return await fs.promises.readFile(fullPath, 'utf8');
      }
      return '';
    }

    if (uri.scheme === SCHEME_PROPOSED) {
      if (staged) {
        return staged.proposedContent;
      }
      return '';
    }

    return '';
  }
}
