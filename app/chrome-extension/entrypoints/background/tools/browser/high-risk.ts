import {
  FILE_CHOOSER_ALLOW_DIRS_KEY,
  HIGH_RISK_STORAGE_KEY,
  parseFileAllowDirs,
  parseHighRiskFlags,
  type HighRiskFlags,
} from 'chrome-mcp-shared';

/** Missing or unreadable storage fails closed. There is no options toggle yet. */
export async function readHighRiskFlags(): Promise<HighRiskFlags> {
  try {
    const stored = await chrome.storage.local.get(HIGH_RISK_STORAGE_KEY);
    return parseHighRiskFlags(stored?.[HIGH_RISK_STORAGE_KEY]);
  } catch {
    return parseHighRiskFlags(undefined);
  }
}

/**
 * Missing, empty, or unreadable storage means no allow-list (absolute paths only).
 * A present but malformed value is returned so the caller can fail the call.
 * chrome_file_chooser stays on either way. There is no options page yet.
 */
export async function readFileAllowDirs(): Promise<string[] | null | { error: string }> {
  try {
    const stored = await chrome.storage.local.get(FILE_CHOOSER_ALLOW_DIRS_KEY);
    if (!stored || !Object.prototype.hasOwnProperty.call(stored, FILE_CHOOSER_ALLOW_DIRS_KEY)) {
      return null;
    }
    return parseFileAllowDirs(stored[FILE_CHOOSER_ALLOW_DIRS_KEY]);
  } catch {
    return null;
  }
}
