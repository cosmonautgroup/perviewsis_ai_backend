import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { 
  CheckCircle2, CreditCard, Calendar, TrendingUp, 
  AlertTriangle, Zap, Building2, Star
} from "lucide-react";
import { format } from "date-fns";

const PLANS = [
  {
    id: "starter",
    name: "Starter",
    icon: <Star className="w-5 h-5" />,
    monthlyPrice: 99,
    annualPrice: 79,
    color: "border-slate-300",
    headerColor: "bg-slate-50 dark:bg-slate-900",
    features: [
      "1 Integration", "5 Applications", "Basic dashboards",
      "Email support"
    ],
    limited: ["No AI forecasting", "No automation", "No capacity planning"]
  },
  {
    id: "professional",
    name: "Professional",
    icon: <Zap className="w-5 h-5" />,
    monthlyPrice: 299,
    annualPrice: 199,
    color: "border-primary/50",
    headerColor: "bg-primary/5",
    badge: "Most Popular",
    features: [
      "5 Integrations", "Unlimited applications", "AI forecasting",
      "Incident grouping", "Capacity planning", "Basic automation",
      "Priority email support"
    ],
    limited: []
  },
  {
    id: "enterprise",
    name: "Enterprise",
    icon: <Building2 className="w-5 h-5" />,
    monthlyPrice: 999,
    annualPrice: 799,
    color: "border-indigo-500/50",
    headerColor: "bg-indigo-500/5",
    badge: "Enterprise",
    features: [
      "Unlimited integrations", "Multi-tenant", "AI causal engine",
      "Knowledge graph", "Automation workflows", "RBAC",
      "Dedicated support", "SLA guarantee"
    ],
    limited: []
  }
];

