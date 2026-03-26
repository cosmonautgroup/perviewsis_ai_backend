import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, TrendingDown, AlertTriangle, DollarSign, ShoppingCart, Users, Activity } from "lucide-react";
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { format } from "date-fns";

function KPICard({ title, value, unit, trend, icon, isPositiveGood = true }: any) {
  const isUp = trend > 0;
  const isGood = isPositiveGood ? isUp : !isUp;
  return (
    <Card className="border border-border shadow-sm">
      <CardContent className="p-6">
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm text-muted-foreground font-medium">{title}</p>
          <div className="p-2 rounded-lg bg-muted/50">{icon}</div>
        </div>
        <p className="text-3xl font-bold text-foreground mb-2">
          {unit === "$" ? `$${value?.toLocaleString()}` : value?.toLocaleString()}{unit !== "$" && unit ? unit : ""}
        </p>
        <div className={`flex items-center gap-1 text-sm font-medium ${isGood ? "text-green-500" : "text-red-400"}`}>
          {isUp ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
          {Math.abs(trend)}% vs last period
        </div>
      </CardContent>
    </Card>
  );
}

function RiskCell({ value }: { value: number }) {
  const color = value > 75 ? "bg-red-500" : value > 50 ? "bg-yellow-500" : value > 25 ? "bg-blue-500" : "bg-green-500";
  return (
    <td className="px-4 py-3">
      <div className="flex items-center gap-2">
        <div className={`w-8 h-8 rounded flex items-center justify-center text-xs font-bold text-white ${color}`}>{value}</div>
      </div>
    </td>
  );
}

export default function BusinessView() {
  const { data, isLoading } = useQuery<any>({ queryKey: ["/api/persona/business"] });

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-2xl font-bold text-foreground">Business Leader View</h1>
              <Badge className="bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">Executive Dashboard</Badge>
            </div>
            <p className="text-muted-foreground text-sm">Unified business health — revenue impact, SLA risk, and service posture.</p>
          </div>
          {!isLoading && data?.slaBreachProbability > 60 && (
            <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3">
              <AlertTriangle className="w-4 h-4 text-red-400" />
              <span className="text-sm font-medium text-red-400">{data?.slaBreachProbability}% SLA breach probability in next 6h</span>
            </div>
          )}
        </div>

        {/* KPI Cards */}
        {isLoading ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-36" />)}</div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <KPICard title="Order Volume" value={data?.kpis?.orderVolume} trend={data?.kpis?.orderVolumeTrend} icon={<ShoppingCart className="w-4 h-4 text-blue-400" />} />
            <KPICard title="Revenue" value={data?.kpis?.revenue} unit="$" trend={data?.kpis?.revenueTrend} icon={<DollarSign className="w-4 h-4 text-green-400" />} />
            <KPICard title="Conversion Rate" value={`${data?.kpis?.conversionRate?.toFixed(2)}%`} trend={data?.kpis?.conversionTrend} isPositiveGood icon={<Users className="w-4 h-4 text-purple-400" />} />
            <KPICard title="SLA Health" value={`${data?.kpis?.slaHealth}%`} trend={data?.kpis?.slaTrend} isPositiveGood icon={<Activity className="w-4 h-4 text-amber-400" />} />
          </div>
        )}

        {/* Revenue at Risk */}
        {!isLoading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-5 flex items-center gap-4">
              <div className="p-3 bg-red-500/10 rounded-lg"><DollarSign className="w-6 h-6 text-red-400" /></div>
              <div>
                <p className="text-xs text-red-400 font-medium uppercase tracking-wide mb-1">Revenue at Risk (Next 6h)</p>
                <p className="text-3xl font-bold text-red-400">${data?.revenueAtRisk?.toLocaleString()}</p>
              </div>
            </div>
            <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-5 flex items-center gap-4">
              <div className="p-3 bg-amber-500/10 rounded-lg"><AlertTriangle className="w-6 h-6 text-amber-400" /></div>
              <div>
                <p className="text-xs text-amber-400 font-medium uppercase tracking-wide mb-1">SLA Breach Probability</p>
                <p className="text-3xl font-bold text-amber-400">{data?.slaBreachProbability}%</p>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Revenue Trend */}
          <Card className="border border-border shadow-sm">
            <CardHeader><CardTitle className="text-base font-semibold">Revenue Trend (24h)</CardTitle></CardHeader>
            <CardContent className="h-[240px]">
              {isLoading ? <Skeleton className="h-full" /> : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data?.revenueHistory} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                    <defs>
                      <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="timestamp" tickFormatter={v => format(new Date(v), 'HH:mm')} stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} tickFormatter={v => `$${(v/1000).toFixed(0)}k`} />
                    <Tooltip formatter={(v: any) => `$${v.toLocaleString()}`} />
                    <Area type="monotone" dataKey="value" name="Revenue" stroke="#22c55e" strokeWidth={2} fill="url(#revGrad)" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Service Health Scores */}
          <Card className="border border-border shadow-sm">
            <CardHeader><CardTitle className="text-base font-semibold">Service Health Score</CardTitle></CardHeader>
            <CardContent className="h-[240px]">
              {isLoading ? <Skeleton className="h-full" /> : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data?.serviceHealthScores} layout="vertical" margin={{ top: 0, right: 20, left: 10, bottom: 0 }}>
                    <XAxis type="number" domain={[0, 100]} stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                    <YAxis type="category" dataKey="service" width={140} stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                    <Tooltip formatter={(v: any) => `${v}/100`} />
                    <Bar dataKey="score" name="Health Score" radius={[0, 4, 4, 0]} fill="#6366f1" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Risk Heatmap */}
        <Card className="border border-border shadow-sm">
          <CardHeader><CardTitle className="text-base font-semibold">Risk Heatmap by Tier</CardTitle></CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-24" /> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      <th className="px-4 py-3 text-left font-medium">Tier</th>
                      <th className="px-4 py-3 text-center font-medium">Latency Risk</th>
                      <th className="px-4 py-3 text-center font-medium">Error Risk</th>
                      <th className="px-4 py-3 text-center font-medium">CPU Risk</th>
                      <th className="px-4 py-3 text-center font-medium">Memory Risk</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data?.riskHeatmap?.map((row: any) => (
                      <tr key={row.tier} className="hover:bg-muted/20">
                        <td className="px-4 py-3 font-medium text-foreground">{row.tier}</td>
                        <RiskCell value={row.latency} />
                        <RiskCell value={row.errors} />
                        <RiskCell value={row.cpu} />
                        <RiskCell value={row.memory} />
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-xs text-muted-foreground mt-3 px-4">Risk score 0–100. Red &gt; 75, Yellow 51–75, Blue 26–50, Green 0–25.</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Business Impact Incidents */}
        <Card className="border border-border shadow-sm">
          <CardHeader><CardTitle className="text-base font-semibold">Incident Business Impact</CardTitle></CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-20" /> : (
              <div className="space-y-3">
                {data?.incidentBusinessImpact?.map((inc: any) => (
                  <div key={inc.incident} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-4 py-3">
                    <div>
                      <p className="font-medium text-foreground">{inc.incident}</p>
                      <p className="text-xs text-muted-foreground">{inc.affectedUsers.toLocaleString()} users affected · Duration: {inc.duration}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xl font-bold text-red-400">${inc.revenueImpact.toLocaleString()}</p>
                      <p className="text-xs text-muted-foreground">revenue impact</p>
                    </div>
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
