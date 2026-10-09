import { createErrorResponse } from '@/common/tool-handler';
import { ERROR_MESSAGES } from '@/common/constants';
import * as browserTools from './browser';
import { flowRunTool, listPublishedFlowsTool } from './record-replay';
import { completeToolCall, guardToolCall } from './browser/agent-guard';

const tools = { ...browserTools, flowRunTool, listPublishedFlowsTool } as any;
const toolsMap = new Map(Object.values(tools).map((tool: any) => [tool.name, tool]));

/**
 * Tool call parameter interface
 */
export interface ToolCallParam {
  name: string;
  args: any;
}

/**
 * Handle tool execution
 */
export const handleCallTool = async (param: ToolCallParam) => {
  const tool = toolsMap.get(param.name);
  if (!tool) {
    return createErrorResponse(`Tool ${param.name} not found`);
  }

  try {
    const guarded = await guardToolCall(param.name, param.args);
    if (guarded.block) {
      completeToolCall(param.name, param.args, guarded.origin, guarded.block, guarded.refused);
      return guarded.block;
    }
    const result = await tool.execute(param.args);
    completeToolCall(param.name, param.args, guarded.origin, result);
    return result;
  } catch (error) {
    console.error(`Tool execution failed for ${param.name}:`, error);
    const failed = createErrorResponse(
      error instanceof Error ? error.message : ERROR_MESSAGES.TOOL_EXECUTION_FAILED,
    );
    completeToolCall(param.name, param.args, 'unknown', failed);
    return failed;
  }
};