function UsageMeter({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit ? Math.min((used / limit) * 100, 100) : 0;
  const color = pct > 85 ? "bg-red-500" : pct > 65 ? "bg-yellow-500" : "bg-green-500";
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5 text-xs">
        <span className="text-muted-foreground font-medium">{label}</span>
        <span className={`font-mono font-bold ${pct > 85 ? "text-red-400" : "text-foreground"}`}>
          {used.toLocaleString()} {limit ? `/ ${limit.toLocaleString()}` : "(unlimited)"}
        </span>
      </div>
      {limit && (
        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

export default function Subscription() {
  const { toast } = useToast();
  const { data: sub, isLoading } = useQuery<any>({ queryKey: ["/api/subscription"] });
  const [cycle, setCycle] = useState<"monthly" | "annual">("annual");

  const updateMutation = useMutation({
    mutationFn: (data: any) => apiRequest("PUT", "/api/subscription", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/subscription"] });
      toast({ title: "Subscription updated" });
    }
  });

  const handleUpgrade = (plan: string) => {
    updateMutation.mutate({ plan, cycle });
    toast({ title: `Switching to ${plan}...`, description: "Stripe integration coming soon." });
  };

  return (
    <AppLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground mb-1">Subscription & Billing</h1>
          <p className="text-muted-foreground text-sm">Manage your plan, usage limits, and billing information.</p>
        </div>

        {/* Current Plan Banner */}
        {!isLoading && sub && (
          <div className="bg-card border border-border rounded-xl p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs text-muted-foreground font-medium mb-1 uppercase tracking-wide">Current Plan</p>
                <div className="flex items-center gap-2 mb-1">
                  <h2 className="text-2xl font-bold text-foreground capitalize">{sub.plan}</h2>
                  <Badge className="bg-primary/10 text-primary border border-primary/20">Active</Badge>
                  <Badge variant="secondary" className="capitalize">{sub.cycle}</Badge>
                </div>
                <p className="text-sm text-muted-foreground flex items-center gap-2">
                  <Calendar className="w-3.5 h-3.5" />
                  Renewal: {format(new Date(sub.renewalDate), 'MMMM d, yyyy')}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-muted-foreground mb-1">Payment Method</p>
                <p className="font-medium text-foreground flex items-center gap-2">
                  <CreditCard className="w-4 h-4" />
                  {sub.paymentMethod?.type} ending {sub.paymentMethod?.last4}
                </p>
                <p className="text-xs text-muted-foreground">Expires {sub.paymentMethod?.expiry}</p>
              </div>
            </div>
          </div>
        )}

        {/* Usage Meters */}
        <Card className="border border-border shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2"><TrendingUp className="w-4 h-4 text-muted-foreground" /> Usage Statistics</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-24" /> : sub && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <UsageMeter label="Integrations" used={sub.usage.integrations} limit={sub.limits.integrations} />
                <UsageMeter label="Monitored Applications" used={sub.usage.apps} limit={sub.limits.apps} />
                <UsageMeter label="API Calls Today" used={sub.usage.apiCallsToday} limit={sub.limits.apiCallsDay} />
                <UsageMeter label="Telemetry Ingestion (GB/mo)" used={sub.usage.ingestionGbMonth} limit={null} />
              </div>
            )}
          </CardContent>
        </Card>

        {/* Billing Cycle Toggle */}
        {/*<div className="flex items-center gap-3">
          <span className="text-sm font-medium text-foreground">Billing Cycle</span>
          <div className="flex rounded-lg border border-border overflow-hidden">
            {["monthly", "annual"].map(c => (
              <button
                key={c}
                data-testid={`button-cycle-${c}`}
                onClick={() => setCycle(c as any)}
                className={`px-4 py-2 text-sm font-medium capitalize transition-colors ${cycle === c ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:text-foreground"}`}
              >
                {c} {c === "annual" && <span className="text-xs opacity-80 ml-1">Save 30%</span>}
              </button>
            ))}
          </div>
        </div>*/}

        {/* Plan Cards */}
        {/*<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {PLANS.map(plan => {
            const isCurrent = sub?.plan === plan.id;
            const price = cycle === "annual" ? plan.annualPrice : plan.monthlyPrice;
            return (
              <Card key={plan.id} data-testid={`card-plan-${plan.id}`} className={`border-2 shadow-sm ${isCurrent ? "border-primary" : plan.color}`}>
                <CardHeader className={`pb-3 rounded-t-xl ${plan.headerColor}`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className={`p-2 rounded-lg bg-white/10`}>{plan.icon}</div>
                    <div className="flex gap-1">
                      {plan.badge && <Badge variant="secondary" className="text-xs">{plan.badge}</Badge>}
                      {isCurrent && <Badge className="bg-primary/10 text-primary border border-primary/20 text-xs">Current</Badge>}
                    </div>
                  </div>
                  <CardTitle className="text-base font-bold">{plan.name}</CardTitle>
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-black text-foreground">${price}</span>
                    <span className="text-sm text-muted-foreground">/mo</span>
                    {cycle === "annual" && <span className="text-xs text-muted-foreground ml-1">(billed annually)</span>}
                  </div>
                </CardHeader>
                <CardContent className="pt-4">
                  <ul className="space-y-2 mb-4">
                    {plan.features.map(f => (
                      <li key={f} className="flex items-center gap-2 text-xs text-foreground">
                        <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />{f}
                      </li>
                    ))}
                    {plan.limited?.map(f => (
                      <li key={f} className="flex items-center gap-2 text-xs text-muted-foreground line-through">
                        <span className="w-3.5 h-3.5 shrink-0 text-center opacity-40">✕</span>{f}
                      </li>
                    ))}
                  </ul>
                  {isCurrent ? (
                    <Button data-testid={`button-current-plan`} className="w-full" variant="outline" disabled>Current Plan</Button>
                  ) : (
                    <Button
                      data-testid={`button-select-${plan.id}`}
                      className="w-full"
                      variant={plan.id === "professional" ? "default" : "outline"}
                      onClick={() => handleUpgrade(plan.id)}
                    >
                      {sub?.plan === "enterprise" && plan.id !== "enterprise" ? "Downgrade" : "Upgrade"} to {plan.name}
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>*/}

        {/* Stripe placeholder */}
        <Card className="border border-dashed border-border shadow-sm bg-muted/10">
          <CardContent className="p-5 flex flex-wrap items-center gap-4">
            <div className="p-2 rounded-lg bg-muted"><CreditCard className="w-5 h-5 text-muted-foreground" /></div>
            <div className="flex-1">
              <p className="font-semibold text-sm text-foreground">Payment Processing</p>
              <p className="text-xs text-muted-foreground">Stripe integration — manage invoices, payment methods, and billing portal.</p>
            </div>
            <Button variant="outline" disabled className="text-xs">
              Connect Stripe <Badge variant="secondary" className="ml-2 text-xs">Coming Soon</Badge>
            </Button>
          </CardContent>
        </Card>

        {/* Invoice History */}
        <Card className="border border-border shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Invoice History</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-24" /> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground text-xs">
                      <th className="px-3 py-2 text-left font-medium">Invoice</th>
                      <th className="px-3 py-2 text-left font-medium">Description</th>
                      <th className="px-3 py-2 text-right font-medium">Amount</th>
                      <th className="px-3 py-2 text-center font-medium">Status</th>
                      <th className="px-3 py-2 text-right font-medium">Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {sub?.invoices?.map((inv: any) => (
                      <tr key={inv.id} className="hover:bg-muted/20">
                        <td className="px-3 py-3 font-mono text-xs text-muted-foreground">{inv.id}</td>
                        <td className="px-3 py-3 text-xs text-foreground">{inv.description}</td>
                        <td className="px-3 py-3 text-right font-mono text-sm font-bold">${inv.amount.toLocaleString()}</td>
                        <td className="px-3 py-3 text-center">
                          <Badge className={`text-xs ${inv.status === 'Paid' ? 'bg-green-500/10 text-green-400 border-green-500/20' : 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'} border`}>{inv.status}</Badge>
                        </td>
                        <td className="px-3 py-3 text-right text-xs text-muted-foreground">{format(new Date(inv.date), 'MMM d, yyyy')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Enterprise Readiness */}
        <Card className="border border-border shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Enterprise Readiness</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {[
                { label: "Multi-Controller Support", status: true },
                { label: "Vendor-Neutral Telemetry", status: true },
                { label: "AI-Driven Insights", status: true },
                { label: "Role-Based Access Control", status: true },
                { label: "SaaS Subscription Model", status: true },
                { label: "SOC 2 Type II", status: false, coming: true },
              ].map(item => (
                <div key={item.label} className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 ${item.status ? 'border-green-500/20 bg-green-500/5' : 'border-dashed border-border bg-muted/10 opacity-60'}`}>
                  {item.status ? <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" /> : <AlertTriangle className="w-4 h-4 text-muted-foreground shrink-0" />}
                  <span className="text-xs font-medium text-foreground">{item.label}</span>
                  {item.coming && <Badge variant="secondary" className="text-xs ml-auto">Soon</Badge>}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
