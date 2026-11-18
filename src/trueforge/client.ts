import * as vscode from 'vscode';
import { TrueForge } from '@truefoundry/trueforge-sdk';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
}

export type NormalizedTurnEvent =
  | { type: 'turnCreated'; turnId: string; threadId: string | null; createdAt: string }
  | { type: 'textDelta'; text: string; threadId: string }
  | { type: 'toolCall'; id: string; name: string; arguments: any; threadId: string }
  | { type: 'toolResult'; toolCallId: string; content: string; threadId: string }
  | { type: 'approvalRequired'; id: string; threadId: string; toolCalls: Array<{ id: string; name?: string; arguments?: any }> }
  | { type: 'threadCreated'; threadId: string; title?: string }
  | { type: 'threadDone'; threadId: string; state?: any }
  | { type: 'turnDone'; turnId?: string; state: any; usage?: TokenUsage };

export interface ToolApprovalInput {
  toolCallId: string;
  threadId: string;
  decision: 'allow' | 'deny';
  reason?: string;
}

export interface CreateSessionOptions {
  agentName?: string;
  agentSpec?: any;
  title?: string;
}

export class TrueForgeClient {
  private client: TrueForge;
  private outputChannel: vscode.OutputChannel;

  constructor(clientOrOptions: TrueForge | { baseUrl?: string; token?: string } | any, outputChannel?: vscode.OutputChannel) {
    if (clientOrOptions && (clientOrOptions instanceof TrueForge || 'sessions' in clientOrOptions)) {
      this.client = clientOrOptions;
    } else {
      this.client = new TrueForge({
        baseUrl: clientOrOptions?.baseUrl || 'http://localhost:8790',
        token: clientOrOptions?.token
      });
    }

    if (outputChannel) {
      this.outputChannel = outputChannel;
    } else {
      try {
        this.outputChannel = vscode.window.createOutputChannel('Forge');
      } catch {
        // Fallback dummy channel for headless testing
        this.outputChannel = {
          name: 'Forge',
          append: () => {},
          appendLine: () => {},
          clear: () => {},
          show: () => {},
          hide: () => {},
          dispose: () => {}
        } as unknown as vscode.OutputChannel;
      }
    }
  }

  public getRawClient(): TrueForge {
    return this.client;
  }

  public getOutputChannel(): vscode.OutputChannel {
    return this.outputChannel;
  }

  public async createSession(options?: CreateSessionOptions): Promise<{ sessionId: string; data: any }> {
    const agentParam: any = options?.agentSpec
      ? { spec: options.agentSpec }
      : { name: options?.agentName ?? 'forge-agent' };

    const request: any = {
      agent: agentParam
    };
    if (options?.title) {
      request.metadata = { title: options.title };
    }
    const resp = await this.client.sessions.create(request);

    const sessionId = resp.data.id;
    this.outputChannel.appendLine(`[Forge] Created session: ${sessionId}`);
    return {
      sessionId,
      data: resp.data
    };
  }

  public async cancel(sessionId: string): Promise<void> {
    this.outputChannel.appendLine(`[Forge] Cancelling session turn: ${sessionId}`);
    await this.client.sessions.cancel(sessionId);
  }

  public async *resumeWithApprovals(
    sessionId: string,
    approvals: ToolApprovalInput[]
  ): AsyncGenerator<NormalizedTurnEvent, void, unknown> {
    this.outputChannel.appendLine(`[Forge] Resuming turn with ${approvals.length} approvals for session ${sessionId}`);

    const inputEvents = approvals.map(appr => ({
      type: 'user.tool_approval' as const,
      threadId: appr.threadId,
      toolCallId: appr.toolCallId,
      approval: appr.decision === 'allow'
        ? { status: 'allow' as const }
        : { status: 'deny' as const, reason: appr.reason }
    }));

    yield* this.processTurnStream(sessionId, inputEvents as any);
  }

  public async *streamTurn(
    sessionId: string,
    input: string | any[],
    previousTurnId?: string
  ): AsyncGenerator<NormalizedTurnEvent, void, unknown> {
    const inputItems = Array.isArray(input)
      ? input
      : [
          {
            type: 'user.message' as const,
            content: input
          }
        ];

    yield* this.processTurnStream(sessionId, inputItems, previousTurnId);
  }

