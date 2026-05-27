import crypto from "crypto";
import { db } from "../db";
import { dbIncidents } from "@shared/schema";
import { aiChat, DEFAULT_MODEL, parseAIJson, systemPrompt } from "./ollama.service";

export type IncidentTelemetrySource = "appdynamics" | "dynatrace";

export type IncidentTelemetrySignal = Record<string, unknown>;

export type IncidentTelemetryPayload = {
  source: IncidentTelemetrySource;
  credentialId: number | null;
  fetchedAt: string;
  applications: IncidentTelemetrySignal[];
  sourceProblems: IncidentTelemetrySignal[];
  alerts: IncidentTelemetrySignal[];
  errors: IncidentTelemetrySignal[];
  servers: IncidentTelemetrySignal[];
  serverMetrics: IncidentTelemetrySignal[];
  applicationMetrics: IncidentTelemetrySignal[];
  businessTransactions: IncidentTelemetrySignal[];
};

type OllamaTimelineEvent = {
  timestamp: string;
  event: string;
};

export type OllamaGeneratedIncident = {
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  status: "open";
  summary: string;
  probable_root_cause: string;
  confidence_score: number;
  impacted_applications: unknown[];
  impacted_services: unknown[];
  impacted_servers: unknown[];
  related_alerts: unknown[];
  related_errors: unknown[];
  related_metrics: unknown[];
  related_business_transactions: unknown[];
  timeline: OllamaTimelineEvent[];
  impact_analysis: string;
  recommended_actions: unknown[];
  drilldown_context: {
    errors: unknown[];
    alerts: unknown[];
    server_metrics: unknown[];
    application_metrics: unknown[];
    business_transactions: unknown[];
  };
};

