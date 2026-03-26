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
  GitMerge, Play, Loader2, WifiOff, RefreshCw,
  CheckCircle2, Zap, Layers,
} from "lucide-react";

function CorrelationTypeBadge({ type }: { type: string }) {
  const map: Record<string, string> = {
    causal: "bg-red-500/10 text-red-400 border-red-500/20",
    temporal: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    service: "bg-purple-500/10 text-purple-400 border-purple-500/20",
    error: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  };
  return <Badge className={`border text-xs capitalize ${map[type] ?? "bg-muted text-muted-foreground"}`}>{type}</Badge>;
}

function ImpactBadge({ v }: { v: string }) {
  const map: Record<string, string> = {
    High: "bg-red-500/10 text-red-400 border-red-500/20",
    Medium: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    Low: "bg-green-500/10 text-green-400 border-green-500/20",
  };
  return <Badge className={`border text-xs ${map[v] ?? "bg-muted text-muted-foreground"}`}>{v}</Badge>;
}

function PriorityBadge({ p }: { p: string }) {
  const map: Record<string, string> = {
    high: "bg-red-500/10 text-red-400 border-red-500/20",
    medium: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    low: "bg-green-500/10 text-green-400 border-green-500/20",
  };
  return <Badge className={`border text-xs capitalize ${map[p] ?? "bg-muted text-muted-foreground"}`}>{p}</Badge>;
}

