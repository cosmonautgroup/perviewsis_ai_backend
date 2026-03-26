import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ShieldAlert, Bell, Flame, Server, Activity, Package, Loader2 } from "lucide-react";

interface Props {
  entityId: string;
  entityType: "incident" | "alert" | "error" | "node" | "transaction";
  entityLabel?: string;
}

const TYPE_META: Record<string, { label: string; icon: any; color: string; bg: string; href: (id?: string) => string }> = {
  incidents: { label: "Incidents", icon: ShieldAlert, color: "text-red-400", bg: "bg-red-500/10 border-red-500/20 hover:bg-red-500/15", href: () => "/incidents/INC-0042" },
  alerts:    { label: "Alerts",    icon: Bell,        color: "text-amber-400", bg: "bg-amber-500/10 border-amber-500/20 hover:bg-amber-500/15", href: () => "/alerts" },
  errors:    { label: "Errors",    icon: Flame,       color: "text-orange-400", bg: "bg-orange-500/10 border-orange-500/20 hover:bg-orange-500/15", href: () => "/errors" },
  nodes:     { label: "Nodes",     icon: Server,      color: "text-blue-400",  bg: "bg-blue-500/10 border-blue-500/20 hover:bg-blue-500/15",   href: () => "/applications/1/servers" },
  transactions: { label: "Transactions", icon: Activity, color: "text-green-400", bg: "bg-green-500/10 border-green-500/20 hover:bg-green-500/15", href: () => "#" },
  deployments: { label: "Deployments", icon: Package,  color: "text-purple-400", bg: "bg-purple-500/10 border-purple-500/20 hover:bg-purple-500/15", href: () => "#" },
};

export function CorrelationContextBar({ entityId, entityType, entityLabel }: Props) {
  const { data: graph, isLoading } = useQuery<any>({
    queryKey: ["/api/correlation/graph", entityId, entityType],
    queryFn: () => fetch(`/api/correlation/graph?entityId=${entityId}&type=${entityType}`).then(r => r.json()),
    staleTime: 60000,
  });

  const summary = graph?.summary ?? {};
  const items = Object.entries(TYPE_META).filter(([key]) => {
    const count = summary[key as keyof typeof summary];
    return typeof count === "number" && count > 0 && !(key === entityType + "s");
  });

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
            href={meta.href(entityId)}
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