const RESPONSE_SCHEMA = `{
  "incidents": [
    {
      "title": "Short incident title",
      "severity": "critical | high | medium | low",
      "status": "open",
      "summary": "Human-readable incident summary",
      "probable_root_cause": "Reasoned explanation of the likely cause",
      "confidence_score": 0.0,
      "impacted_applications": [],
      "impacted_services": [],
      "impacted_servers": [],
      "related_alerts": [],
      "related_errors": [],
      "related_metrics": [],
      "related_business_transactions": [],
      "timeline": [
        {
          "timestamp": "ISO timestamp",
          "event": "What happened at this time"
        }
      ],
      "impact_analysis": "Explanation of user, business, or system impact",
      "recommended_actions": [],
      "drilldown_context": {
        "errors": [],
        "alerts": [],
        "server_metrics": [],
        "application_metrics": [],
        "business_transactions": []
      }
    }
  ]
}`;

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function truncate(value: unknown, max = 500): unknown {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}...` : value;
  if (Array.isArray(value)) return value.slice(0, 30).map((v) => truncate(v, max));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
    out[key] = truncate(item, max);
  }
  return out;
}

function limitSignals(signals: IncidentTelemetrySignal[], limit: number): IncidentTelemetrySignal[] {
  return signals.slice(0, limit).map((signal) => truncate(signal, 700) as IncidentTelemetrySignal);
}

function compactTelemetryPayload(payload: IncidentTelemetryPayload): IncidentTelemetryPayload {
  return {
    ...payload,
    applications: limitSignals(payload.applications, 30),
    sourceProblems: limitSignals(payload.sourceProblems, 40),
    alerts: limitSignals(payload.alerts, 60),
    errors: limitSignals(payload.errors, 60),
    servers: limitSignals(payload.servers, 40),
    serverMetrics: limitSignals(payload.serverMetrics, 60),
    applicationMetrics: limitSignals(payload.applicationMetrics, 60),
    businessTransactions: limitSignals(payload.businessTransactions, 60),
  };
}

function countSignals(payload: IncidentTelemetryPayload): number {
  return [
    payload.sourceProblems,
    payload.alerts,
    payload.errors,
    payload.servers,
    payload.serverMetrics,
    payload.applicationMetrics,
    payload.businessTransactions,
  ].reduce((sum, arr) => sum + arr.length, 0);
}

function clampConfidence(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.5;
  if (n > 1 && n <= 100) return Math.max(0, Math.min(1, n / 100));
  return Math.max(0, Math.min(1, n));
}

function normalizeSeverity(value: unknown): OllamaGeneratedIncident["severity"] {
  const severity = asString(value).toLowerCase();
  if (severity === "critical") return "critical";
  if (severity === "high") return "high";
  if (severity === "low") return "low";
  return "medium";
}

function dbSeverity(value: OllamaGeneratedIncident["severity"]): string {
  switch (value) {
    case "critical": return "Critical";
    case "high": return "High";
    case "low": return "Low";
    default: return "Medium";
  }
}

function extractReferenceStrings(value: unknown): string[] {
  const out = new Set<string>();
  const visit = (item: unknown) => {
    if (item == null) return;
    if (typeof item === "string" || typeof item === "number") {
      const s = String(item).trim();
      if (s) out.add(s);
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (typeof item === "object") {
      const record = item as Record<string, unknown>;
      [
        "id",
        "externalId",
        "entityId",
        "name",
        "title",
        "service",
        "server",
        "application",
        "applicationName",
        "transaction",
      ].forEach((key) => visit(record[key]));
    }
  };
  visit(value);
  return Array.from(out);
}

function normalizeIncident(raw: unknown): OllamaGeneratedIncident | null {
  const obj = asObject(raw);
  const title = asString(obj.title);
  if (!title) return null;

  const timeline = asArray(obj.timeline)
    .map((event) => {
      const e = asObject(event);
      const timestamp = asString(e.timestamp);
      const description = asString(e.event);
      return timestamp && description ? { timestamp, event: description } : null;
    })
    .filter((event): event is OllamaTimelineEvent => event != null)
    .slice(0, 20);

  const drilldown = asObject(obj.drilldown_context);

  return {
    title,
    severity: normalizeSeverity(obj.severity),
    status: "open",
    summary: asString(obj.summary, title),
    probable_root_cause: asString(obj.probable_root_cause, "Ollama did not provide a root cause hypothesis."),
    confidence_score: clampConfidence(obj.confidence_score),
    impacted_applications: asArray(obj.impacted_applications),
    impacted_services: asArray(obj.impacted_services),
    impacted_servers: asArray(obj.impacted_servers),
    related_alerts: asArray(obj.related_alerts),
    related_errors: asArray(obj.related_errors),
    related_metrics: asArray(obj.related_metrics),
    related_business_transactions: asArray(obj.related_business_transactions),
    timeline,
    impact_analysis: asString(obj.impact_analysis, "Impact analysis was not provided by the model."),
    recommended_actions: asArray(obj.recommended_actions),
    drilldown_context: {
      errors: asArray(drilldown.errors),
      alerts: asArray(drilldown.alerts),
      server_metrics: asArray(drilldown.server_metrics),
      application_metrics: asArray(drilldown.application_metrics),
      business_transactions: asArray(drilldown.business_transactions),
    },
  };
}

function parseIncidentResponse(raw: unknown): OllamaGeneratedIncident[] {
  const parsed = asObject(raw);
  return asArray(parsed.incidents)
    .map(normalizeIncident)
    .filter((incident): incident is OllamaGeneratedIncident => incident != null)
    .slice(0, Number(process.env.AI_INCIDENT_MAX_GENERATED ?? 12));
}

function parseTimestamp(value: unknown): Date | null {
  const raw = asString(value);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

function firstTimelineTime(incident: OllamaGeneratedIncident): Date | null {
  const times = incident.timeline
    .map((event) => parseTimestamp(event.timestamp))
    .filter((d): d is Date => d != null)
    .sort((a, b) => a.getTime() - b.getTime());
  return times[0] ?? null;
}

function impactedNames(value: unknown): string[] {
  return extractReferenceStrings(value).slice(0, 30);
}

function resolveApplicationId(payload: IncidentTelemetryPayload, incident: OllamaGeneratedIncident): string | null {
  const refs = new Set([
    ...extractReferenceStrings(incident.impacted_applications),
    ...extractReferenceStrings(incident.drilldown_context.application_metrics),
    ...extractReferenceStrings(incident.related_business_transactions),
  ].map((v) => v.toLowerCase()));

  const apps = payload.applications;
  for (const app of apps) {
    const keys = [
      app.externalId,
      app.id,
      app.name,
      app.applicationName,
      app.displayName,
    ].map((v) => asString(v).toLowerCase()).filter(Boolean);
    if (keys.some((key) => refs.has(key))) {
      return asString(app.externalId || app.id || app.name) || null;
    }
  }

  const appFromService = extractReferenceStrings(incident.impacted_services)
    .map((v) => v.toLowerCase());
  for (const app of apps) {
    const appName = asString(app.name).toLowerCase();
    if (appName && appFromService.some((service) => service.includes(appName) || appName.includes(service))) {
      return asString(app.externalId || app.id || app.name) || null;
    }
  }

  const firstApp = apps[0];
  return firstApp ? (asString(firstApp.externalId || firstApp.id || firstApp.name) || null) : null;
}

function generatedExternalId(payload: IncidentTelemetryPayload, incident: OllamaGeneratedIncident, startTime: Date | null): string {
  const basis = JSON.stringify({
    source: payload.source,
    credentialId: payload.credentialId ?? "env",
    title: incident.title,
    applications: impactedNames(incident.impacted_applications),
    services: impactedNames(incident.impacted_services),
    startBucket: (startTime ?? new Date(payload.fetchedAt)).toISOString().slice(0, 13),
  });
  const hash = crypto.createHash("sha256").update(basis).digest("hex").slice(0, 14);
  return `AI-${payload.source}-${payload.credentialId ?? "env"}-${hash}`;
}

function buildPrompt(payload: IncidentTelemetryPayload): string {
  const compact = compactTelemetryPayload(payload);
  return `Business definition:
