import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Eye, EyeOff, Loader2, Building2 } from "lucide-react";

export default function Signup() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
    organizationName: "",
  });
  const [showPw, setShowPw] = useState(false);

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const signupMutation = useMutation({
    mutationFn: async (data: typeof form) => {
      const res = await apiRequest("POST", "/api/auth/signup", {
        name: data.name,
        email: data.email,
        password: data.password,
        organizationName: data.organizationName,
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Signup failed");
      }
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      if (data?.requiresEmailVerification) {
        toast({
          title: "Verify your email",
          description: data?.verificationEmailSent
            ? "We sent a verification link to your inbox. Please verify before signing in."
            : `Email provider is not configured. Use this link for now: ${data?.verificationPreviewUrl ?? "N/A"}`,
        });
        navigate("/login");
        return;
      }
      navigate("/applications");
    },
    onError: (err: any) => {
      toast({ title: "Signup failed", description: err.message, variant: "destructive" });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (form.password !== form.confirmPassword) {
      toast({ title: "Passwords don't match", variant: "destructive" });
      return;
    }
    if (form.password.length < 8) {
      toast({ title: "Password too short", description: "Must be at least 8 characters", variant: "destructive" });
      return;
    }
    signupMutation.mutate(form);
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-md space-y-6">
        {/* Logo */}
        <div className="flex flex-col items-center gap-3">
          {/*<img src="/logo.png" alt="ObservaIQ" className="h-12 w-auto" />*/}
          <div className="flex items-center gap-2" data-testid="img-logo"><div className="flex h-8 w-8 items-center justify-center rounded-md bg-logo text-primary-foreground"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-activity h-4 w-4"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"></path></svg></div><span className="text-base font-semibold tracking-tight text-foreground">ObservaIQ</span></div>
          <p className="text-sm text-muted-foreground">AI-Powered Observability Platform</p>
        </div>

        <Card className="border border-border shadow-sm">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg">Create your account</CardTitle>
            <CardDescription>Set up your organization and start monitoring in minutes</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Organization */}
              <div className="space-y-1.5">
                <Label htmlFor="orgName" className="flex items-center gap-1.5">
                  <Building2 className="w-3.5 h-3.5 text-muted-foreground" /> Organization Name
                </Label>
                <Input
                  id="orgName"
                  data-testid="input-org-name"
                  placeholder="Acme Corp"
                  value={form.organizationName}
                  onChange={e => set("organizationName", e.target.value)}
                  required
                />
                <p className="text-xs text-muted-foreground">You'll be the Admin of this organization</p>
              </div>

              <div className="border-t border-border pt-3 space-y-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Your Details</p>

                <div className="space-y-1.5">
                  <Label htmlFor="name">Full Name</Label>
                  <Input
                    id="name"
                    data-testid="input-name"
                    placeholder="Jane Smith"
                    value={form.name}
                    onChange={e => set("name", e.target.value)}
                    autoComplete="name"
                    required
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="email">Work Email</Label>
                  <Input
                    id="email"
                    data-testid="input-email"
                    type="email"
                    placeholder="jane@acme.com"
                    value={form.email}
                    onChange={e => set("email", e.target.value)}
                    autoComplete="email"
                    required
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="password">Password</Label>
                  <div className="relative">
                    <Input
                      id="password"
                      data-testid="input-password"
                      type={showPw ? "text" : "password"}
                      placeholder="Min. 8 characters"
                      value={form.password}
                      onChange={e => set("password", e.target.value)}
                      autoComplete="new-password"
                      required
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPw(!showPw)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      tabIndex={-1}
                    >
                      {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="confirmPassword">Confirm Password</Label>
                  <Input
                    id="confirmPassword"
                    data-testid="input-confirm-password"
                    type="password"
                    placeholder="••••••••"
                    value={form.confirmPassword}
                    onChange={e => set("confirmPassword", e.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </div>
              </div>

              <Button
                data-testid="button-signup"
                type="submit"
                className="w-full"
                disabled={signupMutation.isPending}
              >
                {signupMutation.isPending ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Creating account…</>
                ) : "Create Account"}
              </Button>
            </form>

            <div className="mt-4 text-center text-sm text-muted-foreground">
              Already have an account?{" "}
              <button
                data-testid="link-login"
                onClick={() => navigate("/login")}
                className="text-primary hover:underline font-medium"
              >
                Sign in
              </button>
            </div>
          </CardContent>
        </Card>

        {/*<p className="text-center text-xs text-muted-foreground">
          Developed by{" "}
          <a href="https://www.cosmonautgroup.com" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
            Cosmonaut Technologies
          </a>
        </p>*/}
      </div>
    </div>
  );
}

