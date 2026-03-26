import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, Trash2, Wifi, WifiOff, AlertTriangle,
  CheckCircle2, RefreshCw, Clock, Plug, Database,
  Activity, Server, GitBranch, ShieldAlert, BarChart3, Loader2,
  Download, FileDown
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";

const UPCOMING = [
  "SolarWinds", "New Relic", "Datadog", "Splunk Observability",
  "Azure Monitor", "AWS CloudWatch", "Google Cloud Operations"
];

function StatusIcon({ ok }: { ok: boolean | null }) {
  if (ok === null) return <WifiOff className="w-4 h-4 text-muted-foreground" />;
  return ok
    ? <CheckCircle2 className="w-4 h-4 text-green-500" />
    : <AlertTriangle className="w-4 h-4 text-red-400" />;
}

function SourceBadge({ source }: { source: string }) {
  const s = source === "appdynamics" ? "AppDynamics" : "Dynatrace";
  const cls = source === "appdynamics"
    ? "bg-blue-500/10 text-blue-400 border-blue-500/20"
    : "bg-purple-500/10 text-purple-400 border-purple-500/20";
  return <Badge className={`border text-xs ${cls}`}>{s}</Badge>;
}

function SyncStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    success: "bg-green-500/10 text-green-400 border-green-500/20",
    failed: "bg-red-500/10 text-red-400 border-red-500/20",
    running: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    partial: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  };
  return <Badge className={`border text-xs ${map[status] ?? "bg-muted text-muted-foreground"}`}>{status}</Badge>;
}

