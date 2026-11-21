import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { ForgeConfig, getConfig, validateModels } from '../config.js';
import { ServerManager } from './serverManager.js';

export const SECRET_MCP_TOKEN_KEY = 'forge.mcpBearerToken';

export async function getOrCreateMcpToken(secrets: vscode.SecretStorage): Promise<string> {
  let token = await secrets.get(SECRET_MCP_TOKEN_KEY);
  if (!token) {
    token = crypto.randomUUID();
    await secrets.store(SECRET_MCP_TOKEN_KEY, token);
  }
  return token;
}

export async function registerMcpConnector(
  client: TrueForge,
  config: ForgeConfig,
  token: string
): Promise<any> {
  const mcpUrl = `http://${config.mcpHost}:${config.mcpPort}${config.mcpPath}`;
  const manifest = {
    name: config.connectorName,
    type: 'remote' as const,
    url: mcpUrl,
    description: 'Forge Editor workspace tools MCP server',
    auth: {
      type: 'header' as const,
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  };

  return await client.settings.mcpServers.createOrUpdate({ manifest });
}

export interface AgentDefinition {
  name: string;
  description: string;
  manifest: any;
}

export function loadLocalAgentDefinitions(workspaceRoot?: string): AgentDefinition[] {
  const root = workspaceRoot || process.cwd();
  const agentFiles = ['forge-agent.json', 'forge-inline.json'];
  const definitions: AgentDefinition[] = [];

  for (const file of agentFiles) {
    const fullPath = path.join(root, 'agents', file);
    if (fs.existsSync(fullPath)) {
      try {
        const raw = fs.readFileSync(fullPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.name && parsed.manifest) {
          definitions.push(parsed);
        }
      } catch (e) {
        console.warn(`Failed reading agent file ${file}:`, e);
      }
    }
  }

  // Fallback defaults if files not present
  if (definitions.length === 0) {
    definitions.push({
      name: 'forge-agent',
      description: 'Forge Agent for VS Code extension',
      manifest: {
        model: { name: 'groq/llama-3.3-70b-versatile' },
        instructions: 'You are Forge Agent, an expert AI software engineer operating inside VS Code. You inspect files, run tests, and propose clean, minimal diffs. All edits must go through the staging changeset.',
        mcp_servers: [
          {
            name: 'forge-editor',
            enable_tools: ['@all'],
            require_approval_for_tools: ['apply_changes', 'run_command'],
            preload_tools: ['retrieve_context', 'read_file', 'stage_edit', 'apply_changes'],
            preload: false
          }
        ],
        dynamic_sub_agents: true,
        context_management: {
          compaction: {
            enabled: true
          }
        }
      }
    });
    definitions.push({
      name: 'forge-inline',
      description: 'Forge Inline Assistant for fast completions and inline edits',
      manifest: {
        model: { name: 'groq/llama-3.3-70b-versatile' },
        instructions: 'You are Forge Inline Assistant, optimized for fast completions and single-file targeted edits. Keep responses concise.',
        mcp_servers: [
          {
            name: 'forge-editor',
            enable_tools: ['read_file', 'stage_edit', 'apply_changes']
          }
        ]
      }
    });
  }

  return definitions;
}

export async function upsertAgents(
  client: TrueForge,
  agents: AgentDefinition[]
): Promise<Array<{ name: string; id: string; action: 'created' | 'updated' }>> {
  const results: Array<{ name: string; id: string; action: 'created' | 'updated' }> = [];

  // List existing agents
  let existingAgents: any[] = [];
  try {
    const listResp = await client.agents.list();
    if (listResp && Array.isArray((listResp as any).data)) {
      existingAgents = (listResp as any).data;
    } else if (listResp && Symbol.asyncIterator in Object(listResp)) {
      for await (const item of listResp) {
        existingAgents.push(item);
      }
    }
  } catch (err) {
    // If list fails (e.g. server offline or empty), proceed with create attempts
  }

  for (const agentDef of agents) {
    const existing = existingAgents.find((a: any) => a.name === agentDef.name);
    if (existing && existing.id) {
      await client.agents.update(existing.id, {
        description: agentDef.description,
        manifest: agentDef.manifest
      });
      results.push({ name: agentDef.name, id: existing.id, action: 'updated' });
    } else {
      const createResp = await client.agents.create({
        name: agentDef.name,
        description: agentDef.description,
        manifest: agentDef.manifest
      });
      const id = createResp.data?.id || (createResp as any).id || 'unknown';
      results.push({ name: agentDef.name, id, action: 'created' });
    }
  }

  return results;
}

export function registerDoctorAndPingCommands(
  context: vscode.ExtensionContext,
  serverManager: ServerManager,
  outputChannel: vscode.OutputChannel
): vscode.Disposable[] {
  const doctorCmd = vscode.commands.registerCommand('forge.doctor', async () => {
    outputChannel.appendLine('[Forge] Running Doctor diagnostics...');
    const report = await serverManager.doctor();
    outputChannel.appendLine(`[Forge] Doctor Report (${report.timestamp}): Status = ${report.ok ? 'HEALTHY' : 'ISSUES DETECTED'}`);
    for (const check of report.checks) {
      outputChannel.appendLine(`  - [${check.status.toUpperCase()}] ${check.name}: ${check.message}`);
    }

    if (report.ok) {
      vscode.window.showInformationMessage('Forge: All systems operational.');
    } else {
      vscode.window.showWarningMessage('Forge Doctor: Some checks failed. Check Output channel for details.');
    }
    return report;
  });

  const pingCmd = vscode.commands.registerCommand('forge.ping', async () => {
    outputChannel.appendLine('[Forge] Pinging TrueForge server...');
    const pingRes = await serverManager.ping();
    if (pingRes.ok) {
      const msg = `TrueForge Ping: ${pingRes.latencyMs}ms (${pingRes.status})`;
      outputChannel.appendLine(`[Forge] ${msg}`);
      vscode.window.showInformationMessage(msg);
    } else {
      const msg = `TrueForge Ping Failed: ${pingRes.error} (${pingRes.latencyMs}ms)`;
      outputChannel.appendLine(`[Forge] ${msg}`);
      vscode.window.showErrorMessage(msg);
    }
    return pingRes;
  });

  context.subscriptions.push(doctorCmd, pingCmd);
  return [doctorCmd, pingCmd];
}

export async function bootstrapTrueForge(
  context: vscode.ExtensionContext,
  options?: {
    client?: TrueForge;
    config?: ForgeConfig;
    outputChannel?: vscode.OutputChannel;
    workspaceRoot?: string;
    skipNetwork?: boolean;
  }
): Promise<{
  token: string;
  config: ForgeConfig;
  serverManager: ServerManager;
}> {
  const config = options?.config ?? getConfig();
  const outputChannel = options?.outputChannel ?? vscode.window.createOutputChannel('Forge');

  // 1. Validate config.models
  const modelValidation = validateModels(config.models);
  if (!modelValidation.valid) {
    const errorMsg = `Forge Configuration Error: ${modelValidation.errors.join(', ')}`;
    outputChannel.appendLine(`[Forge] ${errorMsg}`);
    throw new Error(errorMsg);
  }

  // 2. SecretStorage Bearer header
  const token = await getOrCreateMcpToken(context.secrets);

  // 3. Initialize TrueForge client & ServerManager
  const client = options?.client ?? new TrueForge({ baseUrl: config.baseUrl });
  const serverManager = new ServerManager(client, config);

  // 4. Expose 'Forge: Doctor' and 'Forge: Ping' commands
  registerDoctorAndPingCommands(context, serverManager, outputChannel);

  // 5. Connect and upsert if not skipping network
  if (!options?.skipNetwork) {
    try {
      await registerMcpConnector(client, config, token);
      outputChannel.appendLine(`[Forge] Registered MCP connector '${config.connectorName}' at http://${config.mcpHost}:${config.mcpPort}${config.mcpPath}`);
    } catch (err: any) {
      outputChannel.appendLine(`[Forge] Warning: Could not register MCP connector: ${err.message}`);
    }

    try {
      const agentDefs = loadLocalAgentDefinitions(context.extensionUri.fsPath);
      const upserted = await upsertAgents(client, agentDefs);
      outputChannel.appendLine(`[Forge] Upserted ${upserted.length} agents: ${upserted.map(a => `${a.name} (${a.action})`).join(', ')}`);
    } catch (err: any) {
      outputChannel.appendLine(`[Forge] Warning: Could not upsert agents: ${err.message}`);
    }
  }

  return {
    token,
    config,
    serverManager
  };
}

