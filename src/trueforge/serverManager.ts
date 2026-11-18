import { TrueForge } from '@truefoundry/trueforge-sdk';
import { ForgeConfig, getConfig, validateModels } from '../config.js';

export interface DiagnosticCheck {
  name: string;
  status: 'ok' | 'warning' | 'error';
  message: string;
  details?: unknown;
}

export interface DoctorReport {
  ok: boolean;
  checks: DiagnosticCheck[];
  timestamp: string;
}

export interface PingResult {
  ok: boolean;
  latencyMs: number;
  status?: string;
  error?: string;
}

export class ServerManager {
  private client: TrueForge;
  private config: ForgeConfig;

  constructor(clientOrConfig?: TrueForge | ForgeConfig | any, maybeConfig?: ForgeConfig) {
    if (clientOrConfig && (clientOrConfig instanceof TrueForge || 'server' in clientOrConfig || 'models' in clientOrConfig)) {
      this.client = clientOrConfig;
      this.config = maybeConfig ?? getConfig();
    } else {
      this.config = clientOrConfig ?? getConfig();
      this.client = new TrueForge({ baseUrl: this.config.baseUrl });
    }
  }

  public getClient(): TrueForge {
    return this.client;
  }

  public getConfig(): ForgeConfig {
    return this.config;
  }

  public async ping(timeoutMs: number = 2000): Promise<PingResult> {
    const start = Date.now();
    try {
      if (typeof this.client.server?.getCapabilities === 'function') {
        await this.client.server.getCapabilities({
          timeoutInSeconds: Math.max(1, Math.floor(timeoutMs / 1000))
        });
      } else {
        // Fallback probe
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const resp = await fetch(`${this.config.baseUrl}/health`, {
            signal: controller.signal
          });
          if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
          }
        } finally {
          clearTimeout(timer);
        }
      }
      return {
        ok: true,
        latencyMs: Date.now() - start,
        status: 'reachable'
      };
    } catch (err: any) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: err?.message || String(err)
      };
    }
  }

  public async doctor(): Promise<DoctorReport> {
    const checks: DiagnosticCheck[] = [];
    const timestamp = new Date().toISOString();

    // 1. Validate BaseUrl configuration
    if (!this.config.baseUrl || !this.config.baseUrl.startsWith('http')) {
      checks.push({
        name: 'Server Base URL',
        status: 'error',
        message: `Invalid baseUrl configured: '${this.config.baseUrl}'`
      });
    } else {
      checks.push({
        name: 'Server Base URL',
        status: 'ok',
        message: `Configured baseUrl: ${this.config.baseUrl}`
      });
    }

    // 2. Ping Server Reachability
    const pingRes = await this.ping(1500);
    if (pingRes.ok) {
      checks.push({
        name: 'Server Reachability',
        status: 'ok',
        message: `TrueForge server reached in ${pingRes.latencyMs}ms`
      });
    } else {
      checks.push({
        name: 'Server Reachability',
        status: 'warning',
        message: `TrueForge server at ${this.config.baseUrl} is unreachable: ${pingRes.error}`
      });
    }

    // 3. Validate Models Configuration
    const modelValidation = validateModels(this.config.models);
    if (!modelValidation.valid) {
      checks.push({
        name: 'Model Configuration',
        status: 'error',
        message: `Invalid models configured: ${modelValidation.errors.join(', ')}`
      });
    } else {
      checks.push({
        name: 'Model Configuration',
        status: 'ok',
        message: `Models configured: ${this.config.models.join(', ')}`
      });

      // If server is reachable, cross-check models against server catalog
      if (pingRes.ok && typeof this.client.models?.list === 'function') {
        try {
          const availableModelsResp = await this.client.models.list();
          const available = availableModelsResp.data?.map(m => m.name) ?? [];
          checks.push({
            name: 'Server Model Catalog',
            status: 'ok',
            message: `Server returned ${available.length} models`,
            details: available
          });
        } catch (e: any) {
          checks.push({
            name: 'Server Model Catalog',
            status: 'warning',
            message: `Could not list server models: ${e.message}`
          });
        }
      }
    }

    // 4. Validate MCP Connector Registration
    if (pingRes.ok && typeof this.client.settings?.mcpServers?.get === 'function') {
      try {
        const mcpResp = await this.client.settings.mcpServers.get(this.config.connectorName);
        checks.push({
          name: 'MCP Connector Registration',
          status: 'ok',
          message: `Connector '${this.config.connectorName}' registered: ${mcpResp.data?.manifest?.url ?? 'active'}`,
          details: mcpResp.data
        });
      } catch (e: any) {
        checks.push({
          name: 'MCP Connector Registration',
          status: 'warning',
          message: `Connector '${this.config.connectorName}' not found or unreachable: ${e.message}`
        });
      }
    } else {
      checks.push({
        name: 'MCP Connector Configuration',
        status: 'ok',
        message: `MCP connector configured at http://${this.config.mcpHost}:${this.config.mcpPort}${this.config.mcpPath}`
      });
    }

    // 5. Context Budgets Check
    if (
      this.config.contextBudgetTokens > 0 &&
      this.config.retrieveContextBudgetTokens > 0 &&
      this.config.repoMapBudgetTokens > 0
    ) {
      checks.push({
        name: 'Context Token Budgets',
        status: 'ok',
        message: `Budgets: turnCap=${this.config.turnCapBudgetTokens}, retrieveContext=${this.config.retrieveContextBudgetTokens}, repoMap=${this.config.repoMapBudgetTokens}`
      });
    } else {
      checks.push({
        name: 'Context Token Budgets',
        status: 'error',
        message: 'Invalid context token budgets configured.'
      });
    }

    const hasError = checks.some(c => c.status === 'error');
    return {
      ok: !hasError,
      checks,
      timestamp
    };
  }
}
