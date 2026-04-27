import { Link } from "wouter";
import { BrainCircuit, ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Evidence {
  type: string;
  detail: string;
  score: number;
}
interface Suggestion {
  label: string;
  href: string;
}
interface AICorrelation {
  summary: string;
  confidence: number;
  strength: number;
  evidence: Evidence[];
  suggestions: Suggestion[];
}

interface Props {
  data?: AICorrelation;
  title?: string;
  size?: "default" | "large";
}

export function AICorrelationPanel({ data, title = "AI Correlation Insights", size = "default" }: Props) {
  if (!data) return null;
  const isLarge = size === "large";

  return (
    <Card data-testid="ai-correlation-panel" className="border border-indigo-500/30 bg-card shadow-sm">
      <CardHeader className="pb-3 border-b border-border">
        <CardTitle className={`${isLarge ? "text-base" : "text-sm"} font-semibold text-foreground flex items-center gap-2`}>
          <BrainCircuit className={`${isLarge ? "w-5 h-5" : "w-4 h-4"} text-indigo-400`} />
          {title}
          <div className="ml-auto flex items-center gap-2">
            <div className={`flex items-center gap-1 ${isLarge ? "text-xs" : "text-[10px]"} font-semibold bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 px-2 py-0.5 rounded`}>
              Strength: {data.strength}%
            </div>
            <div className={`flex items-center gap-1 ${isLarge ? "text-xs" : "text-[10px]"} font-semibold bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 px-2 py-0.5 rounded`}>
              {Math.round(data.confidence * 100)}% confidence
            </div>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 space-y-4">
        {/* Summary */}
        <p className={`${isLarge ? "text-base" : "text-sm"} text-foreground leading-relaxed`}>{data.summary}</p>

        {/* Correlation Strength Bar */}
        <div>
          <div className="flex justify-between mb-1">
            <p className={`${isLarge ? "text-xs" : "text-[10px]"} text-muted-foreground`}>Correlation Strength</p>
            <p className={`${isLarge ? "text-xs" : "text-[10px]"} font-bold text-indigo-400`}>{data.strength}%</p>
          </div>
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div className="h-full rounded-full bg-gradient-to-r from-indigo-600 to-purple-500" style={{ width: `${data.strength}%` }} />
          </div>
        </div>

        {/* Evidence */}
        <div className="space-y-2">
          <p className={`${isLarge ? "text-xs" : "text-[10px]"} font-semibold text-muted-foreground uppercase tracking-wide`}>Evidence</p>
          {data.evidence.map((e, i) => (
            <div key={i} className="flex items-start gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-0.5">
                  <p className={`${isLarge ? "text-xs" : "text-[10px]"} font-bold text-indigo-400`}>{e.type}</p>
                  <span className={`${isLarge ? "text-[10px]" : "text-[9px]"} text-muted-foreground`}>score: {Math.round(e.score * 100)}%</span>
                </div>
                <p className={`${isLarge ? "text-sm" : "text-[11px]"} text-foreground`}>{e.detail}</p>
              </div>
              <div className={`shrink-0 ${isLarge ? "w-9 h-9 text-xs" : "w-8 h-8 text-[10px]"} rounded-lg flex items-center justify-center font-bold bg-indigo-500/10 border border-indigo-500/20 text-indigo-400`}>
                {Math.round(e.score * 100)}
              </div>
            </div>
          ))}
        </div>

        {/* Quick Navigation Suggestions */}
        <div>
          <p className={`${isLarge ? "text-xs" : "text-[10px]"} font-semibold text-muted-foreground uppercase tracking-wide mb-2`}>You may also want to review:</p>
          <div className="flex flex-wrap gap-2">
            {data.suggestions.map((s, i) => (
              <Link
                key={i}
                href={s.href}
                data-testid={`ai-suggestion-${i}`}
                className={`flex items-center gap-1.5 ${isLarge ? "text-sm" : "text-xs"} px-3 py-1.5 rounded-lg border border-indigo-500/30 bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 transition-colors`}
              >
                <ExternalLink className="w-3 h-3" />
                {s.label}
              </Link>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