An Incident is not a single alert or error. It is a contextually related group of observability signals such as errors, alerts, server metrics, application metrics, timestamps, affected services, business transactions, infrastructure impact, probable root cause, downstream impact, and next actions.

Task:
Analyse the complete telemetry payload below. Group related signals into meaningful incidents only when the relationship is supported by timestamps, shared services/applications/servers, similar symptoms, dependency clues, or metric changes. Do not create one incident per alert. If the payload contains only isolated noise, return an empty incidents array.

Rules:
- Return valid JSON only.
- Use the exact schema below.
- Do not copy the input payload or return wrapper objects such as {"status": "...", "data": ...}.
- status must be "open".
- severity must be one of "critical", "high", "medium", or "low".
- confidence_score must be a number between 0.0 and 1.0.
- If there are active or critical/high alerts/errors with shared applications, services, servers, or timestamps, create a small number of contextual incidents from those groups.
- related_* arrays must reference concrete signals from the payload by id/name/timestamp where possible.
- drilldown_context must contain the concrete supporting telemetry objects most relevant to the incident.
- Keep titles short and operational.
- Do not include credentials, tokens, or secrets.

Required JSON schema:
${RESPONSE_SCHEMA}

Telemetry payload:
${JSON.stringify(compact, null, 2)}`;
}

function signalPriority(signal: IncidentTelemetrySignal): number {
  const severity = asString(signal.severity).toLowerCase();
  const status = asString(signal.status || signal.incidentStatus).toLowerCase();
  const frequency = Number(signal.frequency ?? signal.count ?? 0);
  const errorRate = Number(signal.errorRate ?? signal.errorRatePercent ?? 0);
  const currentValue = Number(signal.currentValue ?? signal.value ?? 0);
  let score = 0;
  if (/critical|sev1|p1/.test(severity)) score += 1000;
  else if (/high|warning|warn|sev2|p2/.test(severity)) score += 500;
  if (/active|open|triggered|ongoing/.test(status)) score += 300;
  if (/resolved|closed|normal/.test(status)) score -= 150;
  if (Number.isFinite(frequency)) score += Math.min(250, frequency);
  if (Number.isFinite(errorRate)) score += Math.min(250, errorRate * 5);
  if (Number.isFinite(currentValue)) score += Math.min(100, currentValue);
  return score;
}

function summarizeSignal(signal: IncidentTelemetrySignal): IncidentTelemetrySignal {
  const keys = [
    "id",
    "externalId",
    "name",
    "title",
    "errorType",
    "message",
    "severity",
    "status",
    "service",
    "applicationId",
    "applicationName",
    "serverName",
    "metric",
    "metricName",
    "currentValue",
    "threshold",
    "value",
    "frequency",
    "frequencyTrend",
    "avgResponseTime",
    "callsPerMinute",
    "errorRate",
    "timestamp",
    "triggeredAt",
    "lastOccurrence",
    "recordedAt",
    "tier",
  ];
  const out: IncidentTelemetrySignal = {};
  for (const key of keys) {
    if (signal[key] != null) out[key] = truncate(signal[key], 220);
  }
  return out;
}

function importantSignals(signals: IncidentTelemetrySignal[], limit: number): IncidentTelemetrySignal[] {
  return [...signals]
    .sort((a, b) => signalPriority(b) - signalPriority(a))
    .slice(0, limit)
    .map(summarizeSignal);
}

function signalAppKey(signal: IncidentTelemetrySignal): string {
  return asString(signal.applicationId || signal.appId || signal.applicationName || signal.application || "unknown");
}

function signalServiceKey(signal: IncidentTelemetrySignal): string {
  return asString(signal.service || signal.serviceName || signal.tier || signal.applicationName || signal.name || "service");
}

function isStrongIncidentSignal(signal: IncidentTelemetrySignal): boolean {
  const severity = asString(signal.severity).toLowerCase();
  const status = asString(signal.status || signal.incidentStatus).toLowerCase();
  return signalPriority(signal) >= 500
    && !/resolved|closed|normal/.test(status)
    && (/critical|high|warning|sev1|sev2|p1|p2/.test(severity) || /active|open|triggered/.test(status));
}

type CandidateIncidentGroup = {
  key: string;
  applicationId: string;
  service: string;
  signals: IncidentTelemetrySignal[];
  applications: IncidentTelemetrySignal[];
  servers: IncidentTelemetrySignal[];
  metrics: IncidentTelemetrySignal[];
  businessTransactions: IncidentTelemetrySignal[];
};

function findCandidateIncidentGroups(payload: IncidentTelemetryPayload): CandidateIncidentGroup[] {
  const groups = new Map<string, CandidateIncidentGroup>();
  const sourceSignals = [
    ...payload.sourceProblems,
    ...payload.errors,
    ...payload.alerts,
  ].filter(isStrongIncidentSignal);

  for (const signal of sourceSignals) {
    const applicationId = signalAppKey(signal);
    const service = signalServiceKey(signal);
    const key = `${applicationId.toLowerCase()}::${service.toLowerCase()}`;
    const existing = groups.get(key) ?? {
      key,
      applicationId,
      service,
      signals: [],
      applications: [],
      servers: [],
      metrics: [],
      businessTransactions: [],
    };
    existing.signals.push(signal);
    groups.set(key, existing);
  }

  for (const group of groups.values()) {
    const appKey = group.applicationId.toLowerCase();
    const serviceKey = group.service.toLowerCase();
    group.applications = payload.applications
      .filter((app) => [app.externalId, app.id, app.name, app.applicationName]
        .some((value) => asString(value).toLowerCase() === appKey || asString(value).toLowerCase() === serviceKey))
      .slice(0, 4);
    group.servers = payload.servers
      .filter((server) => asString(server.applicationId).toLowerCase() === appKey || asString(server.service).toLowerCase() === serviceKey)
      .slice(0, 8);
    group.metrics = [...payload.applicationMetrics, ...payload.serverMetrics]
      .filter((metric) => {
        const haystack = [
          metric.applicationId,
          metric.applicationName,
          metric.entityId,
          metric.entityName,
          metric.service,
          metric.serverName,
          metric.metricName,
        ].map((value) => asString(value).toLowerCase());
        return haystack.some((value) => value === appKey || value.includes(serviceKey) || serviceKey.includes(value));
      })
      .slice(0, 12);
    group.businessTransactions = payload.businessTransactions
      .filter((tx) => {
        const haystack = [tx.applicationId, tx.applicationName, tx.name, tx.tier, tx.service]
          .map((value) => asString(value).toLowerCase());
        return haystack.some((value) => value === appKey || value.includes(serviceKey) || serviceKey.includes(value));
      })
      .slice(0, 12);
  }

  return Array.from(groups.values())
    .filter((group) => group.signals.length > 0)
    .sort((a, b) => {
      const scoreA = a.signals.reduce((sum, signal) => sum + signalPriority(signal), 0);
      const scoreB = b.signals.reduce((sum, signal) => sum + signalPriority(signal), 0);
      return scoreB - scoreA;
    })
    .slice(0, 4)
    .map((group) => ({
      ...group,
      signals: importantSignals(group.signals, 16),
      applications: group.applications.map(summarizeSignal),
      servers: importantSignals(group.servers, 8),
      metrics: importantSignals(group.metrics, 12),
      businessTransactions: importantSignals(group.businessTransactions, 12),
    }));
}

function buildDistilledPrompt(payload: IncidentTelemetryPayload, reason: string): string {
  const distilled = {
    source: payload.source,
    credentialId: payload.credentialId,
    fetchedAt: payload.fetchedAt,
    previousAttempt: reason,
    applications: importantSignals(payload.applications, 16),
    strongestProblems: importantSignals([
      ...payload.sourceProblems,
      ...payload.errors,
      ...payload.alerts,
    ], 40),
    nonHealthyServers: importantSignals(
      payload.servers.filter((server) => !/healthy|normal/i.test(asString(server.status))),
      20,
    ),
    importantApplicationMetrics: importantSignals(payload.applicationMetrics, 30),
    importantServerMetrics: importantSignals(payload.serverMetrics, 30),
    importantBusinessTransactions: importantSignals(payload.businessTransactions, 30),
  };

  return `Your previous incident-generation response was unusable: ${reason}.

