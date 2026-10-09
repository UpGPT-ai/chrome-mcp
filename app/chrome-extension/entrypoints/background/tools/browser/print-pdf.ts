import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { ERROR_MESSAGES } from '@/common/constants';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, base64ByteLength, parsePrintPdfArgs, pdfTooLarge } from 'chrome-mcp-shared';
import { runWithDebugger } from '@/utils/cdp-run';
import {
  addNativeResponseListener,
  removeNativeResponseListener,
  postToNative,
} from '@/entrypoints/background/native-host';

/**
 * chrome_print_pdf — Page.printToPDF, then write the bytes through the native
 * host into the downloads directory. Default on. The base64 payload is not logged.
 */

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writePdfDownload(
  saveName: string,
  base64Data: string,
): Promise<{ filePath: string; size: number }> {
  const requestId = `print-pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      removeNativeResponseListener(onMessage);
      reject(
        new Error(
          'Saving the PDF through the native host timed out. Large PDFs can exceed the native messaging size limit.',
        ),
      );
    }, 30000);

    const onMessage = (message: {
      type?: string;
      responseToRequestId?: string;
      error?: string;
      payload?: { success?: boolean; filePath?: string; size?: number; error?: string };
    }) => {
      if (
        message?.type !== 'file_operation_response' ||
        message.responseToRequestId !== requestId
      ) {
        return;
      }
      clearTimeout(timer);
      removeNativeResponseListener(onMessage);
      if (message.payload?.success && message.payload.filePath) {
        resolve({
          filePath: message.payload.filePath,
          size: typeof message.payload.size === 'number' ? message.payload.size : 0,
        });
        return;
      }
      reject(
        new Error(message.payload?.error || message.error || 'Native host failed to save the PDF'),
      );
    };

    addNativeResponseListener(onMessage);
    postToNative({
      type: 'file_operation',
      requestId,
      payload: { action: 'saveDownload', saveName, base64Data },
    }).catch((error) => {
      clearTimeout(timer);
      removeNativeResponseListener(onMessage);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

class PrintPdfTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.PRINT_PDF;

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const parsed = parsePrintPdfArgs(args, new Date());
    if ('error' in parsed) {
      return createErrorResponse(`${ERROR_MESSAGES.INVALID_PARAMETERS}: ${parsed.error}`);
    }

    try {
      const explicit = await this.tryGetTab(parsed.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(parsed.windowId));
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }

      const printed = await runWithDebugger(tab.id, 'print-pdf', async ({ send }) => {
        const params: {
          landscape: boolean;
          printBackground: boolean;
          pageRanges?: string;
        } = {
          landscape: parsed.landscape,
          printBackground: parsed.printBackground,
        };
        if (parsed.pageRanges) params.pageRanges = parsed.pageRanges;
        const result = await send<{ data?: string }>('Page.printToPDF', params);
        if (typeof result?.data !== 'string' || !result.data) {
          throw new Error('Page.printToPDF returned no data');
        }
        return result.data;
      });

      const bytes = base64ByteLength(printed);
      if (typeof bytes !== 'number') {
        return createErrorResponse(`${ERROR_MESSAGES.TOOL_EXECUTION_FAILED}: ${bytes.error}`);
      }
      const tooLarge = pdfTooLarge(bytes);
      if (tooLarge)
        return createErrorResponse(`${ERROR_MESSAGES.TOOL_EXECUTION_FAILED}: ${tooLarge}`);

      const saved = await writePdfDownload(parsed.saveName, printed);
      return ok({
        success: true,
        path: saved.filePath,
        byteSize: saved.size || bytes,
        saveName: parsed.saveName,
      });
    } catch (error) {
      return createErrorResponse(`${ERROR_MESSAGES.TOOL_EXECUTION_FAILED}: ${errMsg(error)}`);
    }
  }
}

export const printPdfTool = new PrintPdfTool();
