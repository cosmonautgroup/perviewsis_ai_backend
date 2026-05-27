import { useState } from "react";
import { useParams, Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import CapacityRiskBacklinks from "@/components/capacity/CapacityRiskBacklinks";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  BrainCircuit, AlertTriangle, Server, Database, Clock,
  ChevronRight, CheckCircle2, Flame, ArrowRight, TrendingUp, Zap,
  MessageSquare, Tag, Play, Shield, Activity, MemoryStick, Cpu,
  BarChart2, Eye, RefreshCw, Package, ExternalLink
} from "lucide-react";
import { CorrelationContextBar } from "@/components/shared/CorrelationContextBar";
import { AICorrelationPanel } from "@/components/shared/AICorrelationPanel";
import {
  AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, ReferenceArea
} from "recharts";
import { format, formatDistanceToNow } from "date-fns";

const fmtTime = (v: number) => format(new Date(v), 'HH:mm');

const SEVERITY_CLASSES: Record<string, string> = {
  Critical: "bg-red-500/10 text-red-400 border-red-500/30",
  High: "bg-orange-500/10 text-orange-400 border-orange-500/30",
  Warning: "bg-yellow-500/10 text-yellow-400 border-yellow-500/30",
  Medium: "bg-yellow-500/10 text-yellow-400 border-yellow-500/30",
  Low: "bg-blue-500/10 text-blue-400 border-blue-500/30",
  Open: "bg-red-500/10 text-red-400 border-red-500/30",
  Investigating: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  Resolved: "bg-green-500/10 text-green-400 border-green-500/30",
  "Auto-Remediated": "bg-indigo-500/10 text-indigo-400 border-indigo-500/30",
};

function SeverityBadge({ label }: { label: string }) {
  return <span className={`text-xs font-bold px-2 py-0.5 rounded border ${SEVERITY_CLASSES[label] ?? "bg-muted text-muted-foreground border-border"}`}>{label}</span>;
}

const CAUSAL_COLORS: Record<string, string> = {
  database: "#3b82f6", jvm: "#a855f7", cpu: "#ef4444",
  app: "#f59e0b", service: "#f97316", incident: "#dc2626"
};

