import { z } from "zod";
import {
  pgTable, text, integer, boolean, real, jsonb, timestamp, serial, varchar, uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";

// ─────────────────────────────────────────────
// MULTI-TENANT AUTH TABLES
// ─────────────────────────────────────────────

export const organizations = pgTable("organizations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  plan: text("plan").notNull().default("starter"),  // "starter" | "professional" | "enterprise"
  maxUsers: integer("max_users").default(5),
  createdAt: timestamp("created_at").default(sql`now()`),
  updatedAt: timestamp("updated_at").default(sql`now()`),
});

export const insertOrganizationSchema = createInsertSchema(organizations).omit({ id: true, createdAt: true, updatedAt: true });
export type Organization = typeof organizations.$inferSelect;
export type InsertOrganization = z.infer<typeof insertOrganizationSchema>;

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  avatarInitials: text("avatar_initials"),
  isEmailVerified: boolean("is_email_verified").default(false),
  createdAt: timestamp("created_at").default(sql`now()`),
  updatedAt: timestamp("updated_at").default(sql`now()`),
});

export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true, updatedAt: true });
export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type PublicUser = Omit<User, "passwordHash">;

// Valid roles: Admin can do everything; SRE can manage integrations/view data; Business Viewer is read-only
export const ROLES = ["Admin", "SRE", "Business Viewer"] as const;
export type Role = typeof ROLES[number];

export const organizationMembers = pgTable("organization_members", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull(),
  userId: integer("user_id").notNull(),
  role: text("role").notNull().default("Business Viewer"),  // "Admin" | "SRE" | "Business Viewer"
  invitedById: integer("invited_by_id"),
  joinedAt: timestamp("joined_at").default(sql`now()`),
  createdAt: timestamp("created_at").default(sql`now()`),
});

export type OrganizationMember = typeof organizationMembers.$inferSelect;

export const invitations = pgTable("invitations", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull(),
  email: text("email").notNull(),
  role: text("role").notNull().default("Business Viewer"),
  token: text("token").notNull().unique(),
  invitedById: integer("invited_by_id").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  acceptedAt: timestamp("accepted_at"),
  createdAt: timestamp("created_at").default(sql`now()`),
});

export type Invitation = typeof invitations.$inferSelect;

export const emailVerifications = pgTable("email_verifications", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  email: text("email").notNull(),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  verifiedAt: timestamp("verified_at"),
  createdAt: timestamp("created_at").default(sql`now()`),
});

export type EmailVerification = typeof emailVerifications.$inferSelect;

export const incidentNotes = pgTable("incident_notes", {
  id: serial("id").primaryKey(),
  incidentId: text("incident_id").notNull(),
  organizationId: integer("organization_id"),
  userId: integer("user_id"),
  author: text("author").notNull(),
  role: text("role").notNull().default("Operator"),
  avatar: text("avatar").notNull().default("OP"),
  content: text("content").notNull(),
  tags: text("tags").array(),
  createdAt: timestamp("created_at").default(sql`now()`),
});

export type IncidentNote = typeof incidentNotes.$inferSelect;

// ─────────────────────────────────────────────
// ZOD SCHEMAS (frontend / API validation)
// ─────────────────────────────────────────────

export const connectionSchema = z.object({
  url: z.union([z.string().url("Must be a valid URL"), z.literal(""), z.undefined()]).optional(),
  account: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  useMock: z.boolean().default(false),
});
export type ConnectionConfig = z.infer<typeof connectionSchema>;

export const applicationSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.enum(["Healthy", "Warning", "Critical"]),
  healthRuleViolations: z.number(),
});
export type Application = z.infer<typeof applicationSchema>;

export const businessTransactionSchema = z.object({
  id: z.number(),
  name: z.string(),
  tier: z.string(),
  avgResponseTime: z.number(),
  callsPerMinute: z.number(),
  errorsPerMinute: z.number().optional().default(0),
  slowCalls: z.number().optional().default(0),
  verySlowCalls: z.number().optional().default(0),
  slowTransactionPercent: z.number().optional().default(0),
  verySlowTransactionPercent: z.number().optional().default(0),
  errorRate: z.number(),
  status: z.enum(["Normal", "Slow", "Very Slow", "Stalled", "Errors", "Warning", "Critical", "Healthy"]),
});
export type BusinessTransaction = z.infer<typeof businessTransactionSchema>;

