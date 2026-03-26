import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import { Server, AlertTriangle, ChevronRight, Cpu, HardDrive, Wifi } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

export default function ServersList() {
  const { id } = useParams<{ id: string }>();
  const appId = parseInt(id || "0", 10);
  const { data: servers, isLoading } = useQuery<any[]>({ queryKey: [`/api/applications/${appId}/servers`] });
  const { data: app } = useQuery<any>({ queryKey: [`/api/applications/${appId}`] });

  const counts = {
    Healthy: servers?.filter(s => s.status === "Healthy").length ?? 0,
    Warning: servers?.filter(s => s.status === "Warning").length ?? 0,
    Critical: servers?.filter(s => s.status === "Critical").length ?? 0,
  };

  const pieData = [
    { name: "Healthy", value: counts.Healthy, fill: "#22c55e" },
    { name: "Warning", value: counts.Warning, fill: "#f59e0b" },
    { name: "Critical", value: counts.Critical, fill: "#ef4444" },
  ].filter(d => d.value > 0);

  function ResourceBar({ value, label }: { value: number; label: string }) {
    const color = value > 80 ? "bg-red-500" : value > 60 ? "bg-yellow-500" : "bg-green-500";
    return (
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-muted-foreground w-10 shrink-0">{label}</span>
        <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
          <div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} />
        </div>
        <span className="text-xs font-mono w-8 text-right">{value}%</span>
      </div>
    );
  }

  return (
    <AppLayout appId={appId}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-start gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Link href={`/applications/${appId}`} className="text-muted-foreground text-sm hover:text-foreground transition-colors">{app?.name ?? "Application"}</Link>
              <ChevronRight className="w-3 h-3 text-muted-foreground" />
              <h1 className="text-xl font-bold text-foreground">Servers & Pods</h1>
            </div>
            <p className="text-sm text-muted-foreground">Infrastructure inventory with health status and resource utilization.</p>
          </div>
        </div>

        {/* Status summary + pie */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          {/* Pie chart */}
          <Card className="border border-border shadow-sm sm:col-span-1">
            <CardContent className="p-5 flex flex-col items-center">
              <p className="text-xs font-semibold text-muted-foreground mb-2">Status Distribution</p>
              {isLoading ? <Skeleton className="w-32 h-32 rounded-full" /> : (
                <ResponsiveContainer width={130} height={130}>
                  <PieChart>
                    <Pie data={pieData} cx="50%" cy="50%" innerRadius={40} outerRadius={60} dataKey="value" paddingAngle={2}>
                      {pieData.map((d, i) => <Cell key={i} fill={d.fill} />)}
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
                ].map(s => (
                  <div key={s.label} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5"><div className={`w-2 h-2 rounded-full ${s.color}`} />{s.label}</div>
                    <span className="font-bold text-foreground">{s.count}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Summary stats */}
          {[
            { label: "Total Servers", value: servers?.length ?? 0, icon: <Server className="w-5 h-5 text-muted-foreground" /> },
            { label: "Critical", value: counts.Critical, icon: <AlertTriangle className="w-5 h-5 text-red-400" />, red: true },
            { label: "Avg CPU", value: `${servers ? Math.round(servers.reduce((s, n) => s + n.cpuUsage, 0) / (servers.length || 1)) : 0}%`, icon: <Cpu className="w-5 h-5 text-amber-400" /> },
          ].map(s => (
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

        {/* Server cards */}
        <div>
          <h2 className="text-sm font-semibold text-foreground mb-3">All Servers</h2>
          {isLoading ? (
            <div className="space-y-3">{Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-28" />)}</div>
          ) : (
            <div className="space-y-3">
              {servers?.map(srv => (
                <Link key={srv.id} href={`/applications/${appId}/servers/${srv.id}`}>
                  <div data-testid={`card-server-${srv.id}`} className="group flex flex-wrap items-center gap-4 rounded-xl border border-border bg-card px-5 py-4 hover:shadow-md hover:border-primary/30 transition-all cursor-pointer">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <Server className="w-4 h-4 text-muted-foreground shrink-0" />
                      <div>
                        <p className="font-bold text-foreground font-mono text-sm group-hover:text-primary transition-colors">{srv.name}</p>
                        <p className="text-xs text-muted-foreground">{srv.ip} · {srv.role}</p>
                      </div>
                    </div>
                    <StatusBadge status={srv.status} />
                    <div className="w-52">
                      <ResourceBar value={srv.cpuUsage} label="CPU" />
                      <ResourceBar value={srv.memoryUsage} label="MEM" />
                      <ResourceBar value={srv.diskUsage} label="DSK" />
                    </div>
                    <div className="text-right text-xs text-muted-foreground min-w-[100px]">
                      {srv.alerts > 0 && <p className="text-red-400 font-bold mb-1">{srv.alerts} alerts</p>}
                      <p className="text-[10px]">Sync: {(srv.lastSyncAt ?? srv.lastSync) ? formatDistanceToNow(new Date(srv.lastSyncAt ?? srv.lastSync), { addSuffix: true }) : "—"}</p>
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
