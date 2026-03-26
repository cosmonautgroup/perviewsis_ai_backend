import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { TrendingUp, AlertTriangle, Clock, Shield, ChevronRight, ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const SEV_STYLES: Record<string, string> = {
  Critical: "bg-red-500/15 text-red-400 border border-red-500/30",
  High:     "bg-orange-500/15 text-orange-400 border border-orange-500/30",
  Medium:   "bg-yellow-500/15 text-yellow-400 border border-yellow-500/30",
  Low:      "bg-green-500/15 text-green-400 border border-green-500/30",
};

const RISK_COLOR = (v: number) =>
  v >= 90 ? "#ef4444" : v >= 70 ? "#f97316" : v >= 45 ? "#eab308" : "#22c55e";

interface Props {
  entityType: "incident" | "alert" | "error";
  entityId: string;
}

export default function CapacityRiskBacklinks({ entityType, entityId }: Props) {
  const { data: risks, isLoading } = useQuery<any[]>({
    queryKey: ["/api/capacity-planning/entity-risks", entityType, entityId],
    queryFn: async () => {
      const res = await fetch(`/api/capacity-planning/entity-risks?type=${entityType}&id=${entityId}`);
      return res.json();
    },
  });

  if (isLoading || !risks?.length) return null;

  return (
    <Card className="border border-indigo-500/30 bg-card shadow-sm" data-testid="capacity-risk-backlinks">
      <CardHeader className="pb-3 border-b border-border">
        <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-indigo-400" />
          Capacity Risks Affecting This {entityType.charAt(0).toUpperCase() + entityType.slice(1)}
          <Badge className="text-[10px] py-0 px-1.5 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 ml-1">{risks.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-3 pb-4 space-y-2.5">
        <p className="text-[11px] text-muted-foreground">
          These capacity risks were forecasted in the same time window as this {entityType}. AI correlation confidence: high.
        </p>
        {risks.map((risk: any) => (
          <div key={risk.riskId} className="flex items-center gap-3 p-2.5 rounded-lg bg-muted/20 border border-border hover:border-indigo-500/30 transition-colors group" data-testid={`backlink-risk-${risk.riskId}`}>
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" style={{ color: RISK_COLOR(risk.riskScore) }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-medium text-foreground truncate">{risk.name}</span>
                <Badge className={`text-[10px] py-0 px-1.5 ${SEV_STYLES[risk.severity] ?? SEV_STYLES.Medium}`}>{risk.severity}</Badge>
              </div>
              <div className="flex items-center gap-4 mt-0.5 text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1"><Clock className="w-2.5 h-2.5" />Saturation in {risk.hoursToSaturation}h</span>
                <span className="flex items-center gap-1"><Shield className="w-2.5 h-2.5 text-indigo-400" />{Math.round(risk.confidence * 100)}% confidence</span>
                <span className="font-bold" style={{ color: RISK_COLOR(risk.riskScore) }}>Score {risk.riskScore}</span>
              </div>
            </div>
            <Link href={`/capacity-planning/detail/${risk.riskId}`}>
              <button
                className="flex items-center gap-1 text-[10px] font-semibold text-indigo-400 hover:text-indigo-300 border border-indigo-500/30 rounded px-2 py-1 bg-indigo-500/10 hover:bg-indigo-500/20 transition-colors shrink-0 whitespace-nowrap"
                data-testid={`btn-view-capacity-risk-${risk.riskId}`}
              >
                View Capacity <ChevronRight className="w-3 h-3" />
              </button>
            </Link>
          </div>
        ))}
        <div className="pt-1">
          <Link href="/capacity-planning">
            <span className="text-xs text-indigo-400 hover:text-indigo-300 cursor-pointer flex items-center gap-1 transition-colors" data-testid="link-all-capacity-risks">
              View all capacity risks <ArrowRight className="w-3 h-3" />
            </span>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
