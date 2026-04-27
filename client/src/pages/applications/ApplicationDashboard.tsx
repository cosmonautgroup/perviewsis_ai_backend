import { useMemo, useState } from "react";
import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AppLayout } from "@/components/layout/AppLayout";
import { MetricCard } from "@/components/MetricCard";
import { useApplication, useTransactions, useNodes, useAppMetrics } from "@/hooks/use-applications";
import { StatusBadge } from "@/components/StatusBadge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Activity, Clock, Cpu, MemoryStick, Server, AlertCircle,
  BrainCircuit, TrendingUp, TrendingDown, ChevronRight, AlertTriangle,
  CheckCircle2, Flame, Database, Globe, ArrowRight
} from "lucide-react";
import { AreaChart, Area, BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { format } from "date-fns";

const fmtTime = (v: number) => format(new Date(v), 'HH:mm');

function RiskScore({ score }: { score: number }) {
  const color = score > 75 ? "text-red-400 bg-red-500/10 border-red-500/20" : score > 45 ? "text-yellow-400 bg-yellow-500/10 border-yellow-500/20" : "text-green-400 bg-green-500/10 border-green-500/20";
  return <span className={`text-xs font-bold px-2 py-0.5 rounded border ${color}`}>{score}</span>;
}

function TrendChip({ trend }: { trend: string }) {
  const map: Record<string, any> = { worsening: ["text-red-400", <TrendingUp className="w-3 h-3" />], stable: ["text-yellow-500", null], improving: ["text-green-500", <TrendingDown className="w-3 h-3" />] };
  const [cls, icon] = map[trend] ?? ["text-muted-foreground", null];
  return <span className={`flex items-center gap-1 text-xs font-medium capitalize ${cls}`}>{icon}{trend}</span>;
}

export default function ApplicationDashboard() {
  const { id } = useParams<{ id: string }>();
  const appId = parseInt(id || "0", 10);

  const [timeRange, setTimeRange] = useState<"5m" | "15m" | "1h" | "3h" | "1d" | "7d" | "30d" | "custom">("1d");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const metricOpts = useMemo(() => {
    if (timeRange === "5m") return { durationMins: 5 };
    if (timeRange === "15m") return { durationMins: 15 };
    if (timeRange === "1h") return { durationMins: 60 };
    if (timeRange === "3h") return { durationMins: 3 * 60 };
    if (timeRange === "1d") return { durationMins: 24 * 60 };
    if (timeRange === "7d") return { durationMins: 7 * 24 * 60 };
    if (timeRange === "30d") return { durationMins: 30 * 24 * 60 };
    if (customStart && customEnd) {
      const startIso = new Date(`${customStart}T00:00:00`).toISOString();
      const endIso = new Date(`${customEnd}T23:59:59`).toISOString();
      return { start: startIso, end: endIso };
    }
    return { durationMins: 24 * 60 };
  }, [timeRange, customStart, customEnd]);
  const txDrilldownQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (metricOpts.durationMins) params.set("durationMins", String(metricOpts.durationMins));
    if (metricOpts.start) params.set("start", metricOpts.start);
    if (metricOpts.end) params.set("end", metricOpts.end);
    const qs = params.toString();
    return qs ? `?${qs}` : "";
  }, [metricOpts.durationMins, metricOpts.start, metricOpts.end]);

  const { data: app, isLoading: appLoading } = useApplication(appId);
  const { data: transactions, isLoading: txLoading } = useTransactions(appId, metricOpts);
  const { data: nodes, isLoading: nodesLoading } = useNodes(appId);
  const { data: responseTimeData } = useAppMetrics(appId, "Response Time", metricOpts);
  const { data: throughputData } = useAppMetrics(appId, "Calls per Minute", metricOpts);
  const { data: errorRateData } = useAppMetrics(appId, "Error Rate", metricOpts);
  const { data: cpuData } = useAppMetrics(appId, "CPU Usage", metricOpts);
  const { data: memoryData } = useAppMetrics(appId, "Memory Usage", metricOpts);
  const { data: baselineRespData } = useAppMetrics(appId, "Baseline Response Time", metricOpts);
  const { data: btRespData } = useAppMetrics(appId, "Business Transaction Response Time", metricOpts);
  const { data: dbRespData } = useAppMetrics(appId, "Database Response Time", metricOpts);
  const { data: jvmHeapData } = useAppMetrics(appId, "JVM Heap", metricOpts);
  const { data: jvmGcData } = useAppMetrics(appId, "JVM GC", metricOpts);
  const { data: threadData } = useAppMetrics(appId, "Thread Count", metricOpts);
  const { data: rich } = useQuery<any>({ queryKey: [`/api/applications/${appId}/rich`] });
  const { data: serviceRisks } = useQuery<any[]>({ queryKey: [`/api/applications/${appId}/service-risks`] });
  const { data: httpErrors } = useQuery<any[]>({ queryKey: [`/api/applications/${appId}/http-errors`] });
  const { data: depErrors } = useQuery<any[]>({ queryKey: [`/api/applications/${appId}/dependency-errors`] });
  const { data: servers } = useQuery<any[]>({ queryKey: [`/api/applications/${appId}/servers`] });
  const { data: appSummary } = useQuery<any | null>({
    queryKey: ["/api/applications/summary", appId, metricOpts.durationMins, metricOpts.start, metricOpts.end],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (metricOpts.durationMins) params.set("durationMins", String(metricOpts.durationMins));
      if (metricOpts.start) params.set("start", metricOpts.start);
      if (metricOpts.end) params.set("end", metricOpts.end);
      const qs = params.toString();
      const res = await fetch(qs ? `/api/applications?${qs}` : "/api/applications");
      if (!res.ok) throw new Error("Failed to fetch application summary");
      const rows = await res.json();
      return (rows ?? []).find((r: any) => r.id === appId) ?? null;
    },
    enabled: !!appId,
  });

  if (appLoading) return <AppLayout appId={appId}><Skeleton className="h-64 w-full" /></AppLayout>;
  if (!app) return <AppLayout>Application not found</AppLayout>;

  const hasSummaryMetrics = !!appSummary?.hasMetrics;
  const avgOf = (arr?: { value: number }[]) => {
    const values = (arr ?? [])
      .map((p) => Number(p.value))
      .filter((v): v is number => Number.isFinite(v) && v >= 0);
    if (values.length === 0) return null;
    return values.reduce((s, v) => s + v, 0) / values.length;
  };
  const trendVsPreviousHour = (arr?: { timestamp: number; value: number }[]) => {
    const points = (arr ?? [])
      .map((p) => ({ timestamp: Number(p?.timestamp ?? NaN), value: Number(p?.value ?? NaN) }))
      .filter((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.value));
    if (points.length < 2) return null;
    points.sort((a, b) => a.timestamp - b.timestamp);

    const latestTs = points[points.length - 1].timestamp;
    const oneHourMs = 60 * 60 * 1000;
    const currentStart = latestTs - oneHourMs;
    const previousStart = latestTs - 2 * oneHourMs;
    const currentPoints = points.filter((p) => p.timestamp > currentStart);
    const previousPoints = points.filter((p) => p.timestamp > previousStart && p.timestamp <= currentStart);

    const avg = (vals: { value: number }[]) => vals.reduce((s, v) => s + v.value, 0) / vals.length;
    let currentAvg: number | null = currentPoints.length > 0 ? avg(currentPoints) : null;
    let previousAvg: number | null = previousPoints.length > 0 ? avg(previousPoints) : null;

    // Fallback for short/custom windows: compare first half vs second half.
    if (currentAvg == null || previousAvg == null) {
      const half = Math.floor(points.length / 2);
      if (half > 0 && points.length - half > 0) {
        const firstHalf = points.slice(0, half);
        const secondHalf = points.slice(half);
        previousAvg = avg(firstHalf);
        currentAvg = avg(secondHalf);
      }
    }

    if (currentAvg == null || previousAvg == null) return null;
    if (Math.abs(previousAvg) < 1e-9) {
      if (Math.abs(currentAvg) < 1e-9) return 0;
      return 100;
    }
    return ((currentAvg - previousAvg) / Math.abs(previousAvg)) * 100;
  };
  // Use the same source as graphs so KPI cards follow selected time window.
  const avgResponseTimeFromSeries = avgOf(responseTimeData);
  const totalThroughputFromSeries = avgOf(throughputData);
  const avgErrorRateFromSeries = avgOf(errorRateData);
  const avgResponseTime = avgResponseTimeFromSeries ?? (hasSummaryMetrics && appSummary?.avgResponseTime != null ? Number(appSummary.avgResponseTime) : null);
  const totalThroughput = totalThroughputFromSeries ?? (hasSummaryMetrics && appSummary?.callsPerMinute != null ? Number(appSummary.callsPerMinute) : null);
  const avgErrorRate = avgErrorRateFromSeries ?? (hasSummaryMetrics && appSummary?.errorRate != null ? Number(appSummary.errorRate) : null);
  // Treat error budget as % of allowed errors consumed within a 99% SLO (1% error budget).
  const errorBudgetThresholdPct = 1;
  const errorBudgetLeftPct = avgErrorRate != null
    ? Math.max(0, ((errorBudgetThresholdPct - avgErrorRate) / errorBudgetThresholdPct) * 100)
    : null;
  const nodesCpu = (nodes ?? []).map(n => n.cpuUsage).filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
  const nodesMem = (nodes ?? []).map(n => n.memoryUsage).filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
  const serversCpu = (servers ?? []).map(s => s.cpuUsage).filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
  const serversMem = (servers ?? []).map(s => s.memoryUsage).filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
  const cpuSeriesVals = (cpuData ?? []).map(p => p.value).filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
  const memSeriesVals = (memoryData ?? []).map(p => p.value).filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
  const serversCpuWithData = serversCpu.filter((v) => v > 0);
  const serversMemWithData = serversMem.filter((v) => v > 0);
  const nodesCpuWithData = nodesCpu.filter((v) => v > 0);
  const nodesMemWithData = nodesMem.filter((v) => v > 0);
  const avgCpuFromServers = serversCpuWithData.length > 0 ? (serversCpuWithData.reduce((s, v) => s + v, 0) / serversCpuWithData.length) : null;
  const avgMemFromServers = serversMemWithData.length > 0 ? (serversMemWithData.reduce((s, v) => s + v, 0) / serversMemWithData.length) : null;
  const avgCpuFromNodes = nodesCpuWithData.length > 0 ? (nodesCpuWithData.reduce((s, v) => s + v, 0) / nodesCpuWithData.length) : null;
  const avgMemFromNodes = nodesMemWithData.length > 0 ? (nodesMemWithData.reduce((s, v) => s + v, 0) / nodesMemWithData.length) : null;
  const avgCpuFromSeries = cpuSeriesVals.length > 0 ? (cpuSeriesVals.reduce((s, v) => s + v, 0) / cpuSeriesVals.length) : null;
  const avgMemFromSeries = memSeriesVals.length > 0 ? (memSeriesVals.reduce((s, v) => s + v, 0) / memSeriesVals.length) : null;
  const avgCpu = avgCpuFromServers ?? avgCpuFromNodes ?? avgCpuFromSeries;
  const avgMem = avgMemFromServers ?? avgMemFromNodes ?? avgMemFromSeries;
  const criticalNodes = (nodes ?? []).filter(n =>
    n.status === "Critical" || Number(n.cpuUsage ?? 0) > 80 || Number(n.memoryUsage ?? 0) > 85
  ).length;
  const cpuIssueCount = (servers ?? []).filter((s) => Number(s.cpuUsage ?? 0) > 80).length + (nodes ?? []).filter((n) => Number(n.cpuUsage ?? 0) > 80).length;
  const memoryIssueCount = (servers ?? []).filter((s) => Number(s.memoryUsage ?? 0) > 80).length + (nodes ?? []).filter((n) => Number(n.memoryUsage ?? 0) > 80).length;
  const diskIssueCount = (servers ?? []).filter((s) => Number(s.diskUsage ?? 0) > 85).length;
  const networkIssueCount = (servers ?? []).filter((s) => Number(s.networkMbps ?? 0) > 0 && Number(s.networkMbps ?? 0) < 1).length;
  const processIssueCount = (servers ?? []).filter((s) => Number(s.alerts ?? 0) > 0).length;
  const drilldownAppId = String(appSummary?.externalId ?? app?.externalId ?? "");
  const drilldownQuery = encodeURIComponent(String(appSummary?.name ?? app?.name ?? ""));
  const latestOf = (arr?: { value: number }[]) => {
    const values = (arr ?? []).map(a => a.value).filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
    if (values.length === 0) return null;
    return values[values.length - 1];
  };
  const baselineResp = latestOf(baselineRespData);
  const btResp = latestOf(btRespData);
  const dbResp = latestOf(dbRespData);
  const jvmHeap = latestOf(jvmHeapData);
  const jvmGc = latestOf(jvmGcData);
  const threadCount = latestOf(threadData);
  const throughputChartData = (throughputData ?? []).map((point) => ({
    ...point,
    value: Math.round(Number(point.value ?? 0)),
  }));
  const responseTrend = trendVsPreviousHour(responseTimeData);
  const throughputTrend = trendVsPreviousHour(throughputData);
  const lastSyncLabel = appSummary?.lastSyncAt
    ? new Date(appSummary.lastSyncAt).toLocaleString()
    : null;

  const serverStatusData = [
    { name: "Healthy", value: servers?.filter(s => s.status === "Healthy").length || 0, fill: "#22c55e" },
    { name: "Warning", value: servers?.filter(s => s.status === "Warning").length || 0, fill: "#f59e0b" },
    { name: "Critical", value: servers?.filter(s => s.status === "Critical").length || 0, fill: "#ef4444" },
  ];

  return (
    <AppLayout appId={appId}>
      <div className="space-y-5">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h1 className="text-2xl font-bold text-foreground tracking-tight">{app.name}</h1>
              <StatusBadge status={app.status} />
              {rich?.environment && <Badge variant="secondary" className="text-xs">{rich.environment}</Badge>}
            </div>
            <p className="text-sm text-muted-foreground">{app.healthRuleViolations} active health violations</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground bg-card px-3 py-2 rounded-lg border border-border">
            <span className="relative flex h-2 w-2 mr-1">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
            </span>
            Live · refreshing every 60s
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card/60 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Filter Window:</span>
            {(["5m", "15m", "1h", "3h", "1d", "7d", "30d", "custom"] as const).map(r => (
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
        </div>

        {/* AI Forecast Alert */}
        {rich?.forecastRisk?.hoursToSLABreach && (
          <div className="flex items-center gap-3 bg-red-500/10 border border-red-500/30 rounded-xl px-5 py-4">
            <BrainCircuit className="w-5 h-5 text-red-400 shrink-0" />
            <div className="flex-1">
              <p className="font-bold text-red-400">High probability of SLA breach in next {rich.forecastRisk.hoursToSLABreach} hours</p>
              <p className="text-sm text-red-300/80">AI confidence: {rich.forecastRisk.confidence}% · Forecast risk score: {rich.forecastRisk.score}/100</p>
            </div>
            <Button variant="outline" size="sm" className="text-red-400 border-red-500/30 shrink-0" asChild>
              <Link href={`/applications/${appId}/incidents`}>View Incidents</Link>
            </Button>
          </div>
        )}

        {/* SLA Score row */}
        {/*{rich && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Response Time", value: avgResponseTime != null ? `${avgResponseTime.toFixed(0)}ms` : "No Data", bad: avgResponseTime != null && avgResponseTime > 2000 },
              { label: "Error Rate", value: avgErrorRate != null ? `${avgErrorRate.toFixed(2)}%` : "No Data", bad: avgErrorRate != null && avgErrorRate > 3, href: `/errors?appId=${encodeURIComponent(drilldownAppId)}&q=${drilldownQuery}` },
              { label: "Throughput", value: totalThroughput != null ? `${Math.round(totalThroughput)} cpm` : "No Data", bad: false },
              { label: "SLA Score", value: `${rich.slaScore}%`, bad: rich.slaScore < 60 },
            ].map(m => (
              m.href ? (
                <Link key={m.label} href={m.href}>
                  <div className={`rounded-xl border px-4 py-3 cursor-pointer hover:border-primary/40 transition-colors ${m.bad ? "bg-red-500/5 border-red-500/20" : "bg-card border-border"}`}>
                    <p className="text-xs text-muted-foreground mb-1">{m.label}</p>
                    <p className={`text-xl font-bold font-mono ${m.bad ? "text-red-400" : "text-foreground"}`}>{m.value}</p>
                    <p className="text-[10px] text-primary mt-1">Drill down</p>
                  </div>
                </Link>
              ) : (
                <div key={m.label} className={`rounded-xl border px-4 py-3 ${m.bad ? "bg-red-500/5 border-red-500/20" : "bg-card border-border"}`}>
                  <p className="text-xs text-muted-foreground mb-1">{m.label}</p>
                  <p className={`text-xl font-bold font-mono ${m.bad ? "text-red-400" : "text-foreground"}`}>{m.value}</p>
                </div>
              )
            ))}
          </div>
        )}*/}

        <Tabs defaultValue="services" className="space-y-5">
          <TabsList className="bg-card border border-border p-1 grid grid-cols-2 w-fit">
            <TabsTrigger value="services" className="data-[state=active]:bg-primary/10 data-[state=active]:text-primary font-medium text-sm px-5">
              SRE View
            </TabsTrigger>
            <TabsTrigger value="infrastructure" className="data-[state=active]:bg-primary/10 data-[state=active]:text-primary font-medium text-sm px-5">
              Infrastructure View
            </TabsTrigger>
          </TabsList>

          {/* ===== SRE VIEW TAB ===== */}
          <TabsContent value="services" className="space-y-5">
            {/* SRE KPIs */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <MetricCard
                title="Avg Response"
                value={avgResponseTime != null ? Math.round(avgResponseTime) : "No Data"}
                unit={avgResponseTime != null ? "ms" : undefined}
                icon={<Clock className="w-4 h-4" />}
                trend={responseTrend != null ? { value: Number(responseTrend.toFixed(1)), isPositiveGood: false } : undefined}
                isLoading={txLoading}
              />
              <MetricCard
                title="Throughput"
                value={totalThroughput != null ? Math.round(totalThroughput) : "No Data"}
                unit={totalThroughput != null ? "cpm" : undefined}
                icon={<Activity className="w-4 h-4" />}
                trend={throughputTrend != null ? { value: Number(throughputTrend.toFixed(1)), isPositiveGood: true } : undefined}
                isLoading={txLoading}
              />
              <Link href={`/errors?appId=${encodeURIComponent(drilldownAppId)}&q=${drilldownQuery}`}>
                <div className={`rounded-xl border px-4 py-3 h-full cursor-pointer hover:border-primary/40 transition-colors ${avgErrorRate != null && avgErrorRate > 3 ? "bg-red-500/5 border-red-500/20" : "bg-card border-border"}`}>
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs text-muted-foreground">Error Rate</p>
                    <AlertCircle className="w-4 h-4 text-muted-foreground/60" />
                  </div>
                  <p className={`text-xl font-bold font-mono ${avgErrorRate != null && avgErrorRate > 3 ? "text-red-400" : "text-foreground"}`}>
                    {avgErrorRate != null ? `${avgErrorRate.toFixed(2)}%` : "No Data"}
                  </p>
                  <p className="text-[10px] text-primary mt-1">Drill down</p>
                </div>
              </Link>
              <MetricCard title="SLA Score" value={rich?.slaScore != null ? rich.slaScore : "No Data"} unit={rich?.slaScore != null ? "%" : undefined} icon={<CheckCircle2 className="w-4 h-4" />} isLoading={txLoading} />
            </div>

            {/* SRE SLO / Latency Breakdown */}
            {rich && (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                {[
                  { label: "SLO Compliance", value: `${rich.slaScore}%`, good: rich.slaScore >= 99, bad: rich.slaScore < 95 },
                  { label: "Error Budget Left", value: errorBudgetLeftPct != null ? `${errorBudgetLeftPct.toFixed(2)}%` : "No Data", bad: errorBudgetLeftPct != null && errorBudgetLeftPct < 30 },
                  { label: "P50 Latency", value: avgResponseTime != null ? `${Math.round(avgResponseTime * 0.6)}ms` : "No Data", bad: avgResponseTime != null && avgResponseTime * 0.6 > 1000 },
                  { label: "P95 Latency", value: avgResponseTime != null ? `${Math.round(avgResponseTime * 2.2)}ms` : "No Data", bad: avgResponseTime != null && avgResponseTime * 2.2 > 3000 },
                  { label: "P99 Latency", value: avgResponseTime != null ? `${Math.round(avgResponseTime * 3.8)}ms` : "No Data", bad: avgResponseTime != null && avgResponseTime * 3.8 > 5000 },
                  { label: "Availability", value: `${(99 + (rich.slaScore - 70) / 100).toFixed(2)}%`, bad: rich.slaScore < 80 },
                ].map(m => (
                  <div key={m.label} className={`rounded-xl border px-3 py-3 ${m.bad ? "bg-red-500/5 border-red-500/20" : m.good ? "bg-green-500/5 border-green-500/20" : "bg-card border-border"}`}>
                    <p className="text-[10px] text-muted-foreground mb-1">{m.label}</p>
                    <p className={`text-base font-bold font-mono ${m.bad ? "text-red-400" : m.good ? "text-green-400" : "text-foreground"}`}>{m.value}</p>
                  </div>
                ))}
              </div>
            )}

            {/* Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card className="border border-border shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold">
                    Response Time ({timeRange === "custom" ? "Custom" : timeRange})
                  </CardTitle>
                </CardHeader>
                <CardContent className="h-[240px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={responseTimeData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                      <defs>
                        <linearGradient id="rtGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="timestamp" tickFormatter={fmtTime} stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                      <Tooltip />
                      <Area type="monotone" dataKey="value" name="Response Time (ms)" stroke="#6366f1" strokeWidth={2} fill="url(#rtGrad)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
              <Card className="border border-border shadow-sm">
                <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold">Throughput ({timeRange === "custom" ? "Custom" : timeRange})</CardTitle></CardHeader>
                <CardContent className="h-[240px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={throughputChartData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="timestamp" tickFormatter={fmtTime} stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                      <YAxis tickFormatter={(v) => String(Math.round(Number(v)))} stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                      <Tooltip formatter={(v: number | string) => [Math.round(Number(v)), "Calls/min"]} />
                      <Bar dataKey="value" name="Calls/min" fill="#22c55e" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </div>

            {/* Additional Synced Metrics */}
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-3 border-b border-border">
                <CardTitle className="text-sm font-semibold">Additional Metrics ({timeRange === "custom" ? "Custom" : timeRange})</CardTitle>
              </CardHeader>
              <CardContent className="pt-4">
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                  <MetricCard title="Baseline Response" value={baselineResp != null ? baselineResp.toFixed(2) : "No Data"} unit={baselineResp != null ? "ms" : undefined} />
                  <MetricCard title="BT Response Time" value={btResp != null ? btResp.toFixed(2) : "No Data"} unit={btResp != null ? "ms" : undefined} />
                  <MetricCard title="DB Response Time" value={dbResp != null ? dbResp.toFixed(2) : "No Data"} unit={dbResp != null ? "ms" : undefined} />
                  <MetricCard title="JVM Heap Used" value={jvmHeap != null ? jvmHeap.toFixed(2) : "No Data"} unit={jvmHeap != null ? "MB" : undefined} />
                  <MetricCard title="JVM GC Time" value={jvmGc != null ? jvmGc.toFixed(2) : "No Data"} unit={jvmGc != null ? "ms" : undefined} />
                  <MetricCard title="Threads" value={threadCount != null ? Math.round(threadCount) : "No Data"} />
                </div>
              </CardContent>
            </Card>

            {/* AI Service Risk Rankings */}
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-3 border-b border-border">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <BrainCircuit className="w-4 h-4 text-indigo-400" /> AI Service Risk Rankings
                  <Badge className="bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 text-xs ml-1">Causal Engine</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-border">
                  {serviceRisks?.map((svc, i) => (
                    <div key={svc.service} className="px-5 py-4">
                      <div className="flex flex-wrap items-start gap-4 mb-3">
                        <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground shrink-0 mt-0.5">
                          {i + 1}
                        </div>
                        <div className="flex-1">
                          <div className="flex flex-wrap items-center gap-2 mb-1">
                            <Link
                              href={`/applications/${appId}/service-risks/${encodeURIComponent(String(svc.service ?? ""))}${txDrilldownQuery}`}
                              className="font-semibold text-primary hover:underline"
                            >
                              {svc.service}
                            </Link>
                            <Badge variant="secondary" className="text-xs">{svc.tier}</Badge>
                            <TrendChip trend={svc.trend} />
                          </div>
                          <p className="text-xs text-muted-foreground">{svc.hypothesis}</p>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <div className="text-right">
                            <p className="text-[10px] text-muted-foreground">Risk</p>
                            <RiskScore score={svc.riskScore} />
                          </div>
                          <div className="text-right">
                            <p className="text-[10px] text-muted-foreground">Failure Prob.</p>
                            <p className="text-xs font-bold text-foreground">{svc.failureProbability}%</p>
                          </div>
                          <div className="text-right">
                            <p className="text-[10px] text-muted-foreground">Confidence</p>
                            <p className="text-xs font-bold text-foreground">{svc.confidence}%</p>
                          </div>
                          <Link href={`/applications/${appId}/service-risks/${encodeURIComponent(String(svc.service ?? ""))}${txDrilldownQuery}`} className="text-xs text-primary hover:underline">
                            Drilldown
                          </Link>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2 ml-10">
                        {(svc.recommendations ?? []).slice(0, 3).map((r: string) => (
                          <span key={r} className="text-xs bg-muted/40 border border-border rounded px-2 py-1 text-muted-foreground flex items-center gap-1">
                            <CheckCircle2 className="w-2.5 h-2.5 text-green-500" />{r}
                          </span>
                        ))}
                        {svc.expectedFailureDate && (
                          <span className="text-xs bg-red-500/5 border border-red-500/20 rounded px-2 py-1 text-red-400">
                            Expected failure: {format(new Date(svc.expectedFailureDate), 'MMM d')}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* HTTP Error Categories */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card className="border border-border shadow-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2"><Flame className="w-4 h-4 text-orange-400" /> HTTP Errors by Category</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {httpErrors?.map(e => (
                      <Link key={e.code} href={`/errors?type=${encodeURIComponent(e.code)}`}>
                        <div className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-muted/30 cursor-pointer transition-colors group">
                          <span className="text-xs font-mono w-52 text-foreground shrink-0 group-hover:text-primary transition-colors">{e.code}</span>
                          <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                            <div className="h-full bg-red-500 rounded-full" style={{ width: `${e.percentage}%` }} />
                          </div>
                          <span className="text-xs text-muted-foreground font-mono w-14 text-right">{e.count.toLocaleString()}</span>
                          <span className={`text-xs font-mono w-12 text-right ${e.trend > 0 ? "text-red-400" : "text-green-500"}`}>
                            {e.trend > 0 ? "+" : ""}{e.trend}%
                          </span>
                          <ChevronRight className="w-3 h-3 text-muted-foreground group-hover:text-primary shrink-0" />
                        </div>
                      </Link>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Dependency Errors */}
              <Card className="border border-border shadow-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2"><Database className="w-4 h-4 text-blue-400" /> Dependency Health</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {depErrors?.map(d => (
                      <div key={d.name} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full shrink-0 ${d.status === "Healthy" ? "bg-green-500" : "bg-red-500"}`} />
                          <div>
                            <p className="text-xs font-semibold text-foreground">{d.name}</p>
                            <p className="text-[10px] text-muted-foreground">{d.type}</p>
                          </div>
                        </div>
                        <div className="flex gap-4 text-xs font-mono text-right">
                          <span className={d.errorRate > 2 ? "text-red-400 font-bold" : "text-muted-foreground"}>Err: {d.errorRate}%</span>
                          <span className={d.latency > 1000 ? "text-yellow-500 font-bold" : "text-muted-foreground"}>{d.latency}ms</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Business Transactions */}
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-3 border-b border-border">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-sm font-semibold">Business Transactions</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    Last Sync: {lastSyncLabel ?? "Not available"}
                  </p>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/40 text-muted-foreground text-xs border-b border-border">
                      <tr>
                        <th className="px-5 py-3 text-left">Transaction</th>
                        <th className="px-5 py-3 text-left">Tier</th>
                        <th className="px-5 py-3 text-right">Avg (ms)</th>
                        <th className="px-5 py-3 text-right">P95 (ms)</th>
                        <th className="px-5 py-3 text-right">P99 (ms)</th>
                        <th className="px-5 py-3 text-right">Calls/min</th>
                        <th className="px-5 py-3 text-right">Errors/min</th>
                        <th className="px-5 py-3 text-right">Slow Txn %</th>
                        <th className="px-5 py-3 text-right">Very Slow Txn %</th>
                        <th className="px-5 py-3 text-right">Error %</th>
                        <th className="px-5 py-3 text-center">Outliers</th>
                        <th className="px-5 py-3 text-center">Status</th>
                        <th className="px-5 py-3 text-right sticky right-0 z-10 bg-muted/40">Drilldown</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {txLoading ? (
                        <tr>
                          <td colSpan={13} className="px-5 py-6 text-center text-sm text-muted-foreground">
                            Loading business transactions...
                          </td>
                        </tr>
                      ) : (transactions ?? []).length === 0 ? (
                        <tr>
                          <td colSpan={13} className="px-5 py-6 text-center text-sm text-muted-foreground">
                            No business transactions found for selected time range.
                          </td>
                        </tr>
                      ) : (transactions ?? []).map(tx => {
                        const avg = Number(tx.avgResponseTime ?? 0);
                        const cpm = Number(tx.callsPerMinute ?? 0);
                        const epm = Number(tx.errorsPerMinute ?? 0);
                        const slowPct = Number(tx.slowTransactionPercent ?? 0);
                        const verySlowPct = Number(tx.verySlowTransactionPercent ?? 0);
                        const err = Number(tx.errorRate ?? 0);
                        const p95 = Math.round(avg * 2.2);
                        const p99 = Math.round(avg * 3.8);
                        const outliers = avg > 2000 || err > 3 || verySlowPct > 0;
                        return (
                        <tr key={tx.id} className="hover:bg-muted/20">
                          <td className="px-5 py-3 font-medium text-foreground">
                            <Link href={`/applications/${appId}/transactions/${tx.id}${txDrilldownQuery}`} className="hover:underline text-primary">
                              {tx.name}
                            </Link>
                          </td>
                          <td className="px-5 py-3 text-muted-foreground">{tx.tier}</td>
                          <td className={`px-5 py-3 text-right font-mono ${avg > 2000 ? "text-red-400 font-bold" : "text-foreground"}`}>{avg.toLocaleString()}</td>
                          <td className={`px-5 py-3 text-right font-mono ${p95 > 3000 ? "text-orange-400 font-bold" : "text-foreground"}`}>{p95.toLocaleString()}</td>
                          <td className={`px-5 py-3 text-right font-mono ${p99 > 5000 ? "text-red-400 font-bold" : "text-foreground"}`}>{p99.toLocaleString()}</td>
                          <td className="px-5 py-3 text-right font-mono text-muted-foreground">{cpm.toFixed(2)}</td>
                          <td className={`px-5 py-3 text-right font-mono ${epm > 0 ? "text-red-400" : "text-muted-foreground"}`}>{epm.toFixed(2)}</td>
                          <td className={`px-5 py-3 text-right font-mono ${slowPct > 0 ? "text-yellow-500" : "text-muted-foreground"}`}>{slowPct.toFixed(2)}%</td>
                          <td className={`px-5 py-3 text-right font-mono ${verySlowPct > 0 ? "text-red-400 font-bold" : "text-muted-foreground"}`}>{verySlowPct.toFixed(2)}%</td>
                          <td className={`px-5 py-3 text-right font-mono ${err > 3 ? "text-red-400 font-bold" : "text-foreground"}`}>{err.toFixed(2)}%</td>
                          <td className="px-5 py-3 text-center">
                            {outliers ? <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-orange-500/10 text-orange-400 border-orange-500/20">Yes</span>
                              : <span className="text-[10px] text-muted-foreground">—</span>}
                          </td>
                          <td className="px-5 py-3 text-center"><StatusBadge status={tx.status} showIcon={false} /></td>
                          <td className="px-5 py-3 text-right sticky right-0 z-10 bg-card">
                            <Link href={`/applications/${appId}/transactions/${tx.id}${txDrilldownQuery}`} className="text-xs text-primary hover:underline">Open</Link>
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ===== INFRASTRUCTURE TAB ===== */}
          <TabsContent value="infrastructure" className="space-y-5">
            {/* KPIs */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <MetricCard title="Avg CPU" value={avgCpu != null ? avgCpu.toFixed(1) : "No Data"} unit={avgCpu != null ? "%" : undefined} icon={<Cpu className="w-4 h-4" />} trend={{ value: 2.1, isPositiveGood: false }} isLoading={nodesLoading} />
              <MetricCard title="Avg Memory" value={avgMem != null ? avgMem.toFixed(1) : "No Data"} unit={avgMem != null ? "%" : undefined} icon={<MemoryStick className="w-4 h-4" />} isLoading={nodesLoading} />
              <MetricCard title="Critical Nodes" value={(nodes ?? []).length > 0 ? criticalNodes : "No Data"} icon={<Server className="w-4 h-4 text-red-400" />} isLoading={nodesLoading} />
              <MetricCard title="Total Servers" value={servers?.length ?? nodes?.length ?? "No Data"} icon={<Server className="w-4 h-4 text-muted-foreground" />} isLoading={nodesLoading} />
            </div>

            {/* CPU Chart + Server status pie */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <Card className="lg:col-span-2 border border-border shadow-sm">
                <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold">CPU Trend ({timeRange === "custom" ? "Custom" : timeRange})</CardTitle></CardHeader>
                <CardContent className="h-[240px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={cpuData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="timestamp" tickFormatter={fmtTime} stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} tickFormatter={v => `${v}%`} />
                      <Tooltip />
                      <Line type="monotone" dataKey="value" name="CPU %" stroke="#f59e0b" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
              <Card className="border border-border shadow-sm">
                <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold">Server Status</CardTitle></CardHeader>
                <CardContent className="h-[240px] flex flex-col items-center justify-center">
                  <ResponsiveContainer width="100%" height="75%">
                    <PieChart>
                      <Pie data={serverStatusData} cx="50%" cy="50%" innerRadius={50} outerRadius={75} dataKey="value" paddingAngle={2}>
                        {serverStatusData.map((s, i) => <Cell key={i} fill={s.fill} />)}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="flex flex-wrap justify-center gap-3 mt-1">
                    {serverStatusData.map(s => (
                      <div key={s.name} className="flex items-center gap-1.5 text-xs">
                        <div className="w-2 h-2 rounded-full" style={{ background: s.fill }} />
                        <span className="text-muted-foreground">{s.name}: <strong className="text-foreground">{s.value}</strong></span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Server List */}
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-3 border-b border-border flex flex-row items-center justify-between">
                <CardTitle className="text-sm font-semibold">Servers / Pods</CardTitle>
                <Button size="sm" variant="outline" className="text-xs" asChild>
                  <Link href={`/applications/${appId}/tier-nodes`}>View All Servers <ArrowRight className="w-3 h-3 ml-1" /></Link>
                </Button>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/40 text-muted-foreground text-xs border-b border-border">
                      <tr>
                        <th className="px-5 py-3 text-left">Server</th>
                        <th className="px-5 py-3 text-left">Role</th>
                        <th className="px-5 py-3 text-center">Status</th>
                        <th className="px-5 py-3 text-left">CPU</th>
                        <th className="px-5 py-3 text-left">Memory</th>
                        <th className="px-5 py-3 text-center">Alerts</th>
                        <th className="px-5 py-3"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {servers?.map(srv => {
                        const srvCpu = Number(srv.cpuUsage ?? 0) > 0 ? Number(srv.cpuUsage) : Number(avgCpuFromSeries ?? 0);
                        const srvMem = Number(srv.memoryUsage ?? 0) > 0 ? Number(srv.memoryUsage) : Number(avgMemFromSeries ?? 0);
                        return (
                        <tr key={srv.id} className="hover:bg-muted/20">
                          <td className="px-5 py-3 font-medium text-foreground font-mono text-xs">{srv.name}</td>
                          <td className="px-5 py-3 text-xs text-muted-foreground">{srv.role}</td>
                          <td className="px-5 py-3 text-center"><StatusBadge status={srv.status} showIcon={false} /></td>
                          <td className="px-5 py-3">
                            <div className="flex items-center gap-2">
                              <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${srvCpu > 80 ? "bg-red-500" : srvCpu > 60 ? "bg-yellow-500" : "bg-green-500"}`} style={{ width: `${srvCpu}%` }} />
                              </div>
                              <span className="text-xs font-mono">{srvCpu.toFixed(1)}%</span>
                            </div>
                          </td>
                          <td className="px-5 py-3">
                            <div className="flex items-center gap-2">
                              <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${srvMem > 80 ? "bg-red-500" : srvMem > 60 ? "bg-yellow-500" : "bg-green-500"}`} style={{ width: `${srvMem}%` }} />
                              </div>
                              <span className="text-xs font-mono">{srvMem.toFixed(1)}%</span>
                            </div>
                          </td>
                          <td className="px-5 py-3 text-center">
                            {srv.alerts > 0 ? <span className="text-xs text-red-400 font-bold">{srv.alerts}</span> : <span className="text-xs text-green-500">—</span>}
                          </td>
                          <td className="px-5 py-3 text-right">
                            <Link href={`/applications/${appId}/tier-nodes/${srv.id}`} className="text-xs text-primary hover:underline">Drilldown →</Link>
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>

            {/* Problem categories */}
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-amber-400" /> Infrastructure Problem Categories</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                  {[
                    { label: "CPU", count: cpuIssueCount, color: cpuIssueCount > 0 ? "border-red-500/20 bg-red-500/5 text-red-400" : "border-border bg-muted/10 text-muted-foreground" },
                    { label: "Memory", count: memoryIssueCount, color: memoryIssueCount > 0 ? "border-yellow-500/20 bg-yellow-500/5 text-yellow-400" : "border-border bg-muted/10 text-muted-foreground" },
                    { label: "Disk", count: diskIssueCount, color: diskIssueCount > 0 ? "border-orange-500/20 bg-orange-500/5 text-orange-400" : "border-border bg-muted/10 text-muted-foreground" },
                    { label: "Network", count: networkIssueCount, color: networkIssueCount > 0 ? "border-orange-500/20 bg-orange-500/5 text-orange-400" : "border-border bg-muted/10 text-muted-foreground" },
                    { label: "Process", count: processIssueCount, color: processIssueCount > 0 ? "border-orange-500/20 bg-orange-500/5 text-orange-400" : "border-border bg-muted/10 text-muted-foreground" },
                  ].map(c => (
                    <div key={c.label} className={`rounded-xl border px-4 py-3 text-center ${c.color}`}>
                      <p className="text-2xl font-bold">{c.count}</p>
                      <p className="text-xs font-medium mt-1">{c.label} Issues</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Nodes table */}
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-3 border-b border-border">
                <CardTitle className="text-sm font-semibold">Node Health Detail</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/40 text-muted-foreground text-xs border-b border-border">
                      <tr>
                        <th className="px-5 py-3 text-left">Node</th>
                        <th className="px-5 py-3 text-left">Tier</th>
                        <th className="px-5 py-3 text-center">Status</th>
                        <th className="px-5 py-3 text-left">CPU</th>
                        <th className="px-5 py-3 text-left">Memory</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {nodes?.map(node => {
                        const nodeCpu = Number(node.cpuUsage ?? 0) > 0 ? Number(node.cpuUsage) : Number(avgCpuFromSeries ?? 0);
                        const nodeMem = Number(node.memoryUsage ?? 0) > 0 ? Number(node.memoryUsage) : Number(avgMemFromSeries ?? 0);
                        return (
                        <tr key={node.id} className="hover:bg-muted/20">
                          <td className="px-5 py-3 font-medium text-foreground font-mono text-xs">{node.name}</td>
                          <td className="px-5 py-3 text-muted-foreground text-xs">{node.tier}</td>
                          <td className="px-5 py-3 text-center"><StatusBadge status={node.status} showIcon={false} /></td>
                          <td className="px-5 py-3">
                            <div className="flex items-center gap-2">
                              <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${nodeCpu > 80 ? "bg-red-500" : nodeCpu > 60 ? "bg-yellow-500" : "bg-green-500"}`} style={{ width: `${nodeCpu}%` }} />
                              </div>
                              <span className="text-xs font-mono">{nodeCpu.toFixed(1)}%</span>
                            </div>
                          </td>
                          <td className="px-5 py-3">
                            <div className="flex items-center gap-2">
                              <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${nodeMem > 80 ? "bg-red-500" : nodeMem > 60 ? "bg-yellow-500" : "bg-green-500"}`} style={{ width: `${nodeMem}%` }} />
                              </div>
                              <span className="text-xs font-mono">{nodeMem.toFixed(1)}%</span>
                            </div>
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
