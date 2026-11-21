import * as vscode from 'vscode';

export interface ForgeConfig {
  baseUrl: string;
  models: string[];
  mcpPort: number;
  mcpHost: string;
  mcpPath: string;
  connectorName: string;
  contextBudgetTokens: number;
  repoMapBudgetTokens: number;
  retrieveContextBudgetTokens: number;
  turnCapBudgetTokens: number;
}

export const DEFAULT_CONFIG: ForgeConfig = {
  baseUrl: 'http://localhost:8790',
  models: [
    'google-gemini/gemini-3-1-flash-lite',
    'groq/llama-3.3-70b-versatile'
  ],
  mcpPort: 8799,
  mcpHost: '127.0.0.1',
  mcpPath: '/mcp',
  connectorName: 'forge-editor',
  contextBudgetTokens: 8000,
  repoMapBudgetTokens: 1500,
  retrieveContextBudgetTokens: 6000,
  turnCapBudgetTokens: 8000
};

export function validateModels(models?: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!models) {
    errors.push('Models configuration is required.');
    return { valid: false, errors };
  }

  if (!Array.isArray(models)) {
    errors.push('Models configuration must be an array.');
    return { valid: false, errors };
  }

  if (models.length === 0) {
    errors.push('At least one model must be configured.');
    return { valid: false, errors };
  }

  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    if (typeof m !== 'string' || m.trim().length === 0) {
      errors.push(`Model at index ${i} must be a non-empty string.`);
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

export function getConfig(overrides?: Partial<ForgeConfig>): ForgeConfig {
  let wsConfig: vscode.WorkspaceConfiguration | undefined;
  try {
    if (typeof vscode !== 'undefined' && vscode.workspace && typeof vscode.workspace.getConfiguration === 'function') {
      wsConfig = vscode.workspace.getConfiguration('forge');
    }
  } catch {
    // vscode runtime not active, fallback to defaults
  }

  const baseUrl = overrides?.baseUrl ?? wsConfig?.get<string>('baseUrl', DEFAULT_CONFIG.baseUrl) ?? DEFAULT_CONFIG.baseUrl;
  const models = overrides?.models ?? wsConfig?.get<string[]>('models', DEFAULT_CONFIG.models) ?? DEFAULT_CONFIG.models;
  const mcpPort = overrides?.mcpPort ?? wsConfig?.get<number>('mcpPort', DEFAULT_CONFIG.mcpPort) ?? DEFAULT_CONFIG.mcpPort;
  const mcpHost = overrides?.mcpHost ?? wsConfig?.get<string>('mcpHost', DEFAULT_CONFIG.mcpHost) ?? DEFAULT_CONFIG.mcpHost;
  const mcpPath = overrides?.mcpPath ?? wsConfig?.get<string>('mcpPath', DEFAULT_CONFIG.mcpPath) ?? DEFAULT_CONFIG.mcpPath;
  const connectorName = overrides?.connectorName ?? wsConfig?.get<string>('connectorName', DEFAULT_CONFIG.connectorName) ?? DEFAULT_CONFIG.connectorName;
  const contextBudgetTokens = overrides?.contextBudgetTokens ?? wsConfig?.get<number>('contextBudgetTokens', DEFAULT_CONFIG.contextBudgetTokens) ?? DEFAULT_CONFIG.contextBudgetTokens;
  const repoMapBudgetTokens = overrides?.repoMapBudgetTokens ?? wsConfig?.get<number>('repoMapBudgetTokens', DEFAULT_CONFIG.repoMapBudgetTokens) ?? DEFAULT_CONFIG.repoMapBudgetTokens;
  const retrieveContextBudgetTokens = overrides?.retrieveContextBudgetTokens ?? wsConfig?.get<number>('retrieveContextBudgetTokens', DEFAULT_CONFIG.retrieveContextBudgetTokens) ?? DEFAULT_CONFIG.retrieveContextBudgetTokens;
  const turnCapBudgetTokens = overrides?.turnCapBudgetTokens ?? wsConfig?.get<number>('turnCapBudgetTokens', DEFAULT_CONFIG.turnCapBudgetTokens) ?? DEFAULT_CONFIG.turnCapBudgetTokens;

  return {
    baseUrl,
    models: Array.isArray(models) ? [...models] : [...DEFAULT_CONFIG.models],
    mcpPort,
    mcpHost,
    mcpPath,
    connectorName,
    contextBudgetTokens,
    repoMapBudgetTokens,
    retrieveContextBudgetTokens,
    turnCapBudgetTokens
  };
}
