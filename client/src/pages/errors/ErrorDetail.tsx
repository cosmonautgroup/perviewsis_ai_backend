import { useState } from "react";
import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import CapacityRiskBacklinks from "@/components/capacity/CapacityRiskBacklinks";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
  ShieldAlert, BrainCircuit, TrendingUp, ChevronRight, Flame, Database,
  Activity, BarChart2, FileText, GitBranch, Zap, MessageSquare, Server,
  AlertTriangle, Wifi, Clock, Send
} from "lucide-react";
import { CorrelationContextBar } from "@/components/shared/CorrelationContextBar";
import { CorrelationGraph } from "@/components/shared/CorrelationGraph";
import { AICorrelationPanel } from "@/components/shared/AICorrelationPanel";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Cell
} from "recharts";
import { formatDistanceToNow, format } from "date-fns";

const SEV = { Critical: "bg-red-500/10 text-red-400 border-red-500/20", High: "bg-orange-500/10 text-orange-400 border-orange-500/20", Medium: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20", Low: "bg-blue-500/10 text-blue-400 border-blue-500/20" } as Record<string,string>;
const SRC = { AppDynamics: "bg-indigo-500/10 text-indigo-400 border-indigo-500/20", Dynatrace: "bg-violet-500/10 text-violet-400 border-violet-500/20", OpenTelemetry: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20" } as Record<string,string>;

function Chip({ label, cls }: { label: string; cls: string }) {
  return <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${cls}`}>{label}</span>;
}

const NODE_STYLES: Record<string, { bg: string; border: string; icon: any; color: string }> = {
  service: { bg: "bg-indigo-500/10", border: "border-indigo-500/30", icon: <Activity className="w-4 h-4 text-indigo-400" />, color: "text-indigo-400" },
  component: { bg: "bg-red-500/10", border: "border-red-500/30", icon: <Flame className="w-4 h-4 text-red-400" />, color: "text-red-400" },
  database: { bg: "bg-amber-500/10", border: "border-amber-500/30", icon: <Database className="w-4 h-4 text-amber-400" />, color: "text-amber-400" },
  cache: { bg: "bg-green-500/10", border: "border-green-500/30", icon: <Server className="w-4 h-4 text-green-400" />, color: "text-green-400" },
  external: { bg: "bg-blue-500/10", border: "border-blue-500/30", icon: <Wifi className="w-4 h-4 text-blue-400" />, color: "text-blue-400" },
};

const TABS = [
  { id: "overview", label: "Overview", icon: <BarChart2 className="w-3.5 h-3.5" /> },
  { id: "ai", label: "AI Analysis", icon: <BrainCircuit className="w-3.5 h-3.5" /> },
  { id: "cluster", label: "Pattern & Cluster", icon: <Activity className="w-3.5 h-3.5" /> },
  { id: "transactions", label: "Transactions", icon: <FileText className="w-3.5 h-3.5" /> },
  { id: "dependencies", label: "Dependencies", icon: <GitBranch className="w-3.5 h-3.5" /> },
  { id: "forecast", label: "Risk Forecast", icon: <TrendingUp className="w-3.5 h-3.5" /> },
  { id: "debug", label: "AI Debug", icon: <MessageSquare className="w-3.5 h-3.5" /> },
];

export default function ErrorDetail() {
  const { errorId } = useParams<{ errorId: string }>();
  const [tab, setTab] = useState("overview");
  const [debugInput, setDebugInput] = useState("");
  const [debugHistory, setDebugHistory] = useState<{ q: string; a: string }[]>([]);

  const { data: error, isLoading: loadingError } = useQuery<any>({
    queryKey: [`/api/errors/${errorId}`],
    queryFn: () => fetch(`/api/errors/${errorId}`).then(r => r.json()),
    enabled: !!errorId,
  });
  const { data: ai, isLoading: loadingAI } = useQuery<any>({
    queryKey: [`/api/errors/${errorId}/ai-analysis`],
    queryFn: () => fetch(`/api/errors/${errorId}/ai-analysis`).then(r => r.json()),
    enabled: !!errorId,
  });
  const { data: correlated } = useQuery<any>({
    queryKey: [`/api/errors/${errorId}/correlated`],
    queryFn: () => fetch(`/api/errors/${errorId}/correlated`).then(r => r.json()),
    enabled: !!errorId,
  });
  const { data: predictions, isLoading: loadingPred } = useQuery<any>({
    queryKey: [`/api/errors/${errorId}/predictions`],
    queryFn: () => fetch(`/api/errors/${errorId}/predictions`).then(r => r.json()),
    enabled: !!errorId,
  });

  const loading = loadingError;

  function handleDebugSubmit() {
    const q = debugInput.trim();
    if (!q) return;
    const responses = error?.debugAssistant?.responses ?? {};
    const best = Object.keys(responses).find(k => q.toLowerCase().includes(k.toLowerCase().split(" ")[0])) ?? Object.keys(responses)[0];
    const answer = responses[best] ?? "I don't have enough context to answer that specific question. Try asking about the root cause, deployment changes, or similar historical incidents.";
    setDebugHistory(h => [...h, { q, a: answer }]);
    setDebugInput("");
  }

  if (loading) return (
    <AppLayout>
      <div className="space-y-4">{Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-36" />)}</div>
    </AppLayout>
  );

  return (
    <AppLayout>
      <div className="space-y-5">
        {/* Breadcrumb */}
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground flex-wrap">
          <Link href="/errors" className="hover:text-foreground transition-colors">Errors</Link>
          <ChevronRight className="w-3 h-3" />
          <span className="text-foreground font-medium">{error?.errorId}</span>
        </div>

        {/* ── CORRELATION CONTEXT BAR ── */}
        {errorId && <CorrelationContextBar entityId={errorId} entityType="error" />}

        {/* ─── Summary Header ─── */}
        <div className="bg-card border border-border rounded-2xl p-6 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <span className="font-mono text-sm text-muted-foreground">{error?.errorId}</span>
                <Chip label={error?.severity} cls={SEV[error?.severity] ?? ""} />
                <Chip label={error?.source} cls={SRC[error?.source] ?? "bg-muted text-muted-foreground border-border"} />
                {error?.httpCode && <Chip label={`HTTP ${error.httpCode}`} cls="bg-red-500/10 text-red-400 border-red-500/20" />}
              </div>
              <h1 className="text-xl font-bold text-foreground">{error?.type}</h1>
              <p className="font-mono text-sm text-red-400 mt-2 max-w-2xl">{error?.message}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground mb-1">AI Severity Score</p>
              <p className={`text-5xl font-bold font-mono ${(error?.aiSeverityScore ?? 0) > 75 ? "text-red-400" : (error?.aiSeverityScore ?? 0) > 45 ? "text-yellow-400" : "text-green-400"}`}>
                {error?.aiSeverityScore ?? 0}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            {[
              { label: "Service", value: error?.service },
              { label: "Server", value: error?.server },
              { label: "Occurrences", value: error?.count?.toLocaleString(), bad: true },
              { label: "Users Affected", value: error?.userImpactCount?.toLocaleString() },
              { label: "First Seen", value: error?.firstOccurrence ? formatDistanceToNow(new Date(error.firstOccurrence), { addSuffix: true }) : "—" },
              { label: "Duration", value: error?.duration },
            ].map(f => (
              <div key={f.label} className={`rounded-xl border px-4 py-3 ${f.bad ? "border-red-500/20 bg-red-500/5" : "border-border bg-muted/20"}`}>
                <p className="text-[10px] text-muted-foreground mb-1">{f.label}</p>
                <p className={`text-sm font-bold ${f.bad ? "text-red-400" : "text-foreground"}`}>{f.value}</p>
              </div>
            ))}
          </div>

          {/* Cluster + linked incident */}
          <div className="flex flex-wrap gap-3">
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-muted/10 text-xs">
              <GitBranch className="w-3.5 h-3.5 text-indigo-400" />
              <span className="text-muted-foreground">Cluster:</span>
              <span className="font-semibold text-foreground">{error?.cluster?.label ?? error?.clusterId}</span>
              <span className="text-muted-foreground">({Math.round((error?.cluster?.confidence ?? 80))}% match)</span>
            </div>
            {correlated?.linkedIncident && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-red-500/20 bg-red-500/5 text-xs">
                <ShieldAlert className="w-3.5 h-3.5 text-red-400" />
                <span className="text-red-400 font-semibold">Linked Incident: {correlated.linkedIncident}</span>
                <Link href={`/incidents/${correlated.linkedIncident}`} className="text-primary hover:underline">View →</Link>
              </div>
            )}
          </div>
        </div>

        {/* ─── Tabs ─── */}
        <div className="flex gap-1 flex-wrap border-b border-border">
          {TABS.map(t => (
            <button
              key={t.id}
              data-testid={`tab-${t.id}`}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${tab === t.id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            >{t.icon}{t.label}</button>
          ))}
        </div>

        {/* ─── TAB: OVERVIEW ─── */}
        {tab === "overview" && (
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
            <div className="xl:col-span-2 space-y-5">
              {/* Error Details */}
              <Card className="border border-border shadow-sm">
                <CardHeader className="pb-3 border-b border-border">
                  <CardTitle className="text-sm font-semibold">Error Details</CardTitle>
                </CardHeader>
                <CardContent className="p-5 space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { label: "Request Path", value: error?.requestPath ?? error?.businessTransaction ?? "N/A" },
                      { label: "Source System", value: error?.source },
                      { label: "Cluster ID", value: error?.clusterId },
                      { label: "Last Occurrence", value: error?.lastOccurrence ? formatDistanceToNow(new Date(error.lastOccurrence), { addSuffix: true }) : "—" },
                    ].map(f => (
                      <div key={f.label} className="rounded-lg border border-border bg-muted/10 px-4 py-3">
                        <p className="text-[10px] text-muted-foreground mb-1">{f.label}</p>
                        <p className="text-xs font-mono font-medium text-foreground break-all">{f.value}</p>
                      </div>
                    ))}
                  </div>
                  {/* Stack Trace */}
                  {error?.stackTrace && (
                    <div>
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Stack Trace</p>
                      <div className="bg-black/40 border border-border rounded-xl p-4 overflow-x-auto">
                        <pre className="text-xs font-mono text-red-300 leading-relaxed whitespace-pre">{error.stackTrace}</pre>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Frequency Trend */}
              <Card className="border border-border shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Error Frequency — Last 24h</CardTitle>
                </CardHeader>
                <CardContent className="h-[160px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={error?.frequencyHistory ?? []} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="hour" tickFormatter={v => `${v}h`} fontSize={9} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} interval={3} />
                      <YAxis fontSize={9} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} />
                      <Tooltip />
                      <Bar dataKey="count" name="Errors" radius={[2, 2, 0, 0]}>
                        {(error?.frequencyHistory ?? []).map((d: any, i: number) => <Cell key={i} fill={d.isSpike ? "#ef4444" : "#6366f1"} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </div>

            {/* Right: AI Summary + Correlated Alerts */}
            <div className="space-y-5">
              <Card className="border border-indigo-500/30 bg-card shadow-sm">
                <CardHeader className="pb-3 border-b border-border">
                  <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <BrainCircuit className="w-4 h-4 text-indigo-400" /> AI Root Cause
                    <span className="ml-auto text-[10px] font-bold px-2 py-0.5 rounded border bg-indigo-500/10 text-indigo-400 border-indigo-500/20">{ai?.confidence ? Math.round(ai.confidence * 100) : error?.cluster?.confidence}% conf.</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4">
                  <p className="text-sm text-foreground leading-relaxed">{ai?.primaryRootCause}</p>
                  <div className="mt-3 space-y-1">
                    {ai?.contributingFactors?.slice(0, 3).map((f: any) => (
                      <div key={f.factor} className="flex items-start gap-2">
                        <div className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${f.severity === "Critical" ? "bg-red-400" : "bg-orange-400"}`} />
                        <p className="text-xs text-muted-foreground">{f.factor}</p>
                      </div>
                    ))}
                  </div>
                  <button onClick={() => setTab("ai")} className="mt-3 text-xs text-indigo-400 hover:underline">Full analysis →</button>
                </CardContent>
              </Card>

              {/* Correlated Alerts */}
              {correlated?.relatedAlerts?.length > 0 && (
                <Card className="border border-border shadow-sm">
                  <CardHeader className="pb-3 border-b border-border">
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-400" /> Correlated Alerts
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="divide-y divide-border">
                      {correlated.relatedAlerts.map((a: any) => (
                        <div key={a.alertId} className="px-4 py-3 flex items-center justify-between">
                          <div>
                            <p className="text-xs font-mono text-muted-foreground">{a.alertId}</p>
                            <p className="text-xs font-medium text-foreground">{a.rule}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Chip label={a.severity} cls={SEV[a.severity] ?? ""} />
                            <Link href={`/alerts/${a.alertId}`} className="text-xs text-primary hover:underline">View →</Link>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Quick Risk Forecast */}
              <Card className="border border-border shadow-sm">
                <CardHeader className="pb-3 border-b border-border">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2"><TrendingUp className="w-4 h-4 text-purple-400" /> Risk Snapshot</CardTitle>
                </CardHeader>
                <CardContent className="p-4 space-y-3">
                  {[
                    { label: "Escalation to Incident", value: `${Math.round((predictions?.escalationToIncident?.probability ?? 0) * 100)}%`, color: "text-red-400", bar: Math.round((predictions?.escalationToIncident?.probability ?? 0) * 100), barColor: "#ef4444" },
                    { label: "Error Spike (next 30min)", value: `${Math.round((predictions?.errorSpike?.probability ?? 0) * 100)}%`, color: "text-orange-400", bar: Math.round((predictions?.errorSpike?.probability ?? 0) * 100), barColor: "#f97316" },
                    { label: "Downstream Cascade", value: `${Math.round((predictions?.downstreamCascade?.probability ?? 0) * 100)}%`, color: "text-yellow-400", bar: Math.round((predictions?.downstreamCascade?.probability ?? 0) * 100), barColor: "#eab308" },
                  ].map(row => (
                    <div key={row.label}>
                      <div className="flex justify-between mb-1">
                        <p className="text-xs text-muted-foreground">{row.label}</p>
                        <p className={`text-xs font-bold ${row.color}`}>{row.value}</p>
                      </div>
                      <div className="h-1 bg-muted rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${row.bar}%`, background: row.barColor }} />
                      </div>
                    </div>
                  ))}
                  <button onClick={() => setTab("forecast")} className="text-xs text-indigo-400 hover:underline">Full risk forecast →</button>
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        {/* ─── TAB: AI ANALYSIS ─── */}
        {tab === "ai" && (
          <div className="space-y-5">
            <Card className="border border-indigo-500/30 bg-card shadow-sm">
              <CardHeader className="pb-3 border-b border-border">
                <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <BrainCircuit className="w-4 h-4 text-indigo-400" /> Primary Root Cause Hypothesis
                  <span className="ml-auto text-[10px] font-bold px-2 py-0.5 rounded border bg-indigo-500/10 text-indigo-400 border-indigo-500/20">{Math.round((ai?.confidence ?? 0.92) * 100)}% confidence</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-5">
                <p className="text-sm text-foreground leading-relaxed">{ai?.primaryRootCause}</p>
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {/* Contributing Factors */}
              <Card className="border border-border shadow-sm">
                <CardHeader className="pb-3 border-b border-border">
                  <CardTitle className="text-sm font-semibold">Contributing Factors</CardTitle>
                </CardHeader>
                <CardContent className="p-4 space-y-3">
                  {ai?.contributingFactors?.map((f: any) => (
                    <div key={f.factor} className={`rounded-xl border px-4 py-3 flex items-start gap-3 ${f.severity === "Critical" ? "border-red-500/20 bg-red-500/5" : f.severity === "High" ? "border-orange-500/20 bg-orange-500/5" : "border-yellow-500/20 bg-yellow-500/5"}`}>
                      <div className={`w-2 h-2 rounded-full mt-1 shrink-0 ${f.severity === "Critical" ? "bg-red-400" : f.severity === "High" ? "bg-orange-400" : "bg-yellow-400"}`} />
                      <div>
                        <Chip label={f.severity} cls={SEV[f.severity] ?? ""} />
                        <p className="text-xs text-foreground mt-1">{f.factor}</p>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>

              {/* Suggested Actions */}
              <Card className="border border-border shadow-sm">
                <CardHeader className="pb-3 border-b border-border">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2"><Zap className="w-4 h-4 text-amber-400" /> AI Suggested Actions</CardTitle>
                </CardHeader>
                <CardContent className="p-4 space-y-3">
                  {ai?.suggestedActions?.map((action: string, i: number) => (
                    <div key={i} className="flex items-start gap-3 rounded-lg border border-border bg-muted/10 px-4 py-3">
                      <span className="text-xs font-bold text-muted-foreground mt-0.5">{i + 1}.</span>
                      <p className="text-xs text-foreground">{action}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        {/* ─── TAB: CLUSTER & PATTERN ─── */}
        {tab === "cluster" && (
          <div className="space-y-5">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {/* Cluster Info */}
              <Card className="border border-border shadow-sm">
                <CardHeader className="pb-3 border-b border-border">
                  <CardTitle className="text-sm font-semibold">Cluster: {error?.cluster?.label}</CardTitle>
                </CardHeader>
                <CardContent className="p-5 space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Cluster ID:</span>
                    <span className="font-mono text-xs font-bold text-foreground">{error?.clusterId}</span>
                  </div>
                  <div className="bg-muted/30 border border-indigo-500/20 rounded-xl p-4">
                    <p className="text-xs font-semibold text-indigo-400 mb-1">Root Cause Pattern</p>
                    <p className="text-xs text-foreground leading-relaxed">{error?.cluster?.rootCause}</p>
                    <p className="text-xs text-indigo-400 mt-2">{error?.cluster?.confidence}% cluster match</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Similar Errors in Cluster</p>
                    <div className="space-y-2">
                      {error?.cluster?.similarErrors?.map((se: any) => (
                        <div key={se.errorId} className="rounded-lg border border-border bg-muted/10 px-4 py-3">
                          <div className="flex justify-between items-start">
                            <div>
                              <p className="text-xs font-mono font-medium text-foreground">{se.type}</p>
                              <p className="text-[10px] text-muted-foreground mt-0.5 truncate max-w-[250px]">{se.message}</p>
                            </div>
                            <Link href={`/errors/${se.errorId}`} className="text-xs text-primary hover:underline shrink-0 ml-2">View →</Link>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Frequency spike chart */}
              <Card className="border border-border shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Spike Detection — 24h</CardTitle>
                </CardHeader>
                <CardContent className="h-[260px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={error?.frequencyHistory ?? []} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="hour" tickFormatter={v => `${v}h`} fontSize={9} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} interval={3} />
                      <YAxis fontSize={9} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} />
                      <ReferenceLine y={50} stroke="#ef4444" strokeDasharray="4 2" label={{ value: "Spike threshold", fontSize: 9, fill: "#ef4444" }} />
                      <Tooltip />
                      <Bar dataKey="count" name="Error Count" radius={[2, 2, 0, 0]}>
                        {(error?.frequencyHistory ?? []).map((d: any, i: number) => <Cell key={i} fill={d.isSpike ? "#ef4444" : "#6366f1"} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        {/* ─── TAB: TRANSACTIONS ─── */}
        {tab === "transactions" && (
          <Card className="border border-border shadow-sm">
            <CardHeader className="pb-3 border-b border-border">
              <CardTitle className="text-sm font-semibold">Transaction Impact Mapping</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-muted-foreground text-xs border-b border-border">
                    <tr>
                      <th className="px-5 py-3 text-left">Business Transaction</th>
                      <th className="px-5 py-3 text-right">Impacted Calls</th>
                      <th className="px-5 py-3 text-right">Error Rate</th>
                      <th className="px-5 py-3 text-right">P99</th>
                      <th className="px-5 py-3 text-left">Revenue Impact</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {error?.affectedTransactions?.map((tx: any) => (
                      <tr key={tx.name} data-testid={`tx-${tx.name.replace(/\s+/g, '-').toLowerCase()}`} className="hover:bg-muted/20 transition-colors">
                        <td className="px-5 py-4 font-medium text-foreground">{tx.name}</td>
                        <td className="px-5 py-4 text-right font-mono text-foreground">{tx.impactedCalls.toLocaleString()}</td>
                        <td className={`px-5 py-4 text-right font-bold font-mono ${tx.errorRate > 3 ? "text-red-400" : tx.errorRate > 1 ? "text-orange-400" : "text-green-400"}`}>{tx.errorRate}%</td>
                        <td className="px-5 py-4 text-right font-mono text-muted-foreground">{tx.p99.toLocaleString()}ms</td>
                        <td className="px-5 py-4">
                          <span className={`text-xs font-semibold ${tx.revenueImpact.startsWith("High") ? "text-red-400" : tx.revenueImpact.startsWith("Medium") ? "text-orange-400" : "text-green-400"}`}>{tx.revenueImpact}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ─── TAB: DEPENDENCIES ─── */}
        {tab === "dependencies" && (
          <div className="space-y-5">
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-3 border-b border-border">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <GitBranch className="w-4 h-4 text-indigo-400" /> Dependency Failure Map
                </CardTitle>
              </CardHeader>
              <CardContent className="p-6">
                {/* Visual dependency map */}
                <div className="bg-muted/10 border border-border rounded-xl p-6 min-h-[300px] relative">
                  <div className="flex items-center justify-between gap-6 overflow-x-auto pb-4">
                    {/* Error origin */}
                    <div className="flex flex-col items-center gap-2 shrink-0">
                      <div className="px-5 py-3 rounded-xl border-2 border-red-500/50 bg-red-500/10 text-center">
                        <Flame className="w-5 h-5 text-red-400 mx-auto mb-1" />
                        <p className="text-xs font-bold text-red-400">ERROR ORIGIN</p>
                        <p className="text-[10px] text-muted-foreground">SessionManager.java</p>
                      </div>
                    </div>
                    <ChevronRight className="w-5 h-5 text-muted-foreground shrink-0" />
                    {error?.dependencyMap?.map((node: any, idx: number) => {
                      const style = NODE_STYLES[node.type] ?? NODE_STYLES.service;
                      return (
                        <div key={node.id} className="flex items-center gap-3 shrink-0">
                          <div className={`px-4 py-3 rounded-xl border-2 ${node.status === "Critical" ? "border-red-500/50 bg-red-500/10" : node.status === "Warning" ? "border-yellow-500/50 bg-yellow-500/10" : `${style.border} ${style.bg}`} text-center`}>
                            <div className="flex justify-center mb-1">{style.icon}</div>
                            <p className={`text-xs font-bold ${node.status === "Critical" ? "text-red-400" : node.status === "Warning" ? "text-yellow-400" : style.color}`}>{node.label}</p>
                            <p className={`text-[10px] mt-0.5 ${node.status === "Critical" ? "text-red-400" : node.status === "Warning" ? "text-yellow-400" : "text-green-400"}`}>{node.status}</p>
                          </div>
                          {idx < (error?.dependencyMap?.length ?? 0) - 1 && <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Edge latency table */}
                <div className="mt-5">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Connection Latencies</p>
                  <div className="space-y-2">
                    {error?.dependencyEdges?.map((edge: any) => (
                      <div key={`${edge.from}-${edge.to}`} className="flex items-center justify-between rounded-lg border border-border bg-muted/10 px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono text-foreground">{edge.from}</span>
                          <ChevronRight className="w-3 h-3 text-muted-foreground" />
                          <span className="text-xs font-mono text-foreground">{edge.to}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className={`text-xs font-bold font-mono ${edge.status === "Critical" ? "text-red-400" : edge.status === "Warning" ? "text-yellow-400" : "text-green-400"}`}>{edge.latency}</span>
                          <Chip label={edge.status} cls={edge.status === "Critical" ? "bg-red-500/10 text-red-400 border-red-500/20" : edge.status === "Warning" ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/20" : "bg-green-500/10 text-green-400 border-green-500/20"} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* ─── TAB: RISK FORECAST ─── */}
        {tab === "forecast" && (
          <div className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {[
                { label: "Escalation to Incident", value: `${Math.round((predictions?.escalationToIncident?.probability ?? 0) * 100)}%`, sub: predictions?.escalationToIncident?.timeframe ?? "No prediction window", color: "text-red-400", border: "border-red-500/20 bg-red-500/5" },
                { label: "Error Spike", value: `${Math.round((predictions?.errorSpike?.probability ?? 0) * 100)}%`, sub: predictions?.errorSpike?.multiplier ? `${predictions.errorSpike.multiplier} current volume` : "No spike multiplier", color: "text-orange-400", border: "border-orange-500/20 bg-orange-500/5" },
                { label: "Downstream Cascade", value: `${Math.round((predictions?.downstreamCascade?.probability ?? 0) * 100)}%`, sub: (predictions?.downstreamCascade?.services ?? ["No dependent services"]).slice(0, 2).join(", "), color: "text-yellow-400", border: "border-yellow-500/20 bg-yellow-500/5" },
                { label: "Recurrence", value: `${Math.round((predictions?.recurrence?.probability ?? 0) * 100)}%`, sub: `Within ${predictions?.recurrence?.hoursUntil ?? "N/A"}h without fix`, color: "text-purple-400", border: "border-purple-500/20 bg-purple-500/5" },
              ].map(r => (
                <div key={r.label} data-testid={`forecast-${r.label.replace(/\s+/g, '-').toLowerCase()}`} className={`rounded-xl border px-5 py-4 ${r.border}`}>
                  <p className="text-xs text-muted-foreground mb-1">{r.label}</p>
                  <p className={`text-3xl font-bold ${r.color}`}>{r.value}</p>
                  <p className="text-[10px] text-muted-foreground mt-1">{r.sub}</p>
                </div>
              ))}
            </div>

            {/* Forecast Curve */}
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold">Escalation Risk Forecast — Next 24h</CardTitle>
              </CardHeader>
              <CardContent className="h-[240px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={predictions?.forecastCurve ?? []} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="fcGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#ef4444" stopOpacity={0.25} />
                        <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="hour" tickFormatter={v => `${v}h`} fontSize={10} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} interval={3} />
                    <YAxis domain={[0, 100]} tickFormatter={v => `${v}%`} fontSize={10} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} />
                    <Tooltip formatter={(v: any) => [`${Number(v).toFixed(1)}%`, ""]} />
                    <Area type="monotone" dataKey="upper" fill="#ef4444" fillOpacity={0.1} stroke="transparent" name=" " />
                    <Area type="monotone" dataKey="lower" fill="white" fillOpacity={1} stroke="transparent" name=" " />
                    <Area type="monotone" dataKey="predicted" stroke="#ef4444" strokeWidth={2} fill="url(#fcGrad)" name="Escalation Risk" dot={false} />
                    <ReferenceLine y={80} stroke="#f97316" strokeDasharray="4 2" label={{ value: "High Risk", fontSize: 9, fill: "#f97316" }} />
                  </AreaChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>
        )}

        {/* ─── TAB: AI DEBUG ASSISTANT ─── */}
        {tab === "debug" && (
          <div className="space-y-5">
            <Card className="border border-indigo-500/20 bg-indigo-950/20 shadow-sm">
              <CardHeader className="pb-3 border-b border-indigo-500/10">
                <CardTitle className="text-sm font-semibold text-indigo-300 flex items-center gap-2">
                  <MessageSquare className="w-4 h-4" /> AI Debug Assistant
                  <span className="text-xs text-muted-foreground font-normal">Contextual AI for {error?.errorId}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-5 space-y-4">
                {/* Suggested questions */}
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Suggested Questions</p>
                  <div className="flex flex-wrap gap-2">
                    {error?.debugAssistant?.suggestedQuestions?.map((q: string) => (
                      <button key={q} onClick={() => setDebugInput(q)} className="text-xs px-3 py-1.5 rounded-lg border border-indigo-500/30 bg-indigo-500/5 text-indigo-300 hover:bg-indigo-500/10 transition-colors">
                        {q}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Chat history */}
                {debugHistory.length > 0 && (
                  <div className="space-y-4 max-h-[400px] overflow-y-auto">
                    {debugHistory.map((item, i) => (
                      <div key={i} className="space-y-2">
                        <div className="flex justify-end">
                          <div className="max-w-[80%] rounded-xl bg-primary/10 border border-primary/20 px-4 py-3">
                            <p className="text-xs text-primary">{item.q}</p>
                          </div>
                        </div>
                        <div className="flex justify-start">
                          <div className="max-w-[90%] rounded-xl bg-indigo-950/40 border border-indigo-500/20 px-4 py-3">
                            <div className="flex items-center gap-1.5 mb-2">
                              <BrainCircuit className="w-3 h-3 text-indigo-400" />
                              <span className="text-[10px] font-semibold text-indigo-400">Perviewsis</span>
                            </div>
                            <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-line">{item.a}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {debugHistory.length === 0 && (
                  <div className="rounded-xl border border-border bg-muted/10 px-5 py-8 text-center">
                    <BrainCircuit className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                    <p className="text-sm text-muted-foreground">Ask a question to start debugging this error with AI assistance.</p>
                    <p className="text-xs text-muted-foreground mt-1">I have access to error history, deployment metadata, and metric baselines.</p>
                  </div>
                )}

                {/* Input */}
                <div className="flex gap-2">
                  <Input
                    data-testid="debug-input"
                    value={debugInput}
                    onChange={e => setDebugInput(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && handleDebugSubmit()}
                    placeholder='Ask: "Why is this happening?" or "What changed before this error?"'
                    className="text-xs"
                  />
                  <Button data-testid="debug-submit" onClick={handleDebugSubmit} size="sm" className="shrink-0 gap-1.5">
                    <Send className="w-3.5 h-3.5" /> Ask
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* ── CORRELATION GRAPH ── */}
        <div className="flex justify-start">
          {errorId && <CorrelationGraph entityId={errorId} entityType="error" />}
        </div>

                {/* ── AI CORRELATION PANEL ── */}
        {errorId && (() => {
          const linkedIncident = correlated?.linkedIncident;
          const relatedAlerts = correlated?.relatedAlerts ?? [];
          const confidence = Number(ai?.confidence ?? 0.7);
          const aiCorrelation = {
            summary: ai?.summary ?? `Error ${error?.errorId ?? errorId} is correlated with ${relatedAlerts.length} alert(s)${linkedIncident ? ` and incident ${linkedIncident}` : ""}.`,
            confidence,
            strength: Math.round(confidence * 100),
            evidence: [
              { type: "Error Signal", detail: error?.message ?? "No error message available", score: 0.85 },
              { type: "Correlated Alerts", detail: `${relatedAlerts.length} related alert(s) detected`, score: relatedAlerts.length > 0 ? 0.8 : 0.3 },
              ...(linkedIncident ? [{ type: "Incident Link", detail: `Linked incident ${linkedIncident}`, score: 0.9 }] : []),
            ],
            suggestions: [
              ...(linkedIncident ? [{ label: `View Linked Incident ${linkedIncident}`, href: `/incidents/${linkedIncident}` }] : []),
              ...relatedAlerts.slice(0, 2).map((a: any) => ({ label: `Open Alert ${a.alertId}`, href: `/alerts/${a.alertId}` })),
              { label: "Back to Error Dashboard", href: "/errors" },
            ],
          };
          return <AICorrelationPanel data={aiCorrelation} />;
        })()}

        {/* ── CAPACITY RISK BACKLINKS ── */}
        <CapacityRiskBacklinks entityType="error" entityId={errorId} />
      </div>
    </AppLayout>
  );
}

