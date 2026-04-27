import { useMemo, useState } from "react";
import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/StatusBadge";
import {
  Cpu, MemoryStick, HardDrive, Wifi, Server, BrainCircuit,
  AlertTriangle, CheckCircle2, ChevronRight, Clock, Gauge,
  TrendingUp, Info, ShieldAlert, Bell, Flame, ExternalLink
} from "lucide-react";
import { CorrelationContextBar } from "@/components/shared/CorrelationContextBar";
import { AICorrelationPanel } from "@/components/shared/AICorrelationPanel";
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine
} from "recharts";
import { format, formatDistanceToNow } from "date-fns";

function ResourceChart({
  data,
  forecast,
  dataKey,
  forecastKey,
  color,
  unit,
  threshold,
  title,
  yDomain = [0, 100],
  xTickFormatter,
  tooltipLabelFormatter,
}: any) {
  const safeData = Array.isArray(data) ? data : [];
  const safeForecast = Array.isArray(forecast) ? forecast : [];
  const combined = [
    ...safeData.map((d: any) => {
      const v = Number(d?.[dataKey] ?? 0);
      if (forecastKey === dataKey) {
        return { ...d, [dataKey]: Number.isFinite(v) ? v : 0, upper: null, lower: null };
      }
      return {
        ...d,
        [dataKey]: Number.isFinite(v) ? v : 0,
        [forecastKey]: null,
        upper: null,
        lower: null,
      };
    }),
    ...safeForecast.map((d: any) => {
      const fv = Number(d?.[forecastKey] ?? 0);
      return {
        timestamp: d?.timestamp,
        [dataKey]: null,
        [forecastKey]: Number.isFinite(fv) ? fv : 0,
        upper: Number.isFinite(fv) ? fv + 5 : 5,
        lower: Number.isFinite(fv) ? Math.max(0, fv - 5) : 0,
      };
    })
  ];

  return (
    <Card className="border border-border shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{title}</CardTitle>
      </CardHeader>
      <CardContent className="h-[180px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={combined} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
            <XAxis
              dataKey="timestamp"
              tickFormatter={(v) => (xTickFormatter ? xTickFormatter(v) : format(new Date(v), "HH:mm"))}
              stroke="hsl(var(--muted-foreground))"
              fontSize={10}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
              minTickGap={24}
            />
            <YAxis stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={false} domain={yDomain} tickFormatter={v => `${v}${unit}`} />
            <Tooltip
              labelFormatter={(v) => (tooltipLabelFormatter ? tooltipLabelFormatter(v) : format(new Date(v), "HH:mm"))}
              formatter={(v: any) => [`${v?.toFixed(1)}${unit}`, ""]}
            />
            {threshold && <ReferenceLine y={threshold} stroke="#ef4444" strokeDasharray="4 2" />}
            <Area dataKey="upper" fill={color} fillOpacity={0.1} stroke="transparent" name=" " legendType="none" />
            <Area dataKey="lower" fill="white" fillOpacity={1} stroke="transparent" name=" " legendType="none" />
            <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2} dot={false} connectNulls={false} name="Historical" />
            <Line type="monotone" dataKey={forecastKey} stroke={color} strokeWidth={1.5} strokeDasharray="5 3" dot={false} connectNulls={false} name="Forecast" />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

export default function ServerDetail() {
  const { id, serverId } = useParams<{ id: string; serverId: string }>();
  const appId = parseInt(id || "0", 10);
  const srvId = parseInt(serverId || "0", 10);
  const [timeRange, setTimeRange] = useState<"5m" | "15m" | "1h" | "3h" | "1d" | "7d" | "30d" | "custom">("1d");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const canQuery = Number.isFinite(appId) && appId > 0 && Number.isFinite(srvId) && srvId > 0;
  const metricOpts = useMemo(() => {
    if (timeRange === "5m") return { durationMins: 5 };
    if (timeRange === "15m") return { durationMins: 15 };
    if (timeRange === "1h") return { durationMins: 60 };
    if (timeRange === "3h") return { durationMins: 3 * 60 };
    if (timeRange === "1d") return { durationMins: 24 * 60 };
    if (timeRange === "7d") return { durationMins: 7 * 24 * 60 };
    if (timeRange === "30d") return { durationMins: 30 * 24 * 60 };
    if (customStart && customEnd) {
      return {
        start: new Date(`${customStart}T00:00:00`).toISOString(),
        end: new Date(`${customEnd}T23:59:59`).toISOString(),
      };
    }
    return { durationMins: 24 * 60 };
  }, [timeRange, customStart, customEnd]);
  const toText = (value: unknown, fallback = "Unknown") => {
    const text = String(value ?? "").trim();
    return text.length > 0 ? text : fallback;
  };
  const formatLastSync = (value: unknown) => {
    if (!value) return "-";
    const parsed = new Date(String(value));
    if (Number.isNaN(parsed.getTime())) return "-";
    return formatDistanceToNow(parsed, { addSuffix: true });
  };

  const { data: srv, isLoading, isError } = useQuery<any>({
    queryKey: [`/api/applications/${appId}/servers/${srvId}`, metricOpts.durationMins, metricOpts.start, metricOpts.end],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (metricOpts.durationMins) params.set("durationMins", String(metricOpts.durationMins));
      if (metricOpts.start) params.set("start", metricOpts.start);
      if (metricOpts.end) params.set("end", metricOpts.end);
      const qs = params.toString();
      const url = qs
        ? `/api/applications/${appId}/servers/${srvId}?${qs}`
        : `/api/applications/${appId}/servers/${srvId}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load server details");
      return res.json();
    },
    enabled: canQuery,
  });
  const relatedNodeId = String(srv?.externalId ?? srv?.id ?? srvId);
  const { data: app } = useQuery<any>({ queryKey: [`/api/applications/${appId}`] });
  const { data: related } = useQuery<any>({
    queryKey: [`/api/nodes/${relatedNodeId}/related`],
    enabled: !!relatedNodeId,
  });

  if (isLoading) return (
    <AppLayout appId={appId}>
      <div className="space-y-4">{Array(3).fill(0).map((_, i) => <Skeleton key={i} className="h-48" />)}</div>
    </AppLayout>
  );
  if (isError || !srv || srv?.message) {
    return (
      <AppLayout appId={appId}>
        <Card className="border border-border shadow-sm">
          <CardContent className="p-6 text-sm text-muted-foreground">
            Unable to load this server right now.
          </CardContent>
        </Card>
      </AppLayout>
    );
  }

  const chartHistory = Array.isArray(srv?.resourceHistory) ? srv.resourceHistory : [];
  const chartForecast = Array.isArray(srv?.forecast) ? srv.forecast : [];
  const xTickFormatter = (v: number) => {
    const ts = Number(v ?? 0);
    const d = new Date(ts);
    if (timeRange === "5m" || timeRange === "15m" || timeRange === "1h" || timeRange === "3h") return format(d, "HH:mm");
    if (timeRange === "1d") return format(d, "HH:mm");
    if (timeRange === "7d" || timeRange === "30d") return format(d, "MMM d");
    const customSpanDays = customStart && customEnd
      ? Math.max(0, (new Date(`${customEnd}T23:59:59`).getTime() - new Date(`${customStart}T00:00:00`).getTime()) / (24 * 60 * 60 * 1000))
      : 0;
    return customSpanDays > 2 ? format(d, "MMM d") : format(d, "MMM d HH:mm");
  };
  const tooltipLabelFormatter = (v: number) => {
    const ts = Number(v ?? 0);
    const d = new Date(ts);
    if (timeRange === "7d" || timeRange === "30d") return format(d, "MMM d, HH:mm");
    if (timeRange === "custom") return format(d, "MMM d, HH:mm");
    return format(d, "MMM d, HH:mm");
  };

  return (
    <AppLayout appId={appId}>
      <div className="space-y-5">
        {/* Breadcrumb */}
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground flex-wrap">
          <Link href={`/applications/${appId}`} className="hover:text-foreground transition-colors">{app?.name ?? "App"}</Link>
          <ChevronRight className="w-3 h-3" />
          <Link href={`/applications/${appId}/tier-nodes`} className="hover:text-foreground transition-colors">Tiers & Nodes</Link>
          <ChevronRight className="w-3 h-3" />
          <span className="text-foreground font-medium">{toText(srv?.name, `Node-${srvId}`)}</span>
        </div>

        {/* ── CORRELATION CONTEXT BAR ── */}
        <CorrelationContextBar entityId={`node-${srvId}`} entityType="node" />

        {/* Server Header */}
        <div className="bg-card border border-border rounded-xl p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-4">
              <div className="p-3 rounded-xl bg-primary/10 border border-primary/20">
                <Server className="w-6 h-6 text-primary" />
              </div>
              <div>
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <h1 className="text-xl font-bold text-foreground font-mono">{toText(srv?.name, `Node-${srvId}`)}</h1>
                  <StatusBadge status={srv?.status} />
                  {srv?.alerts > 0 && (
                    <Badge className="bg-red-500/10 text-red-400 border border-red-500/20">{srv.alerts} alerts</Badge>
                  )}
                </div>
                <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                  <span>IP: <strong className="text-foreground">{toText(srv?.ip ?? srv?.ipAddress, "N/A")}</strong></span>
                  <span>Role: <strong className="text-foreground">{toText(srv?.role ?? srv?.tier)}</strong></span>
                  <span>OS: <strong className="text-foreground">{toText(srv?.os)}</strong></span>
                  <span>Runtime: <strong className="text-foreground">{toText(srv?.runtime)}</strong></span>
                  <span>Pod: <strong className="text-foreground font-mono">{toText(srv?.pod, "N/A")}</strong></span>
                </div>
              </div>
            </div>
            <div className="text-xs text-muted-foreground text-right">
              <p>Last sync: {formatLastSync(srv?.lastSyncAt ?? srv?.lastSync)}</p>
              {srv?.projectedSaturationDate && (
                <p className="text-red-400 font-medium mt-1 flex items-center gap-1 justify-end">
                  <AlertTriangle className="w-3 h-3" />
                  Projected saturation: {format(new Date(srv.projectedSaturationDate), 'MMM d, yyyy')}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Resource Charts */}
        <div>
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Gauge className="w-4 h-4 text-muted-foreground" /> Resource Utilization & Forecast
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              {(["5m", "15m", "1h", "3h", "1d", "7d", "30d", "custom"] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setTimeRange(r)}
                  className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                    timeRange === r
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-card text-muted-foreground border-border hover:text-foreground"
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
            {timeRange === "custom" && (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="date"
                  value={customStart}
                  onChange={(e) => setCustomStart(e.target.value)}
                  className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
                />
                <input
                  type="date"
                  value={customEnd}
                  onChange={(e) => setCustomEnd(e.target.value)}
                  className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
                />
              </div>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <ResourceChart
              title="CPU Usage" data={chartHistory} forecast={chartForecast}
              dataKey="cpu" forecastKey="cpuPredicted"
              color="#ef4444" unit="%" threshold={90}
              yDomain={[0, 100]}
              xTickFormatter={xTickFormatter}
              tooltipLabelFormatter={tooltipLabelFormatter}
            />
            <ResourceChart
              title="Memory Usage" data={chartHistory} forecast={chartForecast}
              dataKey="memory" forecastKey="memPredicted"
              color="#6366f1" unit="%" threshold={85}
              yDomain={[0, 100]}
              xTickFormatter={xTickFormatter}
              tooltipLabelFormatter={tooltipLabelFormatter}
            />
            <ResourceChart
              title="Disk Usage" data={chartHistory} forecast={null}
              dataKey="disk" forecastKey="disk"
              color="#f59e0b" unit="%" threshold={80}
              yDomain={[0, 100]}
              xTickFormatter={xTickFormatter}
              tooltipLabelFormatter={tooltipLabelFormatter}
            />
            <ResourceChart
              title="Network I/O (Mbps)" data={chartHistory} forecast={null}
              dataKey="network" forecastKey="network"
              color="#22c55e" unit="" threshold={null}
              yDomain={[0, "auto"]}
              xTickFormatter={xTickFormatter}
              tooltipLabelFormatter={tooltipLabelFormatter}
            />
          </div>
        </div>

        {/* Process List */}
        <Card className="border border-border shadow-sm">
          <CardHeader className="pb-3 border-b border-border">
            <CardTitle className="text-sm font-semibold">Process List</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-muted-foreground text-xs border-b border-border">
                <tr>
                  <th className="px-5 py-3 text-left">Process</th>
                  <th className="px-5 py-3 text-right">PID</th>
                  <th className="px-5 py-3 text-right">CPU %</th>
                  <th className="px-5 py-3 text-right">Memory (MB)</th>
                  <th className="px-5 py-3 text-center">Status</th>
                  <th className="px-5 py-3 text-center">Anomaly</th>
                  <th className="px-5 py-3 text-center">Drilldown</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {srv?.processes?.map((p: any) => {
                  const qs = new URLSearchParams({
                    service: toText(p?.name, "process"),
                    appId: String(appId),
                    serverId: String(srvId),
                    pid: String(p?.pid ?? ""),
                    serverName: toText(srv?.name, `Node-${srvId}`),
                  }).toString();
                  const drilldownHref = `/runtime/process?${qs}`;
                  return (
                    <tr key={p.pid} className={`hover:bg-muted/20 ${p.anomaly ? "bg-red-500/5" : ""}`}>
                      <td className="px-5 py-3 font-mono text-xs font-medium text-foreground">
                        <Link href={drilldownHref} className="inline-flex items-center gap-1.5 text-primary hover:underline">
                          <span>{p.name}</span>
                          <ExternalLink className="w-3 h-3" />
                        </Link>
                      </td>
                      <td className="px-5 py-3 text-right font-mono text-xs text-muted-foreground">{p.pid}</td>
                      <td className={`px-5 py-3 text-right font-mono text-xs ${p.cpu > 50 ? "text-red-400 font-bold" : "text-foreground"}`}>{p.cpu}</td>
                      <td className="px-5 py-3 text-right font-mono text-xs text-foreground">{p.memory.toLocaleString()}</td>
                      <td className="px-5 py-3 text-center">
                        <span className="text-xs text-green-500 font-medium">{p.status}</span>
                      </td>
                      <td className="px-5 py-3 text-center">
                        {p.anomaly ? <AlertTriangle className="w-4 h-4 text-red-400 mx-auto" /> : <span className="text-xs text-muted-foreground">-</span>}
                      </td>
                      <td className="px-5 py-3 text-center">
                        <Link href={drilldownHref} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                          Open
                          <ExternalLink className="w-3 h-3" />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
                {(!srv?.processes || srv.processes.length === 0) && (
                  <tr>
                    <td colSpan={7} className="px-5 py-6 text-center text-xs text-muted-foreground">
                      No process telemetry available for this node yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>

        {/* Problems */}
        <Card className="border border-border shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400" /> Problems (Real + Forecast)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {srv?.problems?.map((p: any) => (
                <div key={p.id} className={`flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 ${p.severity === "Critical" ? "border-red-500/30 bg-red-500/5" : "border-yellow-500/20 bg-yellow-500/5"}`}>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 flex-wrap mb-0.5">
                      <span className="font-semibold text-sm text-foreground">{p.title}</span>
                      <Badge className={p.severity === "Critical" ? "bg-red-500/10 text-red-400 border-red-500/20 text-xs" : "bg-yellow-500/10 text-yellow-400 border-yellow-500/20 text-xs"}>{p.severity}</Badge>
                      <Badge variant="secondary" className="text-xs">{p.type}</Badge>
                    </div>
                    {p.since && <p className="text-xs text-muted-foreground">Since: {formatDistanceToNow(new Date(p.since), { addSuffix: true })} · Duration: {p.duration}</p>}
                    {p.expectedAt && <p className="text-xs text-muted-foreground">Expected: {format(new Date(p.expectedAt), 'MMM d, yyyy')} · Confidence: {p.confidence}%</p>}
                  </div>
                </div>
              ))}
              {(!srv?.problems || srv.problems.length === 0) && <p className="text-sm text-muted-foreground">No problems detected.</p>}
            </div>
          </CardContent>
        </Card>

        {/* Causal Insights */}
        {srv?.causalInsights && (
          <div>
            <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
              <BrainCircuit className="w-4 h-4 text-indigo-400" /> Causal AI Insights
              <Badge className="bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 text-xs">{srv.causalInsights.confidence}% confidence</Badge>
            </h2>

            {/* Root cause */}
            <div className="bg-muted/30 border border-indigo-500/20 rounded-xl p-5 mb-4">
              <p className="text-xs text-indigo-400 font-semibold mb-2 uppercase tracking-wide">Root Cause Hypothesis</p>
              <p className="text-foreground text-sm leading-relaxed">{srv.causalInsights.rootCauseHypothesis}</p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Correlations */}
              <Card className="border border-border shadow-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Metric Correlations</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {srv.causalInsights.correlations.map((c: any) => (
                      <div key={c.factor}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-medium text-foreground">{c.factor}</span>
                          <span className="text-xs font-bold text-indigo-400">{(c.strength * 100).toFixed(0)}%</span>
                        </div>
                        <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden mb-1">
                          <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${c.strength * 100}%` }} />
                        </div>
                        <p className="text-[11px] text-muted-foreground">{c.description}</p>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Recommended Actions */}
              <Card className="border border-border shadow-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Recommended Actions</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {srv.causalInsights.recommendedActions.map((a: any, i: number) => (
                      <div key={i} className={`rounded-lg border px-3 py-2.5 ${a.priority === "Critical" ? "border-red-500/20 bg-red-500/5" : a.priority === "High" ? "border-amber-500/20 bg-amber-500/5" : "border-border bg-muted/10"}`}>
                        <div className="flex items-start gap-2">
                          <Badge className={`text-xs shrink-0 mt-0.5 ${a.priority === "Critical" ? "bg-red-500/10 text-red-400 border-red-500/20" : a.priority === "High" ? "bg-amber-500/10 text-amber-400 border-amber-500/20" : "bg-muted text-muted-foreground border-border"}`}>{a.priority}</Badge>
                          <div>
                            <p className="text-xs font-medium text-foreground">{a.action}</p>
                            <p className="text-[10px] text-muted-foreground mt-0.5">Effort: {a.effort}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        {/* ── RELATED INCIDENTS ── */}
        {related?.incidents?.length > 0 && (
          <Card data-testid="node-related-incidents" className="border border-red-500/20 bg-red-950/10 shadow-sm">
            <CardHeader className="pb-3 border-b border-border">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-red-400" /> Active Incidents on this Node
                <Badge className="ml-auto bg-red-500/10 text-red-400 border-red-500/20">{related.incidents.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-2">
              {related.incidents.map((inc: any) => (
                <Link key={inc.id} href={`/incidents/${inc.id}`} data-testid={`node-incident-${inc.id}`}
                  className="flex items-center justify-between rounded-xl border border-border hover:border-red-500/30 bg-muted/10 hover:bg-red-500/5 px-4 py-3 transition-colors">
                  <div className="flex items-center gap-3">
                    <ShieldAlert className="w-4 h-4 text-red-400 shrink-0" />
                    <div>
                      <p className="text-sm font-bold text-foreground">{inc.id}</p>
                      <p className="text-xs text-muted-foreground">{inc.title}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-[10px] px-2 py-0.5 rounded border font-bold bg-red-500/10 text-red-400 border-red-500/20">{inc.severity}</span>
                    {typeof inc.correlationScore === "number" ? (
                      <div className="flex items-center gap-1.5">
                        <div className="w-10 h-1.5 bg-muted rounded-full overflow-hidden">
                          <div className="h-full bg-red-500 rounded-full" style={{ width: `${Math.round(inc.correlationScore * 100)}%` }} />
                        </div>
                        <span className="text-[10px] text-red-400">{Math.round(inc.correlationScore * 100)}%</span>
                      </div>
                    ) : (
                      <span className="text-[10px] px-2 py-0.5 rounded border bg-muted/20 border-border text-muted-foreground">{inc.status ?? "Open"}</span>
                    )}
                    <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                  </div>
                </Link>
              ))}
            </CardContent>
          </Card>
        )}

        {/* ── RELATED ALERTS ── */}
        {related?.alerts?.length > 0 && (
          <Card data-testid="node-related-alerts" className="border border-border shadow-sm">
            <CardHeader className="pb-3 border-b border-border">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Bell className="w-4 h-4 text-amber-400" /> Active Alerts on this Node
                <Badge className="ml-auto bg-amber-500/10 text-amber-400 border-amber-500/20">{related.alerts.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-xs">
                <thead><tr className="border-b border-border">
                  <th className="text-left text-muted-foreground px-4 py-2 font-medium">Alert</th>
                  <th className="text-left text-muted-foreground px-4 py-2 font-medium">Rule</th>
                  <th className="text-left text-muted-foreground px-4 py-2 font-medium">Severity</th>
                  <th className="px-4 py-2"></th>
                </tr></thead>
                <tbody>
                  {related.alerts.map((a: any) => (
                    <tr key={a.alertId} className="border-b border-border hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-2 font-mono text-muted-foreground">{a.alertId}</td>
                      <td className="px-4 py-2 font-medium">{a.rule ?? a.name ?? a.entity ?? "Alert"}</td>
                      <td className="px-4 py-2"><span className={`px-2 py-0.5 rounded border text-[10px] font-bold ${a.severity === "Critical" ? "bg-red-500/10 text-red-400 border-red-500/20" : "bg-amber-500/10 text-amber-400 border-amber-500/20"}`}>{a.severity}</span></td>
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
          <Card data-testid="node-related-errors" className="border border-border shadow-sm">
            <CardHeader className="pb-3 border-b border-border">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Flame className="w-4 h-4 text-orange-400" /> Errors from this Node
                <Badge className="ml-auto bg-orange-500/10 text-orange-400 border-orange-500/20">{related.errors.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-xs">
                <thead><tr className="border-b border-border">
                  <th className="text-left text-muted-foreground px-4 py-2 font-medium">Error</th>
                  <th className="text-left text-muted-foreground px-4 py-2 font-medium">Request Path</th>
                  <th className="text-left text-muted-foreground px-4 py-2 font-medium">Root Cause</th>
                  <th className="text-left text-muted-foreground px-4 py-2 font-medium">Message</th>
                  <th className="text-left text-muted-foreground px-4 py-2 font-medium">Occurrences</th>
                  <th className="px-4 py-2"></th>
                </tr></thead>
                <tbody>
                  {related.errors.map((e: any) => (
                    <tr key={e.errorId} className="border-b border-border hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-2 font-mono text-muted-foreground">{e.errorId}</td>
                      <td className="px-4 py-2 font-mono text-[10px] text-primary max-w-[220px] truncate">{e.requestPath ?? "—"}</td>
                      <td className="px-4 py-2 text-[11px] max-w-xs truncate text-muted-foreground">{e.rootCause ?? "—"}</td>
                      <td className="px-4 py-2 font-medium max-w-xs truncate">{e.message ?? e.type ?? "Error"}</td>
                      <td className="px-4 py-2">{(e.occurrences ?? 0).toLocaleString()}</td>
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

        {/* AI Correlation Panel */}
        {related?.aiCorrelation && <AICorrelationPanel data={related.aiCorrelation} title="AI Node Correlation Insights" />}

      </div>
    </AppLayout>
  );
}




