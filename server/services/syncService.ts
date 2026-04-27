/**
 * APM Sync Service
 * Pulls data from AppDynamics and Dynatrace APIs, stores it in PostgreSQL.
 * Runs on demand and optionally on a background schedule.
 * Every sync that produces new or updated records is logged to disk via SyncRunLogger.
 */

import { db } from "../db";
import {
  apmCredentials,
  dbApplications,
  dbIncidents,
  dbAlerts,
  dbServers,
  dbTransactions,
  dbErrors,
  dbMetrics,
  dbCapacityRisks,
  dbSyncLogs,
  ApmCredential,
} from "@shared/schema";
import { eq, and, count, isNull, sql } from "drizzle-orm";
import { AppDynamicsClient, createAppDynamicsClient } from "./appDynamics";
import { DynatraceClient, createDynatraceClient, normalizeDTSeverity, normalizeDTStatus } from "./dynatrace";
import { SyncRunLogger } from "./syncRunLogger";
import { decryptSecret } from "./credentialCrypto";

export type SyncResult = {
  source: string;
  status: "success" | "failed" | "partial";
  recordsSynced: number;
  applicationsCount: number;
  incidentsCount: number;
  alertsCount: number;
  serversCount: number;
  errorMessage?: string;
  durationMs: number;
  syncRunId?: string;
};

function latestMetricValue(values?: { startTimeInMillis: number; value: number; count: number }[]): number | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => (a.startTimeInMillis ?? 0) - (b.startTimeInMillis ?? 0));
  const v = Number(sorted[sorted.length - 1]?.value ?? NaN);
  return Number.isFinite(v) ? v : null;
}

function latestMetricValueFromSeries(series?: { metricValues?: { startTimeInMillis: number; value: number; count: number }[] }[]): number | null {
  if (!Array.isArray(series) || series.length === 0) return null;
  let latestTs = -1;
  let latestVal: number | null = null;
  for (const s of series) {
    for (const point of s?.metricValues ?? []) {
      const ts = Number(point?.startTimeInMillis ?? NaN);
      const val = Number(point?.value ?? NaN);
      if (!Number.isFinite(ts) || !Number.isFinite(val)) continue;
      if (ts >= latestTs) {
        latestTs = ts;
        latestVal = val;
      }
    }
  }
  return latestVal;
}

function parseNodeNameFromMetricPath(metricPath?: string | null): string | null {
  if (!metricPath) return null;
  const parts = metricPath.split("|").map((p) => p.trim()).filter(Boolean);
  const idx = parts.findIndex((p) => p.toLowerCase() === "individual nodes");
  if (idx >= 0 && parts[idx + 1] && parts[idx + 1] !== "*") return parts[idx + 1];
  const nodesIdx = parts.findIndex((p) => p.toLowerCase() === "nodes");
  if (nodesIdx >= 0 && parts[nodesIdx + 1] && parts[nodesIdx + 1] !== "*") return parts[nodesIdx + 1];
  const hwIdx = parts.findIndex((p) => p.toLowerCase() === "hardware resources");
  if (hwIdx > 0 && parts[hwIdx - 1] && parts[hwIdx - 1] !== "*") return parts[hwIdx - 1];
  return null;
}

