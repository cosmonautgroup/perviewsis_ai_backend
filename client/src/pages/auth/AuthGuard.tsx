import { useEffect } from "react";
import { useLocation } from "wouter";
import { useUser } from "@/hooks/use-user";
import { Loader2, Activity } from "lucide-react";

const PUBLIC_PATHS = ["/login", "/signup", "/accept-invite"];
const PUBLIC_EXACT = ["/"];

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useUser();
  const [location, navigate] = useLocation();

  const isPublic = PUBLIC_EXACT.includes(location) || PUBLIC_PATHS.some(p => location.startsWith(p));

  useEffect(() => {
    if (!isLoading && !isAuthenticated && !isPublic) {
      navigate("/login");
    }
    if (!isLoading && isAuthenticated && (location === "/" || location === "/login" || location === "/signup")) {
      navigate("/applications");
    }
  }, [isAuthenticated, isLoading, isPublic, location, navigate]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4">
        <div className="w-12 h-12 rounded-xl bg-primary flex items-center justify-center">
          <Activity className="w-7 h-7 text-white" />
        </div>
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAuthenticated && !isPublic) {
    return null;
  }

  return <>{children}</>;
}