export default function CorrelationInsights() {
  const { toast } = useToast();
  const [result, setResult] = useState<any>(null);

  const { data: health } = useQuery<any>({ queryKey: ["/api/ai/health"], retry: false });

  const mutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/ai/correlation-insights"),
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
              <h1 className="text-2xl font-bold text-foreground">AI Correlation Insights</h1>
              <Badge className="bg-purple-500/10 text-purple-400 border border-purple-500/20">AI Module</Badge>
              {health?.ok !== undefined && (
                health.ok
                  ? <Badge className="bg-green-500/10 text-green-400 border border-green-500/20 text-xs">Ollama connected</Badge>
                  : <Badge className="bg-red-500/10 text-red-400 border border-red-500/20 text-xs">Ollama offline</Badge>
              )}
            </div>
            <p className="text-muted-foreground text-sm">
              Discover hidden correlations between incidents, alerts and errors across services — surfacing anomaly clusters and service-event mappings.
            </p>
          </div>
          <Button
            data-testid="button-run-correlation"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            className="bg-purple-600 hover:bg-purple-700 text-white"
          >
            {mutation.isPending
              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Analysing…</>
              : result
                ? <><RefreshCw className="w-4 h-4 mr-2" /> Re-run Analysis</>
                : <><Play className="w-4 h-4 mr-2" /> Run Correlation Analysis</>
            }
          </Button>
        </div>

        {health?.ok === false && (
          <div className="flex items-center gap-3 bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3">
            <WifiOff className="w-4 h-4 text-amber-400 shrink-0" />
            <p className="text-sm text-amber-300">
              Ollama is not running. Start it with <code className="bg-black/30 px-1 rounded">ollama serve</code>.
            </p>
          </div>
        )}

        {mutation.isPending && (
          <div className="space-y-4">
            <Skeleton className="h-16" />
            <Skeleton className="h-48" />
            <Skeleton className="h-36" />
          </div>
        )}

        {result && !mutation.isPending && (
          <div className="space-y-5">
            {/* Summary */}
            <Card className="border border-purple-500/20 bg-purple-500/5">
              <CardContent className="p-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-foreground flex-1">{result.summary}</p>
                <div className="flex items-center gap-2">
                  <div className="w-20 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-purple-500 rounded-full" style={{ width: `${Math.round((result.confidence ?? 0) * 100)}%` }} />
                  </div>
                  <span className="text-xs font-bold text-purple-400">{Math.round((result.confidence ?? 0) * 100)}% confidence</span>
                </div>
              </CardContent>
            </Card>

            {/* Correlations */}
            {result.correlations?.length > 0 && (
              <div>
                <h2 className="text-base font-semibold text-foreground mb-3 flex items-center gap-2">
                  <GitMerge className="w-4 h-4 text-purple-400" /> Discovered Correlations
                </h2>
                <div className="space-y-3">
                  {result.correlations.map((c: any, i: number) => (
                    <Card key={c.id ?? i} className="border border-border">
                      <CardContent className="p-4">
                        <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
                          <div>
                            <p className="text-sm font-semibold text-foreground">{c.title}</p>
                            <p className="text-xs text-muted-foreground mt-0.5">{c.description}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <CorrelationTypeBadge type={c.type} />
                            <span className="text-xs text-muted-foreground">Strength: <span className="font-bold text-purple-400">{Math.round((c.strength ?? 0) * 100)}%</span></span>
                          </div>
                        </div>
                        {c.services?.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mb-2">
                            {c.services.map((s: string, si: number) => (
                              <span key={si} className="text-xs bg-muted/40 border border-border rounded px-2 py-0.5 text-foreground">{s}</span>
                            ))}
                          </div>
                        )}
                        {c.evidence?.length > 0 && (
                          <ul className="space-y-0.5 mt-2">
                            {c.evidence.map((e: string, ei: number) => (
                              <li key={ei} className="text-xs text-muted-foreground flex items-start gap-1.5">
                                <span className="text-purple-400 shrink-0 mt-0.5">›</span>{e}
                              </li>
                            ))}
                          </ul>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {/* Anomaly Clusters */}
            {result.anomalyClusters?.length > 0 && (
              <div>
                <h2 className="text-base font-semibold text-foreground mb-3 flex items-center gap-2">
                  <Zap className="w-4 h-4 text-amber-400" /> Anomaly Clusters
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {result.anomalyClusters.map((cl: any, i: number) => (
                    <Card key={i} className="border border-border">
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <p className="text-sm font-semibold text-foreground">{cl.cluster}</p>
                          <ImpactBadge v={cl.impact} />
                        </div>
                        <p className="text-xs text-muted-foreground mb-2">Frequency: {cl.frequency}</p>
                        <div className="flex flex-wrap gap-1">
                          {cl.events?.map((e: string, ei: number) => (
                            <span key={ei} className="text-xs bg-amber-500/10 border border-amber-500/20 text-amber-400 rounded px-1.5 py-0.5">{e}</span>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {/* Service Event Map */}
            {result.serviceEventMap?.length > 0 && (
              <Card className="border border-border">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2"><Layers className="w-4 h-4 text-blue-400" /> Service → Event Map</CardTitle>
                </CardHeader>
                <CardContent className="pt-0 space-y-2">
                  {result.serviceEventMap.map((item: any, i: number) => (
                    <div key={i} className="flex items-start justify-between gap-3 py-2 border-b border-border last:border-0">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground">{item.service}</p>
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">{item.relatedEvents?.join(", ")}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                          <div className="h-full bg-blue-500 rounded-full" style={{ width: `${item.riskContribution ?? 0}%` }} />
                        </div>
                        <span className="text-xs font-bold text-blue-400 w-8 text-right">{item.riskContribution}%</span>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Recommendations */}
            {result.recommendations?.length > 0 && (
              <Card className="border border-border">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-green-400" /> Recommendations</CardTitle>
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

        {!result && !mutation.isPending && (
          <Card className="border border-dashed border-border">
            <CardContent className="p-12 flex flex-col items-center gap-4 text-center">
              <div className="w-16 h-16 rounded-full bg-purple-500/10 flex items-center justify-center">
                <GitMerge className="w-8 h-8 text-purple-400" />
              </div>
              <div>
                <p className="font-semibold text-foreground mb-1">No correlations found yet</p>
                <p className="text-sm text-muted-foreground max-w-sm">
                  Click "Run Correlation Analysis" to discover hidden patterns across your incidents, alerts and errors.
                </p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </AppLayout>
  );
}