function canonicalNodeKey(value?: string | null): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// ─── AppDynamics Sync ────────────────────────────────────────────────────────
async function syncAppDynamics(credential?: ApmCredential, actorUserId?: number | null): Promise<SyncResult> {
  const start = Date.now();
  const resolvedPassword = credential
    ? ((): string => {
        const raw = String(credential.passwordHash ?? "");
        try { return String(decryptSecret(credential.passwordHash) ?? ""); }
        catch {
          if (raw.startsWith("enc:")) {
            throw new Error("Credential decryption failed for AppDynamics password. Check CREDENTIALS_ENCRYPTION_KEY.");
          }
          return raw;
        }
      })()
    : undefined;
  const client = credential
    ? new AppDynamicsClient({
        controllerUrl: credential.controllerUrl,
        account: credential.account ?? "",
        username: credential.username ?? "",
        password: resolvedPassword ?? process.env.APPDYNAMICS_PASSWORD ?? "",
      })
    : createAppDynamicsClient();

  if (!client) {
    return {
      source: "appdynamics",
      status: "failed",
      recordsSynced: 0,
      applicationsCount: 0,
      incidentsCount: 0,
      alertsCount: 0,
      serversCount: 0,
      errorMessage: "No AppDynamics credentials configured.",
      durationMs: Date.now() - start,
    };
  }

  const logger = new SyncRunLogger({
    orgId: credential?.organizationId ?? null,
    userId: Number.isFinite(Number(actorUserId)) ? Number(actorUserId) : null,
    credentialId: credential?.id ?? null,
    integration: "appdynamics",
  });

  let applications = 0, incidents = 0, alerts = 0, servers = 0;

  try {
    // ── Bulk-fetch all existing externalIds for diff detection ──
    const [existingApps, existingIncidents, existingAlerts, existingServers, existingErrors] =
      await Promise.all([
        db.select({ externalId: dbApplications.externalId }).from(dbApplications).where(eq(dbApplications.source, "appdynamics")),
        db.select({ externalId: dbIncidents.externalId }).from(dbIncidents).where(eq(dbIncidents.source, "appdynamics")),
        db.select({ externalId: dbAlerts.externalId }).from(dbAlerts).where(eq(dbAlerts.source, "appdynamics")),
        db.select({ externalId: dbServers.externalId }).from(dbServers).where(eq(dbServers.source, "appdynamics")),
        db.select({ externalId: dbErrors.externalId }).from(dbErrors).where(eq(dbErrors.source, "appdynamics")),
      ]);

    const existingAppIds      = new Set(existingApps.map(r => r.externalId));
    const existingIncidentIds = new Set(existingIncidents.map(r => r.externalId));
    const existingAlertIds    = new Set(existingAlerts.map(r => r.externalId));
    const existingServerIds   = new Set(existingServers.map(r => r.externalId));
    const existingErrorIds    = new Set(existingErrors.map(r => r.externalId));

    // 1. Sync applications
    const apps = await client.getApplications();

    // Classify records before upserting
    const newApps     = apps.filter(a => !existingAppIds.has(String(a.id)));
    const updatedApps = apps.filter(a =>  existingAppIds.has(String(a.id)));
    logger.log({
      endpoint: "/controller/rest/applications",
      requestParams: { output: "JSON" },
      rawResponse: apps,
      newRecords: newApps,
      updatedRecords: updatedApps,
    });

    for (const app of apps) {
      await db
        .insert(dbApplications)
        .values({
          externalId: String(app.id),
          source: "appdynamics",
          credentialId: credential?.id ?? null,
          name: app.name,
          description: app.description,
          status: "Healthy",
          healthRuleViolations: 0,
          metadata: app as any,
          lastSyncAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [dbApplications.externalId, dbApplications.source, dbApplications.credentialId],
          set: {
            name: app.name,
            description: app.description,
            metadata: app as any,
            lastSyncAt: new Date(),
            updatedAt: new Date(),
          },
        });
      applications++;

      // 1b. Sync app-level performance KPIs from AppDynamics (source of truth for app cards/KPIs)
      try {
        const [respSeries, callsSeries, errorsSeries] = await Promise.all([
          client.getResponseTimeMetrics(app.id),
          client.getCallsPerMinuteMetrics(app.id),
          client.getErrorRateMetrics(app.id),
        ]);

        const appRespMs = latestMetricValueFromSeries(respSeries);
        const appCallsPerMin = latestMetricValueFromSeries(callsSeries);
        const appErrorsPerMin = latestMetricValueFromSeries(errorsSeries);
        const appErrorRatePct = (appCallsPerMin != null && appCallsPerMin > 0 && appErrorsPerMin != null)
          ? (appErrorsPerMin / appCallsPerMin) * 100
          : null;

        const appRowWhere = credential?.id != null
          ? and(
              eq(dbApplications.externalId, String(app.id)),
              eq(dbApplications.source, "appdynamics"),
              eq(dbApplications.credentialId, credential.id),
            )
          : and(
              eq(dbApplications.externalId, String(app.id)),
              eq(dbApplications.source, "appdynamics"),
              isNull(dbApplications.credentialId),
            );

        await db
          .update(dbApplications)
          .set({
            avgResponseTime: (appRespMs != null && Number.isFinite(appRespMs) && appRespMs > 0) ? appRespMs : undefined,
            callsPerMinute: (appCallsPerMin != null && Number.isFinite(appCallsPerMin) && appCallsPerMin > 0) ? appCallsPerMin : undefined,
            errorRate: (appErrorRatePct != null && Number.isFinite(appErrorRatePct) && appErrorRatePct >= 0) ? appErrorRatePct : undefined,
            lastSyncAt: new Date(),
            updatedAt: new Date(),
          })
          .where(appRowWhere);
      } catch (_) { /* app KPI metric sync best-effort */ }

      // 2. Sync problems/incidents per app
      try {
        const problems = await client.getProblems(app.id);

        const newProblems     = problems.filter(p => !existingIncidentIds.has(String(p.id)));
        const updatedProblems = problems.filter(p =>  existingIncidentIds.has(String(p.id)));
        logger.log({
          endpoint: `/controller/rest/applications/${app.id}/problems`,
          requestParams: { applicationId: app.id, output: "JSON" },
          rawResponse: problems,
          newRecords: newProblems,
          updatedRecords: updatedProblems,
        });

        for (const problem of problems) {
          await db
            .insert(dbIncidents)
            .values({
              externalId: String(problem.id),
              source: "appdynamics",
              applicationId: String(app.id),
              title: problem.name,
              severity: problem.severity === "CRITICAL" ? "Critical" : "Warning",
              status: problem.status === "OPEN" ? "Open" : "Resolved",
              startTime: problem.startTime ? new Date(problem.startTime) : null,
              endTime: problem.endTime ? new Date(problem.endTime) : null,
              affectedServices: problem.affectedEntityDefinitions?.map((e: any) => e.name) ?? [],
              metadata: problem as any,
              lastSyncAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [dbIncidents.externalId, dbIncidents.source],
              set: {
                status: problem.status === "OPEN" ? "Open" : "Resolved",
                endTime: problem.endTime ? new Date(problem.endTime) : null,
                metadata: problem as any,
                lastSyncAt: new Date(),
                updatedAt: new Date(),
              },
            });
          incidents++;
        }
      } catch (_) { /* per-app errors are non-fatal */ }

      // 3. Sync health rule violations / alerts per app
      try {
        const violations = await client.getHealthRuleViolations(app.id, 10080);

        const newViolations     = violations.filter(v => !existingAlertIds.has(String(v.id)));
        const updatedViolations = violations.filter(v =>  existingAlertIds.has(String(v.id)));
        logger.log({
          endpoint: `/controller/rest/applications/${app.id}/problems/healthrule-violations`,
          requestParams: { applicationId: app.id, output: "JSON" },
          rawResponse: violations,
          newRecords: newViolations,
          updatedRecords: updatedViolations,
        });

        for (const v of violations) {
          await db
            .insert(dbAlerts)
            .values({
              externalId: String(v.id),
              source: "appdynamics",
              applicationId: String(app.id),
              name: v.healthRuleName || v.name || (v as any)?.triggeredEntityDefinition?.name || "Health Rule Violation",
              severity: v.severity === "CRITICAL" ? "Critical" : "Warning",
              status: v.incidentStatus === "OPEN" ? "Active" : "Resolved",
              triggeredAt: ((v as any).occurrenceTime ?? (v as any).startTimeInMillis) ? new Date((v as any).occurrenceTime ?? (v as any).startTimeInMillis) : null,
              resolvedAt: ((v as any).resolvedTime ?? (v as any).endTimeInMillis) ? new Date((v as any).resolvedTime ?? (v as any).endTimeInMillis) : null,
              metadata: v as any,
              lastSyncAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [dbAlerts.externalId, dbAlerts.source],
              set: {
                status: v.incidentStatus === "OPEN" ? "Active" : "Resolved",
                name: v.healthRuleName || v.name || (v as any)?.triggeredEntityDefinition?.name || "Health Rule Violation",
                triggeredAt: ((v as any).occurrenceTime ?? (v as any).startTimeInMillis) ? new Date((v as any).occurrenceTime ?? (v as any).startTimeInMillis) : null,
                resolvedAt: ((v as any).resolvedTime ?? (v as any).endTimeInMillis) ? new Date((v as any).resolvedTime ?? (v as any).endTimeInMillis) : null,
                metadata: v as any,
                lastSyncAt: new Date(),
                updatedAt: new Date(),
              },
            });
          alerts++;

          await db
            .update(dbApplications)
            .set({ healthRuleViolations: alerts })
            .where(and(eq(dbApplications.externalId, String(app.id)), eq(dbApplications.source, "appdynamics")));
        }
      } catch (_) { }

      // 4. Sync nodes/servers per app
      try {
        const nodes = await client.getNodes(app.id);

        const newNodes     = nodes.filter(n => !existingServerIds.has(String(n.id)));
        const updatedNodes = nodes.filter(n =>  existingServerIds.has(String(n.id)));
        logger.log({
          endpoint: `/controller/rest/applications/${app.id}/nodes`,
          requestParams: { applicationId: app.id, output: "JSON" },
          rawResponse: nodes,
          newRecords: newNodes,
          updatedRecords: updatedNodes,
        });

        for (const node of nodes) {
          const ipList = node.ipAddresses?.ipAddresses ?? [];
          await db
            .insert(dbServers)
            .values({
              externalId: String(node.id),
              source: "appdynamics",
              applicationId: String(app.id),
              name: node.name,
              ip: ipList[0] ?? null,
              tier: node.tierName,
              role: node.tierName,
              status: "Healthy",
              metadata: node as any,
              lastSyncAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [dbServers.externalId, dbServers.source],
              set: {
                name: node.name,
                tier: node.tierName,
                metadata: node as any,
                lastSyncAt: new Date(),
                updatedAt: new Date(),
              },
            });
          servers++;
        }

        // 4b. Backfill node CPU/Memory/Disk into server rows from AppDynamics metric paths
        try {
          const [cpuSeries, memSeries, diskSeriesA, diskSeriesB] = await Promise.all([
            client.getCpuMetrics(app.id),
            client.getMemoryMetrics(app.id),
            client.getMetrics(app.id, "Application Infrastructure Performance|*|Individual Nodes|*|Hardware Resources|Disks|Used %"),
            client.getMetrics(app.id, "Application Infrastructure Performance|*|Individual Nodes|*|Hardware Resources|Disk|Used %"),
          ]);

          const buildByNode = (seriesList: Array<{ metricPath?: string | null; metricValues?: { startTimeInMillis: number; value: number; count: number }[] }>) => {
            const out = new Map<string, number>();
            for (const series of seriesList ?? []) {
              const nodeName = parseNodeNameFromMetricPath(series.metricPath);
              const latest = latestMetricValue(series.metricValues);
              const key = canonicalNodeKey(nodeName);
              if (!key || latest == null) continue;
              out.set(key, latest);
            }
            return out;
          };

          const cpuByNode = buildByNode(cpuSeries ?? []);
          const memByNode = buildByNode(memSeries ?? []);
          const diskByNode = buildByNode([...(diskSeriesA ?? []), ...(diskSeriesB ?? [])]);

          for (const node of nodes) {
            const nodeKeys = [
              canonicalNodeKey(node.name),
              canonicalNodeKey((node as any)?.machineName),
            ].filter(Boolean);

            const findMetric = (m: Map<string, number>) => {
              for (const key of nodeKeys) {
                const v = m.get(key);
                if (v != null) return v;
              }
              return null;
            };

            const cpu = findMetric(cpuByNode);
            const mem = findMetric(memByNode);
            const disk = findMetric(diskByNode);
            if (cpu == null && mem == null && disk == null) continue;
            await db.update(dbServers)
              .set({
                cpuUsage: cpu ?? undefined,
                memoryUsage: mem ?? undefined,
                diskUsage: disk ?? undefined,
                lastSyncAt: new Date(),
                updatedAt: new Date(),
              })
              .where(and(
                eq(dbServers.source, "appdynamics"),
                eq(dbServers.applicationId, String(app.id)),
                eq(dbServers.externalId, String(node.id)),
              ));
          }
        } catch (_) { /* node metric backfill best-effort */ }
      } catch (_) { }

      // 5. Sync business transactions
      try {
        const bts = await client.getBusinessTransactions(app.id);
        const [rtRows, cpmRows, epmRows, slowRows, verySlowRows] = await Promise.all([
          client.getMetrics(app.id, "Business Transaction Performance|Business Transactions|*|*|Average Response Time (ms)", 60),
          client.getMetrics(app.id, "Business Transaction Performance|Business Transactions|*|*|Calls per Minute", 60),
          client.getMetrics(app.id, "Business Transaction Performance|Business Transactions|*|*|Errors per Minute", 60),
          client.getMetrics(app.id, "Business Transaction Performance|Business Transactions|*|*|Number of Slow Calls", 60),
          client.getMetrics(app.id, "Business Transaction Performance|Business Transactions|*|*|Number of Very Slow Calls", 60),
        ]);

        const metricByBtId = new Map<number, { rt?: number; cpm?: number; epm?: number; slow?: number; verySlow?: number }>();
        const btIdFromMetricName = (metricName?: string | null) => {
          const m = String(metricName ?? "").match(/BT:(\d+)/i);
          if (!m) return null;
          const n = Number(m[1]);
          return Number.isFinite(n) ? n : null;
        };
        const latestMetricNumber = (row: any): number | null => {
          if (String(row?.metricName ?? "").toUpperCase().includes("METRIC DATA NOT FOUND")) return null;
          const vals = Array.isArray(row?.metricValues) ? [...row.metricValues] : [];
          if (vals.length === 0) return null;
          vals.sort((a: any, b: any) => Number(a?.startTimeInMillis ?? 0) - Number(b?.startTimeInMillis ?? 0));
          const agg = vals.reduce((acc: { sum: number; count: number }, p: any) => {
            const s = Number(p?.sum ?? NaN);
            const c = Number(p?.count ?? NaN);
            if (Number.isFinite(s) && Number.isFinite(c) && c > 0) {
              acc.sum += s;
              acc.count += c;
            }
            return acc;
          }, { sum: 0, count: 0 });
          if (agg.count > 0) {
            const avg = agg.sum / agg.count;
            if (Number.isFinite(avg)) return avg;
          }
          const last = vals[vals.length - 1];
          const current = Number(last?.current ?? NaN);
          const value = Number(last?.value ?? NaN);
          if (Number.isFinite(current) && current > 0) return current;
          if (Number.isFinite(value) && value > 0) return value;
          if (Number.isFinite(current)) return current;
          if (Number.isFinite(value)) return value;
          return null;
        };
        const upsertMetric = (rows: any[], field: "rt" | "cpm" | "epm" | "slow" | "verySlow") => {
          for (const row of rows ?? []) {
            const btId = btIdFromMetricName(row?.metricName);
            if (btId == null) continue;
            const v = latestMetricNumber(row);
            if (v == null) continue;
            const cur = metricByBtId.get(btId) ?? {};
            cur[field] = v;
            metricByBtId.set(btId, cur);
          }
        };
        upsertMetric(rtRows as any[], "rt");
        upsertMetric(cpmRows as any[], "cpm");
        upsertMetric(epmRows as any[], "epm");
        upsertMetric(slowRows as any[], "slow");
        upsertMetric(verySlowRows as any[], "verySlow");

        for (const bt of bts) {
          const merged = metricByBtId.get(Number(bt.id)) ?? {};
          const callsPerMinute = Number(merged.cpm ?? bt.callsPerMinute ?? 0);
          const errorsPerMinute = Number(merged.epm ?? bt.errorsPerMinute ?? 0);
          const avgResponseTime = Number(merged.rt ?? bt.averageResponseTime ?? 0);
          const slowCalls = Number(merged.slow ?? 0);
          const verySlowCalls = Number(merged.verySlow ?? 0);
          const slowPct = callsPerMinute > 0 ? (slowCalls / callsPerMinute) * 100 : 0;
          const verySlowPct = callsPerMinute > 0 ? (verySlowCalls / callsPerMinute) * 100 : 0;
          const btStatus = errorsPerMinute > 5 ? "Critical" : errorsPerMinute > 1 ? "Warning" : "Normal";
          await db.insert(dbTransactions).values({
            externalId: String(bt.id),
            source: "appdynamics",
            credentialId: credential?.id ?? null,
            applicationId: String(app.id),
            name: bt.name,
            tier: bt.tierName,
            avgResponseTime,
            callsPerMinute,
            errorRate: callsPerMinute > 0 ? (errorsPerMinute / callsPerMinute) * 100 : 0,
            status: btStatus,
            metadata: {
              ...(bt as any),
              errorsPerMinute,
              slowCalls,
              verySlowCalls,
              slowTransactionPercent: slowPct,
              verySlowTransactionPercent: verySlowPct,
            } as any,
            lastSyncAt: new Date(),
          }).onConflictDoUpdate({
            target: [dbTransactions.externalId, dbTransactions.source, dbTransactions.credentialId],
            set: {
              avgResponseTime,
              callsPerMinute,
              errorRate: callsPerMinute > 0 ? (errorsPerMinute / callsPerMinute) * 100 : 0,
              status: btStatus,
              metadata: {
                ...(bt as any),
                errorsPerMinute,
                slowCalls,
                verySlowCalls,
                slowTransactionPercent: slowPct,
                verySlowTransactionPercent: verySlowPct,
              } as any,
              lastSyncAt: new Date(),
              updatedAt: new Date(),
            },
          });
        }
      } catch (_) { }

      // 6. Sync application error events
      try {
        const events = await client.getEvents(app.id, "APPLICATION_ERROR,DIAGNOSTIC_SESSION", 1440);

        const newEvents     = events.filter(e => !existingErrorIds.has(String(e.id ?? `${app.id}-${e.eventTime ?? Date.now()}`)));
        const updatedEvents = events.filter(e =>  existingErrorIds.has(String(e.id ?? `${app.id}-${e.eventTime ?? Date.now()}`)));
        logger.log({
          endpoint: `/controller/rest/applications/${app.id}/events`,
          requestParams: { applicationId: app.id, eventTypes: "APPLICATION_ERROR,DIAGNOSTIC_SESSION", timerangeMinutes: 1440 },
          rawResponse: events,
          newRecords: newEvents,
          updatedRecords: updatedEvents,
        });

        for (const event of events) {
          const eventId = String(event.id ?? `${app.id}-${event.eventTime ?? Date.now()}`);
          const sevMap: Record<string, string> = { ERROR: "Critical", WARN: "High", INFO: "Low" };
          const severity = sevMap[event.severity] ?? "Medium";
          const errorMsg = event.summary ?? event.displayName ?? event.type ?? "Application Error";
          const errorType = event.type ?? "APPLICATION_ERROR";
          await db.insert(dbErrors).values({
            externalId: eventId,
            source: "appdynamics",
            applicationId: String(app.id),
            applicationName: app.name,
            cluster: `${app.name}-errors`,
            service: event.tierName ?? event.nodeName ?? app.name,
            message: errorMsg,
            errorType,
            frequency: 1,
            frequencyTrend: "stable",
            severity,
            status: "Active",
            firstSeen: event.eventTime ? new Date(event.eventTime) : new Date(),
            lastOccurrence: event.eventTime ? new Date(event.eventTime) : new Date(),
            metadata: event as any,
            lastSyncAt: new Date(),
          }).onConflictDoUpdate({
            target: [dbErrors.externalId, dbErrors.source],
            set: {
              service: event.tierName ?? event.nodeName ?? app.name,
              message: errorMsg,
              severity,
              lastOccurrence: event.eventTime ? new Date(event.eventTime) : new Date(),
              metadata: event as any,
              lastSyncAt: new Date(),
              updatedAt: new Date(),
            },
          });
        }
      } catch (_) { }

      // 7. Sync CPU metrics
      try {
        const cpuData = await client.getCpuMetrics(app.id);
        for (const series of cpuData) {
          for (const point of series.metricValues) {
            await db.insert(dbMetrics).values({
              entityId: String(app.id),
              entityType: "application",
              source: "appdynamics",
              metricName: "cpu_usage",
              recordedAt: new Date(point.startTimeInMillis),
              value: point.value,
            }).onConflictDoNothing();
          }
        }
      } catch (_) { }
    }

    // Update credential last sync time
    if (credential) {
      await db.update(apmCredentials).set({ lastSyncAt: new Date() }).where(eq(apmCredentials.id, credential.id));
    }

    // Write the sync run log file
    const logResult = logger.flush();
    const syncRunId = logResult?.syncRunId;

    return {
      source: "appdynamics",
      status: "success",
      recordsSynced: applications + incidents + alerts + servers,
      applicationsCount: applications,
      incidentsCount: incidents,
      alertsCount: alerts,
      serversCount: servers,
      durationMs: Date.now() - start,
      syncRunId,
    };
  } catch (err: any) {
    logger.flush();
    return {
      source: "appdynamics",
      status: "failed",
      recordsSynced: applications + incidents + alerts + servers,
      applicationsCount: applications,
      incidentsCount: incidents,
      alertsCount: alerts,
      serversCount: servers,
      errorMessage: err.message,
      durationMs: Date.now() - start,
    };
  }
}

