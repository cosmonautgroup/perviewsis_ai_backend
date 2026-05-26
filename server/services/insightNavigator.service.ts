import { db } from "../db";
import {
  dbApplications, dbIncidents, dbAlerts, dbErrors, dbServers, dbCapacityRisks,
  dbTransactions, dbMetrics, insightNavMessages, insightNavSessions,
} from "@shared/schema";
import { eq, desc, sql, and } from "drizzle-orm";
import { ollamaClient, DEFAULT_MODEL, parseAIJson } from "./ollama.service";
import type { Response } from "express";

const configuredStartTimeoutMs = Number(process.env.AI_STREAM_START_TIMEOUT_MS ?? 60000);
const configuredIdleTimeoutMs = Number(process.env.AI_STREAM_IDLE_TIMEOUT_MS ?? 90000);
const OLLAMA_STREAM_START_TIMEOUT_MS = Number.isFinite(configuredStartTimeoutMs) && configuredStartTimeoutMs > 0
  ? configuredStartTimeoutMs
  : 60000;
const OLLAMA_STREAM_IDLE_TIMEOUT_MS = Number.isFinite(configuredIdleTimeoutMs) && configuredIdleTimeoutMs > 0
  ? configuredIdleTimeoutMs
  : 90000;

function timeoutAfter<T>(ms: number, message: string): Promise<T> {
  return new Promise<T>((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HistoryEntry {
  role: string;
  content: string;
  structuredData?: any;
}

// ─── Context builder ──────────────────────────────────────────────────────────

function uniqueTerms(input: string): string[] {
  return Array.from(new Set(input
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, " ")
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 3)
    .filter(t => !["what", "which", "show", "give", "with", "from", "this", "that", "have", "about", "please", "current", "latest"].includes(t)))).slice(0, 6);
}

function orLike(terms: string[], columns: any[]) {
  if (!terms.length) return sql`false`;
  const clauses = terms.flatMap(term => {
    const pattern = `%${term}%`;
    return columns.map(col => sql`lower(coalesce(${col}, '')) LIKE ${pattern}`);
  });
  return sql.join(clauses, sql` OR `);
}

function scopedCredentialWhere(credIds: number[]) {
  if (!credIds.length) return sql`true`;
  return credIds.length === 1
    ? sql`credential_id = ${credIds[0]}`
    : sql`credential_id = ANY(ARRAY[${sql.join(credIds.map(id => sql`${id}`), sql`, `)}]::integer[])`;
}

async function hasScopedApplications(credIds: number[]): Promise<boolean> {
  if (!credIds.length) return false;
  const credWhere = scopedCredentialWhere(credIds);
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(dbApplications).where(credWhere as any);
  return Number(row?.count ?? 0) > 0;
}

export async function buildOrgContext(credIds: number[], orgName: string, userMessage = ""): Promise<string> {
  const useCredentialScope = await hasScopedApplications(credIds);
  const credIdArr = useCredentialScope ? scopedCredentialWhere(credIds) : sql`true`;
  const scopeNote = useCredentialScope
    ? `Scoped to ${credIds.length} active credential${credIds.length === 1 ? "" : "s"} for this user.`
    : "Using all restored APM database records because no active user-owned credential has matching application rows.";

  const [apps, incidents, alerts, errors, servers, risks] = await Promise.all([
    db.select({
      id: dbApplications.id, externalId: dbApplications.externalId, name: dbApplications.name,
      status: dbApplications.status, source: dbApplications.source, callsPerMinute: dbApplications.callsPerMinute,
      avgResponseTime: dbApplications.avgResponseTime, errorRate: dbApplications.errorRate, healthScore: dbApplications.healthScore,
    })
      .from(dbApplications).where(credIdArr as any).orderBy(desc(dbApplications.healthRuleViolations)).limit(20),

    db.select({ id: dbIncidents.id, title: dbIncidents.title, severity: dbIncidents.severity, status: dbIncidents.status,
      startTime: dbIncidents.startTime, rootCause: dbIncidents.rootCause,
      affectedServices: dbIncidents.affectedServices, applicationId: dbIncidents.applicationId })
      .from(dbIncidents)
      .where(sql`${dbIncidents.applicationId} IN (SELECT external_id FROM apm_applications WHERE ${credIdArr})`)
      .orderBy(desc(dbIncidents.startTime)).limit(15),

    db.select({ id: dbAlerts.id, name: dbAlerts.name, severity: dbAlerts.severity, status: dbAlerts.status,
      metric: dbAlerts.metric, currentValue: dbAlerts.currentValue, threshold: dbAlerts.threshold,
      applicationId: dbAlerts.applicationId })
      .from(dbAlerts)
      .where(sql`${dbAlerts.applicationId} IN (SELECT external_id FROM apm_applications WHERE ${credIdArr})`)
      .orderBy(desc(dbAlerts.triggeredAt)).limit(15),

    db.select({ id: dbErrors.id, errorType: dbErrors.errorType, message: dbErrors.message, severity: dbErrors.severity,
      frequency: dbErrors.frequency, frequencyTrend: dbErrors.frequencyTrend,
      service: dbErrors.service, applicationName: dbErrors.applicationName, status: dbErrors.status,
      applicationId: dbErrors.applicationId })
      .from(dbErrors)
      .where(sql`${dbErrors.applicationId} IN (SELECT external_id FROM apm_applications WHERE ${credIdArr})`)
      .orderBy(desc(dbErrors.frequency)).limit(15),

    db.select({ id: dbServers.id, name: dbServers.name, status: dbServers.status, cpuUsage: dbServers.cpuUsage,
      memoryUsage: dbServers.memoryUsage, diskUsage: dbServers.diskUsage, applicationId: dbServers.applicationId })
      .from(dbServers)
      .where(sql`${dbServers.applicationId} IN (SELECT external_id FROM apm_applications WHERE ${credIdArr})`)
      .limit(12),

    db.select({ name: dbCapacityRisks.name, severity: dbCapacityRisks.severity,
      type: dbCapacityRisks.type, entityName: dbCapacityRisks.entityName,
      riskScore: dbCapacityRisks.riskScore, hoursToSaturation: dbCapacityRisks.hoursToSaturation })
      .from(dbCapacityRisks)
      .where(sql`${dbCapacityRisks.appId} IN (SELECT id FROM apm_applications WHERE ${credIdArr})`)
      .orderBy(desc(dbCapacityRisks.riskScore)).limit(8),
  ]);

  const terms = uniqueTerms(userMessage);
  const [matchedApps, matchedIncidents, matchedAlerts, matchedErrors, matchedTransactions, topMetrics] = await Promise.all([
    db.select({
      id: dbApplications.id, externalId: dbApplications.externalId, name: dbApplications.name,
      status: dbApplications.status, avgResponseTime: dbApplications.avgResponseTime,
      callsPerMinute: dbApplications.callsPerMinute, errorRate: dbApplications.errorRate,
    })
      .from(dbApplications)
      .where(and(credIdArr as any, orLike(terms, [dbApplications.name, dbApplications.externalId, dbApplications.status]) as any))
      .limit(8),
    db.select({ id: dbIncidents.id, title: dbIncidents.title, severity: dbIncidents.severity, status: dbIncidents.status, rootCause: dbIncidents.rootCause })
      .from(dbIncidents)
      .where(and(sql`${dbIncidents.applicationId} IN (SELECT external_id FROM apm_applications WHERE ${credIdArr})`, orLike(terms, [dbIncidents.title, dbIncidents.severity, dbIncidents.status, dbIncidents.rootCause]) as any))
      .orderBy(desc(dbIncidents.startTime)).limit(8),
    db.select({ id: dbAlerts.id, name: dbAlerts.name, severity: dbAlerts.severity, status: dbAlerts.status, metric: dbAlerts.metric, currentValue: dbAlerts.currentValue, threshold: dbAlerts.threshold })
      .from(dbAlerts)
      .where(and(sql`${dbAlerts.applicationId} IN (SELECT external_id FROM apm_applications WHERE ${credIdArr})`, orLike(terms, [dbAlerts.name, dbAlerts.severity, dbAlerts.status, dbAlerts.metric]) as any))
      .orderBy(desc(dbAlerts.triggeredAt)).limit(8),
    db.select({ id: dbErrors.id, errorType: dbErrors.errorType, service: dbErrors.service, message: dbErrors.message, severity: dbErrors.severity, frequency: dbErrors.frequency, status: dbErrors.status })
      .from(dbErrors)
      .where(and(sql`${dbErrors.applicationId} IN (SELECT external_id FROM apm_applications WHERE ${credIdArr})`, orLike(terms, [dbErrors.errorType, dbErrors.service, dbErrors.message, dbErrors.severity, dbErrors.status]) as any))
      .orderBy(desc(dbErrors.frequency)).limit(8),
    db.select({
      id: dbTransactions.id, name: dbTransactions.name, tier: dbTransactions.tier,
      avgResponseTime: dbTransactions.avgResponseTime, callsPerMinute: dbTransactions.callsPerMinute,
      errorRate: dbTransactions.errorRate, status: dbTransactions.status,
    })
      .from(dbTransactions)
      .where(and(credIdArr as any, orLike(terms, [dbTransactions.name, dbTransactions.tier, dbTransactions.status]) as any))
      .orderBy(desc(dbTransactions.errorRate)).limit(8),
    db.select({
      entityId: dbMetrics.entityId, entityType: dbMetrics.entityType, metricName: dbMetrics.metricName,
      value: dbMetrics.value, recordedAt: dbMetrics.recordedAt,
    })
      .from(dbMetrics)
      .where(and(credIdArr as any, orLike(terms, [dbMetrics.entityId, dbMetrics.entityType, dbMetrics.metricName]) as any))
      .orderBy(desc(dbMetrics.recordedAt)).limit(12),
  ]);

  const lines: string[] = [
    `Organisation: ${orgName}`,
    `Model: ${DEFAULT_MODEL}`,
    `Database scope: ${scopeNote}`,
  ];

  if (apps.length) {
    lines.push(`\nApplications (${apps.length}):`);
    apps.forEach(a => {
      const perf = [
        a.healthScore != null ? `health: ${a.healthScore}` : "",
        a.callsPerMinute != null ? `calls/min: ${a.callsPerMinute}` : "",
        a.avgResponseTime != null ? `avgRT: ${a.avgResponseTime}ms` : "",
        a.errorRate != null ? `errorRate: ${a.errorRate}%` : "",
      ].filter(Boolean).join(", ");
      lines.push(`  - [ID:${a.id}] ${a.name} [${a.status ?? "Unknown"}, ${a.source}]${perf ? ` | ${perf}` : ""}`);
    });
  }

  if (incidents.length) {
    lines.push(`\nActive Incidents (${incidents.length}):`);
    incidents.slice(0, 10).forEach(i => {
      const svcStr = Array.isArray(i.affectedServices) && i.affectedServices.length
        ? ` | services: ${(i.affectedServices as string[]).join(", ")}` : "";
      lines.push(`  - [ID:${i.id}] [${i.severity}] ${i.title} | ${i.status}${svcStr}${i.rootCause ? ` | cause: ${i.rootCause.substring(0, 80)}` : ""}`);
    });
  }

  if (alerts.length) {
    lines.push(`\nAlerts (${alerts.length}):`);
    alerts.slice(0, 10).forEach(a => {
      const val = a.currentValue != null ? ` (current: ${a.currentValue}, threshold: ${a.threshold})` : "";
      lines.push(`  - [ID:${a.id}] [${a.severity}] ${a.name}${val} | ${a.status}`);
    });
  }

  if (errors.length) {
    lines.push(`\nTop Errors (${errors.length}):`);
    errors.slice(0, 10).forEach(e => {
      lines.push(`  - [ID:${e.id}] [${e.severity}] ${e.errorType ?? "Error"} in ${e.service ?? e.applicationName ?? "?"}: ${(e.message ?? "").substring(0, 80)} | count: ${e.frequency}, trend: ${e.frequencyTrend ?? "stable"}, status: ${e.status}`);
    });
  }

  if (servers.length) {
    lines.push(`\nServers (${servers.length}):`);
    servers.slice(0, 8).forEach(s => {
      const cpu = s.cpuUsage != null ? `cpu: ${s.cpuUsage}%` : "";
      const mem = s.memoryUsage != null ? `mem: ${s.memoryUsage}%` : "";
      lines.push(`  - [ID:${s.id}] ${s.name} [${s.status}] ${[cpu, mem].filter(Boolean).join(", ")} | appId: ${s.applicationId}`);
    });
  }

  if (risks.length) {
    lines.push(`\nCapacity Risks (${risks.length}):`);
    risks.forEach(r => {
      const hrs = r.hoursToSaturation != null ? ` | saturation in: ${r.hoursToSaturation.toFixed(0)}h` : "";
      lines.push(`  - [${r.severity}] ${r.name} | score: ${r.riskScore}${hrs}`);
    });
  }

  if (matchedApps.length || matchedIncidents.length || matchedAlerts.length || matchedErrors.length || matchedTransactions.length || topMetrics.length) {
    lines.push(`\nQuery-Specific Database Matches for "${userMessage.substring(0, 140)}":`);
    matchedApps.forEach(a => lines.push(`  - App [ID:${a.id}] ${a.name} | ${a.status} | avgRT:${a.avgResponseTime ?? "n/a"}ms | err:${a.errorRate ?? "n/a"}% | cpm:${a.callsPerMinute ?? "n/a"}`));
    matchedIncidents.forEach(i => lines.push(`  - Incident [ID:${i.id}] [${i.severity}] ${i.title} | ${i.status}${i.rootCause ? ` | cause: ${String(i.rootCause).substring(0, 90)}` : ""}`));
    matchedAlerts.forEach(a => lines.push(`  - Alert [ID:${a.id}] [${a.severity}] ${a.name} | ${a.status} | ${a.metric ?? "metric"}=${a.currentValue ?? "n/a"} threshold=${a.threshold ?? "n/a"}`));
    matchedErrors.forEach(e => lines.push(`  - Error [ID:${e.id}] [${e.severity ?? "Unknown"}] ${e.errorType ?? "Error"} in ${e.service ?? "unknown"} | count:${e.frequency ?? 0} | ${String(e.message ?? "").substring(0, 90)}`));
    matchedTransactions.forEach(t => lines.push(`  - Transaction [ID:${t.id}] ${t.name} | ${t.status ?? "Unknown"} | avgRT:${t.avgResponseTime ?? "n/a"}ms | err:${t.errorRate ?? "n/a"}% | cpm:${t.callsPerMinute ?? "n/a"}`));
    topMetrics.forEach(m => lines.push(`  - Metric ${m.metricName} for ${m.entityType}:${m.entityId} | value:${m.value ?? "n/a"} at ${m.recordedAt}`));
  }

  return lines.join("\n");
}

// ─── Session memory builder ───────────────────────────────────────────────────

export function buildSessionMemory(history: HistoryEntry[]): string {
  const seenIncidents = new Map<string, string>();
  const seenAlerts = new Map<string, string>();
  const seenErrors = new Map<string, string>();
  const seenServers = new Map<string, string>();

  for (const msg of history) {
    const sd = msg.structuredData;
    if (!sd) continue;
    (sd.relatedIncidents ?? []).forEach((i: any) => { if (i.id) seenIncidents.set(String(i.id), i.title ?? i.id); });
    (sd.relatedAlerts ?? []).forEach((a: any) => { if (a.alertId) seenAlerts.set(String(a.alertId), a.entity ?? a.alertId); });
    (sd.relatedErrors ?? []).forEach((e: any) => { if (e.id) seenErrors.set(String(e.id), `${e.errorType ?? "Error"} in ${e.service ?? "?"}`); });
    (sd.relatedServers ?? []).forEach((s: any) => { if (s.id) seenServers.set(String(s.id), s.name ?? s.id); });
  }

  const parts: string[] = [];
  if (seenIncidents.size) parts.push(`Incidents discussed: ${Array.from(seenIncidents.entries()).map(([id, t]) => `${t} (ID:${id})`).join(", ")}`);
  if (seenAlerts.size) parts.push(`Alerts discussed: ${Array.from(seenAlerts.entries()).map(([id, t]) => `${t} (ID:${id})`).join(", ")}`);
  if (seenErrors.size) parts.push(`Errors discussed: ${Array.from(seenErrors.entries()).map(([id, t]) => `${t} (ID:${id})`).join(", ")}`);
  if (seenServers.size) parts.push(`Servers discussed: ${Array.from(seenServers.entries()).map(([id, t]) => `${t} (ID:${id})`).join(", ")}`);

  return parts.length ? parts.join("\n") : "";
}

// ─── System prompt ────────────────────────────────────────────────────────────

export function buildSystemPrompt(orgName: string, context: string, sessionMemory: string): string {
  const memSection = sessionMemory
    ? `\nSESSION MEMORY (entities discussed earlier in this conversation):\n${sessionMemory}\nUse this context when the user refers to "them", "it", "those servers", etc.\n`
    : "";

  return `You are ObservaIQ Insight Navigator AI, an expert enterprise observability assistant for ${orgName}.
You answer user questions by reasoning over PostgreSQL database context from AppDynamics and Dynatrace telemetry. The database context is authoritative.

CURRENT TELEMETRY CONTEXT:
${context}
${memSection}
RESPONSE RULES:
- Always respond with a single valid JSON object (no markdown, no code blocks, no text outside the JSON).
- Answer the user's exact query using the database context. If query-specific matches exist, prioritize them over generic summary rows.
- If the user asks a question that cannot be answered from the database context, say so clearly in answerText and suggest the closest dashboard to inspect.
- Never expose credentials, API keys, passwords, or internal infrastructure details beyond what's in the context.
- Keep answerText concise but thorough (3-8 sentences). Use bullet points with \\n characters if listing items.
- Include specific metrics, incident names, service names from the context when relevant.
- Use entity IDs from the context (shown as [ID:N]) to populate relatedIncidents, relatedAlerts, relatedErrors, relatedServers.
- Link formats: incidents → /incidents/{id}, alerts → /alerts/{id}, errors → /errors/{id}, servers → /applications/{appId}/servers/{serverId}
- dashboardLinks should point to real app routes: /incidents, /alerts, /errors, /capacity-planning, /applications, /ai/root-cause, /ai/recommendations, /ai/risk-ranking.
- For inlineMetrics include 1-2 visualisations relevant to the question. lineChart data must have {time,value} objects. barChart data must have {name,value} objects. table data is an array of flat row objects.

RESPONSE FORMAT (strict JSON, no deviations):
{
  "answerText": "Your detailed answer here",
  "recommendations": [{"action": "string", "link": "string or empty", "priority": "high|medium|low"}],
  "relatedIncidents": [{"id": "string", "title": "string", "severity": "string", "status": "string", "link": "string"}],
  "relatedAlerts": [{"alertId": "string", "entity": "string", "severity": "string", "status": "string", "link": "string"}],
  "relatedErrors": [{"id": "string", "errorType": "string", "service": "string", "severity": "string", "link": "string"}],
  "relatedServers": [{"id": "string", "name": "string", "status": "string", "cpuUsage": "string", "link": "string"}],
  "inlineMetrics": [{"title": "string", "type": "lineChart|barChart|table", "data": [...]}],
  "dashboardLinks": [{"label": "string", "href": "string"}]
}`;
}

// ─── Streaming chat ───────────────────────────────────────────────────────────

async function buildFallbackStructuredResponse(userMessage: string, credIds: number[], orgName: string) {
  const base = {
    answerText: "",
    recommendations: [] as any[],
    relatedIncidents: [] as any[],
    relatedAlerts: [] as any[],
    relatedErrors: [] as any[],
    relatedServers: [] as any[],
    inlineMetrics: [] as any[],
    dashboardLinks: [] as any[],
  };

  if (!credIds.length) {
    return {
      ...base,
      answerText: "No APM credentials are configured for this organisation, so no live incidents can be queried right now.",
      dashboardLinks: [{ label: "Integrations", href: "/integrations" }],
    };
  }

  const credIdArr = credIds.length === 1
    ? sql`credential_id = ${credIds[0]}`
    : sql`credential_id = ANY(ARRAY[${sql.join(credIds.map(id => sql`${id}`), sql`, `)}]::integer[])`;

  const [incidents, alerts] = await Promise.all([
    db.select({
      id: dbIncidents.id,
      title: dbIncidents.title,
      severity: dbIncidents.severity,
      status: dbIncidents.status,
      rootCause: dbIncidents.rootCause,
      startTime: dbIncidents.startTime,
    })
      .from(dbIncidents)
      .where(sql`${dbIncidents.applicationId} IN (SELECT external_id FROM apm_applications WHERE ${credIdArr})`)
      .orderBy(desc(dbIncidents.startTime))
      .limit(25),
    db.select({
      id: dbAlerts.id,
      name: dbAlerts.name,
      severity: dbAlerts.severity,
      status: dbAlerts.status,
    })
      .from(dbAlerts)
      .where(sql`${dbAlerts.applicationId} IN (SELECT external_id FROM apm_applications WHERE ${credIdArr})`)
      .orderBy(desc(dbAlerts.triggeredAt))
      .limit(10),
  ]);

  const isOpen = (v?: string | null) => ["open", "active", "triggered"].includes((v ?? "").toLowerCase());
  const isCritical = (v?: string | null) => /critical|sev1|p1|high/.test((v ?? "").toLowerCase());

  const openIncidents = incidents.filter(i => isOpen(i.status));
  const criticalOpen = openIncidents.filter(i => isCritical(i.severity)).slice(0, 5);
  const primary = criticalOpen.length ? criticalOpen : openIncidents.slice(0, 5);
  const openAlerts = alerts.filter(a => isOpen(a.status)).slice(0, 4);
  const asksCritical = /critical|urgent|highest|most critical/.test(userMessage.toLowerCase());

  if (primary.length) {
    const answerLines = criticalOpen.length
      ? [
          `Most critical active incidents in ${orgName} right now:`,
          ...criticalOpen.map((i, idx) => `${idx + 1}. ${i.title} (ID:${i.id}) — severity ${i.severity ?? "Unknown"}, status ${i.status ?? "Unknown"}${i.rootCause ? `, root cause: ${i.rootCause}` : ""}`),
          "AI model connectivity is unavailable at the moment, so this answer is generated directly from live incidents data.",
        ]
      : [
          asksCritical
            ? `No incidents marked Critical are currently open in ${orgName}. Here are the highest-priority open incidents:`
            : `Top active incidents in ${orgName}:`,
          ...primary.map((i, idx) => `${idx + 1}. ${i.title} (ID:${i.id}) — severity ${i.severity ?? "Unknown"}, status ${i.status ?? "Unknown"}`),
          "AI model connectivity is unavailable at the moment, so this answer is generated directly from live incidents data.",
        ];

    return {
      ...base,
      answerText: answerLines.join("\n"),
      relatedIncidents: primary.map(i => ({
        id: String(i.id),
        title: i.title ?? `Incident ${i.id}`,
        severity: i.severity ?? "Unknown",
        status: i.status ?? "Unknown",
        link: `/incidents/${i.id}`,
      })),
      relatedAlerts: openAlerts.map(a => ({
        alertId: String(a.id),
        entity: a.name ?? `Alert ${a.id}`,
        severity: a.severity ?? "Unknown",
        status: a.status ?? "Unknown",
        link: `/alerts/${a.id}`,
      })),
      recommendations: [
        { action: "Assign owners to the top incidents and begin mitigation immediately.", link: "/incidents", priority: "high" },
        { action: "Review correlated active alerts for escalation signals.", link: "/alerts", priority: "medium" },
      ],
      dashboardLinks: [
        { label: "Incidents", href: "/incidents" },
        { label: "Alerts", href: "/alerts" },
      ],
    };
  }

  return {
    ...base,
    answerText: "There are no active incidents in the current telemetry snapshot. AI model connectivity is unavailable, so this answer uses direct database fallback.",
    recommendations: [
      { action: "Validate that sync jobs are running and data is fresh.", link: "/integrations", priority: "medium" },
    ],
    dashboardLinks: [
      { label: "Incidents", href: "/incidents" },
      { label: "Integrations", href: "/integrations" },
    ],
  };
}

export async function streamInsightChat(
  sessionId: number,
  userMessage: string,
  credIds: number[],
  orgName: string,
  history: HistoryEntry[],
  res: Response,
): Promise<void> {
  const context = await buildOrgContext(credIds, orgName, userMessage);
  const sessionMemory = buildSessionMemory(history);
  const systemMsg = buildSystemPrompt(orgName, context, sessionMemory);

  const messages = [
    { role: "system", content: systemMsg },
    ...history.slice(-10).map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const emptyStructured = () => ({
    answerText: "",
    recommendations: [],
    relatedIncidents: [],
    relatedAlerts: [],
    relatedErrors: [],
    relatedServers: [],
    inlineMetrics: [],
    dashboardLinks: [],
  });

  let fullText = "";
  try {
    const stream = await Promise.race([
      ollamaClient.chat({
        model: DEFAULT_MODEL,
        messages: messages as any,
        stream: true,
      } as any),
      timeoutAfter<any>(
        OLLAMA_STREAM_START_TIMEOUT_MS,
        `AI stream start timed out after ${Math.round(OLLAMA_STREAM_START_TIMEOUT_MS / 1000)}s`,
      ),
    ]);

    const iterator = (stream as any)[Symbol.asyncIterator]?.();
    if (!iterator) throw new Error("AI stream iterator unavailable");

    while (true) {
      const nextChunk = await Promise.race([
        iterator.next(),
        timeoutAfter<IteratorResult<any>>(
          OLLAMA_STREAM_IDLE_TIMEOUT_MS,
          `AI stream stalled for ${Math.round(OLLAMA_STREAM_IDLE_TIMEOUT_MS / 1000)}s`,
        ),
      ]);
      if (nextChunk.done) break;
      const token: string = nextChunk.value?.message?.content ?? "";
      fullText += token;
      if (token) sendEvent({ type: "token", text: token });
    }

    let structured = { ...emptyStructured(), answerText: fullText };
    try {
      const parsed = parseAIJson(fullText);
      if (parsed.answerText) structured = { ...emptyStructured(), ...parsed };
    } catch {
      // Not valid JSON — keep raw text as answerText
    }

    await db.insert(insightNavMessages).values({
      sessionId,
      role: "assistant",
      content: structured.answerText ?? fullText,
      structuredData: structured,
    });

    if (history.length === 0) {
      const title = userMessage.length > 55 ? userMessage.substring(0, 52) + "..." : userMessage;
      await db.update(insightNavSessions).set({ title, updatedAt: new Date() }).where(eq(insightNavSessions.id, sessionId));
    } else {
      await db.update(insightNavSessions).set({ updatedAt: new Date() }).where(eq(insightNavSessions.id, sessionId));
    }

    sendEvent({ type: "done", data: structured });
  } catch (err: any) {
    const rawMessage = String(err?.message ?? "");
    const aiUnavailable = err?.code === "ECONNREFUSED"
      || /fetch failed|ECONNREFUSED|connect|network|timed out|stream stalled|stream start timed out/i.test(rawMessage);

    if (aiUnavailable) {
      const fallback = await buildFallbackStructuredResponse(userMessage, credIds, orgName);
      await db.insert(insightNavMessages).values({
        sessionId,
        role: "assistant",
        content: fallback.answerText,
        structuredData: fallback,
      });
      await db.update(insightNavSessions).set({ updatedAt: new Date() }).where(eq(insightNavSessions.id, sessionId));
      sendEvent({ type: "done", data: fallback });
    } else {
      const msg = rawMessage || "AI service error";
      sendEvent({ type: "error", message: msg });

      await db.insert(insightNavMessages).values({
        sessionId,
        role: "assistant",
        content: msg,
        structuredData: { ...emptyStructured(), answerText: msg },
      });
    }
  } finally {
    res.end();
  }
}

// ─── Time-series helpers ───────────────────────────────────────────────────────

const HOURS_24 = ["00:00","01:00","02:00","03:00","04:00","05:00","06:00","07:00","08:00","09:00","10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00","20:00","21:00","22:00","23:00"];

const CPU_TREND = [55,56,58,57,60,63,67,72,75,80,84,88,91,89,86,84,87,90,91,88,86,88,91,94];
const ERR_RATE_TREND = [0.8,0.9,1.0,1.0,1.1,1.3,1.6,2.0,2.3,2.8,3.1,3.6,4.2,3.9,3.6,3.3,3.5,4.0,4.2,3.9,3.6,3.5,3.9,4.2];
const MEM_TREND = [62,63,64,64,65,67,69,72,75,78,80,83,85,84,83,82,84,86,87,85,84,85,87,88];
const RESP_TIME_TREND = [180,190,195,188,200,220,260,310,350,420,480,560,620,580,540,500,530,590,620,570,540,510,560,620];

function zipTimeSeries(hours: string[], values: number[], key = "value") {
  return hours.map((time, i) => ({ time, [key]: values[i] }));
}

// ─── Demo org responses ───────────────────────────────────────────────────────

const DEMO_RESPONSES: { keywords: string[]; response: any }[] = [
  {
    keywords: ["critical", "most critical", "highest", "worst", "urgent"],
    response: {
      answerText: "The most critical active incident is 'High Error Rate — EcommerceAPI checkout endpoint exceeding 4%' (INC-31). The checkout service is experiencing database connection pool exhaustion, causing 847 errors and impacting ~4,200 users. InventoryManager is also critical with response time degradation >1200ms (INC-32) due to a missing index on product_id. Both require immediate attention.",
      recommendations: [
        { action: "Add composite index on checkout_items(order_id, product_id) — this is the root cause of pool exhaustion", link: "/ai/root-cause", priority: "high" },
        { action: "Increase DB connection pool size from 50 to 150 connections as immediate mitigation", link: "/incidents/31", priority: "high" },
        { action: "Deploy circuit breaker between EcommerceAPI and InventoryManager", link: "/ai/recommendations", priority: "medium" },
      ],
      relatedIncidents: [
        { id: "31", title: "High Error Rate — EcommerceAPI checkout endpoint exceeding 4%", severity: "Critical", status: "Open", link: "/incidents/31" },
        { id: "32", title: "InventoryManager Response Time Degradation > 1200ms", severity: "Critical", status: "Open", link: "/incidents/32" },
      ],
      relatedAlerts: [
        { alertId: "67", entity: "Error Rate > 4% — EcommerceAPI", severity: "Critical", status: "Open", link: "/alerts/67" },
        { alertId: "68", entity: "Response Time > 1000ms — InventoryManager", severity: "Critical", status: "Open", link: "/alerts/68" },
      ],
      relatedErrors: [
        { id: "86936", errorType: "DatabaseException", service: "checkout-service", severity: "Critical", link: "/errors/86936" },
        { id: "86937", errorType: "ConnectionRefusedException", service: "EcommerceAPI", severity: "High", link: "/errors/86937" },
      ],
      relatedServers: [
        { id: "srv-inv-01", name: "inventory-node-01", status: "Critical", cpuUsage: "94%", link: "/applications/ecomm-app/servers/srv-inv-01" },
        { id: "srv-api-02", name: "api-node-02", status: "Warning", cpuUsage: "78%", link: "/applications/ecomm-app/servers/srv-api-02" },
      ],
      inlineMetrics: [
        {
          title: "EcommerceAPI Error Rate — Last 24h (%)",
          type: "lineChart",
          data: zipTimeSeries(HOURS_24, ERR_RATE_TREND),
        },
        {
          title: "inventory-node-01 CPU — Last 24h (%)",
          type: "lineChart",
          data: zipTimeSeries(HOURS_24, CPU_TREND),
        },
      ],
      dashboardLinks: [
        { label: "View All Incidents", href: "/incidents" },
        { label: "Run Root Cause Analysis", href: "/ai/root-cause" },
        { label: "AI Recommendations", href: "/ai/recommendations" },
      ],
    },
  },
  {
    keywords: ["error rate", "errors", "top errors", "most errors", "error count"],
    response: {
      answerText: "The top errors by occurrence count are:\n• DatabaseException (847 occurrences) — connection pool timeout in checkout-service (EcommerceAPI)\n• CacheNotFoundException (19,200 occurrences) — Redis MISS on product cache after deployment restart (ProductCatalog)\n• ConnectionRefusedException (1,240 occurrences) — ML recommendation service not ready (EcommerceAPI)\n• QueryTimeoutException (412 occurrences) — missing index on stock_items table (InventoryManager)\n\nThe database-related errors are the most impactful and require immediate remediation.",
      recommendations: [
        { action: "Fix the missing DB index — this resolves DatabaseException and QueryTimeoutException together", link: "/errors", priority: "high" },
        { action: "Pre-warm the ProductCatalog Redis cache after deployments to avoid cache cold-start errors", link: "/ai/recommendations", priority: "medium" },
        { action: "Check ML recommendation service pod readiness probe configuration", link: "/errors", priority: "low" },
      ],
      relatedIncidents: [
        { id: "31", title: "High Error Rate — EcommerceAPI checkout endpoint exceeding 4%", severity: "Critical", status: "Open", link: "/incidents/31" },
      ],
      relatedAlerts: [
        { alertId: "67", entity: "Error Rate > 4% — EcommerceAPI", severity: "Critical", status: "Open", link: "/alerts/67" },
      ],
      relatedErrors: [
        { id: "86936", errorType: "DatabaseException", service: "checkout-service", severity: "Critical", link: "/errors/86936" },
        { id: "86938", errorType: "CacheNotFoundException", service: "ProductCatalog", severity: "High", link: "/errors/86938" },
        { id: "86937", errorType: "ConnectionRefusedException", service: "EcommerceAPI", severity: "High", link: "/errors/86937" },
        { id: "86939", errorType: "QueryTimeoutException", service: "InventoryManager", severity: "High", link: "/errors/86939" },
      ],
      relatedServers: [],
      inlineMetrics: [
        {
          title: "Error Occurrences by Type",
          type: "barChart",
          data: [
            { name: "CacheNotFoundException", value: 19200 },
            { name: "ConnectionRefused", value: 1240 },
            { name: "DatabaseException", value: 847 },
            { name: "QueryTimeout", value: 412 },
          ],
        },
        {
          title: "Error Rate Trend — Last 24h (%)",
          type: "lineChart",
          data: zipTimeSeries(HOURS_24, ERR_RATE_TREND),
        },
      ],
      dashboardLinks: [
        { label: "View All Errors", href: "/errors" },
        { label: "Correlation Insights", href: "/ai/correlation" },
      ],
    },
  },
  {
    keywords: ["capacity", "saturation", "disk", "cpu usage", "memory", "infrastructure", "server"],
    response: {
      answerText: "There are 8 active capacity risks across the infrastructure:\n• inventory-node-01 CPU at 94% — will saturate in ~8 hours (Critical, score 97)\n• api-node-02 Heap Memory at 88% — OOM risk in ~12 hours (Critical, score 95)\n• api-db-primary Disk at 78% — growing 2%/day, saturation in ~72 hours (Warning, score 78)\n\nThe highest priority is inventory-node-01 CPU saturation. The N+1 query pattern in stock lookups is driving this. Adding the missing index should reduce CPU load by ~40%.",
      recommendations: [
        { action: "Fix the N+1 query pattern in InventoryManager stock lookups to reduce CPU by ~40%", link: "/capacity-planning", priority: "high" },
        { action: "Scale api-node-02 horizontally or restart with heap size increase to prevent OOM", link: "/capacity-planning", priority: "high" },
        { action: "Archive old order data to free disk space on api-db-primary", link: "/capacity-planning", priority: "medium" },
      ],
      relatedIncidents: [
        { id: "32", title: "InventoryManager Response Time Degradation > 1200ms", severity: "Critical", status: "Open", link: "/incidents/32" },
      ],
      relatedAlerts: [
        { alertId: "69", entity: "CPU > 90% — inventory-node-01", severity: "Critical", status: "Open", link: "/alerts/69" },
        { alertId: "72", entity: "Heap Memory > 85% — api-node-02", severity: "Warning", status: "Open", link: "/alerts/72" },
      ],
      relatedErrors: [
        { id: "86939", errorType: "QueryTimeoutException", service: "InventoryManager", severity: "High", link: "/errors/86939" },
      ],
      relatedServers: [
        { id: "srv-inv-01", name: "inventory-node-01", status: "Critical", cpuUsage: "94%", link: "/applications/ecomm-app/servers/srv-inv-01" },
        { id: "srv-api-02", name: "api-node-02", status: "Warning", cpuUsage: "78%", link: "/applications/ecomm-app/servers/srv-api-02" },
        { id: "srv-db-01", name: "api-db-primary", status: "Warning", cpuUsage: "61%", link: "/applications/ecomm-app/servers/srv-db-01" },
      ],
      inlineMetrics: [
        {
          title: "Server Resource Usage",
          type: "table",
          data: [
            { Server: "inventory-node-01", CPU: "94%", Memory: "71%", Disk: "62%", Status: "Critical" },
            { Server: "api-node-02", CPU: "78%", Memory: "88%", Disk: "55%", Status: "Warning" },
            { Server: "api-db-primary", CPU: "61%", Memory: "72%", Disk: "78%", Status: "Warning" },
            { Server: "api-node-01", CPU: "58%", Memory: "63%", Disk: "41%", Status: "Healthy" },
            { Server: "cache-node-01", CPU: "45%", Memory: "81%", Disk: "38%", Status: "Warning" },
          ],
        },
        {
          title: "inventory-node-01 CPU — Last 24h (%)",
          type: "lineChart",
          data: zipTimeSeries(HOURS_24, CPU_TREND),
        },
      ],
      dashboardLinks: [
        { label: "Capacity Planning", href: "/capacity-planning" },
        { label: "Service Risk Rankings", href: "/ai/risk-ranking" },
      ],
    },
  },
  {
    keywords: ["recommend", "fix", "resolve", "action", "what should", "how to", "what to do", "suggestion"],
    response: {
      answerText: "Based on the current incident and error data, here are the top prioritised actions to restore platform stability:\n\n1. **Add the missing DB index** on checkout_items(order_id, product_id) — root cause of connection pool exhaustion and checkout cascade failures. Estimated resolution: 30 minutes.\n\n2. **Deploy circuit breaker** between EcommerceAPI and InventoryManager to prevent checkout failures cascading when inventory is slow.\n\n3. **Pre-warm the ProductCatalog Redis cache** after every deployment to eliminate 19,200 cache misses.\n\n4. **Increase DB connection pool** from 50 → 150 connections as immediate mitigation while the index is deployed.",
      recommendations: [
        { action: "Add composite index on checkout_items(order_id, product_id)", link: "/ai/root-cause", priority: "high" },
        { action: "Deploy circuit breaker between EcommerceAPI → InventoryManager", link: "/ai/recommendations", priority: "high" },
        { action: "Pre-warm ProductCatalog Redis cache post-deploy", link: "/ai/recommendations", priority: "medium" },
        { action: "Increase DB connection pool size to 150", link: "/incidents/31", priority: "medium" },
        { action: "Scale api-node-02 horizontally to address heap memory pressure", link: "/capacity-planning", priority: "low" },
      ],
      relatedIncidents: [
        { id: "31", title: "High Error Rate — EcommerceAPI checkout endpoint exceeding 4%", severity: "Critical", status: "Open", link: "/incidents/31" },
        { id: "32", title: "InventoryManager Response Time Degradation > 1200ms", severity: "Critical", status: "Open", link: "/incidents/32" },
      ],
      relatedAlerts: [
        { alertId: "67", entity: "Error Rate > 4% — EcommerceAPI", severity: "Critical", status: "Open", link: "/alerts/67" },
      ],
      relatedErrors: [
        { id: "86936", errorType: "DatabaseException", service: "checkout-service", severity: "Critical", link: "/errors/86936" },
      ],
      relatedServers: [
        { id: "srv-inv-01", name: "inventory-node-01", status: "Critical", cpuUsage: "94%", link: "/applications/ecomm-app/servers/srv-inv-01" },
      ],
      inlineMetrics: [
        {
          title: "Estimated Impact of Each Action (% improvement)",
          type: "barChart",
          data: [
            { name: "Add DB Index", value: 65 },
            { name: "Circuit Breaker", value: 45 },
            { name: "Pre-warm Cache", value: 35 },
            { name: "Expand Pool", value: 30 },
            { name: "Scale api-node-02", value: 20 },
          ],
        },
      ],
      dashboardLinks: [
        { label: "AI Recommendations", href: "/ai/recommendations" },
        { label: "Root Cause Analysis", href: "/ai/root-cause" },
        { label: "Causal & Predictive AI", href: "/ai/insights" },
      ],
    },
  },
  {
    keywords: ["risk", "service risk", "ranking", "riskiest", "which service"],
    response: {
      answerText: "The service risk rankings from highest to lowest:\n\n1. EcommerceAPI — Risk Score 96/100 (Critical) | 847 DB errors, heap OOM, checkout failures impacting 4,200 users\n2. InventoryManager — Risk Score 93/100 (Critical) | N+1 query deadlocks, CPU at 94%, replication lag\n3. PaymentService — Risk Score 72/100 (Warning) | 502 gateway errors, SSL cert issue resolved\n4. ProductCatalog — Risk Score 58/100 (Warning) | Redis cache miss 78%, Elasticsearch shard failures\n5. OrderProcessor — Risk Score 42/100 (Warning) | RabbitMQ queue depth 612, consumer lag\n\nEcommerceAPI and InventoryManager share the same PostgreSQL primary, amplifying their risk correlation.",
      recommendations: [
        { action: "Address EcommerceAPI database issues first — highest aggregate risk contribution (34%)", link: "/ai/risk-ranking", priority: "high" },
        { action: "Isolate InventoryManager onto a dedicated DB primary to break shared-lock contention", link: "/ai/risk-ranking", priority: "high" },
        { action: "Monitor PaymentService gateway 502 error rate over next 4 hours", link: "/alerts", priority: "medium" },
      ],
      relatedIncidents: [
        { id: "31", title: "High Error Rate — EcommerceAPI checkout endpoint exceeding 4%", severity: "Critical", status: "Open", link: "/incidents/31" },
        { id: "32", title: "InventoryManager Response Time Degradation > 1200ms", severity: "Critical", status: "Open", link: "/incidents/32" },
      ],
      relatedAlerts: [
        { alertId: "67", entity: "Error Rate > 4% — EcommerceAPI", severity: "Critical", status: "Open", link: "/alerts/67" },
        { alertId: "68", entity: "Response Time > 1000ms — InventoryManager", severity: "Critical", status: "Open", link: "/alerts/68" },
      ],
      relatedErrors: [
        { id: "86936", errorType: "DatabaseException", service: "checkout-service", severity: "Critical", link: "/errors/86936" },
      ],
      relatedServers: [
        { id: "srv-inv-01", name: "inventory-node-01", status: "Critical", cpuUsage: "94%", link: "/applications/ecomm-app/servers/srv-inv-01" },
        { id: "srv-api-02", name: "api-node-02", status: "Warning", cpuUsage: "78%", link: "/applications/ecomm-app/servers/srv-api-02" },
      ],
      inlineMetrics: [
        {
          title: "Service Risk Scores",
          type: "barChart",
          data: [
            { name: "EcommerceAPI", value: 96 },
            { name: "InventoryManager", value: 93 },
            { name: "PaymentService", value: 72 },
            { name: "ProductCatalog", value: 58 },
            { name: "OrderProcessor", value: 42 },
            { name: "UserAuthService", value: 31 },
            { name: "Notifications", value: 18 },
          ],
        },
        {
          title: "Service Response Time — Last 24h (ms)",
          type: "lineChart",
          data: zipTimeSeries(HOURS_24, RESP_TIME_TREND),
        },
      ],
      dashboardLinks: [
        { label: "Service Risk Rankings", href: "/ai/risk-ranking" },
        { label: "Correlation Insights", href: "/ai/correlation" },
      ],
    },
  },
  {
    keywords: ["root cause", "cause", "why", "checkout", "slowdown", "degradation", "outage"],
    response: {
      answerText: "The root cause of the current checkout failures is a missing composite index on checkout_items(order_id, product_id). Without this index, every checkout triggers a full table scan on a table with ~12M rows. Under concurrent load, each scan acquires shared locks and holds connections for >30 seconds, exhausting the 50-connection pool. This triggers a cascade: EcommerceAPI checkout → InventoryManager stock validation → PostgreSQL primary → CPU saturation → 14 deadlocks/min.",
      recommendations: [
        { action: "CREATE INDEX CONCURRENTLY idx_checkout_items ON checkout_items(order_id, product_id) — zero-downtime fix", link: "/ai/root-cause", priority: "high" },
        { action: "Increase connection pool to 150 as an immediate bridge while index is building", link: "/incidents/31", priority: "high" },
        { action: "Add query timeout of 5s with circuit breaker to prevent connection starvation", link: "/ai/recommendations", priority: "medium" },
      ],
      relatedIncidents: [
        { id: "31", title: "High Error Rate — EcommerceAPI checkout endpoint exceeding 4%", severity: "Critical", status: "Open", link: "/incidents/31" },
        { id: "32", title: "InventoryManager Response Time Degradation > 1200ms", severity: "Critical", status: "Open", link: "/incidents/32" },
      ],
      relatedAlerts: [
        { alertId: "67", entity: "Error Rate > 4% — EcommerceAPI", severity: "Critical", status: "Open", link: "/alerts/67" },
        { alertId: "69", entity: "CPU > 90% — inventory-node-01", severity: "Critical", status: "Open", link: "/alerts/69" },
      ],
      relatedErrors: [
        { id: "86936", errorType: "DatabaseException", service: "checkout-service", severity: "Critical", link: "/errors/86936" },
        { id: "86939", errorType: "QueryTimeoutException", service: "InventoryManager", severity: "High", link: "/errors/86939" },
      ],
      relatedServers: [
        { id: "srv-inv-01", name: "inventory-node-01", status: "Critical", cpuUsage: "94%", link: "/applications/ecomm-app/servers/srv-inv-01" },
        { id: "srv-db-01", name: "api-db-primary", status: "Warning", cpuUsage: "61%", link: "/applications/ecomm-app/servers/srv-db-01" },
      ],
      inlineMetrics: [
        {
          title: "Response Time Trend — Last 24h (ms)",
          type: "lineChart",
          data: zipTimeSeries(HOURS_24, RESP_TIME_TREND),
        },
        {
          title: "Causal Chain Steps",
          type: "table",
          data: [
            { Time: "T-180min", Event: "Slow queries accumulate", Impact: "P99 > 4s" },
            { Time: "T-120min", Event: "Connection pool saturated", Impact: "100% pool used" },
            { Time: "T-90min", Event: "Checkout 502 errors spike", Impact: "6.2% error rate" },
            { Time: "T-60min", Event: "Cart abandonment surge", Impact: "+340% timeouts" },
            { Time: "T-0", Event: "Revenue impact detected", Impact: "~$28k/hr loss" },
          ],
        },
      ],
      dashboardLinks: [
        { label: "Root Cause Analysis", href: "/ai/root-cause" },
        { label: "Correlation Insights", href: "/ai/correlation" },
        { label: "Causal & Predictive AI", href: "/ai/insights" },
      ],
    },
  },
];

function matchDemoResponse(question: string, history: HistoryEntry[]): any {
  const q = question.toLowerCase();
  for (const entry of DEMO_RESPONSES) {
    if (entry.keywords.some(kw => q.includes(kw))) return entry.response;
  }

  // Context-aware fallback: if history mentions specific entities, try to answer in context
  const prevEntities: string[] = [];
  for (const h of history) {
    const sd = h.structuredData;
    if (!sd) continue;
    (sd.relatedIncidents ?? []).forEach((i: any) => prevEntities.push(i.title ?? ""));
    (sd.relatedErrors ?? []).forEach((e: any) => prevEntities.push(e.errorType ?? ""));
    (sd.relatedServers ?? []).forEach((s: any) => prevEntities.push(s.name ?? ""));
  }

  const contextNote = prevEntities.length
    ? `\n\nBased on our conversation, we've been discussing: ${Array.from(new Set(prevEntities)).filter(Boolean).slice(0, 4).join(", ")}.`
    : "";

  return {
    answerText: `This is a demo environment with pre-seeded observability data for ObservaIQ Demo org. The platform is monitoring 8 applications: EcommerceAPI, InventoryManager, PaymentService, ProductCatalog, OrderProcessor, UserAuthService, NotificationService, and ReportingDashboard.${contextNote}\n\nCurrently there are 3 critical active incidents and 10 active alerts. The most severe issues are related to database connection pool exhaustion in EcommerceAPI and N+1 query patterns in InventoryManager.\n\nAsk me about: incidents, errors, capacity risks, service rankings, recommendations, root causes, or specific services.`,
    recommendations: [
      { action: "Ask about the most critical incidents to get a prioritised response", link: "/incidents", priority: "medium" },
      { action: "Check the AI recommendations for actionable remediation steps", link: "/ai/recommendations", priority: "medium" },
    ],
    relatedIncidents: [
      { id: "31", title: "High Error Rate — EcommerceAPI checkout endpoint", severity: "Critical", status: "Open", link: "/incidents/31" },
      { id: "32", title: "InventoryManager Response Time Degradation", severity: "Critical", status: "Open", link: "/incidents/32" },
    ],
    relatedAlerts: [],
    relatedErrors: [
      { id: "86936", errorType: "DatabaseException", service: "checkout-service", severity: "Critical", link: "/errors/86936" },
    ],
    relatedServers: [],
    inlineMetrics: [
      {
        title: "Platform Overview — Error Rate (%)",
        type: "lineChart",
        data: zipTimeSeries(HOURS_24, ERR_RATE_TREND),
      },
    ],
    dashboardLinks: [
      { label: "View Incidents", href: "/incidents" },
      { label: "View Errors", href: "/errors" },
      { label: "AI Insights", href: "/ai/insights" },
    ],
  };
}

export async function streamDemoInsightChat(
  sessionId: number,
  userMessage: string,
  history: HistoryEntry[],
  res: Response,
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const sendEvent = (data: any) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const structured = matchDemoResponse(userMessage, history);

  // Simulate streaming word by word
  const words = structured.answerText.split(" ");
  for (let i = 0; i < words.length; i++) {
    const token = (i === 0 ? "" : " ") + words[i];
    sendEvent({ type: "token", text: token });
    await new Promise(r => setTimeout(r, 18));
  }

  await db.insert(insightNavMessages).values({
    sessionId,
    role: "assistant",
    content: structured.answerText,
    structuredData: structured,
  });

  if (history.length === 0) {
    const title = userMessage.length > 55 ? userMessage.substring(0, 52) + "..." : userMessage;
    await db.update(insightNavSessions).set({ title, updatedAt: new Date() }).where(eq(insightNavSessions.id, sessionId));
  } else {
    await db.update(insightNavSessions).set({ updatedAt: new Date() }).where(eq(insightNavSessions.id, sessionId));
  }

  sendEvent({ type: "done", data: structured });
  res.end();
}
