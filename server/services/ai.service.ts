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

  const apps = await db.select({
    id: dbApplications.id, name: dbApplications.name, status: dbApplications.status,
    source: dbApplications.source, healthRuleViolations: dbApplications.healthRuleViolations,
    externalId: dbApplications.externalId,
  }).from(dbApplications).where(inArray(dbApplications.credentialId, credIds))
    .orderBy(dbApplications.name).limit(20);

  const appExternalIds = apps.map((a) => String(a.externalId ?? "")).filter(Boolean);

  const [incidents, alerts, errors, servers] = appExternalIds.length > 0
    ? await Promise.all([
        db.select({
          id: dbIncidents.id, title: dbIncidents.title, severity: dbIncidents.severity,
          status: dbIncidents.status, startTime: dbIncidents.startTime,
          rootCause: dbIncidents.rootCause, affectedServices: dbIncidents.affectedServices,
          source: dbIncidents.source, applicationId: dbIncidents.applicationId,
        }).from(dbIncidents).where(inArray(dbIncidents.applicationId, appExternalIds))
          .orderBy(desc(dbIncidents.startTime)).limit(25),

        db.select({
          id: dbAlerts.id, name: dbAlerts.name, severity: dbAlerts.severity,
          status: dbAlerts.status, metric: dbAlerts.metric,
          threshold: dbAlerts.threshold, currentValue: dbAlerts.currentValue,
          triggeredAt: dbAlerts.triggeredAt, applicationId: dbAlerts.applicationId,
          source: dbAlerts.source,
        }).from(dbAlerts).where(inArray(dbAlerts.applicationId, appExternalIds))
          .orderBy(desc(dbAlerts.triggeredAt)).limit(25),

        db.select({
          id: dbErrors.id, message: dbErrors.message, errorType: dbErrors.errorType,
          severity: dbErrors.severity, frequency: dbErrors.frequency,
          frequencyTrend: dbErrors.frequencyTrend, lastOccurrence: dbErrors.lastOccurrence,
          applicationName: dbErrors.applicationName, service: dbErrors.service,
          source: dbErrors.source, applicationId: dbErrors.applicationId,
        }).from(dbErrors).where(inArray(dbErrors.applicationId, appExternalIds))
          .orderBy(desc(dbErrors.lastOccurrence)).limit(25),

        db.select({
          id: dbServers.id, name: dbServers.name, status: dbServers.status,
          cpuUsage: dbServers.cpuUsage, memoryUsage: dbServers.memoryUsage,
          source: dbServers.source, applicationId: dbServers.applicationId,
        }).from(dbServers).where(inArray(dbServers.applicationId, appExternalIds))
          .orderBy(dbServers.name).limit(20),
      ])
    : [[], [], [], []];

  return { incidents, alerts, errors, apps, servers };
}

function buildApplicationPredictions(ctx: any) {
  const byExternalId = new Map<string, any>();
  for (const app of ctx.apps ?? []) {
    const externalId = String(app.externalId ?? "");
    if (!externalId) continue;
    byExternalId.set(externalId, {
      applicationId: app.id,
      externalId,
      application: app.name ?? `Application ${app.id}`,
      source: app.source ?? "unknown",
      incidents: 0,
      alerts: 0,
      errors: 0,
      servers: 0,
      riskScore: 0,
      riskLevel: "Low",
      trend72h: "Stable",
    });
  }

  for (const inc of ctx.incidents ?? []) {
    const key = String(inc.applicationId ?? "");
    const row = byExternalId.get(key);
    if (row) row.incidents += 1;
  }
  for (const alert of ctx.alerts ?? []) {
    const key = String(alert.applicationId ?? "");
    const row = byExternalId.get(key);
    if (row) row.alerts += 1;
  }
  for (const err of ctx.errors ?? []) {
    const key = String(err.applicationId ?? "");
    const row = byExternalId.get(key);
    if (row) row.errors += Number(err.frequency ?? 1);
  }
  for (const srv of ctx.servers ?? []) {
    const key = String(srv.applicationId ?? "");
    const row = byExternalId.get(key);
    if (row) row.servers += 1;
  }

  const rows = Array.from(byExternalId.values()).map((r) => {
    const score = Math.min(100, (r.incidents * 20) + (r.alerts * 8) + (r.errors * 2) + (r.servers > 0 ? 5 : 0));
    const riskLevel = score >= 70 ? "High" : score >= 35 ? "Medium" : "Low";
    const trend72h = score >= 70 ? "Worsening" : score >= 35 ? "Watch" : "Stable";
    return { ...r, riskScore: score, riskLevel, trend72h };
  });

  return rows
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 12);
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
  const applicationPredictions = buildApplicationPredictions(ctx);

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

  const parsed = parseAIJson(resp.message.content);
  return {
    ...parsed,
    applicationPredictions: Array.isArray(parsed?.applicationPredictions) && parsed.applicationPredictions.length
      ? parsed.applicationPredictions
      : applicationPredictions,
  };
}