// ─── Dynatrace Sync ──────────────────────────────────────────────────────────
async function syncDynatrace(credential?: ApmCredential, actorUserId?: number | null): Promise<SyncResult> {
  const start = Date.now();
  const resolvedToken = credential
    ? ((): string => {
        const raw = String(credential.apiToken ?? "");
        try { return String(decryptSecret(credential.apiToken) ?? ""); }
        catch {
          if (raw.startsWith("enc:")) {
            throw new Error("Credential decryption failed for Dynatrace token. Check CREDENTIALS_ENCRYPTION_KEY.");
          }
          return raw;
        }
      })()
    : undefined;
  const client = credential
    ? new DynatraceClient({
        environmentUrl: credential.controllerUrl,
        apiToken: resolvedToken ?? process.env.DYNATRACE_TOKEN ?? "",
      })
    : createDynatraceClient();

  if (!client) {
    return {
      source: "dynatrace",
      status: "failed",
      recordsSynced: 0,
      applicationsCount: 0,
      incidentsCount: 0,
      alertsCount: 0,
      serversCount: 0,
      errorMessage: "No Dynatrace credentials configured.",
      durationMs: Date.now() - start,
    };
  }

  const logger = new SyncRunLogger({
    orgId: credential?.organizationId ?? null,
    userId: Number.isFinite(Number(actorUserId)) ? Number(actorUserId) : null,
    credentialId: credential?.id ?? null,
    integration: "dynatrace",
  });

  let applications = 0, incidents = 0, alerts = 0, servers = 0;

  try {
    // ── Bulk-fetch all existing externalIds ──
    const [existingApps, existingIncidents, existingServers] = await Promise.all([
      db.select({ externalId: dbApplications.externalId }).from(dbApplications).where(eq(dbApplications.source, "dynatrace")),
      db.select({ externalId: dbIncidents.externalId }).from(dbIncidents).where(eq(dbIncidents.source, "dynatrace")),
      db.select({ externalId: dbServers.externalId }).from(dbServers).where(eq(dbServers.source, "dynatrace")),
    ]);

    const existingAppIds      = new Set(existingApps.map(r => r.externalId));
    const existingIncidentIds = new Set(existingIncidents.map(r => r.externalId));
    const existingServerIds   = new Set(existingServers.map(r => r.externalId));

    // 1. Sync Dynatrace applications (/api/v1/entity/applications?includeDetails=true)
    const { applications: dtApps } = await client.getApplications();
    const toExternalId = (app: any) =>
      String(app?.entityId ?? app?.applicationId ?? app?.id ?? "").trim();

    const newApplications = dtApps.filter((a) => {
      const extId = toExternalId(a);
      return extId.length > 0 && !existingAppIds.has(extId);
    });
    const updatedApplications = dtApps.filter((a) => {
      const extId = toExternalId(a);
      return extId.length > 0 && existingAppIds.has(extId);
    });
    logger.log({
      endpoint: "/api/v1/entity/applications",
      requestParams: { includeDetails: "true" },
      rawResponse: dtApps,
      newRecords: newApplications,
      updatedRecords: updatedApplications,
    });

    for (const app of dtApps) {
      const externalId = toExternalId(app);
      if (!externalId) continue;
      const appName = String(app?.displayName ?? app?.name ?? externalId);
      await db
        .insert(dbApplications)
        .values({
          externalId,
          source: "dynatrace",
          credentialId: credential?.id ?? null,
          name: appName,
          status: "Healthy",
          healthRuleViolations: 0,
          metadata: app as any,
          lastSyncAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [dbApplications.externalId, dbApplications.source, dbApplications.credentialId],
          set: {
            name: appName,
            metadata: app as any,
            lastSyncAt: new Date(),
            updatedAt: new Date(),
          },
        });
      applications++;
    }

    // 2. Sync problems as incidents
    const { problems } = await client.getProblems("now-24h");

    const newProblems     = problems.filter(p => !existingIncidentIds.has(p.problemId));
    const updatedProblems = problems.filter(p =>  existingIncidentIds.has(p.problemId));
    logger.log({
      endpoint: "/api/v2/problems",
      requestParams: { from: "now-24h" },
      rawResponse: problems,
      newRecords: newProblems,
      updatedRecords: updatedProblems,
    });

    for (const problem of problems) {
      const sev = normalizeDTSeverity(problem.severityLevel);
      const status = normalizeDTStatus(problem.status);
      await db
        .insert(dbIncidents)
        .values({
          externalId: problem.problemId,
          source: "dynatrace",
          applicationId: problem.impactedEntities?.[0]?.entityId?.id ?? null,
          title: problem.title,
          severity: sev,
          status,
          startTime: problem.startTime ? new Date(problem.startTime) : null,
          endTime: problem.endTime ? new Date(problem.endTime) : null,
          affectedServices: problem.impactedEntities?.map((e: any) => e.name) ?? [],
          metadata: problem as any,
          lastSyncAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [dbIncidents.externalId, dbIncidents.source],
          set: {
            status,
            endTime: problem.endTime ? new Date(problem.endTime) : null,
            metadata: problem as any,
            lastSyncAt: new Date(),
            updatedAt: new Date(),
          },
        });
      incidents++;
    }

    // 3. Sync hosts as servers
    const { entities: hosts } = await client.getHosts();

    const newHosts     = hosts.filter(h => !existingServerIds.has(h.entityId));
    const updatedHosts = hosts.filter(h =>  existingServerIds.has(h.entityId));
    logger.log({
      endpoint: "/api/v2/entities",
      requestParams: { entitySelector: "type(HOST)" },
      rawResponse: hosts,
      newRecords: newHosts,
      updatedRecords: updatedHosts,
    });

    for (const host of hosts) {
      await db
        .insert(dbServers)
        .values({
          externalId: host.entityId,
          source: "dynatrace",
          name: host.displayName,
          role: "Host",
          tier: "Infrastructure",
          status: "Healthy",
          metadata: host as any,
          lastSyncAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [dbServers.externalId, dbServers.source],
          set: {
            name: host.displayName,
            metadata: host as any,
            lastSyncAt: new Date(),
            updatedAt: new Date(),
          },
        });
      servers++;
    }

    // 4. Sync host CPU metrics
    try {
      const cpuResult = await client.getCpuMetrics("now-2h");
      for (const series of cpuResult.result ?? []) {
        for (const dataPoint of series.data ?? []) {
          for (let i = 0; i < dataPoint.timestamps.length; i++) {
            const val = dataPoint.values[i];
            if (val == null) continue;
            await db.insert(dbMetrics).values({
              entityId: series.metricId,
              entityType: "host",
              source: "dynatrace",
              metricName: "cpu_usage",
              recordedAt: new Date(dataPoint.timestamps[i]),
              value: val,
            }).onConflictDoNothing();
          }
        }
      }
    } catch (_) { }

    // Update credential last sync time
    if (credential) {
      await db.update(apmCredentials).set({ lastSyncAt: new Date() }).where(eq(apmCredentials.id, credential.id));
    }

    const logResult = logger.flush();
    const syncRunId = logResult?.syncRunId;

    return {
      source: "dynatrace",
      status: "success",
      recordsSynced: applications + incidents + alerts + servers,
      applicationsCount: applications,
      incidentsCount: incidents,
      alertsCount: alerts,
      serversCount: servers,
      durationMs: Date.now() - start,
      syncRunId,
    };
  } catch (err: any) {
    logger.flush();
    return {
      source: "dynatrace",
      status: "failed",
      recordsSynced: applications + incidents + alerts + servers,
      applicationsCount: applications,
      incidentsCount: incidents,
      alertsCount: alerts,
      serversCount: servers,
      errorMessage: err.message,
      durationMs: Date.now() - start,
    };
  }
}

