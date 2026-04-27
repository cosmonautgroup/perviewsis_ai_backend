import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ShieldAlert, Bell, Flame, Server, Activity, Package, Loader2 } from "lucide-react";

interface Props {
  entityId: string;
  entityType: "incident" | "alert" | "error" | "node" | "transaction";
  applicationId?: string | number | null;
  sourceIncidentId?: string | null;
  entityLabel?: string;
}
const TYPE_META: Record<string, { label: string; icon: any; color: string; bg: string }> = {
  incidents: { label: "Incidents", icon: ShieldAlert, color: "text-red-400", bg: "bg-red-500/10 border-red-500/20 hover:bg-red-500/15" },
  alerts:    { label: "Alerts",    icon: Bell,        color: "text-amber-400", bg: "bg-amber-500/10 border-amber-500/20 hover:bg-amber-500/15" },
  errors:    { label: "Errors",    icon: Flame,       color: "text-orange-400", bg: "bg-orange-500/10 border-orange-500/20 hover:bg-orange-500/15" },
  nodes:     { label: "Nodes",     icon: Server,      color: "text-blue-400",  bg: "bg-blue-500/10 border-blue-500/20 hover:bg-blue-500/15" },
  transactions: { label: "Transactions", icon: Activity, color: "text-green-400", bg: "bg-green-500/10 border-green-500/20 hover:bg-green-500/15" },
  deployments: { label: "Deployments", icon: Package,  color: "text-purple-400", bg: "bg-purple-500/10 border-purple-500/20 hover:bg-purple-500/15" },
};

function targetHref(key: string, applicationId?: string | number | null, incidentId?: string | null) {
  const appId = applicationId != null && String(applicationId).trim() !== "" ? String(applicationId) : null;
  if (key === "incidents") return appId ? `/applications/${appId}/incidents` : "/incidents";
  if (key === "alerts") {
    if (incidentId) return appId
      ? `/alerts?incidentId=${encodeURIComponent(incidentId)}&appId=${encodeURIComponent(appId)}`
      : `/alerts?incidentId=${encodeURIComponent(incidentId)}`;
    return appId ? `/alerts?appId=${encodeURIComponent(appId)}` : "/alerts";
  }
  if (key === "errors") return incidentId ? `/errors?incidentId=${encodeURIComponent(incidentId)}` : (appId ? `/errors?appId=${encodeURIComponent(appId)}` : "/errors");
  if (key === "nodes") return appId ? `/applications/${appId}/servers${incidentId ? `?incidentId=${encodeURIComponent(incidentId)}` : ""}` : "/applications";
  return "#";
}

export function CorrelationContextBar({ entityId, entityType, applicationId, sourceIncidentId, entityLabel }: Props) {
  const { data: graph, isLoading } = useQuery<any>({
    queryKey: ["/api/correlation/graph", entityId, entityType],
    queryFn: () => fetch(`/api/correlation/graph?entityId=${entityId}&type=${entityType}`).then(r => r.json()),
    staleTime: 60000,
  });

  const derivedSummary = Array.isArray(graph?.nodes)
    ? (graph.nodes as any[]).reduce((acc: Record<string, number>, n: any) => {
        const key = n?.type === "incident"
          ? "incidents"
          : n?.type === "alert"
            ? "alerts"
            : n?.type === "error"
              ? "errors"
              : n?.type === "node"
                ? "nodes"
                : n?.type === "transaction"
                  ? "transactions"
                  : n?.type === "deployment"
                    ? "deployments"
                    : null;
        if (key) acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {})
    : {};
  const summary = graph?.summary ?? derivedSummary;
  const items = Object.entries(TYPE_META).filter(([key]) => {
    const count = summary[key as keyof typeof summary];
    return typeof count === "number" && count > 0 && !(key === entityType + "s");
  });
  const effectiveIncidentId = sourceIncidentId ?? (entityType === "incident" ? entityId : null);

  if (isLoading) {
    return (
      <div data-testid="correlation-context-bar" className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-border bg-muted/20 text-xs text-muted-foreground">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span>Loading correlations…</span>
      </div>
    );
  }

  return (
    <div data-testid="correlation-context-bar" className="flex flex-wrap items-center gap-2 px-4 py-2.5 rounded-xl border border-border bg-muted/10">
      <div className="flex items-center gap-1.5 mr-2">
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Related:</span>
      </div>
      {items.map(([key, meta]) => {
        const count = summary[key as keyof typeof summary] as number;
        const Icon = meta.icon;
        return (
          <Link
            key={key}
            href={targetHref(key, applicationId, effectiveIncidentId)}
            data-testid={`corr-link-${key}`}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-lg border text-xs font-semibold transition-colors ${meta.bg} ${meta.color}`}
          >
            <Icon className="w-3 h-3" />
            {count} {meta.label}
          </Link>
        );
      })}
      {items.length === 0 && (
        <span className="text-xs text-muted-foreground">No correlated entities found</span>
      )}
    </div>
  );
}
