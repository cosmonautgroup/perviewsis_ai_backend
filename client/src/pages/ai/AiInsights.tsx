import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  BrainCircuit, ChevronRight, AlertTriangle, CheckCircle2,
  TrendingUp, Play, Loader2, WifiOff, RefreshCw,
} from "lucide-react";

function OllamaStatusBadge({ ok }: { ok: boolean | null }) {
  if (ok === null) return null;
  return ok
    ? <Badge className="bg-green-500/10 text-green-400 border border-green-500/20 text-xs">Ollama connected</Badge>
    : <Badge className="bg-red-500/10 text-red-400 border border-red-500/20 text-xs">Ollama offline</Badge>;
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="w-24 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-bold text-indigo-400">{pct}%</span>
    </div>
  );
}

function PriorityBadge({ p }: { p: string }) {
  const map: Record<string, string> = {
    high: "bg-red-500/10 text-red-400 border-red-500/20",
    medium: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    low: "bg-green-500/10 text-green-400 border-green-500/20",
  };
  return <Badge className={`border text-xs capitalize ${map[p] ?? "bg-muted text-muted-foreground"}`}>{p}</Badge>;
}

export default function AiInsights() {
  const { toast } = useToast();
  const [result, setResult] = useState<any>(null);

  const { data: health } = useQuery<any>({ queryKey: ["/api/ai/health"], retry: false });

  const mutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/ai/causal-predictive"),
    onSuccess: async (res) => {
      const data = await res.json();
      if (data.error) {
        toast({ title: "AI Error", description: data.error, variant: "destructive" });
      } else {
        setResult(data);
      }
    },
    onError: (err: any) => toast({ title: "AI Error", description: err.message, variant: "destructive" }),
  });

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-2xl font-bold text-foreground">Causal & Predictive AI</h1>
              <Badge className="bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">AI Module</Badge>
              <OllamaStatusBadge ok={health?.ok ?? null} />
            </div>
            <p className="text-muted-foreground text-sm">
              AI-powered causal chain discovery, service dependency mapping and 72-hour failure prediction — powered by Ollama using your live APM data.
            </p>
          </div>
          <Button
            data-testid="button-run-causal-ai"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || health?.ok === false}
            className="bg-indigo-600 hover:bg-indigo-700 text-white"
          >
            {mutation.isPending
              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Analysing…</>
              : result
                ? <><RefreshCw className="w-4 h-4 mr-2" /> Re-run Analysis</>
                : <><Play className="w-4 h-4 mr-2" /> Run AI Analysis</>
            }
          </Button>
        </div>

        {/* Ollama offline warning */}
        {health?.ok === false && (
          <div className="flex items-center gap-3 bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3">
            <WifiOff className="w-4 h-4 text-amber-400 shrink-0" />
            <p className="text-sm text-amber-300">
              Ollama is not running. Start it with <code className="bg-black/30 px-1 rounded">ollama serve</code>, then pull a model with <code className="bg-black/30 px-1 rounded">ollama pull llama3.2</code>.
            </p>
          </div>
        )}

        {/* Loading skeleton */}
        {mutation.isPending && (
          <div className="space-y-4">
            <Skeleton className="h-32" />
            <Skeleton className="h-48" />
            <Skeleton className="h-24" />
          </div>
        )}

        {/* Results */}
        {result && !mutation.isPending && (
          <div className="space-y-6">
            {/* Summary */}
            <Card className="border border-indigo-500/20 bg-indigo-500/5">
              <CardContent className="p-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-foreground">{result.summary}</p>
                <ConfidenceBar value={result.confidence ?? 0} />
              </CardContent>
            </Card>

            {/* Causal Chains */}
            {result.causalChains?.length > 0 && (
              <div>
                <h2 className="text-base font-semibold text-foreground mb-3 flex items-center gap-2">
                  <BrainCircuit className="w-4 h-4 text-indigo-400" /> Causal Root Cause Analysis
                </h2>
                <div className="space-y-4">
                  {result.causalChains.map((chain: any, i: number) => (
                    <Card key={chain.id ?? i} className="border border-border shadow-sm">
                      <CardHeader className="pb-3">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <CardTitle className="text-sm font-bold text-foreground mb-1">{chain.title}</CardTitle>
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-muted-foreground">Confidence:</span>
                              <div className="flex items-center gap-1.5">
                                <div className="w-20 h-1.5 bg-muted rounded-full overflow-hidden">
                                  <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${chain.confidence}%` }} />
                                </div>
                                <span className="text-xs font-bold text-indigo-400">{chain.confidence}%</span>
                              </div>
                            </div>
                          </div>
                          <Badge className="bg-red-500/10 text-red-400 border border-red-500/20">Root Cause Identified</Badge>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <div className="flex flex-wrap items-center gap-1 mb-4">
                          {chain.steps?.map((step: any, si: number) => (
                            <div key={si} className="flex items-center gap-1">
                              <div className="bg-muted/50 border border-border rounded px-2 py-1 text-xs">
                                <span className="text-muted-foreground">{step.time} </span>
                                <span className="text-foreground font-medium">{step.event}</span>
                                <span className="text-muted-foreground"> ({step.value})</span>
                              </div>
                              {si < chain.steps.length - 1 && <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />}
                            </div>
                          ))}
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div className="rounded-lg bg-red-500/5 border border-red-500/20 p-3">
                            <p className="text-xs font-semibold text-red-400 mb-1 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Root Cause</p>
                            <p className="text-xs text-muted-foreground">{chain.rootCause}</p>
                          </div>
                          <div className="rounded-lg bg-green-500/5 border border-green-500/20 p-3">
                            <p className="text-xs font-semibold text-green-400 mb-1 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Recommendation</p>
                            <p className="text-xs text-muted-foreground">{chain.recommendation}</p>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {/* Predictions */}
            {result.predictions?.length > 0 && (
              <div>
                <h2 className="text-base font-semibold text-foreground mb-3 flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-amber-400" /> 72-Hour Predictions
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {result.predictions.map((p: any, i: number) => (
                    <Card key={i} className={`border shadow-sm ${p.riskLevel === "High" ? "border-red-500/30 bg-red-500/5" : "border-yellow-500/30 bg-yellow-500/5"}`}>
                      <CardContent className="p-5">
                        <p className="text-xs font-medium text-muted-foreground mb-2">{p.metric}</p>
                        <div className="flex justify-between items-end mb-3">
                          <div>
                            <p className="text-xs text-muted-foreground">Now</p>
                            <p className="text-xl font-bold text-foreground">{p.current}{p.metric?.includes("Rate") ? "%" : p.metric?.includes("Time") ? "ms" : "%"}</p>
                          </div>
                          <ChevronRight className="w-4 h-4 text-muted-foreground" />
                          <div className="text-right">
                            <p className="text-xs text-muted-foreground">72h Forecast</p>
                            <p className={`text-xl font-bold ${p.riskLevel === "High" ? "text-red-400" : "text-yellow-400"}`}>
                              {p.predicted72h}{p.metric?.includes("Rate") ? "%" : p.metric?.includes("Time") ? "ms" : "%"}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center justify-between">
                          <Badge className={p.riskLevel === "High" ? "bg-red-500/10 text-red-400 border border-red-500/20" : "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20"}>
                            {p.riskLevel} Risk
                          </Badge>
                          <span className="text-xs text-muted-foreground">{p.confidence}% confidence</span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-2">{p.action}</p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {/* Application-wise risk */}
            {result.applicationPredictions?.length > 0 && (
              <div>
                <h2 className="text-base font-semibold text-foreground mb-3">
                  Application-wise Predictions
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {result.applicationPredictions.map((app: any, i: number) => (
                    <Card key={`${app.application}-${i}`} className="border border-border">
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <p className="text-sm font-semibold text-foreground truncate">{app.application}</p>
                          <Badge className={app.riskLevel === "High"
                            ? "bg-red-500/10 text-red-400 border border-red-500/20"
                            : app.riskLevel === "Medium"
                              ? "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20"
                              : "bg-green-500/10 text-green-400 border border-green-500/20"}
                          >
                            {app.riskLevel} ({Math.round(app.riskScore ?? 0)})
                          </Badge>
                        </div>
                        <div className="grid grid-cols-4 gap-2 text-xs text-muted-foreground">
                          <div><span className="block text-foreground font-semibold">{app.incidents ?? 0}</span>Incidents</div>
                          <div><span className="block text-foreground font-semibold">{app.alerts ?? 0}</span>Alerts</div>
                          <div><span className="block text-foreground font-semibold">{app.errors ?? 0}</span>Errors</div>
                          <div><span className="block text-foreground font-semibold">{app.servers ?? 0}</span>Servers</div>
                        </div>
                        <p className="text-xs text-muted-foreground mt-3">72h trend: {app.trend72h ?? "Stable"}</p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {/* Recommendations */}
            {result.recommendations?.length > 0 && (
              <Card className="border border-border">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-green-400" /> AI Recommendations</CardTitle>
                </CardHeader>
                <CardContent className="pt-0 space-y-2">
                  {result.recommendations.map((r: any, i: number) => (
                    <div key={i} className="flex items-start justify-between gap-3 py-2 border-b border-border last:border-0">
                      <div>
                        <p className="text-sm text-foreground font-medium">{r.action}</p>
                        <p className="text-xs text-muted-foreground">{r.impact}</p>
                      </div>
                      <PriorityBadge p={r.priority} />
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {/* Empty state */}
        {!result && !mutation.isPending && (
          <Card className="border border-dashed border-border">
            <CardContent className="p-12 flex flex-col items-center gap-4 text-center">
              <div className="w-16 h-16 rounded-full bg-indigo-500/10 flex items-center justify-center">
                <BrainCircuit className="w-8 h-8 text-indigo-400" />
              </div>
              <div>
                <p className="font-semibold text-foreground mb-1">No analysis yet</p>
                <p className="text-sm text-muted-foreground max-w-sm">
                  Click "Run AI Analysis" to analyse your live APM data for causal chains, predicted failures and root causes.
                </p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </AppLayout>
  );
}
