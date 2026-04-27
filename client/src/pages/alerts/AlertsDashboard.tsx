import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Bell, AlertTriangle, BrainCircuit, Search,
  ChevronRight, CalendarDays
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis,
  Tooltip, ResponsiveContainer, Cell
} from "recharts";
import { formatDistanceToNow, format } from "date-fns";

const APP_COLORS = ["#6366f1", "#8b5cf6", "#06b6d4", "#f59e0b", "#22c55e", "#ef4444", "#f97316", "#ec4899"];

const SEV_CLASSES: Record<string, string> = {
  Critical: "bg-red-500/10 text-red-400 border-red-500/20",
  High: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  Medium: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  Low: "bg-blue-500/10 text-blue-400 border-blue-500/20",
};

const STATUS_CLASSES: Record<string, string> = {
  Active: "bg-red-500/10 text-red-400 border-red-500/20",
  Acknowledged: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  Resolved: "bg-green-500/10 text-green-400 border-green-500/20",
};

function Chip({ label, cls }: { label: string; cls: string }) {
  return <span className={`text-[10px] font-semibold px-2 py-0.5 rounded border ${cls}`}>{label}</span>;
}

function RiskGauge({ score }: { score: number }) {
  const color = score > 75 ? "text-red-400" : score > 45 ? "text-yellow-400" : "text-green-400";
  return <span className={`text-sm font-bold font-mono ${color}`}>{score}</span>;
}

const SEVERITIES = ["All", "Critical", "High", "Medium", "Low"];
const STATUSES = ["All", "Active", "Acknowledged", "Resolved"];
const DATE_PRESETS = ["1h", "24h", "7d", "30d", "All", "Custom"] as const;
type DatePreset = typeof DATE_PRESETS[number];

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

