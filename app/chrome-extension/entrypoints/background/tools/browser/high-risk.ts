import {
  FILE_CHOOSER_ALLOW_DIRS_KEY,
  HIGH_RISK_STORAGE_KEY,
  SITE_POLICY_ALLOW_ORIGINS_KEY,
  SITE_POLICY_DENY_ORIGINS_KEY,
  SITE_POLICY_MODE_KEY,
  parseFileAllowDirs,
  parseHighRiskFlags,
  type HighRiskFlags,
} from 'chrome-mcp-shared';

/**
 * Missing or unreadable storage uses the defaults.
 * javascript and upload stay on. Every other toggle stays off.
 * There is no options page yet. The storage keys are the toggles.
 */
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

/**
 * Missing, empty, and unreadable storage refuse chrome_grant_permission.
 * A present value is returned for matchSitePolicyOrigin, including malformed lists.
 * Entries may be exact origins or host wildcards. There is no options page yet.
 */
export async function readSitePolicyAllowOrigins(): Promise<
  { stored: unknown } | { error: string }
> {
  try {
    const stored = await chrome.storage.local.get(SITE_POLICY_ALLOW_ORIGINS_KEY);
    if (!stored || !Object.prototype.hasOwnProperty.call(stored, SITE_POLICY_ALLOW_ORIGINS_KEY)) {
      return { stored: undefined };
    }
    return { stored: stored[SITE_POLICY_ALLOW_ORIGINS_KEY] };
  } catch {
    return {
      error: `Site policy could not be read (storage key ${SITE_POLICY_ALLOW_ORIGINS_KEY}). chrome_grant_permission refused.`,
    };
  }
}

/**
 * Allow list, extra deny patterns, and mode for the tool choke point.
 * Unreadable storage is an error so a broken allowlist cannot fail open.
 */
export async function readSitePolicySettings(): Promise<
  { allow: unknown; deny: unknown; mode: unknown } | { error: string }
> {
  try {
    const stored = await chrome.storage.local.get([
      SITE_POLICY_ALLOW_ORIGINS_KEY,
      SITE_POLICY_DENY_ORIGINS_KEY,
      SITE_POLICY_MODE_KEY,
    ]);
    return {
      allow: stored?.[SITE_POLICY_ALLOW_ORIGINS_KEY],
      deny: stored?.[SITE_POLICY_DENY_ORIGINS_KEY],
      mode: stored?.[SITE_POLICY_MODE_KEY],
    };
  } catch {
    return { error: 'Site policy could not be read. The call was refused.' };
  }
}
