import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PUBLER_BASE_URL = "https://app.publer.com/api/v1";

type WorkspaceSummary = {
  id: string;
  name: string;
  plan?: string;
  picture?: string;
  role?: string;
};

function pickWorkspaces(raw: unknown): WorkspaceSummary[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkspaceSummary[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id : undefined;
    if (!id) continue;
    const ws: WorkspaceSummary = {
      id,
      name: typeof obj.name === "string" ? obj.name : "Untitled workspace"
    };
    if (typeof obj.plan === "string") ws.plan = obj.plan;
    if (typeof obj.picture === "string") ws.picture = obj.picture;
    if (typeof obj.role === "string") ws.role = obj.role;
    out.push(ws);
  }
  return out;
}

export async function GET() {
  const apiKey = process.env.PUBLER_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "PUBLER_API_KEY is not set in .env.local" },
      { status: 500 }
    );
  }

  try {
    const response = await fetch(`${PUBLER_BASE_URL}/workspaces`, {
      method: "GET",
      headers: {
        Authorization: `Bearer-API ${apiKey}`,
        Accept: "application/json"
      },
      cache: "no-store"
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : null;

    if (!response.ok) {
      return NextResponse.json(
        { error: `Publer responded HTTP ${response.status}`, body: data },
        { status: response.status }
      );
    }

    return NextResponse.json({ workspaces: pickWorkspaces(data) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
