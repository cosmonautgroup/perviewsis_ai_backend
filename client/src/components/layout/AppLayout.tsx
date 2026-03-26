import React, { useState } from "react";
import { Link, useLocation } from "wouter";
import { 
  LayoutDashboard, AlertOctagon, LineChart, Server,
  LogOut, Activity, Menu, X,
  BrainCircuit, Users, Cpu,
  User, Plug, CreditCard, ChevronDown,
  Globe, Building2, Bell, ShieldAlert,
  SearchCode, GitMerge, Lightbulb, Trophy, MessageSquareText,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useQuery } from "@tanstack/react-query";
import { useUser, useLogout } from "@/hooks/use-user";

interface AppLayoutProps {
  children: React.ReactNode;
  appId?: number;
}

const globalSections = [
  {
    label: "OBSERVABILITY",
    items: [
      { name: "Applications", href: "/applications", icon: <LayoutDashboard size={15} /> },
      { name: "Incidents", href: "/incidents", icon: <AlertOctagon size={15} /> },
      { name: "Alerts", href: "/alerts", icon: <Bell size={15} /> },
      { name: "Errors", href: "/errors", icon: <ShieldAlert size={15} /> },
    ]
  },
  {
    label: "PERSONAS",
    items: [
      { name: "Business View", href: "/persona/business", icon: <Users size={15} /> },
      { name: "SRE View", href: "/persona/sre", icon: <Activity size={15} /> },
    ]
  },
  {
    label: "AI & INTELLIGENCE",
    items: [
      { name: "Insight Navigator", href: "/ai/insight-navigator", icon: <MessageSquareText size={15} /> },
      { name: "Causal & Predictive", href: "/ai/insights", icon: <BrainCircuit size={15} /> },
      { name: "Root Cause Analysis", href: "/ai/root-cause", icon: <SearchCode size={15} /> },
      { name: "Correlation Insights", href: "/ai/correlation", icon: <GitMerge size={15} /> },
      { name: "Recommendations", href: "/ai/recommendations", icon: <Lightbulb size={15} /> },
      { name: "Service Risk Rankings", href: "/ai/risk-ranking", icon: <Trophy size={15} /> },
      { name: "Runtime Health", href: "/runtime/frontend-service", icon: <Cpu size={15} /> },
    ]
  },
  {
    label: "PLATFORM",
    items: [
      { name: "Capacity Planning", href: "/capacity-planning", icon: <Activity size={15} /> },
    ]
  },
  {
    label: "ACCOUNT",
    items: [
      { name: "Integrations", href: "/integrations", icon: <Plug size={15} /> },
      { name: "Subscription", href: "/subscription", icon: <CreditCard size={15} /> },
      { name: "My Profile", href: "/profile", icon: <User size={15} /> },
    ]
  }
];

const ENVIRONMENTS = ["Production", "Staging", "QA", "Development"];

function NavItem({ href, name, icon }: { href: string; name: string; icon: React.ReactNode }) {
  const [location] = useLocation();
  const isActive = location === href || (href.length > 1 && location.startsWith(href + "/"));
  return (
    <Link href={href} className={cn(
      "flex items-center gap-2.5 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors",
      isActive
        ? "bg-white/10 text-white"
        : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
    )}>
      <span className={isActive ? "text-white" : "text-slate-500"}>{icon}</span>
      {name}
    </Link>
  );
}

