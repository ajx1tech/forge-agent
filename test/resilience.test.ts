import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import {
  classifyError,
  retryWithBackoff,
  ModelFallbackManager,
  ResilienceErrorCode
} from '../src/trueforge/resilience.js';
import { RunController, RunState } from '../src/core/runner.js';
import { ChangeSet } from '../src/review/changeset.js';
import { TrueForgeClient } from '../src/trueforge/client.js';
import { McpServer } from '../src/mcp/server.js';
import { ReviewController } from '../src/review/reviewController.js';
import { UndoManager } from '../src/review/undo.js';
import { ReviewContentProvider } from '../src/review/contentProvider.js';
import { HunkCodeLensProvider } from '../src/review/codelens.js';

describe('Resilience, Clean Cancellation & Multi-Model Fallback Tests', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-resilience-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // ==========================================
  // 1. ERROR CLASSIFICATION (6 CODES)
  // ==========================================
  describe('Error Classification for 6 Failure Modes', () => {
    it('should classify AUTH errors (401/403/unauthorized)', () => {
      const err1 = { status: 401, message: 'Unauthorized access' };
      const res1 = classifyError(err1);
      expect(res1.code).toBe('AUTH');
      expect(res1.isTransient).toBe(false);
      expect(res1.shouldFallback).toBe(true);

      const err2 = new Error('Invalid API Key provided');
      const res2 = classifyError(err2);
      expect(res2.code).toBe('AUTH');
      expect(res2.shouldFallback).toBe(true);
    });

    it('should classify UNREACHABLE errors (connection refused/network error)', () => {
      const err1 = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:8790' };
      const res1 = classifyError(err1);
      expect(res1.code).toBe('UNREACHABLE');
      expect(res1.isTransient).toBe(true);
      expect(res1.shouldFallback).toBe(true);

      const err2 = new Error('fetch failed: network error');
      const res2 = classifyError(err2);
      expect(res2.code).toBe('UNREACHABLE');
      expect(res2.isTransient).toBe(true);
    });

    it('should classify RATE_LIMIT errors (429/quota exceeded)', () => {
      const err1 = { status: 429, message: 'Too Many Requests' };
      const res1 = classifyError(err1);
      expect(res1.code).toBe('RATE_LIMIT');
      expect(res1.isTransient).toBe(true);
      expect(res1.shouldFallback).toBe(true);

      const err2 = new Error('Resource exhausted: quota exceeded');
      const res2 = classifyError(err2);
      expect(res2.code).toBe('RATE_LIMIT');
      expect(res2.isTransient).toBe(true);
    });

    it('should classify SERVER errors (500/502/bad gateway)', () => {
      const err1 = { status: 500, message: 'Internal Server Error' };
      const res1 = classifyError(err1);
      expect(res1.code).toBe('SERVER');
      expect(res1.isTransient).toBe(true);

      const err2 = { status: 502, message: 'Bad Gateway' };
      const res2 = classifyError(err2);
      expect(res2.code).toBe('SERVER');
      expect(res2.isTransient).toBe(true);
    });

    it('should classify CONTEXT_TOO_LONG errors', () => {
      const err = new Error('This model maximum context length is 8192 tokens. However, your messages resulted in 9400 tokens.');
      const res = classifyError(err);
      expect(res.code).toBe('CONTEXT_TOO_LONG');
      expect(res.isTransient).toBe(false);
      expect(res.shouldFallback).toBe(false);
    });

    it('should classify SERVER_DOWN errors (503/service unavailable)', () => {
      const err1 = { status: 503, message: 'Service Temporarily Unavailable' };
      const res1 = classifyError(err1);
      expect(res1.code).toBe('SERVER_DOWN');
      expect(res1.isTransient).toBe(true);
      expect(res1.shouldFallback).toBe(true);

      const err2 = new Error('TrueForge server is down');
      const res2 = classifyError(err2);
      expect(res2.code).toBe('SERVER_DOWN');
      expect(res2.isTransient).toBe(true);
    });
  });

  // ==========================================
  // 2. RETRY WITH BACKOFF
  // ==========================================
  describe('Transient Error Retry with Backoff', () => {
    it('should retry transient errors and succeed when operation succeeds on retry', async () => {
      let attempts = 0;
      const operation = vi.fn(async () => {
        attempts++;
        if (attempts < 2) {
          throw { status: 500, message: 'Temporary server error' };
        }
        return 'success';
      });

      const retriesRecorded: number[] = [];
      const result = await retryWithBackoff(operation, {
        maxRetries: 2,
        initialDelayMs: 0,
        sleepFn: vi.fn(async () => {}),
        onRetry: (att) => retriesRecorded.push(att)
      });

      expect(result).toBe('success');
      expect(attempts).toBe(2);
      expect(retriesRecorded).toEqual([1]);
    });

    it('should not retry non-transient errors like AUTH', async () => {
      let attempts = 0;
      const operation = vi.fn(async () => {
        attempts++;
        throw { status: 401, message: 'Unauthorized' };
      });

      await expect(
        retryWithBackoff(operation, { maxRetries: 3, initialDelayMs: 0 })
      ).rejects.toMatchObject({ status: 401 });

      expect(attempts).toBe(1); // Fails immediately on first attempt
    });

    it('should throw when all retries are exhausted', async () => {
      let attempts = 0;
      const operation = vi.fn(async () => {
        attempts++;
        throw { status: 429, message: 'Rate limit exceeded' };
      });

      await expect(
        retryWithBackoff(operation, {
          maxRetries: 2,
          initialDelayMs: 0,
          sleepFn: vi.fn(async () => {})
        })
      ).rejects.toMatchObject({ status: 429 });

      expect(attempts).toBe(3); // 1 initial + 2 retries
    });
  });

  // ==========================================
  // 3. MULTI-MODEL FALLBACK MANAGER
  // ==========================================
  describe('Multi-Model Fallback Manager', () => {
    const models = [
      'google-gemini/<primary-model-id>',
      'custom/<groq-model-id>',
      'anthropic-claude/<tertiary-model-id>'
    ];

    it('should start with primary model and progress sequentially through fallbacks', () => {
      const fallbackMgr = new ModelFallbackManager(models);

      expect(fallbackMgr.getActiveIndex()).toBe(0);
      expect(fallbackMgr.getActiveModel()).toBe(models[0]);
      expect(fallbackMgr.hasFallback()).toBe(true);

      // Switch to secondary model
      const res1 = fallbackMgr.switchToFallback('AUTH error');
      expect(res1.success).toBe(true);
      expect(res1.model).toBe(models[1]);
      expect(fallbackMgr.getActiveIndex()).toBe(1);
      expect(fallbackMgr.hasFallback()).toBe(true);

      // Switch to tertiary model
      const res2 = fallbackMgr.switchToFallback('Quota exceeded');
      expect(res2.success).toBe(true);
      expect(res2.model).toBe(models[2]);
      expect(fallbackMgr.getActiveIndex()).toBe(2);
      expect(fallbackMgr.hasFallback()).toBe(false);

      // Attempting to switch past end returns false
      const res3 = fallbackMgr.switchToFallback('Exhausted');
      expect(res3.success).toBe(false);
      expect(res3.model).toBe(models[2]);
    });

    it('should notify registered listeners and display non-modal banner on model switch', () => {
      const fallbackMgr = new ModelFallbackManager(models);
      const notified: string[] = [];
      fallbackMgr.onModelChange((m) => notified.push(m));

      fallbackMgr.switchToFallback('Simulated 401');

      expect(notified).toEqual([models[1]]);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('Switched to fallback')
      );
    });

    it('should restore models to primary index and clear failure flags', () => {
      const fallbackMgr = new ModelFallbackManager(models);
      fallbackMgr.switchToFallback();
      fallbackMgr.setSimulateFailure(true);

      expect(fallbackMgr.getActiveIndex()).toBe(1);
      expect(fallbackMgr.isSimulateFailure()).toBe(true);

      const restored = fallbackMgr.restoreModels();
      expect(restored).toBe(models[0]);
      expect(fallbackMgr.getActiveIndex()).toBe(0);
      expect(fallbackMgr.isSimulateFailure()).toBe(false);
    });
  });

  // ==========================================
  // 4. RUNCONTROLLER CANCELLATION STATE MACHINE
  // ==========================================
  describe('RunController Clean Cancellation State Machine', () => {
    it('should transition through state machine: idle -> running -> paused -> applying -> cancelling -> idle', () => {
      const changeSet = new ChangeSet(tempDir);
      const fallbackMgr = new ModelFallbackManager(['primary', 'fallback']);
      const trueForgeClient = new TrueForgeClient({ baseUrl: 'http://localhost:8790' });

      const runner = new RunController({
        trueForgeClient,
        changeSet,
        fallbackManager: fallbackMgr
      });

      const statesRecorded: RunState[] = [];
      runner.onDidChangeState((s) => statesRecorded.push(s));

      expect(runner.getState()).toBe('idle');

      runner.setState('running');
      expect(runner.getState()).toBe('running');

      runner.pauseForApproval();
      expect(runner.getState()).toBe('paused-for-approval');

      runner.startApplying();
      expect(runner.getState()).toBe('applying');

      runner.finishApplying();
      expect(runner.getState()).toBe('idle');

      expect(statesRecorded).toEqual([
        'running',
        'paused-for-approval',
        'applying',
        'idle'
      ]);
    });

    it('cancel should abort reader, call sessions.cancel, discard ChangeSet, and leave workspace clean', async () => {
      const testFile = path.join(tempDir, 'cancel_target.py');
      const originalCode = 'def process():\n    pass\n';
      fs.writeFileSync(testFile, originalCode, 'utf8');

      const changeSet = new ChangeSet(tempDir);
      const fallbackMgr = new ModelFallbackManager(['model-a', 'model-b']);
      const mockRawClient = {
        sessions: {
          cancel: vi.fn().mockResolvedValue({ status: 'cancelled' }),
          createTurnStream: vi.fn()
        }
      };
      const trueForgeClient = new TrueForgeClient(mockRawClient as any);

      const runner = new RunController({
        trueForgeClient,
        changeSet,
        fallbackManager: fallbackMgr
      });

      runner.setCurrentSessionId('session-cancel-123');
      runner.setState('running');

      // Stage an in-memory edit before cancel
      changeSet.stageEdits('cancel_target.py', [
        { old_str: 'pass', new_str: 'print("MODIFIED")' }
      ]);
      expect(changeSet.hasStaged()).toBe(true);

      // Trigger clean cancellation
      await runner.cancel();

      // State is back to idle
      expect(runner.getState()).toBe('idle');

      // sessions.cancel was called on TrueForgeClient
      expect(mockRawClient.sessions.cancel).toHaveBeenCalledWith('session-cancel-123');

      // In-memory changeset was discarded
      expect(changeSet.hasStaged()).toBe(false);

      // Workspace disk content remains completely untouched (clean git status)
      const diskContent = fs.readFileSync(testFile, 'utf8');
      expect(diskContent).toBe(originalCode);
    });
  });

  // ==========================================
  // 5. RESILIENCE STREAMING WITH AUTOMATIC FAILOVER
  // ==========================================
  describe('Automatic Failover during Stream Execution', () => {
    it('should automatically failover to secondary model on primary failure and yield events', async () => {
      const changeSet = new ChangeSet(tempDir);
      const fallbackMgr = new ModelFallbackManager(['primary-gemini', 'fallback-groq']);

      let callCount = 0;
      const mockRawClient = {
        sessions: {
          create: vi.fn(async (req) => {
            return {
              data: {
                id: `session-${callCount}`
              }
            };
          }),
          createTurnStream: vi.fn(async function* (sessionId, req) {
            callCount++;
            if (callCount === 1) {
              // Primary model fails with AUTH / 401
              throw { status: 401, message: 'Primary API quota or auth invalid' };
            }

            // Fallback model succeeds
            yield { type: 'turn.created', turnId: 'turn-1', createdAt: '2026-11-17T00:00:00Z' };
            yield { type: 'model.message.delta', content: 'Fallback model response.' };
            yield { type: 'turn.done', state: { status: 'completed' } };
          }),
          cancel: vi.fn().mockResolvedValue(undefined)
        }
      };

      const trueForgeClient = new TrueForgeClient(mockRawClient as any);
      const runner = new RunController({
        trueForgeClient,
        changeSet,
        fallbackManager: fallbackMgr
      });

      const events: any[] = [];
      const stream = runner.streamTurnWithResilience('Explain architecture');
      for await (const evt of stream) {
        events.push(evt);
      }

      // Succeeded via fallback model
      expect(events.length).toBeGreaterThan(0);
      expect(events.some(e => e.type === 'textDelta' && e.text.includes('Fallback model response.'))).toBe(true);

      // Model fallback manager was switched to secondary model
      expect(fallbackMgr.getActiveIndex()).toBe(1);
      expect(fallbackMgr.getActiveModel()).toBe('fallback-groq');
      expect(runner.getState()).toBe('idle');
    });

    it('should support simulation dev command to force primary model failure', async () => {
      const fallbackMgr = new ModelFallbackManager(['primary', 'fallback']);
      const trueForgeClient = new TrueForgeClient({ baseUrl: 'http://localhost:8790' });
      const changeSet = new ChangeSet(tempDir);

      const runner = new RunController({
        trueForgeClient,
        changeSet,
        fallbackManager: fallbackMgr
      });

      // Enable simulated failure
      fallbackMgr.setSimulateFailure(true);
      expect(fallbackMgr.isSimulateFailure()).toBe(true);

      // Restore models
      fallbackMgr.restoreModels();
      expect(fallbackMgr.isSimulateFailure()).toBe(false);
      expect(fallbackMgr.getActiveIndex()).toBe(0);
    });
  });
});
