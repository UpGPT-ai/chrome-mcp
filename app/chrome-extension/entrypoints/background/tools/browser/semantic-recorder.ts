import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { ERROR_MESSAGES } from '@/common/constants';
import { BaseBrowserToolExecutor } from '../base-browser';
import {
  SITE_POLICY_ALLOW_ORIGINS_KEY,
  TOOL_NAMES,
  exportFlowCalls,
  highRiskDisabledError,
  matchSitePolicyOrigin,
  parseFlowExportArgs,
  parseFlowListArgs,
  parseFlowRunArgs,
  parseRecordingArgs,
  replayAgentView,
  replayPlan,
  stepNotFoundError,
  type PreparedStep,
} from 'chrome-mcp-shared';
import { readHighRiskFlags, readSitePolicyAllowOrigins } from './high-risk';
import { RecorderManager } from '../../record-replay/recording/recorder-manager';
import { recordingSession } from '../../record-replay/recording/session-manager';
import {
  getSemanticFlow,
  listSemanticFlows,
  prepareSemanticRecording,
  semanticStatus,
} from '../../record-replay/recording/semantic-recording';

/**
 * chrome_recording, chrome_flow_list, chrome_flow_run, chrome_flow_export.
 * Off until highRiskTools.recording is true. Agent start also checks site policy.
 * Popup record buttons call the recorder directly and do not use these tools.
 */

interface PageApplyResult {
  ok?: boolean;
  found?: boolean;
  frameHref?: string;
}

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
}

function invalid(error: string): ToolResult {
  return createErrorResponse(`${ERROR_MESSAGES.INVALID_PARAMETERS}: ${error}`);
}

async function requireRecording(): Promise<ToolResult | null> {
  const flags = await readHighRiskFlags();
  if (!flags.recording) return createErrorResponse(highRiskDisabledError('recording'));
  return null;
}

function waitForNavigation(tabId: number, url: string): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    let sawLoading = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const timer = setTimeout(finish, 15000);
    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (id !== tabId) return;
      if (info.status === 'loading') sawLoading = true;
      if (info.status === 'complete' && (tab.url === url || sawLoading)) finish();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

/** Runs in the page. Attempts are precomputed. The return value never includes field text. */
function applySemanticStep(step: PreparedStep): PageApplyResult {
  const frameHref = String(location.href || '');
  function visible(el: Element): boolean {
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }
  function accName(el: Element): string {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a' || tag === 'summary' || tag === 'label') {
      return (el.textContent || '').trim();
    }
    if (el.id) {
      try {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab) return (lab.textContent || '').trim();
      } catch {
        // The id is still usable through getElementById.
      }
    }
    const wrap = el.closest('label');
    if (wrap) return (wrap.textContent || '').trim();
    const placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) return placeholder.trim();
    return (el.textContent || '').trim();
  }
  function first(selector: string | undefined, name?: string): Element | null {
    if (!selector) return null;
    let nodes: Element[] = [];
    try {
      nodes = Array.from(document.querySelectorAll(selector));
    } catch {
      return null;
    }
    const want = (name || '').trim();
    const hits = nodes.filter((el) => visible(el) && (!want || accName(el) === want));
    return hits[0] || null;
  }
  let el: Element | null = null;
  for (const attempt of step.attempts || []) {
    if (el) break;
    if (attempt.kind === 'role') el = first(attempt.selector, attempt.name);
    else if (attempt.kind === 'label') {
      const want = (attempt.text || '').trim();
      for (const label of Array.from(document.querySelectorAll('label'))) {
        if ((label.textContent || '').trim() !== want) continue;
        const htmlLabel = label as HTMLLabelElement;
        if (htmlLabel.htmlFor) {
          el = document.getElementById(htmlLabel.htmlFor);
          if (el) break;
        }
        el = label.querySelector('input, textarea, select, button');
        if (el) break;
      }
    } else if (attempt.kind === 'name' && attempt.htmlName) {
      el = document.getElementsByName(attempt.htmlName)[0] || null;
    } else if (attempt.kind === 'id' && attempt.id) {
      el = document.getElementById(attempt.id);
    } else if (attempt.kind === 'text') {
      const want = (attempt.text || '').trim();
      el =
        Array.from(
          document.querySelectorAll('button, a, summary, label, [role="button"], [role="link"]'),
        ).find((node) => visible(node) && (node.textContent || '').trim() === want) || null;
    } else if (attempt.kind === 'css') {
      el = first(attempt.selector);
    }
  }
  if (!el) return { ok: false, found: false, frameHref };
  try {
    if (step.action === 'click' || step.action === 'submit') {
      (el as HTMLElement).click();
    } else if (step.action === 'check') {
      const on = step.value === true;
      if ('checked' in el) {
        (el as HTMLInputElement).checked = on;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        (el as HTMLElement).click();
      }
    } else if (step.action === 'fill' || step.action === 'select') {
      const text = typeof step.value === 'string' ? step.value : '';
      if (el instanceof HTMLSelectElement || 'value' in el) {
        (el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if ((el as HTMLElement).isContentEditable) {
        el.textContent = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        return { ok: false, found: false, frameHref };
      }
    } else if (step.action === 'key') {
      const combo = typeof step.value === 'string' ? step.value : '';
      const parts = combo
        .split('+')
        .map((part) => part.trim())
        .filter(Boolean);
      const main = parts.length ? parts[parts.length - 1] : combo;
      const lower = combo.toLowerCase();
      (el as HTMLElement).focus();
      el.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: main,
          bubbles: true,
          ctrlKey: lower.includes('ctrl') || lower.includes('control'),
          metaKey: lower.includes('meta') || lower.includes('cmd'),
          altKey: lower.includes('alt'),
          shiftKey: lower.includes('shift'),
        }),
      );
    } else {
      return { ok: false, found: false, frameHref };
    }
  } catch {
    return { ok: false, found: false, frameHref };
  }
  return { ok: true, found: true, frameHref };
}

