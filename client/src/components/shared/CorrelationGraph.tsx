import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Loader2, GitBranch } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  entityId: string;
  entityType: string;
}

const NODE_COLORS: Record<string, { fill: string; stroke: string; text: string }> = {
  incident:    { fill: "#7f1d1d", stroke: "#ef4444", text: "#fca5a5" },
  alert:       { fill: "#78350f", stroke: "#f59e0b", text: "#fde68a" },
  error:       { fill: "#7c2d12", stroke: "#f97316", text: "#fed7aa" },
  node:        { fill: "#1e3a5f", stroke: "#3b82f6", text: "#93c5fd" },
  transaction: { fill: "#14532d", stroke: "#22c55e", text: "#86efac" },
  deployment:  { fill: "#3b0764", stroke: "#a855f7", text: "#d8b4fe" },
};

const LAYOUT: Record<string, { positions: { x: number; y: number }[] }> = {
  ring: { positions: [] },
};

function getPositions(count: number, cx: number, cy: number, r: number) {
  return Array.from({ length: count }).map((_, i) => ({
    x: cx + r * Math.cos((2 * Math.PI * i) / count - Math.PI / 2),
    y: cy + r * Math.sin((2 * Math.PI * i) / count - Math.PI / 2),
  }));
}

export function CorrelationGraph({ entityId, entityType }: Props) {
  const [, navigate] = useLocation();
  const [hovered, setHovered] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const { data: graph, isLoading } = useQuery<any>({
    queryKey: ["/api/correlation/graph", entityId, entityType],
    queryFn: () => fetch(`/api/correlation/graph?entityId=${entityId}&type=${entityType}`).then(r => r.json()),
    staleTime: 60000,
  });

  if (!expanded) {
    return (
      <button
        data-testid="show-correlation-graph"
        onClick={() => setExpanded(true)}
        className="flex items-center gap-2 text-xs text-indigo-400 hover:text-indigo-300 border border-indigo-500/20 bg-indigo-500/5 px-3 py-2 rounded-lg transition-colors"
      >
        <GitBranch className="w-3.5 h-3.5" />
        Show Correlation Graph
      </button>
    );
  }

  return (
    <Card className="border border-border shadow-sm" data-testid="correlation-graph-panel">
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-indigo-400" /> Correlation Graph
          <span className="text-[10px] text-muted-foreground font-normal">Click any node to navigate</span>
        </CardTitle>
        <button onClick={() => setExpanded(false)} className="text-xs text-muted-foreground hover:text-foreground">Hide</button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center h-64 gap-2 text-muted-foreground text-sm">
            <Loader2 className="w-4 h-4 animate-spin" /> Building graph…
          </div>
        ) : (
          <GraphSVG graph={graph} entityId={entityId} hovered={hovered} setHovered={setHovered} navigate={navigate} />
        )}

        {/* Legend */}
        <div className="flex flex-wrap gap-3 mt-3 pt-3 border-t border-border">
          {Object.entries(NODE_COLORS).map(([type, c]) => (
            <div key={type} className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-full border-2" style={{ background: c.fill, borderColor: c.stroke }} />
              <span className="text-[10px] text-muted-foreground capitalize">{type}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function GraphSVG({ graph, entityId, hovered, setHovered, navigate }: any) {
  const nodes: any[] = graph?.nodes ?? [];
  const edges: any[] = graph?.edges ?? [];

  const W = 760, H = 340, CX = W / 2, CY = H / 2;
  const currentNode = nodes.find(n => n.isCurrent || n.id === entityId);
  const otherNodes = nodes.filter(n => !n.isCurrent && n.id !== entityId);
  const positions = getPositions(otherNodes.length, CX, CY, 140);

  const nodePos: Record<string, { x: number; y: number }> = {};
  if (currentNode) nodePos[currentNode.id] = { x: CX, y: CY };
  otherNodes.forEach((n, i) => { nodePos[n.id] = positions[i] ?? { x: CX + 160, y: CY }; });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 340 }}>
      <defs>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="8" refY="3" orient="auto">
          <path d="M0,0 L0,6 L8,3 z" fill="hsl(var(--muted-foreground))" />
        </marker>
      </defs>

      {/* Edges */}
      {edges.map((e, i) => {
        const from = nodePos[e.from];
        const to = nodePos[e.to];
        if (!from || !to) return null;
        const isHov = hovered === e.from || hovered === e.to;
        return (
          <g key={i}>
            <line
              x1={from.x} y1={from.y} x2={to.x} y2={to.y}
              stroke={isHov ? "#6366f1" : "hsl(var(--muted-foreground))"}
              strokeWidth={isHov ? 2 : 1}
              strokeOpacity={isHov ? 0.8 : 0.3}
              strokeDasharray={e.label === "caused" ? "none" : "4 3"}
              markerEnd="url(#arrow)"
            />
            <text
              x={(from.x + to.x) / 2}
              y={(from.y + to.y) / 2 - 5}
              fontSize={9}
              fill="hsl(var(--muted-foreground))"
              textAnchor="middle"
              opacity={isHov ? 0.9 : 0.4}
            >{e.label}</text>
          </g>
        );
      })}

      {/* Nodes */}
      {nodes.map(n => {
        const pos = nodePos[n.id];
        if (!pos) return null;
        const colors = NODE_COLORS[n.type] ?? NODE_COLORS.incident;
        const isHov = hovered === n.id;
        const isCurrent = n.isCurrent || n.id === entityId;
        const r = isCurrent ? 36 : 28;
        return (
          <g
            key={n.id}
            transform={`translate(${pos.x},${pos.y})`}
            className="cursor-pointer"
            onMouseEnter={() => setHovered(n.id)}
            onMouseLeave={() => setHovered(null)}
            onClick={() => n.href && navigate(n.href)}
            data-testid={`graph-node-${n.id}`}
          >
            <circle
              r={r}
              fill={colors.fill}
              stroke={isCurrent ? "#6366f1" : colors.stroke}
              strokeWidth={isCurrent ? 3 : isHov ? 2.5 : 1.5}
              fillOpacity={0.85}
            />
            {isCurrent && <circle r={r + 6} fill="none" stroke="#6366f1" strokeWidth={1} strokeOpacity={0.4} strokeDasharray="3 3" />}
            <text y={-5} textAnchor="middle" fontSize={isCurrent ? 9 : 8} fontWeight="bold" fill={colors.text}>{n.type.toUpperCase()}</text>
            <text y={7} textAnchor="middle" fontSize={8} fill={colors.text} opacity={0.85}>{n.label.length > 10 ? n.label.slice(0, 10) + "…" : n.label}</text>
            {isHov && n.status && (
              <text y={r + 14} textAnchor="middle" fontSize={8} fill="hsl(var(--muted-foreground))">{n.status}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
