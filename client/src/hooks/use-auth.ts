import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@shared/routes";
import { ConnectionConfig } from "@shared/schema";

export function useConnectionStatus() {
  return useQuery({
    queryKey: [api.auth.status.path],
    queryFn: async () => {
      const res = await fetch(api.auth.status.path);
      if (!res.ok) throw new Error("Failed to fetch status");
      return api.auth.status.responses[200].parse(await res.json());
    },
    retry: false
  });
}

export function useConnect() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: ConnectionConfig) => {
      const res = await fetch(api.auth.connect.path, {
        method: api.auth.connect.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      
      const responseData = await res.json();
      
      if (!res.ok) {
        throw new Error(responseData.message || "Failed to connect");
      }
      
      return api.auth.connect.responses[200].parse(responseData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.auth.status.path] });
    }
  });
}
