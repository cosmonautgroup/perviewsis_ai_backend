import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import {
  Activity, ShieldCheck, Zap, Lock, Database, BrainCircuit,
  TrendingUp, AlertTriangle, CheckCircle2, ArrowRight, Server,
  Globe, BarChart2, Clock, Cpu, ChevronRight, Building2
} from "lucide-react";
import { Button } from "@/components/ui/button";

const FEATURES = [
  { icon: <BrainCircuit className="w-4 h-4" />, label: "AI Root Cause Analysis", desc: "Pinpoint exact failure source in seconds" },
  { icon: <TrendingUp className="w-4 h-4" />, label: "Predictive Capacity", desc: "Know saturation is coming before it hits" },
  { icon: <BarChart2 className="w-4 h-4" />, label: "OpenTelemetry Native", desc: "Metrics, logs, traces in one unified view" },
  { icon: <Zap className="w-4 h-4" />, label: "Automated Remediation", desc: "Self-healing runbooks triggered on anomaly" },
  { icon: <Globe className="w-4 h-4" />, label: "Multi-persona Dashboards", desc: "SRE, Business, and Ops views out of the box" },
  { icon: <ShieldCheck className="w-4 h-4" />, label: "Correlation Engine", desc: "Link incidents, alerts, errors, and deployments" },
];

const CAPABILITIES = [
  { icon: <Server className="w-3 h-3" />, label: "Live APM Sync" },
  { icon: <AlertTriangle className="w-3 h-3" />, label: "Incident Intelligence" },
  { icon: <BrainCircuit className="w-3 h-3" />, label: "AI Insights" },
  { icon: <TrendingUp className="w-3 h-3" />, label: "Capacity Planning" },
  { icon: <Cpu className="w-3 h-3" />, label: "Node Telemetry" },
  { icon: <Clock className="w-3 h-3" />, label: "OTel Traces" },
];

