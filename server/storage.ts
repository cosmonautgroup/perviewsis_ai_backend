import {
  Application, BusinessTransaction, NodeInfo, Problem,
  Incident, Forecast, CapacityPlan, MetricData, ConnectionConfig
} from "@shared/schema";

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  company: string;
  role: "Admin" | "SRE" | "Business Viewer";
  timezone: string;
  theme: "light" | "dark" | "system";
  twoFactorEnabled: boolean;
  notifications: {
    emailAlerts: boolean;
    incidentAlerts: boolean;
    slaBreachAlerts: boolean;
    weeklyReport: boolean;
  };
  sessions: Array<{
    id: string;
    device: string;
    ip: string;
    location: string;
    lastActive: number;
    current: boolean;
  }>;
}

export interface Integration {
  id: string;
  type: "appdynamics" | "otel" | "dynatrace";
  name: string;
  environment: "Production" | "Staging" | "QA" | "Development";
  status: "Connected" | "Disconnected" | "Error";
  lastSync: number;
  config: Record<string, string>;
}

export interface Subscription {
  plan: "starter" | "professional" | "enterprise";
  cycle: "monthly" | "annual";
  usage: {
    integrations: number;
    apps: number;
    apiCallsToday: number;
    ingestionGbMonth: number;
  };
  limits: {
    integrations: number | null;
    apps: number | null;
    apiCallsDay: number | null;
  };
  renewalDate: number;
  trialDaysLeft: number | null;
  invoices: Array<{
    id: string;
    date: number;
    amount: number;
    status: "Paid" | "Pending" | "Failed";
    description: string;
  }>;
  paymentMethod: {
    type: string;
    last4: string;
    expiry: string;
  } | null;
}

export interface IStorage {
  saveConnection(config: ConnectionConfig): Promise<void>;
  getConnection(): Promise<ConnectionConfig | null>;
  getApplications(): Promise<Application[]>;
  getApplication(id: number): Promise<Application | undefined>;
  getBusinessTransactions(appId: number): Promise<BusinessTransaction[]>;
  getNodes(appId: number): Promise<NodeInfo[]>;
  getMetrics(appId: number, metricName?: string): Promise<MetricData[]>;
  getIncidents(appId: number): Promise<Incident[]>;
  getForecast(appId: number): Promise<Forecast[]>;
  getCapacity(appId: number): Promise<CapacityPlan[]>;
  getProblem(id: number): Promise<Problem | undefined>;
  getProblemMetrics(id: number): Promise<{before: MetricData[], during: MetricData[], after: MetricData[]}>;
  getOtelStats(): Promise<any>;
  getPersonaBusiness(): Promise<any>;
  getPersonaSre(): Promise<any>;
  getRuntimeMetrics(service: string): Promise<any>;
  getAiInsights(): Promise<any>;
  getAutomationTimeline(): Promise<any>;
  getMaturityData(): Promise<any>;
  getCostAnalysis(): Promise<any>;
  getProfile(): Promise<UserProfile>;
  updateProfile(updates: Partial<UserProfile>): Promise<UserProfile>;
  revokeSession(sessionId: string): Promise<void>;
  getIntegrations(): Promise<Integration[]>;
  createIntegration(data: Omit<Integration, 'id' | 'lastSync' | 'status'>): Promise<Integration>;
  updateIntegration(id: string, data: Partial<Integration>): Promise<Integration | undefined>;
  deleteIntegration(id: string): Promise<void>;
  testIntegration(id: string): Promise<{ success: boolean; message: string }>;
  getSubscription(): Promise<Subscription>;
  updateSubscription(updates: Partial<Subscription>): Promise<Subscription>;
  getCapacityRisks(): Promise<any[]>;
  getCapacityRiskDetail(riskId: string): Promise<any>;
  getCapacityRiskRelatedIncidents(riskId: string): Promise<any[]>;
  getCapacityRiskRelatedAlerts(riskId: string): Promise<any[]>;
  getCapacityRiskRelatedErrors(riskId: string): Promise<any[]>;
  getCapacityRiskRelatedTransactions(riskId: string): Promise<any[]>;
  getCapacityRiskRelatedServicesNodes(riskId: string): Promise<any>;
  getEntityCapacityRisks(entityType: string, entityId: string): Promise<any[]>;
  getCapacityPlanningGlobal(): Promise<any>;
  getCapacityPlanningApp(appId: number): Promise<any>;
  getCapacityPlanningCluster(clusterId: string): Promise<any>;
  getCorrelationGraph(entityId: string, type: string): Promise<any>;
  getIncidentRelated(incidentId: string): Promise<any>;
  getAlertRelated(alertId: string): Promise<any>;
  getErrorRelated(errorId: string): Promise<any>;
  getNodeRelated(nodeId: string): Promise<any>;
  getAlerts(): Promise<any[]>;
  getAlertDetail(alertId: string): Promise<any>;
  getAlertAIAnalysis(alertId: string): Promise<any>;
  getErrors(): Promise<any[]>;
  getErrorDetail(errorId: string): Promise<any>;
  getErrorAIAnalysis(errorId: string): Promise<any>;
  getErrorCorrelated(errorId: string): Promise<any>;
  getErrorPredictions(errorId: string): Promise<any>;
  getCorrelatedErrors(alertId: string): Promise<any[]>;
  getIncidentDetail(incidentId: string): Promise<any>;
  getApplicationRichData(id: number): Promise<any>;
  getServiceRiskRankings(appId: number): Promise<any[]>;
  getHttpErrorCategories(appId: number): Promise<any[]>;
  getDependencyErrors(appId: number): Promise<any[]>;
  getServersList(appId: number): Promise<any[]>;
  getServerDetail(appId: number, serverId: number): Promise<any>;
}

