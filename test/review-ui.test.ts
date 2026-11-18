import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import {
  computeHunks,
  applyHunks,
  detectLineEnding,
  splitContent,
  isHunkOutsideSelection,
  DiffHunk
} from '../src/review/hunks.js';
import { ChangeSet } from '../src/review/changeset.js';
import { UndoManager, UndoRecord } from '../src/review/undo.js';
import { ReviewContentProvider, SCHEME_ORIGINAL, SCHEME_PROPOSED } from '../src/review/contentProvider.js';
import { HunkCodeLensProvider } from '../src/review/codelens.js';
import { ReviewController } from '../src/review/reviewController.js';
import { EditToolsManager } from '../src/mcp/tools/editTools.js';
import { McpServer } from '../src/mcp/server.js';
import {
  panelReducer,
  initialPanelState,
  PanelState,
  ContextItem
} from '../src/ui/reducer.js';

describe('Diff Review, Staged ChangeSet, Undo & Webview Reducer Tests', () => {
  let tempDir: string;
  let globalStorageDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-review-test-'));
    globalStorageDir = path.join(tempDir, 'global-storage');
    fs.mkdirSync(globalStorageDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // ==========================================
  // 1. HUNKS COMPUTATION & CRLF PRESERVATION
  // ==========================================
  describe('Diff Hunk Generation & CRLF Handling', () => {
    it('should detect CRLF and LF line endings correctly', () => {
      expect(detectLineEnding('hello\r\nworld')).toBe('\r\n');
      expect(detectLineEnding('hello\nworld')).toBe('\n');
      expect(detectLineEnding('hello world')).toBe('\n');
    });

    it('should split content preserving line endings and trailing newline status', () => {
      const crlfContent = 'line 1\r\nline 2\r\n';
      const parsedCrlf = splitContent(crlfContent);
      expect(parsedCrlf.eol).toBe('\r\n');
      expect(parsedCrlf.hasTrailingNewline).toBe(true);
      expect(parsedCrlf.lines).toEqual(['line 1', 'line 2']);

      const lfContent = 'line 1\nline 2';
      const parsedLf = splitContent(lfContent);
      expect(parsedLf.eol).toBe('\n');
      expect(parsedLf.hasTrailingNewline).toBe(false);
      expect(parsedLf.lines).toEqual(['line 1', 'line 2']);
    });

    it('should compute exact diff hunks for additions, deletions, and replacements', () => {
      const original = 'alpha\nbeta\ngamma\ndelta\n';
      const proposed = 'alpha\nbeta_modified\ngamma\nepsilon\ndelta\n';

      const hunks = computeHunks('test.txt', original, proposed);
      expect(hunks.length).toBe(2);

      // Hunk 0: beta -> beta_modified
      expect(hunks[0].originalStartLine).toBe(2);
      expect(hunks[0].originalLines).toEqual(['beta']);
      expect(hunks[0].proposedLines).toEqual(['beta_modified']);

      // Hunk 1: insertion of epsilon before delta
      expect(hunks[1].originalStartLine).toBe(4);
      expect(hunks[1].originalLines).toEqual([]);
      expect(hunks[1].proposedLines).toEqual(['epsilon']);
    });

    it('should correctly flag hunks outside the target selection range', () => {
      const original = [
        'line 1',
        'line 2',
        'line 3',
        'line 4',
        'line 5',
        'line 6',
        'line 7',
        'line 8',
        'line 9',
        'line 10'
      ].join('\n');

      const proposed = [
        'line 1 [mod]',
        'line 2',
        'line 3',
        'line 4',
        'line 5 [mod]',
        'line 6',
        'line 7',
        'line 8',
        'line 9 [mod]',
        'line 10'
      ].join('\n');

      // Target selection: lines 4 to 6
      const hunks = computeHunks('test.txt', original, proposed, { startLine: 4, endLine: 6 });
      expect(hunks.length).toBe(3);

      // Hunk at line 1 is outside
      expect(hunks[0].originalStartLine).toBe(1);
      expect(hunks[0].outsideSelection).toBe(true);

      // Hunk at line 5 is inside [4, 6]
      expect(hunks[1].originalStartLine).toBe(5);
      expect(hunks[1].outsideSelection).toBe(false);

      // Hunk at line 9 is outside
      expect(hunks[2].originalStartLine).toBe(9);
      expect(hunks[2].outsideSelection).toBe(true);
    });

    it('should preserve CRLF line endings when applying changes', () => {
      const originalCrlf = 'const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n';
      const proposedCrlf = 'const a = 1;\r\nconst b = 200;\r\nconst c = 3;\r\n';

      const hunks = computeHunks('code.ts', originalCrlf, proposedCrlf);
      expect(hunks.length).toBe(1);
      hunks[0].status = 'accepted';

      const applied = applyHunks(originalCrlf, hunks);
      expect(applied).toBe('const a = 1;\r\nconst b = 200;\r\nconst c = 3;\r\n');
      expect(applied.includes('\r\n')).toBe(true);
      expect(applied.split('\r\n').length).toBe(4);
    });
  });

  // ==========================================
  // 2. HUNK ACCEPT / REJECT COMBINATIONS
  // ==========================================
  describe('Hunk Accept / Reject Combinations', () => {
    const originalCode = [
      'function testFunction() {',
      '  const step1 = "init";',
      '  console.log("middle log 1");',
      '  const step2 = "process";',
      '  console.log("middle log 2");',
      '  return "done";',
      '}'
    ].join('\n');

    const proposedCode = [
      'function testFunction() {',
      '  const step1 = "INITIALIZED";', // Hunk 0
      '  console.log("middle log 1");',
      '  const step2 = "PROCESSED";',   // Hunk 1
      '  console.log("middle log 2");',
      '  return "COMPLETED";',          // Hunk 2
      '}'
    ].join('\n');

    it('Combination 1: All hunks accepted -> produces proposed code', () => {
      const hunks = computeHunks('sample.ts', originalCode, proposedCode);
      expect(hunks.length).toBe(3);

      for (const h of hunks) h.status = 'accepted';
      const result = applyHunks(originalCode, hunks);
      expect(result).toBe(proposedCode);
    });

    it('Combination 2: All hunks rejected -> preserves original code unchanged', () => {
      const hunks = computeHunks('sample.ts', originalCode, proposedCode);
      for (const h of hunks) h.status = 'rejected';
      const result = applyHunks(originalCode, hunks);
      expect(result).toBe(originalCode);
    });

    it('Combination 3: Accept Hunk 0 & Hunk 2, Reject Hunk 1 -> partial application', () => {
      const hunks = computeHunks('sample.ts', originalCode, proposedCode);
      hunks[0].status = 'accepted';
      hunks[1].status = 'rejected';
      hunks[2].status = 'accepted';

      const result = applyHunks(originalCode, hunks);
      const expected = [
        'function testFunction() {',
        '  const step1 = "INITIALIZED";', // Accepted
        '  console.log("middle log 1");',
        '  const step2 = "process";',       // Rejected (retained original)
        '  console.log("middle log 2");',
        '  return "COMPLETED";',          // Accepted
        '}'
      ].join('\n');

      expect(result).toBe(expected);
    });

    it('Combination 4: Reject Hunk 0 & 2, Accept Hunk 1 only', () => {
      const hunks = computeHunks('sample.ts', originalCode, proposedCode);
      hunks[0].status = 'rejected';
      hunks[1].status = 'accepted';
      hunks[2].status = 'rejected';

      const result = applyHunks(originalCode, hunks);
      const expected = [
        'function testFunction() {',
        '  const step1 = "init";',
        '  console.log("middle log 1");',
        '  const step2 = "PROCESSED";', // Only this accepted
        '  console.log("middle log 2");',
        '  return "done";',
        '}'
      ].join('\n');

      expect(result).toBe(expected);
    });

    it('Combination 5: CRLF file with alternating accept/reject preserves CRLF', () => {
      const origCrlf = originalCode.replace(/\n/g, '\r\n');
      const propCrlf = proposedCode.replace(/\n/g, '\r\n');

      const hunks = computeHunks('sample.ts', origCrlf, propCrlf);
      hunks[0].status = 'accepted';
      hunks[1].status = 'rejected';
      hunks[2].status = 'accepted';

      const result = applyHunks(origCrlf, hunks);
      expect(result.includes('\r\n')).toBe(true);
      expect(result.includes('\r\n  const step1 = "INITIALIZED";\r\n')).toBe(true);
      expect(result.includes('\r\n  const step2 = "process";\r\n')).toBe(true);
      expect(result.includes('\r\n  return "COMPLETED";\r\n')).toBe(true);
    });
  });

  // ==========================================
  // 3. IN-MEMORY CHANGESET & ZERO DISK WRITES
  // ==========================================
  describe('In-Memory ChangeSet & Zero Silent Writes', () => {
    it('should stage edits in-memory without modifying the file on disk', () => {
      const testFile = path.join(tempDir, 'sample.txt');
      const diskContent = 'hello initial world';
      fs.writeFileSync(testFile, diskContent, 'utf8');

      const changeSet = new ChangeSet(tempDir);
      const staged = changeSet.stageEdits('sample.txt', [
        { old_str: 'initial', new_str: 'UPDATED' }
      ], { rationale: 'Unit test staging' });

      // In-memory changeset reflects updated text
      expect(staged.proposedContent).toBe('hello UPDATED world');
      expect(staged.originalContent).toBe(diskContent);
      expect(staged.hunks.length).toBe(1);

      // ELIGIBILITY CONSTRAINT: Zero silent writes to disk!
      const contentOnDisk = fs.readFileSync(testFile, 'utf8');
      expect(contentOnDisk).toBe(diskContent);
    });

    it('should produce line-numbered mismatch error when old_str is not found', () => {
      const testFile = path.join(tempDir, 'error-test.txt');
      fs.writeFileSync(testFile, 'line A\nline B\nline C\n', 'utf8');

      const changeSet = new ChangeSet(tempDir);
      expect(() => {
        changeSet.stageEdits('error-test.txt', [
          { old_str: 'nonexistent line', new_str: 'replacement' }
        ]);
      }).toThrow(/Mismatch error: old_str not found/);
    });

    it('should produce line-numbered mismatch error when old_str matches multiple times', () => {
      const testFile = path.join(tempDir, 'multi-match.txt');
      fs.writeFileSync(testFile, 'foo bar\nsomething\nfoo bar\n', 'utf8');

      const changeSet = new ChangeSet(tempDir);
      expect(() => {
        changeSet.stageEdits('multi-match.txt', [
          { old_str: 'foo bar', new_str: 'foo baz' }
        ]);
      }).toThrow(/matches 2 times/);
    });

    it('should support staging entire file content and unstage cleanly', () => {
      const changeSet = new ChangeSet(tempDir);
      changeSet.stageContent('newfile.txt', 'brand new content', { create: true });

      expect(changeSet.hasStaged()).toBe(true);
      const staged = changeSet.getStaged('newfile.txt');
      expect(staged).toBeDefined();
      expect(staged?.isNewFile).toBe(true);
      expect(staged?.proposedContent).toBe('brand new content');

      // Unstage
      changeSet.unstage('newfile.txt');
      expect(changeSet.hasStaged()).toBe(false);
      expect(changeSet.getStaged('newfile.txt')).toBeUndefined();
    });
  });

  // ==========================================
  // 4. MCP EDIT TOOLS & OVERLAY-AWARE READ_FILE
  // ==========================================
  describe('MCP Edit Tools & Overlay-Aware read_file', () => {
    it('read_file should see in-memory staged overlay before changes are applied to disk', async () => {
      const testFile = path.join(tempDir, 'overlay.py');
      fs.writeFileSync(testFile, 'def run():\n    return 42\n', 'utf8');

      const changeSet = new ChangeSet(tempDir);
      const editTools = new EditToolsManager({ changeSet });
      const server = new McpServer({
        token: 'test-token',
        workspaceRoot: tempDir,
        editTools
      });

      // Initially read_file returns disk content
      const initialRead = await server.toolReadFile({ path: 'overlay.py' });
      expect(initialRead).toContain('return 42');

      // Stage an edit via editTools
      await editTools.handleStageEdit({
        path: 'overlay.py',
        edits: [{ old_str: 'return 42', new_str: 'return 9999' }],
        rationale: 'Testing overlay visibility'
      });

      // Overlay-aware read_file must return staged content!
      const overlayRead = await server.toolReadFile({ path: 'overlay.py' });
      expect(overlayRead).toContain('return 9999');

      // But file on disk remains unchanged!
      const diskContent = fs.readFileSync(testFile, 'utf8');
      expect(diskContent).toContain('return 42');

      // Unstaging removes overlay
      await editTools.handleUnstage({ path: 'overlay.py' });
      const readAfterUnstage = await server.toolReadFile({ path: 'overlay.py' });
      expect(readAfterUnstage).toContain('return 42');
    });

    it('show_staged should return accurate statistics of staged changes', async () => {
      const testFile = path.join(tempDir, 'stats.txt');
      fs.writeFileSync(testFile, 'item 1\nitem 2\nitem 3\n', 'utf8');

      const changeSet = new ChangeSet(tempDir);
      const editTools = new EditToolsManager({ changeSet });

      await editTools.handleStageEdit({
        path: 'stats.txt',
        edits: [{ old_str: 'item 2', new_str: 'item TWO' }]
      });

      const stagedReport = await editTools.handleShowStaged();
      expect(stagedReport.stagedFilesCount).toBe(1);
      expect(stagedReport.files[0].path).toBe('stats.txt');
      expect(stagedReport.files[0].hunkCount).toBe(1);
      expect(stagedReport.files[0].pendingHunks).toBe(1);
    });
  });

  // ==========================================
  // 5. ATOMIC APPLY_CHANGES & UNDO MANAGEMENT
  // ==========================================
  describe('Atomic Apply Changes & Undo Record Management', () => {
    it('should save UndoRecord in globalStorageUri and revert changes on undo', async () => {
      const testFile = path.join(tempDir, 'undo_target.txt');
      const originalText = 'Initial Text 123';
      fs.writeFileSync(testFile, originalText, 'utf8');

      const changeSet = new ChangeSet(tempDir);
      const globalStorageUri = vscode.Uri.file(globalStorageDir);
      const undoManager = new UndoManager(globalStorageUri, tempDir);
      const contentProvider = new ReviewContentProvider(changeSet);
      const codeLensProvider = new HunkCodeLensProvider(changeSet);

      const reviewController = new ReviewController({
        changeSet,
        undoManager,
        contentProvider,
        codeLensProvider
      });

      // Stage an edit
      changeSet.stageEdits('undo_target.txt', [
        { old_str: 'Initial Text 123', new_str: 'Modified Text 456' }
      ]);

      // Accept hunk
      const staged = changeSet.getStaged('undo_target.txt')!;
      changeSet.setHunkStatus('undo_target.txt', staged.hunks[0].id, 'accepted');

      // Apply changes
      const applyResult = await reviewController.applyChanges('Test apply');
      expect(applyResult.applied).toBe(true);
      expect(applyResult.appliedFiles).toContain('undo_target.txt');
      expect(applyResult.undoId).toBeDefined();

      // Verify file on disk was updated
      const updatedText = fs.readFileSync(testFile, 'utf8');
      expect(updatedText).toBe('Modified Text 456');

      // Verify UndoRecord exists in storage file
      const undoFile = path.join(globalStorageDir, 'undo-records.json');
      expect(fs.existsSync(undoFile)).toBe(true);
      const records = JSON.parse(fs.readFileSync(undoFile, 'utf8'));
      expect(records.length).toBe(1);
      expect(records[0].files[0].beforeContent).toBe(originalText);

      // Perform Undo
      const undoRes = await undoManager.undoLastChange();
      expect(undoRes.success).toBe(true);

      // Verify file restored to beforeContent on disk
      const revertedText = fs.readFileSync(testFile, 'utf8');
      expect(revertedText).toBe(originalText);

      // Verify history file is now empty
      const recordsAfter = JSON.parse(fs.readFileSync(undoFile, 'utf8'));
      expect(recordsAfter.length).toBe(0);
    });

    it('should delete newly created files when undoing file creation', async () => {
      const newFilePath = path.join(tempDir, 'created_file.txt');
      const changeSet = new ChangeSet(tempDir);
      const globalStorageUri = vscode.Uri.file(globalStorageDir);
      const undoManager = new UndoManager(globalStorageUri, tempDir);
      const contentProvider = new ReviewContentProvider(changeSet);
      const codeLensProvider = new HunkCodeLensProvider(changeSet);

      const reviewController = new ReviewController({
        changeSet,
        undoManager,
        contentProvider,
        codeLensProvider
      });

      changeSet.stageContent('created_file.txt', 'Freshly created content', { create: true });
      changeSet.acceptAllHunks('created_file.txt');

      await reviewController.applyChanges('Created new file');
      expect(fs.existsSync(newFilePath)).toBe(true);

      // Undo creation
      const undoRes = await undoManager.undoLastChange();
      expect(undoRes.success).toBe(true);
      expect(fs.existsSync(newFilePath)).toBe(false);
    });
  });

  // ==========================================
  // 6. WEBVIEW REDUCER STATE TRANSITIONS
  // ==========================================
  describe('Webview Reducer State Transitions', () => {
    it('should initialize with default state', () => {
      const state = panelReducer(undefined, { type: 'SET_MODEL', payload: 'Gemini 1.5 Pro' });
      expect(state.model).toBe('Gemini 1.5 Pro');
      expect(state.status).toBe('idle');
      expect(state.messages).toEqual([]);
      expect(state.budget.usedTokens).toBe(0);
    });

    it('should transition through streaming states and commit streamed chunks', () => {
      let state = initialPanelState;

      // Start streaming
      state = panelReducer(state, { type: 'START_STREAMING' });
      expect(state.status).toBe('streaming');
      expect(state.streamingChunk).toBe('');

      // Append chunks
      state = panelReducer(state, { type: 'APPEND_STREAM_CHUNK', payload: 'Hello ' });
      state = panelReducer(state, { type: 'APPEND_STREAM_CHUNK', payload: 'World!' });
      expect(state.streamingChunk).toBe('Hello World!');

      // Finish streaming commits message
      state = panelReducer(state, { type: 'FINISH_STREAMING' });
      expect(state.status).toBe('idle');
      expect(state.streamingChunk).toBe('');
      expect(state.messages.length).toBe(1);
      expect(state.messages[0].role).toBe('assistant');
      expect(state.messages[0].content).toBe('Hello World!');
    });

    it('should update context budget and chosen context table cards', () => {
      let state = initialPanelState;

      state = panelReducer(state, {
        type: 'UPDATE_BUDGET',
        payload: { usedTokens: 4200, maxTokens: 8000 }
      });
      expect(state.budget.usedTokens).toBe(4200);
      expect(state.budget.maxTokens).toBe(8000);

      const chosenContextItems: ContextItem[] = [
        {
          file: 'src/extension.ts',
          lines: [1, 50],
          score: 18.75,
          why: 'symbol match on activate',
          tokens: 280
        }
      ];

      state = panelReducer(state, {
        type: 'SET_CHOSEN_CONTEXT',
        payload: chosenContextItems
      });

      expect(state.messages.length).toBe(1);
      expect(state.messages[0].chosenContext).toEqual(chosenContextItems);
    });

    it('should handle tool approval banner request and resolution', () => {
      let state = initialPanelState;

      state = panelReducer(state, {
        type: 'SET_APPROVAL_REQUEST',
        payload: {
          id: 'approval-1',
          threadId: 'thread-main',
          toolCalls: [{ id: 'tc-1', name: 'apply_changes' }],
          summary: 'apply_changes'
        }
      });

      expect(state.activeApproval).toBeDefined();
      expect(state.status).toBe('awaiting_approval');

      state = panelReducer(state, {
        type: 'RESOLVE_APPROVAL',
        payload: { id: 'approval-1', decision: 'allow' }
      });

      expect(state.activeApproval).toBeNull();
      expect(state.status).toBe('idle');
    });

    it('should clear chat on CLEAR_CHAT action', () => {
      let state: PanelState = {
        ...initialPanelState,
        messages: [{ id: '1', role: 'user', content: 'test', timestamp: 123 }],
        budget: { usedTokens: 500, maxTokens: 8000 },
        error: 'some error'
      };

      state = panelReducer(state, { type: 'CLEAR_CHAT' });
      expect(state.messages).toEqual([]);
      expect(state.budget.usedTokens).toBe(0);
      expect(state.error).toBeNull();
      expect(state.status).toBe('idle');
    });
  });

  // ==========================================
  // 7. CODELENS & DEMO FIXTURE
  // ==========================================
  describe('CodeLens & Review UI Integration', () => {
    it('should generate CodeLens actions (Accept, Reject, Next) for staged hunks', async () => {
      const changeSet = new ChangeSet(tempDir);
      const codeLensProvider = new HunkCodeLensProvider(changeSet);

      changeSet.stageContent('component.ts', 'line 1\nline 2_mod\nline 3\n');
      const doc = await vscode.workspace.openTextDocument('component.ts');
      const lenses = codeLensProvider.provideCodeLenses(doc as any);

      expect(lenses.length).toBe(3);
      expect(lenses[0].command?.command).toBe('forge.acceptHunk');
      expect(lenses[1].command?.command).toBe('forge.rejectHunk');
      expect(lenses[2].command?.command).toBe('forge.nextHunk');
    });

    it('should load demo fixture in reviewController with inside and outside selection hunks', () => {
      const changeSet = new ChangeSet(tempDir);
      const globalStorageUri = vscode.Uri.file(globalStorageDir);
      const undoManager = new UndoManager(globalStorageUri, tempDir);
      const contentProvider = new ReviewContentProvider(changeSet);
      const codeLensProvider = new HunkCodeLensProvider(changeSet);

      const reviewController = new ReviewController({
        changeSet,
        undoManager,
        contentProvider,
        codeLensProvider
      });

      reviewController.loadDemoFixture();
      expect(changeSet.hasStaged()).toBe(true);

      const staged = changeSet.getStaged('src/example-fixture.ts');
      expect(staged).toBeDefined();
      expect(staged?.hunks.length).toBeGreaterThan(1);

      // Verify that at least one hunk is outside selection and one is inside
      const outsideCount = staged?.hunks.filter(h => h.outsideSelection).length || 0;
      const insideCount = staged?.hunks.filter(h => !h.outsideSelection).length || 0;
      expect(outsideCount).toBeGreaterThan(0);
      expect(insideCount).toBeGreaterThan(0);
    });
  });
});