Create contextual incidents from this distilled observability summary. This is not a request to echo data.

Incident grouping guidance:
- Group signals by shared applicationId/applicationName/service/server/tier and nearby timestamps.
- Prefer active critical/high errors and alerts.
- Include related business transactions and metrics that support the incident.
- Return 1 to 8 incidents when meaningful active or high-severity groups exist.
- Return {"incidents": []} only if there are genuinely no active/high-severity related signals.

Strict output requirements:
- Return one valid JSON object only.
- The top-level object must have exactly this shape: {"incidents": [...]}
- Do not return {"status": ...}, {"data": ...}, raw arrays, markdown, explanations, or copied telemetry rows.

Required incident schema:
${RESPONSE_SCHEMA}

Distilled telemetry summary:
${JSON.stringify(distilled, null, 2)}`;
}

async function askOllamaForIncidents(prompt: string, numPredict: number): Promise<{ incidents: OllamaGeneratedIncident[]; error?: string }> {
  const resp = await aiChat({
    model: DEFAULT_MODEL,
    messages: [
      { role: "system", content: systemPrompt() },
      { role: "user", content: prompt },
    ],
    options: {
      format: "json",
      options: {
        temperature: 0.1,
        num_predict: numPredict,
      },
    },
  }) as any;

  const rawContent = String(resp?.message?.content ?? "");
  try {
    return { incidents: parseIncidentResponse(parseAIJson(rawContent)) };
  } catch (err: any) {
    return { incidents: [], error: err?.message ?? "Unable to parse Ollama incident response" };
  }
}

async function generateIncidentsFromOllama(payload: IncidentTelemetryPayload): Promise<OllamaGeneratedIncident[]> {
  const first = await askOllamaForIncidents(buildPrompt(payload), 4096);
  if (first.incidents.length > 0) return first.incidents;

  const reason = first.error
    ? `invalid JSON (${first.error})`
    : "the model returned an empty incidents array";
  const retry = await askOllamaForIncidents(buildDistilledPrompt(payload, reason), 3072);
  if (retry.incidents.length > 0) return retry.incidents;

  const seeded = await generateSeededIncidentsFromOllama(payload);
  if (seeded.length > 0) return seeded;

  if (retry.error) {
    throw new Error(`AI incident generation failed after retry: ${retry.error}`);
  }
  return [];
}

function buildSeededIncidentPrompt(payload: IncidentTelemetryPayload, group: CandidateIncidentGroup): string {
  const seed = {
    source: payload.source,
    credentialId: payload.credentialId,
    fetchedAt: payload.fetchedAt,
    candidate: {
      applicationId: group.applicationId,
      service: group.service,
      applications: group.applications,
      signals: group.signals,
      servers: group.servers,
      metrics: group.metrics,
      businessTransactions: group.businessTransactions,
    },
  };

  return `You are creating one contextual incident from a pre-correlated observability signal group.