export function AppLayout({ children, appId }: AppLayoutProps) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [activeEnv, setActiveEnv] = useState("Production");
  const { user, organization, role } = useUser();
  const logoutMutation = useLogout();

  const appNavItems = appId ? [
    { name: "Dashboard", href: `/applications/${appId}`, icon: <LayoutDashboard size={15} /> },
    { name: "Servers", href: `/applications/${appId}/servers`, icon: <Server size={15} /> },
    { name: "Incidents", href: `/applications/${appId}/incidents`, icon: <AlertOctagon size={15} /> },
    { name: "Forecasting", href: `/applications/${appId}/forecast`, icon: <LineChart size={15} /> },
    { name: "Capacity", href: `/applications/${appId}/capacity`, icon: <Server size={15} /> },
  ] : [];

  const initials = user?.avatarInitials ?? user?.name?.split(' ').map((n: string) => n[0]).join('') ?? 'U';

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden">
      {/* Mobile overlay */}
      {isMobileMenuOpen && (
        <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={() => setIsMobileMenuOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={cn(
        "fixed inset-y-0 left-0 z-50 w-56 bg-[#0A0A0A] flex flex-col transition-transform duration-300 ease-in-out lg:translate-x-0 lg:static lg:shrink-0",
        isMobileMenuOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        {/* Logo */}
        <div className="h-14 flex items-center px-4 border-b border-white/8 shrink-0 gap-2">
          <img src="/logo.png" alt="Perviewsis" className="h-7 w-auto shrink-0" />
          <Button variant="ghost" size="icon" className="ml-auto lg:hidden text-slate-400" onClick={() => setIsMobileMenuOpen(false)}>
            <X size={15} />
          </Button>
        </div>

        {/* Org selector */}
        <div className="px-3 pt-3">
          <Link href="/org/settings" className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/8 transition-colors text-left">
            <Building2 className="w-3.5 h-3.5 text-slate-500 shrink-0" />
            <span className="text-[11px] text-slate-300 font-medium flex-1 truncate">{organization?.name ?? "My Organization"}</span>
            <ChevronDown className="w-3 h-3 text-slate-600 shrink-0" />
          </Link>
        </div>

        {/* Scrollable nav */}
        <div className="flex-1 overflow-y-auto py-3 px-3 space-y-5">
          {appId && (
            <div>
              <p className="text-[9px] font-bold text-slate-600 uppercase tracking-widest mb-1.5 px-1">App Navigation</p>
              <div className="space-y-0.5">
                {appNavItems.map(item => <NavItem key={item.href} {...item} />)}
              </div>
              <Link href="/applications" className="flex items-center gap-1.5 mt-2 px-3 py-1 text-[11px] text-slate-600 hover:text-slate-400 transition-colors">
                ← All Applications
              </Link>
              <div className="mt-3 border-t border-white/6 pt-3" />
            </div>
          )}

          {globalSections.map(section => (
            <div key={section.label}>
              <p className="text-[9px] font-bold text-slate-600 uppercase tracking-widest mb-1.5 px-1">{section.label}</p>
              <div className="space-y-0.5">
                {section.items.map(item => <NavItem key={item.href} {...item} />)}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-white/8 shrink-0 space-y-1">
          <Link href="/" className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-[12px] font-medium text-slate-600 hover:bg-red-500/10 hover:text-red-400 transition-colors">
            <LogOut size={14} /> Disconnect
          </Link>
          <a href="https://www.cosmonautgroup.com" target="_blank" rel="noopener noreferrer"
            className="block text-center text-[9px] text-slate-700 hover:text-slate-500 transition-colors pt-1 pb-0.5">
            Developed by Cosmonaut Technologies
          </a>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        {/* Header */}
        <header className="h-14 bg-card border-b border-border flex items-center px-4 sm:px-6 shrink-0 z-10 gap-3">
          <Button variant="ghost" size="icon" className="mr-1 lg:hidden" onClick={() => setIsMobileMenuOpen(true)}>
            <Menu size={17} />
          </Button>

          {/* Environment switcher */}
          <div className="hidden sm:flex items-center gap-2">
            <Globe className="w-3.5 h-3.5 text-muted-foreground" />
            <Select value={activeEnv} onValueChange={setActiveEnv}>
              <SelectTrigger data-testid="select-environment" className="h-7 text-xs border-0 bg-muted/50 px-2 w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENVIRONMENTS.map(e => (
                  <SelectItem key={e} value={e}>
                    <div className="flex items-center gap-2">
                      <div className={cn("w-1.5 h-1.5 rounded-full", e === "Production" ? "bg-green-500" : e === "Staging" ? "bg-yellow-500" : "bg-blue-400")} />
                      {e}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex-1" />

          {/* User avatar dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button data-testid="button-user-menu" className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/50 transition-colors">
                <div className="w-7 h-7 rounded-full bg-primary/15 border border-primary/30 flex items-center justify-center text-primary font-bold text-[11px]">
                  {initials}
                </div>
                <div className="hidden sm:block text-left">
                  <p className="text-xs font-semibold text-foreground leading-tight">{user?.name ?? "User"}</p>
                  <p className="text-[10px] text-muted-foreground leading-tight">{role ?? "Viewer"}</p>
                </div>
                <ChevronDown className="w-3 h-3 text-muted-foreground hidden sm:block" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <div className="px-2 py-1.5 border-b border-border mb-1">
                <p className="text-xs font-semibold text-foreground truncate">{user?.name ?? "User"}</p>
                <p className="text-[10px] text-muted-foreground truncate">{user?.email}</p>
              </div>
              <DropdownMenuItem asChild>
                <Link href="/profile" className="flex items-center gap-2 cursor-pointer">
                  <User className="w-3.5 h-3.5" /> My Profile
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/org/settings" className="flex items-center gap-2 cursor-pointer">
                  <Building2 className="w-3.5 h-3.5" /> Organization
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/integrations" className="flex items-center gap-2 cursor-pointer">
                  <Plug className="w-3.5 h-3.5" /> Integrations
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/subscription" className="flex items-center gap-2 cursor-pointer">
                  <CreditCard className="w-3.5 h-3.5" /> Subscription
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                data-testid="button-sign-out"
                className="flex items-center gap-2 cursor-pointer text-red-400 focus:text-red-400"
                onClick={() => logoutMutation.mutate()}
                disabled={logoutMutation.isPending}
              >
                <LogOut className="w-3.5 h-3.5" /> Sign Out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        {/* Content */}
        <div className="flex-1 overflow-auto bg-[#F8FAFC]">
          <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
