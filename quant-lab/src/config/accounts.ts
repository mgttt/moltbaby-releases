// ============================================================
// Account Config Loader (v3)
//
// Loads API keys from external JSON file (not committed to git)
// Default path: ~/.config/quant-lab/accounts.json
// Override via env: QUANT_LAB_ACCOUNTS=/path/to/accounts.json
// ============================================================

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import { env } from './env';

export type ExchangeId = 'bybit' | 'binance' | 'coinex' | 'htx';

export interface AccountConfig {
  id: string;
  name?: string;
  exchange: ExchangeId;
  apiKey: string;
  apiSecret: string;
  testnet?: boolean;
  proxy?: string;
  region?: string;
  notes?: string;

  // Bybit-specific
  category?: 'spot' | 'linear' | 'inverse';
}

export function getAccountsPath(): string {
  return env.QUANT_LAB_ACCOUNTS || join(homedir(), '.config', 'quant-lab', 'accounts.json');
}

export function loadAccountConfigs(): AccountConfig[] {
  const path = getAccountsPath();
  if (!existsSync(path)) return [];

  const content = readFileSync(path, 'utf8');
  const configs = JSON.parse(content);

  if (!Array.isArray(configs)) {
    throw new Error(`[Accounts] Invalid config format (expected array) at ${path}`);
  }

  return configs;
}

export function getAccountConfig(id: string): AccountConfig | undefined {
  const configs = loadAccountConfigs();
  return configs.find(c => c.id === id);
}

export function getAccountConfigWithAliases(id: string, aliases: string[] = []): AccountConfig | undefined {
  const configs = loadAccountConfigs();
  const ids = [id, ...aliases];
  for (const candidate of ids) {
    const found = configs.find(c => c.id === candidate);
    if (found) return found;
  }
  return undefined;
}

export function requireAccountConfig(id: string, aliases: string[] = []): AccountConfig {
  const path = getAccountsPath();
  const config = getAccountConfigWithAliases(id, aliases);
  if (!config) {
    const tried = [id, ...aliases].join(', ');
    throw new Error(`[Accounts] Account not found: ${tried}. Check ${path}`);
  }
  if (!config.apiKey || !config.apiSecret) {
    throw new Error(`[Accounts] Account missing apiKey/apiSecret: ${config.id}`);
  }
  return config;
}

export function redactAccount(config: AccountConfig) {
  return {
    id: config.id,
    exchange: config.exchange,
    testnet: !!config.testnet,
    region: config.region,
    hasProxy: !!config.proxy,
    category: config.category,
  };
}
