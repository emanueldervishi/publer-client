import { callMcpTool, listMcpTools, openMcpClient } from "@/lib/mcp";
import { runAgentLoop, type ChatMessage, type StreamEvent } from "@/lib/gemini";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

type ChatRequest = {
  messages: ChatMessage[];
  workspaceId?: string;
};

function sseChunk(event: StreamEvent): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(request: Request) {
  let body: ChatRequest;
  try {
    body = (await request.json()) as ChatRequest;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
    return new Response(JSON.stringify({ error: "messages is required" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: StreamEvent) => {
        try {
          controller.enqueue(sseChunk(event));
        } catch {
          // controller may already be closed
        }
      };

      let mcp;
      try {
        mcp = await openMcpClient();
      } catch (error) {
        emit({ type: "error", error: error instanceof Error ? error.message : String(error) });
        emit({ type: "done" });
        controller.close();
        return;
      }

      try {
        const tools = await listMcpTools(mcp.client);
        await runAgentLoop({
          messages,
          workspaceId: body.workspaceId,
          tools,
          callTool: (name, args) => callMcpTool(mcp!.client, name, args),
          emit
        });
      } catch (error) {
        emit({ type: "error", error: error instanceof Error ? error.message : String(error) });
        emit({ type: "done" });
      } finally {
        await mcp.close();
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    }
  });
}
