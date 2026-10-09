import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { TOOL_NAMES, parseAuditLimit } from 'chrome-mcp-shared';
import { BaseBrowserToolExecutor } from '../base-browser';
import {
  addNativeResponseListener,
  removeNativeResponseListener,
  postToNative,
} from '@/entrypoints/background/native-host';

/**
 * chrome_audit_log reads the newest lines of ~/.chrome-mcp-agent/audit.log.
 * The native host owns the file. This tool does not import the shared rotate constant.
 */

const AUDIT_TIMEOUT_MS = 10_000;

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
}

class AuditLogTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.AUDIT_LOG;

  async execute(args: { limit?: number }): Promise<ToolResult> {
    const limit = parseAuditLimit(args?.limit);
    if (typeof limit !== 'number') {
      return createErrorResponse(limit.error);
    }
    try {
      const entries = await readAuditEntries(limit);
      return ok({ success: true, entries, count: entries.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return createErrorResponse(message);
    }
  }
}

function readAuditEntries(limit: number): Promise<unknown[]> {
  const requestId = `audit-read-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      removeNativeResponseListener(onMessage);
      reject(new Error('Audit log read timed out'));
    }, AUDIT_TIMEOUT_MS);

    const onMessage = (message: {
      type?: string;
      responseToRequestId?: string;
      error?: string;
      payload?: { success?: boolean; error?: string; entries?: unknown[] };
    }) => {
      if (
        message?.type !== 'file_operation_response' ||
        message.responseToRequestId !== requestId
      ) {
        return;
      }
      clearTimeout(timer);
      removeNativeResponseListener(onMessage);
      if (message.payload?.success && Array.isArray(message.payload.entries)) {
        resolve(message.payload.entries);
        return;
      }
      reject(new Error(message.payload?.error || message.error || 'Audit log was not read'));
    };

    addNativeResponseListener(onMessage);
    postToNative({
      type: 'file_operation',
      requestId,
      payload: { action: 'readAudit', limit },
    }).catch((error) => {
      clearTimeout(timer);
      removeNativeResponseListener(onMessage);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export const auditLogTool = new AuditLogTool();
