"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Workspace = {
  id: string;
  name: string;
  plan?: string;
  picture?: string;
  role?: string;
};

type ToolEvent = {
  kind: "call" | "result" | "error";
  name: string;
  args?: Record<string, unknown>;
  data?: unknown;
  error?: string;
};

type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  dataBase64: string;
  previewUrl: string;
  size: number;
};

type Message = {
  role: "user" | "assistant";
  content: string;
  tools?: ToolEvent[];
  attachments?: Attachment[];
};

type StreamEvent =
  | { type: "thinking"; iteration: number }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; data: unknown }
  | { type: "tool_error"; name: string; error: string }
  | { type: "text"; content: string }
  | { type: "error"; error: string }
  | { type: "done" };

const SELECTED_WORKSPACE_KEY = "publerPilot.selectedWorkspaceId";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Failed to read file"));
        return;
      }
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

const QUICK_PROMPTS = [
  { label: "What can you do?", body: "What can you help me with?" },
  { label: "Draft a caption", body: "Draft an engaging caption for my next post." },
  { label: "Best time to post", body: "When's the best time to post on my accounts?" },
  { label: "Audit workspace", body: "Audit my workspace and tell me what needs attention." },
  { label: "Recent analytics", body: "Show me recent analytics for my workspace." }
];

const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const ACCEPTED_MIME_PREFIX = "image/";

const STARTER_PROMPTS = [
  {
    eyebrow: "Campaign",
    title: "Build a full campaign",
    body: "Draft a 3-post campaign for our AI-powered Publer MCP assistant — teaser, value, CTA."
  },
  {
    eyebrow: "Analytics",
    title: "Find best timing",
    body: "Pull next 7 days — accounts, scheduled posts, analytics availability, and best-time slots."
  },
  {
    eyebrow: "Operations",
    title: "Audit my workspace",
    body: "Social manager overview: accessible accounts, scheduled posts, failed posts, analytics, next actions."
  },
  {
    eyebrow: "Media",
    title: "Create visual post",
    body: "Create a Facebook photo draft from this image URL with a bold caption for our hackathon demo."
  }
];

