import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueries } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import {
  Activity, AlertTriangle, Search,
  Clock, Zap, ArrowRight, BrainCircuit, Plug
} from "lucide-react";

function RiskBadge({ score, label }: { score: number; label: string }) {
  const cls = score > 70 ? "bg-red-500/10 text-red-400 border-red-500/20" : score > 40 ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/20" : "bg-green-500/10 text-green-400 border-green-500/20";
  return <span className={`text-xs px-2 py-0.5 rounded border font-semibold ${cls}`}>{label} Risk</span>;
}

function AppCard({ app, rich }: { app: any; rich: any }) {
  const fRisk = rich?.forecastRisk;
  const hasMetrics = !!app?.hasMetrics;
  const responseTime = rich?.responseTime ?? app.avgResponseTime;
  const errorRate = rich?.errorRate ?? app.errorRate;
  const throughput = rich?.throughput ?? app.callsPerMinute;

  return (
    <Link href={`/applications/${app.id}`}>
      <Card data-testid={`card-app-${app.id}`} className="group cursor-pointer border border-border shadow-sm hover:shadow-md hover:border-primary/30 transition-all duration-200 h-full flex flex-col">
        <CardContent className="p-5 flex flex-col gap-3 h-full">
          {/* Header */}
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <h3 className="font-bold text-foreground group-hover:text-primary transition-colors truncate">{app.name}</h3>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-muted-foreground">{rich?.environment ?? "Production"}</span>
                {fRisk && <RiskBadge score={fRisk.score} label={fRisk.label} />}
              </div>
            </div>
            <StatusBadge status={app.status} />
          </div>

          {/* Metrics grid */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <p className="text-[10px] text-muted-foreground font-medium mb-1 flex items-center gap-1"><Clock className="w-2.5 h-2.5" /> Response</p>
              {hasMetrics && responseTime != null ? (
                <p className={`text-sm font-bold font-mono ${responseTime > 2000 ? "text-red-400" : responseTime > 800 ? "text-yellow-500" : "text-green-500"}`}>
                  {responseTime?.toLocaleString()}ms
                </p>
              ) : (
                <p className="text-sm font-bold font-mono text-muted-foreground">No Data</p>
              )}
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground font-medium mb-1 flex items-center gap-1"><AlertTriangle className="w-2.5 h-2.5" /> Errors</p>
              {hasMetrics && errorRate != null ? (
                <p className={`text-sm font-bold font-mono ${errorRate > 3 ? "text-red-400" : errorRate > 1 ? "text-yellow-500" : "text-green-500"}`}>
                  {Number(errorRate ?? 0).toFixed(2)}%
                </p>
              ) : (
                <p className="text-sm font-bold font-mono text-muted-foreground">No Data</p>
              )}
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground font-medium mb-1 flex items-center gap-1"><Zap className="w-2.5 h-2.5" /> Throughput</p>
              {hasMetrics && throughput != null ? (
                <p className="text-sm font-bold font-mono text-foreground">{throughput?.toLocaleString() ?? 0}</p>
              ) : (
                <p className="text-sm font-bold font-mono text-muted-foreground">No Data</p>
              )}
            </div>
          </div>

          {/* SLA score bar */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] text-muted-foreground font-medium">SLA Health</span>
              <span className={`text-[10px] font-bold ${rich?.slaScore < 60 ? "text-red-400" : rich?.slaScore < 80 ? "text-yellow-500" : "text-green-500"}`}>{rich?.slaScore ?? 0}/100</span>
            </div>
            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${rich?.slaScore < 60 ? "bg-red-500" : rich?.slaScore < 80 ? "bg-yellow-500" : "bg-green-500"}`}
                style={{ width: `${rich?.slaScore ?? 0}%` }}
              />
            </div>
          </div>

          {/* AI forecast alert */}
          {fRisk?.hoursToSLABreach && (
            <div className="flex items-center gap-2 bg-red-500/5 border border-red-500/20 rounded-lg px-3 py-2">
              <BrainCircuit className="w-3.5 h-3.5 text-red-400 shrink-0" />
              <p className="text-xs text-red-400 font-medium">SLA breach in ~{fRisk.hoursToSLABreach}h -- {fRisk.confidence}% confidence</p>
            </div>
          )}

          {/* Violations + arrow */}
          <div className="flex items-center justify-between mt-auto pt-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Activity className="w-3.5 h-3.5" />
              {app.healthRuleViolations > 0 ? (
                <span className="text-red-400 font-medium">{app.healthRuleViolations} violations</span>
              ) : (
                <span className="text-green-500">No violations</span>
              )}
            </div>
            <ArrowRight className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

const STATUS_FILTERS = ["All", "Critical", "Warning", "Healthy"] as const;

export default function ApplicationsList() {
  const [timeRange, setTimeRange] = useState<"24h" | "7d" | "30d" | "custom">("24h");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");

  const appQueryOpts = useMemo(() => {
    if (timeRange === "24h") return { durationMins: 24 * 60 };
    if (timeRange === "7d") return { durationMins: 7 * 24 * 60 };
    if (timeRange === "30d") return { durationMins: 30 * 24 * 60 };
    if (customStart && customEnd) {
      const startIso = new Date(`${customStart}T00:00:00`).toISOString();
      const endIso = new Date(`${customEnd}T23:59:59`).toISOString();
      return { start: startIso, end: endIso };
    }
    return { durationMins: 24 * 60 };
  }, [timeRange, customStart, customEnd]);

  const { data: applications, isLoading } = useQuery<any[]>({
    queryKey: ["/api/applications", appQueryOpts],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (appQueryOpts.durationMins) params.set("durationMins", String(appQueryOpts.durationMins));
      if (appQueryOpts.start) params.set("start", appQueryOpts.start);
      if (appQueryOpts.end) params.set("end", appQueryOpts.end);
      const qs = params.toString();
      const url = qs ? `/api/applications?${qs}` : "/api/applications";
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch applications");
      return res.json();
    },
  });
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("All");

  // Rich data per app
  const richQueries = useQueries({
    queries: (applications ?? []).map(app => ({
      queryKey: [`/api/applications/${app.id}/rich`],
    })),
  });
  const richMap: Record<number, any> = {};
  (applications ?? []).forEach((app, i) => { richMap[app.id] = richQueries[i]?.data; });

  const filtered = (applications ?? []).filter(app => {
    const matchSearch = app.name.toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === "All" || app.status === statusFilter;
    return matchSearch && matchStatus;
  });
  const sortedFiltered = [...filtered].sort((a, b) => {
    const aRich = richMap[a.id];
    const bRich = richMap[b.id];
    const aResp = Number(aRich?.responseTime ?? a.avgResponseTime ?? 0);
    const aErr = Number(aRich?.errorRate ?? a.errorRate ?? 0);
    const aTput = Number(aRich?.throughput ?? a.callsPerMinute ?? 0);
    const bResp = Number(bRich?.responseTime ?? b.avgResponseTime ?? 0);
    const bErr = Number(bRich?.errorRate ?? b.errorRate ?? 0);
    const bTput = Number(bRich?.throughput ?? b.callsPerMinute ?? 0);
    const aHasData = !!a?.hasMetrics && (aResp > 0 || aErr > 0 || aTput > 0);
    const bHasData = !!b?.hasMetrics && (bResp > 0 || bErr > 0 || bTput > 0);
    if (aHasData !== bHasData) return aHasData ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const counts = { Critical: applications?.filter(a => a.status === "Critical").length ?? 0, Warning: applications?.filter(a => a.status === "Warning").length ?? 0, Healthy: applications?.filter(a => a.status === "Healthy").length ?? 0 };

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-foreground mb-1">Applications</h1>
          <p className="text-muted-foreground text-sm">Monitor health, performance, and AI risk forecasting across your portfolio.</p>
        </div>

        {/* Status summary */}
        {!isLoading && (
          <div className="flex flex-wrap gap-3">
            {[
              { label: "Critical", count: counts.Critical, color: "bg-red-500/10 border-red-500/20 text-red-400", dot: "bg-red-500" },
              { label: "Warning", count: counts.Warning, color: "bg-yellow-500/10 border-yellow-500/20 text-yellow-500", dot: "bg-yellow-500" },
              { label: "Healthy", count: counts.Healthy, color: "bg-green-500/10 border-green-500/20 text-green-500", dot: "bg-green-500" },
            ].map(s => (
              <button key={s.label} onClick={() => setStatusFilter(statusFilter === s.label ? "All" : s.label)}
                className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-all ${s.color} ${statusFilter === s.label ? "ring-2 ring-offset-2 ring-offset-background" : ""}`}
              >
                <div className={`w-2 h-2 rounded-full ${s.dot}`} />
                {s.count} {s.label}
              </button>
            ))}
          </div>
        )}

        {/* Search + filter */}
        <div className="flex flex-wrap gap-3 items-center">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              data-testid="input-search-apps"
              placeholder="Search applications..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="flex gap-1">
            {STATUS_FILTERS.map(f => (
              <button key={f} data-testid={`filter-${f}`} onClick={() => setStatusFilter(f)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${statusFilter === f ? "bg-primary/10 border-primary/30 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        {/* Time range */}
        <div className="flex flex-wrap items-center gap-2">
          {(["24h", "7d", "30d", "custom"] as const).map(r => (
            <Button
              key={r}
              variant={timeRange === r ? "default" : "outline"}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setTimeRange(r)}
            >
              {r}
            </Button>
          ))}
          {timeRange === "custom" && (
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                className="h-7 rounded-md border border-border bg-card px-2 text-xs text-foreground"
              />
              <span className="text-xs text-muted-foreground">to</span>
              <input
                type="date"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                className="h-7 rounded-md border border-border bg-card px-2 text-xs text-foreground"
              />
            </div>
          )}
        </div>

        {/* App grid */}
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array(3).fill(0).map((_, i) => <Skeleton key={i} className="h-64" />)}
          </div>
        ) : sortedFiltered.length === 0 ? (
          (applications ?? []).length === 0 ? (
            <div className="py-20 text-center bg-muted/10 rounded-xl border border-dashed border-border">
              <div className="w-14 h-14 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-4">
                <Plug className="w-7 h-7 text-primary" />
              </div>
              <h3 className="text-lg font-semibold text-foreground mb-2">No APM controllers connected</h3>
              <p className="text-sm text-muted-foreground max-w-sm mx-auto mb-6">
                Connect your AppDynamics or Dynatrace controller to start monitoring applications, incidents, and performance data.
              </p>
              <Link href="/integrations">
                <Button data-testid="button-connect-apm" className="gap-2">
                  <Plug className="w-4 h-4" /> Connect APM Controller
                </Button>
              </Link>
            </div>
          ) : (
            <div className="py-16 text-center bg-muted/20 rounded-xl border border-dashed border-border">
              <Activity className="w-10 h-10 text-muted-foreground mx-auto mb-3 opacity-40" />
              <p className="font-medium text-foreground">No applications match your filters</p>
              <p className="text-sm text-muted-foreground mt-1">Try clearing the search or adjusting status filters.</p>
            </div>
          )
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {sortedFiltered.map(app => (
              <AppCard key={app.id} app={app} rich={richMap[app.id]} />
            ))}
          </div>
        )}

        {/* Footer note */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <BrainCircuit className="w-3.5 h-3.5" />
          Forecast risk scores and SLA projections are AI-generated with 72-hour confidence windows.
        </div>
      </div>
    </AppLayout>
  );
}
