import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ChangeSet, StagedFileChange } from './changeset.js';
import { UndoManager, UndoRecord, UndoRecordFile } from './undo.js';
import { HunkCodeLensProvider } from './codelens.js';
import { ReviewContentProvider, SCHEME_ORIGINAL, SCHEME_PROPOSED } from './contentProvider.js';
import { DiffHunk, applyHunks } from './hunks.js';

export interface ReviewItem {
  type: 'file' | 'hunk';
  filePath: string;
  hunk?: DiffHunk;
}

export class ReviewController implements vscode.TreeDataProvider<ReviewItem> {
  private changeSet: ChangeSet;
  private undoManager: UndoManager;
  private contentProvider: ReviewContentProvider;
  private codeLensProvider: HunkCodeLensProvider;
  private outputChannel?: vscode.OutputChannel;
  private onStagedOverlayClear?: (filePath: string) => void;

  private _onDidChangeTreeData: vscode.EventEmitter<ReviewItem | undefined | null | void> =
    new vscode.EventEmitter<ReviewItem | undefined | null | void>();
  public readonly onDidChangeTreeData: vscode.Event<ReviewItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  constructor(options: {
    changeSet: ChangeSet;
    undoManager: UndoManager;
    contentProvider: ReviewContentProvider;
    codeLensProvider: HunkCodeLensProvider;
    outputChannel?: vscode.OutputChannel;
    onStagedOverlayClear?: (filePath: string) => void;
  }) {
    this.changeSet = options.changeSet;
    this.undoManager = options.undoManager;
    this.contentProvider = options.contentProvider;
    this.codeLensProvider = options.codeLensProvider;
    this.outputChannel = options.outputChannel;
    this.onStagedOverlayClear = options.onStagedOverlayClear;

    this.changeSet.onDidChange(() => {
      this._onDidChangeTreeData.fire();
    });
  }

  public getTreeItem(element: ReviewItem): vscode.TreeItem {
    if (element.type === 'file') {
      const staged = this.changeSet.getStaged(element.filePath);
      const hunks = staged?.hunks || [];
      const accepted = hunks.filter(h => h.status === 'accepted').length;
      const rejected = hunks.filter(h => h.status === 'rejected').length;
      const pending = hunks.filter(h => h.status === 'pending').length;

      const item = new vscode.TreeItem(element.filePath, vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${hunks.length} hunks (${accepted} accepted, ${rejected} rejected, ${pending} pending)`;
      item.tooltip = staged?.rationale || `Staged edits for ${element.filePath}`;
      item.iconPath = new vscode.ThemeIcon('file-code');
      item.contextValue = 'stagedFile';
      item.command = {
        title: 'Open Diff',
        command: 'forge.review',
        arguments: [element.filePath]
      };
      return item;
    } else {
      const hunk = element.hunk!;
      const label = `Hunk #${hunk.id.replace('hunk-', '')}: lines ${hunk.originalStartLine}-${hunk.originalStartLine + hunk.originalLineCount}`;
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);

      const outsideDesc = hunk.outsideSelection ? ' (outside selection)' : '';
      item.description = `[${hunk.status}]${outsideDesc}`;

      if (hunk.status === 'accepted') {
        item.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
      } else if (hunk.status === 'rejected') {
        item.iconPath = new vscode.ThemeIcon('close', new vscode.ThemeColor('testing.iconFailed'));
      } else {
        item.iconPath = new vscode.ThemeIcon('git-pull-request');
      }

      item.contextValue = 'hunkItem';
      item.command = {
        title: 'Open Diff',
        command: 'forge.review',
        arguments: [element.filePath]
      };
      return item;
    }
  }

