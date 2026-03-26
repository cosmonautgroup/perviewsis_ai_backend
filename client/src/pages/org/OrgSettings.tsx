import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { AppLayout } from "@/components/layout/AppLayout";
import { useUser } from "@/hooks/use-user";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";
import {
  Users, Building2, Mail, Trash2, Crown, Edit, UserPlus, Shield,
  Eye, Loader2, Clock, CheckCircle2, XCircle
} from "lucide-react";
import { ROLES } from "@shared/schema";

type Role = typeof ROLES[number];

const ROLE_COLORS: Record<string, string> = {
  Admin: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  SRE: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  "Business Viewer": "bg-muted text-muted-foreground border-border",
};

const ROLE_ICONS: Record<string, any> = {
  Admin: Crown,
  SRE: Shield,
  "Business Viewer": Eye,
};

function RoleBadge({ role }: { role: string }) {
  const Icon = ROLE_ICONS[role] ?? Eye;
  return (
    <Badge className={`border text-xs flex items-center gap-1 ${ROLE_COLORS[role] ?? ""}`}>
      <Icon className="w-3 h-3" /> {role}
    </Badge>
  );
}

function Avatar({ initials, name }: { initials?: string | null; name: string }) {
  const text = initials ?? name.slice(0, 2).toUpperCase();
  return (
    <div className="w-9 h-9 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center text-sm font-bold text-primary select-none">
      {text}
    </div>
  );
}

