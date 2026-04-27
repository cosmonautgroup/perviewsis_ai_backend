import { useState } from "react";
import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  BrainCircuit, Cpu, MemoryStick, Activity, AlertTriangle,
  Server, ChevronRight, TrendingUp, Zap, Clock, ExternalLink, ShieldAlert
} from "lucide-react";
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine
} from "recharts";
import { format } from "date-fns";

const HORIZONS = ["24h", "72h", "1w"] as const;
type Horizon = typeof HORIZONS[number];

const PRIORITY_COLORS: Record<string, string> = {
  Critical: "bg-red-500/10 text-red-400 border-red-500/30",
  High: "bg-orange-500/10 text-orange-400 border-orange-500/30",
  Medium: "bg-yellow-500/10 text-yellow-400 border-yellow-500/30",
  Low: "bg-green-500/10 text-green-400 border-green-500/30",
  Info: "bg-blue-500/10 text-blue-400 border-blue-500/30",
};

function ForecastChart({ historical, forecast, threshold, color, label, unit = "%" }: any) {
  const combined = [
    ...(historical ?? []).slice(-24).map((d: any) => ({ ts: d.ts, value: d.value, predicted: null, upper: null, lower: null })),
    ...(forecast ?? []).map((d: any) => ({ ts: d.ts, value: null, predicted: d.predicted, upper: d.upper, lower: d.lower })),
  ];
  return (
    <Card className="border border-border shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{label}{threshold ? ` · threshold ${threshold}${unit}` : ""}</CardTitle>
      </CardHeader>
      <CardContent className="px-2 pb-3 h-[160px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={combined} margin={{ top: 5, right: 5, left: -28, bottom: 0 }}>
            <defs>
              <linearGradient id={`cg-${label}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.25} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
              <linearGradient id={`fg-${label}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.12} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
            <XAxis dataKey="ts" tickFormatter={v => format(new Date(v), 'HH:mm')} stroke="hsl(var(--muted-foreground))" fontSize={9} tickLine={false} axisLine={false} interval={8} />
            <YAxis stroke="hsl(var(--muted-foreground))" fontSize={9} tickLine={false} axisLine={false} domain={[0, 100]} tickFormatter={v => `${v}${unit}`} />
            <Tooltip labelFormatter={v => format(new Date(v), 'MMM d HH:mm')} formatter={(v: any) => [`${v?.toFixed(1)}${unit}`, ""]} />
            {threshold && <ReferenceLine y={threshold} stroke="#ef4444" strokeDasharray="4 2" strokeWidth={1} />}
            <Area type="monotone" dataKey="upper" fill={`url(#fg-${label})`} stroke="transparent" legendType="none" />
            <Area type="monotone" dataKey="lower" fill="transparent" stroke="transparent" legendType="none" />
            <Area type="monotone" dataKey="value" fill={`url(#cg-${label})`} stroke={color} strokeWidth={2} dot={false} connectNulls={false} />
            <Line type="monotone" dataKey="predicted" stroke={color} strokeWidth={1.5} strokeDasharray="5 3" dot={false} connectNulls={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

export default function ApplicationCapacity() {
  const { id } = useParams<{ id: string }>();
  const appId = parseInt(id || "0", 10);
  const [horizon, setHorizon] = useState<Horizon>("72h");

  const { data, isLoading } = useQuery<any>({
    queryKey: [`/api/capacity-planning/applications/${appId}`, horizon],
    queryFn: () => fetch(`/api/capacity-planning/applications/${appId}?horizon=${encodeURIComponent(horizon)}`).then(r => r.json()),
    enabled: !!appId,
  });

  const { data: app } = useQuery<any>({ queryKey: [`/api/applications/${appId}`] });

  if (isLoading) return (
    <AppLayout appId={appId}>
      <div className="space-y-4">{Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-36" />)}</div>
    </AppLayout>
  );

  const cur = data?.current ?? {};
  const forecasts = data?.forecasts ?? {};
  const selectedGlobalAppId = Number(app?.id ?? appId);
  const globalCapacityHref = Number.isFinite(selectedGlobalAppId)
    ? `/capacity-planning?appId=${encodeURIComponent(String(selectedGlobalAppId))}`
    : "/capacity-planning";

  return (
    <AppLayout appId={appId}>
      <div className="space-y-5 max-w-screen-2xl">

        {/* Breadcrumb */}
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground flex-wrap">
          <Link href="/capacity-planning" className="hover:text-foreground transition-colors">Capacity Planning</Link>
          <ChevronRight className="w-3 h-3" />
          <Link href={`/applications/${appId}`} className="hover:text-foreground transition-colors">{app?.name ?? "App"}</Link>
          <ChevronRight className="w-3 h-3" />
          <span className="text-foreground font-medium">Capacity</span>
        </div>

        {/* Header */}
        <div className="bg-card border border-border rounded-2xl p-6">
          <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <TrendingUp className="w-5 h-5 text-indigo-400" />
                <h1 className="text-2xl font-bold">{data?.appName}</h1>
                <Badge className="bg-indigo-500/10 text-indigo-400 border-indigo-500/20">Capacity View</Badge>
              </div>
              <div className="flex flex-wrap gap-3 text-xs text-muted-foreground mt-1">
                <span>Risk Score: <strong className={`${(data?.riskScore ?? 0) >= 80 ? "text-red-400" : (data?.riskScore ?? 0) >= 60 ? "text-amber-400" : "text-green-400"}`}>{data?.riskScore}/100</strong></span>
                {data?.hoursToSaturation?.cpu && <span className="text-red-400 font-semibold flex items-center gap-1"><AlertTriangle className="w-3 h-3" />CPU saturation in {data.hoursToSaturation.cpu}h</span>}
                {data?.hoursToSaturation?.memory && <span className="text-red-400 font-semibold flex items-center gap-1"><AlertTriangle className="w-3 h-3" />Memory saturation in {data.hoursToSaturation.memory}h</span>}
              </div>
            </div>
            <div className="flex items-center gap-1 p-1 rounded-xl border border-border bg-muted/20">
              {HORIZONS.map(h => (
                <button key={h} onClick={() => setHorizon(h)} data-testid={`app-horizon-${h}`}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${horizon === h ? "bg-indigo-600 text-white shadow" : "text-muted-foreground hover:text-foreground"}`}>
                  {h}
                </button>
              ))}
            </div>
          </div>

          {/* KPI tiles */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {[
              { label: "CPU Usage", value: `${cur.cpu}%`, bad: cur.cpu >= 85, icon: <Cpu className="w-4 h-4 text-red-400" /> },
              { label: "Memory Usage", value: `${cur.memory}%`, bad: cur.memory >= 85, icon: <MemoryStick className="w-4 h-4 text-purple-400" /> },
              { label: "Requests/min", value: (cur.requests ?? 0).toLocaleString(), icon: <Activity className="w-4 h-4 text-indigo-400" /> },
              { label: "Error Rate", value: `${cur.errorRate}%`, bad: cur.errorRate >= 5, icon: <AlertTriangle className="w-4 h-4 text-orange-400" /> },
              { label: "P99 Latency", value: `${(cur.p99 ?? 0).toLocaleString()}ms`, bad: (cur.p99 ?? 0) > 2000, icon: <Clock className="w-4 h-4 text-amber-400" /> },
              { label: "SLA Score", value: `${cur.slaScore}%`, bad: (cur.slaScore ?? 100) < 80, icon: <ShieldAlert className="w-4 h-4 text-blue-400" /> },
            ].map(k => (
              <div key={k.label} className={`rounded-xl border px-4 py-3 ${k.bad ? "border-red-500/20 bg-red-500/5" : "border-border bg-muted/20"}`}>
                <div className="flex items-center gap-1.5 mb-1">{k.icon}<p className="text-[10px] text-muted-foreground font-medium">{k.label}</p></div>
                <p className={`text-sm font-bold ${k.bad ? "text-red-400" : "text-foreground"}`}>{k.value}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
          {/* Left column */}
          <div className="xl:col-span-2 space-y-5">
            {/* Headroom */}
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: "CPU Headroom", value: data?.headroom?.cpu ?? 0 },
                { label: "Memory Headroom", value: data?.headroom?.memory ?? 0 },
              ].map(h => {
                const color = h.value < 15 ? "#ef4444" : h.value < 30 ? "#f59e0b" : "#22c55e";
                return (
                  <Card key={h.label} className="border border-border shadow-sm">
                    <CardContent className="p-4 flex items-center gap-4">
                      <div className="w-14 h-14 rounded-full border-4 flex items-center justify-center text-sm font-bold" style={{ borderColor: color, color }}>
                        {h.value}%
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-foreground">{h.label}</p>
                        <p className="text-[11px] text-muted-foreground">{h.value < 15 ? "Critical — scale now" : h.value < 30 ? "Low — plan scaling" : "Adequate"}</p>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {/* Forecast Charts */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <ForecastChart historical={forecasts.cpu?.historical} forecast={forecasts.cpu?.forecast} threshold={forecasts.cpu?.threshold} color="#ef4444" label="CPU Usage" />
              <ForecastChart historical={forecasts.memory?.historical} forecast={forecasts.memory?.forecast} threshold={forecasts.memory?.threshold} color="#a855f7" label="Memory Usage" />
              <ForecastChart historical={forecasts.requests?.historical} forecast={forecasts.requests?.forecast} threshold={forecasts.requests?.threshold} color="#6366f1" label="Request Rate" />
              <ForecastChart historical={forecasts.errorRate?.historical} forecast={forecasts.errorRate?.forecast} threshold={forecasts.errorRate?.threshold} color="#f97316" label="Error Rate" />
            </div>

            {/* Service Breakdown */}
            <Card className="border border-border shadow-sm" data-testid="service-breakdown">
              <CardHeader className="pb-3 border-b border-border">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Zap className="w-4 h-4 text-amber-400" /> Service Capacity Breakdown
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left text-muted-foreground font-medium px-4 py-2">Service</th>
                      <th className="text-left text-muted-foreground font-medium px-4 py-2">CPU</th>
                      <th className="text-left text-muted-foreground font-medium px-4 py-2">Memory</th>
                      <th className="text-left text-muted-foreground font-medium px-4 py-2">Req/min</th>
                      <th className="text-left text-muted-foreground font-medium px-4 py-2">Risk</th>
                      <th className="text-left text-muted-foreground font-medium px-4 py-2">Saturates In</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.services ?? []).map((svc: any, i: number) => (
                      <tr key={i} data-testid={`service-row-${i}`} className="border-b border-border hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-2 font-medium">{svc.name}</td>
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-1.5">
                            <div className="w-14 h-1.5 bg-muted rounded-full overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${svc.cpu}%`, background: svc.cpu >= 85 ? "#ef4444" : "#6366f1" }} />
                            </div>
                            <span className={svc.cpu >= 85 ? "text-red-400 font-bold" : "text-muted-foreground"}>{svc.cpu}%</span>
                          </div>
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-1.5">
                            <div className="w-14 h-1.5 bg-muted rounded-full overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${svc.memory}%`, background: svc.memory >= 85 ? "#ef4444" : "#a855f7" }} />
                            </div>
                            <span className={svc.memory >= 85 ? "text-red-400 font-bold" : "text-muted-foreground"}>{svc.memory}%</span>
                          </div>
                        </td>
                        <td className="px-4 py-2 text-muted-foreground">{svc.requests}</td>
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-1.5">
                            <div className="w-10 h-1.5 bg-muted rounded-full overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${svc.riskScore}%`, background: svc.riskScore >= 85 ? "#ef4444" : svc.riskScore >= 65 ? "#f59e0b" : "#22c55e" }} />
                            </div>
                            <span className={svc.riskScore >= 85 ? "text-red-400 font-bold" : svc.riskScore >= 65 ? "text-amber-400" : "text-green-400"}>{svc.riskScore}</span>
                          </div>
                        </td>
                        <td className="px-4 py-2">{svc.saturationIn ? <span className="text-red-400 font-semibold">{svc.saturationIn}</span> : <span className="text-muted-foreground">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            {/* Traffic Growth */}
            <Card className="border border-border shadow-sm" data-testid="traffic-growth">
              <CardHeader className="pb-3 border-b border-border">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-green-400" /> Traffic Growth Forecast
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
                {[
                  { label: "Current RPS", value: data?.trafficGrowth?.current?.toLocaleString() },
                  { label: "30-Day Projected", value: data?.trafficGrowth?.projected30d?.toLocaleString(), warn: true },
                  { label: "90-Day Projected", value: data?.trafficGrowth?.projected90d?.toLocaleString(), warn: true },
                  { label: "Growth Rate", value: `+${data?.trafficGrowth?.growthRate}%/mo`, warn: (data?.trafficGrowth?.growthRate ?? 0) > 15 },
                ].map(t => (
                  <div key={t.label} className="text-center p-3 rounded-xl border border-border bg-muted/10">
                    <p className="text-[10px] text-muted-foreground mb-1">{t.label}</p>
                    <p className={`text-lg font-bold ${t.warn ? "text-amber-400" : "text-foreground"}`}>{t.value}</p>
                  </div>
                ))}
                <div className="col-span-2 sm:col-span-4 rounded-xl border border-border bg-muted/10 px-4 py-2 text-xs text-muted-foreground">
                  Peak usage window: <strong className="text-foreground">{data?.trafficGrowth?.peakHour}</strong>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Right sidebar */}
          <div className="space-y-5">
            {/* Recommendations */}
            <Card className="border border-indigo-500/30 bg-card shadow-sm" data-testid="recommendations-panel">
              <CardHeader className="pb-3 border-b border-border">
                <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <BrainCircuit className="w-4 h-4 text-indigo-400" /> AI Recommendations
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-3">
                {(data?.recommendations ?? []).map((r: any) => (
                  <div key={r.id} data-testid={`recommendation-${r.id}`} className="rounded-xl border border-border bg-muted/10 p-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs font-semibold text-foreground leading-snug">{r.action}</p>
                      <span className={`shrink-0 text-[9px] font-bold px-2 py-0.5 rounded border ${PRIORITY_COLORS[r.priority] ?? PRIORITY_COLORS.Info}`}>{r.priority}</span>
                    </div>
                    <div className="flex items-center gap-3 text-[10px]">
                      <span className="text-muted-foreground">Confidence: <strong className="text-indigo-400">{Math.round(r.confidence * 100)}%</strong></span>
                      <span className="text-muted-foreground">Cost: <strong className="text-foreground">{r.costImpact}</strong></span>
                    </div>
                    {r.estimatedTimeToScale !== "—" && (
                      <p className="text-[10px] text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" /> Scale time: {r.estimatedTimeToScale}</p>
                    )}
                    <button data-testid={`take-action-${r.id}`} className="w-full text-center text-[10px] font-semibold text-indigo-300 border border-indigo-500/20 bg-indigo-500/5 rounded-lg py-1.5 hover:bg-indigo-500/10 transition-colors">
                      Take Action →
                    </button>
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* Correlated Incidents */}
            {(data?.incidentCorrelation?.length ?? 0) > 0 && (
              <Card className="border border-red-500/20 bg-red-950/10 shadow-sm" data-testid="incident-correlation">
                <CardHeader className="pb-3 border-b border-red-500/10">
                  <CardTitle className="text-sm font-semibold text-red-300 flex items-center gap-2">
                    <ShieldAlert className="w-4 h-4" /> Capacity-Related Incidents
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4 space-y-3">
                  {data.incidentCorrelation.map((inc: any) => (
                    <Link key={inc.id} href={inc.href} data-testid={`correlated-incident-${inc.id}`}
                      className="block rounded-xl border border-border hover:border-red-500/30 bg-muted/10 p-3 transition-colors">
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-xs font-bold text-foreground">{inc.id}</p>
                        <ExternalLink className="w-3 h-3 text-muted-foreground" />
                      </div>
                      <p className="text-[11px] text-muted-foreground">{inc.title}</p>
                      <p className="text-[10px] text-red-400 mt-1">Capacity factor: {inc.capacityFactor}</p>
                    </Link>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Quick Links */}
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-3 border-b border-border">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Server className="w-4 h-4 text-blue-400" /> Infrastructure Links
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-2">
                {[
                  { label: "View Servers", href: `/applications/${appId}/servers`, icon: <Server className="w-3.5 h-3.5" /> },
                  { label: "Active Alerts", href: "/alerts", icon: <AlertTriangle className="w-3.5 h-3.5" /> },
                  { label: "Active Incidents", href: `/applications/${appId}/incidents`, icon: <ShieldAlert className="w-3.5 h-3.5" /> },
                  { label: "Cluster k8s-prod", href: "/capacity-planning/cluster/k8s-prod", icon: <Activity className="w-3.5 h-3.5" /> },
                  { label: "Global Capacity", href: globalCapacityHref, icon: <TrendingUp className="w-3.5 h-3.5" /> },
                ].map(lk => (
                  <Link key={lk.label} href={lk.href}
                    className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/20 rounded-lg px-3 py-2 transition-colors">
                    {lk.icon} {lk.label} <ChevronRight className="w-3 h-3 ml-auto" />
                  </Link>
                ))}
              </CardContent>
            </Card>
          </div>
        </div>

      </div>
    </AppLayout>
  );
}
