import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  BrainCircuit, Cpu, MemoryStick, HardDrive, Wifi, Activity,
  TrendingUp, AlertTriangle, Server, ChevronRight, Zap, Package,
  Clock, DollarSign, ExternalLink, ShieldAlert
} from "lucide-react";
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine
} from "recharts";
import { format, formatDistanceToNow } from "date-fns";

const HORIZONS = ["24h", "72h", "1w", "3m"] as const;
type Horizon = typeof HORIZONS[number];
const ALL_APPS = "__all_apps__";

const PRIORITY_COLORS: Record<string, string> = {
  Critical: "bg-red-500/10 text-red-400 border-red-500/30",
  High: "bg-orange-500/10 text-orange-400 border-orange-500/30",
  Medium: "bg-yellow-500/10 text-yellow-400 border-yellow-500/30",
  Info: "bg-blue-500/10 text-blue-400 border-blue-500/30",
};

function RiskGauge({ value, label }: { value: number; label: string }) {
  const safeValue = Number.isFinite(value) ? value : 0;
  const color = safeValue >= 85 ? "#ef4444" : safeValue >= 70 ? "#f59e0b" : "#22c55e";
  return (
    <div className="flex flex-col items-center gap-1">
      <svg viewBox="0 0 80 50" className="w-20">
        <path d="M 10 45 A 35 35 0 0 1 70 45" fill="none" stroke="hsl(var(--border))" strokeWidth="8" strokeLinecap="round" />
        <path d="M 10 45 A 35 35 0 0 1 70 45" fill="none" stroke={color} strokeWidth="8" strokeLinecap="round"
          strokeDasharray={`${(safeValue / 100) * 110} 110`} />
        <text x="40" y="44" textAnchor="middle" fontSize="13" fontWeight="bold" fill={color}>{Math.round(safeValue)}%</text>
      </svg>
      <p className="text-[10px] text-muted-foreground font-medium">{label}</p>
    </div>
  );
}