  public getChildren(element?: ReviewItem): vscode.ProviderResult<ReviewItem[]> {
    if (!element) {
      // Top level: files
      const staged = this.changeSet.getAllStaged();
      return staged.map(s => ({
        type: 'file',
        filePath: s.path
      }));
    }

    if (element.type === 'file') {
      // Second level: hunks for file
      const staged = this.changeSet.getStaged(element.filePath);
      if (!staged) return [];
      return staged.hunks.map(h => ({
        type: 'hunk',
        filePath: element.filePath,
        hunk: h
      }));
    }

    return [];
  }

  /**
   * Opens the built-in VS Code diff editor for a staged file.
   */
  public async openDiff(filePath: string): Promise<void> {
    const { relPath } = this.changeSet.normalizePath(filePath);
    const staged = this.changeSet.getStaged(relPath);
    if (!staged) {
      vscode.window.showWarningMessage(`No staged changes found for '${relPath}'.`);
      return;
    }

    const originalUri = vscode.Uri.from({
      scheme: SCHEME_ORIGINAL,
      path: relPath
    });
    const proposedUri = vscode.Uri.from({
      scheme: SCHEME_PROPOSED,
      path: relPath
    });

    const title = `${path.basename(relPath)}: Staged Changes (Forge Review)`;
    await vscode.commands.executeCommand('vscode.diff', originalUri, proposedUri, title);
  }

  public acceptHunk(filePath: string, hunkId: string): void {
    const success = this.changeSet.setHunkStatus(filePath, hunkId, 'accepted');
    if (success) {
      this.outputChannel?.appendLine(`[Forge Review] Accepted hunk '${hunkId}' in ${filePath}`);
    }
  }

  public rejectHunk(filePath: string, hunkId: string): void {
    const success = this.changeSet.setHunkStatus(filePath, hunkId, 'rejected');
    if (success) {
      this.outputChannel?.appendLine(`[Forge Review] Rejected hunk '${hunkId}' in ${filePath}`);
    }
  }

  /**
   * Finds the current or next pending hunk across staged files and advances.
   */
  public nextHunk(currentFile?: string, currentHunkId?: string): void {
    const all = this.changeSet.getAllStaged();
    if (all.length === 0) return;

    let targetFile = currentFile ? this.changeSet.getStaged(currentFile) : all[0];
    if (!targetFile) targetFile = all[0];

    // Find next pending or next hunk
    let found = false;
    for (const h of targetFile.hunks) {
      if (currentHunkId && !found) {
        if (h.id === currentHunkId) {
          found = true;
        }
        continue;
      }
      // Open diff and inform
      this.openDiff(targetFile.path);
      return;
    }

    // Wrap around to first hunk if reached end
    if (targetFile.hunks.length > 0) {
      this.openDiff(targetFile.path);
    }
  }

  public acceptCurrentOrPendingHunk(): void {
    const stagedFiles = this.changeSet.getAllStaged();
    for (const file of stagedFiles) {
      const pending = file.hunks.find(h => h.status === 'pending');
      if (pending) {
        this.acceptHunk(file.path, pending.id);
        vscode.window.showInformationMessage(`Accepted ${file.path} [${pending.id}]`);
        return;
      }
    }
    vscode.window.showInformationMessage('No pending hunks left to accept.');
  }

  public rejectCurrentOrPendingHunk(): void {
    const stagedFiles = this.changeSet.getAllStaged();
    for (const file of stagedFiles) {
      const pending = file.hunks.find(h => h.status === 'pending');
      if (pending) {
        this.rejectHunk(file.path, pending.id);
        vscode.window.showInformationMessage(`Rejected ${file.path} [${pending.id}]`);
        return;
      }
    }
    vscode.window.showInformationMessage('No pending hunks left to reject.');
  }

  public acceptAll(filePath?: string): void {
    this.changeSet.acceptAllHunks(filePath);
    vscode.window.showInformationMessage(
      filePath ? `Accepted all hunks for ${filePath}` : 'Accepted all staged hunks across all files.'
    );
  }