// ─── Credential Card ─────────────────────────────────────────────────────────
function CredentialCard({ cred, onDelete, onSync }: { cred: any; onDelete: () => void; onSync: () => void }) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const { toast } = useToast();

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await apiRequest("POST", `/api/apm/credentials/${cred.id}/test`, {});
      const result = await res.json();
      setTestResult(result);
      toast({
        title: result.ok ? "Connection OK" : "Connection failed",
        description: result.message,
        variant: result.ok ? "default" : "destructive",
      });
    } catch {
      setTestResult({ ok: false, message: "Request failed" });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card data-testid={`card-credential-${cred.id}`} className="border border-border">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Plug className="w-5 h-5 text-primary" />
            </div>
            <div>
              <p className="font-bold text-sm text-foreground">{cred.label}</p>
              <p className="text-xs text-muted-foreground font-mono truncate max-w-48">{cred.controllerUrl}</p>
            </div>
          </div>
          <SourceBadge source={cred.source} />
        </div>

        <div className="space-y-2 mb-4 text-xs text-muted-foreground">
          {cred.account && (
            <div className="flex gap-2 items-center"><Server className="w-3.5 h-3.5" /> Account: <span className="text-foreground font-mono">{cred.account}</span></div>
          )}
          {cred.username && (
            <div className="flex gap-2 items-center"><GitBranch className="w-3.5 h-3.5" /> User: <span className="text-foreground font-mono">{cred.username}</span></div>
          )}
          <div className="flex gap-2 items-center">
            <Clock className="w-3.5 h-3.5" />
            {cred.lastSyncAt
              ? <>Last sync: <span className="text-foreground">{formatDistanceToNow(new Date(cred.lastSyncAt), { addSuffix: true })}</span></>
              : <span className="italic">Never synced</span>}
          </div>
          {testResult && (
            <div className={`flex items-center gap-1.5 ${testResult.ok ? "text-green-400" : "text-red-400"}`}>
              <StatusIcon ok={testResult.ok} /> {testResult.message}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            data-testid={`button-test-${cred.id}`}
            size="sm" variant="outline" onClick={test} disabled={testing} className="text-xs"
          >
            {testing ? <Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> : <Wifi className="w-3 h-3 mr-1.5" />}
            {testing ? "Testing…" : "Test"}
          </Button>
          <Button
            data-testid={`button-sync-${cred.id}`}
            size="sm" variant="outline" onClick={onSync} className="text-xs"
          >
            <RefreshCw className="w-3 h-3 mr-1.5" /> Sync Now
          </Button>
          <Button
            data-testid={`button-delete-cred-${cred.id}`}
            size="sm" variant="ghost" className="text-red-400 text-xs" onClick={onDelete}
          >
            <Trash2 className="w-3 h-3 mr-1.5" /> Remove
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Env Status Card ──────────────────────────────────────────────────────────
function EnvStatusPanel({ envStatus }: { envStatus: any }) {
  if (!envStatus) return null;

  const appdyn = envStatus.appDynamics;
  const dt = envStatus.dynatrace;

  return (
    <Card className="border border-border bg-muted/10">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2"><ShieldAlert className="w-4 h-4 text-primary" /> Environment Variable Credentials</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <p className="text-xs text-muted-foreground mb-3">
          Credentials set via environment variables are used automatically if no DB credentials exist for that source.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="bg-muted/20 rounded-lg p-3 space-y-1">
            <div className="flex items-center gap-2 text-sm font-medium">
              <StatusIcon ok={appdyn?.configured ?? false} /> AppDynamics
            </div>
            {appdyn?.configured ? (
              <div className="text-xs text-muted-foreground space-y-0.5">
                <p>URL: <span className="font-mono text-foreground">{appdyn.url}</span></p>
                <p>Account: <span className="font-mono text-foreground">{appdyn.account}</span></p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic">
                Set <span className="font-mono">APPDYNAMICS_URL</span>, <span className="font-mono">APPDYNAMICS_ACCOUNT</span>,{" "}
                <span className="font-mono">APPDYNAMICS_USERNAME</span>, <span className="font-mono">APPDYNAMICS_PASSWORD</span>
              </p>
            )}
          </div>
          <div className="bg-muted/20 rounded-lg p-3 space-y-1">
            <div className="flex items-center gap-2 text-sm font-medium">
              <StatusIcon ok={dt?.configured ?? false} /> Dynatrace
            </div>
            {dt?.configured ? (
              <div className="text-xs text-muted-foreground space-y-0.5">
                <p>URL: <span className="font-mono text-foreground">{dt.url}</span></p>
                <p>Token: <span className="font-mono text-foreground">{dt.tokenPreview}</span></p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic">
                Set <span className="font-mono">DYNATRACE_URL</span> and <span className="font-mono">DYNATRACE_TOKEN</span>
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Sync Status Panel ────────────────────────────────────────────────────────
function SyncStatusPanel({ syncStatus }: { syncStatus: any }) {
  const counts = syncStatus?.counts ?? {};
  const logs = syncStatus?.recentLogs ?? [];

  const stats = [
    { label: "Applications", count: counts.applications ?? 0, icon: <Activity className="w-4 h-4 text-blue-400" /> },
    { label: "Incidents", count: counts.incidents ?? 0, icon: <ShieldAlert className="w-4 h-4 text-red-400" /> },
    { label: "Alerts", count: counts.alerts ?? 0, icon: <AlertTriangle className="w-4 h-4 text-yellow-400" /> },
    { label: "Servers", count: counts.servers ?? 0, icon: <Server className="w-4 h-4 text-green-400" /> },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {stats.map(s => (
          <Card key={s.label} className="border border-border">
            <CardContent className="p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-muted/30">{s.icon}</div>
              <div>
                <p className="text-xl font-bold text-foreground">{s.count.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">{s.label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {logs.length > 0 && (
        <Card className="border border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><BarChart3 className="w-4 h-4 text-primary" /> Recent Sync Runs</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {logs.map((log: any) => (
                <div key={log.id} data-testid={`sync-log-${log.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2 border-b border-border last:border-0 text-xs">
                  <div className="flex items-center gap-2">
                    <SourceBadge source={log.source} />
                    <SyncStatusBadge status={log.status} />
                    {log.recordsSynced > 0 && (
                      <span className="text-muted-foreground">{log.recordsSynced} records</span>
                    )}
                    {log.errorMessage && (
                      <span className="text-red-400 truncate max-w-48">{log.errorMessage}</span>
                    )}
                  </div>
                  <span className="text-muted-foreground">
                    {log.startedAt ? format(new Date(log.startedAt), "MMM d, HH:mm:ss") : "—"}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Add Credential Dialog ────────────────────────────────────────────────────
function AddCredentialDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    source: "appdynamics",
    label: "",
    controllerUrl: "",
    account: "",
    username: "",
    password: "",
    apiToken: "",
  });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/apm/credentials", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/apm/credentials"] });
      queryClient.invalidateQueries({ queryKey: ["/api/apm/sync/status"] });
      toast({ title: "Credential saved", description: "APM credential stored in database." });
      onClose();
    },
    onError: (err: any) => toast({ title: "Failed to save credential", description: err.message, variant: "destructive" }),
  });

  const testConn = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      let res;
      if (form.source === "appdynamics") {
        res = await apiRequest("POST", "/api/apm/test/appdynamics", {
          controllerUrl: form.controllerUrl,
          account: form.account,
          username: form.username,
          password: form.password,
        });
      } else {
        res = await apiRequest("POST", "/api/apm/test/dynatrace", {
          environmentUrl: form.controllerUrl,
          apiToken: form.apiToken,
        });
      }
      const result = await res.json();
      setTestResult(result);
      toast({
        title: result.ok ? "Connection successful" : "Connection failed",
        description: result.message,
        variant: result.ok ? "default" : "destructive",
      });
    } catch {
      setTestResult({ ok: false, message: "Request failed" });
    } finally {
      setTesting(false);
    }
  };

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const handleControllerUrlChange = (url: string) => {
    setForm(f => {
      const updated = { ...f, controllerUrl: url };
      if (f.source === "appdynamics") {
        try {
          const hostname = new URL(url.startsWith("http") ? url : `https://${url}`).hostname;
          const subdomain = hostname.split(".")[0];
          if (subdomain && subdomain.length > 1) updated.account = subdomain;
        } catch { /* invalid URL, ignore */ }
      }
      return updated;
    });
  };

  const handleUsernameBlur = () => {
    if (!form.account) return;
    const suffix = `@${form.account}`;
    if (form.username.endsWith(suffix)) {
      setForm(f => ({ ...f, username: f.username.slice(0, -suffix.length) }));
    }
  };

  const isValid = form.source && form.controllerUrl && (
    form.source === "appdynamics"
      ? form.account && form.username && form.password
      : form.apiToken
  );

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add APM Credential</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Source</Label>
            <Select value={form.source} onValueChange={v => { set("source", v); setTestResult(null); }}>
              <SelectTrigger data-testid="select-cred-source"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="appdynamics">AppDynamics</SelectItem>
                <SelectItem value="dynatrace">Dynatrace</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Label</Label>
            <Input data-testid="input-cred-label" placeholder="e.g. Production AppDynamics" value={form.label} onChange={e => set("label", e.target.value)} />
          </div>

          {form.source === "appdynamics" ? (
            <>
              <div className="space-y-1.5">
                <Label>Controller URL</Label>
                <Input data-testid="input-appdyn-url" placeholder="https://mycompany.saas.appdynamics.com" value={form.controllerUrl} onChange={e => handleControllerUrlChange(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Account Name</Label>
                <Input placeholder="mycompany-nfr" value={form.account} onChange={e => set("account", e.target.value)} />
                <p className="text-xs text-muted-foreground">Auto-filled from your Controller URL. This is the subdomain — e.g. <span className="font-mono">niit-technologies-nfr</span> from <span className="font-mono">niit-technologies-nfr.saas.appdynamics.com</span></p>
              </div>
              <div className="space-y-1.5">
                <Label>Username</Label>
                <Input
                  placeholder="user@company.com"
                  value={form.username}
                  onChange={e => set("username", e.target.value)}
                  onBlur={handleUsernameBlur}
                />
                <p className="text-xs text-muted-foreground">Your login email only — e.g. <span className="font-mono">user@company.com</span>. Do not include <span className="font-mono">@{form.account || "account"}</span> — it is added automatically.</p>
              </div>
              <div className="space-y-1.5">
                <Label>Password / Client Secret</Label>
                <Input type="password" placeholder="••••••••" value={form.password} onChange={e => set("password", e.target.value)} />
              </div>
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label>Environment URL</Label>
                <Input data-testid="input-dynatrace-url" placeholder="https://abc12345.live.dynatrace.com" value={form.controllerUrl} onChange={e => set("controllerUrl", e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>API Token</Label>
                <Input data-testid="input-dynatrace-token" type="password" placeholder="dt0c01.XXXXX…" value={form.apiToken} onChange={e => set("apiToken", e.target.value)} />
                <p className="text-xs text-muted-foreground">Required scopes: problems.read, entities.read, metrics.read</p>
              </div>
            </>
          )}

          {testResult && (
            <div className={`text-xs flex items-center gap-2 rounded-lg px-3 py-2 ${testResult.ok ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>
              <StatusIcon ok={testResult.ok} /> {testResult.message}
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={testConn} disabled={testing || !form.controllerUrl} data-testid="button-test-connection">
            {testing ? <Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> : <Wifi className="w-3 h-3 mr-1.5" />}
            {testing ? "Testing…" : "Test Connection"}
          </Button>
          <Button
            data-testid="button-confirm-add-credential"
            onClick={() => createMutation.mutate({
              source: form.source, label: form.label || "Default",
              controllerUrl: form.controllerUrl,
              account: form.account, username: form.username,
              password: form.password, apiToken: form.apiToken,
            })}
            disabled={!isValid || createMutation.isPending}
          >
            {createMutation.isPending ? "Saving…" : "Save Credential"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function Integrations() {
  const { toast } = useToast();
  const [showAdd, setShowAdd] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const { data: credentials, isLoading: loadingCreds } = useQuery<any[]>({
    queryKey: ["/api/apm/credentials"],
  });

  const { data: syncStatus, isLoading: loadingStatus } = useQuery<any>({
    queryKey: ["/api/apm/sync/status"],
    refetchInterval: 30_000,
  });

  const { data: envStatus } = useQuery<any>({ queryKey: ["/api/apm/env-status"] });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/apm/credentials/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/apm/credentials"] });
      toast({ title: "Credential removed" });
    },
  });

  const triggerSync = async (source?: string, credentialId?: number) => {
    setSyncing(true);
    try {
      const endpoint = source ? `/api/apm/sync/${source}` : "/api/apm/sync";
      const res = await apiRequest("POST", endpoint, credentialId ? { credentialId } : undefined);
      const result = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/apm/sync/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/apm/credentials"] });

      if (source) {
        const r = result as any;
        toast({
          title: r.status === "success" ? "Sync complete" : r.status === "failed" ? "Sync failed" : "Partial sync",
          description: r.status === "failed" ? r.errorMessage : `${r.recordsSynced} records synced from ${source}`,
          variant: r.status === "failed" ? "destructive" : "default",
        });
      } else {
        const total = (result.results as any[]).reduce((s: number, r: any) => s + r.recordsSynced, 0);
        toast({ title: "Full sync complete", description: `${total} total records synced` });
      }
    } catch (err: any) {
      toast({ title: "Sync failed", description: err.message, variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground mb-1">Integrations</h1>
            <p className="text-muted-foreground text-sm">Connect AppDynamics and Dynatrace to sync live observability data into Perviewsis.</p>
          </div>
          <div className="flex gap-2">
            <Button
              data-testid="button-sync-all"
              variant="outline"
              onClick={() => triggerSync()}
              disabled={syncing}
            >
              {syncing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
              {syncing ? "Syncing…" : "Sync All"}
            </Button>
            <Button data-testid="button-add-integration" onClick={() => setShowAdd(true)}>
              <Plus className="w-4 h-4 mr-2" /> Add Credential
            </Button>
          </div>
        </div>

        <Tabs defaultValue="credentials">
          <TabsList>
            <TabsTrigger value="credentials" data-testid="tab-credentials">Credentials</TabsTrigger>
            <TabsTrigger value="sync" data-testid="tab-sync">Sync Status</TabsTrigger>
            <TabsTrigger value="upcoming" data-testid="tab-upcoming">Upcoming</TabsTrigger>
          </TabsList>

          {/* ── Credentials Tab ── */}
          <TabsContent value="credentials" className="space-y-4 mt-4">
            <EnvStatusPanel envStatus={envStatus} />

            <div>
              <h2 className="text-base font-semibold text-foreground mb-3 flex items-center gap-2">
                <Database className="w-4 h-4 text-primary" /> Database Credentials
              </h2>
              {loadingCreds ? (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">{[0,1].map(i => <Skeleton key={i} className="h-48" />)}</div>
              ) : credentials && credentials.length > 0 ? (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {credentials.map(cred => (
                    <CredentialCard
                      key={cred.id}
                      cred={cred}
                      onDelete={() => deleteMutation.mutate(cred.id)}
                      onSync={() => triggerSync(cred.source, cred.id)}
                    />
                  ))}
                </div>
              ) : (
                <Card className="border border-dashed border-border">
                  <CardContent className="p-8 flex flex-col items-center gap-3 text-center">
                    <div className="w-12 h-12 rounded-full bg-muted/30 flex items-center justify-center">
                      <Plug className="w-6 h-6 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="font-semibold text-foreground mb-1">No credentials saved</p>
                      <p className="text-sm text-muted-foreground">Add AppDynamics or Dynatrace credentials to sync live data, or configure environment variables above.</p>
                    </div>
                    <Button onClick={() => setShowAdd(true)} data-testid="button-add-first-cred">
                      <Plus className="w-4 h-4 mr-2" /> Add First Credential
                    </Button>
                  </CardContent>
                </Card>
              )}
            </div>
          </TabsContent>

          {/* ── Sync Status Tab ── */}
          <TabsContent value="sync" className="mt-4">
            {loadingStatus ? (
              <div className="space-y-3">{[0,1].map(i => <Skeleton key={i} className="h-20" />)}</div>
            ) : (
              <SyncStatusPanel syncStatus={syncStatus} />
            )}
          </TabsContent>

          {/* ── Upcoming Tab ── */}
          <TabsContent value="upcoming" className="mt-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {UPCOMING.map(name => (
                <div
                  key={name}
                  className="border border-dashed border-border rounded-xl p-4 flex flex-col items-center gap-2 opacity-60 select-none"
                >
                  <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center">
                    <Plug className="w-4 h-4 text-muted-foreground" />
                  </div>
                  <p className="text-xs font-medium text-foreground text-center">{name}</p>
                  <Badge variant="secondary" className="text-xs">Coming Soon</Badge>
                </div>
              ))}
            </div>
            <Card className="border border-border shadow-sm bg-muted/20 mt-4">
              <CardContent className="p-5">
                <div className="flex flex-wrap items-start gap-4">
                  <div className="p-2 rounded-lg bg-primary/10"><Plug className="w-4 h-4 text-primary" /></div>
                  <div>
                    <p className="font-semibold text-sm text-foreground mb-1">Multi-Controller Support</p>
                    <p className="text-sm text-muted-foreground">Connect multiple AppDynamics controllers, Dynatrace environments, and OTEL collectors simultaneously. Data from all sources is unified in a single observability plane.</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      <AddCredentialDialog open={showAdd} onClose={() => setShowAdd(false)} />
    </AppLayout>
  );
}
