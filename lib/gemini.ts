import { GoogleGenAI, Type } from "@google/genai";
import type { McpTool } from "./mcp.js";

export type ChatAttachment = {
  mimeType: string;
  dataBase64: string;
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  attachments?: ChatAttachment[];
};

export type StreamEvent =
  | { type: "thinking"; iteration: number }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; data: unknown }
  | { type: "tool_error"; name: string; error: string }
  | { type: "text"; content: string }
  | { type: "error"; error: string }
  | { type: "done" };

type FunctionCall = { id?: string; name: string; args: Record<string, unknown> };

const MAX_ITERATIONS = 20;
const RETRY_STATUSES = [429, 500, 502, 503, 504];
const RETRY_DELAY_MS = [1200, 2400, 5000];

function looksOverloaded(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("unavailable") ||
    lower.includes("overloaded") ||
    lower.includes("high demand") ||
    lower.includes("rate limit") ||
    RETRY_STATUSES.some((status) => lower.includes(`"code":${status}`) || lower.includes(` ${status} `))
  );
}

async function callWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAY_MS.length; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!looksOverloaded(message) || attempt === RETRY_DELAY_MS.length) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS[attempt]));
    }
  }
  throw lastError;
}

function friendlyError(message: string): string {
  if (looksOverloaded(message)) {
    return "Gemini 2.5 Flash is overloaded (free tier capacity). I retried a few times — try again in a minute, or switch to a paid Gemini model.";
  }
  return message;
}

function mapJsonSchemaToGemini(node: unknown): Record<string, unknown> | undefined {
  if (!node || typeof node !== "object") return undefined;
  const schema = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const t = schema.type;

  if (typeof t === "string") {
    switch (t) {
      case "string":
        out.type = Type.STRING;
        break;
      case "number":
        out.type = Type.NUMBER;
        break;
      case "integer":
        out.type = Type.INTEGER;
        break;
      case "boolean":
        out.type = Type.BOOLEAN;
        break;
      case "array": {
        out.type = Type.ARRAY;
        const items = mapJsonSchemaToGemini(schema.items);
        if (items) out.items = items;
        break;
      }
      case "object": {
        out.type = Type.OBJECT;
        const props = schema.properties as Record<string, unknown> | undefined;
        if (props) {
          const mapped: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(props)) {
            const m = mapJsonSchemaToGemini(value);
            if (m) mapped[key] = m;
          }
          if (Object.keys(mapped).length > 0) out.properties = mapped;
        }
        if (Array.isArray(schema.required) && schema.required.length > 0) {
          out.required = schema.required;
        }
        break;
      }
      default:
        out.type = Type.STRING;
    }
  } else {
    out.type = Type.STRING;
  }

  if (typeof schema.description === "string") out.description = schema.description;
  if (Array.isArray(schema.enum)) out.enum = schema.enum;

  return out;
}

function toolToFunctionDeclaration(tool: McpTool) {
  const parameters = mapJsonSchemaToGemini(tool.inputSchema) ?? {
    type: Type.OBJECT,
    properties: {}
  };
  return {
    name: tool.name,
    description: tool.description.slice(0, 1024),
    parameters
  };
}

function buildSystemInstruction(workspaceId: string | undefined): string {
  const today = new Date().toISOString();
  const lines = [
    "You are Publer Pilot, an agentic social-media copilot.",
    `Current time: ${today}.`,
    "You have a set of Publer MCP tools. Use them whenever they help — don't ask the user for confirmation before reading. For writes, follow the tool's confirm/confirmSchedule rules.",
    "Plan first, then call tools in sequence. After tools run, summarize results clearly with bullets, tables, or short paragraphs."
  ];
  if (workspaceId) {
    lines.push(
      `The user has selected workspace_id: ${workspaceId}. ALWAYS include workspaceId="${workspaceId}" in tool args when the tool accepts it.`
    );
  } else {
    lines.push(
      "The user has not selected a workspace. Call publer_list_workspaces first and ask them to pick one before any write actions."
    );
  }
  return lines.join("\n");
}