export default function AlertsDashboard() {
  const urlParams = new URLSearchParams(window.location.search);
  const initialAppId = urlParams.get("appId") ?? "";
  const initialAppName = urlParams.get("appName") ?? "";
  const sourceIncidentId = urlParams.get("incidentId") ?? "";
  const [search, setSearch] = useState("");
  const [appFilter, setAppFilter] = useState(initialAppId || initialAppName || "All");
  const [sevFilter, setSevFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState("All");
  const [selectedAlert, setSelectedAlert] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<DatePreset>("All");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const { data: incidentDetail } = useQuery<any>({
    queryKey: ["/api/incidents/detail-drilldown", sourceIncidentId],
    queryFn: () => fetch(`/api/incidents/${sourceIncidentId}`).then((r) => r.json()),
    enabled: !!sourceIncidentId,
    staleTime: 30000,
  });
  const effectiveAppId = String(initialAppId || incidentDetail?.applicationId || "").trim();

  const { data: alerts, isLoading } = useQuery<any[]>({
    queryKey: ["/api/alerts", effectiveAppId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (effectiveAppId) params.set("appId", effectiveAppId);
      const url = params.toString() ? `/api/alerts?${params.toString()}` : "/api/alerts";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch alerts");
      return await res.json();
    },
    refetchOnMount: "always",
    staleTime: 0,
  });
  // Single source of truth for all contexts: app-scoped /api/alerts rows.
  // This keeps incident-opened Alerts identical to app/global alerts behavior.
  const baseAlerts = alerts ?? [];

  const { from: dateCutoffFrom, to: dateCutoffTo } = getDateCutoffs(dateRange, customFrom, customTo);

  const appOptions = [
    { value: "All", label: "All" },
    ...Array.from(
      new Map(
        baseAlerts
          .filter((a) => a?.applicationName || a?.applicationId)
          .map((a) => [String(a.applicationId ?? a.applicationName), { value: String(a.applicationId ?? a.applicationName), label: a.applicationName ?? String(a.applicationId) }]),
      ).values(),
    ),
  ];
  const scopedAlerts = baseAlerts.filter((a) => {
    if (appFilter === "All") return true;
    return String(a.applicationId ?? "") === String(appFilter) || String(a.applicationName ?? "") === String(appFilter);
  });

  const filtered = scopedAlerts.filter(a => {
    const ts: number = a.timestamp;
    if (dateCutoffFrom !== null && ts < dateCutoffFrom) return false;
    if (dateCutoffTo !== null && ts > dateCutoffTo) return false;
    if (sevFilter !== "All" && a.severity !== sevFilter) return false;
    if (statusFilter !== "All" && a.status !== statusFilter) return false;
    if (search !== "" &&
      !a.entity?.toLowerCase().includes(search.toLowerCase()) &&
      !a.service?.toLowerCase().includes(search.toLowerCase()) &&
      !a.rule?.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const counts = {
    Critical: scopedAlerts.filter(a => a.severity === "Critical").length,
    High: scopedAlerts.filter(a => a.severity === "High").length,
    Medium: scopedAlerts.filter(a => a.severity === "Medium").length,
    Low: scopedAlerts.filter(a => a.severity === "Low").length,
    Active: scopedAlerts.filter(a => a.status === "Active").length,
  };

  const appCounts = appOptions
    .filter((o) => o.value !== "All")
    .map((o) => ({ name: o.label, count: (scopedAlerts ?? []).filter((a) => String(a.applicationId ?? a.applicationName) === o.value).length }));

  const trendData = Array.from({ length: 24 }).map((_, i) => {
    const h = 23 - i;
    const bucket = scopedAlerts.filter(a => {
      const age = Date.now() - a.timestamp;
      return age >= h * 3600000 && age < (h + 1) * 3600000;
    }).length;
    return { hour: format(new Date(Date.now() - h * 3600000), 'HH:mm'), count: bucket };
  }).reverse();

  const ruleFrequency = Object.entries(
    scopedAlerts.reduce((acc: any, a) => { acc[a.rule] = (acc[a.rule] || 0) + 1; return acc; }, {})
  ).map(([rule, count]) => ({ rule, count })).sort((a: any, b: any) => b.count - a.count);

  return (
    <AppLayout>
      <div className="space-y-5">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground mb-1 flex items-center gap-2">
              <Bell className="w-6 h-6 text-amber-400" /> Alerts Dashboard
            </h1>
            <p className="text-sm text-muted-foreground">Unified alert intelligence from AppDynamics, Dynatrace, and OpenTelemetry.</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground bg-card px-3 py-2 rounded-lg border border-border">
            <span className="relative flex h-2 w-2 mr-1">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
            </span>
            {counts.Active} active alerts
          </div>
        </div>

        {/* Summary KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
          {[
            { label: "Critical", count: counts.Critical, cls: "border-red-500/20 bg-red-500/5 text-red-400" },
            { label: "High", count: counts.High, cls: "border-orange-500/20 bg-orange-500/5 text-orange-400" },
            { label: "Medium", count: counts.Medium, cls: "border-yellow-500/20 bg-yellow-500/5 text-yellow-400" },
            { label: "Low", count: counts.Low, cls: "border-blue-500/20 bg-blue-500/5 text-blue-400" },
            { label: "Total Alerts", count: scopedAlerts.length, cls: "border-border bg-muted/20 text-foreground" },
          ].map(s => (
            <div key={s.label} className={`rounded-xl border px-3 py-2 cursor-pointer transition-all ${s.cls}`} onClick={() => setSevFilter(s.label === "Total Alerts" ? "All" : s.label)}>
              <p className="text-xs font-medium opacity-70 mb-1">{s.label}</p>
              <p className="text-2xl font-bold">{s.count}</p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-4 gap-5">
          {/* Main alerts table */}
          <div className="xl:col-span-3 space-y-4">

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
            </div>

            {/* Other Filters */}
            <div className="flex flex-wrap gap-2 items-center">
              <div className="relative flex-1 min-w-[200px] max-w-sm">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <Input data-testid="input-search-alerts" placeholder="Search entity, service, rule..." value={search} onChange={e => setSearch(e.target.value)} className="pl-8 h-8 text-xs" />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground font-medium">Application:</span>
                <Select value={appFilter} onValueChange={setAppFilter}>
                  <SelectTrigger data-testid="select-alert-application" className="h-8 text-xs w-[220px]">
                    <SelectValue placeholder="All applications" />
                  </SelectTrigger>
                  <SelectContent>
                    {appOptions.map((app) => (
                      <SelectItem key={app.value} value={app.value}>{app.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex gap-1 flex-wrap">
                {STATUSES.map(s => <button key={s} data-testid={`filter-status-${s}`} onClick={() => setStatusFilter(s)} className={`px-2.5 py-1 rounded text-xs border font-medium transition-colors ${statusFilter === s ? "bg-primary/10 border-primary/30 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}>{s}</button>)}
              </div>
              <div className="flex gap-1 flex-wrap">
                {SEVERITIES.map(s => <button key={s} data-testid={`filter-sev-${s}`} onClick={() => setSevFilter(s)} className={`px-2.5 py-1 rounded text-xs border font-medium transition-colors ${sevFilter === s ? "bg-primary/10 border-primary/30 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}>{s}</button>)}
              </div>
            </div>

            {/* Alert Trend chart */}
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Alert Volume — Last 24h</CardTitle>
              </CardHeader>
              <CardContent className="px-3 pb-3 h-[72px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={trendData} margin={{ top: 0, right: 0, left: -30, bottom: 0 }}>
                    <XAxis dataKey="hour" fontSize={9} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} interval={5} />
                    <YAxis fontSize={9} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} />
                    <Tooltip />
                    <Bar dataKey="count" name="Alerts" fill="#6366f1" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* Alerts Table */}
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-3 border-b border-border">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-semibold">Alerts ({filtered.length})</CardTitle>
                  {selectedAlert && <span className="text-xs text-primary">1 alert selected — errors filtered below</span>}
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {isLoading ? (
                  <div className="p-4 space-y-3">{Array(5).fill(0).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
                ) : (
                  <div className="max-h-[58vh] overflow-auto">
                    <table className="w-full table-fixed text-xs">
                      <thead className="sticky top-0 z-10 bg-muted/90 backdrop-blur text-muted-foreground text-[11px] border-b border-border">
                        <tr>
                          <th className="px-3 py-2 text-left">Alert ID</th>
                          <th className="px-3 py-2 text-left">Application</th>
                          <th className="px-3 py-2 text-left">Severity</th>
                          <th className="px-3 py-2 text-left">Entity / Rule</th>
                          <th className="px-3 py-2 text-right">Occurrences</th>
                          <th className="px-3 py-2 text-left">Time</th>
                          <th className="px-3 py-2 text-left">Status</th>
                          <th className="px-3 py-2 text-right">AI Risk</th>
                          <th className="px-3 py-2"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {filtered.map(a => (
                          <tr
                            key={a.alertId}
                            data-testid={`row-alert-${a.alertId}`}
                            className={`hover:bg-muted/20 cursor-pointer transition-colors ${selectedAlert === a.alertId ? "bg-primary/5 border-l-2 border-primary" : ""}`}
                            onClick={() => setSelectedAlert(prev => prev === a.alertId ? null : a.alertId)}
                          >
                            <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{a.alertId}</td>
                            <td className="px-3 py-2 text-xs text-foreground max-w-[130px] truncate">{a.applicationName ?? "—"}</td>
                            <td className="px-3 py-2"><Chip label={a.severity} cls={SEV_CLASSES[a.severity] ?? ""} /></td>
                            <td className="px-3 py-2">
                              <p className="font-medium text-foreground text-xs">{a.entity}</p>
                              <p className="text-[10px] text-muted-foreground truncate max-w-[200px]">{a.rule}</p>
                            </td>
                            <td className="px-3 py-2 text-right">
                              <span className={`text-xs font-bold font-mono ${(a.occurrences ?? 1) > 3 ? "text-orange-400" : "text-foreground"}`}>{(a.occurrences ?? 1).toLocaleString()}×</span>
                            </td>
                            <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                              {a.timestamp ? formatDistanceToNow(new Date(a.timestamp), { addSuffix: true }) : "—"}
                            </td>
                            <td className="px-3 py-2"><Chip label={a.status} cls={STATUS_CLASSES[a.status] ?? ""} /></td>
                            <td className="px-3 py-2 text-right"><RiskGauge score={a.aiRiskScore} /></td>
                            <td className="px-3 py-2 text-right">
                              <Link href={`/alerts/${a.alertId}`} onClick={e => e.stopPropagation()}>
                                <span className="text-xs text-primary hover:underline flex items-center gap-0.5 justify-end">Detail <ChevronRight className="w-3 h-3" /></span>
                              </Link>
                            </td>
                          </tr>
                        ))}
                        {filtered.length === 0 && (
                          <tr><td colSpan={9} className="px-4 py-10 text-center text-muted-foreground text-sm">No alerts match your filters.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Cross-filter: correlated errors for selected alert */}
            {selectedAlert && <CorrelatedErrorsPanel alertId={selectedAlert} />}
          </div>

          {/* RIGHT SIDEBAR */}
          <div className="space-y-4">
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Alerts by Application</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4" style={{ height: Math.max(130, appCounts.length * 28 + 20) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={appCounts} layout="vertical" margin={{ top: 0, right: 10, left: 10, bottom: 0 }}>
                    <XAxis type="number" fontSize={9} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} />
                    <YAxis type="category" dataKey="name" fontSize={9} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} width={120} />
                    <Tooltip />
                    <Bar dataKey="count" name="Alerts" radius={[0, 3, 3, 0]}>
                      {appCounts.map((_, i) => <Cell key={i} fill={APP_COLORS[i % APP_COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Most Triggered Rules</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-2">
                {ruleFrequency.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No data available.</p>
                ) : ruleFrequency.map((r: any) => (
                  <div key={r.rule} className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-foreground truncate">{r.rule}</p>
                    </div>
                    <span className="text-xs font-bold text-foreground shrink-0">{r.count}×</span>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card className="border border-indigo-500/20 bg-indigo-500/5 shadow-sm">
              <CardContent className="px-4 py-6 text-center">
                <BrainCircuit className="w-6 h-6 text-indigo-400 mx-auto mb-2" />
                <p className="text-xs font-semibold text-indigo-300 mb-1">AI Analysis Available</p>
                <p className="text-[11px] text-muted-foreground">Connect an APM controller and sync data to see AI-generated forecast risks and recommended actions.</p>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function CorrelatedErrorsPanel({ alertId }: { alertId: string }) {
  const { data: errors, isLoading } = useQuery<any[]>({
    queryKey: [`/api/alerts/errors/correlated`, alertId],
    queryFn: () => fetch(`/api/alerts/errors/correlated?alertId=${alertId}`).then(r => r.json()),
  });

  return (
    <Card className="border border-primary/20 bg-primary/5 shadow-sm">
      <CardHeader className="pb-3 border-b border-border">
        <CardTitle className="text-xs font-semibold flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400" /> Correlated Errors for {alertId}
          <Badge className="bg-primary/10 text-primary border border-primary/20 text-xs">{errors?.length ?? 0} errors</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? <Skeleton className="h-20 m-4" /> : !errors?.length ? (
          <p className="text-xs text-muted-foreground p-4">No correlated errors for this alert.</p>
        ) : (
          <div className="divide-y divide-border">
            {errors.map(e => (
              <div key={e.errorId} className="px-3 py-2 flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-xs font-mono font-medium text-foreground">{e.type}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5 font-mono">{e.message.slice(0, 80)}…</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{e.service} · {e.server}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs font-bold text-red-400">{e.count.toLocaleString()} occurrences</p>
                  <p className="text-[10px] text-muted-foreground">{e.timestamp ? formatDistanceToNow(new Date(e.timestamp), { addSuffix: true }) : "—"}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