function pickFrame(
  results: Array<{ result?: PageApplyResult | null }>,
  framePath: string[],
): PageApplyResult | undefined {
  const wanted = new Set(framePath);
  const rows = results
    .map((result) => result.result)
    .filter((result): result is PageApplyResult => !!result);
  const matched = rows.filter((result) => result.frameHref && wanted.has(result.frameHref));
  return matched.find((result) => result.ok) || matched[0];
}

async function runStep(tabId: number, step: PreparedStep): Promise<string | null> {
  try {
    if (step.action === 'navigate') {
      const url = typeof step.value === 'string' ? step.value : step.url;
      if (!url) return stepNotFoundError(step.index);
      await chrome.tabs.update(tabId, { url });
      await waitForNavigation(tabId, url);
      return null;
    }
    const framePath = step.framePath || [];
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: framePath.length > 0 },
      world: 'MAIN',
      func: applySemanticStep,
      args: [step],
    });
    const picked = framePath.length ? pickFrame(results, framePath) : results[0]?.result;
    if (!picked?.ok) return stepNotFoundError(step.index);
    return null;
  } catch {
    return stepNotFoundError(step.index);
  }
}

class RecordingTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.RECORDING;

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const blocked = await requireRecording();
    if (blocked) return blocked;
    const parsed = parseRecordingArgs(args);
    if ('error' in parsed) return invalid(parsed.error);

    if (parsed.action === 'status') {
      await prepareSemanticRecording();
      return ok({
        success: true,
        status: recordingSession.getStatus(),
        semantic: semanticStatus(),
      });
    }

    if (parsed.action === 'stop') {
      await prepareSemanticRecording();
      const before = semanticStatus();
      const stopped = await RecorderManager.stop();
      if (!stopped.success && !before.flowId) {
        return createErrorResponse(stopped.error || 'No active recording');
      }
      return ok({
        success: true,
        flowId: before.flowId,
        name: before.name,
        steps: before.steps,
        error: stopped.error,
      });
    }

    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!active?.id) return createErrorResponse('Active tab not found');
    if (parsed.tabId !== undefined && parsed.tabId !== active.id) {
      return createErrorResponse('recording runs only on the active tab');
    }
    const policy = await readSitePolicyAllowOrigins();
    if ('error' in policy) {
      return createErrorResponse(
        `Site policy could not be read (storage key ${SITE_POLICY_ALLOW_ORIGINS_KEY}). chrome_recording refused.`,
      );
    }
    const allowed = matchSitePolicyOrigin(active.url || '', policy.stored, 'chrome_recording');
    if ('error' in allowed) return createErrorResponse(allowed.error);

    const started = await RecorderManager.start(parsed.name ? { name: parsed.name } : undefined);
    if (!started.success) return createErrorResponse(started.error || 'Recording did not start');
    return ok({
      success: true,
      status: 'recording',
      flowId: semanticStatus().flowId,
      tabId: active.id,
    });
  }
}

class FlowListTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FLOW_LIST;

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const blocked = await requireRecording();
    if (blocked) return blocked;
    const parsed = parseFlowListArgs(args);
    if ('error' in parsed) return invalid(parsed.error);
    const flows = await listSemanticFlows(parsed.name);
    return ok({
      success: true,
      flows: flows.map((flow) => ({
        version: flow.version,
        id: flow.id,
        name: flow.name,
        createdAt: flow.createdAt,
        updatedAt: flow.updatedAt,
        stepCount: flow.steps.length,
        steps: flow.steps,
      })),
    });
  }
}

class FlowRunTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FLOW_RUN;

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const blocked = await requireRecording();
    if (blocked) return blocked;
    const parsed = parseFlowRunArgs(args);
    if ('error' in parsed) return invalid(parsed.error);
    const flow = await getSemanticFlow(parsed.flowId);
    if (!flow) return createErrorResponse(`flow ${parsed.flowId} was not found`);
    const plan = replayPlan(flow, parsed.params);
    if ('error' in plan) return invalid(plan.error);
    if ('needsSecret' in plan) {
      return ok({ success: true, flowId: flow.id, ...replayAgentView(plan) });
    }

    let tabId: number;
    if (parsed.tabId !== undefined) {
      const tab = await this.tryGetTab(parsed.tabId);
      if (!tab?.id) {
        return createErrorResponse(`${ERROR_MESSAGES.TAB_NOT_FOUND}: ${parsed.tabId}`);
      }
      tabId = tab.id;
    } else {
      const tab = await this.getActiveTabOrThrowInWindow();
      if (!tab.id) return createErrorResponse('Active tab not found');
      tabId = tab.id;
    }

    for (const step of plan.steps) {
      const missed = await runStep(tabId, step);
      if (missed) return createErrorResponse(missed);
    }
    return ok({ success: true, flowId: flow.id, stepsRun: plan.steps.length });
  }
}

class FlowExportTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FLOW_EXPORT;

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const blocked = await requireRecording();
    if (blocked) return blocked;
    const parsed = parseFlowExportArgs(args);
    if ('error' in parsed) return invalid(parsed.error);
    const flow = await getSemanticFlow(parsed.flowId);
    if (!flow) return createErrorResponse(`flow ${parsed.flowId} was not found`);
    return ok(exportFlowCalls(flow));
  }
}

export const recordingTool = new RecordingTool();
export const semanticFlowListTool = new FlowListTool();
export const semanticFlowRunTool = new FlowRunTool();
export const semanticFlowExportTool = new FlowExportTool();
