import { HIGH_RISK_STORAGE_KEY, parseHighRiskFlags, type HighRiskFlags } from 'chrome-mcp-shared';

/** Missing or unreadable storage fails closed. There is no options toggle yet. */
export async function readHighRiskFlags(): Promise<HighRiskFlags> {
  try {
    const stored = await chrome.storage.local.get(HIGH_RISK_STORAGE_KEY);
    return parseHighRiskFlags(stored?.[HIGH_RISK_STORAGE_KEY]);
  } catch {
    return parseHighRiskFlags(undefined);
  }
}
