import { useState, useMemo } from "react";
import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Area, AreaChart, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ReferenceLine, ComposedChart, Line,
} from "recharts";
import {
  AlertTriangle, ArrowLeft, Brain, CheckCircle2, ChevronRight,
  Clock, Cpu, Database, HardDrive, Network, Shield, TrendingUp,
  Zap, Activity, Server, Layers, BarChart3, Bell, Bug, GitMerge,
  Info, ArrowRight, Target, ExternalLink,
} from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";

// ─── helpers ────────────────────────────────────────────────────
type Scenario = "optimistic" | "baseline" | "pessimistic";
const SCENARIO_COLORS: Record<Scenario, string> = { optimistic: "#22c55e", baseline: "#6366f1", pessimistic: "#ef4444" };
const METRIC_ICONS: Record<string, any> = { CPU: Cpu, Memory: Database, Disk: HardDrive, Network: Network };
const SEV_STYLES: Record<string, string> = {
  Critical: "bg-red-500/15 text-red-400 border border-red-500/30",
  High:     "bg-orange-500/15 text-orange-400 border border-orange-500/30",
  Medium:   "bg-yellow-500/15 text-yellow-400 border border-yellow-500/30",
  Low:      "bg-green-500/15 text-green-400 border border-green-500/30",
};
const RISK_COLOR = (v: number) => v >= 90 ? "#ef4444" : v >= 70 ? "#f97316" : v >= 45 ? "#eab308" : "#22c55e";
const fmtPct = (v: number) => `${v.toFixed(1)}%`;
const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// ─── shared chart tooltip ───────────────────────────────────────
function ChartTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[#141420] border border-white/10 rounded-lg p-2.5 text-xs space-y-1 shadow-xl">
      <p className="text-slate-400">{typeof label === "number" ? fmtTime(label) : label}</p>
      {payload.map((p: any, i: number) => (
        <p key={i} style={{ color: p.color }}>{p.name}: <strong>{fmtPct(p.value)}</strong></p>
      ))}
    </div>
  );
}

