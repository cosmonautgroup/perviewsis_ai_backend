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
  SearchCode, AlertTriangle, CheckCircle2, Play, Loader2, WifiOff,
  RefreshCw, Clock, Shield,
} from "lucide-react";

function PriorityBadge({ p }: { p: string }) {
  const map: Record<string, string> = {
    high: "bg-red-500/10 text-red-400 border-red-500/20",
    medium: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    low: "bg-green-500/10 text-green-400 border-green-500/20",
  };
  return <Badge className={`border text-xs capitalize ${map[p] ?? "bg-muted text-muted-foreground"}`}>{p}</Badge>;
}

function SeverityBadge({ s }: { s: string }) {
  const map: Record<string, string> = {
    Critical: "bg-red-500/10 text-red-400 border-red-500/20",
    High: "bg-orange-500/10 text-orange-400 border-orange-500/20",
    Medium: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    Low: "bg-green-500/10 text-green-400 border-green-500/20",
  };
  return <Badge className={`border text-xs ${map[s] ?? "bg-muted text-muted-foreground"}`}>{s}</Badge>;
}

export default function RootCause() {
  const { toast } = useToast();
  const [result, setResult] = useState<any>(null);
  const [incidentContext, setIncidentContext] = useState("");

  const { data: health } = useQuery<any>({ queryKey: ["/api/ai/health"], retry: false });

  const mutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/ai/root-cause", {
        incidentContext: incidentContext.trim() ? incidentContext : undefined,
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
              <h1 className="text-2xl font-bold text-foreground">AI Root Cause Analysis</h1>
              <Badge className="bg-red-500/10 text-red-400 border border-red-500/20">AI Module</Badge>
              {health?.ok !== undefined && (
                health.ok
                  ? <Badge className="bg-green-500/10 text-green-400 border border-green-500/20 text-xs">Ollama connected</Badge>
                  : <Badge className="bg-red-500/10 text-red-400 border border-red-500/20 text-xs">Ollama offline</Badge>
              )}
            </div>
            <p className="text-muted-foreground text-sm">
              Deep-dive root cause identification with probability scores, impacted service mapping and evidence-backed reasoning.
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

        {/* Optional context input */}
        <Card className="border border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Incident Context (optional)</CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-3">
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">
                Paste incident description, error message, or symptoms to focus the analysis. Leave blank to analyse all recent APM data.
              </Label>
              <Textarea
                data-testid="input-incident-context"
                placeholder="e.g. 'Payment service latency spike at 14:30, p99 response time exceeded 5s, 3 pods OOMKilled in payments namespace'"
                value={incidentContext}
                onChange={(e) => setIncidentContext(e.target.value)}
                rows={3}
                className="text-sm resize-none"
              />
            </div>
            <Button
              data-testid="button-run-rca"
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {mutation.isPending
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Analysing…</>
                : result
                  ? <><RefreshCw className="w-4 h-4 mr-2" /> Re-run Analysis</>
                  : <><Play className="w-4 h-4 mr-2" /> Run Root Cause Analysis</>
              }
            </Button>
          </CardContent>
        </Card>

        {mutation.isPending && (
          <div className="space-y-4">
            <Skeleton className="h-24" />
            <Skeleton className="h-48" />
            <Skeleton className="h-32" />
          </div>
        )}

        {result && !mutation.isPending && (
          <div className="space-y-5">
            {/* Summary */}
            <Card className="border border-red-500/20 bg-red-500/5">
              <CardContent className="p-4 flex flex-wrap items-start justify-between gap-3">
                <p className="text-sm text-foreground flex-1">{result.summary}</p>
                <div className="flex items-center gap-2">
                  <div className="w-20 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-red-500 rounded-full" style={{ width: `${Math.round((result.confidence ?? 0) * 100)}%` }} />
                  </div>
                  <span className="text-xs font-bold text-red-400">{Math.round((result.confidence ?? 0) * 100)}% confidence</span>
                </div>
              </CardContent>
            </Card>

            {/* Root Cause Details */}
            {result.rootCauseDetails && (
              <Card className="border border-border">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2"><SearchCode className="w-4 h-4 text-red-400" /> Root Cause Details</CardTitle>
                </CardHeader>
                <CardContent className="pt-0 space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="rounded-lg bg-muted/20 border border-border p-3">
                      <p className="text-xs font-semibold text-muted-foreground mb-1">Description</p>
                      <p className="text-sm text-foreground">{result.rootCauseDetails.description}</p>
                    </div>
                    <div className="rounded-lg bg-muted/20 border border-border p-3">
                      <p className="text-xs font-semibold text-muted-foreground mb-1">Probable Cause</p>
                      <p className="text-sm text-foreground">{result.rootCauseDetails.probableCause}</p>
                    </div>
                  </div>
                  {result.rootCauseDetails.evidencePoints?.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-muted-foreground mb-2">Evidence Points</p>
                      <ul className="space-y-1">
                        {result.rootCauseDetails.evidencePoints.map((e: string, i: number) => (
                          <li key={i} className="flex items-start gap-2 text-sm text-foreground">
                            <span className="text-indigo-400 mt-0.5 shrink-0">•</span>{e}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <Shield className="w-4 h-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Probability score:</span>
                    <span className="text-sm font-bold text-red-400">{result.rootCauseDetails.probabilityScore}%</span>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Impacted Services */}
            {result.impactedServices?.length > 0 && (
              <Card className="border border-border">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-orange-400" /> Impacted Services</CardTitle>
                </CardHeader>
                <CardContent className="pt-0 space-y-2">
                  {result.impactedServices.map((svc: any, i: number) => (
                    <div key={i} className="flex items-center justify-between py-1.5 border-b border-border last:border-0 gap-2">
                      <span className="text-sm text-foreground font-medium">{svc.name}</span>
                      <div className="flex items-center gap-2">
                        {svc.affectedSince && <span className="text-xs text-muted-foreground">{svc.affectedSince}</span>}
                        <SeverityBadge s={svc.severity} />
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Timeline */}
            {result.timeline?.length > 0 && (
              <Card className="border border-border">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2"><Clock className="w-4 h-4 text-blue-400" /> Incident Timeline</CardTitle>
                </CardHeader>
                <CardContent className="pt-0 space-y-2">
                  {result.timeline.map((item: any, i: number) => (
                    <div key={i} className="flex items-start gap-3 py-1.5 border-b border-border last:border-0">
                      <span className="text-xs text-muted-foreground font-mono shrink-0 mt-0.5 w-16">{item.time}</span>
                      <span className="text-sm text-foreground flex-1">{item.event}</span>
                      <SeverityBadge s={item.severity} />
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
              <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center">
                <SearchCode className="w-8 h-8 text-red-400" />
              </div>
              <div>
                <p className="font-semibold text-foreground mb-1">Ready to investigate</p>
                <p className="text-sm text-muted-foreground max-w-sm">
                  Optionally paste an incident description above, then click "Run Root Cause Analysis" to identify root causes using your live APM data.
                </p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </AppLayout>
  );
}
