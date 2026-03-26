import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useUser } from "@/hooks/use-user";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2, UserPlus, CheckCircle2 } from "lucide-react";

export default function AcceptInvite() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const token = new URLSearchParams(search).get("token") ?? "";
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { isAuthenticated, isLoading: authLoading } = useUser();

  // Get invite details
  const { data: invite, isLoading: inviteLoading, error: inviteError } = useQuery<{
    email: string; role: string; organizationName: string;
  }>({
    queryKey: ["/api/auth/invite", token],
    queryFn: async () => {
      const res = await fetch(`/api/auth/invite/${token}`);
      if (!res.ok) throw new Error("Invitation not found or expired");
      return res.json();
    },
    enabled: !!token,
    retry: false,
  });

  // Signup form (if not authenticated)
  const [form, setForm] = useState({ name: "", password: "", confirmPassword: "" });
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  // If already authenticated, accept directly
  const acceptMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/auth/accept-invite", { token }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: "Joined organization!", description: `Welcome to ${invite?.organizationName}` });
      navigate("/applications");
    },
    onError: (err: any) => toast({ title: "Failed to accept invite", description: err.message, variant: "destructive" }),
  });

  // Signup + accept flow
  const signupMutation = useMutation({
    mutationFn: async () => {
      if (form.password !== form.confirmPassword) throw new Error("Passwords don't match");
      if (form.password.length < 8) throw new Error("Password must be at least 8 characters");
      // Sign up first
      const signupRes = await apiRequest("POST", "/api/auth/signup", {
        name: form.name,
        email: invite?.email,
        password: form.password,
        organizationName: `${form.name}'s Workspace`,
      });
      if (!signupRes.ok) {
        const body = await signupRes.json();
        throw new Error(body.error ?? "Signup failed");
      }
      // Then accept invite
      const acceptRes = await apiRequest("POST", "/api/auth/accept-invite", { token });
      if (!acceptRes.ok) {
        const body = await acceptRes.json();
        throw new Error(body.error ?? "Failed to accept invitation");
      }
      return acceptRes.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: "Welcome!", description: `You've joined ${invite?.organizationName}` });
      navigate("/applications");
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  if (!token) return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Invalid invitation link</div>;
  if (inviteLoading || authLoading) return <div className="min-h-screen flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;
  if (inviteError || !invite) return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 text-center px-4">
      <p className="text-lg font-semibold text-foreground">Invitation not found or expired</p>
      <p className="text-muted-foreground text-sm">This invitation link may have already been used or has expired.</p>
      <Button onClick={() => navigate("/login")}>Go to Login</Button>
    </div>
  );

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="flex flex-col items-center gap-3">
          <img src="/logo.png" alt="Perviewsis" className="h-12 w-auto" />
        </div>

        <Card className="border border-border shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2 mb-1">
              <UserPlus className="w-5 h-5 text-primary" />
              <CardTitle className="text-lg">You're invited!</CardTitle>
            </div>
            <CardDescription>
              You've been invited to join <strong className="text-foreground">{invite.organizationName}</strong> as <strong className="text-foreground">{invite.role}</strong>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="bg-muted/30 rounded-lg px-3 py-2 text-sm text-muted-foreground mb-4">
              Invitation sent to: <span className="text-foreground font-medium">{invite.email}</span>
            </div>

            {isAuthenticated ? (
              <Button
                data-testid="button-accept-invite"
                className="w-full"
                onClick={() => acceptMutation.mutate()}
                disabled={acceptMutation.isPending}
              >
                {acceptMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
                {acceptMutation.isPending ? "Joining…" : "Join Organization"}
              </Button>
            ) : (
              <form onSubmit={e => { e.preventDefault(); signupMutation.mutate(); }} className="space-y-4">
                <p className="text-sm text-muted-foreground">Create your account to accept this invitation:</p>
                <div className="space-y-1.5">
                  <Label>Full Name</Label>
                  <Input data-testid="input-name" placeholder="Jane Smith" value={form.name} onChange={e => set("name", e.target.value)} required />
                </div>
                <div className="space-y-1.5">
                  <Label>Password</Label>
                  <Input data-testid="input-password" type="password" placeholder="Min. 8 characters" value={form.password} onChange={e => set("password", e.target.value)} required />
                </div>
                <div className="space-y-1.5">
                  <Label>Confirm Password</Label>
                  <Input type="password" placeholder="••••••••" value={form.confirmPassword} onChange={e => set("confirmPassword", e.target.value)} required />
                </div>
                <Button data-testid="button-create-and-join" type="submit" className="w-full" disabled={signupMutation.isPending}>
                  {signupMutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Creating account…</> : "Create Account & Join"}
                </Button>
                <p className="text-center text-sm text-muted-foreground">
                  Already have an account?{" "}
                  <button type="button" onClick={() => navigate(`/login`)} className="text-primary hover:underline">Sign in</button>
                </p>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