function injectWorkspace(args: Record<string, unknown>, workspaceId: string | undefined, schema: Record<string, unknown>): Record<string, unknown> {
  if (!workspaceId) return args;
  const properties = (schema.properties as Record<string, unknown> | undefined) ?? {};
  if (!("workspaceId" in properties)) return args;
  if (args.workspaceId) return args;
  return { ...args, workspaceId };
}

export async function runAgentLoop(opts: {
  messages: ChatMessage[];
  workspaceId?: string;
  tools: McpTool[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  emit: (event: StreamEvent) => void;
}): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    opts.emit({ type: "error", error: "GEMINI_API_KEY is not set in .env.local" });
    opts.emit({ type: "done" });
    return;
  }

  const ai = new GoogleGenAI({ apiKey });
  const toolSchemaByName = new Map(opts.tools.map((tool) => [tool.name, tool.inputSchema]));
  const functionDeclarations = opts.tools.map(toolToFunctionDeclaration);

  const contents: Array<Record<string, unknown>> = opts.messages.map((msg) => {
    const parts: Array<Record<string, unknown>> = [];
    if (msg.content) parts.push({ text: msg.content });
    if (msg.role === "user" && msg.attachments) {
      for (const att of msg.attachments) {
        parts.push({ inlineData: { mimeType: att.mimeType, data: att.dataBase64 } });
      }
    }
    if (parts.length === 0) parts.push({ text: "" });
    return {
      role: msg.role === "assistant" ? "model" : "user",
      parts
    };
  });

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    opts.emit({ type: "thinking", iteration });

    let response;
    try {
      response = await callWithRetry(() =>
        ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents,
          config: {
            systemInstruction: buildSystemInstruction(opts.workspaceId),
            tools: [{ functionDeclarations }],
            temperature: 0.7
          }
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const friendly = friendlyError(message);
      opts.emit({ type: "error", error: friendly });
      break;
    }

    const candidates = response.candidates ?? [];
    const firstCandidate = candidates[0];
    const parts = (firstCandidate?.content?.parts ?? []) as Array<Record<string, unknown>>;

    const functionCalls: FunctionCall[] = [];
    const textChunks: string[] = [];

    for (const part of parts) {
      if (part.functionCall) {
        const fc = part.functionCall as { id?: string; name?: string; args?: Record<string, unknown> };
        if (fc.name) {
          functionCalls.push({ id: fc.id, name: fc.name, args: fc.args ?? {} });
        }
      } else if (typeof part.text === "string" && part.text.length > 0) {
        textChunks.push(part.text);
      }
    }

    if (textChunks.length > 0) {
      opts.emit({ type: "text", content: textChunks.join("") });
    }

    if (functionCalls.length === 0) {
      break;
    }

    contents.push({
      role: "model",
      parts: parts.filter((p) => p.functionCall || typeof p.text === "string")
    });

    const responseParts: Array<Record<string, unknown>> = [];
    for (const call of functionCalls) {
      const schema = toolSchemaByName.get(call.name) ?? { type: "object", properties: {} };
      const finalArgs = injectWorkspace(call.args, opts.workspaceId, schema);
      opts.emit({ type: "tool_call", name: call.name, args: finalArgs });

      try {
        const data = await opts.callTool(call.name, finalArgs);
        opts.emit({ type: "tool_result", name: call.name, data });
        responseParts.push({
          functionResponse: {
            id: call.id,
            name: call.name,
            response: { result: data }
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        opts.emit({ type: "tool_error", name: call.name, error: message });
        responseParts.push({
          functionResponse: {
            id: call.id,
            name: call.name,
            response: { error: message }
          }
        });
      }
    }

    contents.push({ role: "user", parts: responseParts });
  }

  opts.emit({ type: "done" });
}