  public rejectAll(filePath?: string): void {
    this.changeSet.rejectAllHunks(filePath);
    vscode.window.showInformationMessage(
      filePath ? `Rejected all hunks for ${filePath}` : 'Rejected all staged hunks across all files.'
    );
  }

  /**
   * Applies all accepted hunks in one atomic vscode.WorkspaceEdit and saves an UndoRecord.
   */
  public async applyChanges(summary?: string): Promise<{
    applied: boolean;
    appliedFiles: string[];
    undoId?: string;
    error?: string;
  }> {
    const stagedList = this.changeSet.getAllStaged();
    if (stagedList.length === 0) {
      return { applied: false, appliedFiles: [], error: 'No staged changes to apply.' };
    }

    const edit = new vscode.WorkspaceEdit();
    const undoFiles: UndoRecordFile[] = [];
    const appliedFiles: string[] = [];

    for (const staged of stagedList) {
      const acceptedHunks = staged.hunks.filter(h => h.status === 'accepted');
      if (acceptedHunks.length === 0) {
        // No accepted hunks in this file
        continue;
      }

      const fileUri = vscode.Uri.file(staged.fullPath);
      const finalContent = applyHunks(staged.originalContent, staged.hunks);

      if (staged.isNewFile) {
        undoFiles.push({
          path: staged.path,
          fullPath: staged.fullPath,
          beforeContent: null,
          afterContent: finalContent
        });
        edit.createFile(fileUri, { ignoreIfExists: true });
        edit.insert(fileUri, new vscode.Position(0, 0), finalContent);
      } else {
        undoFiles.push({
          path: staged.path,
          fullPath: staged.fullPath,
          beforeContent: staged.originalContent,
          afterContent: finalContent
        });
        const lineCount = staged.originalContent.split(/\r?\n/).length;
        const fullRange = new vscode.Range(0, 0, Math.max(0, lineCount), 0);
        edit.replace(fileUri, fullRange, finalContent);
      }

      appliedFiles.push(staged.path);
    }

    if (appliedFiles.length === 0) {
      return {
        applied: false,
        appliedFiles: [],
        error: 'No accepted hunks to apply (all hunks were rejected or pending).'
      };
    }

    try {
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) {
        return { applied: false, appliedFiles: [], error: 'WorkspaceEdit was not applied by editor.' };
      }

      // Save UndoRecord
      const undoRecord: UndoRecord = {
        id: `undo-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        timestamp: Date.now(),
        summary: summary || `Applied changes to ${appliedFiles.join(', ')}`,
        files: undoFiles
      };
      await this.undoManager.saveRecord(undoRecord);

      // Clean up staged changes and overlay
      for (const p of appliedFiles) {
        this.changeSet.unstage(p);
        if (this.onStagedOverlayClear) {
          this.onStagedOverlayClear(p);
        }
      }

      vscode.window.showInformationMessage(
        `Forge: Successfully applied changes to ${appliedFiles.length} file(s).`
      );

      return {
        applied: true,
        appliedFiles,
        undoId: undoRecord.id
      };
    } catch (err: any) {
      return {
        applied: false,
        appliedFiles: [],
        error: `Failed to apply changes: ${err.message}`
      };
    }
  }

  /**
   * Undoes the last applied change.
   */
  public async undoLastAppliedChange(): Promise<void> {
    const result = await this.undoManager.undoLastChange();
    if (result.success && result.record) {
      vscode.window.showInformationMessage(
        `Forge: Undone last applied change: ${result.record.summary}`
      );
    } else {
      vscode.window.showWarningMessage(
        `Forge Undo failed: ${result.error || 'No changes to undo.'}`
      );
    }
  }

  /**
   * Loads a rich demo fixture with multiple hunks for review demonstration.
   */
  public loadDemoFixture(): void {
    const fixturePath = 'src/example-fixture.ts';
    const original = [
      '// Demo Fixture for Forge Per-Hunk Review',
      'function computeScore(a: number, b: number): number {',
      '  return a + b;',
      '}',
      '',
      'function displayBanner(): void {',
      '  console.log("Welcome to Forge");',
      '}',
      '',
      'export function main(): void {',
      '  const result = computeScore(10, 20);',
      '  console.log("Result:", result);',
      '  displayBanner();',
      '}'
    ].join('\n');

    const proposed = [
      '// Demo Fixture for Forge Per-Hunk Review (Updated)',
      'function computeScore(a: number, b: number): number {',
      '  if (a < 0 || b < 0) {',
      '    throw new Error("Inputs must be non-negative");',
      '  }',
      '  return a + b;',
      '}',
      '',
      'function displayBanner(): void {',
      '  console.log("Welcome to Forge AI Assistant");',
      '  console.log("Per-hunk diff review enabled");',
      '}',
      '',
      'export function main(): void {',
      '  const result = computeScore(10, 20);',
      '  console.log("Final Computed Result:", result);',
      '  displayBanner();',
      '}'
    ].join('\n');

    // Selection target range: lines 6 to 10 (inside displayBanner)
    this.changeSet.stageContent(fixturePath, proposed, {
      originalContent: original,
      rationale: 'Validation in computeScore and enhanced banner logging',
      targetRange: { startLine: 6, endLine: 10 }
    });

    this.openDiff(fixturePath);
    vscode.window.showInformationMessage('Loaded Forge Review demo fixture.');
  }

  /**
   * Registers all review commands in VS Code.
   */
  public registerCommands(context: vscode.ExtensionContext): void {
    const cmdReview = vscode.commands.registerCommand('forge.review', async (filePath?: string) => {
      if (filePath) {
        await this.openDiff(filePath);
      } else {
        const staged = this.changeSet.getAllStaged();
        if (staged.length > 0) {
          await this.openDiff(staged[0].path);
        } else {
          vscode.window.showInformationMessage('No staged changes currently under review.');
        }
      }
    });

    const cmdAcceptHunk = vscode.commands.registerCommand('forge.acceptHunk', (filePath: string, hunkId: string) => {
      this.acceptHunk(filePath, hunkId);
    });

    const cmdRejectHunk = vscode.commands.registerCommand('forge.rejectHunk', (filePath: string, hunkId: string) => {
      this.rejectHunk(filePath, hunkId);
    });

    const cmdNextHunk = vscode.commands.registerCommand('forge.nextHunk', (filePath?: string, hunkId?: string) => {
      this.nextHunk(filePath, hunkId);
    });

    const cmdAcceptPending = vscode.commands.registerCommand('forge.acceptCurrentHunk', () => {
      this.acceptCurrentOrPendingHunk();
    });

    const cmdRejectPending = vscode.commands.registerCommand('forge.rejectCurrentHunk', () => {
      this.rejectCurrentOrPendingHunk();
    });

    const cmdAcceptAll = vscode.commands.registerCommand('forge.acceptAll', (filePath?: string) => {
      this.acceptAll(filePath);
    });

    const cmdRejectAll = vscode.commands.registerCommand('forge.rejectAll', (filePath?: string) => {
      this.rejectAll(filePath);
    });

    const cmdApply = vscode.commands.registerCommand('forge.applyChanges', async (summary?: string) => {
      await this.applyChanges(summary);
    });

    const cmdUndo = vscode.commands.registerCommand('forge.undoLastAppliedChange', async () => {
      await this.undoLastAppliedChange();
    });

    const cmdDemo = vscode.commands.registerCommand('forge.reviewDemoFixture', () => {
      this.loadDemoFixture();
    });

    context.subscriptions.push(
      cmdReview,
      cmdAcceptHunk,
      cmdRejectHunk,
      cmdNextHunk,
      cmdAcceptPending,
      cmdRejectPending,
      cmdAcceptAll,
      cmdRejectAll,
      cmdApply,
      cmdUndo,
      cmdDemo
    );
  }
}
