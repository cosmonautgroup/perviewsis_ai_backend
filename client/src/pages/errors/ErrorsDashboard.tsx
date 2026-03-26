import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ShieldAlert, BrainCircuit, Flame, Database, Wifi,
  ChevronDown, ChevronRight, Search, AlertTriangle, Zap, CalendarDays
} from "lucide-react";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell, PieChart, Pie
} from "recharts";
import { formatDistanceToNow, format } from "date-fns";

const SEV_CLASSES: Record<string, string> = {
  Critical: "bg-red-500/10 text-red-400 border-red-500/20",
  High: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  Medium: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  Low: "bg-blue-500/10 text-blue-400 border-blue-500/20",
};

const TYPE_ICON: Record<string, any> = {
  "5xx – Internal Server Error": <Flame className="w-3.5 h-3.5 text-red-400" />,
  "5xx – Service Unavailable": <Flame className="w-3.5 h-3.5 text-red-400" />,
  "5xx – Gateway Timeout": <Wifi className="w-3.5 h-3.5 text-orange-400" />,
  "Database Error": <Database className="w-3.5 h-3.5 text-blue-400" />,
  "Timeout – External API": <Wifi className="w-3.5 h-3.5 text-orange-400" />,
  "JVM Warning": <AlertTriangle className="w-3.5 h-3.5 text-yellow-400" />,
  "Client Error – 429": <AlertTriangle className="w-3.5 h-3.5 text-blue-400" />,
};

const CLUSTER_COLOR_PALETTE = ["#ef4444", "#f97316", "#3b82f6", "#8b5cf6", "#22c55e", "#ec4899", "#14b8a6", "#eab308"];
const CLUSTER_COLORS: Record<string, string> = {
  "CLU-001": "#ef4444", "CLU-002": "#f97316", "CLU-003": "#3b82f6", "CLU-004": "#8b5cf6", "CLU-005": "#22c55e"
};
function getClusterColor(clusterId: string, index: number): string {
  return CLUSTER_COLORS[clusterId] ?? CLUSTER_COLOR_PALETTE[index % CLUSTER_COLOR_PALETTE.length];
}

const CLUSTER_META: Record<string, any> = {
  "CLU-001": { label: "JVM Memory / GC Cluster", rootCause: "Memory leak in SessionManager.java causing JVM heap exhaustion and GC pause spikes. GC cannot reclaim memory fast enough under production load.", confidence: 92, action: "Apply SessionManager hotfix v2.1.4 + increase JVM heap to -Xmx6g" },
  "CLU-002": { label: "Thread Pool Exhaustion Cluster", rootCause: "Frontend thread pool saturated (200/200 threads). Caused by upstream CPU saturation which backs up request processing, leading to 503/504 cascade.", confidence: 88, action: "Scale frontend to 6 pods immediately + implement request queuing with max-size limit" },
  "CLU-003": { label: "Database Connection Cluster", rootCause: "PostgreSQL connection pool exhausted. High DB latency (1820ms avg) combined with slow query on product search causing connection holding and starvation.", confidence: 82, action: "Add composite index on (category_id, price) + deploy PgBouncer connection pooler" },
  "CLU-004": { label: "External API Timeout Cluster", rootCause: "Bank settlement API p99 exceeds 4200ms. Missing circuit breaker allows cascading timeout accumulation in payment service.", confidence: 74, action: "Implement circuit breaker for bank API calls + add retry with exponential backoff" },
  "CLU-005": { label: "Rate Limiting / Client Errors", rootCause: "Auth service receiving burst traffic exceeding 1000 req/min rate limit. Token validation spike from mobile app reconnection storm.", confidence: 68, action: "Increase auth service rate limit + add exponential backoff to mobile client SDK" },
};

const DATE_PRESETS = ["1h", "24h", "7d", "30d", "All", "Custom"] as const;
type DatePreset = typeof DATE_PRESETS[number];
const ALL_APPS_FILTER = "__all_apps__";

