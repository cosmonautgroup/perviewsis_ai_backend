import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  MessageSquare, Plus, Trash2, Send, Loader2, Download,
  ChevronRight, AlertTriangle, Bell, ExternalLink, Zap,
  Bot, User, Sparkles, RotateCcw, Copy, CheckCheck,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Session {
  id: number;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface StoredMessage {
  id: number;
  sessionId: number;
  role: "user" | "assistant";
  content: string;
  structuredData: StructuredData | null;
  createdAt: string;
}

interface StructuredData {
  answerText: string;
  recommendations: { action: string; link: string }[];
  relatedIncidents: { id: string; title: string; severity: string; status: string }[];
  relatedAlerts: { alertId: string; entity: string; severity: string; status: string }[];
  dashboardLinks: { label: string; href: string }[];
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  structured?: StructuredData | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SEV_CLS: Record<string, string> = {
  Critical: "bg-red-500/10 text-red-400 border-red-500/20",
  Warning: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  Info: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  Low: "bg-green-500/10 text-green-400 border-green-500/20",
};

const QUICK_PROMPTS = [
  { label: "Critical Incidents", prompt: "What are the most critical active incidents right now?" },
  { label: "Top Errors", prompt: "Show me the top errors by occurrence count" },
  { label: "Capacity Risks", prompt: "What are the current capacity risks and infrastructure pressures?" },
  { label: "Recommendations", prompt: "What should I do first to resolve the current issues?" },
  { label: "Service Rankings", prompt: "Which services have the highest risk scores?" },
  { label: "Root Cause", prompt: "What is the root cause of the checkout failures?" },
];

function SeverityBadge({ severity }: { severity: string }) {
  return (
    <Badge className={`text-[10px] border px-1.5 py-0 ${SEV_CLS[severity] ?? "bg-muted text-muted-foreground border-border"}`}>
      {severity}
    </Badge>
  );
}

// ─── Structured data panel ────────────────────────────────────────────────────

function StructuredPanel({ data }: { data: StructuredData }) {
  const hasContent = data.recommendations?.length || data.relatedIncidents?.length ||
    data.relatedAlerts?.length || data.dashboardLinks?.length;
  if (!hasContent) return null;

  return (
    <div className="mt-3 space-y-3">
      {data.relatedIncidents?.length > 0 && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 overflow-hidden">
          <div className="px-3 py-2 border-b border-red-500/15 flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
            <span className="text-xs font-semibold text-red-400">Related Incidents</span>
          </div>
          <div className="divide-y divide-red-500/10">
            {data.relatedIncidents.map((inc, i) => (
              <div key={i} className="px-3 py-2 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <SeverityBadge severity={inc.severity} />
                  <span className="text-xs text-foreground truncate">{inc.title}</span>
                </div>
                <Link href={`/incidents/${inc.id}`} className="flex-shrink-0 text-[10px] text-indigo-400 hover:text-indigo-300 flex items-center gap-0.5">
                  View <ExternalLink className="w-2.5 h-2.5" />
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {data.relatedAlerts?.length > 0 && (
        <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 overflow-hidden">
          <div className="px-3 py-2 border-b border-yellow-500/15 flex items-center gap-2">
            <Bell className="w-3.5 h-3.5 text-yellow-400" />
            <span className="text-xs font-semibold text-yellow-400">Related Alerts</span>
          </div>
          <div className="divide-y divide-yellow-500/10">
            {data.relatedAlerts.map((a, i) => (
              <div key={i} className="px-3 py-2 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <SeverityBadge severity={a.severity} />
                  <span className="text-xs text-foreground truncate">{a.entity}</span>
                </div>
                <Link href={`/alerts/${a.alertId}`} className="flex-shrink-0 text-[10px] text-indigo-400 hover:text-indigo-300 flex items-center gap-0.5">
                  View <ExternalLink className="w-2.5 h-2.5" />
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {data.recommendations?.length > 0 && (
        <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 overflow-hidden">
          <div className="px-3 py-2 border-b border-indigo-500/15 flex items-center gap-2">
            <Zap className="w-3.5 h-3.5 text-indigo-400" />
            <span className="text-xs font-semibold text-indigo-400">Recommended Actions</span>
          </div>
          <div className="divide-y divide-indigo-500/10">
            {data.recommendations.map((r, i) => (
              <div key={i} className="px-3 py-2 flex items-start justify-between gap-3">
                <div className="flex items-start gap-2 min-w-0">
                  <span className="text-[10px] font-bold text-indigo-400 mt-0.5 flex-shrink-0">{i + 1}.</span>
                  <span className="text-xs text-foreground leading-relaxed">{r.action}</span>
                </div>
                {r.link && (
                  <Link href={r.link} className="flex-shrink-0 text-[10px] text-indigo-400 hover:text-indigo-300 flex items-center gap-0.5 mt-0.5">
                    Go <ExternalLink className="w-2.5 h-2.5" />
                  </Link>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {data.dashboardLinks?.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {data.dashboardLinks.map((l, i) => (
            <Link key={i} href={l.href}>
              <Badge className="cursor-pointer border border-border bg-muted/30 text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors text-[10px] px-2 py-0.5">
                {l.label} <ChevronRight className="w-2.5 h-2.5 ml-0.5 inline" />
              </Badge>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Message bubble ───────────────────────────────────────────────────────────

function MessageBubble({ msg, onCopy }: { msg: ChatMessage; onCopy: (text: string) => void }) {
  const isUser = msg.role === "user";

  const renderContent = (text: string) => {
    const lines = text.split("\n");
    return lines.map((line, i) => {
      const parts = line.split(/(\*\*[^*]+\*\*)/g);
      const rendered = parts.map((part, j) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={j} className="font-semibold">{part.slice(2, -2)}</strong>;
        }
        return <span key={j}>{part}</span>;
      });
      return (
        <span key={i}>
          {rendered}
          {i < lines.length - 1 && <br />}
        </span>
      );
    });
  };

  if (isUser) {
    return (
      <div className="flex justify-end" data-testid={`message-user-${msg.id}`}>
        <div className="max-w-[75%] bg-indigo-600 text-white rounded-2xl rounded-tr-md px-4 py-3 text-sm leading-relaxed">
          {msg.content}
        </div>
        <div className="w-8 h-8 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center ml-2 flex-shrink-0 self-end">
          <User className="w-4 h-4 text-indigo-400" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2" data-testid={`message-assistant-${msg.id}`}>
      <div className="w-8 h-8 rounded-full bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center flex-shrink-0 self-start mt-1">
        <Bot className="w-4 h-4 text-indigo-400" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="bg-card border border-border rounded-2xl rounded-tl-md px-4 py-3">
          <div className="text-sm text-foreground leading-relaxed">
            {renderContent(msg.content)}
            {msg.streaming && (
              <span className="inline-block w-1.5 h-4 bg-indigo-400 ml-0.5 animate-pulse rounded-sm" />
            )}
          </div>
          {!msg.streaming && msg.structured && (
            <StructuredPanel data={msg.structured} />
          )}
        </div>
        {!msg.streaming && (
          <div className="flex items-center gap-2 mt-1.5 ml-1">
            <button
              onClick={() => onCopy(msg.content)}
              className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
              data-testid={`copy-message-${msg.id}`}
            >
              <Copy className="w-2.5 h-2.5" /> Copy
            </button>
            {msg.structured && (
              <button
                onClick={() => {
                  const blob = new Blob([JSON.stringify(msg.structured, null, 2)], { type: "application/json" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url; a.download = "insight-navigator-response.json"; a.click();
                  URL.revokeObjectURL(url);
                }}
                className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
                data-testid={`download-message-${msg.id}`}
              >
                <Download className="w-2.5 h-2.5" /> Export JSON
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function InsightNavigator() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [copied, setCopied] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── Sessions list ──
  const { data: sessions = [], isLoading: loadingSessions } = useQuery<Session[]>({
    queryKey: ["/api/insight-navigator/sessions"],
  });

  // ── Session messages ──
  const { data: storedMessages, isLoading: loadingMessages } = useQuery<StoredMessage[]>({
    queryKey: ["/api/insight-navigator/sessions", activeSessionId, "messages"],
    queryFn: () => activeSessionId
      ? fetch(`/api/insight-navigator/sessions/${activeSessionId}/messages`).then(r => r.json())
      : Promise.resolve([]),
    enabled: !!activeSessionId,
  });

  // Sync stored messages into local state when session changes
  useEffect(() => {
    if (storedMessages && !isStreaming) {
      setMessages(storedMessages.map(m => ({
        id: String(m.id),
        role: m.role,
        content: m.content,
        structured: m.structuredData as StructuredData | null,
      })));
    }
  }, [storedMessages, activeSessionId]);

  // ── Create session ──
  const createSession = useMutation({
    mutationFn: () => apiRequest("POST", "/api/insight-navigator/sessions").then(r => r.json()),
    onSuccess: (session: Session) => {
      qc.invalidateQueries({ queryKey: ["/api/insight-navigator/sessions"] });
      setActiveSessionId(session.id);
      setMessages([]);
    },
    onError: () => toast({ title: "Error", description: "Could not create session", variant: "destructive" }),
  });

  // ── Delete session ──
  const deleteSession = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/insight-navigator/sessions/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/insight-navigator/sessions"] });
      setActiveSessionId(null);
      setMessages([]);
    },
  });

  // ── Scroll to bottom ──
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Copy handler ──
  const handleCopy = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  // ── Send message ──
  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;

    let sessionId = activeSessionId;

    // Auto-create session if none active
    if (!sessionId) {
      try {
        const res = await fetch("/api/insight-navigator/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include" });
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(errText || "Could not start chat session");
        }
        const session: Session = await res.json();
        if (!session?.id) throw new Error("Session was not created");
        sessionId = session.id;
        setActiveSessionId(session.id);
        qc.invalidateQueries({ queryKey: ["/api/insight-navigator/sessions"] });
      } catch (err: any) {
        toast({
          title: "Error",
          description: err?.message || "Could not start chat session",
          variant: "destructive",
        });
        return;
      }
    }

    const userMsgId = `user-${Date.now()}`;
    const assistantMsgId = `ai-${Date.now()}`;

    setMessages(prev => [
      ...prev,
      { id: userMsgId, role: "user", content: trimmed },
      { id: assistantMsgId, role: "assistant", content: "", streaming: true, structured: null },
    ]);
    setInput("");
    setIsStreaming(true);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const response = await fetch(`/api/insight-navigator/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ message: trimmed }),
        signal: abort.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        let errMsg = "Request failed";
        try {
          const parsed = JSON.parse(errText);
          errMsg = parsed?.error ?? parsed?.message ?? errText ?? errMsg;
        } catch {
          errMsg = errText || errMsg;
        }
        throw new Error(errMsg);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error("No response stream");

      let accumulated = "";
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === "token") {
              accumulated += event.text;
              setMessages(prev => prev.map(m =>
                m.id === assistantMsgId ? { ...m, content: accumulated } : m,
              ));
            } else if (event.type === "done") {
              const structured: StructuredData = event.data;
              setMessages(prev => prev.map(m =>
                m.id === assistantMsgId ? {
                  ...m,
                  content: structured.answerText ?? accumulated,
                  streaming: false,
                  structured,
                } : m,
              ));
              qc.invalidateQueries({ queryKey: ["/api/insight-navigator/sessions"] });
              qc.invalidateQueries({ queryKey: ["/api/insight-navigator/sessions", sessionId, "messages"] });
            } else if (event.type === "error") {
              setMessages(prev => prev.map(m =>
                m.id === assistantMsgId ? { ...m, content: event.message, streaming: false, structured: null } : m,
              ));
            }
          } catch { /* ignore malformed SSE */ }
        }
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        setMessages(prev => prev.map(m =>
          m.id === assistantMsgId ? { ...m, content: err.message ?? "Connection error", streaming: false } : m,
        ));
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
      inputRef.current?.focus();
    }
  }, [activeSessionId, isStreaming, qc, toast]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const handleSessionSelect = (id: number) => {
    if (isStreaming) { abortRef.current?.abort(); setIsStreaming(false); }
    setActiveSessionId(id);
    setMessages([]);
  };

  const downloadSession = () => {
    const payload = { sessionId: activeSessionId, messages };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `insight-navigator-session-${activeSessionId}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  const isEmpty = messages.length === 0 && !loadingMessages;

  return (
    <AppLayout>
      <div className="flex h-[calc(100vh-4rem)] -mx-6 -mb-6 overflow-hidden rounded-b-2xl">

        {/* ── Left sidebar: sessions ── */}
        <aside className="w-60 flex-shrink-0 border-r border-border bg-background/50 flex flex-col">
          <div className="p-3 border-b border-border">
            <Button
              size="sm"
              className="w-full bg-indigo-600 hover:bg-indigo-700 text-white text-xs gap-1.5"
              onClick={() => createSession.mutate()}
              disabled={createSession.isPending}
              data-testid="button-new-chat"
            >
              {createSession.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              New Conversation
            </Button>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {loadingSessions ? (
              Array(3).fill(0).map((_, i) => <Skeleton key={i} className="h-10 rounded-lg" />)
            ) : sessions.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-8 px-3">No conversations yet.<br />Start by asking a question.</p>
            ) : (
              sessions.map(s => (
                <div
                  key={s.id}
                  className={`group flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-colors ${
                    activeSessionId === s.id
                      ? "bg-indigo-500/10 border border-indigo-500/20"
                      : "hover:bg-muted/50 border border-transparent"
                  }`}
                  onClick={() => handleSessionSelect(s.id)}
                  data-testid={`session-item-${s.id}`}
                >
                  <MessageSquare className={`w-3.5 h-3.5 flex-shrink-0 ${activeSessionId === s.id ? "text-indigo-400" : "text-muted-foreground"}`} />
                  <div className="flex-1 min-w-0">
                    <p className={`text-xs truncate leading-tight ${activeSessionId === s.id ? "text-foreground font-medium" : "text-muted-foreground"}`}>
                      {s.title}
                    </p>
                    <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                      {formatDistanceToNow(new Date(s.updatedAt), { addSuffix: true })}
                    </p>
                  </div>
                  <button
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-all"
                    onClick={e => { e.stopPropagation(); deleteSession.mutate(s.id); }}
                    data-testid={`delete-session-${s.id}`}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="p-3 border-t border-border">
            <p className="text-[10px] text-muted-foreground text-center leading-relaxed">
              Powered by Ollama AI<br />
              <span className="text-indigo-400">Session context preserved</span>
            </p>
          </div>
        </aside>

        {/* ── Main chat area ── */}
        <div className="flex-1 flex flex-col min-w-0">

          {/* Header */}
          <div className="h-12 border-b border-border px-5 flex items-center justify-between flex-shrink-0 bg-background/80">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
                <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-foreground leading-tight">Insight Navigator AI</h2>
                <p className="text-[10px] text-muted-foreground">Conversational observability intelligence</p>
              </div>
            </div>
            {activeSessionId && messages.length > 0 && (
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost" size="sm"
                  className="text-xs text-muted-foreground hover:text-foreground gap-1.5 h-7"
                  onClick={downloadSession}
                  data-testid="button-download-session"
                >
                  <Download className="w-3.5 h-3.5" /> Export
                </Button>
                <Button
                  variant="ghost" size="sm"
                  className="text-xs text-muted-foreground hover:text-red-400 gap-1.5 h-7"
                  onClick={() => { setMessages([]); setActiveSessionId(null); }}
                  data-testid="button-clear-chat"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> New
                </Button>
              </div>
            )}
          </div>

          {/* Messages or Empty State */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4" data-testid="chat-messages">
            {loadingMessages && activeSessionId ? (
              <div className="space-y-4">
                {Array(3).fill(0).map((_, i) => <Skeleton key={i} className="h-16 rounded-2xl" />)}
              </div>
            ) : isEmpty ? (
              <div className="flex flex-col items-center justify-center h-full text-center pb-16">
                <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mb-4">
                  <Sparkles className="w-8 h-8 text-indigo-400" />
                </div>
                <h3 className="text-lg font-semibold text-foreground mb-2">Ask anything about your platform</h3>
                <p className="text-sm text-muted-foreground max-w-md mb-8">
                  Get instant insights on incidents, errors, capacity risks, and AI-powered recommendations — all grounded in your live observability data.
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-w-xl w-full">
                  {QUICK_PROMPTS.map((qp, i) => (
                    <button
                      key={i}
                      className="text-left p-3 rounded-xl border border-border bg-card hover:border-indigo-500/40 hover:bg-indigo-500/5 transition-all group"
                      onClick={() => sendMessage(qp.prompt)}
                      data-testid={`quick-prompt-${i}`}
                    >
                      <p className="text-xs font-medium text-foreground group-hover:text-indigo-400 transition-colors">{qp.label}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed line-clamp-2">{qp.prompt}</p>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map(msg => (
                <MessageBubble key={msg.id} msg={msg} onCopy={handleCopy} />
              ))
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input bar */}
          <div className="border-t border-border p-3 bg-background/80 flex-shrink-0">
            <div className="flex items-end gap-2 bg-muted/30 border border-border rounded-2xl px-4 py-2 focus-within:border-indigo-500/40 transition-colors">
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about incidents, errors, capacity risks, or any observability question…"
                rows={1}
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground resize-none outline-none leading-relaxed max-h-32 min-h-[1.5rem]"
                style={{ height: "auto" }}
                onInput={e => {
                  const el = e.currentTarget;
                  el.style.height = "auto";
                  el.style.height = Math.min(el.scrollHeight, 128) + "px";
                }}
                disabled={isStreaming}
                data-testid="input-message"
              />
              <button
                onClick={() => sendMessage(input)}
                disabled={!input.trim() || isStreaming}
                className="w-8 h-8 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:bg-muted disabled:cursor-not-allowed flex items-center justify-center flex-shrink-0 transition-colors mb-0.5"
                data-testid="button-send"
              >
                {isStreaming
                  ? <Loader2 className="w-3.5 h-3.5 text-white animate-spin" />
                  : <Send className="w-3.5 h-3.5 text-white" />}
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground text-center mt-1.5">
              Press Enter to send · Shift+Enter for new line · All responses are scoped to your organisation's data
            </p>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
