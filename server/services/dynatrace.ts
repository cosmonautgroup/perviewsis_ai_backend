/**
 * Dynatrace REST API v2 Client
 * Docs: https://www.dynatrace.com/support/help/dynatrace-api
 *
 * Authentication: Authorization: Api-Token {token}
 * Base URL: {environmentUrl}/api/v2
 */

export interface DynatraceConfig {
  environmentUrl: string;  // e.g. https://abc12345.live.dynatrace.com
  apiToken: string;        // API token with scopes: problems.read, entities.read, metrics.read, logs.read
}

export interface DTEntity {
  entityId: string;
  displayName: string;
  type: string;
  properties?: Record<string, any>;
  tags?: { key: string; value?: string }[];
  fromRelationships?: Record<string, any>;
}

export interface DTProblem {
  problemId: string;
  displayId: string;
  title: string;
  severityLevel: string;  // "AVAILABILITY" | "ERROR" | "PERFORMANCE" | "RESOURCE_CONTENTION" | "CUSTOM_ALERT"
  status: string;         // "OPEN" | "CLOSED"
  startTime: number;
  endTime?: number;
  impactedEntities: { entityId: { id: string; type: string }; name: string }[];
  rootCauseEntity?: { entityId: { id: string; type: string }; name: string };
}

export interface DTMetricSeries {
  metricId: string;
  data: { timestamps: number[]; values: (number | null)[] }[];
}

export interface DTMetricResult {
  resolution: string;
  result: DTMetricSeries[];
}

export interface DTLogRecord {
  timestamp: string;
  level: string;
  content: string;
  additionalColumns: Record<string, string[]>;
}

export class DynatraceClient {
  private baseUrl: string;
  private config: DynatraceConfig;

  constructor(config: DynatraceConfig) {
    this.config = config;
    this.baseUrl = `${config.environmentUrl.replace(/\/$/, "")}/api/v2`;
  }

  private async request<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Api-Token ${this.config.apiToken}`,
        Accept: "application/json; charset=utf-8",
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Dynatrace API ${res.status}: ${text.slice(0, 200)}`);
    }

    return res.json() as Promise<T>;
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.request<any>("/entities", { entitySelector: "type(SERVICE)", pageSize: "1" });
      return { ok: true, message: "Connected to Dynatrace successfully" };
    } catch (err: any) {
      return { ok: false, message: err.message };
    }
  }

  async getProblems(from = "now-24h"): Promise<{ problems: DTProblem[]; totalCount: number }> {
    return this.request("/problems", { from, pageSize: "100" });
  }

  async getServices(pageSize = "100"): Promise<{ entities: DTEntity[]; totalCount: number }> {
    return this.request("/entities", {
      entitySelector: "type(SERVICE)",
      fields: "properties,tags",
      pageSize,
    });
  }

  async getHosts(pageSize = "100"): Promise<{ entities: DTEntity[]; totalCount: number }> {
    return this.request("/entities", {
      entitySelector: "type(HOST)",
      fields: "properties,tags",
      pageSize,
    });
  }

  async getProcessGroups(pageSize = "100"): Promise<{ entities: DTEntity[]; totalCount: number }> {
    return this.request("/entities", {
      entitySelector: "type(PROCESS_GROUP)",
      fields: "properties,tags",
      pageSize,
    });
  }

  async getMetrics(metricSelector: string, from = "now-1h", resolution = "5m"): Promise<DTMetricResult> {
    return this.request("/metrics/query", { metricSelector, from, resolution });
  }

  async getCpuMetrics(from = "now-1h"): Promise<DTMetricResult> {
    return this.getMetrics("builtin:host.cpu.usage", from);
  }

  async getMemoryMetrics(from = "now-1h"): Promise<DTMetricResult> {
    return this.getMetrics("builtin:host.mem.usage", from);
  }

  async getDiskMetrics(from = "now-1h"): Promise<DTMetricResult> {
    return this.getMetrics("builtin:host.disk.usedPct", from);
  }

  async getNetworkMetrics(from = "now-1h"): Promise<DTMetricResult> {
    return this.getMetrics("builtin:host.net.bytesRx", from);
  }

  async getServiceResponseTime(from = "now-1h"): Promise<DTMetricResult> {
    return this.getMetrics("builtin:service.response.time", from);
  }

  async getServiceErrorRate(from = "now-1h"): Promise<DTMetricResult> {
    return this.getMetrics("builtin:service.errors.total.rate", from);
  }

  async getServiceThroughput(from = "now-1h"): Promise<DTMetricResult> {
    return this.getMetrics("builtin:service.requestCount.total", from);
  }

  async getEvents(from = "now-24h", eventType?: string): Promise<{ events: any[]; totalCount: number }> {
    const params: Record<string, string> = { from, pageSize: "100" };
    if (eventType) params.eventType = eventType;
    return this.request("/events", params);
  }

  async getLogs(query = "status:error", from = "now-1h"): Promise<{ results: DTLogRecord[]; sliceSize: number }> {
    return this.request("/logs/search", { query, from, pageSize: "100" });
  }

  async getAvailabilityZones(): Promise<any> {
    return this.request("/entities", { entitySelector: "type(CLOUD_APPLICATION_NAMESPACE)" });
  }
}

/** Normalize Dynatrace severity to our common format */
export function normalizeDTSeverity(level: string): string {
  switch (level) {
    case "AVAILABILITY": return "Critical";
    case "ERROR": return "Critical";
    case "PERFORMANCE": return "High";
    case "RESOURCE_CONTENTION": return "High";
    case "CUSTOM_ALERT": return "Medium";
    default: return "Medium";
  }
}

/** Normalize Dynatrace problem status to our format */
export function normalizeDTStatus(status: string): string {
  return status === "OPEN" ? "Open" : "Resolved";
}

/** Factory — creates a client from environment variables if credentials not passed */
export function createDynatraceClient(overrides?: Partial<DynatraceConfig>): DynatraceClient | null {
  const environmentUrl = overrides?.environmentUrl ?? process.env.DYNATRACE_URL;
  const apiToken = overrides?.apiToken ?? process.env.DYNATRACE_TOKEN;
  if (!environmentUrl || !apiToken) return null;
  return new DynatraceClient({ environmentUrl, apiToken });
}
