import React from "react";
import { useParams, Link } from "wouter";
import { ArrowLeft, BrainCircuit, Activity, Clock, Target, AlertTriangle } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { useProblem, useProblemMetrics } from "@/hooks/use-problems";
import { StatusBadge } from "@/components/StatusBadge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine
} from "recharts";

const formatXAxisDate = (tickItem: number) => {
  return format(new Date(tickItem), 'HH:mm');
};

export default function ProblemDetail() {
  const { id } = useParams();
  const problemId = parseInt(id || "0", 10);
  
  const { data: problem, isLoading: isProblemLoading } = useProblem(problemId);
  const { data: metrics, isLoading: isMetricsLoading } = useProblemMetrics(problemId);

  // Combine metrics for the timeline chart
  const timelineData = React.useMemo(() => {
    if (!metrics) return [];
    return [
      ...metrics.before.map(m => ({ ...m, phase: 'before' })),
      ...metrics.during.map(m => ({ ...m, phase: 'during' })),
      ...metrics.after.map(m => ({ ...m, phase: 'after' }))
    ].sort((a, b) => a.timestamp - b.timestamp);
  }, [metrics]);

  const incidentStart = metrics?.during[0]?.timestamp;

  if (isProblemLoading) {
    return (
      <AppLayout>
        <div className="space-y-6">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-12 w-2/3" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <Skeleton className="h-96 md:col-span-1" />
            <Skeleton className="h-96 md:col-span-2" />
          </div>
        </div>
      </AppLayout>
    );
  }

  if (!problem) return <AppLayout>Problem not found</AppLayout>;

  return (
    <AppLayout>
      <div className="mb-6">
        <Button variant="ghost" size="sm" className="mb-4 text-muted-foreground hover:text-foreground pl-0" onClick={() => window.history.back()}>
          <ArrowLeft className="w-4 h-4 mr-2" /> Back to Incidents
        </Button>
        
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
          <div>
            <div className="flex items-center space-x-3 mb-2">
              <h1 className="text-3xl font-bold text-foreground">{problem.title}</h1>
              <StatusBadge status={problem.severity} />
              <StatusBadge status={problem.status} />
            </div>
            <div className="flex items-center space-x-4 text-sm text-muted-foreground mt-2">
              <span className="flex items-center"><Clock className="w-4 h-4 mr-1" /> Started: {problem.startTime ? format(new Date(problem.startTime), "MMM d, yyyy HH:mm") : "—"}</span>
              {problem.duration && <span>Duration: {problem.duration} mins</span>}
              <span className="flex items-center"><Target className="w-4 h-4 mr-1" /> ID: PRB-{problem.id}</span>
            </div>
          </div>
          <Button className="shrink-0 shadow-lg shadow-primary/20 bg-gradient-to-r from-primary to-primary/80">
            Acknowledge Problem
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column - AI Analysis */}
        <div className="lg:col-span-1 space-y-6">
          <Card className="border border-primary/20 shadow-lg bg-gradient-to-b from-card to-primary/5 relative overflow-hidden">
            <div className="absolute top-0 right-0 p-4 opacity-10 pointer-events-none">
              <BrainCircuit className="w-24 h-24 text-primary" />
            </div>
            <CardHeader className="pb-3 border-b border-primary/10">
              <CardTitle className="flex items-center text-lg text-primary">
                <BrainCircuit className="w-5 h-5 mr-2" />
                AI Root Cause Analysis
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4 space-y-4 relative z-10">
              {problem.rootCause ? (
                <p className="text-foreground leading-relaxed">
                  {problem.rootCause}
                </p>
              ) : (
                <div className="flex items-center space-x-2 text-muted-foreground">
                  <span className="animate-spin relative flex h-3 w-3">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-primary"></span>
                  </span>
                  <span>Analyzing telemetry data...</span>
                </div>
              )}

              {problem.errorMessage && (
                <div className="mt-4 p-3 bg-[#0A0A0A] rounded-md border border-border">
                  <div className="text-xs text-muted-foreground mb-1 flex items-center font-mono">
                    <AlertTriangle className="w-3 h-3 mr-1 text-status-warning" /> Exception Trace
                  </div>
                  <code className="text-sm text-red-400 font-mono break-words whitespace-pre-wrap">
                    {problem.errorMessage}
                  </code>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-base font-semibold">Affected Tiers</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {problem.affectedTiers.map(tier => (
                  <div key={tier} className="flex items-center bg-secondary px-3 py-1.5 rounded-md border border-border text-sm font-medium">
                    <Activity className="w-4 h-4 mr-2 text-muted-foreground" />
                    {tier}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right Column - Telemetry Context */}
        <div className="lg:col-span-2 space-y-6">
          <Card className="border border-border shadow-sm h-full">
            <CardHeader>
              <CardTitle className="text-lg">Performance Context (Timeline)</CardTitle>
              <CardDescription>Metrics 30 mins before and after incident onset</CardDescription>
            </CardHeader>
            <CardContent className="h-[400px]">
              {isMetricsLoading ? (
                <div className="w-full h-full flex items-center justify-center">
                  <Skeleton className="h-[300px] w-full" />
                </div>
              ) : timelineData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={timelineData} margin={{ top: 20, right: 20, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorMetric" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--status-critical))" stopOpacity={0.4}/>
                        <stop offset="95%" stopColor="hsl(var(--status-critical))" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis 
                      dataKey="timestamp" 
                      tickFormatter={formatXAxisDate} 
                      stroke="hsl(var(--muted-foreground))" 
                      fontSize={12} 
                      tickLine={false} 
                      axisLine={false} 
                    />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                    <Tooltip 
                      contentStyle={{ backgroundColor: 'hsl(var(--card))', borderRadius: '8px', border: '1px solid hsl(var(--border))' }}
                      labelFormatter={(l) => format(new Date(l), 'HH:mm:ss')}
                    />
                    
                    {incidentStart && (
                      <ReferenceLine 
                        x={incidentStart} 
                        stroke="hsl(var(--status-critical))" 
                        strokeDasharray="4 4"
                        label={{ position: 'top', value: 'Incident Start', fill: 'hsl(var(--status-critical))', fontSize: 12, fontWeight: 'bold' }} 
                      />
                    )}
                    
                    <Area 
                      type="monotone" 
                      dataKey="value" 
                      name="Primary Metric Deviation" 
                      stroke="hsl(var(--status-critical))" 
                      strokeWidth={3} 
                      fill="url(#colorMetric)" 
                    />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="w-full h-full flex items-center justify-center text-muted-foreground border border-dashed rounded-lg bg-muted/20">
                  Detailed metrics not available
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}
