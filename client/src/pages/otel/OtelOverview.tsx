import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { 
  Layers, GitBranch, Database, Cpu, Shield, TrendingDown, 
  ArrowRight, CheckCircle2, Globe, Zap 
} from "lucide-react";

const benefits = [
  { icon: <TrendingDown className="w-5 h-5" />, title: "Lower TCO", desc: "30–40% reduction in observability spend through intelligent sampling and vendor-neutral open standards.", stat: "38% avg savings" },
  { icon: <Shield className="w-5 h-5" />, title: "No Vendor Lock-in", desc: "Switch APM backends at any time without re-instrumenting. Your telemetry stays yours.", stat: "100% portable" },
  { icon: <Zap className="w-5 h-5" />, title: "AI-Ready Foundation", desc: "Standardized semantic conventions enable ML models to correlate signals across services automatically.", stat: "AI-native format" },
  { icon: <Globe className="w-5 h-5" />, title: "Standardized Telemetry", desc: "One SDK per language covers Metrics, Traces, and Logs — reducing developer overhead and drift.", stat: "CNCF standard" },
];

const pipelineStages = [
  { icon: <Cpu className="w-4 h-4" />, label: "Microservices", sub: "OTLP SDK instrumented", color: "bg-blue-500/10 border-blue-500/30 text-blue-400" },
  { icon: <Layers className="w-4 h-4" />, label: "OTEL Collector", sub: "Receive · Process · Export", color: "bg-purple-500/10 border-purple-500/30 text-purple-400" },
  { icon: <GitBranch className="w-4 h-4" />, label: "Processors", sub: "Batch · Sample · Enrich", color: "bg-amber-500/10 border-amber-500/30 text-amber-400" },
  { icon: <Database className="w-4 h-4" />, label: "Exporters", sub: "APM · OSS · Data Lake", color: "bg-green-500/10 border-green-500/30 text-green-400" },
];

export default function OtelOverview() {
  return (
    <AppLayout>
      <div className="space-y-8 max-w-5xl">
        {/* Hero */}
        <div className="rounded-xl bg-gradient-to-br from-indigo-950 via-slate-900 to-slate-900 border border-indigo-500/20 p-8 text-white">
          <div className="flex flex-wrap items-start gap-4 mb-6">
            <Badge className="bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 px-3 py-1">CNCF Graduated Project</Badge>
            <Badge className="bg-green-500/20 text-green-300 border border-green-500/30 px-3 py-1">Vendor Neutral</Badge>
          </div>
          <h1 className="text-4xl font-bold tracking-tight mb-4">OpenTelemetry</h1>
          <p className="text-slate-300 text-lg max-w-2xl leading-relaxed mb-6">
            The industry standard for vendor-neutral, open-source observability. A single instrumentation layer providing unified Metrics, Traces, and Logs across every service in your stack — enabling AI-driven insights without vendor lock-in.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link href="/otel/flow">
              <Button className="bg-indigo-600 text-white">
                View Telemetry Flow <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </Link>
            <Link href="/ai/insights">
              <Button variant="outline" className="border-white/20 text-white">
                AI Insights
              </Button>
            </Link>
          </div>
        </div>

        {/* Architecture Diagram */}
        <Card className="border border-border shadow-sm">
          <CardHeader>
            <CardTitle className="text-base font-semibold">Architecture Overview</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-2 justify-center">
              {pipelineStages.map((stage, i) => (
                <div key={stage.label} className="flex items-center gap-2">
                  <div className={`flex flex-col items-center rounded-lg border px-5 py-4 min-w-[130px] ${stage.color}`}>
                    <div className="mb-2">{stage.icon}</div>
                    <span className="font-semibold text-sm text-center">{stage.label}</span>
                    <span className="text-xs opacity-70 text-center mt-1">{stage.sub}</span>
                  </div>
                  {i < pipelineStages.length - 1 && (
                    <ArrowRight className="w-5 h-5 text-muted-foreground shrink-0" />
                  )}
                </div>
              ))}
            </div>

            {/* Backends */}
            <div className="mt-6 pt-5 border-t border-border">
              <p className="text-xs text-muted-foreground text-center mb-3 font-medium uppercase tracking-wide">Backend Destinations</p>
              <div className="flex flex-wrap justify-center gap-3">
                {[
                  { label: "AppDynamics APM", color: "bg-indigo-500/10 border-indigo-500/30 text-indigo-400" },
                  { label: "Prometheus / Jaeger", color: "bg-green-500/10 border-green-500/30 text-green-400" },
                  { label: "Data Lake (S3/Snowflake)", color: "bg-amber-500/10 border-amber-500/30 text-amber-400" },
                ].map(b => (
                  <span key={b.label} className={`px-4 py-2 rounded-lg border text-sm font-medium ${b.color}`}>{b.label}</span>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Business Benefits */}
        <div>
          <h2 className="text-xl font-bold text-foreground mb-4">Business Benefits</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {benefits.map(b => (
              <Card key={b.title} className="border border-border shadow-sm hover-elevate">
                <CardContent className="p-6">
                  <div className="flex items-start gap-4">
                    <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">{b.icon}</div>
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-semibold text-foreground">{b.title}</h3>
                        <Badge variant="secondary" className="text-xs">{b.stat}</Badge>
                      </div>
                      <p className="text-sm text-muted-foreground leading-relaxed">{b.desc}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>

        {/* What OTel collects */}
        <div>
          <h2 className="text-xl font-bold text-foreground mb-4">Telemetry Signals</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              { signal: "Metrics", desc: "Numeric measurements over time. CPU, memory, latency percentiles, throughput, error rates.", color: "border-blue-500/30 bg-blue-500/5" },
              { signal: "Traces", desc: "Distributed request flows across services. Spans, context propagation, latency breakdown.", color: "border-green-500/30 bg-green-500/5" },
              { signal: "Logs", desc: "Structured event records from services. Correlated with traces via Trace ID linkage.", color: "border-amber-500/30 bg-amber-500/5" }
            ].map(s => (
              <Card key={s.signal} className={`border ${s.color} shadow-sm`}>
                <CardContent className="p-5">
                  <div className="flex items-center gap-2 mb-3">
                    <CheckCircle2 className="w-4 h-4 text-green-500" />
                    <h3 className="font-bold text-foreground">{s.signal}</h3>
                  </div>
                  <p className="text-sm text-muted-foreground">{s.desc}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
