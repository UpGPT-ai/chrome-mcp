import { formatAuditLine, type AuditLineInput } from 'chrome-mcp-shared';
import {
  addNativeResponseListener,
  removeNativeResponseListener,
  postToNative,
} from '@/entrypoints/background/native-host';

/**
 * Append one audit line through the native host.
 * The formatted line is the payload. Callers must not put secrets in it.
 * Returns an error string when the write fails, and null when it lands.
 */

const AUDIT_TIMEOUT_MS = 10_000;

export async function writeAudit(input: AuditLineInput): Promise<string | null> {
  const line = formatAuditLine(input);
  const requestId = `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await sendAudit(requestId, line);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function withAuditError(message: string, auditError: string | null): string {
  if (!auditError) return message;
  return `${message} Audit log was not written: ${auditError}`;
}

function sendAudit(requestId: string, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      removeNativeResponseListener(onMessage);
      reject(new Error('Audit log write timed out'));
    }, AUDIT_TIMEOUT_MS);

    const onMessage = (message: {
      type?: string;
      responseToRequestId?: string;
      error?: string;
      payload?: { success?: boolean; error?: string };
    }) => {
      if (
        message?.type !== 'file_operation_response' ||
        message.responseToRequestId !== requestId
      ) {
        return;
      }
      clearTimeout(timer);
      removeNativeResponseListener(onMessage);
      if (message.payload?.success) {
        resolve();
        return;
      }
      reject(new Error(message.payload?.error || message.error || 'Audit log was not written'));
    };

    addNativeResponseListener(onMessage);
    postToNative({
      type: 'file_operation',
      requestId,
      payload: { action: 'appendAudit', line },
    }).catch((error) => {
      clearTimeout(timer);
      removeNativeResponseListener(onMessage);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}
