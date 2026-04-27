import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, TrendingDown, ChevronRight, Activity, Clock, AlertTriangle, Flame } from "lucide-react";
import { Link } from "wouter";
import { LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { format } from "date-fns";

function SreStat({ label, value, unit, trend, isPositiveGood = true }: any) {
  const isUp = trend > 0;
  const isGood = isPositiveGood ? isUp : !isUp;
  return (
    <Card className="border border-border shadow-sm">
      <CardContent className="p-5">
        <p className="text-xs text-muted-foreground font-medium mb-3">{label}</p>
        <p className="text-2xl font-bold text-foreground">{value}{unit}</p>
        <div className={`flex items-center gap-1 text-xs mt-2 ${isGood ? "text-green-500" : "text-red-400"}`}>
          {isUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
          {Math.abs(trend)}% vs last period
        </div>
      </CardContent>
    </Card>
  );
}

function RiskScore({ score }: { score: number }) {
  const color = score > 75 ? "text-red-400 bg-red-500/10 border-red-500/20" : score > 50 ? "text-yellow-400 bg-yellow-500/10 border-yellow-500/20" : "text-green-400 bg-green-500/10 border-green-500/20";
  return <span className={`inline-flex items-center px-2 py-0.5 rounded border text-xs font-bold ${color}`}>{score}</span>;
}

export default function SreView() {
  const { data, isLoading } = useQuery<any>({ queryKey: ["/api/persona/sre"] });

  return (
    <AppLayout>
      <div className="space-y-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-2xl font-bold text-foreground">SRE / Service Owner View</h1>
            <Badge className="bg-green-500/10 text-green-400 border border-green-500/20">Operational</Badge>
          </div>
          <p className="text-muted-foreground text-sm">Service reliability, error budgets, and latency drilldown by tier.</p>
        </div>

        {/* Stats */}
        {isLoading ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-32" />)}</div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <SreStat label="Uptime" value={data?.summary?.uptime} unit="%" trend={data?.summary?.uptimeTrend} isPositiveGood />
            <SreStat label="p99 Latency" value={data?.summary?.p99Latency?.toLocaleString()} unit="ms" trend={data?.summary?.latencyTrend} isPositiveGood={false} />
            <SreStat label="Error Rate" value={data?.summary?.errorRate} unit="%" trend={data?.summary?.errorTrend} isPositiveGood={false} />
            <SreStat label="Error Budget Burn" value={data?.summary?.errorBudgetBurn} unit="%" trend={data?.summary?.budgetTrend} isPositiveGood={false} />
          </div>
        )}

        {/* Error budget burn indicator */}
        {!isLoading && data?.summary?.errorBudgetBurn > 60 && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 flex items-center gap-3">
            <Flame className="w-5 h-5 text-red-400 shrink-0" />
            <div>
              <p className="font-semibold text-red-400">Error Budget Burn Rate Critical</p>
              <p className="text-sm text-red-300/80">{data?.summary?.errorBudgetBurn}% of monthly error budget consumed. At current rate, budget exhausted in ~{Math.round((100 - data?.summary?.errorBudgetBurn) / data?.summary?.budgetTrend)} days.</p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Latency History */}
          <Card className="border border-border shadow-sm">
            <CardHeader><CardTitle className="text-base font-semibold">p99 Latency Trend (24h)</CardTitle></CardHeader>
            <CardContent className="h-[240px]">
              {isLoading ? <Skeleton className="h-full" /> : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data?.latencyHistory} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                    <defs>
                      <linearGradient id="latGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="timestamp" tickFormatter={v => format(new Date(v), 'HH:mm')} stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} tickFormatter={v => `${v}ms`} />
                    <Tooltip formatter={(v: any) => `${v.toFixed(0)}ms`} />
                    <Area type="monotone" dataKey="value" name="p99 Latency" stroke="#6366f1" strokeWidth={2} fill="url(#latGrad)" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Error rate */}
          <Card className="border border-border shadow-sm">
            <CardHeader><CardTitle className="text-base font-semibold">Error Rate (24h)</CardTitle></CardHeader>
            <CardContent className="h-[240px]">
              {isLoading ? <Skeleton className="h-full" /> : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={data?.errorHistory} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="timestamp" tickFormatter={v => format(new Date(v), 'HH:mm')} stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} tickFormatter={v => `${v.toFixed(1)}%`} />
                    <Tooltip formatter={(v: any) => `${v.toFixed(2)}%`} />
                    <Line type="monotone" dataKey="value" name="Error Rate" stroke="#ef4444" strokeWidth={2} dot={false} activeDot={{ r: 5 }} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Top Degrading Services */}
        <Card className="border border-border shadow-sm">
          <CardHeader><CardTitle className="text-base font-semibold flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-amber-400" /> Top Degrading Services</CardTitle></CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-24" /> : (
              <div className="space-y-3">
                {data?.topDegradingServices?.map((svc: any) => (
                  <div key={svc.name} className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-muted/20 px-4 py-3">
                    <div className="flex-1">
                      {svc?.appId ? (
                        <Link href={`/applications/${svc.appId}`} className="font-medium text-primary hover:underline">
                          {svc.name}
                        </Link>
                      ) : (
                        <p className="font-medium text-foreground">{svc.name}</p>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-4 text-sm font-mono">
                      <span className="text-muted-foreground">Latency: <span className={svc.latency > 2000 ? "text-red-400 font-bold" : "text-foreground"}>{svc.latency}ms</span></span>
                      <span className="text-muted-foreground">Errors: <span className={svc.errors > 2 ? "text-red-400 font-bold" : "text-foreground"}>{svc.errors}%</span></span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Risk:</span>
                      <RiskScore score={svc.riskScore} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Transaction Hotspots */}
        <Card className="border border-border shadow-sm">
          <CardHeader><CardTitle className="text-base font-semibold flex items-center gap-2"><Flame className="w-4 h-4 text-orange-400" /> Transaction Hotspots</CardTitle></CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-24" /> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground text-xs">
                      <th className="px-4 py-3 text-left font-medium">Transaction</th>
                      <th className="px-4 py-3 text-right font-medium">Avg (ms)</th>
                      <th className="px-4 py-3 text-right font-medium">p99 (ms)</th>
                      <th className="px-4 py-3 text-right font-medium">Calls/min</th>
                      <th className="px-4 py-3 text-right font-medium">Error %</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data?.transactionHotspots?.map((tx: any) => (
                      <tr key={tx.name} className="hover:bg-muted/20">
                        <td className="px-4 py-3 font-medium text-foreground">
                          {tx?.appId && tx?.txId ? (
                            <Link href={`/applications/${tx.appId}/transactions/${encodeURIComponent(String(tx.txId))}`} className="text-primary hover:underline">
                              {tx.name}
                            </Link>
                          ) : (
                            tx.name
                          )}
                        </td>
                        <td className={`px-4 py-3 text-right font-mono ${tx.avgResponseTime > 2000 ? "text-red-400 font-bold" : "text-muted-foreground"}`}>{tx.avgResponseTime.toLocaleString()}</td>
                        <td className={`px-4 py-3 text-right font-mono ${tx.p99 > 5000 ? "text-red-400 font-bold" : "text-muted-foreground"}`}>{tx.p99.toLocaleString()}</td>
                        <td className="px-4 py-3 text-right font-mono text-muted-foreground">{tx.callsPerMinute}</td>
                        <td className={`px-4 py-3 text-right font-mono ${tx.errorRate > 2 ? "text-red-400 font-bold" : "text-muted-foreground"}`}>{tx.errorRate}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Service Drilldown Path */}
        <Card className="border border-border shadow-sm">
          <CardHeader><CardTitle className="text-base font-semibold">Service Drilldown Path</CardTitle></CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-12" /> : (
              <div className="flex flex-wrap items-center gap-1">
                {data?.drilldown?.map((d: any, i: number) => (
                  <div key={d.level} className="flex items-center gap-1">
                    <div className="rounded border border-border bg-muted/30 px-3 py-1.5 text-xs">
                      <span className="text-muted-foreground">{d.level}: </span>
                      <span className="font-medium text-foreground">{d.name}</span>
                    </div>
                    {i < data.drilldown.length - 1 && <ChevronRight className="w-3 h-3 text-muted-foreground" />}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
