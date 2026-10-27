/** A provider-neutral handoff, using the installed launcher and this exact tab. */
export function agentConnectionInstructions(command: string | undefined, canvasId: string | undefined) {
  if (!command?.startsWith('/') || /[\r\n\0]/.test(command)) return null
  const configuration = JSON.stringify({ mcpServers: { galta: { command, args: [] } } }, null, 2)
  const target = canvasId ? `the canvas whose ID ends with /${canvasId}` : 'my open Galta canvas (ask me which one if several are open)'
  const prompt = `Connect to my Galta canvas using this local MCP server. Reuse an existing Galta server if configured; otherwise add the server below using your app's supported MCP configuration format, preserving all other servers. If your app needs a restart to load it, tell me the next step.\n\n${configuration}\n\nOnce the tools are available, call canvas_list, then canvas_connect with the full ID returned for ${target}. If that canvas is no longer open, ask me to reopen it. Confirm the connection and wait for my drawing instructions.`
  return { configuration, prompt }
}
