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
  Trophy, Play, Loader2, WifiOff, RefreshCw,
  CheckCircle2, TrendingUp, TrendingDown, Minus,
} from "lucide-react";

function RiskBadge({ level }: { level: string }) {
  const map: Record<string, string> = {
    Critical: "bg-red-500/15 text-red-400 border-red-500/30",
    High: "bg-orange-500/15 text-orange-400 border-orange-500/30",
    Medium: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
    Low: "bg-green-500/15 text-green-400 border-green-500/30",
  };
  return <Badge className={`border text-xs font-semibold ${map[level] ?? "bg-muted text-muted-foreground"}`}>{level}</Badge>;
}

function TrendIcon({ trend }: { trend: string }) {
  if (trend === "Worsening") return <TrendingUp className="w-3.5 h-3.5 text-red-400" />;
  if (trend === "Improving") return <TrendingDown className="w-3.5 h-3.5 text-green-400" />;
  return <Minus className="w-3.5 h-3.5 text-muted-foreground" />;
}

function RiskScoreBar({ score, level }: { score: number; level: string }) {
  const colors: Record<string, string> = {
    Critical: "bg-red-500",
    High: "bg-orange-500",
    Medium: "bg-yellow-500",
    Low: "bg-green-500",
  };
  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${colors[level] ?? "bg-indigo-500"}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-xs font-bold text-foreground w-8 text-right">{score}</span>
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

export default function ServiceRiskRanking() {
  const { toast } = useToast();
  const [result, setResult] = useState<any>(null);

  const { data: health } = useQuery<any>({ queryKey: ["/api/ai/health"], retry: false });

  const mutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/ai/service-risk-ranking"),
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
              <h1 className="text-2xl font-bold text-foreground">AI Service Risk Rankings</h1>
              <Badge className="bg-amber-500/10 text-amber-400 border border-amber-500/20">AI Module</Badge>
              {health?.ok !== undefined && (
                health.ok
                  ? <Badge className="bg-green-500/10 text-green-400 border border-green-500/20 text-xs">Ollama connected</Badge>
                  : <Badge className="bg-red-500/10 text-red-400 border border-red-500/20 text-xs">Ollama offline</Badge>
              )}
            </div>
            <p className="text-muted-foreground text-sm">
              Services ranked by composite risk score — combining incident history, alert frequency, error rates and trend analysis.
            </p>
          </div>
          <Button
            data-testid="button-run-risk-ranking"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            className="bg-amber-600 hover:bg-amber-700 text-white"
          >
            {mutation.isPending
              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Ranking…</>
              : result
                ? <><RefreshCw className="w-4 h-4 mr-2" /> Re-rank Services</>
                : <><Play className="w-4 h-4 mr-2" /> Rank Services by Risk</>
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
          <div className="space-y-3">
            {[0,1,2,3,4].map(i => <Skeleton key={i} className="h-24" />)}
          </div>
        )}

        {result && !mutation.isPending && (
          <div className="space-y-5">
            {/* Summary */}
            <Card className="border border-amber-500/20 bg-amber-500/5">
              <CardContent className="p-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-foreground flex-1">{result.summary}</p>
                <div className="flex items-center gap-2">
                  <div className="w-20 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-amber-500 rounded-full" style={{ width: `${Math.round((result.confidence ?? 0) * 100)}%` }} />
                  </div>
                  <span className="text-xs font-bold text-amber-400">{Math.round((result.confidence ?? 0) * 100)}% confidence</span>
                </div>
              </CardContent>
            </Card>

            {/* Rankings */}
            {result.rankings?.length > 0 && (
              <div>
                <h2 className="text-base font-semibold text-foreground mb-3 flex items-center gap-2">
                  <Trophy className="w-4 h-4 text-amber-400" /> Risk Rankings
                </h2>
                <div className="space-y-3">
                  {result.rankings.map((item: any) => (
                    <Card
                      key={item.rank}
                      data-testid={`risk-rank-${item.rank}`}
                      className={`border ${item.riskLevel === "Critical" ? "border-red-500/30" : item.riskLevel === "High" ? "border-orange-500/30" : "border-border"}`}
                    >
                      <CardContent className="p-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="flex items-start gap-3 flex-1 min-w-0">
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0
                              ${item.riskLevel === "Critical" ? "bg-red-500/20 text-red-400"
                                : item.riskLevel === "High" ? "bg-orange-500/20 text-orange-400"
                                : item.riskLevel === "Medium" ? "bg-yellow-500/20 text-yellow-400"
                                : "bg-green-500/20 text-green-400"
                              }`}>
                              {item.rank}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2 mb-1">
                                <p className="text-sm font-semibold text-foreground">{item.service}</p>
                                <RiskBadge level={item.riskLevel} />
                                <span className="text-xs text-muted-foreground flex items-center gap-1">
                                  <TrendIcon trend={item.trend} />
                                  {item.trend}
                                </span>
                              </div>
                              <p className="text-xs text-muted-foreground mb-2">{item.reasoning}</p>
                              <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                                <span className="flex items-center gap-1">
                                  <span className="text-red-400 font-semibold">{item.incidents}</span> incidents
                                </span>
                                <span className="flex items-center gap-1">
                                  <span className="text-yellow-400 font-semibold">{item.alerts}</span> alerts
                                </span>
                                <span className="flex items-center gap-1">
                                  <span className="text-orange-400 font-semibold">{item.errors}</span> errors
                                </span>
                              </div>
                              {item.topFactors?.length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-2">
                                  {item.topFactors.map((f: string, fi: number) => (
                                    <span key={fi} className="text-xs bg-muted/40 border border-border rounded px-1.5 py-0.5 text-muted-foreground">{f}</span>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="shrink-0">
                            <RiskScoreBar score={item.riskScore} level={item.riskLevel} />
                          </div>
                        </div>
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
              <div className="w-16 h-16 rounded-full bg-amber-500/10 flex items-center justify-center">
                <Trophy className="w-8 h-8 text-amber-400" />
              </div>
              <div>
                <p className="font-semibold text-foreground mb-1">No risk rankings yet</p>
                <p className="text-sm text-muted-foreground max-w-sm">
                  Click "Rank Services by Risk" to get a comprehensive risk score for every service in your APM environment.
                </p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </AppLayout>
  );
}