// ─── Invite Dialog ────────────────────────────────────────────────────────────
function InviteDialog({ orgId, open, onClose }: { orgId: number; open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("SRE");

  const inviteMutation = useMutation({
    mutationFn: (data: { email: string; role: string }) => apiRequest("POST", "/api/org/invite", data),
    onSuccess: async (res) => {
      const body = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/org/invitations"] });
      toast({
        title: "Invitation sent",
        description: `Invite link: ${body.inviteUrl}`,
      });
      setEmail("");
      onClose();
    },
    onError: async (err: any) => {
      toast({ title: "Failed to invite", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><UserPlus className="w-5 h-5 text-primary" /> Invite Team Member</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Email Address</Label>
            <Input
              data-testid="input-invite-email"
              type="email"
              placeholder="colleague@company.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Role</Label>
            <Select value={role} onValueChange={v => setRole(v as Role)}>
              <SelectTrigger data-testid="select-invite-role"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ROLES.map(r => (
                  <SelectItem key={r} value={r}>
                    <span className="flex items-center gap-2">{r}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {role === "Admin" && "Full access: can manage users, credentials, and all data"}
              {role === "SRE" && "Can manage integrations, view incidents, alerts, and monitoring data"}
              {role === "Business Viewer" && "Read-only access to dashboards and business metrics"}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            data-testid="button-send-invite"
            onClick={() => inviteMutation.mutate({ email, role })}
            disabled={!email || inviteMutation.isPending}
          >
            {inviteMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Mail className="w-4 h-4 mr-2" />}
            Send Invitation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function OrgSettings() {
  const { toast } = useToast();
  const { user, organization, role: myRole } = useUser();
  const isAdmin = myRole === "Admin";
  const [showInvite, setShowInvite] = useState(false);
  const [editingMemberId, setEditingMemberId] = useState<number | null>(null);
  const [editingRole, setEditingRole] = useState<Role>("SRE");

  const { data: members, isLoading: loadingMembers } = useQuery<any[]>({ queryKey: ["/api/org/members"] });
  const { data: invitationsList, isLoading: loadingInvites } = useQuery<any[]>({ queryKey: ["/api/org/invitations"] });

  const deleteMember = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/org/members/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/org/members"] });
      toast({ title: "Member removed" });
    },
    onError: async (err: any) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  const updateRole = useMutation({
    mutationFn: ({ id, role }: { id: number; role: Role }) => apiRequest("PUT", `/api/org/members/${id}/role`, { role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/org/members"] });
      setEditingMemberId(null);
      toast({ title: "Role updated" });
    },
  });

  const cancelInvite = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/org/invitations/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/org/invitations"] });
      toast({ title: "Invitation cancelled" });
    },
  });

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground mb-1">Organization Settings</h1>
            <p className="text-muted-foreground text-sm">Manage your team, roles, and organization configuration.</p>
          </div>
          {isAdmin && (
            <Button data-testid="button-invite-member" onClick={() => setShowInvite(true)}>
              <UserPlus className="w-4 h-4 mr-2" /> Invite Member
            </Button>
          )}
        </div>

        <Tabs defaultValue="members">
          <TabsList>
            <TabsTrigger value="members" data-testid="tab-members">
              <Users className="w-4 h-4 mr-1.5" /> Members
            </TabsTrigger>
            <TabsTrigger value="invites" data-testid="tab-invites">
              <Mail className="w-4 h-4 mr-1.5" /> Invitations
            </TabsTrigger>
            <TabsTrigger value="org" data-testid="tab-org">
              <Building2 className="w-4 h-4 mr-1.5" /> Organization
            </TabsTrigger>
          </TabsList>

          {/* Members Tab */}
          <TabsContent value="members" className="mt-4">
            {loadingMembers ? (
              <div className="space-y-3">{[0,1,2].map(i => <Skeleton key={i} className="h-16" />)}</div>
            ) : (
              <Card className="border border-border">
                <CardContent className="p-0">
                  <div className="divide-y divide-border">
                    {members?.map(m => (
                      <div key={m.id} data-testid={`row-member-${m.id}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                        <div className="flex items-center gap-3">
                          <Avatar initials={m.avatarInitials} name={m.name} />
                          <div>
                            <p className="font-medium text-sm text-foreground flex items-center gap-2">
                              {m.name}
                              {m.userId === user?.id && <span className="text-xs text-muted-foreground">(you)</span>}
                            </p>
                            <p className="text-xs text-muted-foreground">{m.email}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          {editingMemberId === m.id ? (
                            <div className="flex items-center gap-2">
                              <Select value={editingRole} onValueChange={v => setEditingRole(v as Role)}>
                                <SelectTrigger className="w-40 h-8 text-xs"><SelectValue /></SelectTrigger>
                                <SelectContent>{ROLES.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
                              </Select>
                              <Button size="sm" onClick={() => updateRole.mutate({ id: m.id, role: editingRole })} disabled={updateRole.isPending} className="h-8 text-xs">Save</Button>
                              <Button size="sm" variant="ghost" onClick={() => setEditingMemberId(null)} className="h-8 text-xs">Cancel</Button>
                            </div>
                          ) : (
                            <>
                              <RoleBadge role={m.role} />
                              {isAdmin && m.userId !== user?.id && (
                                <div className="flex gap-1">
                                  <Button
                                    data-testid={`button-edit-role-${m.id}`}
                                    size="sm" variant="ghost" className="h-8 w-8 p-0"
                                    onClick={() => { setEditingMemberId(m.id); setEditingRole(m.role as Role); }}
                                  >
                                    <Edit className="w-3.5 h-3.5" />
                                  </Button>
                                  <Button
                                    data-testid={`button-remove-${m.id}`}
                                    size="sm" variant="ghost" className="h-8 w-8 p-0 text-red-400 hover:text-red-300"
                                    onClick={() => deleteMember.mutate(m.id)}
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </Button>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* Invitations Tab */}
          <TabsContent value="invites" className="mt-4">
            {loadingInvites ? (
              <div className="space-y-3">{[0,1].map(i => <Skeleton key={i} className="h-14" />)}</div>
            ) : !invitationsList?.length ? (
              <Card className="border border-dashed border-border">
                <CardContent className="p-8 text-center text-muted-foreground">
                  <Mail className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <p className="text-sm">No pending invitations</p>
                </CardContent>
              </Card>
            ) : (
              <Card className="border border-border">
                <CardContent className="p-0">
                  <div className="divide-y divide-border">
                    {invitationsList.map(inv => (
                      <div key={inv.id} data-testid={`row-invite-${inv.id}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                        <div>
                          <p className="font-medium text-sm text-foreground">{inv.email}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <RoleBadge role={inv.role} />
                            <span className="text-xs text-muted-foreground flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              Expires {formatDistanceToNow(new Date(inv.expiresAt), { addSuffix: true })}
                            </span>
                          </div>
                        </div>
                        {isAdmin && (
                          <Button
                            data-testid={`button-cancel-invite-${inv.id}`}
                            size="sm" variant="ghost" className="text-red-400 text-xs"
                            onClick={() => cancelInvite.mutate(inv.id)}
                          >
                            <XCircle className="w-3.5 h-3.5 mr-1" /> Cancel
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* Organization Tab */}
          <TabsContent value="org" className="mt-4 space-y-4">
            <Card className="border border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Building2 className="w-4 h-4 text-primary" /> Organization Details
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground text-xs mb-1">Name</p>
                    <p className="font-medium text-foreground">{organization?.name}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs mb-1">Slug</p>
                    <p className="font-mono text-foreground">{organization?.slug}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs mb-1">Plan</p>
                    <Badge variant="secondary" className="capitalize">{organization?.plan}</Badge>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs mb-1">Max Users</p>
                    <p className="font-medium text-foreground">{members?.length ?? 0} / {organization?.maxUsers ?? "∞"}</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Role Permissions</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3 text-sm">
                  {[
                    { role: "Admin", desc: "Full access: manage users, credentials, integrations, view all data, configure alerts" },
                    { role: "SRE", desc: "Can manage APM integrations, view incidents, alerts, errors, capacity planning, and all monitoring data" },
                    { role: "Business Viewer", desc: "Read-only access to business dashboards, application health overviews, and SLA metrics" },
                  ].map(({ role, desc }) => (
                    <div key={role} className="flex gap-3">
                      <RoleBadge role={role} />
                      <p className="text-muted-foreground text-xs pt-0.5">{desc}</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {organization && (
        <InviteDialog orgId={organization.id} open={showInvite} onClose={() => setShowInvite(false)} />
      )}
    </AppLayout>
  );
}
