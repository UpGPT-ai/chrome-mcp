import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { ERROR_MESSAGES } from '@/common/constants';
import { BaseBrowserToolExecutor } from '../base-browser';
import {
  TOOL_NAMES,
  clipboardAuditInput,
  highRiskDisabledError,
  originFromUrl,
  parseClipboardArgs,
  redactClipboardDetail,
  wrapUntrusted,
  type ParsedClipboardArgs,
} from 'chrome-mcp-shared';
import { runWithDebugger } from '@/utils/cdp-run';
import { readHighRiskFlags } from './high-risk';
import { withAuditError, writeAudit } from './audit-log';

/**
 * chrome_clipboard — navigator.clipboard in the page.
 * Off until highRiskTools.clipboard is true. Reads are wrapped with wrapUntrusted.
 * Audit lines record the action and the result, never the clipboard text.
 */

interface EvalResult {
  result?: { type?: string; value?: unknown; description?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pageOrigin(url: string | undefined): string | { error: string } {
  const origin = originFromUrl(url);
  if (!origin.startsWith('http://') && !origin.startsWith('https://')) {
    return { error: 'chrome_clipboard needs an http(s) page' };
  }
  return origin;
}

function clipboardExpression(parsed: ParsedClipboardArgs): string {
  if (parsed.action === 'read') return '(async () => navigator.clipboard.readText())()';
  return `(async () => { await navigator.clipboard.writeText(${JSON.stringify(parsed.text)}); })()`;
}

function readEval(result: EvalResult, expectText: boolean): string {
  const details = result?.exceptionDetails;
  if (details) {
    throw new Error(
      details.exception?.description || details.text || 'navigator.clipboard failed in the page',
    );
  }
  const remote = result?.result;
  if (!expectText) return '';
  if (remote?.type === 'string' && typeof remote.value === 'string') return remote.value;
  throw new Error('navigator.clipboard.readText did not return a string');
}

function domainMissing(message: string): boolean {
  return message.includes("wasn't found") || message.includes('was not found');
}

class ClipboardTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CLIPBOARD;

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const flags = await readHighRiskFlags();
    if (!flags.clipboard) {
      const auditError = await writeAudit(
        clipboardAuditInput({
          time: new Date().toISOString(),
          origin: 'unknown',
          action: 'disabled',
          result: 'error',
          detail: 'off by default',
        }),
      );
      return createErrorResponse(withAuditError(highRiskDisabledError('clipboard'), auditError));
    }

    const parsed = parseClipboardArgs(args);
    if ('error' in parsed) {
      const auditError = await writeAudit(
        clipboardAuditInput({
          time: new Date().toISOString(),
          origin: 'unknown',
          action: 'invalid',
          result: 'error',
          detail: parsed.error,
        }),
      );
      return createErrorResponse(
        withAuditError(`${ERROR_MESSAGES.INVALID_PARAMETERS}: ${parsed.error}`, auditError),
      );
    }

    let origin = 'unknown';
    try {
      const explicit = await this.tryGetTab(parsed.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(parsed.windowId));
      if (!tab.id) {
        const auditError = await this.audit('unknown', parsed.action, 'error', 'tab has no id');
        return createErrorResponse(
          withAuditError(`${ERROR_MESSAGES.TAB_NOT_FOUND}: Active tab has no ID`, auditError),
        );
      }
      const resolved = pageOrigin(tab.url);
      if (typeof resolved !== 'string') {
        const auditError = await this.audit(origin, parsed.action, 'error', resolved.error);
        return createErrorResponse(withAuditError(resolved.error, auditError));
      }
      origin = resolved;
      try {
        await this.ensureFocus(tab, { activate: true, focusWindow: true });
      } catch {
        // Clipboard still requires a focused document. The page call reports that.
      }

      const ran = await runWithDebugger(tab.id, 'clipboard', async ({ send }) => {
        let permissionGrant: 'granted' | 'unavailable' = 'granted';
        try {
          await send('Browser.grantPermissions', {
            origin,
            permissions: ['clipboardReadWrite'],
          });
        } catch (error) {
          const message = errMsg(error);
          if (!domainMissing(message)) throw error;
          permissionGrant = 'unavailable';
        }
        const evaluated = await send<EvalResult>('Runtime.evaluate', {
          expression: clipboardExpression(parsed),
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        });
        return { permissionGrant, text: readEval(evaluated, parsed.action === 'read') };
      });

      const auditError = await this.audit(origin, parsed.action, 'ok');
      if (parsed.action === 'read') {
        return ok({
          success: true,
          action: 'read',
          origin,
          text: wrapUntrusted(origin, ran.text),
          ...(ran.permissionGrant === 'unavailable' ? { permissionGrant: 'unavailable' } : {}),
          ...(auditError ? { auditError } : {}),
        });
      }
      return ok({
        success: true,
        action: 'write',
        origin,
        byteSize: new TextEncoder().encode(parsed.text).length,
        ...(ran.permissionGrant === 'unavailable' ? { permissionGrant: 'unavailable' } : {}),
        ...(auditError ? { auditError } : {}),
      });
    } catch (error) {
      const message = redactClipboardDetail(
        errMsg(error),
        parsed.action === 'write' ? parsed.text : undefined,
      );
      const auditError = await this.audit(origin, parsed.action, 'error', message);
      return createErrorResponse(
        withAuditError(`${ERROR_MESSAGES.TOOL_EXECUTION_FAILED}: ${message}`, auditError),
      );
    }
  }

  private audit(
    origin: string,
    action: 'read' | 'write',
    result: 'ok' | 'error',
    detail?: string,
  ): Promise<string | null> {
    return writeAudit(
      clipboardAuditInput({
        time: new Date().toISOString(),
        origin,
        action,
        result,
        detail,
      }),
    );
  }
}

export const clipboardTool = new ClipboardTool();
