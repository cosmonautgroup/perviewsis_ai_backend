import { useQuery } from "@tanstack/react-query";
import { api, buildUrl } from "@shared/routes";

export function useApplications() {
  return useQuery({
    queryKey: [api.applications.list.path],
    queryFn: async () => {
      const res = await fetch(api.applications.list.path);
      if (!res.ok) throw new Error("Failed to fetch applications");
      return api.applications.list.responses[200].parse(await res.json());
    }
  });
}

export function useApplication(id: number) {
  return useQuery({
    queryKey: [api.applications.get.path, id],
    queryFn: async () => {
      const url = buildUrl(api.applications.get.path, { id });
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Failed to fetch application");
      return api.applications.get.responses[200].parse(await res.json());
    },
    enabled: !!id
  });
}

export function useTransactions(appId: number, opts?: { durationMins?: number; start?: string; end?: string }) {
  return useQuery({
    queryKey: [api.applications.transactions.path, appId, opts?.durationMins, opts?.start, opts?.end],
    queryFn: async () => {
      const url = buildUrl(api.applications.transactions.path, { id: appId });
      const params = new URLSearchParams();
      if (opts?.durationMins) params.set("durationMins", String(opts.durationMins));
      if (opts?.start) params.set("start", opts.start);
      if (opts?.end) params.set("end", opts.end);
      const qs = params.toString();
      const res = await fetch(qs ? `${url}?${qs}` : url);
      if (!res.ok) throw new Error("Failed to fetch transactions");
      return api.applications.transactions.responses[200].parse(await res.json());
    },
    enabled: !!appId
  });
}

export function useNodes(appId: number) {
  return useQuery({
    queryKey: [api.applications.nodes.path, appId],
    queryFn: async () => {
      const url = buildUrl(api.applications.nodes.path, { id: appId });
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch nodes");
      return api.applications.nodes.responses[200].parse(await res.json());
    },
    enabled: !!appId
  });
}

export function useAppMetrics(appId: number, metricName?: string, opts?: { durationMins?: number; start?: string; end?: string }) {
  return useQuery({
    queryKey: [api.applications.metrics.path, appId, metricName, opts?.durationMins, opts?.start, opts?.end],
    queryFn: async () => {
      let url = buildUrl(api.applications.metrics.path, { id: appId });
      const params = new URLSearchParams();
      if (metricName) params.set("metricName", metricName);
      if (opts?.durationMins) params.set("durationMins", String(opts.durationMins));
      if (opts?.start) params.set("start", opts.start);
      if (opts?.end) params.set("end", opts.end);
      const qs = params.toString();
      if (qs) url += `?${qs}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch metrics");
      return api.applications.metrics.responses[200].parse(await res.json());
    },
    enabled: !!appId
  });
}

export function useIncidents(appId: number) {
  return useQuery({
    queryKey: [api.applications.incidents.path, appId],
    queryFn: async () => {
      const url = buildUrl(api.applications.incidents.path, { id: appId });
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch incidents");
      return await res.json();
    },
    enabled: !!appId
  });
}

export function useForecast(appId: number) {
  return useQuery({
    queryKey: [api.applications.forecast.path, appId],
    queryFn: async () => {
      const url = buildUrl(api.applications.forecast.path, { id: appId });
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch forecast");
      return api.applications.forecast.responses[200].parse(await res.json());
    },
    enabled: !!appId
  });
}

export function useCapacity(appId: number) {
  return useQuery({
    queryKey: [api.applications.capacity.path, appId],
    queryFn: async () => {
      const url = buildUrl(api.applications.capacity.path, { id: appId });
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch capacity data");
      return api.applications.capacity.responses[200].parse(await res.json());
    },
    enabled: !!appId
  });
}
