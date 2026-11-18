import { describe, it, expect } from 'vitest';
import configExample from '../trueforge.config.example.json';

describe('Forge Agent configuration defaults', () => {
  it('should specify localhost:8790 as default TrueForge baseUrl', () => {
    expect(configExample.baseUrl).toBe('http://localhost:8790');
  });

  it('should specify 8799 as default MCP port', () => {
    expect(configExample.mcpPort).toBe(8799);
  });

  it('should set default contextBudgetTokens to 8000', () => {
    expect(configExample.contextBudgetTokens).toBe(8000);
  });

  it('should list configured model IDs', () => {
    expect(Array.isArray(configExample.models)).toBe(true);
    expect(configExample.models).toContain('google-gemini/<primary-model-id>');
  });
});
