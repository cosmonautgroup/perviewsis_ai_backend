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
import { CorrelationGraph } from "@/components/shared/CorrelationGraph";
import { AICorrelationPanel } from "@/components/shared/AICorrelationPanel";
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine
} from "recharts";
import { format, formatDistanceToNow } from "date-fns";

function ResourceChart({ data, forecast, dataKey, forecastKey, color, unit, threshold, title }: any) {
  const combined = [
    ...(data || []).map((d: any) => ({ ...d, [dataKey]: d[dataKey], [forecastKey]: null, upper: null, lower: null })),
    ...(forecast || []).map((d: any) => ({ timestamp: d.timestamp, [dataKey]: null, [forecastKey]: d[forecastKey], upper: d[forecastKey] + 5, lower: Math.max(0, d[forecastKey] - 5) }))
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
            <XAxis dataKey="timestamp" tickFormatter={v => format(new Date(v), 'HH:mm')} stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={false} interval={12} />
            <YAxis stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={false} domain={[0, 100]} tickFormatter={v => `${v}${unit}`} />
            <Tooltip labelFormatter={v => format(new Date(v), 'HH:mm')} formatter={(v: any) => [`${v?.toFixed(1)}${unit}`, ""]} />
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

  const { data: srv, isLoading } = useQuery<any>({
    queryKey: [`/api/applications/${appId}/servers/${srvId}`],
    queryFn: () => fetch(`/api/applications/${appId}/servers/${srvId}`).then(r => r.json())
  });
  const { data: app } = useQuery<any>({ queryKey: [`/api/applications/${appId}`] });
  const { data: related } = useQuery<any>({
    queryKey: [`/api/nodes/${srvId}/related`],
    queryFn: () => fetch(`/api/nodes/${srvId}/related`).then(r => r.json()),
    enabled: !!srvId,
  });

  if (isLoading) return (
    <AppLayout appId={appId}>
      <div className="space-y-4">{Array(3).fill(0).map((_, i) => <Skeleton key={i} className="h-48" />)}</div>
    </AppLayout>
  );

  return (
    <AppLayout appId={appId}>
      <div className="space-y-5">
        {/* Breadcrumb */}
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground flex-wrap">
          <Link href={`/applications/${appId}`} className="hover:text-foreground transition-colors">{app?.name ?? "App"}</Link>
          <ChevronRight className="w-3 h-3" />
          <Link href={`/applications/${appId}/servers`} className="hover:text-foreground transition-colors">Servers</Link>
          <ChevronRight className="w-3 h-3" />
          <span className="text-foreground font-medium">{srv?.name}</span>
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
                  <h1 className="text-xl font-bold text-foreground font-mono">{srv?.name}</h1>
                  <StatusBadge status={srv?.status} />
                  {srv?.alerts > 0 && (
                    <Badge className="bg-red-500/10 text-red-400 border border-red-500/20">{srv.alerts} alerts</Badge>
                  )}
                </div>
                <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                  <span>IP: <strong className="text-foreground">{srv?.ip}</strong></span>
                  <span>Role: <strong className="text-foreground">{srv?.role}</strong></span>
                  <span>OS: <strong className="text-foreground">{srv?.os}</strong></span>
                  <span>Runtime: <strong className="text-foreground">{srv?.runtime}</strong></span>
                  <span>Pod: <strong className="text-foreground font-mono">{srv?.pod}</strong></span>
                </div>
              </div>
            </div>
            <div className="text-xs text-muted-foreground text-right">
              <p>Last sync: {(srv?.lastSyncAt ?? srv?.lastSync) ? formatDistanceToNow(new Date(srv.lastSyncAt ?? srv.lastSync), { addSuffix: true }) : "—"}</p>
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
          <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <Gauge className="w-4 h-4 text-muted-foreground" /> Resource Utilization & Forecast
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <ResourceChart
              title="CPU Usage" data={srv?.resourceHistory} forecast={srv?.forecast}
              dataKey="cpu" forecastKey="cpuPredicted"
              color="#ef4444" unit="%" threshold={90}
            />
            <ResourceChart
              title="Memory Usage" data={srv?.resourceHistory} forecast={srv?.forecast}
              dataKey="memory" forecastKey="memPredicted"
              color="#6366f1" unit="%" threshold={85}
            />
            <ResourceChart
              title="Disk Usage" data={srv?.resourceHistory} forecast={null}
              dataKey="disk" forecastKey="disk"
              color="#f59e0b" unit="%" threshold={80}
            />
            <ResourceChart
              title="Network I/O (Mbps)" data={srv?.resourceHistory} forecast={null}
              dataKey="network" forecastKey="network"
              color="#22c55e" unit="" threshold={null}
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
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {srv?.processes?.map((p: any) => (
                  <tr key={p.pid} className={`hover:bg-muted/20 ${p.anomaly ? "bg-red-500/5" : ""}`}>
                    <td className="px-5 py-3 font-mono text-xs font-medium text-foreground">{p.name}</td>
                    <td className="px-5 py-3 text-right font-mono text-xs text-muted-foreground">{p.pid}</td>
                    <td className={`px-5 py-3 text-right font-mono text-xs ${p.cpu > 50 ? "text-red-400 font-bold" : "text-foreground"}`}>{p.cpu}</td>
                    <td className="px-5 py-3 text-right font-mono text-xs text-foreground">{p.memory.toLocaleString()}</td>
                    <td className="px-5 py-3 text-center">
                      <span className="text-xs text-green-500 font-medium">{p.status}</span>
                    </td>
                    <td className="px-5 py-3 text-center">
                      {p.anomaly ? <AlertTriangle className="w-4 h-4 text-red-400 mx-auto" /> : <span className="text-xs text-muted-foreground">—</span>}
                    </td>
                  </tr>
                ))}
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
                <Link key={inc.id} href={inc.href} data-testid={`node-incident-${inc.id}`}
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
                    <div className="flex items-center gap-1.5">
                      <div className="w-10 h-1.5 bg-muted rounded-full overflow-hidden">
                        <div className="h-full bg-red-500 rounded-full" style={{ width: `${Math.round(inc.correlationScore * 100)}%` }} />
                      </div>
                      <span className="text-[10px] text-red-400">{Math.round(inc.correlationScore * 100)}%</span>
                    </div>
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
                      <td className="px-4 py-2 font-medium">{a.rule ?? a.name}</td>
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
                  <th className="text-left text-muted-foreground px-4 py-2 font-medium">Message</th>
                  <th className="text-left text-muted-foreground px-4 py-2 font-medium">Occurrences</th>
                  <th className="px-4 py-2"></th>
                </tr></thead>
                <tbody>
                  {related.errors.map((e: any) => (
                    <tr key={e.errorId} className="border-b border-border hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-2 font-mono text-muted-foreground">{e.errorId}</td>
                      <td className="px-4 py-2 font-medium max-w-xs truncate">{e.message}</td>
                      <td className="px-4 py-2">{(e.occurrences || 0).toLocaleString()}</td>
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

        {/* ── CORRELATION GRAPH ── */}
        <div className="flex justify-start">
          <CorrelationGraph entityId={`node-${srvId}`} entityType="node" />
        </div>

        {/* ── AI CORRELATION PANEL ── */}
        {related?.aiCorrelation && <AICorrelationPanel data={related.aiCorrelation} title="AI Node Correlation Insights" />}

      </div>
    </AppLayout>
  );
}
