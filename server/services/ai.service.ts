import { db } from "../db";
import {
  dbApplications, dbIncidents, dbAlerts, dbErrors, dbServers, apmCredentials,
} from "@shared/schema";
import { eq, desc, inArray } from "drizzle-orm";
import { aiChat, aiEmbed, parseAIJson, DEFAULT_MODEL, systemPrompt } from "./ollama.service";

// ─── Org context helpers ─────────────────────────────────────────────────────

export async function getOrgCredIds(orgId: number): Promise<number[]> {
  const creds = await db
    .select({ id: apmCredentials.id })
    .from(apmCredentials)
    .where(eq(apmCredentials.organizationId, orgId));
  return creds.map((c) => c.id);
}

async function fetchOrgContext(credIds: number[]) {
  if (!credIds.length) return { incidents: [], alerts: [], errors: [], apps: [], servers: [] };

  const [incidents, alerts, errors, apps, servers] = await Promise.all([
    db.select({
      id: dbIncidents.id, title: dbIncidents.title, severity: dbIncidents.severity,
      status: dbIncidents.status, startTime: dbIncidents.startTime,
      rootCause: dbIncidents.rootCause, affectedServices: dbIncidents.affectedServices,
      source: dbIncidents.source,
    }).from(dbIncidents).where(inArray(dbIncidents.credentialId, credIds))
      .orderBy(desc(dbIncidents.startTime)).limit(25),

    db.select({
      id: dbAlerts.id, name: dbAlerts.name, severity: dbAlerts.severity,
      status: dbAlerts.status, metric: dbAlerts.metric,
      threshold: dbAlerts.threshold, currentValue: dbAlerts.currentValue,
      triggeredAt: dbAlerts.triggeredAt, applicationId: dbAlerts.applicationId,
      source: dbAlerts.source,
    }).from(dbAlerts).where(inArray(dbAlerts.credentialId, credIds))
      .orderBy(desc(dbAlerts.triggeredAt)).limit(25),

    db.select({
      id: dbErrors.id, message: dbErrors.message, errorType: dbErrors.errorType,
      severity: dbErrors.severity, frequency: dbErrors.frequency,
      frequencyTrend: dbErrors.frequencyTrend, lastOccurrence: dbErrors.lastOccurrence,
      applicationName: dbErrors.applicationName, service: dbErrors.service,
      source: dbErrors.source,
    }).from(dbErrors).where(inArray(dbErrors.credentialId, credIds))
      .orderBy(desc(dbErrors.lastOccurrence)).limit(25),

    db.select({
      id: dbApplications.id, name: dbApplications.name, status: dbApplications.status,
      source: dbApplications.source, healthRuleViolations: dbApplications.healthRuleViolations,
    }).from(dbApplications).where(inArray(dbApplications.credentialId, credIds))
      .orderBy(dbApplications.name).limit(20),

    db.select({
      id: dbServers.id, name: dbServers.name, status: dbServers.status,
      cpuUsage: dbServers.cpuUsage, memoryUsage: dbServers.memoryUsage,
      source: dbServers.source,
    }).from(dbServers).where(inArray(dbServers.credentialId, credIds))
      .orderBy(dbServers.name).limit(20),
  ]);

  return { incidents, alerts, errors, apps, servers };
}

// ─── Standard response schema enforced via prompt ────────────────────────────

const BASE_SCHEMA = `{
  "summary": "string",
  "confidence": 0.0-1.0,
  "recommendations": [{"action": "string", "impact": "string", "priority": "high|medium|low"}],
  "relatedIssues": [{"service": "string", "issueId": "string", "severity": "string"}]
}`;

// ─── 1. Causal & Predictive AI ───────────────────────────────────────────────

export async function runCausalPredictive(credIds: number[]) {
  const ctx = await fetchOrgContext(credIds);

  const prompt = `You are an observability AI. Analyse this APM telemetry and identify causal chains between incidents, alerts and errors. Predict potential failures in the next 72 hours.

APM Data (JSON):
${JSON.stringify(ctx, null, 2)}

Respond ONLY with valid JSON matching this schema:
{
  "summary": "string",
  "confidence": number 0-1,
  "causalChains": [
    {
      "id": "string",
      "title": "string",
      "confidence": number 0-100,
      "steps": [{"time": "string", "event": "string", "value": "string"}],
      "rootCause": "string",
      "recommendation": "string"
    }
  ],
  "predictions": [
    {
      "metric": "string",
      "current": number,
      "predicted72h": number,
      "riskLevel": "High|Medium|Low",
      "confidence": number 0-100,
      "action": "string"
    }
  ],
  "knowledgeGraph": {
    "nodes": [{"id": "string", "label": "string", "type": "service|database|infra", "status": "Critical|Warning|Healthy"}],
    "edges": [{"from": "string", "to": "string"}]
  },
  "recommendations": [{"action": "string", "impact": "string", "priority": "high|medium|low"}],
  "relatedIssues": [{"service": "string", "issueId": "string", "severity": "string"}]
}`;

  const resp = await aiChat({
    model: DEFAULT_MODEL,
    messages: [
      { role: "system", content: systemPrompt() },
      { role: "user", content: prompt },
    ],
    options: { temperature: 0.2 },
  });

  return parseAIJson(resp.message.content);
}

// ─── 2. Root Cause Analysis ───────────────────────────────────────────────────