export const nodeSchema = z.object({
  id: z.number(),
  name: z.string(),
  tier: z.string(),
  cpuUsage: z.number(),
  memoryUsage: z.number(),
  status: z.enum(["Healthy", "Warning", "Critical"]),
});
export type NodeInfo = z.infer<typeof nodeSchema>;

export const metricDataSchema = z.object({
  timestamp: z.number(),
  value: z.number(),
});
export type MetricData = z.infer<typeof metricDataSchema>;

export const problemSchema = z.object({
  id: z.number(),
  title: z.string(),
  severity: z.enum(["Warning", "Critical"]),
  startTime: z.number(),
  duration: z.number().optional(),
  status: z.enum(["Open", "Resolved"]),
  affectedTiers: z.array(z.string()),
  errorMessage: z.string().optional(),
  rootCause: z.string().optional(),
});
export type Problem = z.infer<typeof problemSchema>;

export const incidentSchema = z.object({
  id: z.number(),
  title: z.string(),
  severity: z.enum(["Warning", "Critical"]),
  startTime: z.number(),
  status: z.enum(["Open", "Resolved"]),
  affectedTiers: z.array(z.string()),
  relatedProblems: z.array(problemSchema),
  impactScore: z.number(),
  recommendation: z.string().optional(),
});
export type Incident = z.infer<typeof incidentSchema>;

export const forecastSchema = z.object({
  timestamp: z.number(),
  predictedResponseTime: z.number(),
  predictedCpu: z.number(),
  riskLevel: z.enum(["Low", "Medium", "High"]),
});
export type Forecast = z.infer<typeof forecastSchema>;

export const capacitySchema = z.object({
  tier: z.string(),
  currentCpu: z.number(),
  growthRate: z.number(),
  projectedSaturationDate: z.number(),
  recommendation: z.string(),
});
export type CapacityPlan = z.infer<typeof capacitySchema>;

// ─────────────────────────────────────────────
// DRIZZLE DATABASE TABLES
// ─────────────────────────────────────────────

// APM source credentials stored per-integration (org-scoped)
export const apmCredentials = pgTable("apm_credentials", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id"),  // null = global/env-var-based; set = org-specific
  ownerUserId: integer("owner_user_id"),       // credential owner within the organization
  source: text("source").notNull(),           // "appdynamics" | "dynatrace"
  label: text("label").notNull().default("Default"),
  controllerUrl: text("controller_url").notNull(),
  account: text("account"),                   // AppDynamics account name
  username: text("username"),                 // AppDynamics username
  passwordHash: text("password_hash"),        // stored encrypted (env var preferred)
  apiToken: text("api_token"),                // Dynatrace API token
  clientId: text("client_id"),               // AppDynamics OAuth client ID
  clientSecret: text("client_secret"),        // AppDynamics OAuth client secret
  isActive: boolean("is_active").default(true),
  lastSyncAt: timestamp("last_sync_at"),
  createdAt: timestamp("created_at").default(sql`now()`),
  updatedAt: timestamp("updated_at").default(sql`now()`),
});

export const insertApmCredentialSchema = createInsertSchema(apmCredentials).omit({ id: true, createdAt: true, updatedAt: true });
export type ApmCredential = typeof apmCredentials.$inferSelect;
export type InsertApmCredential = z.infer<typeof insertApmCredentialSchema>;

// Synced APM applications
export const dbApplications = pgTable("apm_applications", {
  id: serial("id").primaryKey(),
  externalId: text("external_id").notNull(),
  source: text("source").notNull(),           // "appdynamics" | "dynatrace"
  credentialId: integer("credential_id"),
  name: text("name").notNull(),
  status: text("status").notNull().default("Healthy"),
  healthRuleViolations: integer("health_rule_violations").default(0),
  description: text("description"),
  accountId: text("account_id"),
  tier: text("tier"),
  healthScore: integer("health_score"),
  callsPerMinute: real("calls_per_minute"),
  avgResponseTime: real("avg_response_time"),
  errorRate: real("error_rate"),
  metadata: jsonb("metadata"),
  lastSyncAt: timestamp("last_sync_at"),
  createdAt: timestamp("created_at").default(sql`now()`),
  updatedAt: timestamp("updated_at").default(sql`now()`),
}, (t) => ({
  uniqExternalSource: uniqueIndex("apm_applications_external_source_unique").on(t.externalId, t.source, t.credentialId),
}));

