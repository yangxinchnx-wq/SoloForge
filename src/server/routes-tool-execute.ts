/**
 * Tool execution endpoint - receives tool calls from Java Agent and relays to backends.
 *
 * <p>Implementation notes:
 * <ul>
 *   <li>Java Agent sends tool_execute request here</li>
 *   <li>Routes to Obscura, Browser-Use, Windows-MCP based on tool name</li>
 *   <li>Returns raw result back to Java Agent</li>
 * </ul>
 */

export async function handleToolExecute(body: any, deps: AgentRouteDeps): Promise<ApiResponse> {
  const { tool, args } = body ?? {};

  if (!tool) {
    return { status: 400, headers: { 'Content-Type': 'application/json' }, body: { error: 'tool is required' } };
  }

  try {
    const integration = (deps.kernel as any)?.javaAgentTcp?.getIntegration?.();
    if (!integration) {
      return { status: 503, headers: { 'Content-Type': 'application/json' }, body: { error: 'Java Agent TCP not connected' } };
    }

    const result = await integration.executeTool(tool, args ?? {});

    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { success: true, result } };

  } catch (e: any) {
    return { status: 500, headers: { 'Content-Type': 'application/json' }, body: { error: e?.message || String(e) } };
  }
}
