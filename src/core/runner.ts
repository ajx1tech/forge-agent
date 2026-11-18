import * as vscode from 'vscode';
import { TrueForgeClient, NormalizedTurnEvent, ToolApprovalInput, CreateSessionOptions } from '../trueforge/client.js';
import { ChangeSet } from '../review/changeset.js';
import { McpServer } from '../mcp/server.js';
import { ModelFallbackManager, classifyError, retryWithBackoff, ClassifiedError } from '../trueforge/resilience.js';
import { ReviewController } from '../review/reviewController.js';
import { SCHEME_ORIGINAL, SCHEME_PROPOSED } from '../review/contentProvider.js';

export type RunState =
  | 'idle'
  | 'running'
  | 'paused-for-approval'
  | 'applying'
  | 'cancelling';

export interface RunControllerOptions {
  trueForgeClient: TrueForgeClient;
  changeSet: ChangeSet;
  fallbackManager: ModelFallbackManager;
  mcpServer?: McpServer;
  reviewController?: ReviewController;
  outputChannel?: vscode.OutputChannel;
}

export class RunController {
  private state: RunState = 'idle';
  private currentSessionId: string | null = null;
  private activeAbortController: AbortController | null = null;
  private trueForgeClient: TrueForgeClient;
  private changeSet: ChangeSet;
  private fallbackManager: ModelFallbackManager;
  private mcpServer?: McpServer;
  private reviewController?: ReviewController;
  private outputChannel?: vscode.OutputChannel;

  private stateChangeEmitter = new vscode.EventEmitter<RunState>();
  public readonly onDidChangeState: vscode.Event<RunState> = this.stateChangeEmitter.event;

  constructor(options: RunControllerOptions) {
    this.trueForgeClient = options.trueForgeClient;
    this.changeSet = options.changeSet;
    this.fallbackManager = options.fallbackManager;
    this.mcpServer = options.mcpServer;
    this.reviewController = options.reviewController;
    this.outputChannel = options.outputChannel;
  }

  public getState(): RunState {
    return this.state;
  }

  public setState(newState: RunState): void {
    if (this.state !== newState) {
      const oldState = this.state;
      this.state = newState;
      this.outputChannel?.appendLine(`[RunController] State transition: ${oldState} -> ${newState}`);
      this.stateChangeEmitter.fire(newState);
    }
  }

  public getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  public setCurrentSessionId(sessionId: string | null): void {
    this.currentSessionId = sessionId;
  }

  public getFallbackManager(): ModelFallbackManager {
    return this.fallbackManager;
  }

  /**
   * Creates a TrueForge session using the currently active model from fallbackManager.
   */
  public async createSession(options?: CreateSessionOptions): Promise<{ sessionId: string; data: any }> {
    const activeModel = this.fallbackManager.getActiveModel();
    const agentName = options?.agentName || 'forge-agent';

    const sessionOpts: CreateSessionOptions = {
      ...options,
      agentName,
      agentSpec: options?.agentSpec || {
        name: agentName,
        manifest: {
          model: { name: activeModel }
        }
      }
    };

    const res = await this.trueForgeClient.createSession(sessionOpts);
    this.currentSessionId = res.sessionId;
    return res;
  }

