import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Eye, EyeOff, Loader2 } from "lucide-react";

export default function Login() {
  const [location, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const query = new URLSearchParams(location.split("?")[1] ?? "");
  const isVerified = query.get("verified") === "1";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);

  const loginMutation = useMutation({
    mutationFn: async (data: { email: string; password: string }) => {
      const res = await apiRequest("POST", "/api/auth/login", data);
      if (!res.ok) {
        const body = await res.json();
        const err: any = new Error(body.error ?? "Login failed");
        err.code = body.code;
        throw err;
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      navigate("/applications");
    },
  });

  const resendMutation = useMutation({
    mutationFn: async (targetEmail: string) => {
      const res = await apiRequest("POST", "/api/auth/resend-verification", { email: targetEmail });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Could not resend verification");
      }
      return res.json();
    },
    onSuccess: (data: any) => {
      toast({
        title: "Verification email sent",
        description: data?.verificationEmailSent
          ? "Check your inbox for the verification link."
          : `Email provider is not configured. Use this link for now: ${data?.verificationPreviewUrl ?? "N/A"}`,
      });
    },
    onError: (err: any) => {
      toast({ title: "Resend failed", description: err.message, variant: "destructive" });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    loginMutation.mutate(
      { email, password },
      {
        onError: (err: any) => {
          toast({ title: "Login failed", description: err.message, variant: "destructive" });
          if (err?.code === "EMAIL_NOT_VERIFIED") {
            resendMutation.mutate(email);
          }
        },
      },
    );
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-md space-y-6">
        {/* Logo */}
        <div className="flex flex-col items-center gap-3">
          {/*<img src="/logo.png" alt="ObservaIQ" className="h-12 w-auto" />*/}
          <div className="flex items-center gap-2" data-testid="img-logo"><div className="flex h-8 w-8 items-center justify-center rounded-md bg-logo text-primary-foreground"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-activity h-4 w-4"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"></path></svg></div><span className="text-base font-semibold tracking-tight text-foreground">ObservaIQ</span></div>
          <p className="text-sm text-muted-foreground">AI-Powered Observability Platform</p>
        </div>

        <Card className="border border-border shadow-sm">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg">Sign in to your account</CardTitle>
            <CardDescription>Enter your credentials to access your organization's dashboard</CardDescription>
          </CardHeader>
          <CardContent>
            {isVerified && (
              <div className="mb-4 rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-500">
                Account verified successfully. Please sign in.
              </div>
            )}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  data-testid="input-email"
                  type="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
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
                    placeholder="••••••••"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    autoComplete="current-password"
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

              <Button
                data-testid="button-login"
                type="submit"
                className="w-full"
                disabled={loginMutation.isPending}
              >
                {loginMutation.isPending ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Signing in…</>
                ) : "Sign In"}
              </Button>
            </form>

            <div className="mt-4 text-center text-sm text-muted-foreground">
              Don't have an account?{" "}
              <button
                data-testid="link-signup"
                onClick={() => navigate("/signup")}
                className="text-primary hover:underline font-medium"
              >
                Create one
              </button>
            </div>
            <div className="mt-2 text-center text-xs text-muted-foreground">
              Didn&apos;t get verification email?{" "}
              <button
                type="button"
                onClick={() => email && resendMutation.mutate(email)}
                className="text-primary hover:underline font-medium disabled:opacity-50"
                disabled={!email || resendMutation.isPending}
              >
                {resendMutation.isPending ? "Sending..." : "Resend"}
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

