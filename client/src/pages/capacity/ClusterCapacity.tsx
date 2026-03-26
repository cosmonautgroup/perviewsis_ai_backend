import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  BrainCircuit, Cpu, MemoryStick, Activity, AlertTriangle,
  Server, ChevronRight, TrendingUp, Package, Clock, CheckCircle2,
  Zap, HardDrive, ExternalLink
} from "lucide-react";
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine
} from "recharts";
import { format, formatDistanceToNow } from "date-fns";

const PRIORITY_COLORS: Record<string, string> = {
  Critical: "bg-red-500/10 text-red-400 border-red-500/30",
  High: "bg-orange-500/10 text-orange-400 border-orange-500/30",
  Medium: "bg-yellow-500/10 text-yellow-400 border-yellow-500/30",
  Low: "bg-green-500/10 text-green-400 border-green-500/30",
  Info: "bg-blue-500/10 text-blue-400 border-blue-500/30",
};

function UtilBar({ used, total, label, unit = "%" }: { used: number; total: number; label: string; unit?: string }) {
  const pct = Math.round((used / total) * 100);
  const color = pct >= 90 ? "#ef4444" : pct >= 80 ? "#f59e0b" : "#6366f1";
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <p className="text-[10px] text-muted-foreground">{label}</p>
        <p className="text-[10px] font-bold" style={{ color }}>{used} / {total} {unit} ({pct}%)</p>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function ForecastChart({ historical, forecast, threshold, color, label }: any) {
  const combined = [
    ...(historical ?? []).slice(-24).map((d: any) => ({ ts: d.ts, value: d.value, predicted: null, upper: null, lower: null })),
    ...(forecast ?? []).slice(0, 36).map((d: any) => ({ ts: d.ts, value: null, predicted: d.predicted, upper: d.upper, lower: d.lower })),
  ];
  return (
    <Card className="border border-border shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{label}</CardTitle>
      </CardHeader>
      <CardContent className="px-2 pb-3 h-[160px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={combined} margin={{ top: 5, right: 5, left: -28, bottom: 0 }}>
            <defs>
              <linearGradient id={`cl-${label}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.25} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
              <linearGradient id={`fl-${label}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.1} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
            <XAxis dataKey="ts" tickFormatter={v => format(new Date(v), 'HH:mm')} stroke="hsl(var(--muted-foreground))" fontSize={9} tickLine={false} axisLine={false} interval={8} />
            <YAxis stroke="hsl(var(--muted-foreground))" fontSize={9} tickLine={false} axisLine={false} domain={[0, 100]} tickFormatter={v => `${v}%`} />
            <Tooltip labelFormatter={v => format(new Date(v), 'MMM d HH:mm')} formatter={(v: any) => [`${v?.toFixed(1)}%`, ""]} />
            {threshold && <ReferenceLine y={threshold} stroke="#ef4444" strokeDasharray="4 2" strokeWidth={1} />}
            <Area type="monotone" dataKey="upper" fill={`url(#fl-${label})`} stroke="transparent" legendType="none" />
            <Area type="monotone" dataKey="lower" fill="transparent" stroke="transparent" legendType="none" />
            <Area type="monotone" dataKey="value" fill={`url(#cl-${label})`} stroke={color} strokeWidth={2} dot={false} connectNulls={false} />
            <Line type="monotone" dataKey="predicted" stroke={color} strokeWidth={1.5} strokeDasharray="5 3" dot={false} connectNulls={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

export default function ClusterCapacity() {
  const { clusterId } = useParams<{ clusterId: string }>();

  const { data, isLoading } = useQuery<any>({
    queryKey: [`/api/capacity-planning/cluster/${clusterId}`],
    queryFn: () => fetch(`/api/capacity-planning/cluster/${clusterId}`).then(r => r.json()),
    enabled: !!clusterId,
  });

  if (isLoading) return (
    <AppLayout>
      <div className="space-y-4">{Array(5).fill(0).map((_, i) => <Skeleton key={i} className="h-36" />)}</div>
    </AppLayout>
  );

  const cur = data?.current ?? {};

  return (
    <AppLayout>
      <div className="space-y-5 max-w-screen-2xl">

        {/* Breadcrumb */}
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground flex-wrap">
          <Link href="/capacity-planning" className="hover:text-foreground transition-colors">Capacity Planning</Link>
          <ChevronRight className="w-3 h-3" />
          <span className="text-foreground font-medium">{data?.clusterName}</span>
        </div>

        {/* Header */}
        <div className="bg-card border border-border rounded-2xl p-6">
          <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Package className="w-5 h-5 text-blue-400" />
                <h1 className="text-2xl font-bold">{data?.clusterName}</h1>
                <Badge className={data?.environment === "Production" ? "bg-red-500/10 text-red-400 border-red-500/20" : "bg-green-500/10 text-green-400 border-green-500/20"}>
                  {data?.environment}
                </Badge>
                <Badge className="bg-muted text-muted-foreground border-border">k8s {data?.version}</Badge>
              </div>
              <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                <span>Region: <strong className="text-foreground">{data?.region}</strong></span>
                <span>Nodes: <strong className="text-foreground">{cur.nodes}</strong></span>
                <span>Pods: <strong className="text-foreground">{cur.pods}</strong></span>
                {cur.pendingPods > 0 && <span className="text-amber-400 font-bold flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{cur.pendingPods} Pending Pods</span>}
                {data?.daysToNewNode && <span className="text-red-400 font-bold flex items-center gap-1"><AlertTriangle className="w-3 h-3" />New node needed in {data.daysToNewNode}d</span>}
              </div>
            </div>
          </div>

          {/* Allocatable vs Used */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="p-4 rounded-xl border border-border bg-muted/10 space-y-2">
              <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5"><Cpu className="w-3.5 h-3.5" />CPU</p>
              <UtilBar used={cur.cpuUsed} total={cur.cpuAllocatable} label="Allocatable vs Used" unit="cores" />
            </div>
            <div className="p-4 rounded-xl border border-border bg-muted/10 space-y-2">
              <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5"><MemoryStick className="w-3.5 h-3.5" />Memory</p>
              <UtilBar used={cur.memUsed} total={cur.memAllocatable} label="Allocatable vs Used" unit="Gi" />
            </div>
            <div className="p-4 rounded-xl border border-border bg-muted/10 space-y-2">
              <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5"><HardDrive className="w-3.5 h-3.5" />Storage</p>
              <UtilBar used={cur.storageUsedGb} total={cur.storageGb} label="PVC Storage" unit="GB" />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
          {/* Left: Node Pools + Forecasts + Events */}
          <div className="xl:col-span-2 space-y-5">
            {/* Node Pools */}
            <Card className="border border-border shadow-sm" data-testid="node-pools">
              <CardHeader className="pb-3 border-b border-border">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Server className="w-4 h-4 text-blue-400" /> Node Pools
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-4">
                {(data?.nodePools ?? []).map((pool: any, i: number) => (
                  <div key={i} data-testid={`node-pool-${i}`} className={`rounded-xl border p-4 space-y-3 ${pool.status === "Critical" ? "border-red-500/30 bg-red-950/10" : pool.status === "Warning" ? "border-amber-500/30 bg-amber-950/10" : "border-border bg-muted/10"}`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-bold text-foreground">{pool.name}</p>
                        <span className={`text-[10px] px-2 py-0.5 rounded border font-bold ${PRIORITY_COLORS[pool.status] ?? PRIORITY_COLORS.Info}`}>{pool.status}</span>
                      </div>
                      <div className="text-[10px] text-muted-foreground text-right">
                        <p>{pool.nodes} nodes · {pool.pods}/{pool.maxPods} pods</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <UtilBar used={pool.cpuUsed} total={pool.cpuAllocatable} label="CPU" unit="cores" />
                      <UtilBar used={pool.memUsed} total={pool.memAllocatable} label="Memory" unit="Gi" />
                    </div>
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-blue-500" style={{ width: `${Math.round((pool.pods / pool.maxPods) * 100)}%` }} />
                    </div>
                    <p className="text-[10px] text-muted-foreground">Pod density: {pool.pods}/{pool.maxPods} ({Math.round((pool.pods / pool.maxPods) * 100)}%)</p>
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* Forecast Charts */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <ForecastChart historical={data?.forecasts?.cpu?.historical} forecast={data?.forecasts?.cpu?.forecast} threshold={data?.forecasts?.cpu?.threshold} color="#ef4444" label="Cluster CPU Utilization" />
              <ForecastChart historical={data?.forecasts?.memory?.historical} forecast={data?.forecasts?.memory?.forecast} threshold={data?.forecasts?.memory?.threshold} color="#a855f7" label="Cluster Memory Utilization" />
            </div>

            {/* Autoscaler Events */}
            {(data?.autoscalerEvents?.length ?? 0) > 0 && (
              <Card className="border border-border shadow-sm" data-testid="autoscaler-events">
                <CardHeader className="pb-3 border-b border-border">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <Activity className="w-4 h-4 text-green-400" /> Autoscaler Activity
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left text-muted-foreground font-medium px-4 py-2">Time</th>
                        <th className="text-left text-muted-foreground font-medium px-4 py-2">Type</th>
                        <th className="text-left text-muted-foreground font-medium px-4 py-2">Detail</th>
                        <th className="text-left text-muted-foreground font-medium px-4 py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.autoscalerEvents.map((ev: any, i: number) => (
                        <tr key={i} className="border-b border-border hover:bg-muted/20 transition-colors">
                          <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">{formatDistanceToNow(new Date(ev.ts), { addSuffix: true })}</td>
                          <td className="px-4 py-2">
                            <span className={`text-[10px] px-2 py-0.5 rounded border font-bold ${ev.type === "ScaleOut" ? "bg-blue-500/10 text-blue-400 border-blue-500/20" : "bg-green-500/10 text-green-400 border-green-500/20"}`}>{ev.type}</span>
                          </td>
                          <td className="px-4 py-2 text-muted-foreground">{ev.detail}</td>
                          <td className="px-4 py-2">
                            <span className="flex items-center gap-1 text-green-400"><CheckCircle2 className="w-3 h-3" />{ev.status}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            )}

            {/* Throttling Events */}
            {(data?.throttlingEvents?.length ?? 0) > 0 && (
              <Card className="border border-amber-500/20 bg-amber-950/10 shadow-sm" data-testid="throttling-events">
                <CardHeader className="pb-3 border-b border-amber-500/10">
                  <CardTitle className="text-sm font-semibold text-amber-300 flex items-center gap-2">
                    <Zap className="w-4 h-4" /> CPU Throttling / OOM Events
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4 space-y-3">
                  {data.throttlingEvents.map((ev: any, i: number) => (
                    <div key={i} className="rounded-xl border border-border bg-muted/10 p-3">
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-xs font-bold text-foreground">{ev.service}</p>
                        <span className="text-[10px] text-muted-foreground">{formatDistanceToNow(new Date(ev.ts), { addSuffix: true })} · {ev.duration}</span>
                      </div>
                      <p className="text-[11px] text-amber-400">{ev.reason}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">Impact: {ev.impact}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </div>

          {/* Right sidebar: Recommendations + quick links */}
          <div className="space-y-5">
            {/* New Node Alert */}
            {data?.daysToNewNode && (
              <div data-testid="days-to-new-node" className="rounded-xl border border-red-500/30 bg-red-950/20 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle className="w-4 h-4 text-red-400" />
                  <p className="text-sm font-bold text-red-300">New Node Required</p>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">At current growth rate, the frontend-pool will exhaust capacity in <strong className="text-red-400">{data.daysToNewNode} days</strong>. Provision now to maintain headroom.</p>
              </div>
            )}

            {/* Recommendations */}
            <Card className="border border-indigo-500/20 bg-indigo-950/20 shadow-sm" data-testid="cluster-recommendations">
              <CardHeader className="pb-3 border-b border-indigo-500/10">
                <CardTitle className="text-sm font-semibold text-indigo-300 flex items-center gap-2">
                  <BrainCircuit className="w-4 h-4" /> AI Recommendations
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-3">
                {(data?.recommendations ?? []).map((r: any) => (
                  <div key={r.id} data-testid={`cluster-rec-${r.id}`} className="rounded-xl border border-border bg-muted/10 p-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs font-semibold text-foreground leading-snug">{r.action}</p>
                      <span className={`shrink-0 text-[9px] font-bold px-2 py-0.5 rounded border ${PRIORITY_COLORS[r.priority] ?? PRIORITY_COLORS.Info}`}>{r.priority}</span>
                    </div>
                    <div className="flex items-center gap-3 text-[10px]">
                      <span className="text-muted-foreground">Confidence: <strong className="text-indigo-400">{Math.round(r.confidence * 100)}%</strong></span>
                      <span className="text-muted-foreground">Cost: <strong className="text-foreground">{r.costImpact}</strong></span>
                    </div>
                    <button data-testid={`cluster-action-${r.id}`} className="w-full text-[10px] font-semibold text-indigo-300 border border-indigo-500/20 bg-indigo-500/5 rounded-lg py-1.5 hover:bg-indigo-500/10 transition-colors">
                      Apply Policy →
                    </button>
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* Pending Pods */}
            {cur.pendingPods > 0 && (
              <div data-testid="pending-pods-alert" className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-4">
                <p className="text-sm font-bold text-amber-300 flex items-center gap-2 mb-1"><Clock className="w-4 h-4" />{cur.pendingPods} Pods Pending</p>
                <p className="text-xs text-muted-foreground">Pods are waiting for schedulable nodes. Current capacity is insufficient to schedule them immediately.</p>
              </div>
            )}

            {/* Quick Links */}
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-3 border-b border-border">
                <CardTitle className="text-sm font-semibold">Quick Navigation</CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-2">
                {[
                  { label: "Global Capacity Planning", href: "/capacity-planning", icon: <TrendingUp className="w-3.5 h-3.5" /> },
                  { label: "E-Commerce Capacity", href: "/applications/1/capacity", icon: <Activity className="w-3.5 h-3.5" /> },
                  { label: "Active Alerts", href: "/alerts", icon: <AlertTriangle className="w-3.5 h-3.5" /> },
                  { label: "Active Incidents", href: "/incidents/INC-0042", icon: <ExternalLink className="w-3.5 h-3.5" /> },
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