  private async *processTurnStream(
    sessionId: string,
    inputItems: any[],
    previousTurnId?: string
  ): AsyncGenerator<NormalizedTurnEvent, void, unknown> {
    const responseStream = await this.client.sessions.createTurnStream(sessionId, {
      input: inputItems,
      previousTurnId
    });

    // Delta merging state for tool calls
    const pendingToolCalls = new Map<number, {
      id: string;
      name: string;
      arguments: string;
      threadId: string;
    }>();
    const emittedToolCallIds = new Set<string>();

    for await (const rawEvent of responseStream) {
      const event = rawEvent as any;
      if (!event || !event.type) continue;

      switch (event.type) {
        case 'turn.created': {
          yield {
            type: 'turnCreated',
            turnId: event.turnId,
            threadId: event.threadId ?? null,
            createdAt: event.createdAt
          };
          break;
        }

        case 'model.message.delta': {
          const threadId = event.threadId || 'main';

          // Emit text delta if content present
          if (event.content) {
            yield {
              type: 'textDelta',
              text: event.content,
              threadId
            };
          }

          // Tool calls delta merging
          if (Array.isArray(event.toolCalls)) {
            for (const chunk of event.toolCalls) {
              const idx = typeof chunk.index === 'number' ? chunk.index : 0;
              let existing = pendingToolCalls.get(idx);
              if (!existing) {
                existing = {
                  id: chunk.id || '',
                  name: '',
                  arguments: '',
                  threadId
                };
                pendingToolCalls.set(idx, existing);
              }
              if (chunk.id && !existing.id) {
                existing.id = chunk.id;
              }
              if (chunk.function?.name) {
                existing.name += chunk.function.name;
              }
              if (chunk.function?.arguments) {
                existing.arguments += chunk.function.arguments;
              }
            }
          }

          // If delta indicates finish or tool calls ready
          if (event.finishReason === 'tool_calls' || event.finishReason === 'stop') {
            for (const [idx, ptc] of pendingToolCalls.entries()) {
              if (ptc.id && !emittedToolCallIds.has(ptc.id)) {
                emittedToolCallIds.add(ptc.id);
                let parsedArgs = ptc.arguments;
                try {
                  parsedArgs = JSON.parse(ptc.arguments);
                } catch {
                  // keep raw string if not full JSON
                }
                yield {
                  type: 'toolCall',
                  id: ptc.id,
                  name: ptc.name,
                  arguments: parsedArgs,
                  threadId: ptc.threadId
                };
              }
            }
            pendingToolCalls.clear();
          }

          // Token and cost logging if usage present
          if (event.usage) {
            this.logUsage(event.usage);
          }
          break;
        }

        case 'model.message': {
          const threadId = event.threadId || 'main';

          // Emit complete tool calls if provided
          if (Array.isArray(event.toolCalls)) {
            for (const tc of event.toolCalls) {
              if (tc.id && !emittedToolCallIds.has(tc.id)) {
                emittedToolCallIds.add(tc.id);
                let parsedArgs = tc.function?.arguments;
                try {
                  if (typeof parsedArgs === 'string') {
                    parsedArgs = JSON.parse(parsedArgs);
                  }
                } catch {
                  // keep raw
                }
                yield {
                  type: 'toolCall',
                  id: tc.id,
                  name: tc.function?.name || '',
                  arguments: parsedArgs,
                  threadId
                };
              }
            }
          }

          if (event.usage) {
            this.logUsage(event.usage);
          }
          break;
        }

        case 'tool.approval_required': {
          const threadId = event.threadId || 'main';
          yield {
            type: 'approvalRequired',
            id: event.id,
            threadId,
            toolCalls: Array.isArray(event.toolCalls) ? event.toolCalls : []
          };
          break;
        }

        case 'tool.response': {
          yield {
            type: 'toolResult',
            toolCallId: event.toolCallId,
            content: event.content,
            threadId: event.threadId || 'main'
          };
          break;
        }

        case 'thread.created': {
          yield {
            type: 'threadCreated',
            threadId: event.threadId,
            title: event.title
          };
          break;
        }

        case 'thread.done': {
          yield {
            type: 'threadDone',
            threadId: event.threadId,
            state: event.state
          };
          break;
        }

        case 'turn.done': {
          // Flush any pending tool calls that weren't emitted
          for (const [idx, ptc] of pendingToolCalls.entries()) {
            if (ptc.id && !emittedToolCallIds.has(ptc.id)) {
              emittedToolCallIds.add(ptc.id);
              let parsedArgs = ptc.arguments;
              try {
                parsedArgs = JSON.parse(ptc.arguments);
              } catch {
                // keep raw
              }
              yield {
                type: 'toolCall',
                id: ptc.id,
                name: ptc.name,
                arguments: parsedArgs,
                threadId: ptc.threadId
              };
            }
          }
          pendingToolCalls.clear();

          const usage = event.state?.usage ? this.logUsage(event.state.usage) : undefined;
          yield {
            type: 'turnDone',
            turnId: event.id,
            state: event.state,
            usage
          };
          break;
        }

        default:
          // Ignore other events
          break;
      }
    }
  }

  private logUsage(usage: any): TokenUsage {
    const inputTokens = Number(usage.inputTokens) || 0;
    const outputTokens = Number(usage.outputTokens) || 0;
    const totalTokens = inputTokens + outputTokens;
    // Estimated standard rate: $1.50 / 1M input ($0.0000015), $2.00 / 1M output ($0.000002)
    const cost = (inputTokens * 0.0000015) + (outputTokens * 0.000002);

    this.outputChannel.appendLine(
      `[Forge] Tokens: input=${inputTokens}, output=${outputTokens}, total=${totalTokens}, cost=$${cost.toFixed(6)}`
    );

    return {
      inputTokens,
      outputTokens,
      totalTokens,
      cost
    };
  }
}
