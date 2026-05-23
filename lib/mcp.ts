import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export async function openMcpClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const url = process.env.MCP_SERVER_URL;
  if (!url) throw new Error("MCP_SERVER_URL is not set in .env.local");

  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client(
    { name: "publer-pilot-web", version: "0.1.0" },
    { capabilities: {} }
  );
  await client.connect(transport);

  return {
    client,
    close: async () => {
      try {
        await client.close();
      } catch {
        // ignore
      }
    }
  };
}

export async function listMcpTools(client: Client): Promise<McpTool[]> {
  const result = await client.listTools();
  return result.tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>
  }));
}

export async function callMcpTool(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  const content = Array.isArray(result.content) ? result.content : [];
  const textBlocks = content
    .filter((block): block is { type: "text"; text: string } => block && (block as { type?: string }).type === "text")
    .map((block) => block.text);
  const joined = textBlocks.join("\n");
  try {
    return JSON.parse(joined);
  } catch {
    return { text: joined, raw: result };
  }
}
