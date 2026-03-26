import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, ArrowRight, CheckCircle2, Layers } from "lucide-react";
import { AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { format } from "date-fns";

function StatCard({ label, value, unit, color }: { label: string; value: any; unit?: string; color: string }) {
  return (
    <div className={`rounded-xl border p-5 ${color}`}>
      <p className="text-xs font-medium uppercase tracking-wide opacity-70 mb-1">{label}</p>
      <p className="text-3xl font-bold">{typeof value === 'number' ? value.toLocaleString() : value}<span className="text-base font-normal opacity-60 ml-1">{unit}</span></p>
    </div>
  );
}

export default function OtelFlow() {
  const [proprietaryMode, setProprietaryMode] = useState(false);
  const { data, isLoading } = useQuery<any>({ queryKey: ["/api/otel/stats"] });

  const exportColors = ["#6366f1", "#22c55e", "#f59e0b"];

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground mb-1">Telemetry Flow Dashboard</h1>
            <p className="text-muted-foreground text-sm">Live view of the OpenTelemetry collector pipeline — ingestion, processing, and export.</p>
          </div>
          <div className="flex items-center gap-3 bg-card border border-border rounded-lg px-4 py-3">
            <Label htmlFor="mode-toggle" className={`text-sm font-medium ${proprietaryMode ? "text-red-400" : "text-muted-foreground"}`}>Proprietary Mode</Label>
            <Switch id="mode-toggle" checked={proprietaryMode} onCheckedChange={setProprietaryMode} />
            <Label htmlFor="mode-toggle" className={`text-sm font-medium ${!proprietaryMode ? "text-green-400" : "text-muted-foreground"}`}>OTel Mode</Label>
          </div>
        </div>

        {/* Proprietary Warning */}
        {proprietaryMode && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-red-400 mb-1">Proprietary Agent Mode Active</p>
              <ul className="text-sm text-red-300/80 space-y-1">
                <li>• 2.8x higher ingestion cost — no sampling or filtering</li>
                <li>• Vendor lock-in active — single exporter only</li>
                <li>• No multi-backend export capability</li>
                <li>• SDK migration required to switch vendors</li>
              </ul>
            </div>
          </div>
        )}

        {/* Live Stats */}
        {isLoading ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4"><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label="Metrics / sec" value={proprietaryMode ? Math.round((data?.metricsPerSec || 0) * 2.8) : data?.metricsPerSec} color="bg-blue-500/5 border-blue-500/20 text-blue-400" />
            <StatCard label="Logs / sec" value={proprietaryMode ? Math.round((data?.logsPerSec || 0) * 2.8) : data?.logsPerSec} color="bg-green-500/5 border-green-500/20 text-green-400" />
            <StatCard label="Traces / sec" value={proprietaryMode ? Math.round((data?.tracesPerSec || 0) * 2.8) : data?.tracesPerSec} color="bg-purple-500/5 border-purple-500/20 text-purple-400" />
            <StatCard label="Data Filtered" value={proprietaryMode ? "0" : data?.filteredPercent} unit="%" color={proprietaryMode ? "bg-red-500/5 border-red-500/20 text-red-400" : "bg-amber-500/5 border-amber-500/20 text-amber-400"} />
          </div>
        )}

        {/* Pipeline Stages */}
        <Card className="border border-border shadow-sm">
          <CardHeader>
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Layers className="w-4 h-4" /> Collector Pipeline
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-20" /> : (
              <div className="space-y-3">
                {data?.collectorPipeline?.map((stage: any) => (
                  <div key={stage.stage} className="flex items-center gap-4 rounded-lg border border-border bg-muted/20 px-4 py-3">
                    <div className={`w-2 h-2 rounded-full shrink-0 ${stage.status === 'Healthy' ? 'bg-green-500' : 'bg-yellow-500'}`} />
                    <span className="font-medium text-sm w-36 text-foreground">{stage.stage}</span>
                    <div className="flex-1 hidden sm:flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                        <div className="h-full bg-primary rounded-full" style={{ width: `${(stage.throughput / 24050) * 100}%` }} />
                      </div>
                    </div>
                    <span className="text-sm text-muted-foreground font-mono w-32 text-right">{stage.throughput.toLocaleString()} events/s</span>
                    <Badge variant={stage.status === 'Healthy' ? 'secondary' : 'outline'} className={stage.status === 'Healthy' ? 'text-green-500' : 'text-yellow-500'}>{stage.status}</Badge>
                    <span className="text-xs text-muted-foreground font-mono w-14 text-right hidden md:block">{stage.latencyMs}ms</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Ingestion History Chart */}
          <Card className="border border-border shadow-sm">
            <CardHeader>
              <CardTitle className="text-base font-semibold">Telemetry Ingestion (24h)</CardTitle>
            </CardHeader>
            <CardContent className="h-[280px]">
              {isLoading ? <Skeleton className="h-full" /> : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data?.ingestionHistory} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="timestamp" tickFormatter={(v) => format(new Date(v), 'HH:mm')} stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                    <Tooltip />
                    <Area type="monotone" dataKey="metrics" name="Metrics" stackId="1" stroke="#6366f1" fill="#6366f1" fillOpacity={0.6} />
                    <Area type="monotone" dataKey="logs" name="Logs" stackId="1" stroke="#22c55e" fill="#22c55e" fillOpacity={0.6} />
                    <Area type="monotone" dataKey="traces" name="Traces" stackId="1" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.6} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Export Distribution */}
          <Card className="border border-border shadow-sm">
            <CardHeader>
              <CardTitle className="text-base font-semibold">Export Distribution</CardTitle>
            </CardHeader>
            <CardContent className="h-[280px]">
              {isLoading ? <Skeleton className="h-full" /> : proprietaryMode ? (
                <div className="h-full flex flex-col items-center justify-center gap-3 text-center text-muted-foreground">
                  <AlertTriangle className="w-8 h-8 text-red-400" />
                  <p className="font-medium text-red-400">Single exporter only</p>
                  <p className="text-sm">Proprietary agents cannot multi-export. All telemetry locked to single vendor backend.</p>
                </div>
              ) : (
                <div className="flex flex-col items-center h-full">
                  <ResponsiveContainer width="100%" height="75%">
                    <PieChart>
                      <Pie data={data?.exportDistribution} cx="50%" cy="50%" innerRadius={55} outerRadius={85} dataKey="percent" nameKey="name">
                        {data?.exportDistribution?.map((_: any, i: number) => <Cell key={i} fill={exportColors[i]} />)}
                      </Pie>
                      <Tooltip formatter={(v: any) => `${v}%`} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="flex flex-wrap justify-center gap-3 mt-2">
                    {data?.exportDistribution?.map((d: any, i: number) => (
                      <div key={d.name} className="flex items-center gap-1.5">
                        <div className="w-3 h-3 rounded-full" style={{ background: exportColors[i] }} />
                        <span className="text-xs text-muted-foreground">{d.name} ({d.percent}%)</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* OTel vs Proprietary comparison */}
        <Card className="border border-border shadow-sm">
          <CardHeader>
            <CardTitle className="text-base font-semibold">OpenTelemetry vs Proprietary Agent — Feature Comparison</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="py-3 px-4 text-left font-medium">Capability</th>
                    <th className="py-3 px-4 text-center font-medium text-green-400">OpenTelemetry</th>
                    <th className="py-3 px-4 text-center font-medium text-red-400">Proprietary Agent</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {[
                    ["Vendor Neutral", true, false],
                    ["Intelligent Sampling / Filtering", true, false],
                    ["Multi-Backend Export", true, false],
                    ["Standard SDK (all languages)", true, false],
                    ["Zero-cost Agent Licensing", true, false],
                    ["Community-driven Innovation", true, false],
                    ["AI-Ready Semantic Conventions", true, false],
                  ].map(([cap, otel, prop]) => (
                    <tr key={String(cap)} className="hover:bg-muted/20">
                      <td className="py-3 px-4 text-foreground">{cap}</td>
                      <td className="py-3 px-4 text-center">{otel ? <CheckCircle2 className="w-4 h-4 text-green-500 mx-auto" /> : <span className="text-red-400 font-bold">✕</span>}</td>
                      <td className="py-3 px-4 text-center">{prop ? <CheckCircle2 className="w-4 h-4 text-green-500 mx-auto" /> : <span className="text-red-400 font-bold">✕</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