export default function Page() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      pending.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const remaining = MAX_ATTACHMENTS - pending.length;
    if (remaining <= 0) return;

    const accepted: Attachment[] = [];
    for (const file of Array.from(files).slice(0, remaining)) {
      if (!file.type.startsWith(ACCEPTED_MIME_PREFIX)) continue;
      if (file.size > MAX_ATTACHMENT_BYTES) continue;
      try {
        const dataBase64 = await fileToBase64(file);
        accepted.push({
          id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
          name: file.name,
          mimeType: file.type,
          dataBase64,
          previewUrl: URL.createObjectURL(file),
          size: file.size
        });
      } catch {
        // skip unreadable file
      }
    }
    if (accepted.length > 0) setPending((p) => [...p, ...accepted]);
  }

  function removeAttachment(id: string) {
    setPending((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  }

  useEffect(() => {
    const stored = typeof window !== "undefined" ? window.localStorage.getItem(SELECTED_WORKSPACE_KEY) : null;
    if (stored) setSelectedWorkspaceId(stored);
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch("/api/workspaces", { cache: "no-store" });
        const json = await res.json();

        if (cancelled) return;

        if (!res.ok) {
          setWorkspaceError(json.error ?? "Failed to load workspaces");
        } else {
          const list: Workspace[] = json.workspaces ?? [];
          setWorkspaces(list);

          const stored = typeof window !== "undefined" ? window.localStorage.getItem(SELECTED_WORKSPACE_KEY) : null;
          const storedExists = stored && list.some((w) => w.id === stored);

          if (storedExists) setSelectedWorkspaceId(stored);
          else if (list.length === 1) selectWorkspace(list[0].id);
        }
      } catch (error) {
        if (!cancelled) setWorkspaceError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) setWorkspaceLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, streamStatus]);

  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = "auto";
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
  }, [input]);

  function selectWorkspace(id: string) {
    setSelectedWorkspaceId(id);
    setMobileSidebarOpen(false);
    if (typeof window !== "undefined") window.localStorage.setItem(SELECTED_WORKSPACE_KEY, id);
  }

  async function sendMessage(rawText?: string) {
    const trimmed = (rawText ?? input).trim();
    const attachmentsForSend = pending;
    if ((!trimmed && attachmentsForSend.length === 0) || sending) return;

    const userMessage: Message = {
      role: "user",
      content: trimmed,
      attachments: attachmentsForSend.length > 0 ? attachmentsForSend : undefined
    };
    const assistantMessage: Message = { role: "assistant", content: "", tools: [] };
    const nextMessages = [...messages, userMessage];

    setMessages([...nextMessages, assistantMessage]);
    setInput("");
    setPending([]);
    setSending(true);
    setStreamStatus("Thinking");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages.map((m) => ({
            role: m.role,
            content: m.content,
            attachments: m.attachments?.map((a) => ({ mimeType: a.mimeType, dataBase64: a.dataBase64 }))
          })),
          workspaceId: selectedWorkspaceId ?? undefined
        })
      });

      if (!res.ok || !res.body) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;

          const json = line.slice(5).trim();
          if (!json) continue;

          try {
            applyEvent(JSON.parse(json) as StreamEvent);
          } catch {
            // ignore malformed streaming chunks
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last && last.role === "assistant") {
          last.content = (last.content + `\n\n${message}`).trim();
        }
        return copy;
      });
    } finally {
      setSending(false);
      setStreamStatus(null);
    }
  }

  function applyEvent(event: StreamEvent) {
    if (event.type === "thinking") {
      setStreamStatus(event.iteration === 0 ? "Thinking" : `Reasoning · step ${event.iteration + 1}`);
      return;
    }

    if (event.type === "tool_call") {
      setStreamStatus(`Calling ${event.name}`);
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last?.role === "assistant") {
          last.tools = [...(last.tools ?? []), { kind: "call", name: event.name, args: event.args }];
        }
        return copy;
      });
      return;
    }

    if (event.type === "tool_result") {
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last?.role === "assistant") {
          last.tools = [...(last.tools ?? []), { kind: "result", name: event.name, data: event.data }];
        }
        return copy;
      });
      return;
    }

    if (event.type === "tool_error") {
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last?.role === "assistant") {
          last.tools = [...(last.tools ?? []), { kind: "error", name: event.name, error: event.error }];
        }
        return copy;
      });
      return;
    }

    if (event.type === "text") {
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last?.role === "assistant") {
          last.content = last.content ? `${last.content}\n\n${event.content}` : event.content;
        }
        return copy;
      });
      setStreamStatus(null);
      return;
    }

    if (event.type === "error") {
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last?.role === "assistant") {
          last.content = (last.content + `\n\n${event.error}`).trim();
        }
        return copy;
      });
      setStreamStatus(null);
      return;
    }

    if (event.type === "done") setStreamStatus(null);
  }

  const selectedWorkspace = useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspaceId) ?? null,
    [workspaces, selectedWorkspaceId]
  );

  const canSend = !sending && (input.trim().length > 0 || pending.length > 0) && !!selectedWorkspaceId;

  return (
    <div className="relative h-[100dvh] w-screen overflow-hidden bg-canvas text-ink">
      {mobileSidebarOpen ? (
        <button
          type="button"
          aria-label="Close sidebar"
          onClick={() => setMobileSidebarOpen(false)}
          className="fixed inset-0 z-30 bg-ink/15 backdrop-blur-[2px] lg:hidden"
        />
      ) : null}

      <div className="relative flex h-full min-h-0">
        <Sidebar
          workspaces={workspaces}
          loading={workspaceLoading}
          error={workspaceError}
          selectedId={selectedWorkspaceId}
          onSelect={selectWorkspace}
          mobileOpen={mobileSidebarOpen}
          onClose={() => setMobileSidebarOpen(false)}
        />

        <main className="flex min-w-0 flex-1 flex-col bg-surface">
          <TopBar
            selectedWorkspace={selectedWorkspace}
            streamStatus={streamStatus}
            onOpenSidebar={() => setMobileSidebarOpen(true)}
          />

          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
            {messages.length === 0 ? (
              <EmptyState selectedWorkspace={selectedWorkspace} onPickPrompt={(p) => sendMessage(p)} />
            ) : (
              <div className="mx-auto w-full max-w-3xl px-6 py-10 sm:px-8">
                <div className="space-y-8">
                  {messages.map((m, idx) => (
                    <MessageView key={idx} message={m} />
                  ))}
                  {streamStatus && messages.length > 0 ? <ThinkingIndicator label={streamStatus} /> : null}
                </div>
              </div>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = "";
            }}
          />

          {messages.length > 0 && input.length === 0 && pending.length === 0 ? (
            <QuickPrompts
              onPick={(body) => sendMessage(body)}
              disabled={!selectedWorkspaceId || sending}
            />
          ) : null}

          <Composer
            input={input}
            setInput={setInput}
            onSend={() => sendMessage()}
            disabled={sending || !selectedWorkspaceId}
            canSend={canSend}
            placeholder={selectedWorkspace ? "Message Publer Pilot" : "Pick a workspace to start"}
            textareaRef={textareaRef}
            pending={pending}
            onRemoveAttachment={removeAttachment}
            onAttachClick={() => fileInputRef.current?.click()}
            canAttach={pending.length < MAX_ATTACHMENTS && !sending && !!selectedWorkspaceId}
          />
        </main>
      </div>
    </div>
  );
}

