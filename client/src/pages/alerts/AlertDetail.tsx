import { useMemo, useState } from "react";
import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import CapacityRiskBacklinks from "@/components/capacity/CapacityRiskBacklinks";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Bell, AlertTriangle, BrainCircuit, TrendingUp, ChevronRight,
  ShieldAlert, Link as LinkIcon, Flame, Zap, GitCommit, Terminal,
  Activity, BarChart2, FileText, Wrench, CheckCircle2, Clock
} from "lucide-react";
import { AICorrelationPanel } from "@/components/shared/AICorrelationPanel";
import {
  AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, ComposedChart, Bar
} from "recharts";
import { formatDistanceToNow, format } from "date-fns";

const SEV = { Critical: "bg-red-500/10 text-red-400 border-red-500/20", High: "bg-orange-500/10 text-orange-400 border-orange-500/20", Medium: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20", Low: "bg-blue-500/10 text-blue-400 border-blue-500/20" } as Record<string,string>;
const STATUS = { Active: "bg-red-500/10 text-red-400 border-red-500/20", Acknowledged: "bg-amber-500/10 text-amber-400 border-amber-500/20", Resolved: "bg-green-500/10 text-green-400 border-green-500/20" } as Record<string,string>;
const SRC = { AppDynamics: "bg-indigo-500/10 text-indigo-400 border-indigo-500/20", Dynatrace: "bg-violet-500/10 text-violet-400 border-violet-500/20", OpenTelemetry: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20" } as Record<string,string>;

function Chip({ label, cls }: { label: string; cls: string }) {
  return <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${cls}`}>{label}</span>;
}

const TABS = [
  { id: "overview", label: "Overview", icon: <BarChart2 className="w-3.5 h-3.5" /> },
  { id: "ai", label: "AI Analysis", icon: <BrainCircuit className="w-3.5 h-3.5" /> },
  { id: "transactions", label: "Transactions", icon: <Activity className="w-3.5 h-3.5" /> },
  { id: "metrics", label: "Metrics", icon: <TrendingUp className="w-3.5 h-3.5" /> },
  { id: "logs", label: "Logs", icon: <FileText className="w-3.5 h-3.5" /> },
  { id: "remediation", label: "Remediation", icon: <Wrench className="w-3.5 h-3.5" /> },
];

const LOG_COLORS: Record<string, string> = { ERROR: "text-red-400", WARN: "text-yellow-400", INFO: "text-blue-400", DEBUG: "text-muted-foreground" };

export default function AlertDetail() {
  const { alertId } = useParams<{ alertId: string }>();
  const [tab, setTab] = useState("overview");

  const { data: alert, isLoading: loadingAlert } = useQuery<any>({
    queryKey: [`/api/alerts/${alertId}`],
    queryFn: () => fetch(`/api/alerts/${alertId}`).then(r => r.json()),
  });
  const { data: ai, isLoading: loadingAI } = useQuery<any>({
    queryKey: [`/api/alerts/${alertId}/ai-analysis`],
    queryFn: () => fetch(`/api/alerts/${alertId}/ai-analysis`).then(r => r.json()),
    enabled: !!alertId,
  });
  const { data: related } = useQuery<any>({
    queryKey: [`/api/alerts/${alertId}/related`],
    queryFn: () => fetch(`/api/alerts/${alertId}/related`).then(r => r.json()),
    enabled: !!alertId,
  });

  const txAppId = alert?.applicationId ?? ai?.applicationId ?? null;
  const rootCauseSummary =
    (typeof ai?.primaryRootCause === "string" && ai.primaryRootCause.trim().length > 0
      ? ai.primaryRootCause.trim()
      : "") ||
    (typeof ai?.summary === "string" && ai.summary.trim().length > 0
      ? ai.summary.trim()
      : "") ||
    (typeof alert?.description === "string" && alert.description.trim().length > 0
      ? alert.description.trim()
      : "") ||
    `Alert ${alertId} is active and requires investigation. Review correlated signals and recent changes to confirm the root cause.`;
  const logEntries = useMemo(() => {
    const aiLogs = Array.isArray(ai?.correlatedSignals?.logs) ? ai.correlatedSignals.logs : [];
    const relatedErrorLogs = Array.isArray(related?.errors)
      ? related.errors.slice(0, 4).map((e: any) => ({
          level: "ERROR",
          timestamp: Number(e?.lastSeen ?? Date.now()),
          source: e?.type ?? e?.errorId ?? "Error",
          message: e?.message ?? "Correlated error detected.",
          origin: "Live Context",
        }))
      : [];
    const relatedIncidentLogs = Array.isArray(related?.incidents)
      ? related.incidents.slice(0, 2).map((i: any) => ({
          level: "WARN",
          timestamp: Date.now() - 3 * 60 * 1000,
          source: i?.id ?? "Incident",
          message: `${i?.title ?? "Incident"} is ${String(i?.status ?? "active").toLowerCase()} in the same context.`,
          origin: "Live Context",
        }))
      : [];
    const baseInfoLog = alert?.timestamp
      ? [{
          level: "INFO",
          timestamp: Number(alert.timestamp),
          source: alert?.service ?? alert?.entity ?? "Alert",
          message: `Alert ${alert?.alertId ?? alertId} triggered for ${alert?.rule ?? "rule breach"}.`,
          origin: "Live Context",
        }]
      : [];
    const relatedAlertLogs = Array.isArray(alert?.correlatedAlerts)
      ? alert.correlatedAlerts.slice(0, 3).map((a: any) => ({
          level: "WARN",
          timestamp: Number(alert?.timestamp ?? Date.now()) - 2 * 60 * 1000,
          source: a?.alertId ?? "Correlated Alert",
          message: `Correlated alert ${a?.alertId ?? ""}: ${a?.rule ?? a?.entity ?? "related signal"} (${a?.severity ?? "N/A"}).`,
          origin: "Live Context",
        }))
      : [];
    const merged = [...relatedErrorLogs, ...relatedIncidentLogs, ...relatedAlertLogs, ...baseInfoLog, ...aiLogs]
      .map((l: any) => ({
        level: String(l?.level ?? "INFO").toUpperCase(),
        timestamp: Number(l?.timestamp ?? Date.now()),
        source: String(l?.source ?? "System"),
        message: String(l?.message ?? "No details"),
        origin: String(l?.origin ?? "AI Suggestion"),
      }))
      .filter((l: any) => Number.isFinite(l.timestamp) && l.message.trim().length > 0);
    const seen = new Set<string>();
    const deduped = merged.filter((l: any) => {
      const k = `${l.level}|${l.source}|${l.message}|${Math.floor(l.timestamp / 1000)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return deduped.sort((a: any, b: any) => b.timestamp - a.timestamp).slice(0, 12);
  }, [ai, related, alert, alertId]);

  const remediationImmediate = useMemo(() => {
    const aiImmediate = Array.isArray(ai?.remediationActions?.immediate) ? ai.remediationActions.immediate : [];
    const derived: any[] = [];
    if (Array.isArray(related?.errors) && related.errors.length > 0) {
      derived.push({
        priority: "High",
        effort: "Medium",
        confidence: 84,
        action: `Contain top error path: ${related.errors[0]?.type ?? related.errors[0]?.errorId ?? "Error"}.`,
        impactReduction: 22,
        command: `Investigate ${related.errors[0]?.errorId ?? "error"} and apply targeted retry/timeout guardrails on affected endpoints.`,
        origin: "Live Context",
      });
    }
    if (Array.isArray(related?.incidents) && related.incidents.length > 0) {
      derived.push({
        priority: "High",
        effort: "Low",
        confidence: 81,
        action: `Coordinate with incident ${related.incidents[0]?.id ?? "context"} to prevent escalation overlap.`,
        impactReduction: 18,
        command: `Align remediation timeline with ${related.incidents[0]?.id ?? "incident"} and pause non-critical deploys during mitigation.`,
        origin: "Live Context",
      });
    }
    if (alert?.service || alert?.entity) {
      derived.push({
        priority: "Medium",
        effort: "Low",
        confidence: 76,
        action: `Stabilize ${alert?.service ?? alert?.entity} traffic pattern while alert remains active.`,
        impactReduction: 14,
        command: `Apply temporary rate shaping and retry cap on ${alert?.service ?? alert?.entity}.`,
        origin: "Live Context",
      });
    }
    const normalizedAi = aiImmediate.map((r: any) => ({ ...r, origin: "AI Suggestion" }));
    return [...derived, ...normalizedAi].slice(0, 4);
  }, [ai, related, alert]);

  const remediationLongTerm = useMemo(() => {
    const aiLong = Array.isArray(ai?.remediationActions?.longTerm) ? ai.remediationActions.longTerm : [];
    const derived: any[] = [];
    if (Array.isArray(related?.incidents) && related.incidents.length > 0) {
      derived.push({
        effort: "High",
        confidence: 78,
        action: "Reduce repeat incident pressure with threshold and autoscaling policy tuning.",
        impactReduction: 18,
        detail: `${related.incidents.length} related incident(s) found. Re-baseline thresholds and strengthen dependency resilience for recurring patterns.`,
        origin: "Live Context",
      });
    }
    if (Array.isArray(related?.errors) && related.errors.length > 1) {
      derived.push({
        effort: "Medium",
        confidence: 74,
        action: "Address recurring correlated error signatures with a shared fix pattern.",
        impactReduction: 16,
        detail: `${related.errors.length} correlated error entries detected in this alert context; prioritize top signatures first.`,
        origin: "Live Context",
      });
    }
    const normalizedAi = aiLong.map((r: any) => ({ ...r, origin: "AI Suggestion" }));
    return [...derived, ...normalizedAi].slice(0, 4);
  }, [ai, related]);
  const loading = loadingAlert || loadingAI;

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
          <Link href="/alerts" className="hover:text-foreground transition-colors">Alerts</Link>
          <ChevronRight className="w-3 h-3" />
          <span className="text-foreground font-medium">{alert?.alertId}</span>
        </div>

        {/* ─── Summary Header ─── */}
        <div className="bg-card border border-border rounded-2xl p-6 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <span className="font-mono text-sm text-muted-foreground">{alert?.alertId}</span>
                <Chip label={alert?.severity} cls={SEV[alert?.severity] ?? ""} />
                <Chip label={alert?.status} cls={STATUS[alert?.status] ?? ""} />
                <Chip label={alert?.source} cls={SRC[alert?.source] ?? "bg-muted text-muted-foreground border-border"} />
              </div>
              <h1 className="text-xl font-bold text-foreground">{alert?.rule}</h1>
              <p className="text-sm text-muted-foreground mt-1 max-w-2xl">{alert?.description}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground mb-1">AI Risk Score</p>
              <p className={`text-5xl font-bold font-mono ${(alert?.aiRiskScore ?? 0) > 75 ? "text-red-400" : (alert?.aiRiskScore ?? 0) > 45 ? "text-yellow-400" : "text-green-400"}`}>
                {alert?.aiRiskScore}
              </p>
              <p className="text-xs text-muted-foreground mt-1">Escalation: <strong className={`${(alert?.escalationProbability ?? 0) > 60 ? "text-red-400" : "text-yellow-400"}`}>{alert?.escalationProbability}%</strong></p>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            {[
              { label: "Entity", value: alert?.entity },
              { label: "Service", value: alert?.service },
              { label: "Triggered", value: alert?.timestamp ? formatDistanceToNow(new Date(alert.timestamp), { addSuffix: true }) : "—" },
              { label: "Duration", value: alert?.timestamp ? formatDistanceToNow(new Date(alert.timestamp)) : "—" },
              { label: "SLA Breach Risk", value: `${ai?.impactForecast?.slaBreach ?? 74}%`, bad: true },
              { label: "Escalation Prob.", value: `${alert?.escalationProbability ?? 0}%`, bad: (alert?.escalationProbability ?? 0) > 60 },
            ].map(m => (
              <div key={m.label} className={`rounded-xl border px-4 py-3 ${m.bad ? "border-red-500/20 bg-red-500/5" : "border-border bg-muted/20"}`}>
                <p className="text-[10px] text-muted-foreground mb-1">{m.label}</p>
                <p className={`text-sm font-bold ${m.bad ? "text-red-400" : "text-foreground"}`}>{m.value}</p>
              </div>
            ))}
          </div>

          {/* Linked Incident */}
          {alert?.linkedIncident && (
            <div className="flex flex-wrap items-center gap-3 bg-red-500/5 border border-red-500/20 rounded-xl px-4 py-3">
              <ShieldAlert className="w-4 h-4 text-red-400 shrink-0" />
              <p className="text-sm font-medium text-red-400 flex-1">Linked to active incident: <strong>{alert.linkedIncident}</strong></p>
              <Button variant="outline" size="sm" className="text-red-400 border-red-500/30 shrink-0 h-7 text-xs" asChild>
                <Link href={`/incidents/${alert.linkedIncident}`}>View Incident →</Link>
              </Button>
            </div>
          )}
        </div>

        {/* ─── Tabs ─── */}
        <div className="flex gap-1 flex-wrap border-b border-border pb-0">
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
              {/* Health Rule Details */}
              <Card className="border border-border shadow-sm" data-testid="health-rule-panel">
                <CardHeader className="pb-3 border-b border-border">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-400" /> Health Rule & Trigger Details
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-5 grid grid-cols-2 sm:grid-cols-3 gap-4">
                  {[
                    {
                      label: alert?.alertType === "healthRuleViolation" ? "Health Rule" : "Alert Trigger",
                      value: alert?.alertType === "healthRuleViolation"
                        ? (alert?.healthRuleName ?? ai?.healthRule?.name ?? alert?.rule)
                        : (alert?.rule ?? "Not available"),
                    },
                    ...(alert?.alertType === "healthRuleViolation" && alert?.violationName && alert?.violationName !== (alert?.healthRuleName ?? ai?.healthRule?.name ?? alert?.rule)
                      ? [{ label: "Violation Event", value: alert?.violationName }]
                      : []),
                    ...(alert?.alertType === "healthRuleViolation" && alert?.healthRuleId ? [{ label: "Health Rule ID", value: alert?.healthRuleId }] : []),
                    {
                      label: "Threshold",
                      value: alert?.alertType === "healthRuleViolation"
                        ? (ai?.healthRule?.threshold ?? "> 5% for 5min")
                        : "Not applicable",
                    },
                    {
                      label: "Current Value",
                      value: alert?.alertType === "healthRuleViolation"
                        ? (ai?.healthRule?.metricAtBreach ?? "5.2%")
                        : "Not applicable",
                      bad: alert?.alertType === "healthRuleViolation",
                    },
                    {
                      label: "Baseline",
                      value: alert?.alertType === "healthRuleViolation"
                        ? (ai?.healthRule?.baseline ?? "2.1%")
                        : "Not applicable",
                      good: alert?.alertType === "healthRuleViolation",
                    },
                    { label: "Evaluation Window", value: ai?.healthRule?.evaluationWindow ?? "5 minutes" },
                    { label: "Entity Affected", value: ai?.healthRule?.entity ?? alert?.entity },
                  ].map(f => (
                    <div key={f.label} className={`rounded-lg border px-4 py-3 ${f.bad ? "border-red-500/20 bg-red-500/5" : f.good ? "border-green-500/20 bg-green-500/5" : "border-border bg-muted/10"}`}>
                      <p className="text-[10px] text-muted-foreground mb-1">{f.label}</p>
                      <p className={`text-sm font-bold ${f.bad ? "text-red-400" : f.good ? "text-green-400" : "text-foreground"}`}>{f.value}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>

              {/* Escalation Forecast */}
              <Card className="border border-border shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <TrendingUp className="w-4 h-4 text-purple-400" /> Risk Escalation Forecast
                    <span className="text-xs text-muted-foreground font-normal ml-2">Dashed = AI prediction</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="h-[200px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={alert?.forecastChart ?? []} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                      <defs>
                        <linearGradient id="rGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#6366f1" stopOpacity={0.25} />
                          <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="hour" tickFormatter={v => `${v}h`} stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={false} interval={4} />
                      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={false} domain={[0, 100]} />
                      <Tooltip formatter={(v: any) => [`${Number(v ?? 0).toFixed(1)}`, ""]} />
                      <Area type="monotone" dataKey="upper" fill="#6366f1" fillOpacity={0.1} stroke="transparent" name=" " />
                      <Area type="monotone" dataKey="lower" fill="white" fillOpacity={1} stroke="transparent" name=" " />
                      <Area type="monotone" dataKey="predicted" stroke="#6366f1" strokeWidth={1.5} strokeDasharray="5 3" fill="url(#rGrad)" name="Predicted Risk" dot={false} connectNulls={false} />
                      <Area type="monotone" dataKey="actual" stroke="#ef4444" strokeWidth={2} fill="transparent" name="Actual Risk" dot={false} connectNulls={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* Affected Entities */}
              <Card className="border border-border shadow-sm" data-testid="affected-entities-panel">
                <CardHeader className="pb-3 border-b border-border">
                  <CardTitle className="text-sm font-semibold">Affected Entities</CardTitle>
                </CardHeader>
                <CardContent className="p-4">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {alert?.affectedEntities?.map((e: any) => (
                      <div key={e.name} className={`rounded-lg border px-4 py-3 ${e.status === "Critical" ? "border-red-500/20 bg-red-500/5" : e.status === "Warning" ? "border-yellow-500/20 bg-yellow-500/5" : "border-border bg-muted/10"}`}>
                        <p className="text-[10px] text-muted-foreground mb-1 font-medium">{e.type}</p>
                        {e.link ? <Link href={e.link} className="text-sm font-semibold text-primary hover:underline">{e.name}</Link> : <p className="text-sm font-semibold text-foreground">{e.name}</p>}
                        <p className={`text-xs mt-1 ${e.status === "Critical" ? "text-red-400" : e.status === "Warning" ? "text-yellow-400" : "text-green-400"}`}>{e.status}</p>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Correlated Alerts */}
              {alert?.correlatedAlerts?.length > 0 && (
                <Card className="border border-border shadow-sm" data-testid="correlated-alerts-panel">
                  <CardHeader className="pb-3 border-b border-border">
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <LinkIcon className="w-4 h-4 text-indigo-400" /> Correlated Alerts
                      <Badge className="bg-indigo-500/10 text-indigo-400 border-indigo-500/20 text-xs">Same incident</Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="divide-y divide-border">
                      {alert.correlatedAlerts.map((ca: any) => (
                        <div key={ca.alertId} className="flex items-center justify-between px-5 py-3">
                          <div>
                            <p className="text-xs font-mono text-muted-foreground">{ca.alertId}</p>
                            <p className="text-xs font-medium text-foreground">{ca.entity} — {ca.rule}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Chip label={ca.severity} cls={SEV[ca.severity] ?? ""} />
                            <Link href={`/alerts/${ca.alertId}`} className="text-xs text-primary hover:underline">View →</Link>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Right: AI Summary + Tags */}
            <div className="space-y-5">
              <Card className="border border-indigo-500/25 bg-card shadow-sm">
                <CardHeader className="pb-3 border-b border-indigo-500/10">
                  <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <BrainCircuit className="w-4 h-4 text-indigo-500" /> AI Root Cause Summary
                    <span className="text-[10px] bg-indigo-500/10 text-indigo-600 border border-indigo-500/30 px-1.5 py-0.5 rounded font-bold ml-auto">{Math.round((ai?.confidence ?? 0.92) * 100)}% confidence</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4">
                  <p className="text-sm text-foreground leading-relaxed">{rootCauseSummary}</p>
                  <div className="mt-4 space-y-2">
                    {ai?.contributingFactors?.slice(0, 3)?.map((f: any) => (
                      <div key={f.factor} className="flex items-start gap-2">
                        <div className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${f.severity === "Critical" ? "bg-red-400" : f.severity === "High" ? "bg-orange-400" : "bg-yellow-400"}`} />
                        <p className="text-xs text-muted-foreground">{f.factor}</p>
                      </div>
                    ))}
                  </div>
                  <button onClick={() => setTab("ai")} className="mt-3 text-xs text-indigo-600 hover:underline">Full AI analysis →</button>
                </CardContent>
              </Card>

              {/* Impact Forecast */}
              <Card className="border border-border shadow-sm" data-testid="impact-forecast-panel">
                <CardHeader className="pb-3 border-b border-border">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2"><TrendingUp className="w-4 h-4 text-purple-400" /> Impact Forecast</CardTitle>
                </CardHeader>
                <CardContent className="p-4 space-y-3">
                  {[
                    { label: "Recurrence Probability", value: `${ai?.impactForecast?.recurrenceProbability ?? 78}%`, color: "text-red-400", bar: ai?.impactForecast?.recurrenceProbability ?? 78, barColor: "#ef4444" },
                    { label: "SLA Breach Risk", value: `${ai?.impactForecast?.slaBreach ?? 74}%`, color: "text-orange-400", bar: ai?.impactForecast?.slaBreach ?? 74, barColor: "#f97316" },
                    { label: "Time to Recurrence", value: `${ai?.impactForecast?.hoursToRecurrence ?? 18}h`, color: "text-foreground", bar: 0, barColor: "" },
                    { label: "Users Affected", value: (ai?.impactForecast?.usersAffected ?? 4200).toLocaleString(), color: "text-foreground", bar: 0, barColor: "" },
                  ].map(row => (
                    <div key={row.label}>
                      <div className="flex justify-between mb-1">
                        <p className="text-xs text-muted-foreground">{row.label}</p>
                        <p className={`text-xs font-bold ${row.color}`}>{row.value}</p>
                      </div>
                      {row.bar > 0 && <div className="h-1 bg-muted rounded-full overflow-hidden"><div className="h-full rounded-full" style={{ width: `${row.bar}%`, background: row.barColor }} /></div>}
                    </div>
                  ))}
                </CardContent>
              </Card>

              {/* Tags */}
              <Card className="border border-border shadow-sm">
                <CardHeader className="pb-3"><CardTitle className="text-sm font-semibold">Tags</CardTitle></CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2">
                    {alert?.tags?.map((t: string) => <span key={t} className="text-xs bg-muted/50 border border-border rounded-lg px-3 py-1 text-muted-foreground">{t}</span>)}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        {/* ─── TAB: AI ANALYSIS ─── */}
        {tab === "ai" && (
          <div className="space-y-5">
            {/* Primary Root Cause */}
            <Card className="border border-indigo-500/30 bg-card shadow-sm">
              <CardHeader className="pb-3 border-b border-border">
                <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <BrainCircuit className="w-4 h-4 text-indigo-400" /> Primary Root Cause Hypothesis
                  <span className="ml-auto text-[10px] font-bold px-2 py-0.5 rounded border bg-indigo-500/10 text-indigo-400 border-indigo-500/20">{Math.round((ai?.confidence ?? 0.92) * 100)}% confidence</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-5">
                <p className="text-sm text-foreground leading-relaxed">{rootCauseSummary}</p>
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
                    <div key={f.factor} className={`rounded-xl border px-4 py-3 ${f.severity === "Critical" ? "border-red-500/20 bg-red-500/5" : f.severity === "High" ? "border-orange-500/20 bg-orange-500/5" : "border-yellow-500/20 bg-yellow-500/5"}`}>
                      <div className="flex items-center justify-between mb-1">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${SEV[f.severity] ?? ""}`}>{f.severity}</span>
                        <div className="flex gap-3 text-[10px] text-muted-foreground">
                          <span>Current: <strong className="text-foreground">{f.value}</strong></span>
                          <span>Baseline: <strong className="text-green-400">{f.baseline}</strong></span>
                        </div>
                      </div>
                      <p className="text-xs text-foreground mt-1">{f.factor}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>

              {/* Evidence Used */}
              <Card className="border border-border shadow-sm">
                <CardHeader className="pb-3 border-b border-border">
                  <CardTitle className="text-sm font-semibold">Evidence Used</CardTitle>
                </CardHeader>
                <CardContent className="p-4 space-y-3">
                  {ai?.evidenceUsed?.map((e: any, i: number) => (
                    <div key={i} className="flex items-start gap-3 rounded-lg border border-border bg-muted/10 px-4 py-3">
                      <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${e.icon === "error" ? "bg-red-500/10" : e.icon === "deploy" ? "bg-indigo-500/10" : e.icon === "alert" ? "bg-amber-500/10" : "bg-blue-500/10"}`}>
                        {e.icon === "error" ? <Flame className="w-3.5 h-3.5 text-red-400" /> : e.icon === "deploy" ? <GitCommit className="w-3.5 h-3.5 text-indigo-400" /> : e.icon === "alert" ? <Bell className="w-3.5 h-3.5 text-amber-400" /> : <Activity className="w-3.5 h-3.5 text-blue-400" />}
                      </div>
                      <div>
                        <p className="text-xs font-semibold text-foreground">{e.type}</p>
                        <p className="text-[11px] text-muted-foreground mt-0.5">{e.description}</p>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>

            {/* 7-Step Causal Chain */}
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-3 border-b border-border">
                <CardTitle className="text-sm font-semibold">Causal Chain</CardTitle>
              </CardHeader>
              <CardContent className="p-5 overflow-x-auto">
                <div className="flex items-start gap-3 min-w-max">
                  {ai?.causalChain?.map((step: any, i: number) => (
                    <div key={step.step} className="flex items-start gap-2">
                      <div data-testid={`ai-causal-step-${step.step}`} className="w-44 shrink-0">
                        <div className={`rounded-xl border p-3 ${i === 0 ? "border-green-500/20 bg-green-500/5" : i === (ai.causalChain.length - 1) ? "border-red-500/20 bg-red-500/5" : "border-border bg-muted/10"}`}>
                          <div className="flex items-center gap-1.5 mb-1">
                            <span className="text-[10px] font-mono text-muted-foreground bg-muted/40 px-1.5 rounded">{step.time}</span>
                          </div>
                          <p className="text-xs font-bold text-foreground">{step.event}</p>
                          <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">{step.detail}</p>
                        </div>
                      </div>
                      {i < ai.causalChain.length - 1 && <div className="flex items-center mt-6"><ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" /></div>}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Correlated Signals: Metrics & Logs */}
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-3 border-b border-border">
                <CardTitle className="text-sm font-semibold">Correlated Metric Spikes</CardTitle>
              </CardHeader>
              <CardContent className="p-5">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {ai?.correlatedSignals?.metricSpikes?.map((m: any) => (
                    <div key={m.metric} className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3">
                      <p className="text-[10px] text-muted-foreground mb-1">{m.metric}</p>
                      <p className="text-xl font-bold text-red-400">{m.value}{m.unit}</p>
                      <p className="text-[10px] text-green-400 mt-0.5">Baseline: {m.baseline}{m.unit}</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* ─── TAB: TRANSACTIONS ─── */}
        {tab === "transactions" && (
          <Card className="border border-border shadow-sm">
            <CardHeader className="pb-3 border-b border-border">
              <CardTitle className="text-sm font-semibold">Affected Business Transactions</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-muted-foreground text-xs border-b border-border">
                    <tr>
                      <th className="px-5 py-3 text-left">Transaction</th>
                      <th className="px-5 py-3 text-right">Error Rate</th>
                      <th className="px-5 py-3 text-right">Avg Response</th>
                      <th className="px-5 py-3 text-right">P99</th>
                      <th className="px-5 py-3 text-right">Calls/min</th>
                      <th className="px-5 py-3 text-left">Impact</th>
                      <th className="px-5 py-3 text-left">SLA</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {ai?.affectedTransactions?.map((tx: any) => (
                      <tr key={tx.name} data-testid={`tx-row-${tx.name.replace(/\s+/g, '-').toLowerCase()}`} className="hover:bg-muted/20 transition-colors">
                        <td className="px-5 py-4 font-medium text-foreground">
                          {txAppId ? (
                            <div className="flex items-center gap-2 flex-wrap">
                              <Link href={`/applications/${txAppId}/transactions/${encodeURIComponent(String(tx?.txId ?? tx?.name ?? ""))}`} className="text-primary hover:underline">
                                {tx.name}
                              </Link>
                              <Link href={`/applications/${txAppId}/transactions/${encodeURIComponent(String(tx?.txId ?? tx?.name ?? ""))}`} className="text-[11px] px-1.5 py-0.5 rounded border border-primary/30 text-primary hover:bg-primary/10">
                                Open
                              </Link>
                            </div>
                          ) : (
                            tx.name
                          )}
                        </td>
                        <td className={`px-5 py-4 text-right font-bold font-mono ${tx.errorRate > 3 ? "text-red-400" : tx.errorRate > 1 ? "text-orange-400" : "text-green-400"}`}>{tx.errorRate}%</td>
                        <td className={`px-5 py-4 text-right font-mono ${tx.avgResponseTime > 2000 ? "text-red-400" : tx.avgResponseTime > 800 ? "text-orange-400" : "text-foreground"}`}>{tx.avgResponseTime.toLocaleString()}ms</td>
                        <td className="px-5 py-4 text-right font-mono text-muted-foreground">{tx.p99.toLocaleString()}ms</td>
                        <td className="px-5 py-4 text-right text-muted-foreground">{tx.callsPerMin}/min</td>
                        <td className="px-5 py-4"><Chip label={tx.impactLevel} cls={SEV[tx.impactLevel] ?? "bg-muted text-muted-foreground border-border"} /></td>
                        <td className="px-5 py-4">{tx.slaBreach ? <span className="text-xs text-red-400 font-bold">BREACH</span> : <span className="text-xs text-green-400">OK</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ─── TAB: METRICS ─── */}
        {tab === "metrics" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {[
              { key: "cpu", label: "CPU Usage (%)", color: "#ef4444", threshold: 85 },
              { key: "heap", label: "JVM Heap (%)", color: "#f97316", threshold: 80 },
              { key: "errorRate", label: "Error Rate (%)", color: "#6366f1", threshold: 3 },
              { key: "gcPause", label: "GC Pause (ms)", color: "#8b5cf6", threshold: 500 },
            ].map(m => (
              <Card key={m.key} className="border border-border shadow-sm">
                <CardHeader className="pb-1">
                  <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{m.label}</CardTitle>
                </CardHeader>
                <CardContent className="h-[160px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={ai?.metricsHistory?.[m.key] ?? []} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="ts" tickFormatter={v => format(new Date(v), 'HH:mm')} fontSize={9} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} interval={5} />
                      <YAxis fontSize={9} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} />
                      <Tooltip labelFormatter={v => format(new Date(v), 'HH:mm')} formatter={(v: any) => [Number(v).toFixed(1), m.label]} />
                      <ReferenceLine y={m.threshold} stroke={m.color} strokeDasharray="4 2" label={{ value: `Threshold: ${m.threshold}`, fontSize: 9, fill: m.color }} />
                      <Line type="monotone" dataKey="value" stroke={m.color} strokeWidth={1.5} dot={false} name={m.label} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* ─── TAB: LOGS ─── */}
        {tab === "logs" && (
          <Card className="border border-border shadow-sm">
            <CardHeader className="pb-3 border-b border-border">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <FileText className="w-4 h-4 text-blue-400" /> Correlated Log Entries
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="font-mono text-xs divide-y divide-border">
                {logEntries.map((log: any, i: number) => (
                  <div key={i} data-testid={`log-entry-${i}`} className="px-5 py-3 flex flex-wrap gap-3 hover:bg-muted/20 transition-colors">
                    <span className={`shrink-0 font-bold ${LOG_COLORS[log.level] ?? "text-foreground"}`}>[{log.level}]</span>
                    <span className="text-foreground/80 shrink-0">{format(new Date(log.timestamp), 'HH:mm:ss')}</span>
                    <span className="text-blue-600 shrink-0">{log.source}</span>
                    <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border ${log.origin === "Live Context" ? "text-green-600 border-green-500/30 bg-green-500/10" : "text-indigo-600 border-indigo-500/30 bg-indigo-500/10"}`}>{log.origin}</span>
                    <span className="text-foreground flex-1 min-w-0 break-all">{log.message}</span>
                  </div>
                ))}
                {logEntries.length === 0 && (
                  <div className="px-5 py-6 text-muted-foreground">No correlated logs found for this alert.</div>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* ─── TAB: REMEDIATION ─── */}
        {tab === "remediation" && (
          <div className="space-y-5">
            <div>
              <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2"><Zap className="w-4 h-4 text-amber-400" /> Immediate Actions</h2>
              <div className="space-y-3">
                {remediationImmediate.map((r: any, idx: number) => (
                  <div key={r.action} data-testid={`immediate-action-${idx}`} className={`rounded-xl border p-5 ${r.priority === "Critical" ? "border-red-500/20 bg-red-500/5" : "border-orange-500/20 bg-orange-500/5"}`}>
                    <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <Chip label={r.priority} cls={SEV[r.priority] ?? ""} />
                          <span className="text-xs text-foreground/80">Effort: <strong className="text-foreground">{r.effort}</strong></span>
                          <span className="text-xs text-indigo-600">Confidence: {r.confidence}%</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${r.origin === "Live Context" ? "text-green-600 border-green-500/30 bg-green-500/10" : "text-indigo-600 border-indigo-500/30 bg-indigo-500/10"}`}>{r.origin ?? "AI Suggestion"}</span>
                        </div>
                        <p className="text-sm font-semibold text-foreground">{r.action}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-muted-foreground">Impact Reduction</p>
                        <p className="text-xl font-bold text-green-400">{r.impactReduction}%</p>
                      </div>
                    </div>
                    <div className="bg-muted/30 border border-border rounded-lg px-4 py-3 font-mono text-xs text-foreground">{r.command}</div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2"><Wrench className="w-4 h-4 text-blue-400" /> Long-term Fixes</h2>
              <div className="space-y-3">
                {remediationLongTerm.map((r: any, idx: number) => (
                  <div key={r.action} data-testid={`longterm-action-${idx}`} className="rounded-xl border border-border bg-muted/10 p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3 mb-2">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs text-foreground/80">Effort: <strong className="text-foreground">{r.effort}</strong></span>
                          <span className="text-xs text-indigo-600">Confidence: {r.confidence}%</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${r.origin === "Live Context" ? "text-green-600 border-green-500/30 bg-green-500/10" : "text-indigo-600 border-indigo-500/30 bg-indigo-500/10"}`}>{r.origin ?? "AI Suggestion"}</span>
                        </div>
                        <p className="text-sm font-semibold text-foreground">{r.action}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-muted-foreground">Impact Reduction</p>
                        <p className="text-xl font-bold text-green-400">{r.impactReduction}%</p>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">{r.detail}</p>
                  </div>
                ))}
                {remediationLongTerm.length === 0 && (
                  <div className="rounded-xl border border-border bg-muted/10 p-5 text-xs text-muted-foreground">
                    No long-term remediation suggestions available for this alert context yet.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── AI CORRELATION PANEL ── */}
        {related?.aiCorrelation && <AICorrelationPanel data={related.aiCorrelation} />}

        {/* ── CAPACITY RISK BACKLINKS ── */}
        <CapacityRiskBacklinks entityType="alert" entityId={alertId} />
      </div>
    </AppLayout>
  );
}
