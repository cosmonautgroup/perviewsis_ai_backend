/**
 * AppDynamics REST API Client
 * Docs: https://docs.appdynamics.com/display/PRO21/AppDynamics+APIs
 *
 * Authentication: Basic Auth — {account}@{username}:{password}
 *   OR OAuth2 token from POST /controller/api/oauth/access_token
 *
 * Base URL: {controllerUrl}/controller/rest
 */

export interface AppDynamicsConfig {
  controllerUrl: string;   // e.g. https://mycompany.saas.appdynamics.com
  account: string;         // e.g. customer1
  username: string;        // e.g. admin
  password: string;        // password or API client secret
  clientId?: string;       // OAuth client ID (alternative to password auth)
  clientSecret?: string;   // OAuth client secret
}

export interface AppDApp {
  id: number;
  name: string;
  description: string;
  accountGuid: string;
}

export interface AppDNode {
  id: number;
  name: string;
  tierId: number;
  tierName: string;
  appAgentPresent: boolean;
  machineAgentPresent: boolean;
  ipAddresses?: { ipAddresses?: string[] };
}

export interface AppDTier {
  id: number;
  name: string;
  description?: string;
  type?: string;
  numberOfNodes?: number;
}

export interface AppDBusinessTransaction {
  id: number;
  name: string;
  tierId: number;
  tierName: string;
  averageResponseTime: number;
  callsPerMinute: number;
  errorsPerMinute: number;
}

export interface AppDProblem {
  id: number;
  name: string;
  severity: string;
  status: string;
  startTime: number;
  endTime?: number;
  description: string;
  affectedEntityDefinitions: { entityType: string; name: string }[];
}

export interface AppDHealthRuleViolation {
  id: number;
  name: string;
  affectedEntityType: string;
  affectedEntityName: string;
  severity: string;
  occurrenceTime: number;
  resolvedTime?: number;
  healthRuleName: string;
  incidentStatus: string;
}

export interface AppDMetricData {
  metricName: string;
  metricPath: string;
  metricValues: { startTimeInMillis: number; value: number; count: number }[];
}

export class AppDynamicsClient {
  private baseUrl: string;
  private authHeader: string;
  private config: AppDynamicsConfig;

  constructor(config: AppDynamicsConfig) {
    this.config = config;
    this.baseUrl = `${config.controllerUrl.replace(/\/$/, "")}/controller/rest`;
    // AppDynamics SaaS Basic Auth format: {username}@{account}:{password}
    // Guard against double-appending: if username already ends with @{account}, use it as-is
    const accountSuffix = `@${config.account}`;
    const normalizedUsername = config.username.endsWith(accountSuffix)
      ? config.username
      : `${config.username}${accountSuffix}`;
    const creds = `${normalizedUsername}:${config.password}`;
    this.authHeader = `Basic ${Buffer.from(creds).toString("base64")}`;
  }

  private async request<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set("output", "JSON");
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`AppDynamics API ${res.status}: ${text.slice(0, 200)}`);
    }

    return res.json() as Promise<T>;
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.request("/applications");
      return { ok: true, message: "Connected to AppDynamics successfully" };
    } catch (err: any) {
      return { ok: false, message: err.message };
    }
  }

  async getApplications(): Promise<AppDApp[]> {
    return this.request<AppDApp[]>("/applications");
  }

  async getNodes(appId: number): Promise<AppDNode[]> {
    return this.request<AppDNode[]>(`/applications/${appId}/nodes`);
  }

  async getTiers(appId: number): Promise<AppDTier[]> {
    return this.request<AppDTier[]>(`/applications/${appId}/tiers`);
  }

  async getBusinessTransactions(appId: number): Promise<AppDBusinessTransaction[]> {
    return this.request<AppDBusinessTransaction[]>(`/applications/${appId}/business-transactions`);
  }

  async getProblems(appId: number, durationMins = 1440): Promise<AppDProblem[]> {
    return this.request<AppDProblem[]>(`/applications/${appId}/problems`, {
      "time-range-type": "BEFORE_NOW",
      "duration-in-mins": String(durationMins),
    });
  }

  async getHealthRuleViolations(appId: number, durationMins = 1440): Promise<AppDHealthRuleViolation[]> {
    return this.request<AppDHealthRuleViolation[]>(
      `/applications/${appId}/healthrule-violations`,
      { "time-range-type": "BEFORE_NOW", "duration-in-mins": String(durationMins) }
    );
  }

  async getMetricData(appId: number, metricPath: string, durationMins = 60): Promise<AppDMetricData[]> {
    return this.request<AppDMetricData[]>(`/applications/${appId}/metric-data`, {
      "metric-path": metricPath,
      "time-range-type": "BEFORE_NOW",
      "duration-in-mins": String(durationMins),
    });
  }

  async getCpuMetrics(appId: number, durationMins = 60): Promise<AppDMetricData[]> {
    return this.getMetricData(appId, "Application Infrastructure Performance|*|Individual Nodes|*|Hardware Resources|CPU|%Busy", durationMins);
  }

  async getMemoryMetrics(appId: number, durationMins = 60): Promise<AppDMetricData[]> {
    return this.getMetricData(appId, "Application Infrastructure Performance|*|Individual Nodes|*|Hardware Resources|Memory|Used %", durationMins);
  }

  async getResponseTimeMetrics(appId: number, durationMins = 60): Promise<AppDMetricData[]> {
    return this.getMetricData(appId, "Overall Application Performance|Average Response Time (ms)", durationMins);
  }

  async getErrorRateMetrics(appId: number, durationMins = 60): Promise<AppDMetricData[]> {
    return this.getMetricData(appId, "Overall Application Performance|Errors per Minute", durationMins);
  }

  async getEvents(appId: number, eventTypes = "APPLICATION_ERROR,DIAGNOSTIC_SESSION", durationMins = 1440): Promise<any[]> {
    return this.request<any[]>(`/applications/${appId}/events`, {
      "time-range-type": "BEFORE_NOW",
      "duration-in-mins": String(durationMins),
      "event-types": eventTypes,
      "severities": "ERROR,WARN",
    });
  }
}

/** Factory — creates a client from environment variables if credentials not passed */
export function createAppDynamicsClient(overrides?: Partial<AppDynamicsConfig>): AppDynamicsClient | null {
  const controllerUrl = overrides?.controllerUrl ?? process.env.APPDYNAMICS_URL;
  const account = overrides?.account ?? process.env.APPDYNAMICS_ACCOUNT;
  const username = overrides?.username ?? process.env.APPDYNAMICS_USERNAME;
  const password = overrides?.password ?? process.env.APPDYNAMICS_PASSWORD;

  if (!controllerUrl || !account || !username || !password) return null;
  return new AppDynamicsClient({ controllerUrl, account, username, password });
}

