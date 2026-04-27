import { Link, useParams, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { BrainCircuit, AlertTriangle, Cpu, Server, Bell, Flame, ExternalLink } from "lucide-react";
import { ComposedChart, Line, Area, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { format } from "date-fns";

function AnomalyDot(props: any) {
  const { cx, cy, payload } = props;
  if (!payload || payload.gcTime < 500) return null;
  return <circle cx={cx} cy={cy} r={6} fill="#ef4444" stroke="white" strokeWidth={2} />;
}

export default function RuntimeView() {
  const search = useSearch();
  const { service } = useParams<{ service: string }>();
  const searchParams = new URLSearchParams(search);
  const serviceFromQuery = searchParams.get("service") ?? "";
  const svcName = decodeURIComponent(serviceFromQuery || service || "process");
  const appId = searchParams.get("appId") ?? "";
  const serverId = searchParams.get("serverId") ?? "";
  const pid = searchParams.get("pid") ?? "";
  const serverName = searchParams.get("serverName") ?? "";
  const { data, isLoading } = useQuery<any>({
    queryKey: ["/api/runtime", search, svcName, appId, serverId, pid],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (appId) qs.set("appId", appId);
      if (serverId) qs.set("serverId", serverId);
      if (pid) qs.set("pid", pid);
      if (serverName) qs.set("serverName", serverName);
      qs.set("service", svcName);
      const res = await fetch(`/api/runtime?${qs.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load runtime details");
      return res.json();
    },
  });

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-2xl font-bold text-foreground">{data?.service || svcName || "Runtime Deep Observability"}</h1>
            </div>
            <p className="text-muted-foreground text-sm">JVM / .NET CLR runtime metrics with AI anomaly detection and recommendations.</p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              {appId && <Badge variant="secondary">App: {appId}</Badge>}
              {serverId && <Badge variant="secondary">Node: {serverName || serverId}</Badge>}
              {pid && <Badge variant="secondary">PID: {pid}</Badge>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {(data?.relatedProcesses ?? []).map((p: any) => {
              const qs = new URLSearchParams();
              if (appId) qs.set("appId", appId);
              if (serverId) qs.set("serverId", serverId);
              if (serverName) qs.set("serverName", serverName);
              qs.set("pid", String(p?.pid ?? ""));
              qs.set("service", String(p?.name ?? "process"));
              const href = `/runtime/process?${qs.toString()}`;
              const active = String(p?.name ?? "").toLowerCase() === String(data?.service ?? svcName).toLowerCase();
              return (
                <Link key={`${p?.name}-${p?.pid}`} href={href} className={`px-3 py-1.5 rounded border text-xs font-medium transition-colors ${active ? "bg-primary/10 border-primary/30 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}>
                  {String(p?.name ?? "process")}
                </Link>
              );
            })}
          </div>
        </div>

        {/* Service info + AI Insight */}
        {!isLoading && data && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-1 bg-card border border-border rounded-xl p-5">
              <div className="flex items-center gap-3 mb-4">
                <Server className="w-5 h-5 text-muted-foreground" />
                <div>
                  <p className="font-bold text-foreground">{data.service}</p>
                  <p className="text-xs text-muted-foreground">{data.runtime} Runtime</p>
                </div>
              </div>
              <div className="space-y-2">
                {data.anomalies?.map((a: any) => (
                  <div key={a.metric} className={`rounded-lg border px-3 py-2 text-xs ${a.severity === 'Critical' ? 'border-red-500/30 bg-red-500/5 text-red-400' : 'border-yellow-500/30 bg-yellow-500/5 text-yellow-400'}`}>
                    <div className="flex items-center gap-1.5 font-semibold mb-0.5">
                      <AlertTriangle className="w-3 h-3" />{a.metric}
                    </div>
                    <p>Value: <strong>{a.value}</strong> / Threshold: {a.threshold}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="lg:col-span-2 bg-card border border-indigo-500/30 rounded-xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <BrainCircuit className="w-4 h-4 text-indigo-400" />
                <span className="font-semibold text-sm text-foreground">AI Runtime Insight</span>
                <Badge className="bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 text-xs">Auto-generated</Badge>
              </div>
              <p className="text-foreground text-sm leading-relaxed">{data.aiInsight}</p>
            </div>
          </div>
        )}

        {/* GC + CPU Chart (anomaly highlighted) */}
        <Card className="border border-border shadow-sm">
          <CardHeader>
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Cpu className="w-4 h-4" /> Runtime Metrics — Anomaly Highlighted
            </CardTitle>
          </CardHeader>
          <CardContent className="h-[320px]">
            {isLoading ? <Skeleton className="h-full" /> : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={data?.metrics} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="timestamp" tickFormatter={v => format(new Date(v), 'HH:mm')} stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis yAxisId="left" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis yAxisId="right" orientation="right" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                  <Tooltip labelFormatter={v => format(new Date(v), 'HH:mm:ss')} />
                  <ReferenceLine yAxisId="left" y={200} stroke="#ef4444" strokeDasharray="4 2" label={{ value: "GC Threshold", fill: "#ef4444", fontSize: 10 }} />
                  <Area yAxisId="left" type="monotone" dataKey="gcTime" name="GC Pause (ms)" fill="#ef4444" fillOpacity={0.15} stroke="#ef4444" strokeWidth={2} dot={<AnomalyDot />} />
                  <Line yAxisId="right" type="monotone" dataKey="cpuUsage" name="CPU %" stroke="#6366f1" strokeWidth={2} dot={false} />
                  <Line yAxisId="right" type="monotone" dataKey="heapUsed" name="Heap %" stroke="#f59e0b" strokeWidth={2} dot={false} strokeDasharray="4 2" />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Related alerts/errors */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="border border-border shadow-sm">
            <CardHeader className="pb-3 border-b border-border">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Bell className="w-4 h-4 text-amber-400" /> Related Alerts
                <Badge className="ml-auto bg-amber-500/10 text-amber-400 border-amber-500/20">
                  {(data?.relatedAlerts ?? []).length}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {(data?.relatedAlerts ?? []).length > 0 ? (
                <div className="divide-y divide-border">
                  {(data?.relatedAlerts ?? []).map((a: any) => (
                    <Link key={a.alertId} href={a.href ?? `/alerts/${a.alertId}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted/20 transition-colors">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{a.name ?? a.alertId}</p>
                        <p className="text-xs text-muted-foreground font-mono truncate">{a.alertId}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`px-2 py-0.5 rounded border text-[10px] font-bold ${a.severity === "Critical" ? "bg-red-500/10 text-red-400 border-red-500/20" : "bg-amber-500/10 text-amber-400 border-amber-500/20"}`}>
                          {a.severity ?? "Warning"}
                        </span>
                        <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                      </div>
                    </Link>
                  ))}
                </div>
              ) : (
                <p className="px-4 py-6 text-xs text-muted-foreground">No related alerts found for this process.</p>
              )}
            </CardContent>
          </Card>

          <Card className="border border-border shadow-sm lg:col-span-2">
            <CardHeader className="pb-3 border-b border-border">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Flame className="w-4 h-4 text-orange-400" /> Related Errors
                <Badge className="ml-auto bg-orange-500/10 text-orange-400 border-orange-500/20">
                  {(data?.relatedErrors ?? []).length}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {(data?.relatedErrors ?? []).length > 0 ? (
                <div className="w-full overflow-x-auto">
                <table className="w-full min-w-[900px] text-xs">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left text-muted-foreground px-4 py-2 font-medium">Error</th>
                      <th className="text-left text-muted-foreground px-4 py-2 font-medium">Service</th>
                      <th className="text-left text-muted-foreground px-4 py-2 font-medium">Request Path</th>
                      <th className="text-left text-muted-foreground px-4 py-2 font-medium">Root Cause</th>
                      <th className="text-left text-muted-foreground px-4 py-2 font-medium">Message</th>
                      <th className="text-left text-muted-foreground px-4 py-2 font-medium">Occurrences</th>
                      <th className="px-4 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.relatedErrors ?? []).map((e: any) => (
                      <tr key={e.errorId} className="border-b border-border hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-2">
                          <div className="flex flex-col gap-1">
                            <Link href={e.href ?? `/errors/${e.errorId}`} className="font-mono text-muted-foreground hover:text-primary hover:underline">
                              {e.errorId}
                            </Link>
                            <span className="text-[10px] text-muted-foreground truncate">{e.errorType ?? "Application Error"}</span>
                          </div>
                        </td>
                        <td className="px-4 py-2 max-w-[150px] truncate">{e.service || "N/A"}</td>
                        <td className="px-4 py-2 font-mono text-[10px] text-primary max-w-[180px] truncate">{e.requestPath || "—"}</td>
                        <td className="px-4 py-2 text-[11px] max-w-[200px] truncate text-muted-foreground">{e.rootCause || "—"}</td>
                        <td className="px-4 py-2 font-medium max-w-[320px]">
                          <Link href={e.href ?? `/errors/${e.errorId}`} className="text-foreground hover:text-primary hover:underline block truncate" title={e.message || "Error"}>
                            {e.message || "Error"}
                          </Link>
                        </td>
                        <td className="px-4 py-2">{Number(e.occurrences ?? 0).toLocaleString()}</td>
                        <td className="px-4 py-2">
                          <Link href={e.href ?? `/errors/${e.errorId}`} className="text-indigo-400 hover:text-indigo-300 flex items-center gap-1 whitespace-nowrap">
                            View <ExternalLink className="w-3 h-3" />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              ) : (
                <p className="px-4 py-6 text-xs text-muted-foreground">No related errors found for this process.</p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Thread + Exception rate */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="border border-border shadow-sm">
            <CardHeader><CardTitle className="text-base font-semibold">Thread Count</CardTitle></CardHeader>
            <CardContent className="h-[200px]">
              {isLoading ? <Skeleton className="h-full" /> : (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={data?.metrics} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="timestamp" tickFormatter={v => format(new Date(v), 'HH:mm')} stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                    <Tooltip />
                    <Line type="monotone" dataKey="threadCount" name="Thread Count" stroke="#22c55e" strokeWidth={2} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <Card className="border border-border shadow-sm">
            <CardHeader><CardTitle className="text-base font-semibold">Exception Rate / min</CardTitle></CardHeader>
            <CardContent className="h-[200px]">
              {isLoading ? <Skeleton className="h-full" /> : (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={data?.metrics} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="timestamp" tickFormatter={v => format(new Date(v), 'HH:mm')} stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                    <Tooltip />
                    <Bar dataKey="exceptionRate" name="Exceptions/min" fill="#ef4444" fillOpacity={0.7} radius={[2, 2, 0, 0]} />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}