// ─── Orchestration ───────────────────────────────────────────────────────────
export async function syncAll(actorUserId?: number | null): Promise<{ results: SyncResult[]; totalSynced: number }> {
  const results: SyncResult[] = [];

  let credentials: ApmCredential[] = [];
  try {
    credentials = await db.select().from(apmCredentials).where(eq(apmCredentials.isActive, true));
  } catch (_) { }

  const appdCredentials = credentials.filter(c => c.source === "appdynamics");
  const dtCredentials   = credentials.filter(c => c.source === "dynatrace");

  const hasAppdEnv = !!(process.env.APPDYNAMICS_URL && process.env.APPDYNAMICS_ACCOUNT && process.env.APPDYNAMICS_USERNAME && process.env.APPDYNAMICS_PASSWORD);
  if (appdCredentials.length === 0 && hasAppdEnv) {
    const logEntry = await db.insert(dbSyncLogs).values({ source: "appdynamics", startedAt: new Date(), status: "running" }).returning();
    const result = await syncAppDynamics(undefined, actorUserId);
    results.push(result);
    await db.update(dbSyncLogs).set({
      completedAt: new Date(),
      status: result.status,
      recordsSynced: result.recordsSynced,
      applicationsCount: result.applicationsCount,
      incidentsCount: result.incidentsCount,
      alertsCount: result.alertsCount,
      serversCount: result.serversCount,
      errorMessage: result.errorMessage ?? null,
    }).where(eq(dbSyncLogs.id, logEntry[0].id));
  } else if (appdCredentials.length > 0) {
    for (const cred of appdCredentials) {
      const logEntry = await db.insert(dbSyncLogs).values({ source: "appdynamics", credentialId: cred.id, startedAt: new Date(), status: "running" }).returning();
      const result = await syncAppDynamics(cred, actorUserId);
      results.push(result);
      await db.update(dbSyncLogs).set({
        completedAt: new Date(),
        status: result.status,
        recordsSynced: result.recordsSynced,
        applicationsCount: result.applicationsCount,
        incidentsCount: result.incidentsCount,
        alertsCount: result.alertsCount,
        serversCount: result.serversCount,
        errorMessage: result.errorMessage ?? null,
      }).where(eq(dbSyncLogs.id, logEntry[0].id));
    }
  }

  const hasDtEnv = !!(process.env.DYNATRACE_URL && process.env.DYNATRACE_TOKEN);
  if (dtCredentials.length === 0 && hasDtEnv) {
    const logEntry = await db.insert(dbSyncLogs).values({ source: "dynatrace", startedAt: new Date(), status: "running" }).returning();
    const result = await syncDynatrace(undefined, actorUserId);
    results.push(result);
    await db.update(dbSyncLogs).set({
      completedAt: new Date(),
      status: result.status,
      recordsSynced: result.recordsSynced,
      applicationsCount: result.applicationsCount,
      incidentsCount: result.incidentsCount,
      alertsCount: result.alertsCount,
      serversCount: result.serversCount,
      errorMessage: result.errorMessage ?? null,
    }).where(eq(dbSyncLogs.id, logEntry[0].id));
  } else if (dtCredentials.length > 0) {
    for (const cred of dtCredentials) {
      const logEntry = await db.insert(dbSyncLogs).values({ source: "dynatrace", credentialId: cred.id, startedAt: new Date(), status: "running" }).returning();
      const result = await syncDynatrace(cred, actorUserId);
      results.push(result);
      await db.update(dbSyncLogs).set({
        completedAt: new Date(),
        status: result.status,
        recordsSynced: result.recordsSynced,
        applicationsCount: result.applicationsCount,
        incidentsCount: result.incidentsCount,
        alertsCount: result.alertsCount,
        serversCount: result.serversCount,
        errorMessage: result.errorMessage ?? null,
      }).where(eq(dbSyncLogs.id, logEntry[0].id));
    }
  }

  const totalSynced = results.reduce((sum, r) => sum + r.recordsSynced, 0);
  return { results, totalSynced };
}

