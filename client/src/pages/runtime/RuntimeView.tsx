import { useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { BrainCircuit, AlertTriangle, Cpu, Server } from "lucide-react";
import { ComposedChart, Line, Area, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { format } from "date-fns";

const SERVICES = ["frontend-service", "payment-service", "inventory-service"];

function AnomalyDot(props: any) {
  const { cx, cy, payload } = props;
  if (!payload || payload.gcTime < 500) return null;
  return <circle cx={cx} cy={cy} r={6} fill="#ef4444" stroke="white" strokeWidth={2} />;
}

export default function RuntimeView() {
  const { service } = useParams<{ service: string }>();
  const svcName = service || "frontend-service";
  const { data, isLoading } = useQuery<any>({ queryKey: ["/api/runtime", svcName], queryFn: () => fetch(`/api/runtime/${svcName}`).then(r => r.json()) });

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-2xl font-bold text-foreground">Runtime Deep Observability</h1>
            </div>
            <p className="text-muted-foreground text-sm">JVM / .NET CLR runtime metrics with AI anomaly detection and recommendations.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {SERVICES.map(s => (
              <a key={s} href={`/runtime/${s}`} className={`px-3 py-1.5 rounded border text-xs font-medium transition-colors ${s === svcName ? "bg-primary/10 border-primary/30 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}>
                {s}
              </a>
            ))}
          </div>
        </div>

        {/* Service info + AI Insight */}
        {!isLoading && data && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-1 bg-card border border-border rounded-xl p-5">
              <div className="flex items-center gap-3 mb-4">
                <Server className="w-5 h-5 text-muted-foreground" />
                <div>
                  <p className="font-bold text-foreground">{data.service}</p>
                  <p className="text-xs text-muted-foreground">{data.runtime} Runtime</p>
                </div>
              </div>
              <div className="space-y-2">
                {data.anomalies?.map((a: any) => (
                  <div key={a.metric} className={`rounded-lg border px-3 py-2 text-xs ${a.severity === 'Critical' ? 'border-red-500/30 bg-red-500/5 text-red-400' : 'border-yellow-500/30 bg-yellow-500/5 text-yellow-400'}`}>
                    <div className="flex items-center gap-1.5 font-semibold mb-0.5">
                      <AlertTriangle className="w-3 h-3" />{a.metric}
                    </div>
                    <p>Value: <strong>{a.value}</strong> / Threshold: {a.threshold}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="lg:col-span-2 bg-card border border-indigo-500/30 rounded-xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <BrainCircuit className="w-4 h-4 text-indigo-400" />
                <span className="font-semibold text-sm text-foreground">AI Runtime Insight</span>
                <Badge className="bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 text-xs">Auto-generated</Badge>
              </div>
              <p className="text-foreground text-sm leading-relaxed">{data.aiInsight}</p>
            </div>
          </div>
        )}

        {/* GC + CPU Chart (anomaly highlighted) */}
        <Card className="border border-border shadow-sm">
          <CardHeader>
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Cpu className="w-4 h-4" /> Runtime Metrics — Anomaly Highlighted
            </CardTitle>
          </CardHeader>
          <CardContent className="h-[320px]">
            {isLoading ? <Skeleton className="h-full" /> : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={data?.metrics} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="timestamp" tickFormatter={v => format(new Date(v), 'HH:mm')} stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis yAxisId="left" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis yAxisId="right" orientation="right" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                  <Tooltip labelFormatter={v => format(new Date(v), 'HH:mm:ss')} />
                  <ReferenceLine yAxisId="left" y={200} stroke="#ef4444" strokeDasharray="4 2" label={{ value: "GC Threshold", fill: "#ef4444", fontSize: 10 }} />
                  <Area yAxisId="left" type="monotone" dataKey="gcTime" name="GC Pause (ms)" fill="#ef4444" fillOpacity={0.15} stroke="#ef4444" strokeWidth={2} dot={<AnomalyDot />} />
                  <Line yAxisId="right" type="monotone" dataKey="cpuUsage" name="CPU %" stroke="#6366f1" strokeWidth={2} dot={false} />
                  <Line yAxisId="right" type="monotone" dataKey="heapUsed" name="Heap %" stroke="#f59e0b" strokeWidth={2} dot={false} strokeDasharray="4 2" />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Thread + Exception rate */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="border border-border shadow-sm">
            <CardHeader><CardTitle className="text-base font-semibold">Thread Count</CardTitle></CardHeader>
            <CardContent className="h-[200px]">
              {isLoading ? <Skeleton className="h-full" /> : (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={data?.metrics} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="timestamp" tickFormatter={v => format(new Date(v), 'HH:mm')} stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                    <Tooltip />
                    <Line type="monotone" dataKey="threadCount" name="Thread Count" stroke="#22c55e" strokeWidth={2} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <Card className="border border-border shadow-sm">
            <CardHeader><CardTitle className="text-base font-semibold">Exception Rate / min</CardTitle></CardHeader>
            <CardContent className="h-[200px]">
              {isLoading ? <Skeleton className="h-full" /> : (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={data?.metrics} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="timestamp" tickFormatter={v => format(new Date(v), 'HH:mm')} stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                    <Tooltip />
                    <Bar dataKey="exceptionRate" name="Exceptions/min" fill="#ef4444" fillOpacity={0.7} radius={[2, 2, 0, 0]} />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}