export default function LandingPage() {
  const [, setLocation] = useLocation();
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setPulse(p => !p), 2000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="min-h-screen bg-[#080810] flex flex-col md:flex-row overflow-hidden">

      {/* ── LEFT PANEL ── */}
      <div className="hidden md:flex md:w-[58%] relative flex-col justify-between p-10 lg:p-14 overflow-hidden">
        <div className="absolute -top-40 -right-40 w-[600px] h-[600px] rounded-full bg-indigo-600/10 blur-[120px] pointer-events-none" />
        <div className="absolute -bottom-40 -left-40 w-[500px] h-[500px] rounded-full bg-violet-600/8 blur-[100px] pointer-events-none" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] rounded-full bg-indigo-500/3 blur-[150px] pointer-events-none" />

        <div className="relative z-10 flex items-center gap-3">
          {/*<img src="/logo.png" alt="ObservaIQ" className="h-9 w-auto" />*/}
          <div className="flex items-center gap-2" data-testid="img-logo"><div className="flex h-8 w-8 items-center justify-center rounded-md bg-logo text-primary-foreground"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-activity h-4 w-4"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"></path></svg></div><span className="text-base font-semibold tracking-tight text-primary-foreground">ObservaIQ</span></div>
          <span className="text-[10px] px-2 py-0.5 rounded-full border border-indigo-500/30 text-indigo-400 font-medium">Enterprise</span>
        </div>

        <div className="relative z-10 my-auto max-w-xl">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 text-xs font-medium mb-6">
            <span className={`w-1.5 h-1.5 rounded-full bg-indigo-400 ${pulse ? "opacity-100" : "opacity-40"} transition-opacity duration-700`} />
            Real-time observability · AppDynamics &amp; Dynatrace
          </div>

          <h1 className="text-4xl lg:text-5xl font-bold text-white leading-tight mb-4">
            Intelligent Observability for Modern Enterprise
          </h1>
          <p className="text-base text-slate-400 mb-8 leading-relaxed">
            Correlate metrics, traces, and logs from AppDynamics and Dynatrace. Predict outages before they happen. Resolve incidents in seconds with AI-powered root cause analysis.
          </p>

          <div className="grid grid-cols-2 gap-2 mb-8">
            {FEATURES.map(f => (
              <div key={f.label} className="flex items-start gap-2 p-2.5 rounded-lg border border-white/5 bg-white/[0.02]">
                <div className="shrink-0 mt-0.5 text-indigo-400">{f.icon}</div>
                <div>
                  <p className="text-[11px] font-semibold text-slate-200">{f.label}</p>
                  <p className="text-[10px] text-slate-500">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-white/8 bg-white/[0.03] p-4">
            <p className="text-xs font-semibold text-slate-300 mb-3">Platform Capabilities</p>
            <div className="grid grid-cols-3 gap-2">
              {CAPABILITIES.map(i => (
                <div key={i.label} className="flex items-center gap-1.5 text-[10px] text-slate-400">
                  <span className="text-indigo-500">{i.icon}</span>{i.label}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="relative z-10 space-y-2">
          <div className="flex items-center gap-3 text-xs text-slate-600">
            <Database className="w-3.5 h-3.5" />
            <span>Integrates with AppDynamics · Dynatrace · New Relic · OpenTelemetry</span>
          </div>
          {/*<a href="https://www.cosmonautgroup.com" target="_blank" rel="noopener noreferrer"
            className="text-[11px] text-slate-600 hover:text-slate-400 transition-colors">
            Developed by Cosmonaut Technologies
          </a>*/}
        </div>
      </div>

      {/* ── RIGHT PANEL ── */}
      <div className="flex-1 flex flex-col justify-center items-center px-8 py-12 bg-[#0D0D1A] border-l border-white/5">
        <div className="w-full max-w-sm space-y-6">

          <div className="flex md:hidden items-center gap-2 mb-2">
            {/*<img src="/logo.png" alt="ObservaIQ" className="h-8 w-auto" />*/}
            <div className="flex items-center gap-2" data-testid="img-logo"><div className="flex h-8 w-8 items-center justify-center rounded-md bg-logo text-primary-foreground"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-activity h-4 w-4"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"></path></svg></div><span className="text-base font-semibold tracking-tight text-primary-foreground">ObservaIQ</span></div>
          </div>

          <div className="space-y-1">
            <h2 className="text-xl font-bold text-white">Welcome to ObservaIQ</h2>
            <p className="text-sm text-slate-400">
              Enterprise APM Intelligence — connect AppDynamics or Dynatrace and start monitoring your stack in real time.
            </p>
          </div>

          <div className="space-y-3">
            <Button
              data-testid="button-sign-in"
              className="w-full h-11 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold shadow-lg shadow-indigo-600/30 transition-all"
              onClick={() => setLocation("/login")}
            >
              <span className="flex items-center gap-2">Sign In <ArrowRight className="w-4 h-4" /></span>
            </Button>

            <Button
              data-testid="button-create-account"
              variant="outline"
              className="w-full h-11 border-white/10 bg-white/[0.04] text-slate-200 hover:bg-white/[0.08] hover:text-white transition-all"
              onClick={() => setLocation("/signup")}
            >
              <span className="flex items-center gap-2"><Building2 className="w-4 h-4" /> Create Organization Account</span>
            </Button>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-white/8" />
            <span className="text-xs text-slate-500">platform features</span>
            <div className="flex-1 h-px bg-white/8" />
          </div>

          <div className="space-y-2">
            {[
              { icon: <ShieldCheck className="w-3.5 h-3.5 text-indigo-400" />, title: "Multi-tenant & Role-based", desc: "Admin, SRE, and Business Viewer roles per org" },
              { icon: <Database className="w-3.5 h-3.5 text-indigo-400" />, title: "Real APM Data", desc: "Live sync from AppDynamics and Dynatrace controllers" },
              { icon: <BrainCircuit className="w-3.5 h-3.5 text-indigo-400" />, title: "AI-Powered Intelligence", desc: "Root cause analysis, incident correlation, and forecasting" },
              { icon: <Lock className="w-3.5 h-3.5 text-indigo-400" />, title: "Secure Credential Storage", desc: "Encrypted per-organization APM credentials" },
            ].map(item => (
              <div key={item.title} className="flex items-start gap-3 p-3 rounded-lg border border-white/5 bg-white/[0.02]">
                <div className="mt-0.5 shrink-0">{item.icon}</div>
                <div>
                  <p className="text-xs font-semibold text-slate-200">{item.title}</p>
                  <p className="text-[11px] text-slate-500">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>

          <p className="text-[10px] text-center text-slate-600">
            By signing in, you agree to the platform terms of service.
          </p>
        </div>
      </div>
    </div>
  );
}

