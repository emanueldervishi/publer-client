# Publer Pilot — MCP Client

A Next.js dashboard that talks to the [Publer MCP server](https://github.com/emanueldervishi/publer-mcp-agent) via [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) and lets you chat with [Gemini 2.5 Flash](https://ai.google.dev/) to run social-marketing workflows end-to-end.

This is the **client** half. The MCP server lives in a sibling repo (`publer-mcp-agent`) and exposes 42 Publer tools.

- Sidebar lists Publer workspaces (pulled directly from `GET https://app.publer.com/api/v1/workspaces` — no MCP round-trip for static UI data).
- Pick a workspace → its `id` is auto-injected into every MCP tool call in the chat.
- Chat panel streams Gemini's thinking + tool calls + tool results + final text via SSE.
- All Publer MCP tools available to the agent out of the box (campaigns, analytics, scheduling, recurring/recycling, every content type).

### split of responsibilities

- **Direct Publer calls** for static, read-only UI lookups (workspaces, accounts list for a picker, etc.) — keeps the sidebar snappy and saves an MCP round-trip.
- **MCP for the agent** — when Gemini does real work (schedule, publish, draft, analyze), it goes through the MCP server so all the tool annotations, confirm gates, and orchestrators (`publer_smart_campaign`, `publer_get_campaign_context`) apply.

## not OAuth

Publer's API is key-based — there is no OAuth flow. The "login" model is: the MCP server holds your `PUBLER_API_KEY` server-side, this web app talks to that MCP server. Whoever has access to this web app demos against that one Publer account. For multi-tenant, you'd run one MCP server per tenant.

## setup

```bash
git clone <this repo>
cd mcp-client
cp .env.local.example .env.local
# fill in MCP_SERVER_URL, GEMINI_API_KEY, PUBLER_API_KEY
npm install
npm run dev
```

Open <http://localhost:3001>.

`.env.local`:

```
MCP_SERVER_URL=http://localhost:3000/mcp
GEMINI_API_KEY=...
PUBLER_API_KEY=...
```

- `PUBLER_API_KEY` is used by `/api/workspaces` to hit Publer directly for the sidebar listing.
- `MCP_SERVER_URL` is used by `/api/chat` for the agent loop. Point this at your deployed MCP server (Railway/Fly/Render) or `localhost:3000/mcp` while developing.
- `GEMINI_API_KEY` powers Gemini 2.5 Flash. Get one from [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — 2.5 Flash is on the free tier.

You also need the MCP server running (the sibling [`publer-mcp-agent`](https://github.com/emanueldervishi/publer-mcp-agent) repo):

```bash
# in publer-mcp-agent
npm run dev:http
```

## architecture

```
browser ──▶ /api/chat (SSE) ──▶ Gemini 2.5 Flash + tool decls
                  │                       │
                  ▼                       ▼
              MCP client          (function call)
                  │                       │
                  └──── MCP server ◀──────┘
                          │
                          ▼
                      Publer API
```

- `lib/mcp.ts` — opens a `StreamableHTTPClientTransport` to your MCP server, lists tools, executes calls. Parses the MCP text-content block back to JSON.
- `lib/gemini.ts` — converts MCP JSON schemas to Gemini function declarations, runs an agentic loop (max 20 iterations) with retry-on-overload (429/500/502/503/504, "high demand", "unavailable"). Auto-injects the selected `workspaceId` into any tool that accepts it.
- `app/api/chat/route.ts` — wraps the loop in a `ReadableStream` and emits SSE events: `thinking`, `tool_call`, `tool_result`, `tool_error`, `text`, `error`, `done`.
- `app/api/workspaces/route.ts` — direct `GET https://app.publer.com/api/v1/workspaces` with the server-side `PUBLER_API_KEY`. No MCP. Renders the sidebar.
- `app/page.tsx` — sidebar + chat dashboard. Stores the selected workspace in `localStorage`.

## demo prompts

| prompt | chained tool calls |
|---|---|
| "What's failing across my accounts?" | `publer_list_failed_posts` |
| "Pull campaign context for the next week." | `publer_get_campaign_context` |
| "Set up a recurring Monday LinkedIn post at 10:00." | `publer_list_accounts` → `publer_create_recurring_post` |
| "Brainstorm 6 launch ideas and save them as drafts." | `publer_save_workspace_drafts` |
| "Run a 7-day campaign across every network." | `publer_get_campaign_context` → `publer_smart_campaign` |
| "Audit my hashtag performance vs competitors." | `publer_get_hashtag_analysis` → `publer_get_competitor_analysis` |

## not yet supported

- **File uploads from this web UI.** The MCP server's media upload tool (`publer_upload_media_from_chatgpt_file`) expects the ChatGPT Apps SDK file-reference object. A browser-upload path through the web app would need either a new MCP tool that accepts base64 directly, or the web app uploading straight to Publer's `/media` endpoint server-side. Open as future work.
- **Streaming text within a single Gemini call.** We stream events between iterations (each tool call is its own SSE event) but Gemini's final text comes back in one shot per iteration. Easy upgrade later via `generateContentStream`.

## deploy

Single-process Node, holds an MCP client per request — fits Railway, Fly.io, Render Starter. Set `MCP_SERVER_URL`, `GEMINI_API_KEY`, and `PUBLER_API_KEY` in the platform's env panel. The web app talks to the MCP server over HTTPS — both can live on the same host as two services, or split across providers.
# publer-client
