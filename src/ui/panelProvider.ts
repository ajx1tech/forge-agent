import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { TrueForgeClient, NormalizedTurnEvent } from '../trueforge/client.js';
import { WorkspaceIndexer } from '../context/indexer.js';
import { ReviewController } from '../review/reviewController.js';
import { ForgeConfig, getConfig } from '../config.js';
import { RunController } from '../core/runner.js';
import { PanelAction, initialPanelState, panelReducer } from './reducer.js';

export class ForgePanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'forge.chatView';

  private view?: vscode.WebviewView;
  private extensionUri: vscode.Uri;
  private trueForgeClient: TrueForgeClient;
  private indexer: WorkspaceIndexer;
  private reviewController: ReviewController;
  private runController?: RunController;
  private config: ForgeConfig;
  private currentSessionId: string | null = null;
  private isTurnActive: boolean = false;
  private outputChannel?: vscode.OutputChannel;

  constructor(options: {
    extensionUri: vscode.Uri;
    trueForgeClient: TrueForgeClient;
    indexer: WorkspaceIndexer;
    reviewController: ReviewController;
    runController?: RunController;
    config?: ForgeConfig;
    outputChannel?: vscode.OutputChannel;
  }) {
    this.extensionUri = options.extensionUri;
    this.trueForgeClient = options.trueForgeClient;
    this.indexer = options.indexer;
    this.reviewController = options.reviewController;
    this.runController = options.runController;
    this.config = options.config ?? getConfig();
    this.outputChannel = options.outputChannel;

    if (this.runController) {
      this.runController.getFallbackManager().onModelChange((newModel) => {
        this.postAction({ type: 'SET_MODEL', payload: newModel });
      });
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.extensionUri,
        vscode.Uri.joinPath(this.extensionUri, 'media')
      ]
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    // Send initial configuration
    const activeModel = this.runController
      ? this.runController.getFallbackManager().getActiveModel()
      : (this.config.models[0] || 'google-gemini/<primary-model-id>');
    this.postAction({ type: 'SET_MODEL', payload: activeModel });
    this.postAction({
      type: 'UPDATE_BUDGET',
      payload: { usedTokens: 0, maxTokens: this.config.contextBudgetTokens }
    });

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      await this.handleWebviewMessage(msg);
    });
  }

  public postAction(action: PanelAction | { type: string; payload: any }): void {
    if (this.view) {
      this.view.webview.postMessage(action);
    }
  }

  private async getOrCreateSession(): Promise<string> {
    if (!this.currentSessionId) {
      const res = await this.trueForgeClient.createSession({
        agentName: 'forge-agent',
        title: 'Forge VS Code Chat'
      });
      this.currentSessionId = res.sessionId;
    }
    return this.currentSessionId;
  }

  private async handleWebviewMessage(msg: { command: string; data?: any }): Promise<void> {
    switch (msg.command) {
      case 'sendMessage':
        await this.handleUserMessage(msg.data?.text);
        break;

      case 'cancel':
        if (this.runController) {
          try {
            await this.runController.cancel();
            this.postAction({ type: 'FINISH_STREAMING' });
          } catch (err: any) {
            this.outputChannel?.appendLine(`[Forge Panel] Cancel error: ${err.message}`);
          }
        } else if (this.currentSessionId && this.isTurnActive) {
          try {
            await this.trueForgeClient.cancel(this.currentSessionId);
            this.postAction({ type: 'FINISH_STREAMING' });
          } catch (err: any) {
            this.outputChannel?.appendLine(`[Forge Panel] Cancel error: ${err.message}`);
          }
        }
        break;

      case 'newChat':
        this.currentSessionId = null;
        this.isTurnActive = false;
        this.postAction({ type: 'CLEAR_CHAT' });
        this.postAction({
          type: 'UPDATE_BUDGET',
          payload: { usedTokens: 0, maxTokens: this.config.contextBudgetTokens }
        });
        break;

      case 'reviewChanges': {
        const staged = this.reviewController['changeSet'].getAllStaged();
        if (staged.length > 0) {
          await this.reviewController.openDiff(staged[0].path);
        } else {
          vscode.window.showInformationMessage('No staged changes under review.');
        }
        break;
      }

      case 'approveTool':
        await this.handleToolApproval(msg.data);
        break;

      case 'searchMentions':
        this.handleSearchMentions(msg.data?.query || '');
        break;
    }
  }

  private handleSearchMentions(query: string): void {
    const qLower = query.toLowerCase();
    const results: Array<{ name: string; path: string; kind: 'file' | 'symbol' }> = [];

    // Search indexed symbols
    const symbols = this.indexer.findSymbols(query);
    for (const s of symbols.slice(0, 8)) {
      results.push({
        name: s.name,
        path: `${s.filePath}:${s.line}`,
        kind: 'symbol'
      });
    }

    // Search workspace files
    const docs = this.indexer.getAllDocuments();
    for (const d of docs) {
      if (results.length >= 15) break;
      if (d.relativePath.toLowerCase().includes(qLower)) {
        if (!results.some(r => r.path === d.relativePath)) {
          results.push({
            name: path.basename(d.relativePath),
            path: d.relativePath,
            kind: 'file'
          });
        }
      }
    }

    this.postAction({
      type: 'SET_AUTOCOMPLETE_RESULTS',
      payload: results
    });
  }

  private async handleUserMessage(text: string): Promise<void> {
    if (!text || this.isTurnActive) return;

    try {
      this.isTurnActive = true;
      this.postAction({ type: 'START_STREAMING' });

      if (this.runController) {
        const stream = this.runController.streamTurnWithResilience(text);
        await this.consumeTurnStream(stream);
      } else {
        const sessionId = await this.getOrCreateSession();
        const stream = this.trueForgeClient.streamTurn(sessionId, text);
        await this.consumeTurnStream(stream);
      }
    } catch (err: any) {
      this.outputChannel?.appendLine(`[Forge Panel] Turn error: ${err.message}`);
      this.postAction({ type: 'SET_ERROR', payload: err.message });
      this.postAction({ type: 'FINISH_STREAMING' });
    } finally {
      this.isTurnActive = false;
    }
  }

  private async handleToolApproval(data: { id: string; threadId: string; decision: 'allow' | 'deny' }): Promise<void> {
    if (!this.currentSessionId || !data) return;

    this.postAction({
      type: 'RESOLVE_APPROVAL',
      payload: { id: data.id, decision: data.decision }
    });

    try {
      this.isTurnActive = true;
      this.postAction({ type: 'START_STREAMING' });

      const stream = this.trueForgeClient.resumeWithApprovals(this.currentSessionId, [
        {
          toolCallId: data.id,
          threadId: data.threadId || 'main',
          decision: data.decision
        }
      ]);

      await this.consumeTurnStream(stream);
    } catch (err: any) {
      this.outputChannel?.appendLine(`[Forge Panel] Resume approval error: ${err.message}`);
      this.postAction({ type: 'SET_ERROR', payload: err.message });
      this.postAction({ type: 'FINISH_STREAMING' });
    } finally {
      this.isTurnActive = false;
    }
  }

  private async consumeTurnStream(stream: AsyncGenerator<NormalizedTurnEvent, void, unknown>): Promise<void> {
    for await (const event of stream) {
      switch (event.type) {
        case 'textDelta':
          this.postAction({ type: 'APPEND_STREAM_CHUNK', payload: event.text });
          break;

        case 'approvalRequired':
          this.postAction({
            type: 'SET_APPROVAL_REQUEST',
            payload: {
              id: event.id,
              threadId: event.threadId,
              toolCalls: event.toolCalls,
              summary: event.toolCalls.map(tc => tc.name || 'tool').join(', ')
            }
          });
          break;

        case 'toolResult': {
          // If context items retrieved, send SET_CHOSEN_CONTEXT
          try {
            const parsed = JSON.parse(event.content);
            if (parsed && Array.isArray(parsed.items) && parsed.items.length > 0) {
              this.postAction({
                type: 'SET_CHOSEN_CONTEXT',
                payload: parsed.items
              });
            }
          } catch {}
          break;
        }

        case 'turnDone':
          if (event.usage) {
            this.postAction({
              type: 'UPDATE_BUDGET',
              payload: {
                usedTokens: event.usage.totalTokens || event.usage.inputTokens + event.usage.outputTokens,
                maxTokens: this.config.contextBudgetTokens
              }
            });
          }
          this.postAction({ type: 'FINISH_STREAMING' });
          break;
      }
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const mediaDir = vscode.Uri.joinPath(this.extensionUri, 'media');
    const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'panel.html');
    let template = fs.existsSync(htmlPath)
      ? fs.readFileSync(htmlPath, 'utf8')
      : this.getDefaultHtmlTemplate();

    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, 'panel.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, 'panel.css'));
    const nonce = crypto.randomBytes(16).toString('base64');

    return template
      .replace(/\{\{cspSource\}\}/g, webview.cspSource)
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace(/\{\{styleUri\}\}/g, styleUri.toString())
      .replace(/\{\{scriptUri\}\}/g, scriptUri.toString());
  }

  private getDefaultHtmlTemplate(): string {
    return `<!DOCTYPE html><html><body><h3>Forge Agent</h3></body></html>`;
  }
}