export const insertDbApplicationSchema = createInsertSchema(dbApplications).omit({ id: true, createdAt: true, updatedAt: true });
export type DbApplication = typeof dbApplications.$inferSelect;

// Synced incidents / problems
export const dbIncidents = pgTable("apm_incidents", {
  id: serial("id").primaryKey(),
  externalId: text("external_id").notNull(),
  source: text("source").notNull(),
  applicationId: text("application_id"),
  title: text("title").notNull(),
  severity: text("severity").notNull(),
  status: text("status").notNull(),
  startTime: timestamp("start_time"),
  endTime: timestamp("end_time"),
  rootCause: text("root_cause"),
  affectedServices: text("affected_services").array(),
  metadata: jsonb("metadata"),
  lastSyncAt: timestamp("last_sync_at"),
  createdAt: timestamp("created_at").default(sql`now()`),
  updatedAt: timestamp("updated_at").default(sql`now()`),
}, (t) => ({
  uniqExternalSource: uniqueIndex("apm_incidents_external_source_unique").on(t.externalId, t.source),
}));

export const insertDbIncidentSchema = createInsertSchema(dbIncidents).omit({ id: true, createdAt: true, updatedAt: true });
export type DbIncident = typeof dbIncidents.$inferSelect;

// Synced alerts / health rule violations
export const dbAlerts = pgTable("apm_alerts", {
  id: serial("id").primaryKey(),
  externalId: text("external_id").notNull(),
  source: text("source").notNull(),
  applicationId: text("application_id"),
  name: text("name").notNull(),
  severity: text("severity").notNull(),
  status: text("status").notNull(),
  metric: text("metric"),
  threshold: real("threshold"),
  currentValue: real("current_value"),
  triggeredAt: timestamp("triggered_at"),
  resolvedAt: timestamp("resolved_at"),
  metadata: jsonb("metadata"),
  lastSyncAt: timestamp("last_sync_at"),
  createdAt: timestamp("created_at").default(sql`now()`),
  updatedAt: timestamp("updated_at").default(sql`now()`),
}, (t) => ({
  uniqExternalSource: uniqueIndex("apm_alerts_external_source_unique").on(t.externalId, t.source),
}));

export type DbAlert = typeof dbAlerts.$inferSelect;

// Synced servers / nodes / hosts
export const dbServers = pgTable("apm_servers", {
  id: serial("id").primaryKey(),
  externalId: text("external_id").notNull(),
  source: text("source").notNull(),
  applicationId: text("application_id"),
  name: text("name").notNull(),
  ip: text("ip"),
  role: text("role"),
  tier: text("tier"),
  status: text("status").default("Healthy"),
  cpuUsage: real("cpu_usage"),
  memoryUsage: real("memory_usage"),
  diskUsage: real("disk_usage"),
  networkMbps: real("network_mbps"),
  alerts: integer("alerts").default(0),
  metadata: jsonb("metadata"),
  lastSyncAt: timestamp("last_sync_at"),
  createdAt: timestamp("created_at").default(sql`now()`),
  updatedAt: timestamp("updated_at").default(sql`now()`),
}, (t) => ({
  uniqExternalSource: uniqueIndex("apm_servers_external_source_unique").on(t.externalId, t.source),
}));

export type DbServer = typeof dbServers.$inferSelect;

// Synced business transactions
export const dbTransactions = pgTable("apm_transactions", {
  id: serial("id").primaryKey(),
  externalId: text("external_id").notNull(),
  source: text("source").notNull(),
  credentialId: integer("credential_id"),
  applicationId: text("application_id"),
  name: text("name").notNull(),
  tier: text("tier"),
  avgResponseTime: real("avg_response_time"),
  callsPerMinute: real("calls_per_minute"),
  errorRate: real("error_rate"),
  status: text("status"),
  metadata: jsonb("metadata"),
  lastSyncAt: timestamp("last_sync_at"),
  createdAt: timestamp("created_at").default(sql`now()`),
  updatedAt: timestamp("updated_at").default(sql`now()`),
}, (t) => ({
  uniqExternalSource: uniqueIndex("apm_transactions_external_source_cred_unique").on(t.externalId, t.source, t.credentialId),
}));