function getDateCutoffs(preset: DatePreset, customFrom: string, customTo: string) {
  if (preset === "All") return { from: null, to: null };
  if (preset === "Custom") {
    return {
      from: customFrom ? new Date(customFrom).getTime() : null,
      to: customTo ? new Date(customTo + "T23:59:59").getTime() : null,
    };
  }
  const ms: Record<string, number> = { "1h": 3600000, "24h": 86400000, "7d": 604800000, "30d": 2592000000 };
  return { from: Date.now() - ms[preset], to: null };
}

function buildTrendDataFromErrors(preset: DatePreset, errors: any[], customFrom: string, customTo: string) {
  const now = Date.now();
  let points = 24;
  let intervalMs = 3600000;
  if (preset === "1h")  { points = 12; intervalMs = 5 * 60 * 1000; }
  else if (preset === "24h") { points = 24; intervalMs = 60 * 60 * 1000; }
  else if (preset === "7d")  { points = 28; intervalMs = 6 * 60 * 60 * 1000; }
  else if (preset === "30d") { points = 30; intervalMs = 24 * 60 * 60 * 1000; }
  else if (preset === "Custom") {
    const from = customFrom ? new Date(customFrom).getTime() : now - 24 * 60 * 60 * 1000;
    const to = customTo ? new Date(customTo + "T23:59:59").getTime() : now;
    const span = Math.max(1, to - from);
    points = 24;
    intervalMs = Math.max(5 * 60 * 1000, Math.floor(span / points));
  }

  const firstTs = now - (points - 1) * intervalMs;
  const buckets = Array.from({ length: points }).map((_, i) => ({ timestamp: firstTs + i * intervalMs, count: 0 }));
  for (const e of errors ?? []) {
    const ts = Number(e.timestamp ?? e.lastSeen ?? 0);
    if (!ts || ts < firstTs) continue;
    const idx = Math.min(points - 1, Math.max(0, Math.floor((ts - firstTs) / intervalMs)));
    buckets[idx].count += Number(e.count ?? 1);
  }
  return buckets;
}

function inferClusterMeta(cluster: any) {
  const first = cluster?.errors?.[0] ?? {};
  const sevRank: Record<string, number> = { Critical: 4, High: 3, Medium: 2, Low: 1 };
  const topSev = (cluster?.errors ?? []).reduce((best: string, e: any) =>
    (sevRank[e.severity] ?? 0) > (sevRank[best] ?? 0) ? e.severity : best
  , "Low");
  const rootCause = first?.message
    ? `Most frequent signature: ${String(first.message).slice(0, 220)}`
    : "No detailed root cause text available from provider for this cluster.";
  const action = first?.recommendation ?? "Open the error detail and inspect correlated alerts/incidents for remediation path.";
  return {
    label: first?.type ? `${first.type} Cluster` : `Cluster ${cluster?.clusterId}`,
    rootCause,
    confidence: topSev === "Critical" ? 92 : topSev === "High" ? 84 : topSev === "Medium" ? 72 : 60,
    action,
  };
}

