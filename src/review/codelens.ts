import * as vscode from 'vscode';
import { ChangeSet } from './changeset.js';
import { SCHEME_PROPOSED } from './contentProvider.js';

export class HunkCodeLensProvider implements vscode.CodeLensProvider {
  private changeSet: ChangeSet;
  private onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> = this.onDidChangeCodeLensesEmitter.event;

  constructor(changeSet: ChangeSet) {
    this.changeSet = changeSet;
    this.changeSet.onDidChange(() => {
      this.onDidChangeCodeLensesEmitter.fire();
    });
  }

  public refresh(): void {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  public provideCodeLenses(
    document: vscode.TextDocument,
    token?: vscode.CancellationToken
  ): vscode.CodeLens[] {
    const uri = document.uri;
    const rawPath = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;
    const staged = this.changeSet.getStaged(rawPath);

    if (!staged || staged.hunks.length === 0) {
      return [];
    }

    const lenses: vscode.CodeLens[] = [];

    for (let i = 0; i < staged.hunks.length; i++) {
      const hunk = staged.hunks[i];
      // In proposed document, place CodeLens at hunk's proposed start line (0-based)
      const line = Math.max(0, Math.min(document.lineCount - 1, hunk.proposedStartLine - 1));
      const range = new vscode.Range(line, 0, line, 0);

      const statusTag = hunk.status === 'accepted'
        ? '✓ Accepted'
        : hunk.status === 'rejected'
          ? '✗ Rejected'
          : 'Pending';

      const outsideTag = hunk.outsideSelection ? ' [outside selection]' : '';

      // Combined or separate actions: 'Accept hunk | Reject hunk | Next'
      // 1. Accept action
      lenses.push(
        new vscode.CodeLens(range, {
          title: hunk.status === 'accepted' ? '✓ Accepted' : `Accept hunk (Alt+Y)${outsideTag}`,
          command: 'forge.acceptHunk',
          tooltip: 'Accept this diff hunk',
          arguments: [staged.path, hunk.id]
        })
      );

      // 2. Reject action
      lenses.push(
        new vscode.CodeLens(range, {
          title: hunk.status === 'rejected' ? '✗ Rejected' : 'Reject hunk (Alt+N)',
          command: 'forge.rejectHunk',
          tooltip: 'Reject this diff hunk',
          arguments: [staged.path, hunk.id]
        })
      );

      // 3. Next action
      lenses.push(
        new vscode.CodeLens(range, {
          title: 'Next (Alt+])',
          command: 'forge.nextHunk',
          tooltip: 'Navigate to the next diff hunk',
          arguments: [staged.path, hunk.id]
        })
      );
    }

    return lenses;
  }
}
