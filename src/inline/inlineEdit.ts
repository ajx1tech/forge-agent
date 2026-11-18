import * as vscode from 'vscode';
import * as path from 'path';
import { TrueForgeClient } from '../trueforge/client.js';
import { ChangeSet } from '../review/changeset.js';
import { ReviewController } from '../review/reviewController.js';

export class InlineEditManager {
  private trueForgeClient: TrueForgeClient;
  private changeSet: ChangeSet;
  private reviewController: ReviewController;
  private outputChannel?: vscode.OutputChannel;

  constructor(options: {
    trueForgeClient: TrueForgeClient;
    changeSet: ChangeSet;
    reviewController: ReviewController;
    outputChannel?: vscode.OutputChannel;
  }) {
    this.trueForgeClient = options.trueForgeClient;
    this.changeSet = options.changeSet;
    this.reviewController = options.reviewController;
    this.outputChannel = options.outputChannel;
  }

  /**
   * Triggers the Inline Edit workflow for active editor and selection.
   */
  public async executeInlineEdit(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('Forge Inline Edit: No active text editor open.');
      return;
    }

    const document = editor.document;
    const selection = editor.selection;
    const relPath = vscode.workspace.asRelativePath(document.uri);
    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;
    const isRange = !selection.isEmpty;
    const selectedText = isRange ? document.getText(selection) : '';

    const promptTitle = isRange
      ? `Edit lines ${startLine}-${endLine} of ${path.basename(relPath)}`
      : `Edit around line ${startLine} of ${path.basename(relPath)}`;

    const userInput = await vscode.window.showInputBox({
      title: 'Forge: Inline Edit',
      prompt: promptTitle,
      placeHolder: 'Describe the modification you want Forge to make...'
    });

    if (!userInput || !userInput.trim()) {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Forge: Editing ${path.basename(relPath)}...`,
        cancellable: true
      },
      async (progress, token) => {
        try {
          // 1. Create session with 'forge-inline'
          const { sessionId } = await this.trueForgeClient.createSession({
            agentName: 'forge-inline',
            title: `Inline Edit: ${path.basename(relPath)}:${startLine}`
          });

          token.onCancellationRequested(async () => {
            try {
              await this.trueForgeClient.cancel(sessionId);
            } catch (err: any) {
              this.outputChannel?.appendLine(`[Forge Inline] Cancel error: ${err.message}`);
            }
          });

          // 2. Prepare structured prompt with target range
          let prompt = `You are performing an inline edit on file: "${relPath}".\n` +
            `Target line range: ${startLine} to ${endLine}.\n`;

          if (isRange && selectedText) {
            prompt += `Current text in selection:\n\`\`\`\n${selectedText}\n\`\`\`\n`;
          }

          prompt += `User request: ${userInput}\n\n` +
            `Instructions:\n` +
            `- Inspect file context with 'read_file' if required.\n` +
            `- Propose your edits using 'stage_edit' with path "${relPath}" and exact 'edits' or 'content'.\n` +
            `- Do not modify other files unless strictly necessary.`;

          progress.report({ message: 'Contacting forge-inline assistant...' });

          // 3. Stream turn
          const stream = this.trueForgeClient.streamTurn(sessionId, prompt);
          for await (const event of stream) {
            if (token.isCancellationRequested) break;

            if (event.type === 'toolCall') {
              progress.report({ message: `Executing tool ${event.name}...` });
            } else if (event.type === 'textDelta') {
              progress.report({ message: 'Generating edits...' });
            }
          }

          // 4. Route staged edits into the shared per-hunk review UI
          const staged = this.changeSet.getStaged(relPath);
          if (staged) {
            // Apply target range to flag hunks outside selection
            staged.targetRange = { startLine, endLine };
            for (const hunk of staged.hunks) {
              const hunkStart = hunk.originalStartLine;
              const hunkEnd = hunk.originalLineCount > 0
                ? hunk.originalStartLine + hunk.originalLineCount - 1
                : hunk.originalStartLine;
              hunk.outsideSelection = hunkEnd < startLine || hunkStart > endLine;
            }

            // Open diff view for review
            await this.reviewController.openDiff(relPath);
            vscode.window.showInformationMessage(
              `Forge: Staged inline edits for ${path.basename(relPath)}. Review hunks in the diff editor.`
            );
          } else {
            // Check if any other file was staged
            const allStaged = this.changeSet.getAllStaged();
            if (allStaged.length > 0) {
              await this.reviewController.openDiff(allStaged[0].path);
              vscode.window.showInformationMessage(
                `Forge: Staged edits for ${allStaged[0].path}. Review hunks in the diff editor.`
              );
            } else {
              vscode.window.showInformationMessage(
                'Forge Inline Edit completed without staging changes.'
              );
            }
          }
        } catch (err: any) {
          vscode.window.showErrorMessage(`Forge Inline Edit failed: ${err.message}`);
          this.outputChannel?.appendLine(`[Forge Inline] Error: ${err.message}`);
        }
      }
    );
  }

  public registerCommands(context: vscode.ExtensionContext): void {
    const inlineCmd = vscode.commands.registerCommand('forge.inlineEdit', async () => {
      await this.executeInlineEdit();
    });
    context.subscriptions.push(inlineCmd);
  }
}