Important:
- The signals in this candidate are already related by application/service and severity.
- Return exactly one incident in the incidents array.
- Do not return an empty incidents array.
- Do not copy the input payload.
- Produce concise human-readable summary, probable root cause, impact analysis, and next actions.
- Use concrete signal IDs/names/timestamps from the candidate in related_* and drilldown_context.
- Return valid JSON only.

Required JSON shape:
${RESPONSE_SCHEMA}

Candidate signal group:
${JSON.stringify(seed, null, 2)}`;
}

async function generateSeededIncidentsFromOllama(payload: IncidentTelemetryPayload): Promise<OllamaGeneratedIncident[]> {
  const groups = findCandidateIncidentGroups(payload);
  const incidents: OllamaGeneratedIncident[] = [];

  for (const group of groups) {
    const response = await askOllamaForIncidents(buildSeededIncidentPrompt(payload, group), 2048);
    if (response.incidents[0]) incidents.push(response.incidents[0]);
  }

  return incidents.slice(0, Number(process.env.AI_INCIDENT_MAX_GENERATED ?? 12));
}

export async function generateAndSaveAiIncidentsFromTelemetry(payload: IncidentTelemetryPayload): Promise<number> {
  if (payload.applications.length === 0 || countSignals(payload) === 0) return 0;

  const incidents = await generateIncidentsFromOllama(payload);
  const generatedAt = new Date();

  let saved = 0;
  for (const incident of incidents) {
    const startTime = firstTimelineTime(incident) ?? generatedAt;
    const externalId = generatedExternalId(payload, incident, startTime);
    const applicationId = resolveApplicationId(payload, incident);
    const affectedServices = [
      ...impactedNames(incident.impacted_services),
      ...impactedNames(incident.impacted_applications),
    ].slice(0, 30);

    await db
      .insert(dbIncidents)
      .values({
        externalId,
        source: payload.source,
        applicationId,
        title: incident.title,
        severity: dbSeverity(incident.severity),
        status: "Open",
        startTime,
        endTime: null,
        rootCause: incident.probable_root_cause,
        affectedServices,
        metadata: {
          aiGenerated: true,
          generatedBy: "ollama",
          model: DEFAULT_MODEL,
          generatedAt: generatedAt.toISOString(),
          sourceTelemetry: {
            source: payload.source,
            credentialId: payload.credentialId,
            fetchedAt: payload.fetchedAt,
            counts: {
              applications: payload.applications.length,
              sourceProblems: payload.sourceProblems.length,
              alerts: payload.alerts.length,
              errors: payload.errors.length,
              servers: payload.servers.length,
              serverMetrics: payload.serverMetrics.length,
              applicationMetrics: payload.applicationMetrics.length,
              businessTransactions: payload.businessTransactions.length,
            },
          },
          ollamaIncident: incident,
        },
        lastSyncAt: generatedAt,
      })
      .onConflictDoUpdate({
        target: [dbIncidents.externalId, dbIncidents.source],
        set: {
          applicationId,
          title: incident.title,
          severity: dbSeverity(incident.severity),
          status: "Open",
          startTime,
          endTime: null,
          rootCause: incident.probable_root_cause,
          affectedServices,
          metadata: {
            aiGenerated: true,
            generatedBy: "ollama",
            model: DEFAULT_MODEL,
            generatedAt: generatedAt.toISOString(),
            sourceTelemetry: {
              source: payload.source,
              credentialId: payload.credentialId,
              fetchedAt: payload.fetchedAt,
              counts: {
                applications: payload.applications.length,
                sourceProblems: payload.sourceProblems.length,
                alerts: payload.alerts.length,
                errors: payload.errors.length,
                servers: payload.servers.length,
                serverMetrics: payload.serverMetrics.length,
                applicationMetrics: payload.applicationMetrics.length,
                businessTransactions: payload.businessTransactions.length,
              },
            },
            ollamaIncident: incident,
          },
          lastSyncAt: generatedAt,
          updatedAt: generatedAt,
        },
      });
    saved++;
  }

  return saved;
}