function QuickPrompts({ onPick, disabled }: { onPick: (body: string) => void; disabled: boolean }) {
  return (
    <div className="border-t border-hairline bg-surface px-4 pt-3 sm:px-6">
      <div className="mx-auto w-full max-w-3xl">
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {QUICK_PROMPTS.map((qp) => (
            <button
              key={qp.label}
              type="button"
              disabled={disabled}
              onClick={() => onPick(qp.body)}
              className="shrink-0 rounded-full border border-hairline bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:border-line hover:bg-soft hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              {qp.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function TopBar({
  selectedWorkspace,
  streamStatus,
  onOpenSidebar
}: {
  selectedWorkspace: Workspace | null;
  streamStatus: string | null;
  onOpenSidebar: () => void;
}) {
  return (
    <header className="sticky top-0 z-20 h-14 border-b border-hairline bg-surface/80 px-4 backdrop-blur-xl sm:px-6">
      <div className="mx-auto flex h-full w-full max-w-5xl items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={onOpenSidebar}
            className="-ml-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-2 transition-colors hover:bg-soft hover:text-ink lg:hidden"
            aria-label="Open sidebar"
          >
            <MenuIcon />
          </button>
          <div className="min-w-0">
            <div className="truncate text-[14px] font-semibold tracking-[-0.01em] text-ink">
              {selectedWorkspace ? selectedWorkspace.name : "Select a workspace"}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          {streamStatus ? (
            <div className="flex items-center gap-2 text-[12.5px] text-ink-2">
              <ThinkingDots />
              <span className="hidden sm:inline">{streamStatus}</span>
            </div>
          ) : (
            <span className="text-[12.5px] text-ink-3">Ready</span>
          )}
        </div>
      </div>
    </header>
  );
}

function Sidebar({
  workspaces,
  loading,
  error,
  selectedId,
  onSelect,
  mobileOpen,
  onClose
}: {
  workspaces: Workspace[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  mobileOpen: boolean;
  onClose: () => void;
}) {
  return (
    <aside
      className={`fixed inset-y-0 left-0 z-40 flex w-[80vw] max-w-[300px] shrink-0 flex-col border-r border-hairline bg-canvas transition-transform duration-200 ease-out lg:static lg:z-auto lg:w-[260px] lg:max-w-none lg:translate-x-0 ${
        mobileOpen ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <div className="flex h-14 items-center justify-between border-b border-hairline px-4 pt-[env(safe-area-inset-top)]">
        <div className="flex items-center gap-2.5">
          <Mark />
          <div className="text-[14px] font-semibold tracking-[-0.01em] text-ink">Publer Pilot</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="-mr-1.5 flex h-8 w-8 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-soft hover:text-ink-2 lg:hidden"
          aria-label="Close sidebar"
        >
          <CloseIcon />
        </button>
      </div>

      <div className="flex items-center justify-between px-5 pb-2 pt-5">
        <div className="text-[11.5px] font-medium uppercase tracking-[0.04em] text-ink-3">Workspaces</div>
        <div className="text-[12px] tabular-nums text-ink-4">{workspaces.length || "—"}</div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {loading ? (
          <SidebarSkeleton />
        ) : error ? (
          <div className="mx-3 mt-2 rounded-md border border-error/15 bg-error-soft px-3 py-2.5 text-[13px] leading-snug text-error">
            {error}
          </div>
        ) : workspaces.length === 0 ? (
          <div className="px-5 py-6 text-[13px] text-ink-3">No workspaces found.</div>
        ) : (
          <ul className="space-y-0.5">
            {workspaces.map((ws) => {
              const active = ws.id === selectedId;
              return (
                <li key={ws.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(ws.id)}
                    className={`group flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors duration-100 ${
                      active ? "bg-fill-2 text-ink" : "text-ink-2 hover:bg-soft"
                    }`}
                  >
                    <Avatar name={ws.name} src={ws.picture} active={active} />
                    <div className="min-w-0 flex-1">
                      <div className={`truncate text-[13.5px] ${active ? "font-semibold text-ink" : "font-medium text-ink"}`}>
                        {ws.name}
                      </div>
                      <div className="mt-0.5 truncate text-[11.5px] text-ink-3">
                        {ws.plan ?? ws.role ?? "Workspace"}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      <div className="border-t border-hairline px-5 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <div className="flex items-center gap-2 text-[12px] text-ink-2">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-success opacity-40 blur-[2px]" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
          </span>
          MCP connected
        </div>
      </div>
    </aside>
  );
}

function SidebarSkeleton() {
  return (
    <ul className="space-y-1 px-1">
      {Array.from({ length: 5 }).map((_, i) => (
        <li key={i} className="flex items-center gap-3 rounded-md px-2.5 py-2">
          <div className="h-8 w-8 animate-pulse rounded-md bg-soft" />
          <div className="flex-1 space-y-1.5">
            <div className="h-2.5 w-2/3 animate-pulse rounded bg-soft" />
            <div className="h-2 w-1/3 animate-pulse rounded bg-soft" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function Avatar({ name, src, active }: { name: string; src?: string; active: boolean }) {
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" className="h-8 w-8 rounded-md object-cover" />;
  }

  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div
      className={`flex h-8 w-8 items-center justify-center rounded-md text-[11px] font-semibold ${
        active ? "bg-ink text-surface" : "bg-fill text-ink-2"
      }`}
    >
      {initials || "P"}
    </div>
  );
}

function EmptyState({
  selectedWorkspace,
  onPickPrompt
}: {
  selectedWorkspace: Workspace | null;
  onPickPrompt: (prompt: string) => void;
}) {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center px-6 py-16 sm:px-8 sm:py-24">
      <div className="animate-fade-up">
        <h1 className="text-[40px] font-semibold leading-[1.05] tracking-[-0.035em] text-ink sm:text-[52px]">
          How can I help today?
        </h1>
        <p className="mt-4 max-w-xl text-[16px] leading-relaxed text-ink-2">
          {selectedWorkspace
            ? `Working in ${selectedWorkspace.name}. Plan campaigns, draft posts, schedule, and verify — from one prompt.`
            : "Choose a workspace to start. Plan campaigns, draft posts, schedule, and verify — from one prompt."}
        </p>

        <div className="mt-10 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {STARTER_PROMPTS.map((p) => (
            <button
              key={p.title}
              type="button"
              disabled={!selectedWorkspace}
              onClick={() => onPickPrompt(p.body)}
              className="group rounded-lg border border-hairline bg-surface p-4 text-left transition-all duration-150 hover:border-line hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-hairline disabled:hover:shadow-none"
            >
              <div className="text-[11.5px] font-medium uppercase tracking-[0.04em] text-ink-3">{p.eyebrow}</div>
              <div className="mt-1.5 text-[14px] font-semibold tracking-[-0.005em] text-ink">{p.title}</div>
              <div className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{p.body}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function MessageView({ message }: { message: Message }) {
  if (message.role === "user") {
    const hasAttachments = (message.attachments?.length ?? 0) > 0;
    return (
      <div className="flex justify-end">
        <div className="flex max-w-[85%] flex-col items-end gap-1.5 sm:max-w-[78%]">
          {hasAttachments ? (
            <div className="flex flex-wrap justify-end gap-1.5">
              {message.attachments!.map((att) => (
                <div
                  key={att.id}
                  className="h-20 w-20 overflow-hidden rounded-lg border border-hairline bg-soft sm:h-24 sm:w-24"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={att.previewUrl} alt={att.name} className="h-full w-full object-cover" />
                </div>
              ))}
            </div>
          ) : null}
          {message.content ? (
            <div className="rounded-2xl rounded-tr-md bg-ink px-4 py-2.5 text-[15px] leading-[1.55] text-surface">
              {message.content}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-3">
      {(message.tools ?? []).map((tool, idx) => (
        <ToolCard key={idx} tool={tool} />
      ))}
      {message.content ? (
        <div className="text-[15px] leading-[1.65] text-ink">{renderInline(message.content)}</div>
      ) : null}
    </div>
  );
}

function renderInline(text: string): React.ReactNode {
  const lines = text.split("\n");

  return lines.map((line, lineIdx) => {
    const bullet = /^\s*[-*]\s+/.test(line);
    const cleaned = bullet ? line.replace(/^\s*[-*]\s+/, "") : line;
    const parts: React.ReactNode[] = [];
    const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = re.exec(cleaned))) {
      if (match.index > lastIndex) parts.push(cleaned.slice(lastIndex, match.index));
      const token = match[0];

      if (token.startsWith("**")) {
        parts.push(
          <strong key={`b-${lineIdx}-${match.index}`} className="font-semibold text-ink">
            {token.slice(2, -2)}
          </strong>
        );
      } else if (token.startsWith("`")) {
        parts.push(
          <code key={`c-${lineIdx}-${match.index}`} className="rounded bg-soft px-1.5 py-0.5 text-[13px] text-ink">
            {token.slice(1, -1)}
          </code>
        );
      } else {
        parts.push(
          <em key={`i-${lineIdx}-${match.index}`} className="italic">
            {token.slice(1, -1)}
          </em>
        );
      }

      lastIndex = match.index + token.length;
    }

    if (lastIndex < cleaned.length) parts.push(cleaned.slice(lastIndex));

    if (bullet) {
      return (
        <div key={lineIdx} className="flex gap-2.5">
          <span className="mt-[10px] inline-flex h-1 w-1 shrink-0 rounded-full bg-ink-3" />
          <div className="flex-1">{parts}</div>
        </div>
      );
    }

    return (
      <div key={lineIdx} className={line.length === 0 ? "h-3" : ""}>
        {parts}
      </div>
    );
  });
}

function ToolCard({ tool }: { tool: ToolEvent }) {
  const config =
    tool.kind === "error"
      ? { label: "Error", dot: "bg-error" }
      : tool.kind === "result"
        ? { label: "Result", dot: "bg-success" }
        : { label: "Call", dot: "bg-ink-3" };

  return (
    <details className="group overflow-hidden rounded-lg border border-hairline bg-softer">
      <summary className="flex cursor-pointer select-none items-center gap-2.5 px-3 py-2 hover:bg-soft">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${config.dot}`} />
        <span className="shrink-0 text-[11px] font-medium uppercase tracking-[0.04em] text-ink-3">
          {config.label}
        </span>
        <span className="truncate font-mono text-[12px] text-ink-2">{tool.name}</span>
        <span className="ml-auto text-[11px] text-ink-3 transition-transform group-open:rotate-180">⌄</span>
      </summary>

      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all border-t border-hairline bg-surface px-3 py-3 font-mono text-[11.5px] leading-relaxed text-ink-2">
        {tool.kind === "call"
          ? JSON.stringify(tool.args ?? {}, null, 2)
          : tool.kind === "result"
            ? JSON.stringify(tool.data, null, 2)
            : tool.error ?? "(unknown error)"}
      </pre>
    </details>
  );
}

function ThinkingIndicator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-[13px] text-ink-2">
      <ThinkingDots />
      <span>{label}</span>
    </div>
  );
}

function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-[3px]">
      <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-ink-3" />
      <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-ink-3" />
      <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-ink-3" />
    </span>
  );
}

function Composer({
  input,
  setInput,
  onSend,
  disabled,
  canSend,
  placeholder,
  textareaRef,
  pending,
  onRemoveAttachment,
  onAttachClick,
  canAttach
}: {
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
  canSend: boolean;
  placeholder: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  pending: Attachment[];
  onRemoveAttachment: (id: string) => void;
  onAttachClick: () => void;
  canAttach: boolean;
}) {
  return (
    <div className="border-t border-hairline bg-surface px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4 sm:px-6 sm:pt-5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSend();
        }}
        className="mx-auto w-full max-w-3xl"
      >
        <div className="group relative overflow-hidden rounded-xl border border-line bg-surface shadow-xs transition-all duration-150 focus-within:border-ink focus-within:shadow-[var(--shadow-focus)]">
          {pending.length > 0 ? (
            <div className="flex flex-wrap gap-2 border-b border-hairline px-2 py-2">
              {pending.map((att) => (
                <AttachmentChip key={att.id} attachment={att} onRemove={() => onRemoveAttachment(att.id)} />
              ))}
            </div>
          ) : null}

          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            rows={1}
            placeholder={placeholder}
            disabled={disabled}
            className="block max-h-[200px] min-h-[44px] w-full resize-none bg-transparent px-3.5 py-3 text-[15px] leading-[1.5] text-ink outline-none placeholder:text-ink-3 disabled:cursor-not-allowed disabled:opacity-60"
          />

          <div className="flex items-center justify-between px-2 pb-1.5">
            <button
              type="button"
              onClick={onAttachClick}
              disabled={!canAttach}
              className="flex h-8 w-8 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-soft hover:text-ink-2 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-3"
              aria-label="Attach image"
              title="Attach image"
            >
              <PaperclipIcon />
            </button>

            <button
              type="submit"
              disabled={!canSend}
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-all duration-100 ${
                canSend
                  ? "bg-ink text-surface hover:bg-ink/90 active:scale-[0.96]"
                  : "bg-fill text-ink-4"
              }`}
              aria-label="Send"
            >
              <SendIcon />
            </button>
          </div>
        </div>

        <div className="mt-2 flex items-center justify-center gap-2 text-[11.5px] text-ink-3">
          <span>Enter to send</span>
          <span className="text-ink-4">·</span>
          <span>Shift + Enter for newline</span>
          <span className="text-ink-4">·</span>
          <span>Images up to 4 MB</span>
        </div>
      </form>
    </div>
  );
}

function AttachmentChip({
  attachment,
  onRemove
}: {
  attachment: Attachment;
  onRemove: () => void;
}) {
  return (
    <div className="group relative h-14 w-14 overflow-hidden rounded-md border border-hairline bg-soft">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={attachment.previewUrl} alt={attachment.name} className="h-full w-full object-cover" />
      <button
        type="button"
        onClick={onRemove}
        className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-ink/85 text-surface shadow-sm transition-transform hover:scale-110"
        aria-label={`Remove ${attachment.name}`}
      >
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
          <path d="M6 6l12 12" />
          <path d="M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}

function Mark() {
  return (
    <div className="flex h-7 w-7 items-center justify-center rounded-md bg-ink">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <path
          d="M5.5 12L10 16.5L18.5 7.5"
          stroke="white"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function SendIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 19V5M12 5L5 12M12 5L19 12"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l8.57-8.57A4 4 0 1117.99 8.84l-8.59 8.57a2 2 0 01-2.83-2.83l8.49-8.49" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </svg>
  );
}