function MetricMiniChart({ data, color, label, unit }: { data: any[]; color: string; label: string; unit: string }) {
  const incidentStart = data.find(d => d.anomaly)?.timestamp;
  const hasData = Array.isArray(data) && data.length > 0;
  return (
    <Card className="border border-border shadow-sm">
      <CardHeader className="pb-1 pt-4 px-4">
        <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{label}</CardTitle>
      </CardHeader>
      <CardContent className="px-2 pb-4 h-[130px]">
        {hasData ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 5, right: 5, left: -30, bottom: 0 }}>
              <defs>
                <linearGradient id={`grad-${label}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
              <XAxis dataKey="timestamp" tickFormatter={fmtTime} stroke="hsl(var(--muted-foreground))" fontSize={9} tickLine={false} axisLine={false} interval={8} />
              <YAxis stroke="hsl(var(--muted-foreground))" fontSize={9} tickLine={false} axisLine={false} />
              <Tooltip labelFormatter={v => fmtTime(v)} formatter={(v: any) => [`${Number(v).toFixed(1)}${unit}`]} />
              {incidentStart && <ReferenceLine x={incidentStart} stroke="#ef4444" strokeDasharray="4 2" strokeWidth={1.5} />}
              <Area type="monotone" dataKey="value" stroke={color} strokeWidth={1.5} fill={`url(#grad-${label})`} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-full flex items-center justify-center text-[10px] text-muted-foreground px-4 text-center">
            No incident-scoped metric data
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const TIMELINE_ICONS: Record<string, any> = {
  metric: <Activity className="w-3.5 h-3.5" />,
  detection: <BrainCircuit className="w-3.5 h-3.5" />,
  warning: <AlertTriangle className="w-3.5 h-3.5" />,
  incident: <Flame className="w-3.5 h-3.5" />,
  ai: <BrainCircuit className="w-3.5 h-3.5" />,
  forecast: <TrendingUp className="w-3.5 h-3.5" />,
  brain: <BrainCircuit className="w-3.5 h-3.5" />,
};

const TIMELINE_COLORS: Record<string, string> = {
  metric: "bg-blue-500/10 border-blue-500/20 text-blue-400",
  detection: "bg-indigo-500/10 border-indigo-500/20 text-indigo-400",
  warning: "bg-yellow-500/10 border-yellow-500/20 text-yellow-400",
  incident: "bg-red-500/10 border-red-500/20 text-red-400",
  ai: "bg-indigo-500/10 border-indigo-500/20 text-indigo-400",
  forecast: "bg-purple-500/10 border-purple-500/20 text-purple-400",
};

const PRIORITY_CLASSES: Record<string, string> = {
  Critical: "bg-red-500/10 text-red-400 border-red-500/30",
  High: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  Medium: "bg-yellow-500/10 text-yellow-400 border-yellow-500/30",
};

const CATEGORY_ICON: Record<string, any> = {
  Infra: <Server className="w-3.5 h-3.5" />,
  App: <Activity className="w-3.5 h-3.5" />,
  Service: <Zap className="w-3.5 h-3.5" />,
};

const DRILLDOWN_SECTIONS: Array<{ key: string; label: string; icon: any; tone: string }> = [
  { key: "alerts", label: "Alerts", icon: AlertTriangle, tone: "text-amber-400 border-amber-500/20 bg-amber-500/5" },
  { key: "errors", label: "Errors", icon: Flame, tone: "text-orange-400 border-orange-500/20 bg-orange-500/5" },
  { key: "server_metrics", label: "Server Metrics", icon: Server, tone: "text-blue-400 border-blue-500/20 bg-blue-500/5" },
  { key: "application_metrics", label: "Application Metrics", icon: Activity, tone: "text-indigo-400 border-indigo-500/20 bg-indigo-500/5" },
  { key: "business_transactions", label: "Business Transactions", icon: Zap, tone: "text-green-400 border-green-500/20 bg-green-500/5" },
];

function asRows(value: any): any[] {
  return Array.isArray(value) ? value : [];
}

function briefSignalText(value: any): string {
  if (value == null) return "No details";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const title = value.title ?? value.name ?? value.message ?? value.event ?? value.metricName ?? value.metric_id ?? value.id ?? value.externalId;
  const detail = value.timestamp ?? value.triggeredAt ?? value.startTime ?? value.service ?? value.applicationName ?? value.value ?? value.status;
  return [title, detail].filter(Boolean).join(" · ") || JSON.stringify(value).slice(0, 180);
}

function DrilldownContextPanel({ context }: { context: any }) {
  const hasContext = DRILLDOWN_SECTIONS.some((section) => asRows(context?.[section.key]).length > 0);
  if (!hasContext) return null;

  return (
    <Card className="border border-border shadow-sm">
      <CardHeader className="pb-3 border-b border-border">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Database className="w-4 h-4 text-indigo-400" /> Ollama Drilldown Context
        </CardTitle>
      </CardHeader>
      <CardContent className="p-5 grid grid-cols-1 lg:grid-cols-2 gap-3">
        {DRILLDOWN_SECTIONS.map((section) => {
          const rows = asRows(context?.[section.key]).slice(0, 5);
          if (rows.length === 0) return null;
          const Icon = section.icon;
          return (
            <div key={section.key} className={`rounded-xl border p-3 ${section.tone}`}>
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-1.5">
                  <Icon className="w-3.5 h-3.5" />
                  <p className="text-xs font-bold text-foreground">{section.label}</p>
                </div>
                <Badge className="text-[10px] bg-background/50 border-border">{rows.length}</Badge>
              </div>
              <div className="space-y-1.5">
                {rows.map((row, i) => (
                  <div key={i} className="rounded-lg bg-background/50 border border-border px-3 py-2">
                    <p className="text-xs text-foreground line-clamp-2">{briefSignalText(row)}</p>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

export default function IncidentDetail() {
  const { incidentId } = useParams<{ incidentId: string }>();
  const [note, setNote] = useState("");
  const [showRemediationPreview, setShowRemediationPreview] = useState(false);
  const queryClient = useQueryClient();

  const { data: inc, isLoading } = useQuery<any>({
    queryKey: [`/api/incidents/${incidentId}`],
    queryFn: () => fetch(`/api/incidents/${incidentId}`).then(r => r.json()),
  });

  const { data: related } = useQuery<any>({
    queryKey: [`/api/incidents/${incidentId}/related`],
    queryFn: () => fetch(`/api/incidents/${incidentId}/related`).then(r => r.json()),
    enabled: !!incidentId,
  });

  const addNoteMutation = useMutation({
    mutationFn: async (content: string) => {
      const res = await fetch(`/api/incidents/${incidentId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        let msg = "Failed to add note";
        try {
          const body = await res.json();
          msg = body?.error ?? msg;
        } catch {}
        throw new Error(msg);
      }
      return res.json();
    },
    onSuccess: () => {
      setNote("");
      queryClient.invalidateQueries({ queryKey: [`/api/incidents/${incidentId}`] });
    },
  });

  if (isLoading) return (
    <AppLayout>
      <div className="space-y-4">{Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-40" />)}</div>
    </AppLayout>
  );

  return (
    <AppLayout>
      <div className="space-y-5 max-w-screen-2xl">

        {/* ── CORRELATION CONTEXT BAR ── */}
        {incidentId && (
          <CorrelationContextBar
            entityId={incidentId}
            entityType="incident"
            applicationId={inc?.applicationId ?? inc?.affectedApplications?.[0]?.id ?? null}
            sourceIncidentId={incidentId}
          />
        )}

        {/* ── TOP SUMMARY PANEL ── */}
        <div className="bg-card border border-border rounded-2xl p-6 space-y-4">
          {/* Title row */}
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <span className="font-mono text-sm text-muted-foreground">{inc?.incidentId}</span>
                <SeverityBadge label={inc?.severity} />
                <SeverityBadge label={inc?.status} />
              </div>
              <h1 className="text-2xl font-bold text-foreground">{inc?.title}</h1>
            </div>
            <div className="flex items-center gap-2">
              {inc?.autoRemediation?.available && (
                <Button data-testid="btn-remediate" variant="outline" size="sm" className="text-indigo-400 border-indigo-500/30" onClick={() => setShowRemediationPreview(v => !v)}>
                  <Play className="w-3.5 h-3.5 mr-1.5" /> Execute Remediation
                </Button>
              )}
              <Button variant="outline" size="sm" className="text-muted-foreground">
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Refresh
              </Button>
            </div>
          </div>

          {/* KPI grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 gap-3">
            {([
              { label: "Duration", value: inc?.duration, icon: <Clock className="w-4 h-4 text-muted-foreground" />, unit: "" },
              { label: "AI Confidence", value: `${inc?.confidenceScore}%`, icon: <BrainCircuit className="w-4 h-4 text-indigo-400" />, highlight: true },
              { label: "Start Time", value: inc?.startTime ? formatDistanceToNow(new Date(inc.startTime), { addSuffix: true }) : "—", icon: <Clock className="w-4 h-4 text-muted-foreground" /> },
            ] as Array<{ label: string; value: any; icon: any; unit?: string; highlight?: boolean; bad?: boolean }>).map(m => (
              <div key={m.label} className={`rounded-xl border px-4 py-3 ${m.bad ? "border-red-500/20 bg-red-500/5" : m.highlight ? "border-indigo-500/20 bg-indigo-500/5" : "border-border bg-muted/20"}`}>
                <div className="flex items-center gap-1.5 mb-1">{m.icon}<p className="text-[10px] text-muted-foreground font-medium">{m.label}</p></div>
                <p className={`text-sm font-bold ${m.bad ? "text-red-400" : m.highlight ? "text-indigo-400" : "text-foreground"}`}>{m.value}</p>
              </div>
            ))}
          </div>

          {(inc?.summary || inc?.impactAnalysis) && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {inc?.summary && (
                <div className="rounded-xl border border-border bg-muted/20 px-4 py-3">
                  <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wide mb-1">Summary</p>
                  <p className="text-sm text-foreground leading-relaxed">{inc.summary}</p>
                </div>
              )}
              {inc?.impactAnalysis && (
                <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 px-4 py-3">
                  <p className="text-[10px] text-indigo-400 font-semibold uppercase tracking-wide mb-1">Impact Analysis</p>
                  <p className="text-sm text-foreground leading-relaxed">{inc.impactAnalysis}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── AUTO-REMEDIATION PREVIEW ── */}
        {showRemediationPreview && inc?.autoRemediation && (
          <div className="bg-card border border-indigo-500/30 rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-2">
                <Shield className="w-5 h-5 text-indigo-400" />
                <h2 className="font-bold text-foreground">Auto-Remediation</h2>
                <Badge className="bg-green-500/10 text-green-400 border-green-500/20 text-xs">Ready to Execute</Badge>
              </div>
              <div className="text-xs text-muted-foreground">Type: <strong className="text-foreground">{inc.autoRemediation.type}</strong> · Script: <strong className="text-foreground">{inc.autoRemediation.script}</strong> · Est. Impact Reduction: <strong className="text-foreground">{inc.autoRemediation.estimatedImpactReduction}%</strong></div>
            </div>
            <div className="bg-black/40 rounded-lg p-4 font-mono text-xs text-green-400 border border-green-500/10 whitespace-pre-wrap">
              {inc.autoRemediation.preview}
            </div>
            <div className="flex gap-3">
              <Button size="sm" className="bg-indigo-600 hover:bg-indigo-700 text-white">Confirm & Execute</Button>
              <Button size="sm" variant="outline" onClick={() => setShowRemediationPreview(false)}>Cancel</Button>
            </div>
            <div>
              <p className="text-xs font-semibold text-muted-foreground mb-2">Execution History</p>
              <div className="space-y-1">
                {inc.autoRemediation.history.map((h: any, i: number) => (
                  <div key={i} className="flex items-center gap-3 text-xs text-muted-foreground">
                    <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0" />
                    <span>{format(new Date(h.at), "MMM d HH:mm")}</span>
                    <span className="text-foreground font-medium">{h.action}</span>
                    <span className="text-green-400">{h.result}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
          {/* ── LEFT COLUMN: Scope + RCA ── */}
          <div className="xl:col-span-2 space-y-5">

            {/* Affected Scope */}
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-3 border-b border-border">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-400" /> Affected Scope
                </CardTitle>
              </CardHeader>
              <CardContent className="p-5 grid grid-cols-1 md:grid-cols-3 gap-5">
                {/* Applications */}
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Applications</p>
                  <div className="space-y-2">
                    {inc?.affectedApplications?.map((a: any) => (
                      <Link key={a.id} href={`/applications/${a.id}`}>
                        <div className="flex items-center justify-between rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 hover:border-red-400/40 transition-colors cursor-pointer">
                          <span className="text-xs font-medium text-foreground">{a.name}</span>
                          <span className="text-xs text-red-400 font-mono">{a.errorRateSpike}% err</span>
                        </div>
                      </Link>
                    ))}
                    {(!inc?.affectedApplications || inc.affectedApplications.length === 0) && (
                      <p className="text-xs text-muted-foreground border border-border rounded-lg px-3 py-2 bg-muted/10">No incident-scoped applications.</p>
                    )}
                  </div>
                </div>
                {/* Services */}
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Services</p>
                  <div className="space-y-2">
                    {inc?.affectedServices?.map((s: any) => (
                      <div key={s.name} className={`rounded-lg border px-3 py-2 ${s.severity === "Critical" ? "border-red-500/20 bg-red-500/5" : "border-yellow-500/20 bg-yellow-500/5"}`}>
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium text-foreground">{s.name}</span>
                          <SeverityBadge label={s.severity} />
                        </div>
                        <p className="text-[10px] text-muted-foreground mt-0.5">{(Array.isArray(s.errors) ? s.errors[0] : null) ?? "No error details"}</p>
                        <p className="text-[10px] text-red-400 font-medium">+{s.errorRateDelta}% errors</p>
                      </div>
                    ))}
                    {(!inc?.affectedServices || inc.affectedServices.length === 0) && (
                      <p className="text-xs text-muted-foreground border border-border rounded-lg px-3 py-2 bg-muted/10">No incident-scoped services.</p>
                    )}
                  </div>
                </div>
                {/* Servers */}
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Servers</p>
                  <div className="space-y-2">
                    {inc?.affectedServers?.map((s: any) => (
                      <Link key={s.id} href={`/applications/${inc?.applicationId ?? inc?.affectedApplications?.[0]?.id}/servers/${s.id}`}>
                        <div className={`rounded-lg border px-3 py-2 cursor-pointer hover:border-primary/30 transition-colors ${s.severity === "Critical" ? "border-red-500/20 bg-red-500/5" : "border-yellow-500/20 bg-yellow-500/5"}`}>
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <Server className="w-3 h-3 text-muted-foreground" />
                            <span className="text-xs font-mono font-medium text-foreground">{s.name}</span>
                          </div>
                          {(Array.isArray(s.problems) ? s.problems : []).map((p: string) => (
                            <p key={p} className="text-[10px] text-muted-foreground">· {p}</p>
                          ))}
                        </div>
                      </Link>
                    ))}
                    {(!inc?.affectedServers || inc.affectedServers.length === 0) && (
                      <p className="text-xs text-muted-foreground border border-border rounded-lg px-3 py-2 bg-muted/10">No incident-scoped servers.</p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Root Cause Analysis */}
            <Card className="border border-border shadow-sm overflow-hidden">
              <CardHeader className="pb-3 border-b border-border">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <BrainCircuit className="w-4 h-4 text-indigo-400" /> AI Root Cause Analysis
                  <Badge className="bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 text-xs">{inc?.rootCause?.confidence}% confidence</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-5 space-y-5">
                {/* Hypothesis */}
                <div className="bg-muted/30 border border-indigo-500/20 rounded-xl p-4">
                  <p className="text-xs text-indigo-400 font-semibold uppercase tracking-wide mb-2">Root Cause Hypothesis</p>
                  <p className="text-foreground text-sm leading-relaxed">{inc?.rootCause?.hypothesis}</p>
                </div>

                {/* Causal Chain */}
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Causal Chain</p>
                  <div className="overflow-x-auto pb-2">
                    <div className="flex items-center gap-1" style={{ minWidth: "max-content" }}>
                      {inc?.rootCause?.causalChains?.map((c: any, i: number) => (
                        <div key={c.step} className="flex items-center gap-1">
                          <div data-testid={`causal-step-${c.step}`} className="rounded-lg border px-3 py-2 text-center" style={{ borderColor: CAUSAL_COLORS[c.type] + "40", background: CAUSAL_COLORS[c.type] + "10" }}>
                            <p className="text-[10px] font-semibold whitespace-nowrap" style={{ color: CAUSAL_COLORS[c.type] }}>{c.label}</p>
                            <p className="text-xs font-bold text-foreground whitespace-nowrap">{c.value}</p>
                            <p className="text-[10px] text-red-400 whitespace-nowrap">{c.delta}</p>
                          </div>
                          {i < (inc.rootCause.causalChains.length - 1) && (
                            <ArrowRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                          )}
                        </div>
                      ))}
                      {(!inc?.rootCause?.causalChains || inc.rootCause.causalChains.length === 0) && (
                        <p className="text-xs text-muted-foreground border border-border rounded-lg px-3 py-2 bg-muted/10">
                          No incident-scoped causal chain evidence.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <DrilldownContextPanel context={inc?.drilldownContext} />

            {/* Evidence Metric Charts */}
            <div>
              <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                <BarChart2 className="w-4 h-4 text-muted-foreground" /> Evidence Metrics (Incident Window)
                <span className="text-xs text-muted-foreground font-normal">Red line = incident trigger</span>
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                <MetricMiniChart data={inc?.metrics?.cpu || []} color="#ef4444" label="CPU Usage" unit="%" />
                <MetricMiniChart data={inc?.metrics?.memory || []} color="#6366f1" label="Memory Usage" unit="%" />
                <MetricMiniChart data={inc?.metrics?.errorRate || []} color="#f97316" label="Error Rate" unit="%" />
                <MetricMiniChart data={inc?.metrics?.responseTime || []} color="#f59e0b" label="Response Time" unit="ms" />
                <MetricMiniChart data={inc?.metrics?.throughput || []} color="#22c55e" label="Throughput" unit="" />
              </div>
            </div>

            {/* Affected Transactions */}
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-3 border-b border-border">
                <CardTitle className="text-sm font-semibold">Affected Business Transactions</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-muted-foreground text-xs border-b border-border">
                    <tr>
                      <th className="px-5 py-3 text-left">Transaction</th>
                      <th className="px-5 py-3 text-right">Throughput Drop</th>
                      <th className="px-5 py-3 text-right">Error Spike</th>
                      <th className="px-5 py-3 text-right">Avg Response</th>
                      <th className="px-5 py-3 text-center">SLA</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {inc?.affectedTransactions?.map((tx: any) => (
                      <tr key={tx.id} className="hover:bg-muted/20">
                        <td className="px-5 py-3 font-medium text-foreground">
                          {inc?.applicationId && tx?.id && !String(tx.id).startsWith("tx-") ? (
                            <Link href={`/applications/${inc.applicationId}/transactions/${tx.id}`} className="text-primary hover:underline">
                              {tx.name}
                            </Link>
                          ) : (
                            tx.name
                          )}
                        </td>
                        <td className="px-5 py-3 text-right text-red-400 font-mono font-bold">-{tx.throughputDrop}%</td>
                        <td className="px-5 py-3 text-right font-mono text-red-400">+{tx.errorSpike}%</td>
                        <td className="px-5 py-3 text-right font-mono text-foreground">{tx.avgResponseTime.toLocaleString()}ms</td>
                        <td className="px-5 py-3 text-center">
                          {tx.slaBreach
                            ? <span className="text-xs font-bold text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-0.5 rounded">BREACH</span>
                            : <span className="text-xs text-green-500">OK</span>
                          }
                        </td>
                      </tr>
                    ))}
                    {(!inc?.affectedTransactions || inc.affectedTransactions.length === 0) && (
                      <tr>
                        <td colSpan={5} className="px-5 py-6 text-center text-xs text-muted-foreground">
                          No affected transactions available for this incident.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            {/* Traces */}
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-3 border-b border-border">
                <CardTitle className="text-sm font-semibold">Top Slow Traces</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-muted-foreground text-xs border-b border-border">
                    <tr>
                      <th className="px-5 py-3 text-left">Trace ID</th>
                      <th className="px-5 py-3 text-left">Endpoint</th>
                      <th className="px-5 py-3 text-right">Duration</th>
                      <th className="px-5 py-3 text-right">Spans</th>
                      <th className="px-5 py-3 text-left">Slowest Span</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {inc?.traces?.map((t: any) => (
                      <tr key={t.traceId} className="hover:bg-muted/20">
                        <td className="px-5 py-3 font-mono text-xs text-indigo-400">
                          {inc?.applicationId && t?.txId ? (
                            <Link href={`/applications/${inc.applicationId}/transactions/${t.txId}`} className="text-indigo-400 hover:underline">
                              {t.traceId}
                            </Link>
                          ) : (
                            t.traceId
                          )}
                        </td>
                        <td className="px-5 py-3 font-mono text-xs text-foreground">
                          {inc?.applicationId && t?.txId ? (
                            <Link href={`/applications/${inc.applicationId}/transactions/${t.txId}`} className="hover:underline">
                              {t.name}
                            </Link>
                          ) : (
                            t.name
                          )}
                        </td>
                        <td className="px-5 py-3 text-right font-mono text-red-400 font-bold">{t.duration.toLocaleString()}ms</td>
                        <td className="px-5 py-3 text-right font-mono text-muted-foreground">{t.spanCount}</td>
                        <td className="px-5 py-3 text-xs text-muted-foreground">{t.slowestSpan}</td>
                      </tr>
                    ))}
                    {(!inc?.traces || inc.traces.length === 0) && (
                      <tr>
                        <td colSpan={5} className="px-5 py-6 text-center text-xs text-muted-foreground">
                          No slow traces available for this incident.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </div>

          {/* ── RIGHT COLUMN: Recommendations + Timeline + Notes ── */}
          <div className="space-y-5">

            {/* Forecast Risk */}
            {inc?.forecastRisk && (
              <Card className="border border-purple-500/20 bg-purple-500/5 shadow-sm">
                <CardContent className="p-5">
                  <div className="flex items-center gap-2 mb-3">
                    <TrendingUp className="w-4 h-4 text-purple-400" />
                    <p className="text-sm font-semibold text-purple-300">Recurrence Forecast</p>
                  </div>
                  <p className="text-3xl font-bold text-purple-400 mb-1">{inc.forecastRisk.recurrenceProbability}%</p>
                  <p className="text-xs text-muted-foreground mb-3">chance of recurrence in next 24 hours ({inc.forecastRisk.confidence}% confidence)</p>
                  <p className="text-xs text-muted-foreground mb-2 font-medium">Prevention actions:</p>
                  {inc.forecastRisk.preventionActions.map((a: string) => (
                    <div key={a} className="flex items-start gap-1.5 text-xs text-purple-300 mb-1">
                      <CheckCircle2 className="w-3 h-3 shrink-0 mt-0.5" />{a}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* AI Recommendations */}
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-3 border-b border-border">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <BrainCircuit className="w-4 h-4 text-indigo-400" /> AI Recommendations
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-3">
                {inc?.recommendations?.map((rec: any) => (
                  <div key={rec.id} className={`rounded-xl border p-4 space-y-2 ${PRIORITY_CLASSES[rec.priority]?.includes("red") || rec.priority === "Critical" ? "border-red-500/20 bg-red-500/5" : rec.priority === "High" ? "border-amber-500/20 bg-amber-500/5" : "border-border bg-muted/10"}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`text-xs font-bold px-2 py-0.5 rounded border ${PRIORITY_CLASSES[rec.priority]}`}>{rec.priority}</span>
                        <div className="flex items-center gap-1 text-[10px] text-muted-foreground border border-border rounded px-1.5 py-0.5">
                          {CATEGORY_ICON[rec.category]}{rec.category}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-[10px] text-muted-foreground">Confidence</p>
                        <p className="text-xs font-bold text-foreground">{rec.confidence}%</p>
                      </div>
                    </div>
                    <p className="font-semibold text-sm text-foreground">{rec.title}</p>
                    <p className="text-xs text-muted-foreground leading-relaxed">{rec.description}</p>
                    <div className="bg-muted/30 rounded px-3 py-2 border border-border">
                      <p className="text-[10px] text-muted-foreground font-medium mb-0.5">Rule trigger:</p>
                      <p className="text-xs font-mono text-foreground">{rec.rule}</p>
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                      <span>Effort: <strong>{rec.effort}</strong></span>
                      <span className="text-green-400 font-medium">-{rec.impactReduction}% impact</span>
                    </div>
                    <div className="space-y-1 pt-1">
                      {rec.nextSteps.map((step: string) => (
                        <div key={step} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                          <ChevronRight className="w-3 h-3 shrink-0 mt-0.5 text-primary" />{step}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                {(!inc?.recommendations || inc.recommendations.length === 0) && (
                  <p className="text-xs text-muted-foreground border border-border rounded-lg px-3 py-3 bg-muted/10">
                    No incident-scoped recommendations available.
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Timeline */}
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-3 border-b border-border">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Clock className="w-4 h-4 text-muted-foreground" /> Incident Timeline
                </CardTitle>
              </CardHeader>
              <CardContent className="p-5">
                <div className="relative">
                  <div className="absolute left-3.5 top-0 bottom-0 w-px bg-border" />
                  <div className="space-y-5">
                    {inc?.timeline?.map((ev: any, i: number) => (
                      <div key={i} className="flex gap-4 relative">
                        <div className={`w-7 h-7 rounded-full border flex items-center justify-center shrink-0 z-10 ${TIMELINE_COLORS[ev.type] ?? "bg-muted border-border text-muted-foreground"}`}>
                          {TIMELINE_ICONS[ev.type] ?? TIMELINE_ICONS.metric}
                        </div>
                        <div className="flex-1 pb-1">
                          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                            <p className="text-xs font-mono text-muted-foreground">{format(new Date(ev.at), 'HH:mm:ss')}</p>
                            {ev.type === "incident" && <span className="text-[10px] bg-red-500/10 text-red-400 border border-red-500/20 px-1.5 py-0.5 rounded font-bold">INCIDENT TRIGGER</span>}
                          </div>
                          <p className="text-sm font-semibold text-foreground">{ev.event}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">{ev.detail}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Collaboration Notes */}
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-3 border-b border-border">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-muted-foreground" /> Incident Notes
                </CardTitle>
              </CardHeader>
              <CardContent className="p-5 space-y-4">
                {inc?.notes?.map((n: any) => (
                  <div key={n.id} className="space-y-2">
                    <div className="flex items-center gap-2">
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${n.role === "AI Engine" ? "bg-indigo-500/10 text-indigo-400 border border-indigo-500/20" : "bg-muted text-foreground border border-border"}`}>
                        {n.avatar}
                      </div>
                      <div>
                        <span className="text-xs font-semibold text-foreground">{n.author}</span>
                        <span className="text-[10px] text-muted-foreground ml-2">{n.role} · {formatDistanceToNow(new Date(n.timestamp), { addSuffix: true })}</span>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed ml-9">{n.content}</p>
                    <div className="flex gap-1 ml-9">
                      {n.tags.map((t: string) => (
                        <span key={t} className="text-[10px] bg-muted/50 border border-border rounded px-2 py-0.5 text-muted-foreground flex items-center gap-1">
                          <Tag className="w-2.5 h-2.5" />{t}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
                {(!inc?.notes || inc.notes.length === 0) && (
                  <p className="text-xs text-muted-foreground border border-border rounded-lg px-3 py-3 bg-muted/10">
                    No notes have been added for this incident.
                  </p>
                )}
                {/* Add note */}
                <div className="pt-2 border-t border-border space-y-2">
                  <Textarea
                    data-testid="textarea-note"
                    placeholder="Add an incident note, tag, or observation..."
                    value={note}
                    onChange={e => setNote(e.target.value)}
                    className="text-xs resize-none"
                    rows={3}
                  />
                  <div className="flex justify-end">
                    <Button
                      data-testid="btn-add-note"
                      size="sm"
                      disabled={!note.trim() || addNoteMutation.isPending}
                      onClick={() => {
                        if (!note.trim()) return;
                        addNoteMutation.mutate(note.trim());
                      }}
                    >
                      {addNoteMutation.isPending ? "Posting..." : "Post Note"}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* ── RELATED ALERTS ── */}
        {related?.alerts?.length > 0 && (
          <Card data-testid="related-alerts-section" className="border border-border shadow-sm">
            <CardHeader className="pb-3 border-b border-border">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Flame className="w-4 h-4 text-amber-400" /> Related Alerts
                <Badge className="ml-auto bg-amber-500/10 text-amber-400 border-amber-500/20">{related.alerts.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left text-muted-foreground font-medium px-4 py-2">Alert</th>
                    <th className="text-left text-muted-foreground font-medium px-4 py-2">Rule</th>
                    <th className="text-left text-muted-foreground font-medium px-4 py-2">Severity</th>
                    <th className="text-left text-muted-foreground font-medium px-4 py-2">Source</th>
                    <th className="text-left text-muted-foreground font-medium px-4 py-2">Corr. Score</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {related.alerts.map((a: any) => (
                    <tr key={a.alertId} className="border-b border-border hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-2 font-mono text-muted-foreground">{a.alertId}</td>
                      <td className="px-4 py-2 font-medium">{a.rule ?? a.name}</td>
                      <td className="px-4 py-2"><span className={`px-2 py-0.5 rounded border text-[10px] font-bold ${a.severity === "Critical" ? "bg-red-500/10 text-red-400 border-red-500/20" : "bg-amber-500/10 text-amber-400 border-amber-500/20"}`}>{a.severity}</span></td>
                      <td className="px-4 py-2 text-muted-foreground">{a.source}</td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                            <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${Math.round(a.correlationScore * 100)}%` }} />
                          </div>
                          <span className="text-[10px] text-indigo-400">{Math.round(a.correlationScore * 100)}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <Link href={`/alerts/${a.alertId}`} className="text-indigo-400 hover:text-indigo-300 flex items-center gap-1 whitespace-nowrap">
                          View <ExternalLink className="w-3 h-3" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}

        {/* ── RELATED ERRORS ── */}
        {related?.errors?.length > 0 && (
          <Card data-testid="related-errors-section" className="border border-border shadow-sm">
            <CardHeader className="pb-3 border-b border-border">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Flame className="w-4 h-4 text-orange-400" /> Related Errors
                <Badge className="ml-auto bg-orange-500/10 text-orange-400 border-orange-500/20">{related.errors.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left text-muted-foreground font-medium px-4 py-2">Error ID</th>
                    <th className="text-left text-muted-foreground font-medium px-4 py-2">Message</th>
                    <th className="text-left text-muted-foreground font-medium px-4 py-2">Cluster</th>
                    <th className="text-left text-muted-foreground font-medium px-4 py-2">Occurrences</th>
                    <th className="text-left text-muted-foreground font-medium px-4 py-2">Corr. Score</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {related.errors.map((e: any) => (
                    <tr key={e.errorId} className="border-b border-border hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-2 font-mono text-muted-foreground">{e.errorId}</td>
                      <td className="px-4 py-2 font-medium max-w-xs truncate">{e.message}</td>
                      <td className="px-4 py-2 text-muted-foreground">{e.clusterId ?? "—"}</td>
                      <td className="px-4 py-2">{(e.occurrences || 0).toLocaleString()}</td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                            <div className="h-full bg-orange-500 rounded-full" style={{ width: `${Math.round(e.correlationScore * 100)}%` }} />
                          </div>
                          <span className="text-[10px] text-orange-400">{Math.round(e.correlationScore * 100)}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <Link href={`/errors/${e.errorId}`} className="text-indigo-400 hover:text-indigo-300 flex items-center gap-1 whitespace-nowrap">
                          View <ExternalLink className="w-3 h-3" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}

        {/* ── AFFECTED NODES ── */}
        {related?.nodes?.length > 0 && (
          <Card data-testid="related-nodes-section" className="border border-border shadow-sm">
            <CardHeader className="pb-3 border-b border-border">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Server className="w-4 h-4 text-blue-400" /> Affected Infrastructure
                <Badge className="ml-auto bg-blue-500/10 text-blue-400 border-blue-500/20">{related.nodes.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {related.nodes.map((n: any) => (
                  <Link key={n.nodeId} href={n.href} data-testid={`related-node-${n.nodeId}`} className="block rounded-xl border border-border hover:border-blue-500/30 bg-muted/10 hover:bg-blue-500/5 p-3 transition-colors">
                    <div className="flex items-center gap-2 mb-2">
                      <Server className="w-4 h-4 text-blue-400 shrink-0" />
                      <span className="font-mono text-sm font-bold text-foreground">{n.name}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className={`text-[10px] px-2 py-0.5 rounded border font-bold ${n.status === "Critical" ? "bg-red-500/10 text-red-400 border-red-500/20" : "bg-amber-500/10 text-amber-400 border-amber-500/20"}`}>{n.status}</span>
                      <div className="flex items-center gap-1">
                        <div className="w-12 h-1.5 bg-muted rounded-full overflow-hidden">
                          <div className="h-full bg-blue-500 rounded-full" style={{ width: `${Math.round(n.correlationScore * 100)}%` }} />
                        </div>
                        <span className="text-[10px] text-blue-400">{Math.round(n.correlationScore * 100)}%</span>
                      </div>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1">{n.role} · {n.correlationType}</p>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── RELATED DEPLOYMENT ── */}
        {related?.deployment && (
          <Card data-testid="related-deployment-section" className="border border-purple-500/20 bg-purple-950/10 shadow-sm">
            <CardHeader className="pb-3 border-b border-purple-500/10">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Package className="w-4 h-4 text-purple-400" /> Correlated Deployment
                <Badge className="bg-purple-500/10 text-purple-400 border-purple-500/20 text-[10px]">{Math.round(related.deployment.correlationScore * 100)}% correlated</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <p className="text-xs font-bold text-purple-300">{related.deployment.deploymentId} — {related.deployment.version}</p>
                <div className="text-xs text-muted-foreground space-y-1">
                  <p>Service: <strong className="text-foreground">{related.deployment.service}</strong></p>
                  <p>Author: <strong className="text-foreground">{related.deployment.author}</strong></p>
                  <p>Type: <span className="text-purple-300">{related.deployment.correlationType}</span></p>
                </div>
              </div>
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">Changes in this deploy</p>
                <ul className="space-y-1">
                  {related.deployment.changes.map((c: string, i: number) => (
                    <li key={i} className="text-xs text-muted-foreground flex items-start gap-2">
                      <span className="text-purple-400 shrink-0 mt-0.5">→</span>
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── AI CORRELATION PANEL ── */}
        {related?.aiCorrelation && <AICorrelationPanel data={related.aiCorrelation} />}

        {/* ── CAPACITY RISK BACKLINKS ── */}
        <CapacityRiskBacklinks entityType="incident" entityId={incidentId} />

      </div>
    </AppLayout>
  );
}