function MetricForecastChart({ historical, forecast, threshold, color, label, unit = "%" }: any) {
  const combined = [
    ...(historical ?? []).map((d: any) => ({ ts: d.ts, value: d.value, predicted: null, upper: null, lower: null })),
    ...(forecast ?? []).map((d: any) => ({ ts: d.ts, value: null, predicted: d.predicted, upper: d.upper, lower: d.lower })),
  ];
  const switchPoint = historical?.[historical.length - 1]?.ts;

  return (
    <Card className="border border-border shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
          {label}
          {threshold && <span className="text-[10px] text-muted-foreground normal-case">· threshold {threshold}{unit}</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-2 pb-3 h-[160px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={combined} margin={{ top: 5, right: 5, left: -28, bottom: 0 }}>
            <defs>
              <linearGradient id={`grad-${label}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.25} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
              <linearGradient id={`forecast-band-${label}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.12} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
            <XAxis dataKey="ts" tickFormatter={v => format(new Date(v), 'HH:mm')} stroke="hsl(var(--muted-foreground))" fontSize={9} tickLine={false} axisLine={false} interval={11} />
            <YAxis stroke="hsl(var(--muted-foreground))" fontSize={9} tickLine={false} axisLine={false} domain={[0, 100]} tickFormatter={v => `${v}${unit}`} />
            <Tooltip labelFormatter={v => format(new Date(v), 'MMM d HH:mm')} formatter={(v: any, n: string) => [`${v?.toFixed(1)}${unit}`, n]} />
            {threshold && <ReferenceLine y={threshold} stroke="#ef4444" strokeDasharray="4 2" strokeWidth={1} label={{ value: `Threshold ${threshold}%`, position: "right", fontSize: 8, fill: "#ef4444" }} />}
            {switchPoint && <ReferenceLine x={switchPoint} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 2" strokeWidth={1} label={{ value: "Now", position: "top", fontSize: 8, fill: "hsl(var(--muted-foreground))" }} />}
            <Area type="monotone" dataKey="upper" fill={`url(#forecast-band-${label})`} stroke="transparent" name="Upper" legendType="none" />
            <Area type="monotone" dataKey="lower" fill="transparent" stroke="transparent" name="Lower" legendType="none" />
            <Area type="monotone" dataKey="value" fill={`url(#grad-${label})`} stroke={color} strokeWidth={2} dot={false} name="Historical" connectNulls={false} />
            <Line type="monotone" dataKey="predicted" stroke={color} strokeWidth={1.5} strokeDasharray="5 3" dot={false} name="Forecast" connectNulls={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

export default function CapacityPlanningGlobal() {
  const initialSelectedApp = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const appId = params.get("appId");
    return appId && appId.trim().length > 0 ? appId : ALL_APPS;
  }, []);
  const [horizon, setHorizon] = useState<Horizon>("72h");
  const [selectedApp, setSelectedApp] = useState<string>(initialSelectedApp);

  const { data, isLoading } = useQuery<any>({
    queryKey: ["/api/capacity-planning/global", selectedApp, horizon],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("horizon", horizon);
      if (selectedApp !== ALL_APPS) params.set("appId", selectedApp);
      const qs = params.toString();
      return fetch(`/api/capacity-planning/global?${qs}`).then(r => r.json());
    },
  });

  const { data: applications } = useQuery<any[]>({
    queryKey: ["/api/applications"],
  });

  if (isLoading) return (
    <AppLayout>
      <div className="space-y-4">{Array(5).fill(0).map((_, i) => <Skeleton key={i} className="h-36" />)}</div>
    </AppLayout>
  );

  const s = data?.summary ?? {};
  const horizonData = data?.forecasts?.[horizon] ?? {};
  const metrics = data?.metrics ?? {};
  const nodesHref = selectedApp !== ALL_APPS
    ? `/capacity-planning/nodes?appId=${encodeURIComponent(selectedApp)}`
    : "/capacity-planning/nodes";
  const formatCurrency = (value: unknown) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    return `$${Math.round(n).toLocaleString()}`;
  };

  return (
    <AppLayout>
      <div className="space-y-6 max-w-screen-2xl">

        {/* ── HEADER ── */}
        <div className="bg-card border border-border rounded-2xl p-6">
          <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <TrendingUp className="w-5 h-5 text-indigo-400" />
                <h1 className="text-2xl font-bold text-foreground">Capacity Planning</h1>
                <Badge className="bg-indigo-500/10 text-indigo-400 border-indigo-500/20">AI-Powered</Badge>
              </div>
              <p className="text-sm text-muted-foreground">Predictive resource forecasting across all applications, services, and infrastructure nodes.</p>
            </div>
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
              <Select value={selectedApp} onValueChange={setSelectedApp}>
                <SelectTrigger data-testid="capacity-application-filter" className="h-8 text-xs w-[220px]">
                  <SelectValue placeholder="All applications" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_APPS}>All applications</SelectItem>
                  {(applications ?? []).map((app: any) => (
                    <SelectItem key={app.id} value={String(app.id)}>{app.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-1 p-1 rounded-xl border border-border bg-muted/20">
                {HORIZONS.map(h => (
                  <button key={h} onClick={() => setHorizon(h)} data-testid={`horizon-${h}`}
                    className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-all ${horizon === h ? "bg-indigo-600 text-white shadow" : "text-muted-foreground hover:text-foreground"}`}>
                    {h}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* KPI Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {[
              { label: "Total Nodes", value: s.totalNodes ?? "-", icon: <Server className="w-4 h-4 text-blue-400" />, cls: "border-border" },
              { label: "Critical Nodes", value: s.criticalNodes ?? "-", icon: <AlertTriangle className="w-4 h-4 text-red-400" />, cls: "border-red-500/20 bg-red-500/5" },
              { label: "Warning Nodes", value: s.warningNodes ?? "-", icon: <AlertTriangle className="w-4 h-4 text-amber-400" />, cls: "border-amber-500/20 bg-amber-500/5" },
              { label: "CPU Headroom", value: s.headroomCpu != null ? `${s.headroomCpu}%` : "-", icon: <Cpu className="w-4 h-4 text-indigo-400" />, cls: (s.headroomCpu ?? 100) < 20 ? "border-red-500/20 bg-red-500/5" : "border-border" },
              { label: "Memory Headroom", value: s.headroomMemory != null ? `${s.headroomMemory}%` : "-", icon: <MemoryStick className="w-4 h-4 text-purple-400" />, cls: (s.headroomMemory ?? 100) < 20 ? "border-red-500/20 bg-red-500/5" : "border-border" },
              { label: "Overall Risk", value: s.overallRiskScore != null ? `${s.overallRiskScore}/100` : "-", icon: <BrainCircuit className="w-4 h-4 text-red-400" />, cls: "border-red-500/20 bg-red-500/5" },
            ].map(k => {
              const card = (
                <div className={`rounded-xl border px-4 py-3 ${k.cls}`}>
                  <div className="flex items-center gap-1.5 mb-1">{k.icon}<p className="text-[10px] text-muted-foreground font-medium">{k.label}</p></div>
                  <p className="text-lg font-bold text-foreground">{k.value}</p>
                </div>
              );
              if (k.label === "Total Nodes") {
                return (
                  <Link key={k.label} href={nodesHref} data-testid="capacity-total-nodes-link" className="block hover:opacity-90 transition-opacity">
                    {card}
                  </Link>
                );
              }
              return <div key={k.label}>{card}</div>;
            })}
          </div>
        </div>

        {/* ── HORIZON FORECAST SUMMARY ── */}
        <Card className="border border-blue-300/50 bg-blue-50/80 dark:border-blue-500/25 dark:bg-blue-950/20 shadow-sm" data-testid="horizon-forecast-card">
          <CardHeader className="pb-3 border-b border-blue-300/40 dark:border-blue-500/15">
            <CardTitle className="text-sm font-semibold text-blue-800 dark:text-blue-200 flex items-center gap-2">
              <BrainCircuit className="w-4 h-4" /> Forecast Summary - Next {horizon}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 grid grid-cols-2 sm:grid-cols-5 gap-4">
            {[
              { label: "CPU Peak", value: horizonData.cpuMax != null ? `${horizonData.cpuMax}%` : "-", icon: <Cpu className="w-4 h-4" />, warn: (horizonData.cpuMax ?? 0) >= 85 },
              { label: "Memory Peak", value: horizonData.memoryMax != null ? `${horizonData.memoryMax}%` : "-", icon: <MemoryStick className="w-4 h-4" />, warn: (horizonData.memoryMax ?? 0) >= 85 },
              { label: "Disk Peak", value: horizonData.diskMax != null ? `${horizonData.diskMax}%` : "-", icon: <HardDrive className="w-4 h-4" />, warn: (horizonData.diskMax ?? 0) >= 80 },
              { label: "Network Peak", value: horizonData.networkMax != null ? `${horizonData.networkMax}%` : "-", icon: <Wifi className="w-4 h-4" />, warn: (horizonData.networkMax ?? 0) >= 80 },
              { label: "Saturation Events", value: horizonData.saturationEvents ?? "-", icon: <AlertTriangle className="w-4 h-4" />, warn: (horizonData.saturationEvents ?? 0) > 0 },
            ].map(f => (
              <div key={f.label} className={`rounded-xl border p-3 text-center ${f.warn ? "border-red-500/20 bg-red-500/5" : "border-blue-300/40 bg-white/80 dark:border-blue-500/20 dark:bg-blue-950/20"}`}>
                <div className={`flex justify-center mb-1 ${f.warn ? "text-red-400" : "text-blue-600 dark:text-blue-300"}`}>{f.icon}</div>
                <p className={`text-2xl font-bold font-mono ${f.warn ? "text-red-400" : "text-foreground"}`}>{f.value}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">{f.label}</p>
              </div>
            ))}
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
          {/* ── LEFT: Metric Charts + Top Risks ── */}
          <div className="xl:col-span-2 space-y-5">
            {/* Resource Utilization Gauges */}
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-3 border-b border-border">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Activity className="w-4 h-4 text-indigo-400" /> Current Resource Utilization
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 flex flex-wrap gap-6 justify-around">
                <RiskGauge value={s.avgCpuUtilization ?? 0} label="Avg CPU" />
                <RiskGauge value={s.avgMemoryUtilization ?? 0} label="Avg Memory" />
                <RiskGauge value={s.avgDiskUtilization ?? 0} label="Avg Disk" />
                <div className="flex flex-col items-center gap-1">
                  <div className={`w-20 h-20 rounded-full flex items-center justify-center border-4 ${(s.overallRiskScore ?? 0) >= 80 ? "border-red-500 bg-red-500/10" : "border-amber-500 bg-amber-500/10"}`}>
                    <div className="text-center">
                      <p className={`text-2xl font-bold ${(s.overallRiskScore ?? 0) >= 80 ? "text-red-400" : "text-amber-400"}`}>{s.overallRiskScore}</p>
                      <p className="text-[9px] text-muted-foreground">Risk</p>
                    </div>
                  </div>
                  <p className="text-[10px] text-muted-foreground font-medium">Overall Risk</p>
                </div>
              </CardContent>
            </Card>

            {/* 5-Chart Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <MetricForecastChart historical={metrics.cpu?.historical} forecast={metrics.cpu?.forecast} threshold={metrics.cpu?.threshold} color="#ef4444" label="CPU Usage" />
              <MetricForecastChart historical={metrics.memory?.historical} forecast={metrics.memory?.forecast} threshold={metrics.memory?.threshold} color="#a855f7" label="Memory Usage" />
              <MetricForecastChart historical={metrics.disk?.historical} forecast={metrics.disk?.forecast} threshold={metrics.disk?.threshold} color="#f59e0b" label="Disk I/O" />
              <MetricForecastChart historical={metrics.network?.historical} forecast={metrics.network?.forecast} threshold={metrics.network?.threshold} color="#22c55e" label="Network Throughput" />
            </div>
            <MetricForecastChart historical={metrics.requests?.historical} forecast={metrics.requests?.forecast} threshold={metrics.requests?.threshold} color="#6366f1" label="Request Volume (% of capacity)" />

            {/* Top Risk Items */}
            <Card className="border border-border shadow-sm" data-testid="top-risks-section">
              <CardHeader className="pb-3 border-b border-border">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-red-400" /> Top Capacity Risks
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left text-muted-foreground font-medium px-4 py-2">Entity</th>
                      <th className="text-left text-muted-foreground font-medium px-4 py-2">Type</th>
                      <th className="text-left text-muted-foreground font-medium px-4 py-2">Metric</th>
                      <th className="text-left text-muted-foreground font-medium px-4 py-2">Current</th>
                      <th className="text-left text-muted-foreground font-medium px-4 py-2">Saturation In</th>
                      <th className="text-left text-muted-foreground font-medium px-4 py-2">Risk</th>
                      <th className="px-4 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.topRisks ?? []).map((r: any) => {
                      const drillHref = r.detailHref || r.href || "/capacity-planning/nodes";
                      return (
                      <tr key={r.id} data-testid={`risk-row-${r.id}`} className="border-b border-border hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-2 font-medium">{r.entity}</td>
                        <td className="px-4 py-2">
                          <span className="capitalize text-[10px] px-2 py-0.5 rounded border border-border bg-muted/20 text-muted-foreground">{r.type}</span>
                        </td>
                        <td className="px-4 py-2 text-muted-foreground">{r.metric}</td>
                        <td className="px-4 py-2">
                          <span className={`font-bold ${r.current >= r.threshold ? "text-red-400" : r.current >= r.threshold * 0.9 ? "text-amber-400" : "text-foreground"}`}>{r.current}%</span>
                          <span className="text-muted-foreground text-[10px] ml-1">/ {r.threshold}%</span>
                        </td>
                        <td className="px-4 py-2">
                          {r.hoursToSaturation ? (
                            <span className={`font-semibold ${r.hoursToSaturation <= 6 ? "text-red-400" : r.hoursToSaturation <= 24 ? "text-amber-400" : "text-muted-foreground"}`}>
                              {r.hoursToSaturation}h
                            </span>
                          ) : <span className="text-muted-foreground">-</span>}
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-1.5">
                            <div className="w-14 h-1.5 bg-muted rounded-full overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${r.riskScore}%`, background: r.riskScore >= 85 ? "#ef4444" : r.riskScore >= 65 ? "#f59e0b" : "#22c55e" }} />
                            </div>
                            <span className={`text-[10px] font-bold ${r.riskScore >= 85 ? "text-red-400" : r.riskScore >= 65 ? "text-amber-400" : "text-green-400"}`}>{r.riskScore}</span>
                          </div>
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-2">
                          {r.detailHref && (
                            <Link href={r.detailHref} className="text-indigo-400 hover:text-indigo-300 flex items-center gap-1 whitespace-nowrap text-[10px] font-semibold border border-indigo-500/30 rounded px-1.5 py-0.5 bg-indigo-500/10 hover:bg-indigo-500/20 transition-colors" data-testid={`link-detail-${r.riskId}`}>
                              View Details
                            </Link>
                          )}
                          <Link href={drillHref} className="text-slate-500 hover:text-slate-300 flex items-center gap-1">
                            Drill-in <ExternalLink className="w-3 h-3" />
                          </Link>
                          </div>
                        </td>
                      </tr>
                    )})}
                    {(!data?.topRisks || data.topRisks.length === 0) && (
                      <tr>
                        <td colSpan={7} className="px-4 py-6 text-center text-muted-foreground">
                          No capacity risks found for the selected scope yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </div>

          {/* ── RIGHT SIDEBAR ── */}
          <div className="space-y-5">
            {/* Saturation Timeline */}
            <Card className="border border-red-500/20 bg-red-950/10 shadow-sm" data-testid="saturation-timeline">
              <CardHeader className="pb-3 border-b border-red-500/10">
                <CardTitle className="text-sm font-semibold text-red-300 flex items-center gap-2">
                  <Clock className="w-4 h-4" /> Predicted Saturation Events
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-3">
                {(data?.saturationTimeline ?? []).map((ev: any, i: number) => (
                  <div key={i} className="flex items-start gap-3">
                    <div className="shrink-0 mt-0.5 w-2 h-2 rounded-full bg-red-500" />
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-semibold text-foreground">{ev.entity}</p>
                        <span className="text-[10px] text-red-400">{Math.round(ev.confidence * 100)}%</span>
                      </div>
                      <p className="text-[10px] text-muted-foreground">{ev.metric} · {formatDistanceToNow(new Date(ev.predictedAt), { addSuffix: true })}</p>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* Cluster Summary */}
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-3 border-b border-border">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Package className="w-4 h-4 text-blue-400" /> Clusters
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-3">
                {(data?.clusters ?? []).map((cl: any) => (
                  <Link key={cl.clusterId} href={`/capacity-planning/cluster/${cl.clusterId}`} data-testid={`cluster-card-${cl.clusterId}`}
                    className="block rounded-xl border border-border hover:border-blue-500/30 bg-muted/10 hover:bg-blue-500/5 p-3 transition-colors">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-bold text-foreground">{cl.name}</p>
                      <Badge className={cl.riskScore >= 70 ? "bg-amber-500/10 text-amber-400 border-amber-500/20" : "bg-green-500/10 text-green-400 border-green-500/20"}>
                        Risk {cl.riskScore}
                      </Badge>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-[10px] text-muted-foreground">
                      <span>Nodes: <strong className="text-foreground">{cl.nodes}</strong></span>
                      <span>CPU: <strong className={cl.cpuUsed >= 85 ? "text-red-400" : "text-foreground"}>{cl.cpuUsed}%</strong></span>
                      <span>Mem: <strong className={cl.memUsed >= 85 ? "text-red-400" : "text-foreground"}>{cl.memUsed}%</strong></span>
                    </div>
                    {cl.pendingPods > 0 && (
                      <p className="text-[10px] text-amber-400 mt-1.5 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" /> {cl.pendingPods} pending pods
                      </p>
                    )}
                  </Link>
                ))}
              </CardContent>
            </Card>

            {/* AI Insights */}
            <Card className="border border-indigo-500/20 bg-indigo-500/5 shadow-sm" data-testid="ai-insights-panel">
              <CardHeader className="pb-3 border-b border-indigo-500/10">
                <CardTitle className="text-sm font-semibold text-indigo-300 flex items-center gap-2">
                  <BrainCircuit className="w-4 h-4" /> AI Capacity Insights
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-4">
                {/* Cost Forecast */}
                <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-3">
                  <p className="text-[10px] font-semibold text-indigo-400 uppercase tracking-wide mb-2 flex items-center gap-1"><DollarSign className="w-3 h-3" /> Cost Forecast</p>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div><p className="text-muted-foreground">Current/mo</p><p className="font-bold text-foreground">{formatCurrency(data?.aiInsights?.costForecast?.current)}</p></div>
                    <div><p className="text-muted-foreground">30-day forecast</p><p className="font-bold text-amber-500">{formatCurrency(data?.aiInsights?.costForecast?.projected30d)}</p></div>
                    <div><p className="text-muted-foreground">90-day forecast</p><p className="font-bold text-red-500">{formatCurrency(data?.aiInsights?.costForecast?.projected90d)}</p></div>
                    <div><p className="text-muted-foreground">Optimized</p><p className="font-bold text-green-600">{formatCurrency(data?.aiInsights?.costForecast?.optimized)}</p></div>
                  </div>
                </div>

                {/* Predictions */}
                <div className="space-y-2">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Predicted Exhaustion Events</p>
                  {(data?.aiInsights?.predictions ?? []).map((p: any) => (
                    <div key={p.id} data-testid={`ai-prediction-${p.id}`} className="rounded-lg border border-border bg-muted/10 p-3 space-y-1">
                      <div className="flex items-center justify-between">
                        <p className="text-[10px] font-bold text-foreground">{p.entity} - {p.metric}</p>
                        <span className={`text-[9px] font-bold px-2 py-0.5 rounded border ${PRIORITY_COLORS[p.severity] ?? PRIORITY_COLORS.Info}`}>{p.severity}</span>
                      </div>
                      <p className="text-[10px] text-muted-foreground leading-relaxed">{p.message}</p>
                      <div className="flex items-center justify-between pt-1">
                        <p className="text-[10px] text-indigo-500 font-medium">{"->"} {p.action}</p>
                        <span className="text-[9px] text-green-400">{Math.round(p.confidence * 100)}% confidence</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px]">
                        <span className="text-muted-foreground">Cost: <strong className="text-foreground">{p.costImpact}</strong></span>
                        <span className="text-muted-foreground">Act by: <strong className={p.timeToAction === "Now" ? "text-red-500" : "text-amber-500"}>{p.timeToAction}</strong></span>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Scaling Strategy */}
                <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-3">
                  <p className="text-[10px] font-semibold text-indigo-400 uppercase tracking-wide mb-1 flex items-center gap-1"><Zap className="w-3 h-3" /> Scaling Strategy</p>
                  <p className="text-[11px] text-foreground/80 leading-relaxed">{data?.aiInsights?.scalingStrategy ?? "No scaling recommendation available for the selected context."}</p>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* ── APPLICATION CAPACITY LINKS ── */}
        <Card className="border border-border shadow-sm">
          <CardHeader className="pb-3 border-b border-border">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Activity className="w-4 h-4 text-green-400" /> Drill Down by Application
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            {!applications || applications.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <Server className="w-8 h-8 text-muted-foreground/40" />
                <p className="text-sm font-medium text-muted-foreground">No applications synced yet</p>
                <p className="text-xs text-muted-foreground">Connect an APM controller in Integrations to sync your applications.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {applications.map((app: any) => (
                  <Link key={app.id} href={`/applications/${app.id}/capacity`} data-testid={`app-capacity-link-${app.id}`}
                    className="block rounded-xl border border-border hover:border-indigo-500/30 bg-muted/10 hover:bg-indigo-500/5 p-4 transition-colors">
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-sm font-bold text-foreground truncate flex-1 mr-2">{app.name}</p>
                      <span className={`text-[10px] px-2 py-0.5 rounded border font-bold shrink-0 ${app.status === "Critical" ? "bg-red-500/10 text-red-400 border-red-500/20" : app.status === "Warning" ? "bg-amber-500/10 text-amber-400 border-amber-500/20" : "bg-green-500/10 text-green-400 border-green-500/20"}`}>{app.status ?? "Unknown"}</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground mb-3 capitalize">{app.source} · {app.tier ?? "Application"}</p>
                    <div className="flex items-center justify-between pt-2 border-t border-border">
                      <span className="text-[10px] text-muted-foreground">View capacity details</span>
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

      </div>
    </AppLayout>
  );
}
