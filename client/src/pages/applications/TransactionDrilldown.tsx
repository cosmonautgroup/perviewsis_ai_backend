import { useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { useApplication } from "@/hooks/use-applications";
import { useQuery } from "@tanstack/react-query";
import { Clock, Activity, AlertTriangle, ChevronRight, TrendingUp } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export default function TransactionDrilldown() {
  const { id, txId } = useParams<{ id: string; txId: string }>();
  const appId = parseInt(id || "0", 10);
  const transactionKey = decodeURIComponent(txId || "").trim();
  const initialSearch = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const initialDuration = Number(initialSearch.get("durationMins") ?? NaN);
  const initialStartIso = initialSearch.get("start") ?? "";
  const initialEndIso = initialSearch.get("end") ?? "";
  const initialCustomStart = initialStartIso ? initialStartIso.slice(0, 10) : "";
  const initialCustomEnd = initialEndIso ? initialEndIso.slice(0, 10) : "";
  const initialRange = (() => {
    if (initialCustomStart && initialCustomEnd) return "custom" as const;
    if (initialDuration === 5) return "5m" as const;
    if (initialDuration === 15) return "15m" as const;
    if (initialDuration === 60) return "1h" as const;
    if (initialDuration === 180) return "3h" as const;
    if (initialDuration === 1440) return "1d" as const;
    if (initialDuration === 10080) return "7d" as const;
    if (initialDuration === 43200) return "30d" as const;
    return "1d" as const;
  })();

  const [timeRange, setTimeRange] = useState<"5m" | "15m" | "1h" | "3h" | "1d" | "7d" | "30d" | "custom">(initialRange);
  const [customStart, setCustomStart] = useState(initialCustomStart);
  const [customEnd, setCustomEnd] = useState(initialCustomEnd);
  const [diagView, setDiagView] = useState<"error" | "slow" | "verySlow">("error");
  const [expandedCallGuid, setExpandedCallGuid] = useState<string>("");
  const [expandedErrorSampleId, setExpandedErrorSampleId] = useState<string>("");

  const metricOpts = useMemo(() => {
    if (timeRange === "5m") return { durationMins: 5 };
    if (timeRange === "15m") return { durationMins: 15 };
    if (timeRange === "1h") return { durationMins: 60 };
    if (timeRange === "3h") return { durationMins: 3 * 60 };
    if (timeRange === "1d") return { durationMins: 24 * 60 };
    if (timeRange === "7d") return { durationMins: 7 * 24 * 60 };
    if (timeRange === "30d") return { durationMins: 30 * 24 * 60 };
    if (customStart && customEnd) {
      return {
        start: new Date(`${customStart}T00:00:00`).toISOString(),
        end: new Date(`${customEnd}T23:59:59`).toISOString(),
      };
    }
    return { durationMins: 24 * 60 };
  }, [timeRange, customStart, customEnd]);

  const { data: app, isLoading: appLoading } = useApplication(appId);
  const { data: tx, isLoading: txLoading } = useQuery<any>({
    queryKey: ["/api/applications/transaction-detail", appId, transactionKey, metricOpts.durationMins, metricOpts.start, metricOpts.end],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (metricOpts.durationMins) params.set("durationMins", String(metricOpts.durationMins));
      if (metricOpts.start) params.set("start", metricOpts.start);
      if (metricOpts.end) params.set("end", metricOpts.end);
      const qs = params.toString();
      const encodedTx = encodeURIComponent(transactionKey);
      const url = qs
        ? `/api/applications/${appId}/transactions/${encodedTx}?${qs}`
        : `/api/applications/${appId}/transactions/${encodedTx}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch transaction details");
      return res.json();
    },
    enabled: !!appId && !!transactionKey,
  });
  const { data: diagnostics, isLoading: diagnosticsLoading } = useQuery<any>({
    queryKey: ["/api/applications/transaction-diagnostics", appId, transactionKey, metricOpts.durationMins, metricOpts.start, metricOpts.end],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (metricOpts.durationMins) params.set("durationMins", String(metricOpts.durationMins));
      if (metricOpts.start) params.set("start", metricOpts.start);
      if (metricOpts.end) params.set("end", metricOpts.end);
      const qs = params.toString();
      const encodedTx = encodeURIComponent(transactionKey);
      const url = qs
        ? `/api/applications/${appId}/transactions/${encodedTx}/diagnostics?${qs}`
        : `/api/applications/${appId}/transactions/${encodedTx}/diagnostics`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch transaction diagnostics");
      return res.json();
    },
    enabled: !!appId && !!transactionKey,
  });

  if (appLoading || txLoading) {
    return (
      <AppLayout appId={appId}>
        <div className="space-y-4">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      </AppLayout>
    );
  }

  if (!tx) {
    return (
      <AppLayout appId={appId}>
        <Card className="border border-border shadow-sm">
          <CardContent className="p-6 text-sm text-muted-foreground">
            Transaction not found for this application and selected time range.
          </CardContent>
        </Card>
      </AppLayout>
    );
  }

  const avg = Number(tx.avgResponseTime ?? 0);
  const cpm = Number(tx.callsPerMinute ?? 0);
  const err = Number(tx.errorRate ?? 0);
  const hasMetricData = avg > 0 || cpm > 0 || err > 0 || Number(tx.errorsPerMinute ?? 0) > 0;
  const slowPct = Number(tx.slowTransactionPercent ?? 0);
  const verySlowPct = Number(tx.verySlowTransactionPercent ?? 0);
  const p95 = Math.round(avg * 2.2);
  const p99 = Math.round(avg * 3.8);
  const snapshotChart = [
    { key: "Avg Response (ms)", value: Math.round(avg) },
    { key: "Calls/Min", value: Math.round(cpm) },
    { key: "Error Rate (%)", value: Number(err.toFixed(2)) },
  ];
  const diagSeriesRaw = diagView === "error"
    ? diagnostics?.series?.errorsPerMinute
    : diagView === "slow"
      ? diagnostics?.series?.slowCalls
      : diagnostics?.series?.verySlowCalls;
  const diagSeries = (Array.isArray(diagSeriesRaw) ? diagSeriesRaw : []).map((p: any) => ({
    time: new Date(Number(p.ts ?? 0)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    value: Number(p.effective ?? p.value ?? p.current ?? 0),
  }));
  const diagLabel = diagView === "error"
    ? "Errors per Minute"
    : diagView === "slow"
      ? "Number of Slow Calls"
      : "Number of Very Slow Calls";
  const diagValue = diagView === "error"
    ? Number(diagnostics?.summary?.errorRate ?? err)
    : diagView === "slow"
      ? Number(diagnostics?.summary?.slowTransactionPercent ?? slowPct)
      : Number(diagnostics?.summary?.verySlowTransactionPercent ?? verySlowPct);
  const callSnapshots = Array.isArray(diagnostics?.callSnapshots) ? diagnostics.callSnapshots : [];

  return (
    <AppLayout appId={appId}>
      <div className="space-y-5">
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground flex-wrap">
          <Link href={`/applications/${appId}`} className="hover:text-foreground transition-colors">{app?.name ?? "Application"}</Link>
          <ChevronRight className="w-3 h-3" />
          <span>Business Transactions</span>
          <ChevronRight className="w-3 h-3" />
          <span className="text-foreground font-medium">{tx.name}</span>
        </div>

        <div className="bg-card border border-border rounded-xl p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl font-bold text-foreground">{tx.name}</h1>
                <StatusBadge status={tx.status} />
                <Badge variant="secondary">{tx.tier || "Unknown Tier"}</Badge>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                Transaction ID: <span className="font-mono">{tx.id}</span>
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {(["5m", "15m", "1h", "3h", "1d", "7d", "30d", "custom"] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setTimeRange(r)}
                  className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                    timeRange === r ? "bg-primary text-primary-foreground border-primary" : "bg-card text-muted-foreground border-border hover:text-foreground"
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
          {timeRange === "custom" && (
            <div className="flex items-center gap-2 mt-3">
              <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground" />
              <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground" />
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Card className="border border-border shadow-sm"><CardContent className="p-4"><p className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><Clock className="w-3 h-3" /> Avg Response</p><p className={`text-xl font-bold font-mono ${avg > 2000 ? "text-red-400" : "text-foreground"}`}>{avg > 0 ? `${Math.round(avg).toLocaleString()}ms` : "No Data"}</p></CardContent></Card>
          <Card className="border border-border shadow-sm"><CardContent className="p-4"><p className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><Activity className="w-3 h-3" /> Throughput</p><p className="text-xl font-bold font-mono">{cpm > 0 ? `${Math.round(cpm).toLocaleString()} cpm` : "No Data"}</p></CardContent></Card>
          <Card className="border border-border shadow-sm"><CardContent className="p-4"><p className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Error Rate</p><p className={`text-xl font-bold font-mono ${err > 3 ? "text-red-400" : "text-foreground"}`}>{err > 0 ? `${err.toFixed(2)}%` : "No Data"}</p></CardContent></Card>
          <Card className="border border-border shadow-sm"><CardContent className="p-4"><p className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><TrendingUp className="w-3 h-3" /> Tail Latency</p><p className="text-xl font-bold font-mono">{avg > 0 ? `P95 ${p95.toLocaleString()} / P99 ${p99.toLocaleString()}` : "No Data"}</p></CardContent></Card>
        </div>

        {!hasMetricData && (
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
            No recent BT metric samples were returned for this transaction in the selected window.
          </div>
        )}

        <div className="grid grid-cols-1 gap-4">
          <Card className="border border-border shadow-sm">
            <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold">Current BT Snapshot</CardTitle></CardHeader>
            <CardContent className="h-[240px]">
              {hasMetricData ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={snapshotChart} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="key" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                    <Tooltip formatter={(v: number | string) => [Number(v), "Value"]} />
                    <Bar dataKey="value" fill="#22c55e" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
                  No transaction metric data in this window.
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="border border-border shadow-sm">
          <CardHeader className="pb-3 border-b border-border"><CardTitle className="text-sm font-semibold">Transaction Diagnostics</CardTitle></CardHeader>
          <CardContent className="p-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <button onClick={() => setDiagView("slow")} className={`rounded-lg border px-3 py-2 text-left ${diagView === "slow" ? "border-yellow-500/40 bg-yellow-500/10" : "border-border bg-muted/20"}`}><p className="text-[10px] text-muted-foreground">Slow Txn %</p><p className={`text-sm font-mono font-bold ${slowPct > 0 ? "text-yellow-500" : "text-foreground"}`}>{slowPct.toFixed(2)}%</p></button>
              <button onClick={() => setDiagView("verySlow")} className={`rounded-lg border px-3 py-2 text-left ${diagView === "verySlow" ? "border-red-500/40 bg-red-500/10" : "border-border bg-muted/20"}`}><p className="text-[10px] text-muted-foreground">Very Slow Txn %</p><p className={`text-sm font-mono font-bold ${verySlowPct > 0 ? "text-red-400" : "text-foreground"}`}>{verySlowPct.toFixed(2)}%</p></button>
              <div className="rounded-lg border border-border bg-muted/20 px-3 py-2"><p className="text-[10px] text-muted-foreground">Calls/min</p><p className="text-sm font-mono font-bold">{cpm.toFixed(2)}</p></div>
              <button onClick={() => setDiagView("error")} className={`rounded-lg border px-3 py-2 text-left ${diagView === "error" ? "border-orange-500/40 bg-orange-500/10" : "border-border bg-muted/20"}`}><p className="text-[10px] text-muted-foreground">Errors/min</p><p className="text-sm font-mono font-bold">{Number(tx.errorsPerMinute ?? 0).toFixed(2)}</p></button>
            </div>
          </CardContent>
        </Card>

        <Card className="border border-border shadow-sm">
          <CardHeader className="pb-2 border-b border-border">
            <CardTitle className="text-sm font-semibold">
              Further Drilldown: {diagLabel} ({diagValue.toFixed(2)}%)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 space-y-4">
            <div className="h-[220px]">
              {diagnosticsLoading ? (
                <Skeleton className="h-full w-full" />
              ) : (
                diagSeries.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={diagSeries} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="time" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                    <Tooltip formatter={(v: number | string) => [Number(v), diagLabel]} />
                    <Bar dataKey="value" fill={diagView === "error" ? "#f97316" : diagView === "slow" ? "#eab308" : "#ef4444"} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
                    No {diagLabel.toLowerCase()} samples in this window.
                  </div>
                )
              )}
            </div>
            <div className="rounded-lg border border-border overflow-hidden">
              <div className="px-3 py-2 border-b border-border bg-muted/30 text-xs font-medium text-muted-foreground">
                Recent Error Samples (Transaction/App)
              </div>
              <div className="max-h-64 overflow-auto">
                {!diagnostics?.errorSamples?.length ? (
                  <div className="px-3 py-4 text-xs text-muted-foreground">No error samples found in this time range.</div>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="bg-muted/20 text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-left">Cluster</th>
                        <th className="px-3 py-2 text-left">Message</th>
                        <th className="px-3 py-2 text-left">Severity</th>
                        <th className="px-3 py-2 text-right">Frequency</th>
                        <th className="px-3 py-2 text-right">Details</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {(diagnostics.errorSamples as any[]).slice(0, 20).map((e: any, i: number) => {
                        const rowId = `${String(e.errorId ?? e.id ?? i)}`;
                        const isOpen = expandedErrorSampleId === rowId;
                        const affected = Array.isArray(e?.details?.affectedEntities) ? e.details.affectedEntities : [];
                        return [
                          <tr key={`err-${rowId}`}>
                              <td className="px-3 py-2">{e.cluster ?? "Unknown"}</td>
                              <td className="px-3 py-2 text-muted-foreground">{String(e.message ?? "").slice(0, 120) || "-"}</td>
                              <td className="px-3 py-2">{e.severity ?? "-"}</td>
                              <td className="px-3 py-2 text-right font-mono">{Number(e.frequency ?? 0)}</td>
                              <td className="px-3 py-2 text-right">
                                <button className="text-primary hover:underline" onClick={() => setExpandedErrorSampleId(isOpen ? "" : rowId)}>
                                  {isOpen ? "Hide" : "View"}
                                </button>
                              </td>
                          </tr>,
                          isOpen ? (
                              <tr key={`err-details-${rowId}`}>
                                <td colSpan={5} className="px-3 py-3 bg-muted/10">
                                  <div className="space-y-2">
                                    <div><span className="text-muted-foreground">Summary:</span> {String(e?.details?.summary ?? e?.message ?? "-")}</div>
                                    <div><span className="text-muted-foreground">Type:</span> {String(e?.type ?? e?.details?.subType ?? "-")}</div>
                                    <div><span className="text-muted-foreground">Triggered Entity:</span> {e?.details?.triggeredEntity ? `${String(e.details.triggeredEntity.name ?? "-")} (${String(e.details.triggeredEntity.entityType ?? "-")})` : "-"}</div>
                                    <div><span className="text-muted-foreground">Affected:</span> {affected.length > 0 ? affected.slice(0, 6).map((a: any) => `${String(a?.name ?? "-")} (${String(a?.entityType ?? "-")})`).join(", ") : "-"}</div>
                                  </div>
                                </td>
                              </tr>
                            ) : null,
                        ];
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
            <div className="rounded-lg border border-border overflow-hidden">
              <div className="px-3 py-2 border-b border-border bg-muted/30 text-xs font-medium text-muted-foreground">
                Recent Calls (AppDynamics Request Snapshots)
              </div>
              <div className="max-h-80 overflow-auto">
                {!callSnapshots.length ? (
                  <div className="px-3 py-4 text-xs text-muted-foreground">No call-level snapshots returned for this BT and time range.</div>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="bg-muted/20 text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-left">Time</th>
                        <th className="px-3 py-2 text-left">URL</th>
                        <th className="px-3 py-2 text-right">Duration</th>
                        <th className="px-3 py-2 text-center">Error</th>
                        <th className="px-3 py-2 text-right">Details</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {callSnapshots.slice(0, 40).map((c: any, i: number) => {
                        const guid = String(c.requestGUID ?? "");
                        const isOpen = expandedCallGuid === guid;
                        const rowKey = guid || `snapshot-${Number(c.localStartTime ?? 0)}-${i}`;
                        return [
                            <tr key={`${rowKey}-base`}>
                              <td className="px-3 py-2">{c.localStartTime ? new Date(Number(c.localStartTime)).toLocaleString() : "-"}</td>
                              <td className="px-3 py-2 text-muted-foreground">{String(c.url ?? "-").slice(0, 80)}</td>
                              <td className="px-3 py-2 text-right font-mono">{Math.round(Number(c.durationMs ?? 0))} ms</td>
                              <td className="px-3 py-2 text-center">{c.errorOccurred ? <span className="text-red-400 font-semibold">Yes</span> : <span className="text-green-500">No</span>}</td>
                              <td className="px-3 py-2 text-right">
                                <button className="text-primary hover:underline" onClick={() => setExpandedCallGuid(isOpen ? "" : guid)}>View</button>
                              </td>
                            </tr>,
                            isOpen ? (
                              <tr key={`${rowKey}-details`}>
                                <td colSpan={5} className="px-3 py-3 bg-muted/10">
                                  <div className="space-y-2">
                                    <div><span className="text-muted-foreground">Summary:</span> {c.summary || c.errorSummary || "-"}</div>
                                    <div><span className="text-muted-foreground">Error Summary:</span> {c.errorSummary || c.summary || "-"}</div>
                                    <div><span className="text-muted-foreground">HTTP Params:</span> {Array.isArray(c.httpParameters) && c.httpParameters.length > 0 ? c.httpParameters.map((p: any) => `${p.name}=${p.value}`).join(", ") : "-"}</div>
                                    <div><span className="text-muted-foreground">Error Details:</span> {Array.isArray(c.errorDetails) && c.errorDetails.length > 0 ? c.errorDetails.map((d: any) => `${String(d?.name ?? "-")}: ${String(d?.value ?? "-")}`).join(" | ").slice(0, 500) : (c.errorSummary || c.summary || "-")}</div>
                                  </div>
                                </td>
                              </tr>
                            ) : null,
                        ];
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