const EMPTY_SUBSCRIPTION: Subscription = {
  plan: "starter",
  cycle: "monthly",
  usage: { integrations: 0, apps: 0, apiCallsToday: 0, ingestionGbMonth: 0 },
  limits: { integrations: 5, apps: 10, apiCallsDay: 10000 },
  renewalDate: Date.now() + 30 * 24 * 3600000,
  trialDaysLeft: null,
  invoices: [],
  paymentMethod: null,
};

const EMPTY_PROFILE: UserProfile = {
  id: "0",
  name: "",
  email: "",
  company: "",
  role: "Admin",
  timezone: "UTC",
  theme: "dark",
  twoFactorEnabled: false,
  notifications: { emailAlerts: true, incidentAlerts: true, slaBreachAlerts: true, weeklyReport: false },
  sessions: [],
};

export class MemStorage implements IStorage {
  private connection: ConnectionConfig | null = null;
  private subscription: Subscription = { ...EMPTY_SUBSCRIPTION };
  private profile: UserProfile = { ...EMPTY_PROFILE };

  async saveConnection(config: ConnectionConfig): Promise<void> { this.connection = config; }
  async getConnection(): Promise<ConnectionConfig | null> { return this.connection; }

  async getApplications(): Promise<Application[]> { return []; }
  async getApplication(_id: number): Promise<Application | undefined> { return undefined; }
  async getBusinessTransactions(_appId: number): Promise<BusinessTransaction[]> { return []; }
  async getNodes(_appId: number): Promise<NodeInfo[]> { return []; }
  async getMetrics(_appId: number, _metricName?: string): Promise<MetricData[]> { return []; }
  async getIncidents(_appId: number): Promise<Incident[]> { return []; }
  async getForecast(_appId: number): Promise<Forecast[]> { return []; }
  async getCapacity(_appId: number): Promise<CapacityPlan[]> { return []; }
  async getProblem(_id: number): Promise<Problem | undefined> { return undefined; }
  async getProblemMetrics(_id: number): Promise<{before: MetricData[], during: MetricData[], after: MetricData[]}> {
    return { before: [], during: [], after: [] };
  }
  async getOtelStats(): Promise<any> { return {}; }
  async getPersonaBusiness(): Promise<any> { return {}; }
  async getPersonaSre(): Promise<any> { return {}; }
  async getRuntimeMetrics(_service: string): Promise<any> { return {}; }
  async getAiInsights(): Promise<any> { return { insights: [] }; }
  async getAutomationTimeline(): Promise<any> { return { events: [] }; }
  async getMaturityData(): Promise<any> { return {}; }
  async getCostAnalysis(): Promise<any> { return {}; }

