import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { 
  User, Lock, Bell, Monitor, Shield, LogOut, 
  CheckCircle2, AlertTriangle, Smartphone, Globe, Trash2
} from "lucide-react";
import { format } from "date-fns";

const ROLES = ["Admin", "SRE", "Business Viewer"];
const TIMEZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Paris", "Asia/Tokyo", "Asia/Singapore"];

function PasswordStrength({ password }: { password: string }) {
  const score = [/.{8,}/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(r => r.test(password)).length;
  const levels = ["", "Weak", "Fair", "Good", "Strong"];
  const colors = ["", "bg-red-500", "bg-yellow-500", "bg-blue-500", "bg-green-500"];
  if (!password) return null;
  return (
    <div className="mt-1.5">
      <div className="flex gap-1 mb-1">
        {[1, 2, 3, 4].map(i => <div key={i} className={`h-1 flex-1 rounded-full ${i <= score ? colors[score] : "bg-muted"}`} />)}
      </div>
      <p className={`text-xs ${score <= 1 ? "text-red-500" : score <= 2 ? "text-yellow-500" : score <= 3 ? "text-blue-500" : "text-green-500"}`}>{levels[score]}</p>
    </div>
  );
}

export default function Profile() {
  const { toast } = useToast();
  const { data: profile, isLoading } = useQuery<any>({ queryKey: ["/api/profile"] });
  const [form, setForm] = useState<any>(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [oldPassword, setOldPassword] = useState("");

  // Initialize form when data loads
  if (profile && !form) {
    setForm({
      name: profile.name,
      company: profile.company,
      role: profile.role,
      timezone: profile.timezone,
      theme: profile.theme,
      twoFactorEnabled: profile.twoFactorEnabled,
      notifications: { ...profile.notifications }
    });
  }

  const updateMutation = useMutation({
    mutationFn: (data: any) => apiRequest("PUT", "/api/profile", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/profile"] });
      toast({ title: "Profile saved", description: "Your changes have been applied." });
    },
    onError: () => toast({ title: "Save failed", variant: "destructive" })
  });

  const revokeSession = useMutation({
    mutationFn: (sessionId: string) => apiRequest("DELETE", `/api/profile/sessions/${sessionId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/profile"] })
  });

  const set = (field: string, value: any) => setForm((f: any) => ({ ...f, [field]: value }));
  const setNotif = (key: string, value: boolean) => setForm((f: any) => ({ ...f, notifications: { ...f.notifications, [key]: value } }));

  const handleSave = () => {
    if (!form) return;
    updateMutation.mutate(form);
  };

  const handleChangePassword = () => {
    if (newPassword !== confirmPassword) { toast({ title: "Passwords do not match", variant: "destructive" }); return; }
    if (newPassword.length < 8) { toast({ title: "Password must be at least 8 characters", variant: "destructive" }); return; }
    toast({ title: "Password updated", description: "Your password has been changed." });
    setOldPassword(""); setNewPassword(""); setConfirmPassword("");
  };

  return (
    <AppLayout>
      <div className="space-y-6 max-w-3xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground mb-1">My Profile</h1>
            <p className="text-muted-foreground text-sm">Manage your account, security, and notification preferences.</p>
          </div>
          {!isLoading && profile && (
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-full bg-primary/15 border border-primary/30 flex items-center justify-center text-primary font-bold text-base">
                {profile.name?.split(' ').map((n: string) => n[0]).join('')}
              </div>
              <div>
                <p className="font-semibold text-sm text-foreground">{profile.name}</p>
                <Badge variant="secondary" className="text-xs">{profile.role}</Badge>
              </div>
            </div>
          )}
        </div>

        {/* Basic Information */}
        <Card className="border border-border shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2"><User className="w-4 h-4 text-muted-foreground" /> Basic Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {isLoading || !form ? (
              <div className="space-y-3">{Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="name">Full Name</Label>
                    <Input data-testid="input-name" id="name" value={form.name} onChange={e => set("name", e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="email">Email <span className="text-muted-foreground text-xs">(read-only)</span></Label>
                    <Input id="email" value={profile?.email} disabled className="opacity-60" />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="company">Company</Label>
                    <Input data-testid="input-company" id="company" value={form.company} onChange={e => set("company", e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="role">Role</Label>
                    <Select value={form.role} onValueChange={v => set("role", v)}>
                      <SelectTrigger data-testid="select-role"><SelectValue /></SelectTrigger>
                      <SelectContent>{ROLES.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="timezone">Timezone</Label>
                    <Select value={form.timezone} onValueChange={v => set("timezone", v)}>
                      <SelectTrigger data-testid="select-timezone"><SelectValue /></SelectTrigger>
                      <SelectContent>{TIMEZONES.map(tz => <SelectItem key={tz} value={tz}>{tz}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Theme</Label>
                    <Select value={form.theme} onValueChange={v => set("theme", v)}>
                      <SelectTrigger data-testid="select-theme"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="light">Light</SelectItem>
                        <SelectItem value="dark">Dark</SelectItem>
                        <SelectItem value="system">System</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Security */}
        <Card className="border border-border shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2"><Lock className="w-4 h-4 text-muted-foreground" /> Security</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Change Password */}
            <div>
              <p className="text-sm font-medium text-foreground mb-3">Change Password</p>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label>Current Password</Label>
                  <Input data-testid="input-old-password" type="password" value={oldPassword} onChange={e => setOldPassword(e.target.value)} placeholder="Enter current password" />
                </div>
                <div className="space-y-1.5">
                  <Label>New Password</Label>
                  <Input data-testid="input-new-password" type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="Enter new password" />
                  <PasswordStrength password={newPassword} />
                </div>
                <div className="space-y-1.5">
                  <Label>Confirm New Password</Label>
                  <Input data-testid="input-confirm-password" type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="Confirm new password" />
                </div>
                <Button data-testid="button-change-password" size="sm" onClick={handleChangePassword} disabled={!oldPassword || !newPassword}>Change Password</Button>
              </div>
            </div>

            <Separator />

            {/* 2FA */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-foreground flex items-center gap-2">
                  <Smartphone className="w-4 h-4 text-muted-foreground" /> Two-Factor Authentication
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">Add an extra layer of security to your account.</p>
              </div>
              <div className="flex items-center gap-2">
                {form && <Switch data-testid="switch-2fa" checked={form?.twoFactorEnabled} onCheckedChange={v => set("twoFactorEnabled", v)} />}
                <Badge variant="secondary" className="text-xs">UI Placeholder</Badge>
              </div>
            </div>

            <Separator />

            {/* Active Sessions */}
            <div>
              <p className="text-sm font-medium text-foreground mb-3 flex items-center gap-2">
                <Monitor className="w-4 h-4 text-muted-foreground" /> Active Sessions
              </p>
              {isLoading ? <Skeleton className="h-24" /> : (
                <div className="space-y-2">
                  {profile?.sessions?.map((s: any) => (
                    <div key={s.id} className="flex items-center justify-between rounded-lg border border-border bg-muted/20 px-4 py-3">
                      <div>
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-sm font-medium text-foreground">{s.device}</span>
                          {s.current && <Badge className="bg-green-500/10 text-green-400 border border-green-500/20 text-xs">Current</Badge>}
                        </div>
                        <p className="text-xs text-muted-foreground">{s.location} · {s.ip} · {format(new Date(s.lastActive), 'MMM d, HH:mm')}</p>
                      </div>
                      {!s.current && (
                        <Button data-testid={`button-revoke-${s.id}`} variant="ghost" size="sm" className="text-red-400 text-xs" onClick={() => revokeSession.mutate(s.id)}>
                          <Trash2 className="w-3 h-3 mr-1" /> Revoke
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Notifications */}
        <Card className="border border-border shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2"><Bell className="w-4 h-4 text-muted-foreground" /> Notification Preferences</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading || !form ? <Skeleton className="h-32" /> : (
              <div className="space-y-4">
                {[
                  { key: "emailAlerts", label: "Email Alerts", desc: "Receive general platform alerts via email" },
                  { key: "incidentAlerts", label: "Incident Alerts", desc: "Immediate notification on new critical incidents" },
                  { key: "slaBreachAlerts", label: "SLA Breach Alerts", desc: "Alert when SLA breach probability exceeds 70%" },
                  { key: "weeklyReport", label: "Weekly Executive Summary", desc: "Digest report every Monday morning" },
                ].map(item => (
                  <div key={item.key} className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium text-foreground">{item.label}</p>
                      <p className="text-xs text-muted-foreground">{item.desc}</p>
                    </div>
                    <Switch
                      data-testid={`switch-notif-${item.key}`}
                      checked={form.notifications[item.key]}
                      onCheckedChange={v => setNotif(item.key, v)}
                    />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* RBAC Info */}
        <Card className="border border-border shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2"><Shield className="w-4 h-4 text-muted-foreground" /> Role & Permissions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                { role: "Admin", perms: ["Manage integrations", "Manage subscription", "Manage users", "All dashboards"] },
                { role: "SRE", perms: ["View dashboards", "View incidents", "Trigger automation", "Runtime health"] },
                { role: "Business Viewer", perms: ["Business dashboard only", "SLA & revenue KPIs", "No configuration"] },
              ].map(r => (
                <div key={r.role} className={`rounded-lg border p-4 ${profile?.role === r.role ? 'border-primary/30 bg-primary/5' : 'border-border bg-muted/10'}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <p className="font-semibold text-sm text-foreground">{r.role}</p>
                    {profile?.role === r.role && <Badge className="bg-primary/10 text-primary border border-primary/20 text-xs">Your Role</Badge>}
                  </div>
                  <ul className="space-y-1">
                    {r.perms.map(p => (
                      <li key={p} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0" />{p}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Save */}
        <div className="flex justify-end">
          <Button data-testid="button-save-profile" onClick={handleSave} disabled={updateMutation.isPending}>
            {updateMutation.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </div>
    </AppLayout>
  );
}
