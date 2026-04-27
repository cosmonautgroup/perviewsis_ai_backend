import { Link, useParams } from "wouter";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useApplication, useTransactions } from "@/hooks/use-applications";
import { ArrowLeft, BrainCircuit, CheckCircle2, TriangleAlert } from "lucide-react";

function RiskTone({ score }: { score: number }) {
  if (score >= 75) return <Badge className="bg-red-500/10 text-red-400 border border-red-500/20">Critical</Badge>;
  if (score >= 45) return <Badge className="bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">Warning</Badge>;
  return <Badge className="bg-green-500/10 text-green-400 border border-green-500/20">Healthy</Badge>;
}

export default function ServiceRiskDrilldown() {
  const { id, service } = useParams<{ id: string; service: string }>();
  const appId = parseInt(id || "0", 10);
  const serviceName = decodeURIComponent(String(service ?? "")).trim();

  const metricOpts = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const durationMins = Number(params.get("durationMins") ?? "");
    const start = params.get("start");
    const end = params.get("end");
    if (Number.isFinite(durationMins) && durationMins > 0) return { durationMins };
    if (start && end) return { start, end };
    return { durationMins: 24 * 60 };
  }, []);

  const { data: app, isLoading: appLoading } = useApplication(appId);
  const { data: serviceRisks, isLoading: risksLoading } = useQuery<any[]>({
    queryKey: [`/api/applications/${appId}/service-risks`],
    enabled: !!appId,
  });
  const { data: transactions } = useTransactions(appId, metricOpts);

  const risk = useMemo(
    () => (serviceRisks ?? []).find((row) => String(row?.service ?? "").toLowerCase() === serviceName.toLowerCase()),
    [serviceRisks, serviceName],
  );
  const relatedTx = useMemo(
    () => (transactions ?? []).find((tx) => String(tx?.name ?? "").toLowerCase() === serviceName.toLowerCase()),
    [transactions, serviceName],
  );

  if (appLoading || risksLoading) {
    return (
      <AppLayout appId={appId}>
        <Skeleton className="h-64 w-full" />
      </AppLayout>
    );
  }

  if (!app) return <AppLayout>Application not found</AppLayout>;

  return (
    <AppLayout appId={appId}>
      <div className="space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-2xl font-bold text-foreground tracking-tight">{serviceName || "Service Risk Drilldown"}</h1>
              <Badge variant="secondary" className="text-xs">Application: {app.name}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">AI service risk breakdown with related business transaction context.</p>
          </div>
          <Button size="sm" variant="outline" asChild>
            <Link href={`/applications/${appId}`}>
              <ArrowLeft className="w-3.5 h-3.5 mr-1" /> Back to Application
            </Link>
          </Button>
        </div>

        {!risk ? (
          <Card className="border border-border">
            <CardContent className="p-6 text-sm text-muted-foreground">
              No risk data found for this service in the current snapshot.
            </CardContent>
          </Card>
        ) : (
          <>
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-3 border-b border-border">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <BrainCircuit className="w-4 h-4 text-indigo-400" /> AI Risk Summary
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                  <div className="rounded-lg border border-border bg-muted/20 p-3">
                    <p className="text-[11px] text-muted-foreground mb-1">Risk Score</p>
                    <p className="text-xl font-bold text-foreground">{risk.riskScore}</p>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/20 p-3">
                    <p className="text-[11px] text-muted-foreground mb-1">Trend</p>
                    <p className="text-sm font-semibold text-foreground capitalize">{risk.trend}</p>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/20 p-3">
                    <p className="text-[11px] text-muted-foreground mb-1">Failure Probability</p>
                    <p className="text-sm font-semibold text-foreground">{risk.failureProbability}%</p>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/20 p-3">
                    <p className="text-[11px] text-muted-foreground mb-1">Confidence</p>
                    <p className="text-sm font-semibold text-foreground">{risk.confidence}%</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <RiskTone score={Number(risk.riskScore ?? 0)} />
                  {risk.tier && <Badge variant="secondary" className="text-xs">{risk.tier}</Badge>}
                  {risk.expectedFailureDate && (
                    <Badge className="bg-red-500/10 text-red-400 border border-red-500/20 text-xs">
                      Expected failure: {new Date(risk.expectedFailureDate).toLocaleDateString()}
                    </Badge>
                  )}
                </div>
                <div className="rounded-lg border border-border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground mb-1">Hypothesis</p>
                  <p className="text-sm text-foreground">{risk.hypothesis}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-foreground mb-2">Recommendations</p>
                  <div className="space-y-2">
                    {(risk.recommendations ?? []).map((item: string) => (
                      <div key={item} className="flex items-start gap-2 rounded-lg border border-border bg-muted/20 p-2.5">
                        <CheckCircle2 className="w-3.5 h-3.5 text-green-500 mt-0.5 shrink-0" />
                        <p className="text-xs text-foreground">{item}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-3 border-b border-border">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <TriangleAlert className="w-4 h-4 text-amber-400" /> Related Business Transaction
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4">
                {!relatedTx ? (
                  <p className="text-sm text-muted-foreground">No matching business transaction found for this service in the selected time window.</p>
                ) : (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="rounded-lg border border-border bg-muted/20 p-3">
                        <p className="text-[11px] text-muted-foreground mb-1">Avg Response</p>
                        <p className="text-sm font-semibold text-foreground">{Number(relatedTx.avgResponseTime ?? 0).toFixed(0)} ms</p>
                      </div>
                      <div className="rounded-lg border border-border bg-muted/20 p-3">
                        <p className="text-[11px] text-muted-foreground mb-1">Calls/min</p>
                        <p className="text-sm font-semibold text-foreground">{Number(relatedTx.callsPerMinute ?? 0).toFixed(2)}</p>
                      </div>
                      <div className="rounded-lg border border-border bg-muted/20 p-3">
                        <p className="text-[11px] text-muted-foreground mb-1">Error Rate</p>
                        <p className="text-sm font-semibold text-foreground">{Number(relatedTx.errorRate ?? 0).toFixed(2)}%</p>
                      </div>
                    </div>
                    <Button size="sm" variant="outline" asChild>
                      <Link href={`/applications/${appId}/transactions/${relatedTx.id}`}>Open Business Transaction Drilldown</Link>
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </AppLayout>
  );
}
