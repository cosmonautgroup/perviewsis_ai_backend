import { useQuery } from "@tanstack/react-query";
import { api, buildUrl } from "@shared/routes";

export function useProblem(id: number) {
  return useQuery({
    queryKey: [api.problems.get.path, id],
    queryFn: async () => {
      const url = buildUrl(api.problems.get.path, { id });
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Failed to fetch problem");
      return api.problems.get.responses[200].parse(await res.json());
    },
    enabled: !!id
  });
}

export function useProblemMetrics(id: number) {
  return useQuery({
    queryKey: [api.problems.metrics.path, id],
    queryFn: async () => {
      const url = buildUrl(api.problems.metrics.path, { id });
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch problem metrics");
      return api.problems.metrics.responses[200].parse(await res.json());
    },
    enabled: !!id
  });
}
