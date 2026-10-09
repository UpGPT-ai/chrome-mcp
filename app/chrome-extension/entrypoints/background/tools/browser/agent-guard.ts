import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import {
  collectSitePolicyTargets,
  confirmCrossOriginFlag,
  crossOriginAction,
  decideCrossOrigin,
  evaluateSitePolicy,
  exfiltrationInput,
  findExfiltratedSecret,
  highRiskDisabledError,
  highRiskToggleForTool,
  policyOrigin,
  summarizeToolArgs,
  toolNotesPageRead,
  type AuditLineInput,
} from 'chrome-mcp-shared';
import { readHighRiskFlags, readSitePolicySettings } from './high-risk';
import { writeAudit } from './audit-log';

/**
 * Session memory for the cross-origin window and the exfiltration guard.
 * Secrets stay in memory. They are not written to the audit log.
 * confirmCrossOrigin is never set here.
 */

const SECRET_CAP = 200;
const SECRET_MAX_CHARS = 4096;

let readMark: { origin: string; at: number } | null = null;
const secrets = new Set<string>();

export function notePageRead(origin: string, now = Date.now()): void {
  if (!origin || origin === 'unknown' || origin === 'about:blank') return;
  readMark = { origin, at: now };
}

export function noteReturnedSecret(value: string | null | undefined): void {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > SECRET_MAX_CHARS) return;
  if (secrets.size >= SECRET_CAP && !secrets.has(trimmed)) return;
  secrets.add(trimmed);
}

export function sessionSecrets(): readonly string[] {
  return [...secrets];
}

async function resolveTabUrl(args: unknown): Promise<string> {
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  try {
    if (typeof record.tabId === 'number') {
      const tab = await chrome.tabs.get(record.tabId);
      return tab.url || tab.pendingUrl || '';
    }
    const query =
      typeof record.windowId === 'number'
        ? { active: true, windowId: record.windowId }
        : { active: true, currentWindow: true as const };
    const [tab] = await chrome.tabs.query(query);
    return tab?.url || tab?.pendingUrl || '';
  } catch {
    return '';
  }
}

export interface GuardDecision {
  origin: string;
  block?: ToolResult;
  /** Set when the call was refused before the tool ran. */
  refused?: 'error' | 'needs_confirmation';
}

/**
 * One choke point. handleCallTool runs this before a tool touches a tab.
 * High-risk toggles, site policy, exfiltration, then the cross-origin window.
 */
export async function guardToolCall(name: string, args: unknown): Promise<GuardDecision> {
  let origin = 'unknown';
  const toggle = highRiskToggleForTool(name);
  if (toggle) {
    const flags = await readHighRiskFlags();
    if (!flags[toggle]) {
      return {
        origin,
        block: createErrorResponse(highRiskDisabledError(toggle)),
        refused: 'error',
      };
    }
  }

  const targets = collectSitePolicyTargets(name, args);
  if (targets.urls.length > 0 || targets.needsTab) {
    const policy = await readSitePolicySettings();
    if ('error' in policy) {
      return { origin, block: createErrorResponse(policy.error), refused: 'error' };
    }
    const urls = targets.urls.slice();
    if (targets.needsTab) urls.push(await resolveTabUrl(args));
    for (const url of urls) {
      const decision = evaluateSitePolicy({
        url,
        allow: policy.allow,
        deny: policy.deny,
        mode: policy.mode,
      });
      if ('error' in decision) {
        return { origin, block: createErrorResponse(decision.error), refused: 'error' };
      }
      if (origin === 'unknown') origin = decision.origin;
    }
  }

  const exfil = exfiltrationInput(name, args);
  if (exfil) {
    const hit = findExfiltratedSecret({
      url: exfil.url,
      body: exfil.body,
      secrets: sessionSecrets(),
      confirmCrossOrigin: confirmCrossOriginFlag(args),
    });
    if ('error' in hit) {
      return { origin, block: createErrorResponse(hit.error), refused: 'error' };
    }
    const requestOrigin = policyOrigin(exfil.url);
    if (requestOrigin !== 'unknown') origin = requestOrigin;
  }

  const action = crossOriginAction(name, args);
  if (action) {
    const target = origin !== 'unknown' ? origin : policyOrigin(await resolveTabUrl(args));
    const decision = decideCrossOrigin({
      readOrigin: readMark?.origin,
      readAtMs: readMark?.at,
      nowMs: Date.now(),
      targetOrigin: target,
      confirmCrossOrigin: confirmCrossOriginFlag(args),
    });
    if ('needs_confirmation' in decision) {
      return {
        origin: target,
        refused: 'needs_confirmation',
        block: {
          content: [{ type: 'text', text: JSON.stringify(decision) }],
          isError: false,
        },
      };
    }
    if (target && target !== 'unknown') origin = target;
  }

  return { origin };
}

export function completeToolCall(
  name: string,
  args: unknown,
  origin: string,
  result: ToolResult,
  refused?: 'error' | 'needs_confirmation',
): void {
  if (!result.isError && !refused && toolNotesPageRead(name)) notePageRead(origin);
  const line: AuditLineInput = {
    time: new Date().toISOString(),
    tool: name,
    origin: origin || 'unknown',
    summary: summarizeToolArgs(args),
    result: result.isError || refused ? 'error' : 'ok',
    detail: refused === 'needs_confirmation' ? 'needs_confirmation' : undefined,
  };
  void writeAudit(line);
}
