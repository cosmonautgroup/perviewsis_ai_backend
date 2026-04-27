import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { useAppMetrics, useNodes } from "@/hooks/use-applications";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import { Server, AlertTriangle, ChevronRight, Cpu } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface ServersListProps {
  mode?: "servers" | "tier-nodes";
}

export default function ServersList({ mode = "servers" }: ServersListProps) {
  const { id } = useParams<{ id: string }>();
  const queryParams = new URLSearchParams(window.location.search);
  const sourceIncidentId = queryParams.get("incidentId") ?? "";
  const appId = parseInt(id || "0", 10);
  const canQuery = Number.isFinite(appId) && appId > 0;
  const detailBasePath = mode === "tier-nodes" ? "tier-nodes" : "servers";
  const pageTitle = mode === "tier-nodes" ? "Tiers & Nodes" : "Servers";

  const { data: serversRaw, isLoading, isError } = useQuery<any[]>({
    queryKey: [`/api/applications/${appId}/servers`],
    enabled: canQuery,
  });
  const { data: app } = useQuery<any>({
    queryKey: [`/api/applications/${appId}`],
    enabled: canQuery,
  });
  const { data: relatedFromIncident } = useQuery<any>({
    queryKey: ["/api/incidents/related-drilldown", sourceIncidentId],
    queryFn: () => fetch(`/api/incidents/${sourceIncidentId}/related`).then((r) => r.json()),
    enabled: canQuery && !!sourceIncidentId,
    staleTime: 30000,
  });
  const { data: nodes } = useNodes(appId);
  const { data: cpuData } = useAppMetrics(appId, "CPU Usage", { durationMins: 24 * 60 });
  const { data: memoryData } = useAppMetrics(appId, "Memory Usage", { durationMins: 24 * 60 });

  const toNumber = (value: unknown) => {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? n : 0;
  };

  const formatLastSync = (value: unknown) => {
    if (!value) return "-";
    const parsed = new Date(String(value));
    if (Number.isNaN(parsed.getTime())) return "-";
    return formatDistanceToNow(parsed, { addSuffix: true });
  };

  const servers = Array.isArray(serversRaw) ? serversRaw : [];
  const incidentScopedServers = sourceIncidentId && Array.isArray(relatedFromIncident?.nodes)
    ? (relatedFromIncident.nodes as any[]).map((n: any, i: number) => ({
        id: n.nodeDbId ?? n.nodeId ?? `rel-node-${i + 1}`,
        externalId: n.nodeId ?? null,
        name: n.name ?? `Server ${i + 1}`,
        ip: n.ip ?? "-",
        role: n.role ?? "Server",
        status: n.status ?? "Warning",
        cpuUsage: Number(n.cpuUsage ?? 0),
        memoryUsage: Number(n.memoryUsage ?? 0),
        diskUsage: Number(n.diskUsage ?? 0),
        alerts: Number(n.alerts ?? 0),
        lastSyncAt: n.lastSyncAt ?? null,
        lastSync: n.lastSync ?? null,
      }))
    : [];
  const relatedNodeDbIds = new Set<string>((relatedFromIncident?.nodes ?? []).map((n: any) => String(n.nodeDbId ?? "")));
  const relatedNodeIds = new Set<string>((relatedFromIncident?.nodes ?? []).map((n: any) => String(n.nodeId ?? "")));
  const relatedNodeNames = new Set<string>((relatedFromIncident?.nodes ?? []).map((n: any) => String(n.name ?? "").toLowerCase()));
  const hasIncidentScopedNodes = sourceIncidentId && (relatedNodeDbIds.size > 0 || relatedNodeIds.size > 0 || relatedNodeNames.size > 0);
  const scopedServers = incidentScopedServers.length > 0
    ? incidentScopedServers
    : (sourceIncidentId
    ? (hasIncidentScopedNodes ? servers.filter((s: any) => {
        const byDbId = relatedNodeDbIds.has(String(s.id ?? ""));
        const byNodeId = relatedNodeIds.has(String(s.externalId ?? ""));
        const byName = relatedNodeNames.has(String(s.name ?? "").toLowerCase());
        return byDbId || byNodeId || byName;
      }) : servers)
    : servers);
  const avgFromSeries = (arr?: Array<{ value: number }>) => {
    const vals = (arr ?? [])
      .map((p) => Number(p?.value ?? NaN))
      .filter((v) => Number.isFinite(v) && v > 0);
    if (!vals.length) return null;
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  };
  const avgCpuFromSeries = avgFromSeries(cpuData as any[]);
  const avgMemFromSeries = avgFromSeries(memoryData as any[]);
  const avgDiskFromServers = (() => {
    const vals = scopedServers
      .map((s) => Number(s?.diskUsage ?? NaN))
      .filter((v) => Number.isFinite(v) && v > 0);
    if (!vals.length) return null;
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  })();
  const resolvedServers = scopedServers.map((s) => {
    const cpuRaw = Number(s?.cpuUsage ?? NaN);
    const memRaw = Number(s?.memoryUsage ?? NaN);
    const diskRaw = Number(s?.diskUsage ?? NaN);
    const cpuResolved = Number.isFinite(cpuRaw) && cpuRaw > 0 ? cpuRaw : avgCpuFromSeries;
    const memResolved = Number.isFinite(memRaw) && memRaw > 0 ? memRaw : avgMemFromSeries;
    const diskResolved = Number.isFinite(diskRaw) && diskRaw > 0 ? diskRaw : avgDiskFromServers;
    return {
      ...s,
      cpuUsageResolved: cpuResolved,
      memoryUsageResolved: memResolved,
      diskUsageResolved: diskResolved,
    };
  });

  const counts = {
    Healthy: resolvedServers.filter((s) => s?.status === "Healthy").length,
    Warning: resolvedServers.filter((s) => s?.status === "Warning").length,
    Critical: resolvedServers.filter((s) => s?.status === "Critical").length,
  };

  const pieData = [
    { name: "Healthy", value: counts.Healthy, fill: "#22c55e" },
    { name: "Warning", value: counts.Warning, fill: "#f59e0b" },
    { name: "Critical", value: counts.Critical, fill: "#ef4444" },
  ].filter((d) => d.value > 0);

  function ResourceBar({ value, label }: { value: number | null | undefined; label: string }) {
    const hasValue = Number.isFinite(Number(value));
    const safeValue = hasValue ? Math.max(0, Math.min(100, Number(value))) : 0;
    const color = safeValue > 80 ? "bg-red-500" : safeValue > 60 ? "bg-yellow-500" : "bg-green-500";

    return (
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-muted-foreground w-10 shrink-0">{label}</span>
        <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
          <div className={`h-full rounded-full ${hasValue ? color : "bg-muted-foreground/30"}`} style={{ width: `${safeValue}%` }} />
        </div>
        <span className="text-xs font-mono w-14 text-right">{hasValue ? `${safeValue.toFixed(1)}%` : "—"}</span>
      </div>
    );
  }

  // Keep Avg CPU logic aligned with Application Details page:
  // 1) average of node CPU values (>0), 2) fallback to app CPU metric series average.
  const nodesCpu = (nodes ?? [])
    .map((n: any) => Number(n?.cpuUsage ?? NaN))
    .filter((v: number) => Number.isFinite(v));
  const nodesCpuWithData = nodesCpu.filter((v: number) => v > 0);
  const avgCpuFromNodes = nodesCpuWithData.length > 0
    ? (nodesCpuWithData.reduce((sum: number, v: number) => sum + v, 0) / nodesCpuWithData.length)
    : null;
  const avgCpu = avgCpuFromNodes ?? avgCpuFromSeries;

  return (
    <AppLayout appId={appId}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-start gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Link href={`/applications/${appId}`} className="text-muted-foreground text-sm hover:text-foreground transition-colors">
                {app?.name ?? "Application"}
              </Link>
              <ChevronRight className="w-3 h-3 text-muted-foreground" />
              <h1 className="text-xl font-bold text-foreground">{pageTitle}</h1>
            </div>
            <p className="text-sm text-muted-foreground">Infrastructure inventory with health status and resource utilization.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <Card className="border border-border shadow-sm sm:col-span-1">
            <CardContent className="p-5 flex flex-col items-center">
              <p className="text-xs font-semibold text-muted-foreground mb-2">Status Distribution</p>
              {isLoading ? (
                <Skeleton className="w-32 h-32 rounded-full" />
              ) : (
                <ResponsiveContainer width={130} height={130}>
                  <PieChart>
                    <Pie data={pieData} cx="50%" cy="50%" innerRadius={40} outerRadius={60} dataKey="value" paddingAngle={2}>
                      {pieData.map((d, i) => (
                        <Cell key={i} fill={d.fill} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              )}

              <div className="flex flex-col gap-1 mt-1 w-full">
                {[
                  { label: "Healthy", color: "bg-green-500", count: counts.Healthy },
                  { label: "Warning", color: "bg-yellow-500", count: counts.Warning },
                  { label: "Critical", color: "bg-red-500", count: counts.Critical },
                ].map((s) => (
                  <div key={s.label} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5">
                      <div className={`w-2 h-2 rounded-full ${s.color}`} />
                      {s.label}
                    </div>
                    <span className="font-bold text-foreground">{s.count}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {[
            { label: "Total Servers", value: resolvedServers.length, icon: <Server className="w-5 h-5 text-muted-foreground" /> },
            { label: "Critical", value: counts.Critical, icon: <AlertTriangle className="w-5 h-5 text-red-400" />, red: true },
            { label: "Avg CPU", value: avgCpu != null ? `${avgCpu.toFixed(1)}%` : "No Data", icon: <Cpu className="w-5 h-5 text-amber-400" /> },
          ].map((s) => (
            <Card key={s.label} className={`border shadow-sm ${s.red && counts.Critical > 0 ? "border-red-500/20 bg-red-500/5" : "border-border"}`}>
              <CardContent className="p-5 flex items-center gap-4">
                {s.icon}
                <div>
                  <p className="text-xs text-muted-foreground font-medium">{s.label}</p>
                  <p className={`text-2xl font-bold ${s.red && counts.Critical > 0 ? "text-red-400" : "text-foreground"}`}>{s.value}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div>
          <h2 className="text-sm font-semibold text-foreground mb-3">All Servers</h2>
          {isLoading ? (
            <div className="space-y-3">{Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-28" />)}</div>
          ) : isError ? (
            <Card className="border border-border">
              <CardContent className="p-6 text-sm text-muted-foreground">Unable to load servers right now. Please try again.</CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {resolvedServers.map((srv) => (
                <Link key={srv.id} href={`/applications/${appId}/${detailBasePath}/${srv.id}`}>
                  <div data-testid={`card-server-${srv.id}`} className="group flex flex-wrap items-center gap-4 rounded-xl border border-border bg-card px-5 py-4 hover:shadow-md hover:border-primary/30 transition-all cursor-pointer">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <Server className="w-4 h-4 text-muted-foreground shrink-0" />
                      <div>
                        <p className="font-bold text-foreground font-mono text-sm group-hover:text-primary transition-colors">{srv.name}</p>
                        <p className="text-xs text-muted-foreground">{srv.ip} - {srv.role}</p>
                      </div>
                    </div>

                    <StatusBadge status={srv.status} />

                    <div className="w-52">
                      <ResourceBar value={srv.cpuUsageResolved} label="CPU" />
                      <ResourceBar value={srv.memoryUsageResolved} label="MEM" />
                      <ResourceBar value={srv.diskUsageResolved} label="DSK" />
                    </div>

                    <div className="text-right text-xs text-muted-foreground min-w-[100px]">
                      {toNumber(srv.alerts) > 0 && <p className="text-red-400 font-bold mb-1">{toNumber(srv.alerts)} alerts</p>}
                      <p className="text-[10px]">Sync: {formatLastSync(srv.lastSyncAt ?? srv.lastSync)}</p>
                    </div>

                    <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