export async function runCausalPredictiveFallback(credIds: number[]) {
  const ctx = await fetchOrgContext(credIds);
  const applicationPredictions = buildApplicationPredictions(ctx);
  const incidentCount = ctx.incidents.length;
  const alertCount = ctx.alerts.length;
  const errorCount = ctx.errors.length;
  const serverCount = ctx.servers.length;
  const appCount = ctx.apps.length;

  const topIncident = ctx.incidents[0];
  const topAlert = ctx.alerts[0];
  const topError = ctx.errors[0];

  const causalChains = topIncident ? [
    {
      id: `fallback-chain-${topIncident.id}`,
      title: topIncident.title ?? "Primary active incident",
      confidence: 62,
      steps: [
        { time: "T-60m", event: topAlert?.name ?? "Alert threshold breached", value: `${topAlert?.metric ?? "metric"} elevated` },
        { time: "T-30m", event: topError?.errorType ?? "Error rate increase", value: `${topError?.frequency ?? 0} events` },
        { time: "T-0m", event: topIncident.title ?? "Incident opened", value: topIncident.severity ?? "Warning" },
      ],
      rootCause: topIncident.rootCause ?? "Probable issue chain inferred from alert and error co-occurrence.",
      recommendation: "Stabilize the impacted service first, then validate dependent services and rollback recent risky changes.",
    },
  ] : [];

  const predictions = [
    {
      metric: "Incident Load",
      current: incidentCount,
      predicted72h: Math.max(incidentCount, Math.round(incidentCount * 1.2)),
      riskLevel: incidentCount >= 3 ? "High" : incidentCount >= 1 ? "Medium" : "Low",
      confidence: 55,
      action: "Prioritize high-severity incidents and suppress noisy alert sources.",
    },
    {
      metric: "Alert Volume",
      current: alertCount,
      predicted72h: Math.max(alertCount, Math.round(alertCount * 1.15)),
      riskLevel: alertCount >= 10 ? "High" : alertCount >= 4 ? "Medium" : "Low",
      confidence: 58,
      action: "Tune thresholds for recurring low-value alerts and isolate flapping entities.",
    },
    {
      metric: "Error Rate",
      current: errorCount,
      predicted72h: Math.max(errorCount, Math.round(errorCount * 1.1)),
      riskLevel: errorCount >= 8 ? "High" : errorCount >= 3 ? "Medium" : "Low",
      confidence: 57,
      action: "Investigate top recurring exceptions and add guardrails around failure paths.",
    },
  ];

  const recommendations = [
    { action: "Address the top active incident and verify remediation success with live metrics.", impact: "Reduces immediate service risk and user impact.", priority: "high" },
    { action: "Correlate top alerts with top errors to remove duplicate noise and focus responders.", impact: "Improves triage speed and MTTR.", priority: "medium" },
    { action: "Review server saturation trends for impacted applications.", impact: "Prevents repeat incidents caused by capacity pressure.", priority: "medium" },
  ];

  return {
    summary: `Fallback analysis generated from live telemetry snapshot: ${incidentCount} incidents, ${alertCount} alerts, ${errorCount} errors across ${appCount} applications and ${serverCount} servers.`,
    confidence: 0.56,
    causalChains,
    predictions,
    applicationPredictions,
    knowledgeGraph: { nodes: [], edges: [] },
    recommendations,
    relatedIssues: [],
    degraded: true,
  };
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
