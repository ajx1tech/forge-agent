import { ChangeSet, StagedFileChange } from '../../review/changeset.js';
import { ReviewController } from '../../review/reviewController.js';

export interface StageEditArgs {
  path: string;
  edits?: Array<{ old_str: string; new_str: string }>;
  content?: string;
  create?: boolean;
  rationale?: string;
}

export interface UnstageArgs {
  path?: string;
}

export interface ApplyChangesArgs {
  summary?: string;
}

export class EditToolsManager {
  private changeSet: ChangeSet;
  private reviewController?: ReviewController;
  private onOverlayUpdate?: (filePath: string, content: string | null) => void;

  constructor(options: {
    changeSet: ChangeSet;
    reviewController?: ReviewController;
    onOverlayUpdate?: (filePath: string, content: string | null) => void;
  }) {
    this.changeSet = options.changeSet;
    this.reviewController = options.reviewController;
    this.onOverlayUpdate = options.onOverlayUpdate;
  }

  public setReviewController(reviewController: ReviewController): void {
    this.reviewController = reviewController;
  }

  public setOverlayUpdateCallback(cb: (filePath: string, content: string | null) => void): void {
    this.onOverlayUpdate = cb;
  }

  public getToolDefinitions(): any[] {
    return [
      {
        name: 'stage_edit',
        description:
          'Stages edits to an in-memory ChangeSet without modifying disk. Supports exact unique string replacements (edits) or full content overwrite, with automatic hunk generation and overlay-aware reading.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path of the file to edit or create' },
            edits: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  old_str: { type: 'string', description: 'Exact string to find and replace' },
                  new_str: { type: 'string', description: 'New string to replace old_str with' }
                },
                required: ['old_str', 'new_str']
              },
              description: 'Array of exact string replacements. Fails with line numbers if old_str is not unique or missing.'
            },
            content: { type: 'string', description: 'Complete file content for new files or full rewrites' },
            create: { type: 'boolean', description: 'Set to true when creating a new file' },
            rationale: { type: 'string', description: 'Explanation of why these changes are being made' }
          },
          required: ['path']
        }
      },
      {
        name: 'unstage',
        description: 'Removes staged changes for a specific file or clears all staged files.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to unstage, or omit to unstage all files' }
          }
        }
      },
      {
        name: 'show_staged',
        description: 'Returns all currently staged file changes, hunks, and review statuses.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'apply_changes',
        description:
          'Gated operation to apply accepted hunks in one atomic WorkspaceEdit and record an UndoRecord. Requires approval.',
        inputSchema: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'Brief summary of the changes being applied' }
          }
        }
      }
    ];
  }

  public async handleStageEdit(args: StageEditArgs): Promise<any> {
    if (!args.path) {
      throw new Error("Missing required argument 'path'.");
    }

    if (!args.edits && args.content === undefined) {
      throw new Error("Either 'edits' or 'content' must be provided to stage_edit.");
    }

    let staged: StagedFileChange;

    if (args.edits && args.edits.length > 0) {
      staged = this.changeSet.stageEdits(args.path, args.edits, {
        create: args.create,
        rationale: args.rationale
      });
    } else {
      staged = this.changeSet.stageContent(args.path, args.content ?? '', {
        create: args.create,
        rationale: args.rationale
      });
    }

    // Update in-memory overlay hook so read_file sees staged edits
    if (this.onOverlayUpdate) {
      this.onOverlayUpdate(staged.path, staged.proposedContent);
      this.onOverlayUpdate(staged.fullPath, staged.proposedContent);
    }

    return {
      status: 'staged',
      file: staged.path,
      isNewFile: staged.isNewFile,
      hunkCount: staged.hunks.length,
      rationale: staged.rationale,
      hunks: staged.hunks.map(h => ({
        id: h.id,
        status: h.status,
        originalRange: [h.originalStartLine, h.originalStartLine + h.originalLineCount - 1],
        proposedRange: [h.proposedStartLine, h.proposedStartLine + h.proposedLineCount - 1],
        outsideSelection: h.outsideSelection
      })),
      message: `Successfully staged edits for '${staged.path}'. ${staged.hunks.length} hunk(s) ready for review.`
    };
  }

  public async handleUnstage(args: UnstageArgs): Promise<any> {
    const target = args.path;
    if (target && target !== 'all') {
      const { relPath, fullPath } = this.changeSet.normalizePath(target);
      this.changeSet.unstage(relPath);
      if (this.onOverlayUpdate) {
        this.onOverlayUpdate(relPath, null);
        this.onOverlayUpdate(fullPath, null);
      }
      return { status: 'unstaged', path: relPath };
    } else {
      const all = this.changeSet.getAllStaged();
      this.changeSet.unstage();
      if (this.onOverlayUpdate) {
        for (const s of all) {
          this.onOverlayUpdate(s.path, null);
          this.onOverlayUpdate(s.fullPath, null);
        }
      }
      return { status: 'unstaged_all', count: all.length };
    }
  }

  public async handleShowStaged(): Promise<any> {
    const staged = this.changeSet.showStaged();
    return {
      stagedFilesCount: staged.length,
      files: staged
    };
  }

  public async handleApplyChanges(args: ApplyChangesArgs): Promise<any> {
    if (!this.reviewController) {
      // Fallback if reviewController not set: apply accepted hunks via changeset
      throw new Error('Review controller is not initialized. Cannot apply changes.');
    }

    const result = await this.reviewController.applyChanges(args.summary);
    if (!result.applied) {
      throw new Error(`apply_changes failed: ${result.error}`);
    }

    return {
      status: 'applied',
      appliedFiles: result.appliedFiles,
      undoId: result.undoId,
      message: `Successfully applied changes to ${result.appliedFiles.length} file(s). Undo record saved.`
    };
  }
}
