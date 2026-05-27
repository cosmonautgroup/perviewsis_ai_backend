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

export interface AppDRequestSnapshot {
  requestGUID?: string;
  localStartTime?: number;
  serverStartTime?: number;
  timeTakenInMilliSecs?: number;
  URL?: string;
  summary?: string;
  errorOccured?: boolean;
  errorSummary?: string;
  errorDetails?: any[];
  stackTraces?: any[];
  transactionEvents?: any[];
  httpParameters?: { name?: string; value?: string }[];
  hasDeepDiveData?: boolean;
  userExperience?: string;
  businessTransactionId?: number;
  businessTransactionName?: string;
  tierName?: string;
  applicationComponentName?: string;
  applicationComponentNodeName?: string;
  applicationComponentNodeId?: number;
  nodeName?: string;
  requestPath?: string;
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

  async getBusinessTransactions(appId: number, durationMins?: number): Promise<AppDBusinessTransaction[]> {
    const params: Record<string, string> = {};
    if (durationMins && Number.isFinite(durationMins) && durationMins > 0) {
      params["time-range-type"] = "BEFORE_NOW";
      params["duration-in-mins"] = String(durationMins);
    }
    return this.request<AppDBusinessTransaction[]>(`/applications/${appId}/business-transactions`, params);
  }

  async getProblems(appId: number, durationMins = 1440): Promise<AppDProblem[]> {
    return this.request<AppDProblem[]>(`/applications/${appId}/problems`, {
      "time-range-type": "BEFORE_NOW",
      "duration-in-mins": String(durationMins),
    });
  }

  async getHealthRuleViolations(appId: number, durationMins = 1440): Promise<AppDHealthRuleViolation[]> {
    return this.request<AppDHealthRuleViolation[]>(
      `/applications/${appId}/problems/healthrule-violations`,
      { "time-range-type": "BEFORE_NOW", "duration-in-mins": String(durationMins) }
    );
  }

  async getMetrics(appId: number, metricPath: string, durationMins = 60): Promise<AppDMetricData[]> {
    return this.request<AppDMetricData[]>(`/applications/${appId}/metric-data`, {
      "metric-path": metricPath,
      "time-range-type": "BEFORE_NOW",
      "duration-in-mins": String(durationMins),
      "rollup": "false",
    });
  }

  async getCpuMetrics(appId: number): Promise<AppDMetricData[]> {
    return this.getMetrics(appId, "Application Infrastructure Performance|*|Individual Nodes|*|Hardware Resources|CPU|%Busy");
  }

  async getMemoryMetrics(appId: number): Promise<AppDMetricData[]> {
    return this.getMetrics(appId, "Application Infrastructure Performance|*|Individual Nodes|*|Hardware Resources|Memory|Used %");
  }

  async getResponseTimeMetrics(appId: number, durationMins = 60): Promise<AppDMetricData[]> {
    return this.getMetrics(appId, "Overall Application Performance|Average Response Time (ms)", durationMins);
  }

  async getCallsPerMinuteMetrics(appId: number, durationMins = 60): Promise<AppDMetricData[]> {
    return this.getMetrics(appId, "Overall Application Performance|Calls per Minute", durationMins);
  }

  async getErrorRateMetrics(appId: number, durationMins = 60): Promise<AppDMetricData[]> {
    return this.getMetrics(appId, "Overall Application Performance|Errors per Minute", durationMins);
  }

  async getEvents(appId: number, eventTypes = "APPLICATION_ERROR,DIAGNOSTIC_SESSION", durationMins = 1440): Promise<any[]> {
    return this.request<any[]>(`/applications/${appId}/events`, {
      "time-range-type": "BEFORE_NOW",
      "duration-in-mins": String(durationMins),
      "event-types": eventTypes,
      "severities": "ERROR,WARN",
    });
  }

  async getRequestSnapshots(appId: number, businessTransactionId: number, durationMins = 60): Promise<AppDRequestSnapshot[]> {
    return this.request<AppDRequestSnapshot[]>(`/applications/${appId}/request-snapshots`, {
      "time-range-type": "BEFORE_NOW",
      "duration-in-mins": String(durationMins),
      "business-transaction-ids": String(businessTransactionId),
      "need-props": "true",
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
