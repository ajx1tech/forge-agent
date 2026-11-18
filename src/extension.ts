import * as vscode from 'vscode';
import { bootstrapTrueForge } from './trueforge/bootstrap.js';
import { McpServer } from './mcp/server.js';
import { WorkspaceIndexer } from './context/indexer.js';
import { TrueForgeClient } from './trueforge/client.js';
import { ChangeSet } from './review/changeset.js';
import { UndoManager } from './review/undo.js';
import { ReviewContentProvider, SCHEME_ORIGINAL, SCHEME_PROPOSED } from './review/contentProvider.js';
import { HunkCodeLensProvider } from './review/codelens.js';
import { ReviewController } from './review/reviewController.js';
import { EditToolsManager } from './mcp/tools/editTools.js';
import { ForgePanelProvider } from './ui/panelProvider.js';
import { InlineEditManager } from './inline/inlineEdit.js';
import { ModelFallbackManager } from './trueforge/resilience.js';
import { RunController } from './core/runner.js';

let outputChannel: vscode.OutputChannel;
let mcpServer: McpServer | undefined;
let indexer: WorkspaceIndexer | undefined;
let changeSet: ChangeSet | undefined;
let reviewController: ReviewController | undefined;
let runController: RunController | undefined;
let fallbackManager: ModelFallbackManager | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel('Forge');
  outputChannel.appendLine('Forge Agent activated.');

  const helloCommand = vscode.commands.registerCommand('forge.hello', () => {
    vscode.window.showInformationMessage('Forge Agent active');
    outputChannel.appendLine("Command 'forge.hello' executed.");
  });
  context.subscriptions.push(outputChannel, helloCommand);

  // Initialize workspace root and in-memory staged changeset
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const workspaceRoot = workspaceFolders && workspaceFolders.length > 0
    ? workspaceFolders[0].uri.fsPath
    : process.cwd();

  changeSet = new ChangeSet(workspaceRoot);
  const undoManager = new UndoManager(context.globalStorageUri, workspaceRoot);

  // Register diff content providers for custom URI schemes
  const contentProvider = new ReviewContentProvider(changeSet);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME_ORIGINAL, contentProvider),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME_PROPOSED, contentProvider)
  );

  // Register CodeLens provider for hunks
  const codeLensProvider = new HunkCodeLensProvider(changeSet);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: SCHEME_PROPOSED }, codeLensProvider)
  );

  // Initialize review controller
  reviewController = new ReviewController({
    changeSet,
    undoManager,
    contentProvider,
    codeLensProvider,
    outputChannel,
    onStagedOverlayClear: (filePath) => mcpServer?.setStagedOverlay(filePath, null)
  });
  reviewController.registerCommands(context);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('forge.reviewView', reviewController)
  );

  // Initialize edit tools manager
  const editTools = new EditToolsManager({
    changeSet,
    reviewController,
    onOverlayUpdate: (filePath, content) => mcpServer?.setStagedOverlay(filePath, content)
  });

  // Initialize workspace indexer
  indexer = new WorkspaceIndexer({
    globalStorageUri: context.globalStorageUri
  });

  // Run bootstrap (registers Doctor and Ping commands, manages SecretStorage token, upserts connector & agents)
  try {
    const bootstrapRes = await bootstrapTrueForge(context, {
      outputChannel,
      workspaceRoot
    });

    // Start MCP server with edit tools attached
    mcpServer = new McpServer({
      port: bootstrapRes.config.mcpPort,
      host: bootstrapRes.config.mcpHost,
      token: bootstrapRes.token,
      workspaceRoot,
      indexer,
      editTools
    });

    // TrueForge client for agent loops
    const trueForgeClient = new TrueForgeClient(
      { baseUrl: bootstrapRes.config.baseUrl },
      outputChannel
    );

    // Fallback manager and RunController state machine
    fallbackManager = new ModelFallbackManager(bootstrapRes.config.models, outputChannel);
    runController = new RunController({
      trueForgeClient,
      changeSet,
      fallbackManager,
      mcpServer,
      reviewController,
      outputChannel
    });

    // Register Activity Bar WebviewView provider ('Forge')
    const panelProvider = new ForgePanelProvider({
      extensionUri: context.extensionUri,
      trueForgeClient,
      indexer,
      reviewController,
      runController,
      config: bootstrapRes.config,
      outputChannel
    });
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(ForgePanelProvider.viewType, panelProvider)
    );

    // Register dev commands for resilience testing & cancellation
    const simFailCmd = vscode.commands.registerCommand('forge.simulatePrimaryFailure', () => {
      fallbackManager?.setSimulateFailure(true);
      vscode.window.showWarningMessage('Forge: Simulated primary model failure ENABLED. Next turn will trigger fallback.');
    });

    const restoreModelsCmd = vscode.commands.registerCommand('forge.restoreModels', () => {
      fallbackManager?.restoreModels();
    });

    const cancelCmd = vscode.commands.registerCommand('forge.cancel', async () => {
      await runController?.cancel();
    });

    context.subscriptions.push(simFailCmd, restoreModelsCmd, cancelCmd);

    // Register Inline Edit controller (Ctrl+Alt+K)
    const inlineEditManager = new InlineEditManager({
      trueForgeClient,
      changeSet,
      reviewController,
      outputChannel
    });
    inlineEditManager.registerCommands(context);

    // Index workspace asynchronously without blocking activation
    indexer.indexWorkspace(workspaceRoot).catch(err => {
      outputChannel.appendLine(`[Forge] Indexing warning: ${err.message}`);
    });

  } catch (err: any) {
    outputChannel.appendLine(`[Forge] Bootstrap error: ${err.message}`);
  }
}

export async function deactivate(): Promise<void> {
  if (mcpServer) {
    await mcpServer.stop();
    mcpServer = undefined;
  }
  if (outputChannel) {
    outputChannel.dispose();
  }
}
