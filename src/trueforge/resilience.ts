import * as vscode from 'vscode';

export type ResilienceErrorCode =
  | 'AUTH'
  | 'UNREACHABLE'
  | 'RATE_LIMIT'
  | 'SERVER'
  | 'CONTEXT_TOO_LONG'
  | 'SERVER_DOWN';

export interface ClassifiedError {
  code: ResilienceErrorCode;
  message: string;
  isTransient: boolean;
  shouldFallback: boolean;
  statusCode?: number;
  originalError: any;
}

/**
 * Classifies an error into one of the 6 standard resilience error codes:
 * AUTH, UNREACHABLE, RATE_LIMIT, SERVER, CONTEXT_TOO_LONG, SERVER_DOWN.
 */
export function classifyError(err: any): ClassifiedError {
  const message = (err?.message || (typeof err === 'string' ? err : 'Unknown error')).toString();
  const lowerMsg = message.toLowerCase();
  const statusCode = err?.status ?? err?.statusCode ?? err?.response?.status;
  const errorCode = (err?.code || '').toString().toUpperCase();

  // 1. CONTEXT_TOO_LONG
  if (
    lowerMsg.includes('context length exceeded') ||
    lowerMsg.includes('maximum context length') ||
    lowerMsg.includes('context_length_exceeded') ||
    lowerMsg.includes('too many tokens') ||
    lowerMsg.includes('prompt is too long') ||
    lowerMsg.includes('token limit exceeded') ||
    lowerMsg.includes('context_window_exceeded')
  ) {
    return {
      code: 'CONTEXT_TOO_LONG',
      message,
      isTransient: false,
      shouldFallback: false,
      statusCode,
      originalError: err
    };
  }

  // 2. AUTH
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    errorCode === 'AUTH' ||
    errorCode === 'UNAUTHORIZED' ||
    errorCode === 'FORBIDDEN' ||
    lowerMsg.includes('unauthorized') ||
    lowerMsg.includes('forbidden') ||
    lowerMsg.includes('invalid api key') ||
    lowerMsg.includes('invalid bearer token') ||
    lowerMsg.includes('authentication failed') ||
    lowerMsg.includes('auth error')
  ) {
    return {
      code: 'AUTH',
      message,
      isTransient: false,
      shouldFallback: true,
      statusCode,
      originalError: err
    };
  }

  // 3. RATE_LIMIT
  if (
    statusCode === 429 ||
    errorCode === 'RATE_LIMIT' ||
    lowerMsg.includes('rate limit') ||
    lowerMsg.includes('quota exceeded') ||
    lowerMsg.includes('resource_exhausted') ||
    lowerMsg.includes('too many requests') ||
    lowerMsg.includes('429')
  ) {
    return {
      code: 'RATE_LIMIT',
      message,
      isTransient: true,
      shouldFallback: true,
      statusCode,
      originalError: err
    };
  }

  // 4. SERVER_DOWN
  if (
    statusCode === 503 ||
    lowerMsg.includes('service unavailable') ||
    lowerMsg.includes('server is down') ||
    lowerMsg.includes('server down') ||
    lowerMsg.includes('temporarily unavailable')
  ) {
    return {
      code: 'SERVER_DOWN',
      message,
      isTransient: true,
      shouldFallback: true,
      statusCode,
      originalError: err
    };
  }

  // 5. UNREACHABLE
  if (
    errorCode === 'ECONNREFUSED' ||
    errorCode === 'ENOTFOUND' ||
    errorCode === 'EAI_AGAIN' ||
    errorCode === 'ECONNRESET' ||
    errorCode === 'ETIMEDOUT' ||
    lowerMsg.includes('econnrefused') ||
    lowerMsg.includes('network error') ||
    lowerMsg.includes('unreachable') ||
    lowerMsg.includes('failed to fetch') ||
    lowerMsg.includes('fetch failed') ||
    lowerMsg.includes('connection refused')
  ) {
    return {
      code: 'UNREACHABLE',
      message,
      isTransient: true,
      shouldFallback: true,
      statusCode,
      originalError: err
    };
  }

  // 6. SERVER
  if (
    (typeof statusCode === 'number' && statusCode >= 500 && statusCode < 600) ||
    lowerMsg.includes('internal server error') ||
    lowerMsg.includes('bad gateway') ||
    lowerMsg.includes('gateway timeout') ||
    lowerMsg.includes('server error')
  ) {
    return {
      code: 'SERVER',
      message,
      isTransient: true,
      shouldFallback: true,
      statusCode,
      originalError: err
    };
  }

  // Default fallback classification
  return {
    code: 'SERVER',
    message,
    isTransient: true,
    shouldFallback: true,
    statusCode,
    originalError: err
  };
}

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
  onRetry?: (attempt: number, classified: ClassifiedError) => void;
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Retries transient errors with exponential backoff.
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 2;
  const initialDelay = options?.initialDelayMs ?? 100;
  const factor = options?.backoffFactor ?? 2;
  const sleep = options?.sleepFn ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));

  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err: any) {
      lastError = err;
      const classified = classifyError(err);

      // If not transient (e.g. AUTH or CONTEXT_TOO_LONG), fail immediately without retry
      if (!classified.isTransient || attempt >= maxRetries) {
        throw err;
      }

      if (options?.onRetry) {
        options.onRetry(attempt + 1, classified);
      }

      const delay = initialDelay * Math.pow(factor, attempt);
      if (delay > 0) {
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

/**
 * Manages multi-model fallback state, automatic failover, and simulation commands.
 */
export class ModelFallbackManager {
  private models: string[];
  private activeIndex: number = 0;
  private simulateFailure: boolean = false;
  private outputChannel?: vscode.OutputChannel;
  private onModelChangeCallbacks: Array<(model: string) => void> = [];

  constructor(models: string[], outputChannel?: vscode.OutputChannel) {
    this.models = models.length > 0 ? [...models] : ['google-gemini/<primary-model-id>'];
    this.outputChannel = outputChannel;
  }

  public getActiveModel(): string {
    return this.models[this.activeIndex] || this.models[0];
  }

  public getActiveIndex(): number {
    return this.activeIndex;
  }

  public getAllModels(): string[] {
    return [...this.models];
  }

  public hasFallback(): boolean {
    return this.activeIndex < this.models.length - 1;
  }

  public isSimulateFailure(): boolean {
    return this.simulateFailure;
  }

  public setSimulateFailure(value: boolean): void {
    this.simulateFailure = value;
    this.outputChannel?.appendLine(`[Forge Resilience] Primary model failure simulation: ${value ? 'ENABLED' : 'DISABLED'}`);
  }

  public onModelChange(callback: (model: string) => void): { dispose: () => void } {
    this.onModelChangeCallbacks.push(callback);
    return {
      dispose: () => {
        const idx = this.onModelChangeCallbacks.indexOf(callback);
        if (idx >= 0) this.onModelChangeCallbacks.splice(idx, 1);
      }
    };
  }

  private notifyModelChange(model: string): void {
    for (const cb of this.onModelChangeCallbacks) {
      try {
        cb(model);
      } catch (e) {
        console.error('[ModelFallbackManager] Callback error:', e);
      }
    }
  }

  /**
   * Switches to the next fallback model in the list and shows non-modal notification banner.
   */
  public switchToFallback(reason?: string): { success: boolean; model: string } {
    if (!this.hasFallback()) {
      this.outputChannel?.appendLine(`[Forge Resilience] No fallback models available beyond '${this.getActiveModel()}'.`);
      return { success: false, model: this.getActiveModel() };
    }

    const previousModel = this.getActiveModel();
    this.activeIndex++;
    const newModel = this.getActiveModel();

    const bannerMsg = `Primary model failed${reason ? ` (${reason})` : ''}... Switched to fallback: ${newModel}`;
    this.outputChannel?.appendLine(`[Forge Resilience] ${bannerMsg}`);

    // Show non-modal banner notification in VS Code
    vscode.window.showInformationMessage(bannerMsg);

    // Notify UI / webview listeners to update model badge
    this.notifyModelChange(newModel);

    return { success: true, model: newModel };
  }

  /**
   * Restores model selection back to primary model and clears simulation flags.
   */
  public restoreModels(): string {
    this.activeIndex = 0;
    this.simulateFailure = false;
    const primary = this.getActiveModel();
    this.outputChannel?.appendLine(`[Forge Resilience] Restored to primary model: ${primary}`);
    vscode.window.showInformationMessage(`Forge: Restored to primary model: ${primary}`);
    this.notifyModelChange(primary);
    return primary;
  }
}
