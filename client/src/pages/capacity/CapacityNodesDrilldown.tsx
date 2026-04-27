import { Link } from "wouter";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, ArrowLeft, Cpu, HardDrive, MemoryStick, Server } from "lucide-react";

export default function CapacityNodesDrilldown() {
  const appId = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("appId");
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }, []);

  const { data, isLoading } = useQuery<any>({
    queryKey: ["/api/capacity-planning/nodes", appId],
    queryFn: () => {
      const qs = appId != null ? `?appId=${encodeURIComponent(String(appId))}` : "";
      return fetch(`/api/capacity-planning/nodes${qs}`).then((r) => r.json());
    },
  });

  if (isLoading) {
    return (
      <AppLayout>
        <div className="space-y-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-80" />
        </div>
      </AppLayout>
    );
  }

  const summary = data?.summary ?? {};
  const nodes = Array.isArray(data?.nodes) ? data.nodes : [];

  return (
    <AppLayout>
      <div className="space-y-5 max-w-screen-2xl">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <Link href="/capacity-planning" className="hover:text-foreground transition-colors">Capacity Planning</Link>
              <span>/</span>
              <span className="text-foreground font-medium">Total Nodes</span>
            </div>
            <h1 className="text-2xl font-bold text-foreground">Total Nodes Drilldown</h1>
            <p className="text-sm text-muted-foreground">All monitored nodes sorted by highest infrastructure risk.</p>
          </div>
          <Link href="/capacity-planning" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="w-4 h-4" /> Back
          </Link>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <Card className="border border-border">
            <CardContent className="p-3">
              <p className="text-[10px] text-muted-foreground uppercase">Total Nodes</p>
              <p className="text-2xl font-bold">{summary.totalNodes ?? 0}</p>
            </CardContent>
          </Card>
          <Card className="border border-red-500/20 bg-red-500/5">
            <CardContent className="p-3">
              <p className="text-[10px] text-muted-foreground uppercase">Critical</p>
              <p className="text-2xl font-bold text-red-500">{summary.criticalNodes ?? 0}</p>
            </CardContent>
          </Card>
          <Card className="border border-amber-500/20 bg-amber-500/5">
            <CardContent className="p-3">
              <p className="text-[10px] text-muted-foreground uppercase">Warning</p>
              <p className="text-2xl font-bold text-amber-500">{summary.warningNodes ?? 0}</p>
            </CardContent>
          </Card>
          <Card className="border border-border">
            <CardContent className="p-3">
              <p className="text-[10px] text-muted-foreground uppercase">Avg CPU</p>
              <p className="text-2xl font-bold">{summary.avgCpu ?? 0}%</p>
            </CardContent>
          </Card>
          <Card className="border border-border">
            <CardContent className="p-3">
              <p className="text-[10px] text-muted-foreground uppercase">Avg Memory</p>
              <p className="text-2xl font-bold">{summary.avgMemory ?? 0}%</p>
            </CardContent>
          </Card>
        </div>

        <Card className="border border-border">
          <CardHeader className="pb-3 border-b border-border">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Server className="w-4 h-4 text-blue-500" /> Node Inventory
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {nodes.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">No node data available for this selection.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="border-b border-border bg-muted/30">
                    <tr>
                      <th className="text-left px-4 py-2">Node</th>
                      <th className="text-left px-4 py-2">Application</th>
                      <th className="text-left px-4 py-2">Role</th>
                      <th className="text-left px-4 py-2">Status</th>
                      <th className="text-left px-4 py-2">CPU</th>
                      <th className="text-left px-4 py-2">Memory</th>
                      <th className="text-left px-4 py-2">Disk</th>
                      <th className="text-left px-4 py-2">Risk</th>
                      <th className="text-right px-4 py-2">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nodes.map((node: any) => (
                      <tr key={node.id} className="border-b border-border hover:bg-muted/20">
                        <td className="px-4 py-2 font-medium">{node.name}</td>
                        <td className="px-4 py-2">{node.appName ?? "Unknown Application"}</td>
                        <td className="px-4 py-2 text-muted-foreground">{node.role ?? node.tier ?? "-"}</td>
                        <td className="px-4 py-2">
                          <Badge className={node.status === "Critical" ? "bg-red-500/10 text-red-500 border-red-500/20" : node.status === "Warning" ? "bg-amber-500/10 text-amber-500 border-amber-500/20" : "bg-green-500/10 text-green-600 border-green-500/20"}>
                            {node.status ?? "Unknown"}
                          </Badge>
                        </td>
                        <td className="px-4 py-2"><span className="inline-flex items-center gap-1"><Cpu className="w-3 h-3 text-red-500" />{node.cpuUsage}%</span></td>
                        <td className="px-4 py-2"><span className="inline-flex items-center gap-1"><MemoryStick className="w-3 h-3 text-purple-500" />{node.memoryUsage}%</span></td>
                        <td className="px-4 py-2"><span className="inline-flex items-center gap-1"><HardDrive className="w-3 h-3 text-amber-500" />{node.diskUsage}%</span></td>
                        <td className="px-4 py-2">
                          <span className={`inline-flex items-center gap-1 font-semibold ${node.riskScore >= 85 ? "text-red-500" : node.riskScore >= 70 ? "text-amber-500" : "text-green-600"}`}>
                            <Activity className="w-3 h-3" /> {node.riskScore}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right">
                          {node.detailHref ? (
                            <Link href={node.detailHref} className="text-indigo-500 hover:text-indigo-600 font-medium">View</Link>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
