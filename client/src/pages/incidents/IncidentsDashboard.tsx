import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ShieldAlert, Search, ChevronRight, Clock, CheckCircle2,
  AlertTriangle, BrainCircuit, Activity, CalendarDays
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";

const SEV_CLASSES: Record<string, string> = {
  Critical: "bg-red-500/10 text-red-400 border-red-500/20",
  Warning:  "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  High:     "bg-orange-500/10 text-orange-400 border-orange-500/20",
  Low:      "bg-blue-500/10 text-blue-400 border-blue-500/20",
};

const STATUS_CLASSES: Record<string, string> = {
  Open:         "bg-red-500/10 text-red-400 border-red-500/20",
  Active:       "bg-red-500/10 text-red-400 border-red-500/20",
  Acknowledged: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  Resolved:     "bg-green-500/10 text-green-400 border-green-500/20",
};

const STATUS_ICONS: Record<string, JSX.Element> = {
  Open:         <AlertTriangle className="w-3 h-3" />,
  Active:       <AlertTriangle className="w-3 h-3" />,
  Acknowledged: <Clock className="w-3 h-3" />,
  Resolved:     <CheckCircle2 className="w-3 h-3" />,
};

function Chip({ label, cls }: { label: string; cls: string }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded border ${cls}`}>
      {STATUS_ICONS[label] ?? null} {label}
    </span>
  );
}

const SEVERITIES = ["All", "Critical", "Warning", "High", "Low"];
const STATUSES   = ["All", "Open", "Acknowledged", "Resolved"];
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

export default function IncidentsDashboard() {
  const [search, setSearch]             = useState("");
  const [sevFilter, setSevFilter]       = useState("All");
  const [statusFilter, setStatusFilter] = useState("All");
  const [dateRange, setDateRange]       = useState<DatePreset>("All");
  const [customFrom, setCustomFrom]     = useState("");
  const [customTo, setCustomTo]         = useState("");

  const { data: incidents, isLoading } = useQuery<any[]>({ queryKey: ["/api/incidents"] });

  const { from: dateCutoffFrom, to: dateCutoffTo } = getDateCutoffs(dateRange, customFrom, customTo);

  const filtered = (incidents ?? []).filter(inc => {
    const ts: number = inc.startTime;
    if (dateCutoffFrom !== null && ts < dateCutoffFrom) return false;
    if (dateCutoffTo !== null && ts > dateCutoffTo) return false;
    if (sevFilter !== "All" && inc.severity !== sevFilter) return false;
    if (statusFilter !== "All" && inc.status !== statusFilter) return false;
    if (search !== "" &&
      !inc.title?.toLowerCase().includes(search.toLowerCase()) &&
      !(inc.applicationName ?? "").toLowerCase().includes(search.toLowerCase()) &&
      !(inc.rootCause ?? "").toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const counts = {
    total:    incidents?.length ?? 0,
    critical: incidents?.filter(i => i.severity === "Critical").length ?? 0,
    open:     incidents?.filter(i => i.status === "Open" || i.status === "Active").length ?? 0,
    resolved: incidents?.filter(i => i.status === "Resolved").length ?? 0,
  };

  return (
    <AppLayout>
      <div className="space-y-5">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground mb-1 flex items-center gap-2">
              <ShieldAlert className="w-6 h-6 text-red-400" /> Incident Intelligence
            </h1>
            <p className="text-sm text-muted-foreground">
              All incidents across your APM-connected applications, enriched with AI root-cause analysis.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground bg-card px-3 py-2 rounded-lg border border-border">
            <span className="relative flex h-2 w-2 mr-1">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
            </span>
            {counts.open} open incidents
          </div>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { label: "Total Incidents", value: counts.total,    icon: <ShieldAlert className="w-4 h-4" />, color: "text-foreground" },
            { label: "Critical",        value: counts.critical,  icon: <AlertTriangle className="w-4 h-4" />, color: "text-red-400" },
            { label: "Open",            value: counts.open,      icon: <Activity className="w-4 h-4" />, color: "text-amber-400" },
            { label: "Resolved",        value: counts.resolved,  icon: <CheckCircle2 className="w-4 h-4" />, color: "text-green-400" },
          ].map(kpi => (
            <Card key={kpi.label} className="border border-border bg-card">
              <CardContent className="p-4">
                <div className={`flex items-center gap-1.5 text-xs text-muted-foreground mb-1 ${kpi.color}`}>
                  {kpi.icon} {kpi.label}
                </div>
                <div className={`text-2xl font-bold ${kpi.color}`} data-testid={`kpi-${kpi.label.toLowerCase().replace(/\s+/g, '-')}`}>
                  {isLoading ? <Skeleton className="h-7 w-10" /> : kpi.value}
                </div>
              </CardContent>
            </Card>
          ))}
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
        </div>

        {/* Keyword + Severity + Status Filters */}
        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              placeholder="Search incidents, applications, root cause…"
              className="pl-9 h-8 text-sm"
              value={search}
              onChange={e => setSearch(e.target.value)}
              data-testid="input-search-incidents"
            />
          </div>
          <div className="flex gap-1 flex-wrap">
            {SEVERITIES.map(s => (
              <button
                key={s}
                onClick={() => setSevFilter(s)}
                data-testid={`filter-severity-${s.toLowerCase()}`}
                className={`text-[11px] px-2.5 py-1 rounded-md border transition-colors ${
                  sevFilter === s
                    ? "bg-indigo-500/20 text-indigo-300 border-indigo-500/40"
                    : "bg-card text-muted-foreground border-border hover:border-indigo-500/30"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="flex gap-1 flex-wrap">
            {STATUSES.map(s => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                data-testid={`filter-status-${s.toLowerCase()}`}
                className={`text-[11px] px-2.5 py-1 rounded-md border transition-colors ${
                  statusFilter === s
                    ? "bg-indigo-500/20 text-indigo-300 border-indigo-500/40"
                    : "bg-card text-muted-foreground border-border hover:border-indigo-500/30"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Incidents Table */}
        <Card className="border border-border shadow-sm">
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-6 space-y-3">
                {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-16 w-full" />)}
              </div>
            ) : filtered.length === 0 ? (
              <div className="p-12 text-center text-muted-foreground">
                <ShieldAlert className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p className="font-medium">No incidents found</p>
                <p className="text-sm mt-1">Try adjusting your filters or connect an APM controller.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-muted/40 text-muted-foreground text-xs border-b border-border">
                    <tr>
                      <th className="px-5 py-3 font-medium">Incident</th>
                      <th className="px-5 py-3 font-medium">Application</th>
                      <th className="px-5 py-3 font-medium">Severity</th>
                      <th className="px-5 py-3 font-medium">Status</th>
                      <th className="px-5 py-3 font-medium">Started</th>
                      <th className="px-5 py-3 font-medium">Duration / MTTR</th>
                      <th className="px-5 py-3 font-medium">Affected Services</th>
                      <th className="px-5 py-3 font-medium text-right">Impact</th>
                      <th className="px-5 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filtered.map(inc => {
                      const durMs = (inc.endTime ?? Date.now()) - inc.startTime;
                      const durMins = Math.floor(durMs / 60000);
                      const durStr = inc.mttr
                        ? `${Math.floor(inc.mttr / 60)}m MTTR`
                        : durMins > 60
                        ? `${Math.floor(durMins / 60)}h ${durMins % 60}m`
                        : `${durMins}m`;

                      return (
                        <tr
                          key={inc.incidentId}
                          data-testid={`row-incident-${inc.incidentId}`}
                          className="hover:bg-muted/20 transition-colors group"
                        >
                          <td className="px-5 py-4">
                            <div className="font-medium text-foreground leading-snug max-w-xs">{inc.title}</div>
                            <div className="text-[11px] text-muted-foreground mt-0.5 font-mono">{inc.incidentId}</div>
                          </td>
                          <td className="px-5 py-4">
                            {inc.applicationId ? (
                              <Link
                                href={`/applications/${inc.applicationId}`}
                                className="text-indigo-400 hover:text-indigo-300 text-xs font-medium"
                                data-testid={`link-app-${inc.applicationId}`}
                              >
                                {inc.applicationName}
                              </Link>
                            ) : (
                              <span className="text-muted-foreground text-xs">{inc.applicationName}</span>
                            )}
                          </td>
                          <td className="px-5 py-4">
                            <Chip label={inc.severity} cls={SEV_CLASSES[inc.severity] ?? SEV_CLASSES.Low} />
                          </td>
                          <td className="px-5 py-4">
                            <Chip label={inc.status} cls={STATUS_CLASSES[inc.status] ?? STATUS_CLASSES.Open} />
                          </td>
                          <td className="px-5 py-4 text-muted-foreground text-xs">
                            {inc.startTime ? (
                              <>
                                <div>{format(new Date(inc.startTime), "MMM d, HH:mm")}</div>
                                <div className="text-[10px]">{formatDistanceToNow(new Date(inc.startTime), { addSuffix: true })}</div>
                              </>
                            ) : "—"}
                          </td>
                          <td className="px-5 py-4 text-muted-foreground text-xs font-mono">{durStr}</td>
                          <td className="px-5 py-4">
                            <div className="flex gap-1 flex-wrap max-w-[160px]">
                              {((inc.affectedServices ?? []) as string[]).slice(0, 2).map((s: string) => (
                                <span key={s} className="text-[10px] px-1.5 py-0.5 bg-muted/50 border border-border rounded text-muted-foreground">
                                  {s}
                                </span>
                              ))}
                              {((inc.affectedServices ?? []) as string[]).length > 2 && (
                                <span className="text-[10px] text-muted-foreground">
                                  +{(inc.affectedServices as string[]).length - 2}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-5 py-4 text-right">
                            <span className={`text-sm font-bold font-mono ${
                              inc.impactScore > 75 ? "text-red-400" :
                              inc.impactScore > 45 ? "text-yellow-400" : "text-green-400"
                            }`} data-testid={`score-impact-${inc.incidentId}`}>
                              {inc.impactScore}
                            </span>
                          </td>
                          <td className="px-5 py-4">
                            <Link
                              href={`/incidents/${inc.incidentId}`}
                              className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 text-indigo-400 hover:text-indigo-300 text-xs"
                              data-testid={`link-incident-${inc.incidentId}`}
                            >
                              Investigate <ChevronRight className="w-3 h-3" />
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* AI Summary footer */}
        {!isLoading && incidents && incidents.length > 0 && (
          <Card className="border border-indigo-500/20 bg-card">
            <CardContent className="p-4 flex items-start gap-3">
              <BrainCircuit className="w-5 h-5 text-indigo-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-semibold text-foreground mb-1">AI Incident Summary</p>
                <p className="text-sm text-muted-foreground">
                  {counts.critical} critical incident{counts.critical !== 1 ? "s" : ""} detected across {new Set(incidents.map(i => i.applicationName)).size} applications.{" "}
                  {counts.open > 0
                    ? `${counts.open} incident${counts.open !== 1 ? "s" : ""} remain open and require immediate attention.`
                    : "All incidents have been resolved."}{" "}
                  AI root-cause analysis is available for each incident — click Investigate to view detailed causal chains, metrics, and remediation recommendations.
                </p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </AppLayout>
  );
}