export async function syncSource(source: "appdynamics" | "dynatrace", credentialId?: number, actorUserId?: number | null): Promise<SyncResult> {
  let credential: ApmCredential | undefined;
  if (credentialId) {
    const rows = await db.select().from(apmCredentials).where(and(eq(apmCredentials.id, credentialId), eq(apmCredentials.isActive, true)));
    credential = rows[0];
  } else {
    const rows = await db.select().from(apmCredentials).where(and(eq(apmCredentials.source, source), eq(apmCredentials.isActive, true))).limit(1);
    credential = rows[0];
  }
  return source === "appdynamics"
    ? syncAppDynamics(credential, actorUserId)
    : syncDynatrace(credential, actorUserId);
}

export async function getSyncStatus(credentialIds?: number[]): Promise<any> {
  try {
    const scopedIds = Array.isArray(credentialIds)
      ? credentialIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
      : null;
    if (scopedIds != null && scopedIds.length === 0) {
      return {
        credentials: [],
        counts: { applications: 0, incidents: 0, alerts: 0, servers: 0 },
        recentLogs: [],
        envCredentials: {
          appDynamics: !!(process.env.APPDYNAMICS_URL && process.env.APPDYNAMICS_ACCOUNT),
          dynatrace: !!(process.env.DYNATRACE_URL && process.env.DYNATRACE_TOKEN),
        },
      };
    }

    const credFilter = scopedIds == null
      ? undefined
      : scopedIds.length === 1
        ? eq(apmCredentials.id, scopedIds[0])
        : sql`${apmCredentials.id} = ANY(ARRAY[${sql.join(scopedIds.map((id) => sql`${id}`), sql`, `)}]::integer[])`;

    const logFilter = scopedIds == null
      ? undefined
      : scopedIds.length === 1
        ? eq(dbSyncLogs.credentialId, scopedIds[0])
        : sql`${dbSyncLogs.credentialId} = ANY(ARRAY[${sql.join(scopedIds.map((id) => sql`${id}`), sql`, `)}]::integer[])`;

    const appFilter = scopedIds == null
      ? undefined
      : scopedIds.length === 1
        ? eq(dbApplications.credentialId, scopedIds[0])
        : sql`${dbApplications.credentialId} = ANY(ARRAY[${sql.join(scopedIds.map((id) => sql`${id}`), sql`, `)}]::integer[])`;

    const incidentsFilter = scopedIds == null
      ? undefined
      : scopedIds.length === 1
        ? sql`${dbIncidents.applicationId} IN (SELECT external_id::text FROM apm_applications WHERE credential_id = ${scopedIds[0]})`
        : sql`${dbIncidents.applicationId} IN (SELECT external_id::text FROM apm_applications WHERE credential_id = ANY(ARRAY[${sql.join(scopedIds.map((id) => sql`${id}`), sql`, `)}]::integer[]))`;

    const alertsFilter = scopedIds == null
      ? undefined
      : scopedIds.length === 1
        ? sql`${dbAlerts.applicationId} IN (SELECT external_id::text FROM apm_applications WHERE credential_id = ${scopedIds[0]})`
        : sql`${dbAlerts.applicationId} IN (SELECT external_id::text FROM apm_applications WHERE credential_id = ANY(ARRAY[${sql.join(scopedIds.map((id) => sql`${id}`), sql`, `)}]::integer[]))`;

    const serversFilter = scopedIds == null
      ? undefined
      : scopedIds.length === 1
        ? sql`${dbServers.applicationId} IN (SELECT external_id::text FROM apm_applications WHERE credential_id = ${scopedIds[0]})`
        : sql`${dbServers.applicationId} IN (SELECT external_id::text FROM apm_applications WHERE credential_id = ANY(ARRAY[${sql.join(scopedIds.map((id) => sql`${id}`), sql`, `)}]::integer[]))`;

    const logs = await (logFilter
      ? db.select().from(dbSyncLogs).where(logFilter).orderBy(dbSyncLogs.startedAt).limit(20)
      : db.select().from(dbSyncLogs).orderBy(dbSyncLogs.startedAt).limit(20));
    const credentials = await (credFilter
      ? db.select().from(apmCredentials).where(credFilter)
      : db.select().from(apmCredentials));
    const [appCount] = await (appFilter
      ? db.select({ count: count() }).from(dbApplications).where(appFilter)
      : db.select({ count: count() }).from(dbApplications));
    const [incCount] = await (incidentsFilter
      ? db.select({ count: count() }).from(dbIncidents).where(incidentsFilter)
      : db.select({ count: count() }).from(dbIncidents));
    const [alertCount] = await (alertsFilter
      ? db.select({ count: count() }).from(dbAlerts).where(alertsFilter)
      : db.select({ count: count() }).from(dbAlerts));
    const [serverCount] = await (serversFilter
      ? db.select({ count: count() }).from(dbServers).where(serversFilter)
      : db.select({ count: count() }).from(dbServers));

    return {
      credentials: credentials.map(c => ({
        id: c.id,
        source: c.source,
        label: c.label,
        controllerUrl: c.controllerUrl,
        isActive: c.isActive,
        lastSyncAt: c.lastSyncAt,
      })),
      counts: {
        applications: appCount?.count ?? 0,
        incidents: incCount?.count ?? 0,
        alerts: alertCount?.count ?? 0,
        servers: serverCount?.count ?? 0,
      },
      recentLogs: logs.slice(-10).reverse(),
      envCredentials: {
        appDynamics: !!(process.env.APPDYNAMICS_URL && process.env.APPDYNAMICS_ACCOUNT),
        dynatrace: !!(process.env.DYNATRACE_URL && process.env.DYNATRACE_TOKEN),
      },
    };
  } catch {
    return { credentials: [], counts: {}, recentLogs: [], envCredentials: {} };
  }
}

export function startBackgroundSync(intervalMs = 60000) {
  console.log(`[SyncService] Background sync started — interval: ${intervalMs / 1000}s`);
  setInterval(async () => {
    console.log("[SyncService] Running scheduled sync…");
    try {
      const { results, totalSynced } = await syncAll();
      const summary = results.map(r => `${r.source}: ${r.status} (${r.recordsSynced} records${r.syncRunId ? `, run=${r.syncRunId.slice(0, 8)}` : ""})`).join(", ");
      console.log(`[SyncService] Sync complete — ${totalSynced} total records. ${summary}`);
    } catch (err: any) {
      console.error("[SyncService] Sync error:", err.message);
    }
  }, intervalMs);
}
