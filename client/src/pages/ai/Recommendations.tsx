import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  Lightbulb, Play, Loader2, WifiOff, RefreshCw,
  Zap, Shield, Clock, ArrowRight,
} from "lucide-react";

function PriorityBadge({ p }: { p: string }) {
  const map: Record<string, string> = {
    high: "bg-red-500/10 text-red-400 border-red-500/20",
    medium: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    low: "bg-green-500/10 text-green-400 border-green-500/20",
  };
  return <Badge className={`border text-xs capitalize ${map[p] ?? "bg-muted text-muted-foreground"}`}>{p}</Badge>;
}

function EffortBadge({ e }: { e: string }) {
  const map: Record<string, string> = {
    low: "bg-green-500/10 text-green-400 border-green-500/20",
    medium: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    high: "bg-red-500/10 text-red-400 border-red-500/20",
  };
  return <Badge className={`border text-xs capitalize ${map[e] ?? "bg-muted text-muted-foreground"}`}>{e} effort</Badge>;
}

export default function Recommendations() {
  const { toast } = useToast();
  const [result, setResult] = useState<any>(null);
  const [rootCauseSummary, setRootCauseSummary] = useState("");

  const { data: health } = useQuery<any>({ queryKey: ["/api/ai/health"], retry: false });

  const mutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/ai/recommendations", {
        rootCauseSummary: rootCauseSummary.trim() ? rootCauseSummary : undefined,
      }),
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
              <h1 className="text-2xl font-bold text-foreground">AI Recommendations</h1>
              <Badge className="bg-green-500/10 text-green-400 border border-green-500/20">AI Module</Badge>
              {health?.ok !== undefined && (
                health.ok
                  ? <Badge className="bg-green-500/10 text-green-400 border border-green-500/20 text-xs">Ollama connected</Badge>
                  : <Badge className="bg-red-500/10 text-red-400 border border-red-500/20 text-xs">Ollama offline</Badge>
              )}
            </div>
            <p className="text-muted-foreground text-sm">
              Prioritised remediation actions with impact estimates, effort ratings and time-to-resolution estimates — grounded in your live APM data.
            </p>
          </div>
        </div>

        {health?.ok === false && (
          <div className="flex items-center gap-3 bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3">
            <WifiOff className="w-4 h-4 text-amber-400 shrink-0" />
            <p className="text-sm text-amber-300">
              Ollama is not running. Start it with <code className="bg-black/30 px-1 rounded">ollama serve</code>.
            </p>
          </div>
        )}

        {/* Context input */}
        <Card className="border border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Root Cause Context (optional)</CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-3">
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">
                Paste a root cause summary from the Root Cause Analysis module to tailor recommendations. Leave blank to generate general recommendations from live APM data.
              </Label>
              <Textarea
                data-testid="input-rca-summary"
                placeholder="e.g. 'Database connection pool exhausted due to slow queries in the reports service caused by missing index on orders table…'"
                value={rootCauseSummary}
                onChange={(e) => setRootCauseSummary(e.target.value)}
                rows={3}
                className="text-sm resize-none"
              />
            </div>
            <Button
              data-testid="button-run-recommendations"
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
              className="bg-green-600 hover:bg-green-700 text-white"
            >
              {mutation.isPending
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Generating…</>
                : result
                  ? <><RefreshCw className="w-4 h-4 mr-2" /> Regenerate</>
                  : <><Play className="w-4 h-4 mr-2" /> Generate Recommendations</>
              }
            </Button>
          </CardContent>
        </Card>

        {mutation.isPending && (
          <div className="space-y-4">
            <Skeleton className="h-16" />
            <Skeleton className="h-64" />
            <Skeleton className="h-48" />
          </div>
        )}

        {result && !mutation.isPending && (
          <div className="space-y-5">
            {/* Summary */}
            <Card className="border border-green-500/20 bg-green-500/5">
              <CardContent className="p-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-foreground flex-1">{result.summary}</p>
                <div className="flex items-center gap-2">
                  <div className="w-20 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-green-500 rounded-full" style={{ width: `${Math.round((result.confidence ?? 0) * 100)}%` }} />
                  </div>
                  <span className="text-xs font-bold text-green-400">{Math.round((result.confidence ?? 0) * 100)}% confidence</span>
                </div>
              </CardContent>
            </Card>

            {/* Immediate Actions */}
            {result.immediateActions?.length > 0 && (
              <div>
                <h2 className="text-base font-semibold text-foreground mb-3 flex items-center gap-2">
                  <Zap className="w-4 h-4 text-red-400" /> Immediate Actions
                </h2>
                <div className="space-y-3">
                  {result.immediateActions.map((action: any, i: number) => (
                    <Card key={i} className="border border-border">
                      <CardContent className="p-4">
                        <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
                          <div className="flex items-start gap-2 flex-1">
                            <ArrowRight className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
                            <p className="text-sm font-semibold text-foreground">{action.action}</p>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <PriorityBadge p={action.priority} />
                            {action.effort && <EffortBadge e={action.effort} />}
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground mb-2 ml-6">{action.impact}</p>
                        <div className="flex flex-wrap items-center gap-3 ml-6 text-xs text-muted-foreground">
                          {action.targetService && (
                            <span className="flex items-center gap-1"><Shield className="w-3 h-3" /> {action.targetService}</span>
                          )}
                          {action.estimatedResolutionTime && (
                            <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {action.estimatedResolutionTime}</span>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {/* Preventive Actions */}
            {result.preventiveActions?.length > 0 && (
              <div>
                <h2 className="text-base font-semibold text-foreground mb-3 flex items-center gap-2">
                  <Shield className="w-4 h-4 text-blue-400" /> Preventive Actions
                </h2>
                <div className="space-y-3">
                  {result.preventiveActions.map((action: any, i: number) => (
                    <Card key={i} className="border border-border">
                      <CardContent className="p-4">
                        <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
                          <div className="flex items-start gap-2 flex-1">
                            <ArrowRight className="w-4 h-4 text-blue-400 mt-0.5 shrink-0" />
                            <p className="text-sm font-semibold text-foreground">{action.action}</p>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <PriorityBadge p={action.priority} />
                            {action.effort && <EffortBadge e={action.effort} />}
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground mb-2 ml-6">{action.impact}</p>
                        {action.targetService && (
                          <span className="text-xs text-muted-foreground ml-6 flex items-center gap-1">
                            <Shield className="w-3 h-3" /> {action.targetService}
                          </span>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {!result && !mutation.isPending && (
          <Card className="border border-dashed border-border">
            <CardContent className="p-12 flex flex-col items-center gap-4 text-center">
              <div className="w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center">
                <Lightbulb className="w-8 h-8 text-green-400" />
              </div>
              <div>
                <p className="font-semibold text-foreground mb-1">No recommendations yet</p>
                <p className="text-sm text-muted-foreground max-w-sm">
                  Click "Generate Recommendations" to get prioritised remediation actions from your live APM data.
                </p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </AppLayout>
  );
}
