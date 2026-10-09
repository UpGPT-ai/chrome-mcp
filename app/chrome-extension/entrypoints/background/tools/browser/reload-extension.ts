import { ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { writeAudit } from './audit-log';

/**
 * chrome_reload_extension — reload this extension after a rebuild.
 * Always on: it only restarts our own extension, and the call needs the
 * authenticated bridge. Audit-logged. The reload runs after the reply is sent.
 */

const RELOAD_DELAY_MS = 1_000;

class ReloadExtensionTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.RELOAD_EXTENSION;

  async execute(): Promise<ToolResult> {
    const auditError = await writeAudit({
      time: new Date().toISOString(),
      tool: this.name,
      origin: 'extension',
      summary: 'reload extension',
      result: 'ok',
    });
    setTimeout(() => chrome.runtime.reload(), RELOAD_DELAY_MS);
    const payload = {
      success: true,
      message: 'Reload starts in about 1 second. The bridge reconnects on its own.',
      ...(auditError ? { auditError } : {}),
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
  }
}

export const reloadExtensionTool = new ReloadExtensionTool();