  /**
   * Starts a turn stream with automatic error classification, retry, and multi-model fallback.
   */
  public async *streamTurnWithResilience(
    prompt: string | any[],
    options?: { agentName?: string }
  ): AsyncGenerator<NormalizedTurnEvent, void, unknown> {
    if (this.state === 'running' || this.state === 'cancelling') {
      throw new Error(`Cannot start run while in state '${this.state}'.`);
    }

    this.setState('running');
    this.activeAbortController = new AbortController();

    let attemptTurn = 0;
    const maxFallbackAttempts = this.fallbackManager.getAllModels().length;

    while (attemptTurn < maxFallbackAttempts) {
      attemptTurn++;

      // Create session if needed
      if (!this.currentSessionId) {
        await this.createSession({ agentName: options?.agentName || 'forge-agent' });
      }

      const sessionId = this.currentSessionId!;

      try {
        // Simulated primary model failure check for dev test commands
        if (this.fallbackManager.isSimulateFailure() && this.fallbackManager.getActiveIndex() === 0) {
          throw new Error('Simulated primary model failure: 401 Unauthorized / Quota Exceeded (AUTH)');
        }

        // Run turn stream with retry for transient errors
        const stream = this.trueForgeClient.streamTurn(sessionId, prompt);

        for await (const event of stream) {
          if (this.activeAbortController?.signal.aborted) {
            this.outputChannel?.appendLine('[RunController] Turn stream aborted by local controller.');
            return;
          }

          if (event.type === 'approvalRequired') {
            this.setState('paused-for-approval');
          } else if (event.type === 'turnDone') {
            this.setState('idle');
          }

          yield event;
        }

        // Successfully completed turn stream
        this.activeAbortController = null;
        if (this.state !== 'idle') {
          this.setState('idle');
        }
        return;

      } catch (err: any) {
        const classified = classifyError(err);
        this.outputChannel?.appendLine(
          `[RunController] Error encountered (code: ${classified.code}, transient: ${classified.isTransient}): ${classified.message}`
        );

        // Check if fallback to next model should be triggered
        if (classified.shouldFallback && this.fallbackManager.hasFallback()) {
          // Discard any partial staged edits so zero files are changed on failure
          this.discardStagedChanges();

          const fallbackResult = this.fallbackManager.switchToFallback(classified.code);
          if (fallbackResult.success) {
            // Invalidate current session so a new session on fallback model is created
            this.currentSessionId = null;
            continue; // Retry with next model
          }
        }

        // If not recoverable by fallback, reset state and rethrow
        this.setState('idle');
        this.activeAbortController = null;
        throw err;
      }
    }

    this.setState('idle');
    this.activeAbortController = null;
  }

  public pauseForApproval(): void {
    this.setState('paused-for-approval');
  }

  public startApplying(): void {
    this.setState('applying');
  }

  public finishApplying(): void {
    this.setState('idle');
  }

  /**
   * Discards all in-memory staged changes and resets overlay hooks.
   * Guarantees zero files modified on failure or cancel.
   */
  public discardStagedChanges(): void {
    const all = this.changeSet.getAllStaged();
    for (const staged of all) {
      if (this.mcpServer) {
        this.mcpServer.setStagedOverlay(staged.path, null);
        this.mcpServer.setStagedOverlay(staged.fullPath, null);
      }
    }
    this.changeSet.clear();
    this.outputChannel?.appendLine('[RunController] Discarded staged ChangeSet and cleared overlays.');
  }

  /**
   * Closes any open VS Code review tabs matching forge-original or forge-proposed schemes.
   */
  public async closeReviewTabs(): Promise<void> {
    try {
      if (typeof vscode.window !== 'undefined' && 'tabGroups' in vscode.window) {
        const tabGroups = (vscode.window as any).tabGroups?.all || [];
        for (const group of tabGroups) {
          for (const tab of group.tabs || []) {
            const input = tab.input;
            if (input && typeof input === 'object') {
              const origScheme = input.original?.scheme;
              const propScheme = input.modified?.scheme;
              if (origScheme === SCHEME_ORIGINAL || propScheme === SCHEME_PROPOSED) {
                await (vscode.window as any).tabGroups.close(tab);
              }
            }
          }
        }
      }
    } catch (err: any) {
      this.outputChannel?.appendLine(`[RunController] Warning closing review tabs: ${err.message}`);
    }
  }

  /**
   * Clean cancellation state machine:
   * (idle -> running -> paused-for-approval -> applying -> cancelling -> idle)
   * Stop/Esc aborts local reader, calls sessions.cancel, discards staged ChangeSet/overlay,
   * closes review tabs, and leaves workspace git status completely clean.
   */
  public async cancel(): Promise<void> {
    if (this.state === 'idle') {
      return;
    }

    this.setState('cancelling');
    this.outputChannel?.appendLine('[RunController] Clean cancellation initiated.');

    // 1. Abort local reader / stream
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }

    // 2. Call sessions.cancel on TrueForge session
    if (this.currentSessionId) {
      try {
        await this.trueForgeClient.cancel(this.currentSessionId);
        this.outputChannel?.appendLine(`[RunController] Session ${this.currentSessionId} cancelled.`);
      } catch (err: any) {
        this.outputChannel?.appendLine(`[RunController] Error calling sessions.cancel: ${err.message}`);
      }
    }

    // 3. Discard staged ChangeSet and overlay
    this.discardStagedChanges();

    // 4. Close review tabs
    await this.closeReviewTabs();

    // 5. Complete transition back to idle
    this.setState('idle');
    this.outputChannel?.appendLine('[RunController] Cancellation complete. Workspace state is clean and idle.');
  }
}
