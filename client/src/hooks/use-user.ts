import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useLocation } from "wouter";

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  avatarInitials: string | null;
  isEmailVerified: boolean | null;
  createdAt: string | null;
}

export interface AuthOrg {
  id: number;
  name: string;
  slug: string;
  plan: string;
  maxUsers: number | null;
  createdAt: string | null;
}

export interface AuthState {
  user: AuthUser | null;
  organization: AuthOrg | null;
  role: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

export function useUser(): AuthState {
  const { data, isLoading } = useQuery<{ user: AuthUser; organization: AuthOrg; role: string }>({
    queryKey: ["/api/auth/me"],
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  return {
    user: data?.user ?? null,
    organization: data?.organization ?? null,
    role: data?.role ?? null,
    isAuthenticated: !!data?.user,
    isLoading,
  };
}

export function useLogout() {
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  return useMutation({
    mutationFn: () => apiRequest("POST", "/api/auth/logout"),
    onSuccess: () => {
      queryClient.clear();
      navigate("/login");
    },
  });
}