export type DbTransaction = typeof dbTransactions.$inferSelect;

// Error clusters / events synced from both sources
export const dbErrors = pgTable("apm_errors", {
  id: serial("id").primaryKey(),
  externalId: text("external_id").notNull(),
  source: text("source").notNull(),
  applicationId: text("application_id"),
  applicationName: text("application_name"),
  cluster: text("cluster").notNull(),
  service: text("service"),
  message: text("message"),
  errorType: text("error_type"),
  frequency: integer("frequency").default(1),
  frequencyTrend: text("frequency_trend"),
  severity: text("severity"),
  status: text("status").default("Active"),
  firstSeen: timestamp("first_seen"),
  lastOccurrence: timestamp("last_occurrence"),
  metadata: jsonb("metadata"),
  lastSyncAt: timestamp("last_sync_at"),
  createdAt: timestamp("created_at").default(sql`now()`),
  updatedAt: timestamp("updated_at").default(sql`now()`),
}, (t) => ({
  uniqExternalSource: uniqueIndex("apm_errors_external_source_unique").on(t.externalId, t.source),
}));

export type DbError = typeof dbErrors.$inferSelect;

// Metric time-series data
export const dbMetrics = pgTable("apm_metrics", {
  id: serial("id").primaryKey(),
  entityId: text("entity_id").notNull(),
  entityType: text("entity_type").notNull(),  // "application" | "server" | "service"
  source: text("source").notNull(),
  credentialId: integer("credential_id"),
  metricName: text("metric_name").notNull(),
  recordedAt: timestamp("recorded_at").notNull(),
  value: real("value"),
  createdAt: timestamp("created_at").default(sql`now()`),
});

export type DbMetric = typeof dbMetrics.$inferSelect;

// Capacity risks computed from live metrics
export const dbCapacityRisks = pgTable("apm_capacity_risks", {
  id: serial("id").primaryKey(),
  riskId: text("risk_id").notNull().unique(),
  source: text("source").notNull(),
  name: text("name").notNull(),
  type: text("type").notNull(),               // "CPU" | "Memory" | "Disk" | "Network"
  severity: text("severity").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  entityName: text("entity_name").notNull(),
  current: real("current"),
  threshold: real("threshold"),
  hoursToSaturation: real("hours_to_saturation"),
  confidence: real("confidence"),
  riskScore: integer("risk_score"),
  affectedApp: text("affected_app"),
  appId: integer("app_id"),
  metadata: jsonb("metadata"),
  computedAt: timestamp("computed_at").default(sql`now()`),
  createdAt: timestamp("created_at").default(sql`now()`),
});

export type DbCapacityRisk = typeof dbCapacityRisks.$inferSelect;

// Insight Navigator AI — chat sessions
export const insightNavSessions = pgTable("insight_nav_sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  orgId: integer("org_id").notNull(),
  title: text("title").notNull().default("New Conversation"),
  createdAt: timestamp("created_at").default(sql`now()`),
  updatedAt: timestamp("updated_at").default(sql`now()`),
});

// Insight Navigator AI — messages per session
export const insightNavMessages = pgTable("insight_nav_messages", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull(),
  role: text("role").notNull(), // "user" | "assistant"
  content: text("content").notNull(),
  structuredData: jsonb("structured_data"), // parsed AI JSON with relatedIncidents etc.
  createdAt: timestamp("created_at").default(sql`now()`),
});

// Sync operation audit log
export const dbSyncLogs = pgTable("apm_sync_logs", {
  id: serial("id").primaryKey(),
  source: text("source").notNull(),
  credentialId: integer("credential_id"),
  startedAt: timestamp("started_at").default(sql`now()`),
  completedAt: timestamp("completed_at"),
  status: text("status").notNull().default("running"),  // "running" | "success" | "failed" | "partial"
  recordsSynced: integer("records_synced").default(0),
  applicationsCount: integer("applications_count").default(0),
  incidentsCount: integer("incidents_count").default(0),
  alertsCount: integer("alerts_count").default(0),
  serversCount: integer("servers_count").default(0),
  errorMessage: text("error_message"),
  metadata: jsonb("metadata"),
});

export type DbSyncLog = typeof dbSyncLogs.$inferSelect;