// ─── small forecast chart ───────────────────────────────────────
function ForecastChart({ detail, metric, scenario, threshold }: { detail: any; metric: string; scenario: Scenario; threshold: number }) {
  const mKey = metric.toLowerCase();
  const hist: any[] = detail.historical?.[mKey] ?? [];
  const fcast: any[] = detail.forecast?.[mKey]?.[scenario] ?? [];
  const color = SCENARIO_COLORS[scenario];

  const data = useMemo(() => {
    const h = hist.map((d: any) => ({ ts: d.ts, actual: +d.value.toFixed(1) }));
    const f = fcast.map((d: any) => ({ ts: d.ts, forecast: +d.value.toFixed(1), upper: +d.upper?.toFixed(1), lower: +d.lower?.toFixed(1) }));
    return [...h, ...f];
  }, [hist, fcast]);

  const Icon = METRIC_ICONS[metric] ?? Activity;
  const current = hist[hist.length - 1]?.value ?? 0;
  const peak = Math.max(...fcast.map((d: any) => d.value), 0);
  const crossIdx = fcast.findIndex((d: any) => d.value >= threshold);
  const crossTs = crossIdx >= 0 ? fcast[crossIdx]?.ts : null;

  return (
    <Card className="bg-[#0D0D1A] border-white/8">
      <CardHeader className="pb-2 pt-3 px-4 flex flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="w-3.5 h-3.5 text-slate-400" />
          <span className="text-sm font-semibold text-slate-200">{metric}</span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-slate-400">Now: <strong className="text-slate-200">{fmtPct(current)}</strong></span>
          <span style={{ color }} className="font-medium">Peak: {fmtPct(peak)}</span>
          {crossTs && (
            <span className="text-red-400 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              Breach ~{new Date(crossTs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="px-2 pb-3">
        <ResponsiveContainer width="100%" height={130}>
          <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
            <XAxis dataKey="ts" tickFormatter={fmtTime} tick={{ fill: "#64748b", fontSize: 9 }} tickLine={false} interval="preserveStartEnd" />
            <YAxis domain={[0, 100]} tick={{ fill: "#64748b", fontSize: 9 }} tickLine={false} tickFormatter={v => `${v}%`} width={28} />
            <Tooltip content={<ChartTip />} />
            <ReferenceLine y={threshold} stroke="#ef4444" strokeDasharray="4 2" label={{ value: `${threshold}%`, fill: "#ef4444", fontSize: 9, position: "right" }} />
            {crossTs && <ReferenceLine x={crossTs} stroke="#f97316" strokeDasharray="4 2" />}
            <Area type="monotone" dataKey="upper" stroke="none" fill={color} fillOpacity={0.08} name="Upper" />
            <Area type="monotone" dataKey="lower" stroke="none" fill="#0D0D1A" fillOpacity={1} name="Lower" />
            <Line type="monotone" dataKey="actual" stroke="#94a3b8" strokeWidth={1.5} dot={false} name="Actual" />
            <Line type="monotone" dataKey="forecast" stroke={color} strokeWidth={2} strokeDasharray="5 3" dot={false} name="Forecast" />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

// ─── incident card ──────────────────────────────────────────────
function IncidentCard({ inc }: { inc: any }) {
  const sev = SEV_STYLES[inc.severity] ?? SEV_STYLES.Medium;
  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-[#0D0D1A] border border-white/6 hover:border-white/14 transition-colors group">
      <AlertTriangle className="w-4 h-4 mt-0.5 text-red-400 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className="text-xs font-semibold text-slate-200 truncate">{inc.title}</span>
          <Badge className={`text-[10px] py-0 px-1.5 ${sev}`}>{inc.severity}</Badge>
          {inc.status === "Open" && <Badge className="text-[10px] py-0 px-1.5 bg-red-500/10 text-red-400 border border-red-500/20">OPEN</Badge>}
        </div>
        <p className="text-[11px] text-slate-500 mb-1.5">{inc.correlationReason}</p>
        <div className="flex items-center gap-4 text-[10px] text-slate-500">
          <span className="flex items-center gap-1"><Clock className="w-3 h-3" />Swimlane overlap: {inc.swimlaneOverlap}</span>
          <span className="text-indigo-400">{Math.round(inc.confidence * 100)}% confidence</span>
          <span>{inc.impactedServices?.join(", ")}</span>
        </div>
      </div>
      <Link href={inc.href ?? "#"}>
        <Button variant="ghost" size="icon" className="h-7 w-7 text-slate-500 group-hover:text-indigo-400 transition-colors shrink-0" data-testid={`link-incident-${inc.id}`}>
          <ChevronRight className="w-4 h-4" />
        </Button>
      </Link>
    </div>
  );
}

// ─── alert row ──────────────────────────────────────────────────
function AlertRow({ alt }: { alt: any }) {
  const sev = SEV_STYLES[alt.severity] ?? SEV_STYLES.Medium;
  return (
    <div className="flex items-center gap-3 p-2.5 rounded-lg bg-[#0D0D1A] border border-white/6 hover:border-white/14 transition-colors">
      <Bell className="w-3.5 h-3.5 text-yellow-400 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-slate-200 truncate">{alt.name}</span>
          <Badge className={`text-[10px] py-0 px-1.5 ${sev}`}>{alt.severity}</Badge>
          <span className="text-[10px] text-slate-500">{alt.source}</span>
        </div>
        <p className="text-[11px] text-slate-500 mt-0.5">{alt.metric} · {new Date(alt.ts).toLocaleTimeString()}</p>
      </div>
      <Link href={alt.href ?? "#"}>
        <Button variant="ghost" size="icon" className="h-7 w-7 text-slate-500 hover:text-indigo-400" data-testid={`link-alert-${alt.id}`}>
          <ExternalLink className="w-3.5 h-3.5" />
        </Button>
      </Link>
    </div>
  );
}

// ─── error row ──────────────────────────────────────────────────
function ErrorRow({ err }: { err: any }) {
  const sev = SEV_STYLES[err.severity] ?? SEV_STYLES.Medium;
  return (
    <div className="flex items-center gap-3 p-2.5 rounded-lg bg-[#0D0D1A] border border-white/6 hover:border-white/14 transition-colors">
      <Bug className="w-3.5 h-3.5 text-red-400 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-mono text-slate-200 truncate">{err.cluster}</span>
          <Badge className={`text-[10px] py-0 px-1.5 ${sev}`}>{err.severity}</Badge>
        </div>
        <p className="text-[11px] text-slate-500 mt-0.5">{err.service} · {err.frequencyTrend} · {err.timeRangeOverlap} · <span className="text-indigo-400">{Math.round(err.confidence * 100)}% corr.</span></p>
      </div>
      <Link href={err.href ?? "#"}>
        <Button variant="ghost" size="icon" className="h-7 w-7 text-slate-500 hover:text-indigo-400" data-testid={`link-error-${err.id}`}>
          <ExternalLink className="w-3.5 h-3.5" />
        </Button>
      </Link>
    </div>
  );
}

// ─── transaction row ────────────────────────────────────────────
function TxRow({ tx }: { tx: any }) {
  const impact = tx.impactScore >= 80 ? "Critical" : tx.impactScore >= 50 ? "High" : "Medium";
  return (
    <div className="flex items-center gap-3 p-2.5 rounded-lg bg-[#0D0D1A] border border-white/6 hover:border-white/14 transition-colors">
      <BarChart3 className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-slate-200">{tx.name}</span>
          <Badge className={`text-[10px] py-0 px-1.5 ${SEV_STYLES[impact]}`}>Impact {tx.impactScore}</Badge>
          {tx.slaBreached && <Badge className="text-[10px] py-0 px-1.5 bg-red-500/10 text-red-400 border border-red-500/20">SLA BREACH</Badge>}
        </div>
        <p className="text-[11px] text-slate-500 mt-0.5">RT: <span className="text-orange-400">{tx.responseTimeTrend}</span> · Errors: <span className="text-red-400">{tx.errorPctTrend}</span> · {tx.calls} calls/min</p>
      </div>
      <Link href={tx.href ?? "#"}>
        <Button variant="ghost" size="icon" className="h-7 w-7 text-slate-500 hover:text-indigo-400" data-testid={`link-tx-${tx.id}`}>
          <ExternalLink className="w-3.5 h-3.5" />
        </Button>
      </Link>
    </div>
  );
}

// ─── service/node card ──────────────────────────────────────────
function EntityCard({ item, type }: { item: any; type: "service" | "node" }) {
  const rc = RISK_COLOR(item.riskScore);
  const Icon = type === "service" ? Layers : Server;
  return (
    <Link href={item.href ?? "#"}>
      <div className="p-3 rounded-lg bg-[#0D0D1A] border border-white/6 hover:border-indigo-500/30 transition-colors cursor-pointer group" data-testid={`card-entity-${item.name}`}>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Icon className="w-3.5 h-3.5 text-slate-400" />
            <span className="text-xs font-semibold text-slate-200 group-hover:text-indigo-300 transition-colors">{item.name}</span>
          </div>
          <span className="text-[10px] font-bold" style={{ color: rc }}>Score {item.riskScore}</span>
        </div>
        <div className="grid grid-cols-2 gap-1 mb-2 text-[10px] text-slate-500">
          <span>CPU <strong className="text-slate-300">{item.cpu}%</strong></span>
          <span>Mem <strong className="text-slate-300">{item.memory}%</strong></span>
        </div>
        <Progress value={item.riskScore} className="h-1 mb-1" style={{ "--progress-color": rc } as any} />
        <p className="text-[10px] text-slate-500 flex items-center gap-1 mt-1.5">
          <Target className="w-3 h-3" />{item.forecast}
        </p>
      </div>
    </Link>
  );
}

// ─── recommendation card ────────────────────────────────────────
function RecommendationCard({ rec, rank }: { rec: any; rank: number }) {
  const priorityColor = rec.priority === "Critical" ? "text-red-400 border-red-500/30" : rec.priority === "High" ? "text-orange-400 border-orange-500/30" : "text-yellow-400 border-yellow-500/30";
  return (
    <div className="p-3 rounded-lg bg-[#0D0D1A] border border-white/6 space-y-2" data-testid={`card-recommendation-${rec.id}`}>
      <div className="flex items-start gap-2">
        <div className={`flex-shrink-0 w-5 h-5 rounded-full border flex items-center justify-center text-[9px] font-bold ${priorityColor}`}>{rank}</div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-slate-200 leading-tight">{rec.title}</p>
          <p className="text-[10px] text-slate-500 mt-0.5 leading-relaxed">{rec.description}</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[10px]">
        <div className="bg-white/3 rounded p-1.5">
          <p className="text-slate-500">Impact</p>
          <p className="text-green-400 font-medium">{rec.impact}</p>
        </div>
        <div className="bg-white/3 rounded p-1.5">
          <p className="text-slate-500">Confidence</p>
          <p className="text-indigo-400 font-medium">{Math.round(rec.confidence * 100)}%</p>
        </div>
        <div className="bg-white/3 rounded p-1.5">
          <p className="text-slate-500">Cost</p>
          <p className="text-slate-300 font-medium">{rec.costImpact}</p>
        </div>
        <div className="bg-white/3 rounded p-1.5">
          <p className="text-slate-500">Time to apply</p>
          <p className="text-slate-300 font-medium">{rec.timeToApply}</p>
        </div>
      </div>
      <Button size="sm" className="w-full h-7 text-xs bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 border border-indigo-500/30" data-testid={`btn-apply-rec-${rec.id}`}>
        Apply Recommendation
      </Button>
    </div>
  );
}

// ─── AI narrative box ───────────────────────────────────────────
function AIBox({ text }: { text: string }) {
  return (
    <div className="flex gap-3 p-3.5 rounded-xl bg-gradient-to-r from-indigo-900/20 to-purple-900/10 border border-indigo-500/20">
      <Brain className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
      <div>
        <p className="text-[10px] font-semibold text-indigo-300 uppercase tracking-widest mb-1.5">AI Narrative</p>
        <p className="text-xs text-slate-300 leading-relaxed">{text}</p>
      </div>
    </div>
  );
}

// ─── AI insight tip ─────────────────────────────────────────────
function AITip({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 p-2.5 rounded-lg bg-indigo-900/10 border border-indigo-500/15 text-xs text-indigo-300">
      <Brain className="w-3.5 h-3.5 shrink-0 mt-0.5 text-indigo-400" />
      <span>{text}</span>
    </div>
  );
}

// ─── main page ──────────────────────────────────────────────────
export default function CapacityRiskDetail() {
  const { riskId } = useParams<{ riskId: string }>();
  const [scenario, setScenario] = useState<Scenario>("baseline");
  const [activeTab, setActiveTab] = useState("metrics");

  const { data: detail, isLoading } = useQuery<any>({ queryKey: ["/api/capacity-planning/risks", riskId] });
  const { data: incidents } = useQuery<any[]>({ queryKey: ["/api/capacity-planning/risks", riskId, "related-incidents"] });
  const { data: alerts } = useQuery<any[]>({ queryKey: ["/api/capacity-planning/risks", riskId, "related-alerts"] });
  const { data: errors } = useQuery<any[]>({ queryKey: ["/api/capacity-planning/risks", riskId, "related-errors"] });
  const { data: transactions } = useQuery<any[]>({ queryKey: ["/api/capacity-planning/risks", riskId, "related-transactions"] });
  const { data: servicesNodes } = useQuery<any>({ queryKey: ["/api/capacity-planning/risks", riskId, "related-services-nodes"] });

  if (isLoading || !detail) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-64 text-slate-400 text-sm animate-pulse">Loading capacity risk analysis…</div>
      </AppLayout>
    );
  }

  const sevStyle = SEV_STYLES[detail.severity] ?? SEV_STYLES.Medium;
  const MetIcon = METRIC_ICONS[detail.type] ?? Activity;
  const scenarioLabels: Record<Scenario, string> = { optimistic: "Optimistic", baseline: "Baseline", pessimistic: "Pessimistic" };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[#08080F] text-slate-100">
        {/* ── Breadcrumb ── */}
        <div className="border-b border-white/6 bg-[#0A0A14] px-6 py-3 flex items-center gap-2 text-xs text-slate-500">
          <Link href="/capacity-planning">
            <span className="hover:text-indigo-400 cursor-pointer flex items-center gap-1 transition-colors" data-testid="link-breadcrumb-capacity">
              <ArrowLeft className="w-3 h-3" /> Capacity Planning
            </span>
          </Link>
          <ChevronRight className="w-3 h-3" />
          <span className="text-slate-300">{detail.name}</span>
        </div>

        <div className="p-6 space-y-6">

          {/* ── Risk Header ── */}
          <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
            <div className="space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <Badge className={`text-xs px-2.5 py-1 ${sevStyle}`} data-testid="badge-severity">{detail.severity}</Badge>
                <Badge className="text-xs px-2 py-0.5 bg-white/5 text-slate-300 border border-white/10">{detail.type}</Badge>
                <Badge className="text-xs px-2 py-0.5 bg-white/5 text-slate-300 border border-white/10">{detail.forecastWindow} window</Badge>
              </div>
              <h1 className="text-2xl font-bold text-white" data-testid="text-risk-name">{detail.name}</h1>
              <div className="flex items-center gap-6 text-sm text-slate-400 flex-wrap">
                <span className="flex items-center gap-1.5"><MetIcon className="w-4 h-4 text-indigo-400" />{detail.entityType}: <strong className="text-slate-200">{detail.entityName}</strong></span>
                <span className="flex items-center gap-1.5"><Clock className="w-4 h-4 text-orange-400" />Saturation in <strong className="text-orange-300">{detail.hoursToSaturation}h</strong></span>
                <span className="flex items-center gap-1.5"><Shield className="w-4 h-4 text-indigo-400" />Confidence <strong className="text-indigo-300">{Math.round(detail.confidence * 100)}%</strong></span>
                <span className="flex items-center gap-1.5"><Zap className="w-4 h-4 text-yellow-400" />{detail.impactCategory}</span>
              </div>
              <p className="text-xs text-slate-500">App: <Link href={`/applications/${detail.appId}`}><span className="text-indigo-400 hover:text-indigo-300 cursor-pointer transition-colors">{detail.affectedApp}</span></Link></p>
            </div>

            {/* Risk Score gauge */}
            <div className="flex-shrink-0 text-center bg-[#0D0D1A] border border-white/8 rounded-xl p-4 min-w-[120px]" data-testid="gauge-risk-score">
              <p className="text-xs text-slate-500 mb-1">Risk Score</p>
              <p className="text-4xl font-black" style={{ color: RISK_COLOR(detail.riskScore) }}>{detail.riskScore}</p>
              <p className="text-[10px] text-slate-600 mt-1">/100</p>
              <div className="w-full mt-2 h-1.5 rounded-full bg-white/5">
                <div className="h-1.5 rounded-full transition-all" style={{ width: `${detail.riskScore}%`, backgroundColor: RISK_COLOR(detail.riskScore) }} />
              </div>
            </div>
          </div>

          {/* ── Main grid: content + sidebar ── */}
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            {/* Left: charts + tabs */}
            <div className="xl:col-span-2 space-y-6">

              {/* Scenario Selector */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-slate-500 font-medium">Forecast Scenario:</span>
                {(["optimistic", "baseline", "pessimistic"] as Scenario[]).map(s => (
                  <button
                    key={s}
                    data-testid={`btn-scenario-${s}`}
                    onClick={() => setScenario(s)}
                    className={`px-3 py-1 rounded-full text-xs font-semibold border transition-all ${scenario === s ? "border-transparent text-white shadow-sm" : "border-white/10 text-slate-400 hover:border-white/20"}`}
                    style={scenario === s ? { backgroundColor: SCENARIO_COLORS[s] + "30", color: SCENARIO_COLORS[s], borderColor: SCENARIO_COLORS[s] + "60" } : {}}
                  >
                    {scenarioLabels[s]}
                  </button>
                ))}
                <span className="ml-2 text-[11px] text-slate-500">
                  {scenario === "optimistic" ? "Minimal growth — best case" : scenario === "baseline" ? "Current trend continues" : "Spike scenario — worst case"}
                </span>
              </div>

              {/* 4 Forecast Charts */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {["CPU", "Memory", "Disk", "Network"].map(m => (
                  <ForecastChart key={m} detail={detail} metric={m} scenario={scenario} threshold={detail.thresholds?.[m.toLowerCase()] ?? 85} />
                ))}
              </div>

              {/* Tabbed correlation panels */}
              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="bg-[#0D0D1A] border border-white/6 flex-wrap h-auto gap-1 p-1 rounded-xl">
                  {[
                    { value: "metrics", label: "Resource Metrics", icon: Activity },
                    { value: "alerts", label: "Alerts", icon: Bell },
                    { value: "errors", label: "Errors", icon: Bug },
                    { value: "incidents", label: "Incidents", icon: AlertTriangle },
                    { value: "ai", label: "AI Insights", icon: Brain },
                  ].map(t => (
                    <TabsTrigger key={t.value} value={t.value} className="flex items-center gap-1.5 text-xs data-[state=active]:bg-indigo-600/30 data-[state=active]:text-indigo-300 rounded-lg px-3" data-testid={`tab-${t.value}`}>
                      <t.icon className="w-3 h-3" />{t.label}
                    </TabsTrigger>
                  ))}
                </TabsList>

                {/* Resource Metrics */}
                <TabsContent value="metrics" className="mt-4 space-y-3">
                  {["CPU", "Memory", "Disk", "Network"].map(m => {
                    const vals = detail.historical?.[m.toLowerCase()] ?? [];
                    const cur = vals[vals.length - 1]?.value ?? 0;
                    const thr = detail.thresholds?.[m.toLowerCase()] ?? 85;
                    const Icon = METRIC_ICONS[m] ?? Activity;
                    return (
                      <div key={m} className="flex items-center gap-4 p-3 rounded-lg bg-[#0D0D1A] border border-white/6">
                        <Icon className="w-4 h-4 text-slate-400 shrink-0" />
                        <div className="w-24 shrink-0">
                          <p className="text-xs font-medium text-slate-300">{m}</p>
                          <p className="text-[10px] text-slate-500">threshold {thr}%</p>
                        </div>
                        <div className="flex-1">
                          <Progress value={cur} className="h-2" />
                        </div>
                        <span className="text-sm font-bold shrink-0" style={{ color: RISK_COLOR(cur) }} data-testid={`metric-value-${m}`}>{fmtPct(cur)}</span>
                        {cur >= thr && <Badge className="text-[10px] py-0 px-1.5 bg-red-500/15 text-red-400 border border-red-500/30 shrink-0">BREACH</Badge>}
                      </div>
                    );
                  })}
                </TabsContent>

                {/* Alerts tab */}
                <TabsContent value="alerts" className="mt-4 space-y-2">
                  <AITip text="These alerts were triggered within the same time window as the capacity trend escalation — strong correlation signal." />
                  {(alerts ?? []).map((a: any) => <AlertRow key={a.id} alt={a} />)}
                </TabsContent>

                {/* Errors tab */}
                <TabsContent value="errors" className="mt-4 space-y-2">
                  <AITip text={`Network timeout and OOM errors spiked concurrently with ${detail.type} climbs > ${detail.threshold}%.`} />
                  {(errors ?? []).map((e: any) => <ErrorRow key={e.id} err={e} />)}
                </TabsContent>

                {/* Incidents tab */}
                <TabsContent value="incidents" className="mt-4 space-y-2">
                  <AITip text="Historical incidents with this resource saturation type showed 60% recurrence within the same forecast window." />
                  {(incidents ?? []).map((inc: any) => <IncidentCard key={inc.id} inc={inc} />)}
                </TabsContent>

                {/* AI Insights tab */}
                <TabsContent value="ai" className="mt-4 space-y-4">
                  <AIBox text={detail.aiNarrative} />
                  <Card className="bg-[#0D0D1A] border-white/8">
                    <CardHeader className="py-3 px-4">
                      <CardTitle className="text-sm flex items-center gap-2"><TrendingUp className="w-4 h-4 text-indigo-400" />Correlation Summary</CardTitle>
                    </CardHeader>
                    <CardContent className="px-4 pb-4 space-y-2.5">
                      {[
                        { label: "Incidents likely caused by this risk", value: incidents?.length ?? "—", color: "text-red-400" },
                        { label: "Alerts correlated in time window", value: alerts?.length ?? "—", color: "text-yellow-400" },
                        { label: "Error clusters overlapping", value: errors?.length ?? "—", color: "text-orange-400" },
                        { label: "Business transactions degraded", value: transactions?.length ?? "—", color: "text-indigo-400" },
                        { label: "Services at risk", value: servicesNodes?.services?.length ?? "—", color: "text-purple-400" },
                        { label: "Nodes at risk", value: servicesNodes?.nodes?.length ?? "—", color: "text-cyan-400" },
                      ].map(item => (
                        <div key={item.label} className="flex items-center justify-between text-xs">
                          <span className="text-slate-400">{item.label}</span>
                          <span className={`font-bold ${item.color}`}>{item.value}</span>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                  {/* Scenario threshold crossing summary */}
                  <Card className="bg-[#0D0D1A] border-white/8">
                    <CardHeader className="py-3 px-4">
                      <CardTitle className="text-sm flex items-center gap-2"><Clock className="w-4 h-4 text-orange-400" />Threshold Crossing by Scenario</CardTitle>
                    </CardHeader>
                    <CardContent className="px-4 pb-4 space-y-2">
                      {[
                        { s: "Optimistic", time: `${Math.round(detail.hoursToSaturation * 2.1)}h`, level: "Low", color: "text-green-400" },
                        { s: "Baseline", time: `${detail.hoursToSaturation}h`, level: detail.severity, color: "text-orange-400" },
                        { s: "Pessimistic", time: `${Math.round(detail.hoursToSaturation * 0.55)}h`, level: "Critical", color: "text-red-400" },
                      ].map(row => (
                        <div key={row.s} className="flex items-center gap-3 text-xs">
                          <span className={`w-2 h-2 rounded-full shrink-0`} style={{ backgroundColor: SCENARIO_COLORS[row.s.toLowerCase() as Scenario] }} />
                          <span className="text-slate-400 w-24">{row.s}</span>
                          <span className="text-slate-200 font-medium flex-1">Breach in {row.time}</span>
                          <Badge className={`text-[10px] py-0 px-1.5 ${SEV_STYLES[row.level] ?? SEV_STYLES.Medium}`}>{row.level}</Badge>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                </TabsContent>
              </Tabs>
            </div>

            {/* Right: sticky sidebar */}
            <div className="xl:col-span-1 space-y-5 xl:sticky xl:top-4 xl:max-h-[calc(100vh-8rem)] xl:overflow-y-auto pr-0.5">
              {/* AI Narrative */}
              <AIBox text={detail.aiNarrative} />

              {/* Recommendations */}
              <div>
                <h3 className="text-sm font-semibold text-slate-200 mb-3 flex items-center gap-2">
                  <Brain className="w-4 h-4 text-indigo-400" /> AI Recommendations
                </h3>
                <div className="space-y-3">
                  {(detail.recommendations ?? []).map((rec: any, i: number) => (
                    <RecommendationCard key={rec.id} rec={rec} rank={i + 1} />
                  ))}
                </div>
              </div>

              {/* Quick nav to correlation */}
              <Card className="bg-[#0D0D1A] border-white/8">
                <CardHeader className="py-3 px-4">
                  <CardTitle className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Jump to Related</CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4 space-y-1.5">
                  {[
                    { label: "Incidents", icon: AlertTriangle, count: incidents?.length, tab: "incidents", color: "text-red-400" },
                    { label: "Alerts", icon: Bell, count: alerts?.length, tab: "alerts", color: "text-yellow-400" },
                    { label: "Errors", icon: Bug, count: errors?.length, tab: "errors", color: "text-orange-400" },
                    { label: "Transactions", icon: BarChart3, count: transactions?.length, tab: "metrics", color: "text-indigo-400" },
                  ].map(item => (
                    <button
                      key={item.tab}
                      onClick={() => setActiveTab(item.tab)}
                      data-testid={`btn-jump-${item.tab}`}
                      className="w-full flex items-center justify-between p-2 rounded-lg hover:bg-white/5 transition-colors text-xs"
                    >
                      <span className="flex items-center gap-2">
                        <item.icon className={`w-3.5 h-3.5 ${item.color}`} />
                        <span className="text-slate-300">{item.label}</span>
                      </span>
                      <span className={`font-bold ${item.color}`}>{item.count ?? "—"}</span>
                    </button>
                  ))}
                </CardContent>
              </Card>
            </div>
          </div>

          {/* ── Correlation Panels ── */}
          <div className="space-y-6">

            {/* Related Incidents */}
            <section data-testid="section-related-incidents">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-red-400" />
                  Incidents Likely Impacted by This Risk
                  <Badge className="text-[10px] py-0 px-1.5 bg-red-500/10 text-red-400 border border-red-500/20">{incidents?.length ?? 0}</Badge>
                </h2>
                <Link href="/incidents"><span className="text-xs text-indigo-400 hover:text-indigo-300 cursor-pointer flex items-center gap-1" data-testid="link-all-incidents">All Incidents <ArrowRight className="w-3 h-3" /></span></Link>
              </div>
              <div className="space-y-2">
                {(incidents ?? []).map((inc: any) => <IncidentCard key={inc.id} inc={inc} />)}
              </div>
              <AITip text="Historical incidents with CPU saturation showed recurrence 60% within same forecast window." />
            </section>

            {/* Related Alerts */}
            <section data-testid="section-related-alerts">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                  <Bell className="w-4 h-4 text-yellow-400" />
                  Capacity & Threshold Alerts
                  <Badge className="text-[10px] py-0 px-1.5 bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">{alerts?.length ?? 0}</Badge>
                </h2>
                <Link href="/alerts"><span className="text-xs text-indigo-400 hover:text-indigo-300 cursor-pointer flex items-center gap-1" data-testid="link-all-alerts">All Alerts <ArrowRight className="w-3 h-3" /></span></Link>
              </div>
              <div className="space-y-2">
                {(alerts ?? []).map((a: any) => <AlertRow key={a.id} alt={a} />)}
              </div>
            </section>

            {/* Related Errors */}
            <section data-testid="section-related-errors">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                  <Bug className="w-4 h-4 text-orange-400" />
                  Errors Correlated to Resource Stress
                  <Badge className="text-[10px] py-0 px-1.5 bg-orange-500/10 text-orange-400 border border-orange-500/20">{errors?.length ?? 0}</Badge>
                </h2>
                <Link href="/errors"><span className="text-xs text-indigo-400 hover:text-indigo-300 cursor-pointer flex items-center gap-1" data-testid="link-all-errors">All Errors <ArrowRight className="w-3 h-3" /></span></Link>
              </div>
              <div className="space-y-2">
                {(errors ?? []).map((e: any) => <ErrorRow key={e.id} err={e} />)}
              </div>
              <AITip text="Network timeout errors spiked concurrently with CPU climbs > 75%." />
            </section>

            {/* Business Transactions */}
            <section data-testid="section-related-transactions">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-indigo-400" />
                  Business Transactions Affected
                  <Badge className="text-[10px] py-0 px-1.5 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">{transactions?.length ?? 0}</Badge>
                </h2>
              </div>
              <div className="space-y-2">
                {(transactions ?? []).map((tx: any) => <TxRow key={tx.id} tx={tx} />)}
              </div>
            </section>

            {/* Services & Nodes */}
            <section data-testid="section-related-services-nodes">
              <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2 mb-4">
                <Server className="w-4 h-4 text-cyan-400" />Services & Nodes at Risk
              </h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div>
                  <p className="text-xs font-semibold text-slate-400 mb-2 flex items-center gap-1.5"><Layers className="w-3 h-3" />Impacted Services</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {(servicesNodes?.services ?? []).map((s: any) => <EntityCard key={s.name} item={s} type="service" />)}
                  </div>
                  <AITip text={`For ${servicesNodes?.services?.[0]?.name ?? "this service"}, ${servicesNodes?.services?.[0]?.forecast ?? "saturation is expected soon"}.`} />
                </div>
                <div>
                  <p className="text-xs font-semibold text-slate-400 mb-2 flex items-center gap-1.5"><Server className="w-3 h-3" />Impacted Nodes</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {(servicesNodes?.nodes ?? []).map((n: any) => <EntityCard key={n.name} item={n} type="node" />)}
                  </div>
                  <AITip text={`For Node ${servicesNodes?.nodes?.[0]?.name ?? "DB-X"}, ${servicesNodes?.nodes?.[0]?.forecast ?? "forecast crossing threshold in next 36 hours with 78% confidence"}.`} />
                </div>
              </div>
            </section>

            {/* Related Risks nav */}
            <section>
              <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2 mb-3">
                <GitMerge className="w-4 h-4 text-purple-400" />Other Active Capacity Risks
              </h2>
              <div className="flex items-center gap-2 flex-wrap">
                {[{ id: "RISK-001", label: "CPU — node-frontend-01", sev: "Critical" }, { id: "RISK-002", label: "Memory — E-Commerce", sev: "Critical" }, { id: "RISK-003", label: "Memory — node-db-01", sev: "High" }, { id: "RISK-004", label: "Network — api-gw-01", sev: "Medium" }]
                  .filter(r => r.id !== riskId)
                  .map(r => (
                    <Link key={r.id} href={`/capacity-planning/detail/${r.id}`}>
                      <div className={`px-3 py-1.5 rounded-lg text-xs border cursor-pointer hover:scale-105 transition-transform ${SEV_STYLES[r.sev]}`} data-testid={`link-risk-${r.id}`}>
                        {r.label}
                      </div>
                    </Link>
                  ))}
                <Link href="/capacity-planning">
                  <Button variant="outline" size="sm" className="h-7 text-xs border-white/10 text-slate-400 hover:text-slate-200" data-testid="link-all-risks">
                    View All Risks
                  </Button>
                </Link>
              </div>
            </section>

          </div>
        </div>
      </div>
    </AppLayout>
  );
}