export async function runRootCause(credIds: number[], incidentContext?: any) {
  const ctx = await fetchOrgContext(credIds);

  const incidentSection = incidentContext
    ? `\nFocus incident/problem:\n${JSON.stringify(incidentContext, null, 2)}\n`
    : "";

  const prompt = `You are an observability AI specialising in root cause analysis. Based on the incident data, logs, errors and alerts below, identify the root cause of the problem, quantify the probability, and list all impacted services.
${incidentSection}
Full APM context:
${JSON.stringify(ctx, null, 2)}

Respond ONLY with valid JSON matching this schema:
{
  "summary": "string — concise root cause description",
  "confidence": number 0-1,
  "rootCauseDetails": {
    "description": "string",
    "probableCause": "string",
    "evidencePoints": ["string"],
    "probabilityScore": number 0-100
  },
  "impactedServices": [
    {"name": "string", "severity": "Critical|High|Medium|Low", "affectedSince": "string"}
  ],
  "timeline": [
    {"time": "string", "event": "string", "severity": "string"}
  ],
  "recommendations": [{"action": "string", "impact": "string", "priority": "high|medium|low"}],
  "relatedIssues": [{"service": "string", "issueId": "string", "severity": "string"}]
}`;

  const resp = await aiChat({
    model: DEFAULT_MODEL,
    messages: [
      { role: "system", content: systemPrompt() },
      { role: "user", content: prompt },
    ],
    options: { temperature: 0.2 },
  });

  return parseAIJson(resp.message.content);
}

// ─── 3. Correlation Insights ──────────────────────────────────────────────────

export async function runCorrelationInsights(credIds: number[]) {
  const ctx = await fetchOrgContext(credIds);

  const prompt = `You are an observability AI. Analyse the following APM events and identify non-obvious correlations between incidents, alerts, errors and services. Surface hidden dependencies, anomaly clusters and service-event mappings.

APM Data:
${JSON.stringify(ctx, null, 2)}

Respond ONLY with valid JSON matching this schema:
{
  "summary": "string",
  "confidence": number 0-1,
  "correlations": [
    {
      "id": "string",
      "title": "string",
      "description": "string",
      "strength": number 0-1,
      "type": "causal|temporal|service|error",
      "services": ["string"],
      "evidence": ["string"]
    }
  ],
  "anomalyClusters": [
    {
      "cluster": "string",
      "events": ["string"],
      "frequency": "string",
      "impact": "High|Medium|Low"
    }
  ],
  "serviceEventMap": [
    {"service": "string", "relatedEvents": ["string"], "riskContribution": number 0-100}
  ],
  "recommendations": [{"action": "string", "impact": "string", "priority": "high|medium|low"}],
  "relatedIssues": [{"service": "string", "issueId": "string", "severity": "string"}]
}`;

  const resp = await aiChat({
    model: DEFAULT_MODEL,
    messages: [
      { role: "system", content: systemPrompt() },
      { role: "user", content: prompt },
    ],
    options: { temperature: 0.3 },
  });

  return parseAIJson(resp.message.content);
}

// ─── 4. AI Recommendations ────────────────────────────────────────────────────

export async function runRecommendations(credIds: number[], rootCauseSummary?: string) {
  const ctx = await fetchOrgContext(credIds);

  const summarySection = rootCauseSummary
    ? `\nRoot cause summary provided:\n${rootCauseSummary}\n`
    : "";

  const prompt = `You are an SRE advisor AI. Based on the observability data and root cause information below, generate a prioritised set of remediation actions with clear impact and confidence scores.
${summarySection}
APM Context:
${JSON.stringify(ctx, null, 2)}

Respond ONLY with valid JSON matching this schema:
{
  "summary": "string",
  "confidence": number 0-1,
  "immediateActions": [
    {
      "action": "string",
      "impact": "string",
      "priority": "high|medium|low",
      "effort": "low|medium|high",
      "estimatedResolutionTime": "string",
      "targetService": "string"
    }
  ],
  "preventiveActions": [
    {
      "action": "string",
      "impact": "string",
      "priority": "high|medium|low",
      "effort": "low|medium|high",
      "targetService": "string"
    }
  ],
  "recommendations": [{"action": "string", "impact": "string", "priority": "high|medium|low"}],
  "relatedIssues": [{"service": "string", "issueId": "string", "severity": "string"}]
}`;

  const resp = await aiChat({
    model: DEFAULT_MODEL,
    messages: [
      { role: "system", content: systemPrompt() },
      { role: "user", content: prompt },
    ],
    options: { temperature: 0.25 },
  });

  return parseAIJson(resp.message.content);
}

// ─── 5. Service Risk Ranking ──────────────────────────────────────────────────

export async function runServiceRiskRanking(credIds: number[]) {
  const ctx = await fetchOrgContext(credIds);

  const prompt = `You are a risk assessment AI. Analyse the following APM service metrics, incident history, alert counts and error patterns. Rank each service by its overall risk score, explaining the reasoning for each ranking.

APM Data:
${JSON.stringify(ctx, null, 2)}

Respond ONLY with valid JSON matching this schema:
{
  "summary": "string",
  "confidence": number 0-1,
  "rankings": [
    {
      "rank": number,
      "service": "string",
      "riskScore": number 0-100,
      "riskLevel": "Critical|High|Medium|Low",
      "reasoning": "string",
      "topFactors": ["string"],
      "incidents": number,
      "alerts": number,
      "errors": number,
      "trend": "Worsening|Stable|Improving"
    }
  ],
  "recommendations": [{"action": "string", "impact": "string", "priority": "high|medium|low"}],
  "relatedIssues": [{"service": "string", "issueId": "string", "severity": "string"}]
}`;

  const resp = await aiChat({
    model: DEFAULT_MODEL,
    messages: [
      { role: "system", content: systemPrompt() },
      { role: "user", content: prompt },
    ],
    options: { temperature: 0.2 },
  });

  return parseAIJson(resp.message.content);
}

// ─── RAG embedding helper ─────────────────────────────────────────────────────

export async function embedContext(text: string) {
  return aiEmbed({ model: "nomic-embed-text", input: text });
}