export default function ErrorsDashboard() {
  const urlParams = new URLSearchParams(window.location.search);
  const initialAppId = urlParams.get("appId") ?? "";
  const initialType = urlParams.get("type") ?? "";
  const initialSearch = urlParams.get("q") ?? "";
  const [dateRange, setDateRange]       = useState<DatePreset>("All");
  const [customFrom, setCustomFrom]     = useState("");
  const [customTo, setCustomTo]         = useState("");
  const [search, setSearch]             = useState(initialSearch);
  const [appFilter, setAppFilter]       = useState(initialAppId);
  const [typeFilter, setTypeFilter]     = useState(initialType);
  const [expandedCluster, setExpandedCluster] = useState<string | null>(null);
  const [selectedCluster, setSelectedCluster] = useState<string | null>(null);

  const { data: errors, isLoading } = useQuery<any[]>({
    queryKey: ["/api/errors"],
    queryFn: async () => {
      const res = await fetch("/api/errors");
      if (!res.ok) throw new Error("Failed to load errors");
      return res.json();
    },
  });

  const { from: dateCutoffFrom, to: dateCutoffTo } = getDateCutoffs(dateRange, customFrom, customTo);

  const filtered = (errors ?? []).filter(e => {
    const ts: number = e.timestamp ?? e.lastSeen ?? 0;
    if (dateCutoffFrom !== null && ts < dateCutoffFrom) return false;
    if (dateCutoffTo !== null && ts > dateCutoffTo) return false;
    if (appFilter && String(e.appId ?? "") !== String(appFilter)) return false;
    if (typeFilter && !(String(e.type ?? "").toLowerCase().includes(typeFilter.toLowerCase()) || String(e.message ?? "").toLowerCase().includes(typeFilter.toLowerCase()))) return false;
    if (selectedCluster !== null && e.clusterId !== selectedCluster) return false;
    if (search !== "" &&
      !e.message?.toLowerCase().includes(search.toLowerCase()) &&
      !e.service?.toLowerCase().includes(search.toLowerCase()) &&
      !e.type?.toLowerCase().includes(search.toLowerCase()) &&
      !String(e.requestPath ?? "").toLowerCase().includes(search.toLowerCase()) &&
      !String(e.businessTransaction ?? "").toLowerCase().includes(search.toLowerCase()) &&
      !String(e.callToCheck ?? "").toLowerCase().includes(search.toLowerCase()) &&
      !e.applicationName?.toLowerCase().includes(search.toLowerCase()) &&
      !String(e.appId ?? "").toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });
  const applicationOptions = useMemo(() => {
    const appMap = new Map<string, string>();
    for (const e of errors ?? []) {
      const appId = String(e.appId ?? "").trim();
      if (!appId) continue;
      const appName = String(e.applicationName ?? "").trim();
      if (!appMap.has(appId)) appMap.set(appId, appName || appId);
    }
    return Array.from(appMap.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [errors]);
  const selectedAppLabel =
    appFilter
      ? (applicationOptions.find(a => a.id === String(appFilter))?.name ?? String(appFilter))
      : "";

  const totalCount = filtered.reduce((s, e) => s + e.count, 0);
  const bySeverity = { Critical: 0, High: 0, Medium: 0, Low: 0 } as Record<string, number>;
  filtered.forEach(e => { bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + e.count; });

  const byType = Object.entries(
    filtered.reduce((acc: any, e) => { acc[e.type] = (acc[e.type] ?? 0) + e.count; return acc; }, {})
  ).map(([type, count]) => ({ type, count })).sort((a: any, b: any) => b.count - a.count);

  const bySource = Object.entries(
    filtered.reduce((acc: any, e) => { acc[e.source] = (acc[e.source] ?? 0) + e.count; return acc; }, {})
  ).map(([name, value]) => ({ name, value }));

  const clusters = Object.entries(
    filtered.reduce((acc: any, e) => {
      if (!acc[e.clusterId]) acc[e.clusterId] = { clusterId: e.clusterId, errors: [], totalCount: 0 };
      acc[e.clusterId].errors.push(e);
      acc[e.clusterId].totalCount += e.count;
      return acc;
    }, {})
  ).map(([, v]) => v).sort((a: any, b: any) => b.totalCount - a.totalCount);

  const trendData = useMemo(
    () => buildTrendDataFromErrors(dateRange, filtered, customFrom, customTo),
    [dateRange, filtered, customFrom, customTo]
  );

  const trendFmt = (v: number) =>
    dateRange === "1h" || dateRange === "24h"
      ? format(new Date(v), "HH:mm")
      : format(new Date(v), "MMM d");

  return (
    <AppLayout>
      <div className="space-y-5">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-foreground mb-1 flex items-center gap-2">
            <ShieldAlert className="w-6 h-6 text-red-400" /> Error Dashboard
          </h1>
          <p className="text-sm text-muted-foreground">Centralized error intelligence from AppDynamics, Dynatrace, and OpenTelemetry.</p>
        </div>

        {/* Date Range Filter */}
        <div className="flex flex-wrap items-center gap-2 bg-card border border-border rounded-lg px-3 py-2.5">
          <CalendarDays className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs text-muted-foreground font-medium mr-1">Time range:</span>
          {DATE_PRESETS.map(p => (
            <button
              key={p}
              data-testid={`date-preset-${p}`}
              onClick={() => setDateRange(p)}
              className={`px-2.5 py-1 rounded text-xs border font-medium transition-colors ${
                dateRange === p
                  ? "bg-primary/10 border-primary/30 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >{p}</button>
          ))}
          {dateRange === "Custom" && (
            <>
              <input
                type="date"
                value={customFrom}
                onChange={e => setCustomFrom(e.target.value)}
                data-testid="date-from"
                className="h-7 px-2 text-xs border border-border rounded bg-background text-foreground"
              />
              <span className="text-xs text-muted-foreground">to</span>
              <input
                type="date"
                value={customTo}
                onChange={e => setCustomTo(e.target.value)}
                data-testid="date-to"
                className="h-7 px-2 text-xs border border-border rounded bg-background text-foreground"
              />
            </>
          )}
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground font-medium">Application:</span>
            <Select
              value={appFilter || ALL_APPS_FILTER}
              onValueChange={(value) => setAppFilter(value === ALL_APPS_FILTER ? "" : value)}
            >
              <SelectTrigger data-testid="select-error-application" className="h-8 text-xs w-[220px]">
                <SelectValue placeholder="All applications" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_APPS_FILTER}>All applications</SelectItem>
                {applicationOptions.map((app) => (
                  <SelectItem key={app.id} value={app.id}>{app.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {(appFilter || typeFilter) && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {appFilter && <Badge className="bg-primary/10 text-primary border-primary/20">App: {selectedAppLabel}</Badge>}
            {typeFilter && <Badge className="bg-orange-500/10 text-orange-400 border-orange-500/20">Type: {typeFilter}</Badge>}
            <button
              onClick={() => { setAppFilter(""); setTypeFilter(""); }}
              className="px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground"
            >
              Clear drilldown filters
            </button>
          </div>
        )}

        {/* Summary KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
          <div className="rounded-xl border border-border bg-card px-4 py-3 col-span-2 sm:col-span-1">
            <p className="text-xs text-muted-foreground mb-1">Total Errors</p>
            <p className="text-3xl font-bold text-foreground">{totalCount.toLocaleString()}</p>
          </div>
          {Object.entries(bySeverity).map(([sev, cnt]) => (
            <div key={sev} className={`rounded-xl border px-4 py-3 cursor-pointer ${SEV_CLASSES[sev]}`} onClick={() => setSelectedCluster(null)}>
              <p className="text-xs font-medium opacity-70 mb-1">{sev}</p>
              <p className="text-2xl font-bold">{cnt.toLocaleString()}</p>
            </div>
          ))}
        </div>

        {/* Trend Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          <Card className="lg:col-span-2 border border-border shadow-sm">
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-semibold">Error Rate Over Time</CardTitle>
              <span className="text-xs text-muted-foreground">
                {dateRange === "Custom" && customFrom && customTo
                  ? `${customFrom} → ${customTo}`
                  : dateRange === "All" ? "All time" : `Last ${dateRange}`}
              </span>
            </CardHeader>
            <CardContent className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trendData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="errGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="timestamp" tickFormatter={trendFmt} stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={false} interval={Math.floor(trendData.length / 6)} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={false} />
                  <Tooltip labelFormatter={v => format(new Date(v), "MMM d HH:mm")} />
                  <Area type="monotone" dataKey="count" name="Errors" stroke="#ef4444" strokeWidth={2} fill="url(#errGrad)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className="border border-border shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">Errors by Source</CardTitle>
            </CardHeader>
            <CardContent className="h-[200px] flex flex-col items-center">
              <ResponsiveContainer width="100%" height="75%">
                <PieChart>
                  <Pie data={bySource} cx="50%" cy="50%" innerRadius={45} outerRadius={70} dataKey="value" paddingAngle={2}>
                    {bySource.map((_, i) => <Cell key={i} fill={["#6366f1", "#8b5cf6", "#06b6d4"][i % 3]} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex flex-wrap justify-center gap-3 mt-1">
                {bySource.map((s, i) => (
                  <div key={s.name} className="flex items-center gap-1 text-xs">
                    <div className="w-2 h-2 rounded-full" style={{ background: ["#6366f1", "#8b5cf6", "#06b6d4"][i % 3] }} />
                    <span className="text-muted-foreground">{s.name}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Errors by Type bar */}
        {byType.length > 0 && (
          <Card className="border border-border shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">Top Error Categories</CardTitle>
            </CardHeader>
            <CardContent className="h-[160px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={byType} layout="vertical" margin={{ top: 0, right: 30, left: 10, bottom: 0 }}>
                  <XAxis type="number" fontSize={10} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} />
                  <YAxis type="category" dataKey="type" fontSize={9} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} width={180} />
                  <Tooltip />
                  <Bar dataKey="count" name="Count" radius={[0, 4, 4, 0]}>
                    {byType.map((_, i) => <Cell key={i} fill={["#ef4444", "#f97316", "#f59e0b", "#3b82f6", "#8b5cf6", "#22c55e", "#06b6d4"][i % 7]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
          {/* Error Clusters */}
          <div className="xl:col-span-2 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <BrainCircuit className="w-4 h-4 text-indigo-400" /> AI Error Clusters
                {selectedCluster && (
                  <button onClick={() => setSelectedCluster(null)} className="text-xs text-muted-foreground hover:text-foreground border border-border rounded px-2 py-0.5">Clear filter</button>
                )}
              </h2>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <Input data-testid="input-search-errors" placeholder="Search errors..." value={search} onChange={e => setSearch(e.target.value)} className="pl-8 h-8 text-xs w-56" />
              </div>
            </div>

            {isLoading ? (
              <div className="space-y-3">{Array(3).fill(0).map((_, i) => <Skeleton key={i} className="h-20" />)}</div>
            ) : clusters.length === 0 ? (
              <div className="py-10 text-center text-muted-foreground">
                <ShieldAlert className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm font-medium">No errors in this time range</p>
                <p className="text-xs mt-1">Try expanding the date range filter above.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {clusters.map((cluster: any, idx: number) => {
                  const meta = CLUSTER_META[cluster.clusterId] ?? inferClusterMeta(cluster);
                  const isExpanded = expandedCluster === cluster.clusterId;
                  const clusterErrors = filtered.filter(e => e.clusterId === cluster.clusterId);
                  if (filtered.length > 0 && clusterErrors.length === 0) return null;
                  return (
                    <Card key={cluster.clusterId} className={`border shadow-sm transition-all ${selectedCluster === cluster.clusterId ? "border-primary/40 bg-primary/5" : "border-border"}`}>
                      <CardHeader className="pb-3 cursor-pointer" onClick={() => setExpandedCluster(isExpanded ? null : cluster.clusterId)}>
                        <div className="flex items-center gap-3">
                          <div className="w-3 h-3 rounded-full shrink-0" style={{ background: getClusterColor(cluster.clusterId, idx) }} />
                          <div className="flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <CardTitle className="text-sm font-semibold text-foreground">{meta?.label ?? cluster.clusterId}</CardTitle>
                              <Badge className="bg-muted text-muted-foreground border-border text-xs">{cluster.errors.length} error types</Badge>
                              <span className="text-xs font-bold text-red-400">{cluster.totalCount.toLocaleString()} occurrences</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              data-testid={`btn-filter-cluster-${cluster.clusterId}`}
                              onClick={e => { e.stopPropagation(); setSelectedCluster(c => c === cluster.clusterId ? null : cluster.clusterId); }}
                              className={`text-xs px-2 py-1 rounded border transition-colors ${selectedCluster === cluster.clusterId ? "bg-primary/10 border-primary/30 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
                            >
                              {selectedCluster === cluster.clusterId ? "Clear" : "Filter"}
                            </button>
                            {isExpanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                          </div>
                        </div>
                      </CardHeader>

                      {isExpanded && (
                        <CardContent className="pt-0 space-y-4 border-t border-border">
                          {meta && (
                            <div className="mt-4 bg-card border border-indigo-500/20 rounded-xl p-4">
                              <div className="flex items-center gap-2 mb-2">
                                <BrainCircuit className="w-3.5 h-3.5 text-indigo-400" />
                                <p className="text-xs font-semibold text-indigo-300">Root Cause Analysis</p>
                                <span className="text-[10px] bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-1.5 py-0.5 rounded font-bold">{meta.confidence}% confidence</span>
                              </div>
                              <p className="text-xs text-foreground leading-relaxed">{meta.rootCause}</p>
                              <div className="mt-3 flex items-start gap-2 bg-green-500/5 border border-green-500/20 rounded-lg px-3 py-2">
                                <Zap className="w-3.5 h-3.5 text-green-400 shrink-0 mt-0.5" />
                                <p className="text-xs text-green-300">{meta.action}</p>
                              </div>
                            </div>
                          )}

                          <div className="space-y-2">
                            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Errors in this cluster</p>
                            {cluster.errors.map((e: any) => (
                              <div key={e.errorId} className="rounded-lg border border-border bg-muted/10 px-4 py-3">
                                <div className="flex flex-wrap items-start justify-between gap-2">
                                  <div className="flex-1">
                                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                                      {TYPE_ICON[e.type] ?? <AlertTriangle className="w-3.5 h-3.5 text-muted-foreground" />}
                                      <span className="text-xs font-semibold text-foreground">{e.type}</span>
                                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${SEV_CLASSES[e.severity]}`}>{e.severity}</span>
                                      <span className="text-[10px] text-muted-foreground">{e.source}</span>
                                    </div>
                                    <p className="text-[11px] font-mono text-muted-foreground">{e.message}</p>
                                    {(e.callToCheck || e.requestPath || e.businessTransaction) && (
                                      <p className="text-[11px] mt-1">
                                        <span className="text-muted-foreground">Call to check: </span>
                                        <span className="font-mono text-primary">{e.callToCheck ?? e.requestPath ?? e.businessTransaction}</span>
                                      </p>
                                    )}
                                    <p className="text-[10px] text-muted-foreground mt-1">
                                      {e.service} · {e.server} · {(e.timestamp ?? e.lastSeen) ? formatDistanceToNow(new Date(e.timestamp ?? e.lastSeen), { addSuffix: true }) : "—"}
                                    </p>
                                  </div>
                                    {e.recommendation && (
                                      <div className="mt-1.5 rounded-md border border-green-500/20 bg-green-500/5 px-2 py-1">
                                        <p className="text-[10px] text-green-300">Recommendation: {e.recommendation}</p>
                                      </div>
                                    )}
                                  <div className="text-right shrink-0 space-y-1">
                                    <p className="text-sm font-bold text-red-400">{e.count.toLocaleString()}</p>
                                    <p className="text-[10px] text-muted-foreground">occurrences</p>
                                    <Link href={`/errors/${e.errorId}`} className="text-[10px] text-green-400 hover:underline block">Open Recommendation ↗</Link>
                                    <Link href={`/errors/${e.errorId}`} className="text-xs text-primary hover:underline block">Detail →</Link>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </CardContent>
                      )}
                    </Card>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right: AI Insights Panel */}
          <div className="space-y-4">
            <Card className="border border-indigo-500/20 bg-indigo-500/5 shadow-sm">
              <CardContent className="px-4 py-6">
                <div className="flex items-center gap-2 mb-2">
                  <BrainCircuit className="w-4 h-4 text-indigo-400" />
                  <p className="text-xs font-semibold text-indigo-300">Live Error Insights</p>
                </div>
                <p className="text-xs text-muted-foreground mb-1">Active clusters: <span className="text-foreground font-semibold">{clusters.length}</span></p>
                <p className="text-xs text-muted-foreground mb-1">Top source: <span className="text-foreground font-semibold">{bySource[0]?.name ?? "N/A"}</span></p>
                <p className="text-xs text-muted-foreground">Top category: <span className="text-foreground font-semibold">{byType[0]?.type ?? "N/A"}</span></p>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
