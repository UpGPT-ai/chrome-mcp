import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { ERROR_MESSAGES } from '@/common/constants';
import { BaseBrowserToolExecutor } from '../base-browser';
import {
  TOOL_NAMES,
  grantAuditInput,
  highRiskDisabledError,
  matchSitePolicyOrigin,
  parseGrantPermissionArgs,
  type ParsedGrantArgs,
} from 'chrome-mcp-shared';
import { runWithDebugger } from '@/utils/cdp-run';
import { readHighRiskFlags, readSitePolicyAllowOrigins } from './high-risk';
import { withAuditError, writeAudit } from './audit-log';

/**
 * chrome_grant_permission — Browser.grantPermissions / Browser.resetPermissions.
 * Off until highRiskTools.grantPermission is true, and the origin is listed in
 * sitePolicyAllowOrigins. Every attempt is audit-logged. No browser-wide attach.
 */

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function originHint(args: Record<string, unknown>): string {
  if (typeof args.origin !== 'string') return 'unknown';
  const cleaned = args.origin.replace(/[\r\n]/g, '').trim();
  return cleaned ? cleaned.slice(0, 200) : 'unknown';
}

function browserDomainError(error: unknown): Error {
  const message = errMsg(error);
  if (message.includes("wasn't found") || message.includes('was not found')) {
    return new Error(
      `${message}. This tab debugger session does not expose the Browser domain, so the permission was not changed. Close DevTools on the tab and retry. A browser-wide debugger is not attached.`,
    );
  }
  return error instanceof Error ? error : new Error(message);
}

class GrantPermissionTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.GRANT_PERMISSION;

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const flags = await readHighRiskFlags();
    if (!flags.grantPermission) {
      const auditError = await writeAudit(
        grantAuditInput({
          time: new Date().toISOString(),
          origin: originHint(args),
          action: 'disabled',
          result: 'error',
          detail: 'off by default',
        }),
      );
      return createErrorResponse(
        withAuditError(highRiskDisabledError('grantPermission'), auditError),
      );
    }

    const parsed = parseGrantPermissionArgs(args);
    if ('error' in parsed) {
      const auditError = await writeAudit(
        grantAuditInput({
          time: new Date().toISOString(),
          origin: originHint(args),
          action: 'invalid',
          result: 'error',
          detail: parsed.error,
        }),
      );
      return createErrorResponse(
        withAuditError(`${ERROR_MESSAGES.INVALID_PARAMETERS}: ${parsed.error}`, auditError),
      );
    }

    const policy = await readSitePolicyAllowOrigins();
    if ('error' in policy) {
      const auditError = await this.audit(parsed, 'error', policy.error);
      return createErrorResponse(withAuditError(policy.error, auditError));
    }
    const allowed = matchSitePolicyOrigin(parsed.origin, policy.stored);
    if ('error' in allowed) {
      const auditError = await this.audit(parsed, 'error', allowed.error);
      return createErrorResponse(withAuditError(allowed.error, auditError));
    }

    try {
      const explicit = await this.tryGetTab(parsed.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(parsed.windowId));
      if (!tab.id) {
        throw new Error(`${ERROR_MESSAGES.TAB_NOT_FOUND}: Active tab has no ID`);
      }

      await runWithDebugger(tab.id, 'grant-permission', async ({ send }) => {
        if (parsed.mode === 'reset') {
          await send('Browser.resetPermissions', {});
          return;
        }
        await send('Browser.grantPermissions', {
          origin: parsed.origin,
          permissions: parsed.cdpPermissions,
        });
      });

      const auditError = await this.audit(parsed, 'ok');
      if (parsed.mode === 'reset') {
        return ok({
          success: true,
          origin: parsed.origin,
          reset: true,
          scope: 'browserContext',
          ...(auditError ? { auditError } : {}),
        });
      }
      return ok({
        success: true,
        origin: parsed.origin,
        permissions: parsed.permissions,
        cdpPermissions: parsed.cdpPermissions,
        ...(auditError ? { auditError } : {}),
      });
    } catch (error) {
      const message = errMsg(browserDomainError(error));
      const auditError = await this.audit(parsed, 'error', message);
      return createErrorResponse(
        withAuditError(`${ERROR_MESSAGES.TOOL_EXECUTION_FAILED}: ${message}`, auditError),
      );
    }
  }

  private audit(
    parsed: ParsedGrantArgs,
    result: 'ok' | 'error',
    detail?: string,
  ): Promise<string | null> {
    return writeAudit(
      grantAuditInput({
        time: new Date().toISOString(),
        origin: parsed.origin,
        action: parsed.mode,
        permissions: parsed.mode === 'grant' ? parsed.permissions : undefined,
        result,
        detail,
      }),
    );
  }
}

export const grantPermissionTool = new GrantPermissionTool();