  async getProfile(): Promise<UserProfile> { return { ...this.profile }; }
  async updateProfile(updates: Partial<UserProfile>): Promise<UserProfile> {
    this.profile = { ...this.profile, ...updates };
    return { ...this.profile };
  }
  async revokeSession(_sessionId: string): Promise<void> { /* no-op */ }

  async getIntegrations(): Promise<Integration[]> { return []; }
  async createIntegration(data: Omit<Integration, 'id' | 'lastSync' | 'status'>): Promise<Integration> {
    return { ...data, id: `int_${Date.now()}`, status: "Connected", lastSync: Date.now() };
  }
  async updateIntegration(_id: string, _data: Partial<Integration>): Promise<Integration | undefined> { return undefined; }
  async deleteIntegration(_id: string): Promise<void> { /* no-op */ }
  async testIntegration(_id: string): Promise<{ success: boolean; message: string }> {
    return { success: false, message: "Integration not found" };
  }

  async getSubscription(): Promise<Subscription> { return { ...this.subscription }; }
  async updateSubscription(updates: Partial<Subscription>): Promise<Subscription> {
    this.subscription = { ...this.subscription, ...updates };
    return { ...this.subscription };
  }

  async getCapacityRisks(): Promise<any[]> { return []; }
  async getCapacityRiskDetail(_riskId: string): Promise<any> { return null; }
  async getCapacityRiskRelatedIncidents(_riskId: string): Promise<any[]> { return []; }
  async getCapacityRiskRelatedAlerts(_riskId: string): Promise<any[]> { return []; }
  async getCapacityRiskRelatedErrors(_riskId: string): Promise<any[]> { return []; }
  async getCapacityRiskRelatedTransactions(_riskId: string): Promise<any[]> { return []; }
  async getCapacityRiskRelatedServicesNodes(_riskId: string): Promise<any> { return { services: [], nodes: [] }; }
  async getEntityCapacityRisks(_entityType: string, _entityId: string): Promise<any[]> { return []; }
  async getCapacityPlanningGlobal(): Promise<any> { return {}; }
  async getCapacityPlanningApp(_appId: number): Promise<any> { return {}; }
  async getCapacityPlanningCluster(_clusterId: string): Promise<any> { return {}; }

  async getCorrelationGraph(_entityId: string, _type: string): Promise<any> { return { nodes: [], edges: [] }; }
  async getIncidentRelated(_incidentId: string): Promise<any> { return { alerts: [], errors: [], nodes: [] }; }
  async getAlertRelated(_alertId: string): Promise<any> { return { incidents: [], errors: [], nodes: [] }; }
  async getErrorRelated(_errorId: string): Promise<any> { return { incidents: [], alerts: [], nodes: [] }; }
  async getNodeRelated(_nodeId: string): Promise<any> { return { incidents: [], alerts: [], errors: [] }; }

  async getAlerts(): Promise<any[]> { return []; }
  async getAlertDetail(_alertId: string): Promise<any> { return null; }
  async getAlertAIAnalysis(_alertId: string): Promise<any> {
    return { summary: "", rootCause: "", recommendations: [], confidence: 0 };
  }
  async getErrors(): Promise<any[]> { return []; }
  async getErrorDetail(_errorId: string): Promise<any> { return null; }
  async getErrorAIAnalysis(_errorId: string): Promise<any> {
    return { summary: "", rootCause: "", recommendations: [], confidence: 0 };
  }
  async getErrorCorrelated(_errorId: string): Promise<any[]> { return []; }
  async getErrorPredictions(_errorId: string): Promise<any[]> { return []; }
  async getCorrelatedErrors(_alertId: string): Promise<any[]> { return []; }

  async getIncidentDetail(_incidentId: string): Promise<any> { return null; }
  async getApplicationRichData(_id: number): Promise<any> { return {}; }
  async getServiceRiskRankings(_appId: number): Promise<any[]> { return []; }
  async getHttpErrorCategories(_appId: number): Promise<any[]> { return []; }
  async getDependencyErrors(_appId: number): Promise<any[]> { return []; }
  async getServersList(_appId: number): Promise<any[]> { return []; }
  async getServerDetail(_appId: number, _serverId: number): Promise<any> { return null; }
}

export const storage = new MemStorage();
