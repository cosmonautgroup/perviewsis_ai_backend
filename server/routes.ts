import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { db } from "./db";
import {
  apmCredentials, dbApplications, dbIncidents, dbAlerts, dbServers, dbSyncLogs,
  dbErrors, dbTransactions, dbCapacityRisks, dbMetrics,
  organizations, users, organizationMembers, invitations, ROLES,
} from "@shared/schema";
import { eq, desc, and, isNull, sql, gt, inArray, lte } from "drizzle-orm";
import { syncAll, syncSource, getSyncStatus } from "./services/syncService";
import { listSyncRuns, getSyncRunFilePath } from "./services/syncRunLogger";
import {
  runCausalPredictive, runRootCause, runCorrelationInsights,
  runRecommendations, runServiceRiskRanking, getOrgCredIds,
} from "./services/ai.service";
import { checkOllamaHealth } from "./services/ollama.service";
import {
  DEMO_CAUSAL_PREDICTIVE, DEMO_ROOT_CAUSE, DEMO_CORRELATION_INSIGHTS,
  DEMO_RECOMMENDATIONS, DEMO_SERVICE_RISK_RANKING,
} from "./services/ai-demo-data";
import {
  streamInsightChat, streamDemoInsightChat,
} from "./services/insightNavigator.service";
import {
  insightNavSessions, insightNavMessages,
} from "@shared/schema";
import { AppDynamicsClient, createAppDynamicsClient } from "./services/appDynamics";
import { createDynatraceClient } from "./services/dynatrace";
import fs from "fs";
import passport from "passport";
import { decryptSecret, encryptSecret } from "./services/credentialCrypto";
import {
  requireAuth, requireRole, signupUser, createInvitation, acceptInvitation, getUserOrg, hashPassword,
} from "./auth";

async function ensureInsightNavigatorTables(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS insight_nav_sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      org_id INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT 'New Conversation',
      created_at TIMESTAMP DEFAULT now(),
      updated_at TIMESTAMP DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS insight_nav_messages (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      structured_data JSONB,
      created_at TIMESTAMP DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_insight_nav_sessions_user_org_updated
    ON insight_nav_sessions(user_id, org_id, updated_at DESC);
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_insight_nav_messages_session_created
    ON insight_nav_messages(session_id, created_at);
  `);
}
export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  await ensureInsightNavigatorTables();
  // ══════════════════════════════════════════════════════════════
  // AUTH ROUTES (public — no auth required)
  // ══════════════════════════════════════════════════════════════

  app.post("/api/auth/signup", async (req, res) => {
    const { email, password, name, organizationName } = req.body;
    if (!email || !password || !name || !organizationName) {
      return res.status(400).json({ error: "email, password, name, and organizationName are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }
    try {
      const { user, org, membership } = await signupUser(email, password, name, organizationName);
      req.login(user, (err) => {
        if (err) return res.status(500).json({ error: "Login after signup failed" });
        (req.session as any).currentOrgId = org.id;
        const { passwordHash: _, ...publicUser } = user;
        res.status(201).json({ user: publicUser, organization: org, role: membership.role });
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/auth/login", (req, res, next) => {
    passport.authenticate("local", (err: any, user: any, info: any) => {
      if (err) return res.status(500).json({ error: "Authentication error" });
      if (!user) return res.status(401).json({ error: info?.message ?? "Invalid credentials" });
      req.login(user, async (loginErr) => {
        if (loginErr) return res.status(500).json({ error: "Login failed" });
        // Get user's organization and set session
        const orgData = await getUserOrg(user.id);
        if (orgData) (req.session as any).currentOrgId = orgData.org.id;
        const { passwordHash: _, ...publicUser } = user;
        res.json({ user: publicUser, organization: orgData?.org ?? null, role: orgData?.membership.role ?? null });
      });
    })(req, res, next);
  });

  app.post("/api/auth/logout", (req, res) => {
    req.logout(() => {
      req.session.destroy(() => {
        res.json({ success: true });
      });
    });
  });

  app.get("/api/auth/me", async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: "Not authenticated" });
    const user = req.user as import("@shared/schema").User;
    const orgData = await getUserOrg(user.id);
    const { passwordHash: _, ...publicUser } = user;
    res.json({ user: publicUser, organization: orgData?.org ?? null, role: orgData?.membership.role ?? null });
  });

  // Accept an invitation (authenticated user)
  app.post("/api/auth/accept-invite", requireAuth, async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "token required" });
    try {
      const user = req.user as import("@shared/schema").User;
      const { org, membership } = await acceptInvitation(token, user.id);
      (req.session as any).currentOrgId = org.id;
      res.json({ organization: org, role: membership.role });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Get invite details without auth (for invite page)
  app.get("/api/auth/invite/:token", async (req, res) => {
    const [inv] = await db.select().from(invitations).where(eq(invitations.token, req.params.token));
    if (!inv || inv.acceptedAt || inv.expiresAt < new Date()) {
      return res.status(404).json({ error: "Invitation not found or expired" });
    }
    const [org] = await db.select().from(organizations).where(eq(organizations.id, inv.organizationId));
    res.json({ email: inv.email, role: inv.role, organizationName: org?.name ?? "Unknown Org" });
  });

  // ══════════════════════════════════════════════════════════════
  // ORGANIZATION MANAGEMENT ROUTES (auth required)
  // ══════════════════════════════════════════════════════════════

  app.get("/api/org", requireAuth, async (req, res) => {
    const user = req.user as import("@shared/schema").User;
    const orgData = await getUserOrg(user.id);
    if (!orgData) return res.status(404).json({ error: "Not a member of any organization" });
    res.json({ organization: orgData.org, role: orgData.membership.role });
  });

  app.put("/api/org", requireRole("Admin"), async (req, res) => {
    const user = req.user as import("@shared/schema").User;
    const orgData = await getUserOrg(user.id);
    if (!orgData) return res.status(404).json({ error: "Organization not found" });
    const { name } = req.body;
    const [updated] = await db.update(organizations)
      .set({ name, updatedAt: new Date() })
      .where(eq(organizations.id, orgData.org.id))
      .returning();
    res.json(updated);
  });

  app.get("/api/org/members", requireAuth, async (req, res) => {
    const user = req.user as import("@shared/schema").User;
    const orgData = await getUserOrg(user.id);
    if (!orgData) return res.status(404).json({ error: "Organization not found" });

    const members = await db
      .select({
        id: organizationMembers.id,
        userId: organizationMembers.userId,
        role: organizationMembers.role,
        joinedAt: organizationMembers.joinedAt,
        name: users.name,
        email: users.email,
        avatarInitials: users.avatarInitials,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(eq(organizationMembers.organizationId, orgData.org.id));

    res.json(members);
  });

  app.put("/api/org/members/:id/role", requireRole("Admin"), async (req, res) => {
    const { role } = req.body;
    if (!ROLES.includes(role)) return res.status(400).json({ error: `Role must be one of: ${ROLES.join(", ")}` });
    const [updated] = await db.update(organizationMembers)
      .set({ role })
      .where(eq(organizationMembers.id, parseInt(req.params.id)))
      .returning();
    res.json(updated);
  });

  app.delete("/api/org/members/:id", requireRole("Admin"), async (req, res) => {
    const user = req.user as import("@shared/schema").User;
    // Prevent removing yourself
    const [member] = await db.select().from(organizationMembers).where(eq(organizationMembers.id, parseInt(req.params.id)));
    if (member?.userId === user.id) return res.status(400).json({ error: "Cannot remove yourself" });
    await db.delete(organizationMembers).where(eq(organizationMembers.id, parseInt(req.params.id)));
    res.json({ success: true });
  });

  app.post("/api/org/invite", requireRole("Admin"), async (req, res) => {
    const user = req.user as import("@shared/schema").User;
    const orgData = await getUserOrg(user.id);
    if (!orgData) return res.status(404).json({ error: "Organization not found" });

    const { email, role } = req.body;
    if (!email) return res.status(400).json({ error: "email required" });
    if (!ROLES.includes(role)) return res.status(400).json({ error: `Role must be one of: ${ROLES.join(", ")}` });

    try {
      const inv = await createInvitation(orgData.org.id, email, role, user.id);
      res.status(201).json(inv);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/api/org/invitations", requireAuth, async (req, res) => {
    const user = req.user as import("@shared/schema").User;
    const orgData = await getUserOrg(user.id);
    if (!orgData) return res.status(404).json({ error: "Organization not found" });

    const pending = await db.select().from(invitations)
      .where(and(
        eq(invitations.organizationId, orgData.org.id),
        isNull(invitations.acceptedAt)
      ))
      .orderBy(desc(invitations.createdAt));
    res.json(pending);
  });

  app.delete("/api/org/invitations/:id", requireRole("Admin"), async (req, res) => {
    await db.delete(invitations).where(eq(invitations.id, parseInt(req.params.id)));
    res.json({ success: true });
  });

  app.put("/api/org/profile", requireAuth, async (req, res) => {
    const user = req.user as import("@shared/schema").User;
    const { name } = req.body;
    const initials = name.split(" ").map((p: string) => p[0]).join("").toUpperCase().slice(0, 2);
    const [updated] = await db.update(users)
      .set({ name, avatarInitials: initials, updatedAt: new Date() })
      .where(eq(users.id, user.id))
      .returning();
    const { passwordHash: _, ...publicUser } = updated;
    res.json(publicUser);
  });

  app.put("/api/org/password", requireAuth, async (req, res) => {
    const user = req.user as import("@shared/schema").User;
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: "currentPassword and newPassword required" });
    if (newPassword.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters" });

    const bcrypt = await import("bcrypt");
    const match = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!match) return res.status(400).json({ error: "Current password is incorrect" });

    const newHash = await hashPassword(newPassword);
    await db.update(users).set({ passwordHash: newHash, updatedAt: new Date() }).where(eq(users.id, user.id));
    res.json({ success: true });
  });

  // ══════════════════════════════════════════════════════════════
  // GLOBAL AUTH GUARD for all subsequent API routes
  // ══════════════════════════════════════════════════════════════
  app.use("/api", requireAuth);

  function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
  }

  function buildSeries(opts: {
    base: number;
    variance: number;
    min?: number;
    max?: number;
    points?: number;
    stepMs?: number;
  }) {
    const points = opts.points ?? 24;
    const stepMs = opts.stepMs ?? 60 * 60 * 1000;
    const min = opts.min ?? 0;
    const max = opts.max ?? Math.max(min + 1, opts.base + opts.variance * 3);
    const now = Date.now();
    return Array.from({ length: points }).map((_, i) => {
      const ts = now - (points - 1 - i) * stepMs;
      const wave = Math.sin(i / 3) * opts.variance;
      const wobble = ((i * 7) % 10 - 5) * (opts.variance * 0.08);
      const value = clamp(opts.base + wave + wobble, min, max);
      return { timestamp: ts, value: Number(value.toFixed(2)) };
    });
  }

  function extractHttpCode(message?: string | null): string | null {
    if (!message) return null;
    const match = message.match(/\b(4\d{2}|5\d{2})\b/);
    return match?.[1] ?? null;
  }

  app.get(api.auth.status.path, async (_req, res) => {
    res.json({ connected: true, useMock: false });
  });

  // === Applications ===
  // Return org-scoped real data from DB if credentials exist; empty array otherwise
  app.get(api.applications.list.path, async (req, res) => {
    const durationMins = Math.max(60, Number(req.query.durationMins ?? 1440));
    const startParam = req.query.start as string | undefined;
    const endParam = req.query.end as string | undefined;
    const startMs = startParam ? Date.parse(startParam) : NaN;
    const endMs = endParam ? Date.parse(endParam) : NaN;
    const hasCustomRange = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs;
      const user = req.user as import("@shared/schema").User | undefined;
      if (user) {
        const orgData = await getUserOrg(user.id);
        if (orgData) {
          let orgId = orgData.org.id;
          const currentOrgId = Number((req.session as any)?.currentOrgId);
          if (Number.isFinite(currentOrgId) && currentOrgId > 0) {
            const [membership] = await db
              .select({ id: organizationMembers.id })
              .from(organizationMembers)
              .where(and(
                eq(organizationMembers.userId, user.id),
                eq(organizationMembers.organizationId, currentOrgId),
              ))
              .limit(1);
            if (membership) orgId = currentOrgId;
          }
          const orgCreds = await db.select({ id: apmCredentials.id })
            .from(apmCredentials)
            .where(and(eq(apmCredentials.organizationId, orgId), eq(apmCredentials.isActive, true)));
        if (orgCreds.length === 0) return res.json([]);
        const credIds = orgCreds.map(c => c.id);
        const apps = await db.select().from(dbApplications)
          .where(credIds.length === 1
            ? eq(dbApplications.credentialId, credIds[0])
            : sql`${dbApplications.credentialId} = ANY(ARRAY[${sql.join(credIds.map(id => sql`${id}`), sql`, `)}]::integer[])`)
          .orderBy(dbApplications.name);
        const externalIds = apps.map(a => a.externalId);
        const since = hasCustomRange
          ? new Date(startMs)
          : new Date(Date.now() - durationMins * 60 * 1000);
        const metricAgg = new Map<string, { sum: number; count: number }>();
        const latestMetric = new Map<string, number>();
        const txAgg = new Map<string, { respSum: number; respCount: number; callsSum: number; errSum: number; errCount: number }>();
        if (externalIds.length > 0) {
          const metricRows = await db.select({
            entityId: dbMetrics.entityId,
            credentialId: dbMetrics.credentialId,
            metricName: dbMetrics.metricName,
            value: dbMetrics.value,
            recordedAt: dbMetrics.recordedAt,
          }).from(dbMetrics)
            .where(and(
              eq(dbMetrics.entityType, "application"),
              inArray(dbMetrics.entityId, externalIds),
              inArray(dbMetrics.credentialId, credIds),
              inArray(dbMetrics.metricName, ["avg_response_time", "calls_per_minute", "errors_per_minute"]),
              gt(dbMetrics.recordedAt, since),
              ...(hasCustomRange ? [lte(dbMetrics.recordedAt, new Date(endMs))] : [])
            ));
          for (const row of metricRows) {
            const key = `${row.entityId}::${row.metricName}::${row.credentialId ?? ""}`;
            const agg = metricAgg.get(key) ?? { sum: 0, count: 0 };
            agg.sum += row.value ?? 0;
            agg.count += 1;
            metricAgg.set(key, agg);
          }
          const latestRows = await db.execute(sql`
            SELECT DISTINCT ON (entity_id, metric_name, credential_id)
              entity_id, metric_name, credential_id, value, recorded_at
            FROM apm_metrics
            WHERE entity_type = 'application'
              AND entity_id = ANY(ARRAY[${sql.join(externalIds.map(id => sql`${id}`), sql`, `)}]::text[])
              AND credential_id = ANY(ARRAY[${sql.join(credIds.map(id => sql`${id}`), sql`, `)}]::integer[])
              AND metric_name = ANY(ARRAY['avg_response_time','calls_per_minute','errors_per_minute'])
            ORDER BY entity_id, metric_name, credential_id, recorded_at DESC
          `);
          const rows = (latestRows as any).rows ?? [];
          for (const row of rows) {
            const key = `${row.entity_id}::${row.metric_name}::${row.credential_id ?? ""}`;
            if (row.value != null) latestMetric.set(key, Number(row.value));
          }

          const txRows = await db.select({
            applicationId: dbTransactions.applicationId,
            avgResponseTime: dbTransactions.avgResponseTime,
            callsPerMinute: dbTransactions.callsPerMinute,
            errorRate: dbTransactions.errorRate,
          }).from(dbTransactions)
            .where(inArray(dbTransactions.applicationId, externalIds));
          for (const row of txRows) {
            const appId = row.applicationId ?? "";
            if (!appId) continue;
            const agg = txAgg.get(appId) ?? { respSum: 0, respCount: 0, callsSum: 0, errSum: 0, errCount: 0 };
            if (row.avgResponseTime != null) {
              agg.respSum += row.avgResponseTime;
              agg.respCount += 1;
            }
            if (row.callsPerMinute != null) {
              agg.callsSum += row.callsPerMinute;
            }
            if (row.errorRate != null) {
              agg.errSum += row.errorRate;
              agg.errCount += 1;
            }
            txAgg.set(appId, agg);
          }
        }
          return res.json(apps.map(a => {
            const hasMetricAgg =
              (metricAgg.get(`${a.externalId}::avg_response_time::${a.credentialId ?? ""}`)?.count ?? 0) > 0 ||
              (metricAgg.get(`${a.externalId}::calls_per_minute::${a.credentialId ?? ""}`)?.count ?? 0) > 0 ||
              (metricAgg.get(`${a.externalId}::errors_per_minute::${a.credentialId ?? ""}`)?.count ?? 0) > 0;
            const hasMetricLatest =
              latestMetric.has(`${a.externalId}::avg_response_time::${a.credentialId ?? ""}`) ||
              latestMetric.has(`${a.externalId}::calls_per_minute::${a.credentialId ?? ""}`) ||
              latestMetric.has(`${a.externalId}::errors_per_minute::${a.credentialId ?? ""}`);
            const tx = txAgg.get(a.externalId);
            const hasTx = !!tx && (tx.respCount > 0 || tx.callsSum > 0 || tx.errCount > 0);
            const fallbackCalls = a.callsPerMinute ?? 300;
            const fallbackResp = a.avgResponseTime ?? 220;
            const fallbackErr = a.errorRate ?? 2;

            return ({
            id: a.id,
            name: a.name,
            status: a.status,
          description: a.description ?? "",
          tier: a.tier ?? "",
          healthRuleViolations: a.healthRuleViolations ?? 0,
          source: a.source,
          externalId: a.externalId,
            callsPerMinute: (() => {
              const agg = metricAgg.get(`${a.externalId}::calls_per_minute`);
              const scopedAgg = metricAgg.get(`${a.externalId}::calls_per_minute::${a.credentialId ?? ""}`);
              if (scopedAgg && scopedAgg.count > 0) return scopedAgg.sum / scopedAgg.count;
              if (agg && agg.count > 0) return agg.sum / agg.count;
              const latest = latestMetric.get(`${a.externalId}::calls_per_minute::${a.credentialId ?? ""}`);
              if (latest != null) return latest;
              const tx = txAgg.get(a.externalId);
              if (tx && tx.callsSum > 0) return tx.callsSum;
              return fallbackCalls;
            })(),
            avgResponseTime: (() => {
              const agg = metricAgg.get(`${a.externalId}::avg_response_time::${a.credentialId ?? ""}`);
              if (agg && agg.count > 0) return agg.sum / agg.count;
              const latest = latestMetric.get(`${a.externalId}::avg_response_time::${a.credentialId ?? ""}`);
              if (latest != null) return latest;
              const tx = txAgg.get(a.externalId);
              if (tx && tx.respCount > 0) return tx.respSum / tx.respCount;
              return fallbackResp;
            })(),
            errorRate: (() => {
              const errAgg = metricAgg.get(`${a.externalId}::errors_per_minute::${a.credentialId ?? ""}`);
              const callAgg = metricAgg.get(`${a.externalId}::calls_per_minute::${a.credentialId ?? ""}`);
              if (errAgg && callAgg && errAgg.count > 0 && callAgg.count > 0) {
                const err = errAgg.sum / errAgg.count;
                const cpm = callAgg.sum / callAgg.count;
                return cpm > 0 ? (err / cpm) * 100 : fallbackErr;
              }
              const latestErr = latestMetric.get(`${a.externalId}::errors_per_minute::${a.credentialId ?? ""}`);
              const latestCalls = latestMetric.get(`${a.externalId}::calls_per_minute::${a.credentialId ?? ""}`);
              if (latestErr != null && latestCalls != null && latestCalls > 0) {
                return (latestErr / latestCalls) * 100;
              }
              const tx = txAgg.get(a.externalId);
              if (tx && tx.errCount > 0) return tx.errSum / tx.errCount;
              return fallbackErr;
            })(),
          hasMetrics: hasMetricAgg || hasMetricLatest || hasTx,
          lastSyncAt: a.lastSyncAt,
        });
      }));
      }
    }
    return res.json([]);
  });
  app.get(api.applications.get.path, async (req, res) => {
    const numId = Number(req.params.id);
    // First try DB (real synced apps)
    const dbAppRows = await db.select().from(dbApplications).where(eq(dbApplications.id, numId));
    if (dbAppRows.length > 0) {
      const a = dbAppRows[0];
      return res.json({
        id: a.id,
        name: a.name,
        status: a.status,
        healthRuleViolations: a.healthRuleViolations ?? 0,
        description: a.description ?? "",
        tier: a.tier ?? "",
        externalId: a.externalId,
        source: a.source,
        callsPerMinute: a.callsPerMinute ?? 0,
        avgResponseTime: a.avgResponseTime ?? 0,
        errorRate: a.errorRate ?? 0,
        healthScore: a.healthScore ?? 80,
        lastSyncAt: a.lastSyncAt,
      });
    }
    // Fall back to MemStorage (demo mock apps)
    const found = await storage.getApplication(numId);
    if (!found) return res.status(404).json({ message: "Not found" });
    res.json(found);
  });
  app.get(api.applications.transactions.path, async (req, res) => {
    const numId = Number(req.params.id);
    const qDuration = Array.isArray(req.query.durationMins) ? req.query.durationMins[0] : req.query.durationMins;
    const qStart = Array.isArray(req.query.start) ? req.query.start[0] : req.query.start;
    const qEnd = Array.isArray(req.query.end) ? req.query.end[0] : req.query.end;
    const parsedDuration = Number(qDuration);
    const startMs = qStart ? Date.parse(String(qStart)) : NaN;
    const endMs = qEnd ? Date.parse(String(qEnd)) : NaN;
    const customDurationMins =
      Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
        ? Math.max(1, Math.floor((endMs - startMs) / 60000))
        : null;
    const metricWindowMins = customDurationMins ?? (Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : 1440);
    const hasExplicitWindowFilter =
      Number.isFinite(parsedDuration) && parsedDuration > 0
      || (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs);
    // Check if this is a real DB app; if so, return real BT data
    const dbAppRows = await db.select({
      externalId: dbApplications.externalId,
      credentialId: dbApplications.credentialId,
      source: dbApplications.source,
    }).from(dbApplications).where(eq(dbApplications.id, numId));
    if (dbAppRows.length > 0) {
      const appRow = dbAppRows[0];
      const externalId = appRow.externalId;
      const bts = await db.select().from(dbTransactions)
        .where(and(
          eq(dbTransactions.applicationId, externalId),
          appRow.credentialId != null
            ? eq(dbTransactions.credentialId, appRow.credentialId)
            : sql`${dbTransactions.credentialId} IS NULL`
        ))
        .orderBy(desc(dbTransactions.avgResponseTime))
        .limit(50);
      if (bts.length > 0) {
        let btRows = bts;
        if (appRow.source === "appdynamics" && appRow.credentialId) {
          try {
            const [cred] = await db.select().from(apmCredentials).where(eq(apmCredentials.id, appRow.credentialId)).limit(1);
            if (cred) {
              const client = new AppDynamicsClient({
                controllerUrl: cred.controllerUrl,
                account: cred.account ?? "",
                username: cred.username ?? "",
                password: decryptSecret(cred.passwordHash) ?? "",
              });

              const avgPoint = (series: any[]): number | null => {
                let sum = 0;
                let count = 0;
                for (const s of series ?? []) {
                  for (const p of (s.metricValues ?? [])) {
                    if (p?.value == null) continue;
                    sum += Number(p.value);
                    count += 1;
                  }
                }
                return count > 0 ? (sum / count) : null;
              };

              const merge = await Promise.all(bts.map(async (bt) => {
                const base = `Business Transaction Performance|Business Transactions|${bt.tier ?? ""}|${bt.name}`;
                const [errSeries, callsSeries, respSeries, slowSeries, verySlowSeries] = await Promise.all([
                  client.getMetricData(Number(externalId), `${base}|Errors per Minute`, metricWindowMins).catch(() => [] as any[]),
                  client.getMetricData(Number(externalId), `${base}|Calls per Minute`, metricWindowMins).catch(() => [] as any[]),
                  client.getMetricData(Number(externalId), `${base}|Average Response Time (ms)`, metricWindowMins).catch(() => [] as any[]),
                  client.getMetricData(Number(externalId), `${base}|Slow Calls`, metricWindowMins).catch(() => [] as any[]),
                  client.getMetricData(Number(externalId), `${base}|Very Slow Calls`, metricWindowMins).catch(() => [] as any[]),
                ]);

                const errorsPerMin = avgPoint(errSeries) ?? 0;
                const callsPerMin = avgPoint(callsSeries) ?? 0;
                const avgResp = avgPoint(respSeries) ?? 0;
                const slowCalls = avgPoint(slowSeries) ?? 0;
                const verySlowCalls = avgPoint(verySlowSeries) ?? 0;
                const errPct = callsPerMin > 0 ? (errorsPerMin / callsPerMin) * 100 : 0;
                const slowPct = callsPerMin > 0 ? (slowCalls / callsPerMin) * 100 : 0;
                const verySlowPct = callsPerMin > 0 ? (verySlowCalls / callsPerMin) * 100 : 0;

                const status = errPct > 5
                  ? "Critical"
                  : verySlowPct > 0
                    ? "Very Slow"
                    : slowPct > 0
                      ? "Slow"
                      : "Normal";
                return {
                  ...bt,
                  avgResponseTime: avgResp,
                  callsPerMinute: callsPerMin,
                  errorsPerMinute: errorsPerMin,
                  slowCalls,
                  verySlowCalls,
                  slowTransactionPercent: slowPct,
                  verySlowTransactionPercent: verySlowPct,
                  errorRate: errPct,
                  status,
                };
              }));

              // Match AppDynamics behavior for selected windows:
              // show only BTs that actually have activity/metrics in that window.
              btRows = hasExplicitWindowFilter
                ? (merge as any[]).filter((bt) =>
                    Number(bt.callsPerMinute ?? 0) > 0
                    || Number(bt.errorsPerMinute ?? 0) > 0
                    || Number(bt.avgResponseTime ?? 0) > 0
                    || Number(bt.slowCalls ?? 0) > 0
                    || Number(bt.verySlowCalls ?? 0) > 0
                  )
                : merge as any;
            }
          } catch (_) { }
        }

        return res.json(btRows.map((bt, i) => ({
          id: bt.id ?? (numId * 100 + i),
          name: bt.name,
          tier: bt.tier ?? "",
          avgResponseTime: bt.avgResponseTime ?? 0,
          callsPerMinute: bt.callsPerMinute ?? 0,
          errorsPerMinute: bt.errorsPerMinute ?? 0,
          slowCalls: bt.slowCalls ?? 0,
          verySlowCalls: bt.verySlowCalls ?? 0,
          slowTransactionPercent: bt.slowTransactionPercent ?? 0,
          verySlowTransactionPercent: bt.verySlowTransactionPercent ?? 0,
          errorRate: bt.errorRate ?? 0,
          status: bt.status ?? "Normal",
        })));
      }
    }
    res.json(await storage.getBusinessTransactions(numId));
  });
  app.get(api.applications.nodes.path, async (req, res) => {
    const numId = Number(req.params.id);
    // Check if this is a real DB app; if so, return real server data as nodes
    const dbAppRows = await db.select({
      externalId: dbApplications.externalId,
      credentialId: dbApplications.credentialId,
    }).from(dbApplications).where(eq(dbApplications.id, numId));
    if (dbAppRows.length > 0) {
      const externalId = dbAppRows[0].externalId;
      const credentialId = dbAppRows[0].credentialId;
      const servers = await db.select().from(dbServers)
        .where(eq(dbServers.applicationId, externalId))
        .limit(20);
      if (servers.length > 0) {
          let fallbackCpu = 0;
          let fallbackMem = 0;
          if (credentialId != null) {
            const [latestCpu] = await db.select({ value: dbMetrics.value }).from(dbMetrics)
              .where(and(
                eq(dbMetrics.entityType, "application"),
                eq(dbMetrics.entityId, externalId),
                eq(dbMetrics.credentialId, credentialId),
                eq(dbMetrics.metricName, "cpu_usage"),
              ))
              .orderBy(desc(dbMetrics.recordedAt))
              .limit(1);
            const [latestMem] = await db.select({ value: dbMetrics.value }).from(dbMetrics)
              .where(and(
                eq(dbMetrics.entityType, "application"),
                eq(dbMetrics.entityId, externalId),
                eq(dbMetrics.credentialId, credentialId),
                eq(dbMetrics.metricName, "memory_usage"),
              ))
              .orderBy(desc(dbMetrics.recordedAt))
              .limit(1);
            fallbackCpu = Number(latestCpu?.value ?? 0);
            fallbackMem = Number(latestMem?.value ?? 0);
          }
          return res.json(servers.map(s => ({
            id: s.id,
            name: s.name,
            tier: s.tier ?? "",
            cpuUsage: (s.cpuUsage ?? 0) > 0 ? (s.cpuUsage ?? 0) : fallbackCpu,
            memoryUsage: (s.memoryUsage ?? 0) > 0 ? (s.memoryUsage ?? 0) : fallbackMem,
            status: s.status ?? "Healthy",
          })));
      }
    }
    res.json(await storage.getNodes(numId));
  });
  app.get("/api/applications/:id/tiers", async (req, res) => {
    const numId = Number(req.params.id);
    const [row] = await db.select({ metadata: dbApplications.metadata }).from(dbApplications).where(eq(dbApplications.id, numId));
    const tiers = (row?.metadata as any)?.tiers;
    if (Array.isArray(tiers)) {
      return res.json(tiers.map((t: any) => ({
        id: t.id,
        name: t.name,
        description: t.description ?? "",
        type: t.type ?? "",
        numberOfNodes: t.numberOfNodes ?? 0,
      })));
    }
    return res.json([]);
  });
  app.get(api.applications.metrics.path, async (req, res) => {
    const appId = Number(req.params.id);
    const metricName = (req.query.metricName as string | undefined) ?? "";
    const durationMins = Math.max(60, Number(req.query.durationMins ?? 10080));
    const startParam = req.query.start as string | undefined;
    const endParam = req.query.end as string | undefined;
    const startMs = startParam ? Date.parse(startParam) : NaN;
    const endMs = endParam ? Date.parse(endParam) : NaN;
    const hasCustomRange = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs;
    const [appRow] = await db.select().from(dbApplications).where(eq(dbApplications.id, appId));
    if (!appRow) return res.json(await storage.getMetrics(appId, metricName));

    const metricNameLower = metricName.toLowerCase();
    const metricKey = metricNameLower.includes("baseline")
      ? "baseline_avg_response_time"
      : (metricNameLower.includes("bt") || metricNameLower.includes("business transaction")) && metricNameLower.includes("response")
        ? "bt_avg_response_time"
        : metricNameLower.includes("db") || metricNameLower.includes("database")
          ? "db_avg_response_time"
          : metricNameLower.includes("jvm") && metricNameLower.includes("heap")
            ? "jvm_heap_used_mb"
            : metricNameLower.includes("jvm") && metricNameLower.includes("gc")
              ? "jvm_gc_time_ms"
              : metricNameLower.includes("thread")
                ? "jvm_threads"
                : metricNameLower.includes("cpu")
                  ? "cpu_usage"
                  : metricNameLower.includes("response")
                    ? "avg_response_time"
                    : metricNameLower.includes("error")
                      ? "errors_per_minute"
                      : metricNameLower.includes("memory")
                        ? "memory_usage"
                        : metricNameLower.includes("call") || metricNameLower.includes("throughput")
                          ? "calls_per_minute"
                          : "cpu_usage";

    const since = hasCustomRange
      ? new Date(startMs)
      : new Date(Date.now() - durationMins * 60 * 1000);
    const rows = await db.select().from(dbMetrics)
      .where(and(
        eq(dbMetrics.entityType, "application"),
        eq(dbMetrics.entityId, appRow.externalId),
        eq(dbMetrics.credentialId, appRow.credentialId),
        eq(dbMetrics.metricName, metricKey),
        gt(dbMetrics.recordedAt, since)
      ))
      .orderBy(dbMetrics.recordedAt);
      if (rows.length > 0) {
        const filtered = hasCustomRange
          ? rows.filter(r => r.recordedAt.getTime() <= endMs)
          : rows;
        return res.json(filtered.map(r => ({
          timestamp: r.recordedAt.getTime(),
          value: r.value ?? 0,
        })));
      }

      // Keep dashboard behavior aligned with listing:
      // if range has no points, fall back to latest known point for this metric.
      const latestMetricRows = await db.select({
        recordedAt: dbMetrics.recordedAt,
        value: dbMetrics.value,
      }).from(dbMetrics)
        .where(and(
          eq(dbMetrics.entityType, "application"),
          eq(dbMetrics.entityId, appRow.externalId),
          eq(dbMetrics.credentialId, appRow.credentialId),
          eq(dbMetrics.metricName, metricKey),
        ))
        .orderBy(desc(dbMetrics.recordedAt))
        .limit(1);
      const latestMetric = latestMetricRows[0];
      if (latestMetric?.value != null) {
        const points = hasCustomRange ? 24 : Math.max(6, Math.min(24, Math.floor(durationMins / 60)));
        const startTs = hasCustomRange ? startMs : (Date.now() - durationMins * 60 * 1000);
        const endTs = hasCustomRange ? endMs : Date.now();
        const step = points > 1 ? Math.max(1, Math.floor((endTs - startTs) / (points - 1))) : 1;
        return res.json(Array.from({ length: points }).map((_, i) => ({
          timestamp: startTs + i * step,
          value: latestMetric.value ?? 0,
        })));
      }

    if (metricKey === "cpu_usage") {
      const servers = await db.select({ cpu: dbServers.cpuUsage }).from(dbServers)
        .where(eq(dbServers.applicationId, appRow.externalId))
        .limit(50);
      const avgCpu = servers.length > 0
        ? servers.reduce((s, v) => s + (v.cpu ?? 0), 0) / servers.length
        : 45;
      return res.json(buildSeries({ base: avgCpu, variance: 12, min: 0, max: 100 }));
    }

    if (metricKey === "avg_response_time") {
      const base = appRow.avgResponseTime ?? 220;
      return res.json(buildSeries({ base, variance: Math.max(30, base * 0.25), min: 0, max: base * 4 }));
    }

    if (metricKey === "calls_per_minute") {
      const base = appRow.callsPerMinute ?? 300;
      return res.json(buildSeries({ base, variance: Math.max(50, base * 0.35), min: 0, max: base * 2.5 }));
    }

    if (metricKey === "errors_per_minute") {
      const calls = appRow.callsPerMinute ?? 300;
      const errPct = appRow.errorRate ?? 2;
      const base = (calls * errPct) / 100;
      return res.json(buildSeries({ base, variance: Math.max(2, base * 0.4), min: 0, max: Math.max(5, base * 4) }));
    }

    if (metricKey === "memory_usage") {
      const servers = await db.select({ mem: dbServers.memoryUsage }).from(dbServers)
        .where(eq(dbServers.applicationId, appRow.externalId))
        .limit(50);
      const avgMem = servers.length > 0
        ? servers.reduce((s, v) => s + (v.mem ?? 0), 0) / servers.length
        : 60;
      return res.json(buildSeries({ base: avgMem, variance: 10, min: 0, max: 100 }));
    }

    if (metricKey === "baseline_avg_response_time") {
      const base = (appRow.avgResponseTime ?? 220) * 0.9;
      return res.json(buildSeries({ base, variance: Math.max(20, base * 0.2), min: 0, max: base * 3 }));
    }

    if (metricKey === "bt_avg_response_time") {
      const base = appRow.avgResponseTime ?? 220;
      return res.json(buildSeries({ base, variance: Math.max(40, base * 0.35), min: 0, max: base * 5 }));
    }

      if (metricKey === "db_avg_response_time") {
        const base = Math.max(0.1, (appRow.avgResponseTime ?? 220) * 0.03);
        return res.json(buildSeries({ base, variance: Math.max(0.1, base * 0.35), min: 0, max: Math.max(5, base * 4) }));
      }

      if (metricKey === "jvm_heap_used_mb") {
        return res.json(buildSeries({ base: 620, variance: 90, min: 64, max: 4096 }));
      }

      if (metricKey === "jvm_gc_time_ms") {
        return res.json(buildSeries({ base: 45, variance: 18, min: 0, max: 1000 }));
      }

      if (metricKey === "jvm_threads") {
        return res.json(buildSeries({ base: 120, variance: 22, min: 1, max: 2000 }));
      }

    return res.json(await storage.getMetrics(appId, metricName));
  });
  app.get(api.applications.incidents.path, async (req, res) => {
    const numId = Number(req.params.id);
    // Check if this is a real DB app; if so, return real incident data
    const dbAppRows = await db.select({ externalId: dbApplications.externalId }).from(dbApplications).where(eq(dbApplications.id, numId));
    if (dbAppRows.length > 0) {
      const externalId = dbAppRows[0].externalId;
      const incidents = await db.select().from(dbIncidents)
        .where(eq(dbIncidents.applicationId, externalId))
        .orderBy(desc(dbIncidents.startTime))
        .limit(20);
      if (incidents.length > 0) {
        return res.json(incidents.map(inc => {
          const sev = inc.severity ?? "Warning";
          return {
            id: inc.externalId ?? inc.id,
            title: inc.title,
            severity: sev,
            status: inc.status,
            startTime: inc.startTime?.getTime() ?? Date.now(),
            endTime: inc.endTime?.getTime() ?? null,
            affectedServices: inc.affectedServices ?? [],
            affectedTiers: inc.affectedServices ?? [],
            rootCause: inc.rootCause ?? null,
            mttr: inc.mttr ?? null,
            impactScore: sev === "Critical" ? 88 : sev === "Warning" ? 55 : 20,
            recommendation: inc.rootCause
              ? `Investigate and remediate: ${inc.rootCause.slice(0, 120)}`
              : "Follow standard runbook for this incident type.",
          };
        }));
      }
    }
    res.json(await storage.getIncidents(numId));
  });
  app.get(api.applications.forecast.path, async (req, res) => { res.json(await storage.getForecast(Number(req.params.id))); });
  app.get(api.applications.capacity.path, async (req, res) => { res.json(await storage.getCapacity(Number(req.params.id))); });

  // === Problems ===
  app.get(api.problems.get.path, async (req, res) => {
    const problem = await storage.getProblem(Number(req.params.id));
    if (!problem) return res.status(404).json({ message: "Not found" });
    res.json(problem);
  });
  app.get(api.problems.metrics.path, async (req, res) => { res.json(await storage.getProblemMetrics(Number(req.params.id))); });

  // === OTEL ===
  app.get("/api/otel/stats", async (req, res) => { res.json(await storage.getOtelStats()); });

  // === Personas ===
  app.get("/api/persona/business", async (req, res) => { res.json(await storage.getPersonaBusiness()); });
  app.get("/api/persona/sre", async (req, res) => { res.json(await storage.getPersonaSre()); });

  // === Runtime ===
  app.get("/api/runtime/:service", async (req, res) => { res.json(await storage.getRuntimeMetrics(req.params.service)); });

  // === AI (legacy) ===
  app.get("/api/ai/insights", async (req, res) => { res.json(await storage.getAiInsights()); });

  // === AI Health Check ===
  app.get("/api/ai/health", requireAuth, async (_req, res) => {
    const health = await checkOllamaHealth();
    res.json(health);
  });

  // ── Helper: get credIds for the requesting user's org ──────────────────────
  async function resolveCredIds(req: any): Promise<number[] | null> {
    const user = req.user as import("@shared/schema").User | undefined;
    if (!user) return null;
    const orgData = await getUserOrg(user.id);
    if (!orgData) return null;
    return getOrgCredIds(orgData.org.id);
  }

  async function isDemoOrg(req: any): Promise<boolean> {
    const user = req.user as import("@shared/schema").User | undefined;
    if (!user) return false;
    const orgData = await getUserOrg(user.id);
    return orgData?.org?.slug === "perviewsis-demo";
  }

  // === AI — Causal & Predictive ===
  app.post("/api/ai/causal-predictive", requireAuth, async (req, res) => {
    try {
      if (await isDemoOrg(req)) return res.json(DEMO_CAUSAL_PREDICTIVE);
      const credIds = await resolveCredIds(req);
      if (!credIds) return res.status(401).json({ error: "Not authenticated" });
      const result = await runCausalPredictive(credIds);
      res.json(result);
    } catch (err: any) {
      const isOllama = err?.cause?.code === "ECONNREFUSED" || err?.message?.includes("ECONNREFUSED");
      res.status(isOllama ? 503 : 500).json({
        error: isOllama
          ? "Ollama is not running. Start it with: ollama serve"
          : err.message ?? "AI analysis failed",
      });
    }
  });

  // === AI — Root Cause Analysis ===
  app.post("/api/ai/root-cause", requireAuth, async (req, res) => {
    try {
      if (await isDemoOrg(req)) return res.json(DEMO_ROOT_CAUSE);
      const credIds = await resolveCredIds(req);
      if (!credIds) return res.status(401).json({ error: "Not authenticated" });
      const result = await runRootCause(credIds, req.body?.incidentContext ?? undefined);
      res.json(result);
    } catch (err: any) {
      const isOllama = err?.cause?.code === "ECONNREFUSED" || err?.message?.includes("ECONNREFUSED");
      res.status(isOllama ? 503 : 500).json({
        error: isOllama
          ? "Ollama is not running. Start it with: ollama serve"
          : err.message ?? "AI analysis failed",
      });
    }
  });

  // === AI — Correlation Insights ===
  app.post("/api/ai/correlation-insights", requireAuth, async (req, res) => {
    try {
      if (await isDemoOrg(req)) return res.json(DEMO_CORRELATION_INSIGHTS);
      const credIds = await resolveCredIds(req);
      if (!credIds) return res.status(401).json({ error: "Not authenticated" });
      const result = await runCorrelationInsights(credIds);
      res.json(result);
    } catch (err: any) {
      const isOllama = err?.cause?.code === "ECONNREFUSED" || err?.message?.includes("ECONNREFUSED");
      res.status(isOllama ? 503 : 500).json({
        error: isOllama
          ? "Ollama is not running. Start it with: ollama serve"
          : err.message ?? "AI analysis failed",
      });
    }
  });

  // === AI — Recommendations ===
  app.post("/api/ai/recommendations", requireAuth, async (req, res) => {
    try {
      if (await isDemoOrg(req)) return res.json(DEMO_RECOMMENDATIONS);
      const credIds = await resolveCredIds(req);
      if (!credIds) return res.status(401).json({ error: "Not authenticated" });
      const result = await runRecommendations(credIds, req.body?.rootCauseSummary ?? undefined);
      res.json(result);
    } catch (err: any) {
      const isOllama = err?.cause?.code === "ECONNREFUSED" || err?.message?.includes("ECONNREFUSED");
      res.status(isOllama ? 503 : 500).json({
        error: isOllama
          ? "Ollama is not running. Start it with: ollama serve"
          : err.message ?? "AI analysis failed",
      });
    }
  });

  // === AI — Service Risk Ranking ===
  app.post("/api/ai/service-risk-ranking", requireAuth, async (req, res) => {
    try {
      if (await isDemoOrg(req)) return res.json(DEMO_SERVICE_RISK_RANKING);
      const credIds = await resolveCredIds(req);
      if (!credIds) return res.status(401).json({ error: "Not authenticated" });
      const result = await runServiceRiskRanking(credIds);
      res.json(result);
    } catch (err: any) {
      const isOllama = err?.cause?.code === "ECONNREFUSED" || err?.message?.includes("ECONNREFUSED");
      res.status(isOllama ? 503 : 500).json({
        error: isOllama
          ? "Ollama is not running. Start it with: ollama serve"
          : err.message ?? "AI analysis failed",
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // === Insight Navigator AI — conversational observability chat ===
  // ═══════════════════════════════════════════════════════════════════════════

  // List sessions for current user
  app.get("/api/insight-navigator/sessions", requireAuth, async (req, res) => {
    try {
      const user = req.user as any;
      const orgData = await getUserOrg(user.id);
      if (!orgData) return res.json([]);
      const sessions = await db.select().from(insightNavSessions)
        .where(and(eq(insightNavSessions.userId, user.id), eq(insightNavSessions.orgId, orgData.org.id)))
        .orderBy(desc(insightNavSessions.updatedAt))
        .limit(30);
      return res.json(sessions);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Create new session
  app.post("/api/insight-navigator/sessions", requireAuth, async (req, res) => {
    try {
      const user = req.user as any;
      const orgData = await getUserOrg(user.id);
      if (!orgData) return res.status(400).json({ error: "No organisation" });
      const [session] = await db.insert(insightNavSessions).values({
        userId: user.id,
        orgId: orgData.org.id,
        title: "New Conversation",
      }).returning();
      return res.json(session);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Delete a session (and its messages)
  app.delete("/api/insight-navigator/sessions/:sessionId", requireAuth, async (req, res) => {
    try {
      const user = req.user as any;
      const sessionId = parseInt(req.params.sessionId);
      const [session] = await db.select().from(insightNavSessions)
        .where(and(eq(insightNavSessions.id, sessionId), eq(insightNavSessions.userId, user.id)));
      if (!session) return res.status(404).json({ error: "Session not found" });
      await db.delete(insightNavMessages).where(eq(insightNavMessages.sessionId, sessionId));
      await db.delete(insightNavSessions).where(eq(insightNavSessions.id, sessionId));
      return res.json({ success: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Get messages for a session
  app.get("/api/insight-navigator/sessions/:sessionId/messages", requireAuth, async (req, res) => {
    try {
      const user = req.user as any;
      const sessionId = parseInt(req.params.sessionId);
      const [session] = await db.select().from(insightNavSessions)
        .where(and(eq(insightNavSessions.id, sessionId), eq(insightNavSessions.userId, user.id)));
      if (!session) return res.status(404).json({ error: "Session not found" });
      const messages = await db.select().from(insightNavMessages)
        .where(eq(insightNavMessages.sessionId, sessionId))
        .orderBy(insightNavMessages.createdAt);
      return res.json(messages);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Send a message — SSE streaming response
  app.post("/api/insight-navigator/sessions/:sessionId/messages", requireAuth, async (req, res) => {
    try {
      const user = req.user as any;
      const sessionId = parseInt(req.params.sessionId);
      const { message } = req.body as { message: string };

      if (!message?.trim()) return res.status(400).json({ error: "Message required" });

      // Verify session ownership
      const [session] = await db.select().from(insightNavSessions)
        .where(and(eq(insightNavSessions.id, sessionId), eq(insightNavSessions.userId, user.id)));
      if (!session) return res.status(404).json({ error: "Session not found" });

      // Save user message
      await db.insert(insightNavMessages).values({ sessionId, role: "user", content: message.trim() });

      // Fetch conversation history for context
      const historyRows = await db.select({ role: insightNavMessages.role, content: insightNavMessages.content })
        .from(insightNavMessages)
        .where(and(eq(insightNavMessages.sessionId, sessionId), sql`${insightNavMessages.role} != 'system'`))
        .orderBy(insightNavMessages.createdAt)
        .limit(20);
      // Remove the message we just inserted from history (it's the current user turn)
      const history = historyRows.slice(0, -1);

      const orgData = await getUserOrg(user.id);
      if (!orgData) return res.status(400).json({ error: "No organisation" });

      const isDemo = orgData.org.slug === "perviewsis-demo";

      if (isDemo) {
        await streamDemoInsightChat(sessionId, message.trim(), history, res);
      } else {
        const creds = await db.select({ id: apmCredentials.id })
          .from(apmCredentials)
          .where(and(eq(apmCredentials.organizationId, orgData.org.id), eq(apmCredentials.isActive, true)));
        const credIds = creds.map(c => c.id);
        await streamInsightChat(sessionId, message.trim(), credIds, orgData.org.name, history, res);
      }
    } catch (err: any) {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  // === Automation ===
  app.get("/api/automation/timeline", async (req, res) => { res.json(await storage.getAutomationTimeline()); });

  // === Maturity ===
  app.get("/api/maturity", async (req, res) => { res.json(await storage.getMaturityData()); });

  // === Cost Analysis ===
  app.get("/api/cost-analysis", async (req, res) => { res.json(await storage.getCostAnalysis()); });

  // === Profile ===
  app.get("/api/profile", async (req, res) => {
    const user = req.user as import("@shared/schema").User | undefined;
    if (!user) return res.status(401).json({ message: "Not authenticated" });
    const [membership] = await db.select({ role: organizationMembers.role })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, user.id));
    const { passwordHash: _, ...publicUser } = user;
    res.json({
      ...publicUser,
      id: String(user.id),
      company: "",
      role: membership?.role ?? "Admin",
      timezone: "UTC",
      theme: "dark",
      twoFactorEnabled: false,
      notifications: { emailAlerts: true, incidentAlerts: true, slaBreachAlerts: true, weeklyReport: false },
      sessions: [],
    });
  });

  app.put("/api/profile", async (req, res) => {
    const user = req.user as import("@shared/schema").User | undefined;
    if (!user) return res.status(401).json({ message: "Not authenticated" });
    try {
      const { name } = req.body;
      if (name) {
        const initials = name.split(" ").map((p: string) => p[0]).join("").toUpperCase().slice(0, 2);
        await db.update(users).set({ name, avatarInitials: initials, updatedAt: new Date() }).where(eq(users.id, user.id));
      }
      const [updated] = await db.select().from(users).where(eq(users.id, user.id));
      const { passwordHash: _, ...publicUser } = updated;
      res.json({ ...publicUser, id: String(updated.id), company: "", role: "Admin", timezone: "UTC", theme: "dark", twoFactorEnabled: false, notifications: { emailAlerts: true, incidentAlerts: true, slaBreachAlerts: true, weeklyReport: false }, sessions: [] });
    } catch {
      res.status(500).json({ message: "Failed to update profile" });
    }
  });

  app.delete("/api/profile/sessions/:sessionId", async (_req, res) => {
    res.json({ success: true });
  });


  // === Capacity Risks — org-scoped real data from DB ===
  app.get("/api/capacity-planning/risks", async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: "Not authenticated" });
    try {
      const user = req.user as any;
      const orgData = await getUserOrg(user.id);
      if (!orgData) return res.json([]);
      const creds = await db.select({ id: apmCredentials.id })
        .from(apmCredentials)
        .where(and(eq(apmCredentials.organizationId, orgData.org.id), eq(apmCredentials.isActive, true)));
      if (!creds.length) return res.json([]);
      const credIds = creds.map(c => c.id);
      const risks = await db.select().from(dbCapacityRisks)
        .where(credIds.length === 1
          ? sql`${dbCapacityRisks.appId} IN (SELECT id FROM apm_applications WHERE credential_id = ${credIds[0]})`
          : sql`${dbCapacityRisks.appId} IN (SELECT id FROM apm_applications WHERE credential_id = ANY(ARRAY[${sql.join(credIds.map(id => sql`${id}`), sql`, `)}]::integer[]))`)
        .orderBy(desc(dbCapacityRisks.riskScore));
      return res.json(risks.map(r => ({
        id: r.riskId, riskId: r.riskId, name: r.name, type: r.type, severity: r.severity,
        entityType: r.entityType, entityId: r.entityId, entityName: r.entityName,
        current: r.current, threshold: r.threshold, hoursToSaturation: r.hoursToSaturation,
        confidence: r.confidence, riskScore: r.riskScore,
        affectedApp: r.affectedApp, appId: r.appId, metadata: r.metadata,
        computedAt: r.computedAt,
      })));
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.get("/api/capacity-planning/risks/:riskId", async (req, res) => {
    try {
      const [risk] = await db.select().from(dbCapacityRisks).where(eq(dbCapacityRisks.riskId, req.params.riskId));
      if (!risk) return res.status(404).json({ message: "Risk not found" });
      return res.json({
        id: risk.riskId, riskId: risk.riskId, name: risk.name, type: risk.type, severity: risk.severity,
        entityType: risk.entityType, entityId: risk.entityId, entityName: risk.entityName,
        current: risk.current, threshold: risk.threshold, hoursToSaturation: risk.hoursToSaturation,
        confidence: risk.confidence, riskScore: risk.riskScore, affectedApp: risk.affectedApp,
        appId: risk.appId, metadata: risk.metadata, computedAt: risk.computedAt,
        trend: (risk.metadata as any)?.trend ?? [],
        recommendations: (risk.metadata as any)?.recommendations ?? [],
      });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.get("/api/capacity-planning/risks/:riskId/related-incidents", async (req, res) => {
    try {
      const [risk] = await db.select({ affectedApp: dbCapacityRisks.affectedApp }).from(dbCapacityRisks).where(eq(dbCapacityRisks.riskId, req.params.riskId));
      if (!risk) return res.json([]);
      const incs = await db.select().from(dbIncidents)
        .where(sql`${dbIncidents.applicationId} IN (SELECT external_id FROM apm_applications WHERE name = ${risk.affectedApp})`)
        .limit(5);
      return res.json(incs.map(i => ({ id: i.externalId, title: i.title, severity: i.severity, status: i.status, startTime: i.startTime?.getTime() })));
    } catch { return res.json([]); }
  });
  app.get("/api/capacity-planning/risks/:riskId/related-alerts", async (req, res) => {
    try {
      const [risk] = await db.select({ affectedApp: dbCapacityRisks.affectedApp }).from(dbCapacityRisks).where(eq(dbCapacityRisks.riskId, req.params.riskId));
      if (!risk) return res.json([]);
      const rows = await db.select().from(dbAlerts)
        .where(sql`${dbAlerts.applicationId} IN (SELECT external_id FROM apm_applications WHERE name = ${risk.affectedApp})`)
        .limit(5);
      return res.json(rows.map(a => ({ alertId: `ALT-${a.id}`, entity: a.name, severity: a.severity, status: a.status, timestamp: a.triggeredAt?.getTime() })));
    } catch { return res.json([]); }
  });
  app.get("/api/capacity-planning/risks/:riskId/related-errors", async (req, res) => {
    try {
      const [risk] = await db.select({ affectedApp: dbCapacityRisks.affectedApp }).from(dbCapacityRisks).where(eq(dbCapacityRisks.riskId, req.params.riskId));
      if (!risk) return res.json([]);
      const rows = await db.select().from(dbErrors)
        .where(eq(dbErrors.applicationName, risk.affectedApp ?? ""))
        .limit(5);
      return res.json(rows.map(e => ({ errorId: `ERR-${e.id}`, type: e.errorType, message: e.message, severity: e.severity, count: e.frequency })));
    } catch { return res.json([]); }
  });
  app.get("/api/capacity-planning/risks/:riskId/related-transactions", async (req, res) => {
    try {
      const [risk] = await db.select({ affectedApp: dbCapacityRisks.affectedApp }).from(dbCapacityRisks).where(eq(dbCapacityRisks.riskId, req.params.riskId));
      if (!risk) return res.json([]);
      const rows = await db.select().from(dbTransactions)
        .where(sql`${dbTransactions.applicationId} IN (SELECT external_id FROM apm_applications WHERE name = ${risk.affectedApp})`)
        .limit(5);
      return res.json(rows.map(t => ({ name: t.name, avgResponseTime: t.avgResponseTime, errorRate: t.errorRate, callsPerMinute: t.callsPerMinute })));
    } catch { return res.json([]); }
  });
  app.get("/api/capacity-planning/risks/:riskId/related-services-nodes", async (req, res) => {
    try {
      const [risk] = await db.select({ affectedApp: dbCapacityRisks.affectedApp }).from(dbCapacityRisks).where(eq(dbCapacityRisks.riskId, req.params.riskId));
      if (!risk) return res.json({ services: [], nodes: [] });
      const nodes = await db.select().from(dbServers)
        .where(sql`${dbServers.applicationId} IN (SELECT external_id FROM apm_applications WHERE name = ${risk.affectedApp})`)
        .limit(5);
      return res.json({ services: [risk.affectedApp], nodes: nodes.map(n => ({ name: n.name, status: n.status, cpuUsage: n.cpuUsage, memoryUsage: n.memoryUsage })) });
    } catch { return res.json({ services: [], nodes: [] }); }
  });
  app.get("/api/capacity-planning/entity-risks", async (req, res) => {
    const { type, id } = req.query as { type: string; id: string };
    if (!type || !id) return res.json([]);
    try {
      const risks = await db.select().from(dbCapacityRisks)
        .where(and(eq(dbCapacityRisks.entityType, type), eq(dbCapacityRisks.entityId, id)))
        .orderBy(desc(dbCapacityRisks.riskScore));
      return res.json(risks.map(r => ({ id: r.riskId, riskId: r.riskId, name: r.name, type: r.type, severity: r.severity, riskScore: r.riskScore, current: r.current, threshold: r.threshold, hoursToSaturation: r.hoursToSaturation })));
    } catch { return res.json([]); }
  });

  function buildCapacitySeries(base: number, hours: number, volatility = 6, slope = 0) {
    const now = Date.now();
    const pts = Math.max(12, Math.min(72, hours));
    const arr = Array.from({ length: pts }).map((_, i) => {
      const wave = Math.sin(i / 3) * volatility;
      const drift = i * slope;
      const v = clamp(base + wave + drift, 0, 100);
      return { ts: now - (pts - 1 - i) * 60 * 60 * 1000, value: Number(v.toFixed(2)) };
    });
    return arr;
  }

  function buildCapacityForecast(base: number, threshold: number, hours = 48, slope = 0.15) {
    const now = Date.now();
    return Array.from({ length: hours }).map((_, i) => {
      const growth = i * slope;
      const wave = Math.sin(i / 4) * 2;
      const predicted = clamp(base + growth + wave, 0, 100);
      const spread = Math.max(2, Math.abs(growth) * 0.6);
      return {
        ts: now + (i + 1) * 60 * 60 * 1000,
        predicted: Number(predicted.toFixed(2)),
        upper: Number(clamp(predicted + spread, 0, 100).toFixed(2)),
        lower: Number(clamp(predicted - spread, 0, 100).toFixed(2)),
      };
    });
  }

  async function getOrgCapacityScope(req: any, appDbId?: number | null) {
    const user = req.user as import("@shared/schema").User | undefined;
    if (!user) return { apps: [], servers: [], risks: [], incidents: [], errors: [] as any[] };
    const orgData = await getUserOrg(user.id);
    if (!orgData) return { apps: [], servers: [], risks: [], incidents: [], errors: [] as any[] };

    const creds = await db.select({ id: apmCredentials.id, source: apmCredentials.source })
      .from(apmCredentials)
      .where(and(eq(apmCredentials.organizationId, orgData.org.id), eq(apmCredentials.isActive, true)));
    if (!creds.length) return { apps: [], servers: [], risks: [], incidents: [], errors: [] as any[] };

    const credIds = creds.map(c => c.id);
    const apps = await db.select().from(dbApplications)
      .where(credIds.length === 1
        ? eq(dbApplications.credentialId, credIds[0])
        : sql`${dbApplications.credentialId} = ANY(ARRAY[${sql.join(credIds.map(id => sql`${id}`), sql`, `)}]::integer[])`);

    if (!apps.length) return { apps: [], servers: [], risks: [], incidents: [], errors: [] as any[] };

    const scopedApps = appDbId
      ? apps.filter(a => a.id === appDbId)
      : apps;
    if (!scopedApps.length) return { apps: [], servers: [], risks: [], incidents: [], errors: [] as any[] };

    const appDbIds = scopedApps.map(a => a.id);
    const appExternalIds = scopedApps.map(a => a.externalId);

    const servers = await db.select().from(dbServers)
      .where(inArray(dbServers.applicationId, appExternalIds));
    const incidents = await db.select().from(dbIncidents)
      .where(inArray(dbIncidents.applicationId, appExternalIds))
      .orderBy(desc(dbIncidents.startTime))
      .limit(100);
    const errors = await db.select().from(dbErrors)
      .where(inArray(dbErrors.applicationId, appExternalIds))
      .orderBy(desc(dbErrors.lastOccurrence))
      .limit(150);
    const risks = await db.select().from(dbCapacityRisks)
      .where(inArray(dbCapacityRisks.appId, appDbIds))
      .orderBy(desc(dbCapacityRisks.riskScore))
      .limit(150);

    return { apps: scopedApps, servers, risks, incidents, errors };
  }

  // === Capacity Planning ===
  app.get("/api/capacity-planning/global", async (req, res) => {
    try {
      const appIdParam = req.query.appId != null ? Number(req.query.appId) : null;
      const selectedAppId = Number.isFinite(appIdParam) ? appIdParam : null;
      const { apps, servers, risks, incidents, errors } = await getOrgCapacityScope(req, selectedAppId);

      const avgCpu = servers.length ? servers.reduce((s, n) => s + Number(n.cpuUsage ?? 0), 0) / servers.length : (apps.reduce((s, a) => s + Number(a.errorRate ?? 0), 0) / Math.max(1, apps.length)) * 8;
      const avgMemory = servers.length ? servers.reduce((s, n) => s + Number(n.memoryUsage ?? 0), 0) / servers.length : 58;
      const avgDisk = servers.length ? servers.reduce((s, n) => s + Number(n.diskUsage ?? 0), 0) / servers.length : 42;
      const totalNodes = Math.max(servers.length, apps.length);
      const criticalNodes = servers.filter(s => (s.cpuUsage ?? 0) >= 85 || (s.memoryUsage ?? 0) >= 90 || s.status === "Critical").length;
      const warningNodes = servers.filter(s => (s.cpuUsage ?? 0) >= 70 || (s.memoryUsage ?? 0) >= 75 || s.status === "Warning").length;
      const headroomCpu = Math.round(clamp(100 - avgCpu, 0, 100));
      const headroomMemory = Math.round(clamp(100 - avgMemory, 0, 100));
      const overallRiskScore = Math.round(clamp(
        (100 - headroomCpu) * 0.4 + (100 - headroomMemory) * 0.35 + (criticalNodes / Math.max(1, totalNodes)) * 25,
        0,
        100
      ));

      const cpuHistorical = buildCapacitySeries(avgCpu, 24, 7, 0.02);
      const memoryHistorical = buildCapacitySeries(avgMemory, 24, 6, 0.02);
      const diskHistorical = buildCapacitySeries(avgDisk, 24, 4, 0.01);
      const networkBase = clamp((apps.reduce((s, a) => s + Number(a.callsPerMinute ?? 0), 0) / Math.max(1, apps.length)) / 10, 15, 85);
      const networkHistorical = buildCapacitySeries(networkBase, 24, 5, 0.02);
      const reqBase = clamp((apps.reduce((s, a) => s + Number(a.callsPerMinute ?? 0), 0) / Math.max(1, apps.length)) / 12, 10, 95);
      const reqHistorical = buildCapacitySeries(reqBase, 24, 6, 0.03);

      const cpuForecast = buildCapacityForecast(avgCpu, 85, 48, 0.18);
      const memoryForecast = buildCapacityForecast(avgMemory, 85, 48, 0.14);
      const diskForecast = buildCapacityForecast(avgDisk, 80, 48, 0.08);
      const networkForecast = buildCapacityForecast(networkBase, 80, 48, 0.1);
      const reqForecast = buildCapacityForecast(reqBase, 90, 48, 0.12);

      const allRisks = risks.length > 0
        ? risks.map((r, i) => ({
            id: r.riskId,
            riskId: r.riskId,
            entity: r.entityName,
            type: String(r.entityType ?? "node"),
            metric: r.type,
            current: Number(r.current ?? 0),
            threshold: Number(r.threshold ?? 85),
            hoursToSaturation: r.hoursToSaturation != null ? Math.round(Number(r.hoursToSaturation)) : null,
            riskScore: Number(r.riskScore ?? 0),
            href: r.appId ? `/applications/${r.appId}/capacity` : "/capacity-planning",
            detailHref: `/capacity-planning/detail/${r.riskId}`,
            confidence: Number(r.confidence ?? 0.75),
          }))
        : [
            ...servers.slice(0, 10).map((s, i) => {
              const cpu = Number(s.cpuUsage ?? 0);
              const mem = Number(s.memoryUsage ?? 0);
              const metric = cpu >= mem ? "CPU" : "Memory";
              const current = Math.max(cpu, mem);
              const threshold = metric === "CPU" ? 85 : 90;
              const gap = Math.max(1, threshold - current);
              const hoursToSat = current >= threshold ? 1 : Math.round(gap / 1.5);
              const score = Math.round(clamp(current + (100 - gap) * 0.12, 20, 99));
              const app = apps.find(a => a.externalId === s.applicationId);
              return {
                id: `SYN-RISK-N-${i + 1}`,
                riskId: `SYN-RISK-N-${i + 1}`,
                entity: s.name,
                type: "node",
                metric,
                current: Number(current.toFixed(1)),
                threshold,
                hoursToSaturation: hoursToSat,
                riskScore: score,
                href: app ? `/applications/${app.id}/capacity` : "/capacity-planning",
                detailHref: null,
                confidence: 0.72,
              };
            }),
            ...apps.slice(0, 6).map((a, i) => {
              const current = Number(a.errorRate ?? 0) * 10 + Number(a.avgResponseTime ?? 0) / 120;
              const threshold = 70;
              const score = Math.round(clamp(current + 35, 25, 96));
              return {
                id: `SYN-RISK-A-${i + 1}`,
                riskId: `SYN-RISK-A-${i + 1}`,
                entity: a.name,
                type: "application",
                metric: "Load",
                current: Number(clamp(current, 0, 100).toFixed(1)),
                threshold,
                hoursToSaturation: Math.max(2, Math.round((100 - score) / 2)),
                riskScore: score,
                href: `/applications/${a.id}/capacity`,
                detailHref: null,
                confidence: 0.68,
              };
            }),
          ];

      const topRisks = allRisks.sort((a, b) => b.riskScore - a.riskScore).slice(0, 8);
      const saturationTimeline = topRisks
        .filter(r => r.hoursToSaturation != null)
        .slice(0, 6)
        .map(r => ({
          entity: r.entity,
          metric: r.metric,
          predictedAt: Date.now() + Number(r.hoursToSaturation) * 60 * 60 * 1000,
          confidence: r.confidence ?? 0.75,
        }));

      const clusters = Array.from(new Map(
        apps.map(a => [a.source, a])
      ).keys()).map((source, idx) => {
        const sourceApps = apps.filter(a => a.source === source);
        const sourceExternalIds = new Set(sourceApps.map(a => a.externalId));
        const sourceServers = servers.filter(s => sourceExternalIds.has(String(s.applicationId ?? "")));
        const scpu = sourceServers.length ? sourceServers.reduce((s, n) => s + Number(n.cpuUsage ?? 0), 0) / sourceServers.length : avgCpu;
        const smem = sourceServers.length ? sourceServers.reduce((s, n) => s + Number(n.memoryUsage ?? 0), 0) / sourceServers.length : avgMemory;
        const riskScore = Math.round(clamp(scpu * 0.55 + smem * 0.45, 10, 99));
        return {
          clusterId: `cluster-${String(source).toLowerCase()}`,
          name: String(source).toUpperCase(),
          riskScore,
          nodes: Math.max(1, sourceServers.length),
          cpuUsed: Math.round(scpu),
          memUsed: Math.round(smem),
          pendingPods: sourceServers.filter(s => (s.cpuUsage ?? 0) >= 92 || (s.memoryUsage ?? 0) >= 92).length,
        };
      });

      const currentCost = Math.round(totalNodes * 140 + apps.length * 80 + (avgCpu + avgMemory) * 6);
      const predictions = topRisks.slice(0, 4).map((r, idx) => ({
        id: `P-${idx + 1}`,
        entity: r.entity,
        metric: r.metric,
        severity: r.riskScore >= 85 ? "Critical" : r.riskScore >= 65 ? "High" : "Medium",
        message: `${r.metric} utilization is trending toward threshold in ${r.hoursToSaturation ?? 24}h.`,
        action: r.metric === "CPU" ? "Scale out affected nodes/services" : "Increase memory limits and optimize GC/leaks",
        confidence: r.confidence ?? 0.75,
        costImpact: r.riskScore >= 85 ? "$$$" : "$$",
        timeToAction: r.hoursToSaturation != null && r.hoursToSaturation <= 6 ? "Now" : "Today",
      }));

      return res.json({
        summary: {
          totalNodes,
          criticalNodes,
          warningNodes,
          headroomCpu,
          headroomMemory,
          overallRiskScore,
          avgCpuUtilization: Math.round(avgCpu),
          avgMemoryUtilization: Math.round(avgMemory),
          avgDiskUtilization: Math.round(avgDisk),
        },
        forecasts: {
          "24h": { cpuMax: Math.round(Math.max(...cpuForecast.slice(0, 24).map(p => p.predicted))), memoryMax: Math.round(Math.max(...memoryForecast.slice(0, 24).map(p => p.predicted))), diskMax: Math.round(Math.max(...diskForecast.slice(0, 24).map(p => p.predicted))), networkMax: Math.round(Math.max(...networkForecast.slice(0, 24).map(p => p.predicted))), saturationEvents: saturationTimeline.filter(s => s.predictedAt <= Date.now() + 24 * 3600000).length },
          "72h": { cpuMax: Math.round(Math.max(...cpuForecast.map(p => p.predicted))), memoryMax: Math.round(Math.max(...memoryForecast.map(p => p.predicted))), diskMax: Math.round(Math.max(...diskForecast.map(p => p.predicted))), networkMax: Math.round(Math.max(...networkForecast.map(p => p.predicted))), saturationEvents: saturationTimeline.length },
          "1w": { cpuMax: Math.round(clamp(Math.max(...cpuForecast.map(p => p.predicted)) + 4, 0, 100)), memoryMax: Math.round(clamp(Math.max(...memoryForecast.map(p => p.predicted)) + 3, 0, 100)), diskMax: Math.round(clamp(Math.max(...diskForecast.map(p => p.predicted)) + 2, 0, 100)), networkMax: Math.round(clamp(Math.max(...networkForecast.map(p => p.predicted)) + 2, 0, 100)), saturationEvents: saturationTimeline.length + 1 },
          "3m": { cpuMax: Math.round(clamp(Math.max(...cpuForecast.map(p => p.predicted)) + 8, 0, 100)), memoryMax: Math.round(clamp(Math.max(...memoryForecast.map(p => p.predicted)) + 7, 0, 100)), diskMax: Math.round(clamp(Math.max(...diskForecast.map(p => p.predicted)) + 6, 0, 100)), networkMax: Math.round(clamp(Math.max(...networkForecast.map(p => p.predicted)) + 5, 0, 100)), saturationEvents: saturationTimeline.length + 3 },
        },
        metrics: {
          cpu: { historical: cpuHistorical, forecast: cpuForecast, threshold: 85 },
          memory: { historical: memoryHistorical, forecast: memoryForecast, threshold: 85 },
          disk: { historical: diskHistorical, forecast: diskForecast, threshold: 80 },
          network: { historical: networkHistorical, forecast: networkForecast, threshold: 80 },
          requests: { historical: reqHistorical, forecast: reqForecast, threshold: 90 },
        },
        topRisks,
        saturationTimeline,
        clusters: clusters.length ? clusters : [{ clusterId: "cluster-default", name: "DEFAULT", riskScore: overallRiskScore, nodes: Math.max(1, totalNodes), cpuUsed: Math.round(avgCpu), memUsed: Math.round(avgMemory), pendingPods: criticalNodes }],
        aiInsights: {
          costForecast: {
            current: currentCost,
            projected30d: Math.round(currentCost * 1.12),
            projected90d: Math.round(currentCost * 1.28),
            optimized: Math.round(currentCost * 0.86),
          },
          predictions,
          scalingStrategy: `Prioritize workloads above 85% utilization, rebalance memory-heavy services, and scale high-risk nodes before ${predictions[0]?.timeToAction ?? "this week"}.`,
        },
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/capacity-planning/applications/:appId", async (req, res) => {
    try {
      const appId = Number(req.params.appId);
      if (!Number.isFinite(appId)) return res.status(400).json({ error: "Invalid app id" });
      const [app] = await db.select().from(dbApplications).where(eq(dbApplications.id, appId));
      if (!app) return res.json(await storage.getCapacityPlanningApp(appId));

      const servers = await db.select().from(dbServers).where(eq(dbServers.applicationId, app.externalId)).limit(60);
      const txs = await db.select().from(dbTransactions)
        .where(eq(dbTransactions.applicationId, app.externalId))
        .orderBy(desc(dbTransactions.callsPerMinute))
        .limit(10);
      const incidents = await db.select().from(dbIncidents)
        .where(eq(dbIncidents.applicationId, app.externalId))
        .orderBy(desc(dbIncidents.startTime))
        .limit(5);

      const avgCpu = servers.length ? servers.reduce((s, n) => s + Number(n.cpuUsage ?? 0), 0) / servers.length : 52;
      const avgMemory = servers.length ? servers.reduce((s, n) => s + Number(n.memoryUsage ?? 0), 0) / servers.length : 61;
      const calls = Number(app.callsPerMinute ?? txs.reduce((s, t) => s + Number(t.callsPerMinute ?? 0), 0) ?? 0);
      const errorRate = Number(app.errorRate ?? 0);
      const p99 = Math.round(Number(app.avgResponseTime ?? 240) * 1.8);
      const slaScore = Math.round(clamp(100 - errorRate * 6 - (p99 > 2000 ? 15 : 0) - (avgCpu > 85 ? 12 : 0), 45, 99));
      const riskScore = Math.round(clamp(avgCpu * 0.38 + avgMemory * 0.3 + errorRate * 5 + (p99 / 120), 10, 99));

      const cpuThreshold = 85;
      const memThreshold = 90;
      const cpuGap = Math.max(1, cpuThreshold - avgCpu);
      const memGap = Math.max(1, memThreshold - avgMemory);

      const services = (txs.length ? txs : [{ name: app.name, callsPerMinute: calls, errorRate, avgResponseTime: app.avgResponseTime }]).map((t, i) => {
        const req = Math.round(Number(t.callsPerMinute ?? 0));
        const svcCpu = Math.round(clamp(avgCpu * (0.7 + i * 0.04), 10, 99));
        const svcMem = Math.round(clamp(avgMemory * (0.75 + i * 0.03), 10, 99));
        const svcRisk = Math.round(clamp(svcCpu * 0.5 + svcMem * 0.4 + Number(t.errorRate ?? errorRate) * 2, 10, 99));
        return {
          name: String(t.name ?? `service-${i + 1}`),
          cpu: svcCpu,
          memory: svcMem,
          requests: req,
          riskScore: svcRisk,
          saturationIn: svcRisk >= 85 ? `${Math.max(1, Math.round((100 - svcRisk) / 2))}h` : null,
        };
      }).slice(0, 8);

      return res.json({
        appName: app.name,
        riskScore,
        current: {
          cpu: Math.round(avgCpu),
          memory: Math.round(avgMemory),
          requests: Math.round(calls),
          errorRate: Number(errorRate.toFixed(2)),
          p99,
          slaScore,
        },
        headroom: {
          cpu: Math.round(clamp(100 - avgCpu, 0, 100)),
          memory: Math.round(clamp(100 - avgMemory, 0, 100)),
        },
        hoursToSaturation: {
          cpu: avgCpu >= cpuThreshold ? 1 : Math.round(cpuGap / 1.4),
          memory: avgMemory >= memThreshold ? 1 : Math.round(memGap / 1.2),
        },
        forecasts: {
          cpu: { historical: buildCapacitySeries(avgCpu, 24, 8, 0.05), forecast: buildCapacityForecast(avgCpu, cpuThreshold, 48, 0.18), threshold: cpuThreshold },
          memory: { historical: buildCapacitySeries(avgMemory, 24, 7, 0.04), forecast: buildCapacityForecast(avgMemory, memThreshold, 48, 0.14), threshold: memThreshold },
          requests: { historical: buildCapacitySeries(clamp(calls / 12, 5, 95), 24, 6, 0.07), forecast: buildCapacityForecast(clamp(calls / 12, 5, 95), 90, 48, 0.16), threshold: 90 },
          errorRate: { historical: buildCapacitySeries(clamp(errorRate * 10, 0, 100), 24, 5, 0.03), forecast: buildCapacityForecast(clamp(errorRate * 10, 0, 100), 60, 48, 0.08), threshold: 60 },
        },
        services,
        trafficGrowth: {
          current: Math.round(calls / 60),
          projected30d: Math.round((calls / 60) * 1.15),
          projected90d: Math.round((calls / 60) * 1.32),
          growthRate: 11,
          peakHour: "11:00-13:00 UTC",
        },
        recommendations: [
          { id: "AR-1", action: "Scale top CPU-bound service by +1 replica", priority: riskScore >= 80 ? "Critical" : "High", confidence: 0.84, costImpact: "$$", estimatedTimeToScale: "5-10m" },
          { id: "AR-2", action: "Tune JVM/memory limits to reduce pressure", priority: avgMemory >= 80 ? "High" : "Medium", confidence: 0.78, costImpact: "$", estimatedTimeToScale: "15-30m" },
          { id: "AR-3", action: "Optimize high-latency transactions", priority: "Medium", confidence: 0.72, costImpact: "$", estimatedTimeToScale: "—" },
        ],
        incidentCorrelation: incidents.map((inc) => ({
          id: inc.externalId,
          title: inc.title,
          href: `/incidents/${inc.externalId}`,
          capacityFactor: avgCpu >= 80 || avgMemory >= 80 ? "High infrastructure pressure" : "Moderate load impact",
        })),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/capacity-planning/cluster/:clusterId", async (req, res) => {
    try {
      const clusterId = String(req.params.clusterId ?? "k8s-prod");
      const { apps, servers, errors } = await getOrgCapacityScope(req);
      const sourceKey = clusterId.replace("cluster-", "").toLowerCase();
      const scopeApps = sourceKey && sourceKey !== "k8s-prod"
        ? apps.filter(a => String(a.source).toLowerCase() === sourceKey)
        : apps;
      const scopeExternalIds = new Set(scopeApps.map(a => a.externalId));
      const scopeServers = servers.filter(s => scopeExternalIds.size === 0 || scopeExternalIds.has(String(s.applicationId ?? "")));
      const nodes = Math.max(1, scopeServers.length);
      const cpuUsed = scopeServers.length ? scopeServers.reduce((s, n) => s + Number(n.cpuUsage ?? 0), 0) / scopeServers.length : 54;
      const memUsed = scopeServers.length ? scopeServers.reduce((s, n) => s + Number(n.memoryUsage ?? 0), 0) / scopeServers.length : 59;
      const storageUsed = scopeServers.length ? scopeServers.reduce((s, n) => s + Number(n.diskUsage ?? 0), 0) / scopeServers.length : 48;
      const pendingPods = scopeServers.filter(s => (s.cpuUsage ?? 0) >= 92 || (s.memoryUsage ?? 0) >= 92).length;

      const cpuAlloc = Math.round(nodes * 8);
      const memAlloc = Math.round(nodes * 32);
      const pods = Math.max(4, nodes * 8 + pendingPods);
      const maxPods = Math.max(pods + 4, nodes * 20);

      const relatedErrors = errors.filter(e => scopeExternalIds.size === 0 || scopeExternalIds.has(String(e.applicationId ?? ""))).slice(0, 6);

      return res.json({
        clusterName: sourceKey && sourceKey !== "k8s-prod" ? `${sourceKey.toUpperCase()} Cluster` : "k8s-prod",
        environment: "Production",
        version: "1.29",
        region: "ap-south-1",
        daysToNewNode: cpuUsed >= 85 || memUsed >= 85 ? Math.max(1, Math.round((100 - Math.max(cpuUsed, memUsed)) / 2.5)) : null,
        current: {
          nodes,
          pods,
          pendingPods,
          cpuUsed: Math.round(cpuUsed),
          cpuAllocatable: cpuAlloc,
          memUsed: Math.round(memUsed),
          memAllocatable: memAlloc,
          storageUsedGb: Math.round((storageUsed / 100) * nodes * 400),
          storageGb: nodes * 400,
        },
        nodePools: [
          {
            name: "general-pool",
            status: Math.max(cpuUsed, memUsed) >= 85 ? "Critical" : Math.max(cpuUsed, memUsed) >= 70 ? "Warning" : "Healthy",
            nodes,
            pods,
            maxPods,
            cpuUsed: Math.round((cpuUsed / 100) * cpuAlloc),
            cpuAllocatable: cpuAlloc,
            memUsed: Math.round((memUsed / 100) * memAlloc),
            memAllocatable: memAlloc,
          },
        ],
        forecasts: {
          cpu: { historical: buildCapacitySeries(cpuUsed, 24, 7, 0.06), forecast: buildCapacityForecast(cpuUsed, 85, 36, 0.2), threshold: 85 },
          memory: { historical: buildCapacitySeries(memUsed, 24, 6, 0.05), forecast: buildCapacityForecast(memUsed, 90, 36, 0.16), threshold: 90 },
        },
        autoscalerEvents: [
          { ts: Date.now() - 3 * 3600000, type: "ScaleOut", detail: `Scaled general-pool from ${Math.max(1, nodes - 1)} to ${nodes} nodes`, status: "Completed" },
          ...(pendingPods > 0 ? [{ ts: Date.now() - 3600000, type: "ScaleOut", detail: `${pendingPods} pending pods detected`, status: "In Progress" }] : []),
        ],
        throttlingEvents: relatedErrors.map((e, i) => ({
          ts: e.lastOccurrence?.getTime?.() ?? (Date.now() - i * 3600000),
          service: e.service ?? e.applicationName ?? `service-${i + 1}`,
          reason: e.message ?? e.errorType ?? "High utilization",
          impact: `${e.frequency ?? 1} errors observed`,
          duration: "15m",
        })),
        recommendations: [
          { id: "CR-1", action: "Increase node pool min replicas by +1", priority: pendingPods > 0 ? "Critical" : "High", confidence: 0.86, costImpact: "$$" },
          { id: "CR-2", action: "Right-size memory requests/limits for top services", priority: memUsed >= 80 ? "High" : "Medium", confidence: 0.79, costImpact: "$" },
          { id: "CR-3", action: "Enable proactive autoscaler thresholds at 75%", priority: "Medium", confidence: 0.74, costImpact: "$" },
        ],
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });
  // === Correlation Graph — build from real DB entities ===
  app.get("/api/correlation/graph", async (req, res) => {
    const entityId = String(req.query.entityId ?? "");
    const type = String(req.query.type ?? "");
    if (!entityId || entityId === "undefined") return res.json({ nodes: [], edges: [] });
    try {
      const nodes: any[] = [];
      const edges: any[] = [];
      if (type === "incident" || entityId.startsWith("INC-") || entityId.startsWith("demo-inc-")) {
        const exId = entityId;
        const [inc] = await db.select().from(dbIncidents).where(eq(dbIncidents.externalId, exId));
        if (inc) {
          nodes.push({ id: exId, type: "incident", label: inc.title.substring(0, 40), severity: inc.severity });
          const relErrors = await db.select().from(dbErrors).where(eq(dbErrors.applicationId, inc.applicationId)).limit(4);
          const relAlerts = await db.select().from(dbAlerts).where(eq(dbAlerts.applicationId, inc.applicationId)).limit(4);
          const relServers = await db.select().from(dbServers).where(eq(dbServers.applicationId, inc.applicationId)).limit(3);
          relErrors.forEach(e => { nodes.push({ id: `ERR-${e.id}`, type: "error", label: e.errorType ?? "Error", severity: e.severity }); edges.push({ source: exId, target: `ERR-${e.id}`, relation: "caused" }); });
          relAlerts.forEach(a => { nodes.push({ id: `ALT-${a.id}`, type: "alert", label: a.name.substring(0, 40), severity: a.severity }); edges.push({ source: exId, target: `ALT-${a.id}`, relation: "triggered" }); });
          relServers.forEach(s => { nodes.push({ id: s.externalId, type: "node", label: s.name, severity: s.status === "Healthy" ? "Low" : "Warning" }); edges.push({ source: exId, target: s.externalId, relation: "affects" }); });
        }
      } else if (type === "error" || entityId.startsWith("ERR-")) {
        const numId = parseInt(entityId.replace("ERR-", ""));
        if (!isNaN(numId)) {
          const [err] = await db.select().from(dbErrors).where(eq(dbErrors.id, numId));
          if (err) {
            nodes.push({ id: entityId, type: "error", label: err.errorType ?? "Error", severity: err.severity });
            const relInc = await db.select().from(dbIncidents).where(eq(dbIncidents.applicationId, err.applicationId ?? "")).limit(3);
            const relAlerts = await db.select().from(dbAlerts).where(eq(dbAlerts.applicationId, err.applicationId ?? "")).limit(3);
            relInc.forEach(i => { nodes.push({ id: i.externalId, type: "incident", label: i.title.substring(0, 40), severity: i.severity }); edges.push({ source: entityId, target: i.externalId, relation: "part-of" }); });
            relAlerts.forEach(a => { nodes.push({ id: `ALT-${a.id}`, type: "alert", label: a.name.substring(0, 40), severity: a.severity }); edges.push({ source: entityId, target: `ALT-${a.id}`, relation: "related" }); });
          }
        }
      }
      return res.json({ nodes, edges });
    } catch { return res.json({ nodes: [], edges: [] }); }
  });
  // === Related entity lookups — real DB data ===
  app.get("/api/incidents/:incidentId/related", async (req, res) => {
    const { incidentId } = req.params;
    try {
      const [inc] = await db.select().from(dbIncidents).where(eq(dbIncidents.externalId, incidentId));
      if (!inc) return res.json({ alerts: [], errors: [], nodes: [] });
      const alerts = await db.select().from(dbAlerts).where(eq(dbAlerts.applicationId, inc.applicationId)).limit(5);
      const errors = await db.select().from(dbErrors).where(eq(dbErrors.applicationId, inc.applicationId)).limit(5);
      const nodes = await db.select().from(dbServers).where(eq(dbServers.applicationId, inc.applicationId)).limit(5);
      return res.json({
        alerts: alerts.map(a => ({ alertId: `ALT-${a.id}`, entity: a.name, severity: a.severity, status: a.status, timestamp: a.triggeredAt?.getTime() })),
        errors: errors.map(e => ({ errorId: `ERR-${e.id}`, type: e.errorType, message: e.message?.substring(0, 80), severity: e.severity })),
        nodes: nodes.map(n => ({ name: n.name, status: n.status, cpuUsage: n.cpuUsage, memoryUsage: n.memoryUsage })),
      });
    } catch { return res.json({ alerts: [], errors: [], nodes: [] }); }
  });
  app.get("/api/errors/:errorId/related", async (req, res) => {
    const numId = parseInt(req.params.errorId.replace("ERR-", ""));
    try {
      if (isNaN(numId)) return res.json({ incidents: [], alerts: [], nodes: [] });
      const [err] = await db.select().from(dbErrors).where(eq(dbErrors.id, numId));
      if (!err) return res.json({ incidents: [], alerts: [], nodes: [] });
      const incidents = await db.select().from(dbIncidents).where(eq(dbIncidents.applicationId, err.applicationId ?? "")).limit(5);
      const alerts = await db.select().from(dbAlerts).where(eq(dbAlerts.applicationId, err.applicationId ?? "")).limit(5);
      const nodes = await db.select().from(dbServers).where(eq(dbServers.applicationId, err.applicationId ?? "")).limit(5);
      return res.json({
        incidents: incidents.map(i => ({ id: i.externalId, title: i.title, severity: i.severity, status: i.status })),
        alerts: alerts.map(a => ({ alertId: `ALT-${a.id}`, entity: a.name, severity: a.severity, status: a.status })),
        nodes: nodes.map(n => ({ name: n.name, status: n.status, cpuUsage: n.cpuUsage, memoryUsage: n.memoryUsage })),
      });
    } catch { return res.json({ incidents: [], alerts: [], nodes: [] }); }
  });
  app.get("/api/nodes/:nodeId/related", async (req, res) => {
    const { nodeId } = req.params;
    try {
      const [server] = await db.select().from(dbServers).where(eq(dbServers.externalId, nodeId));
      if (!server) return res.json({ incidents: [], alerts: [], errors: [] });
      const incidents = await db.select().from(dbIncidents).where(eq(dbIncidents.applicationId, server.applicationId ?? "")).limit(5);
      const alerts = await db.select().from(dbAlerts).where(eq(dbAlerts.applicationId, server.applicationId ?? "")).limit(5);
      const errors = await db.select().from(dbErrors).where(eq(dbErrors.applicationId, server.applicationId ?? "")).limit(5);
      return res.json({
        incidents: incidents.map(i => ({ id: i.externalId, title: i.title, severity: i.severity, status: i.status })),
        alerts: alerts.map(a => ({ alertId: `ALT-${a.id}`, entity: a.name, severity: a.severity, status: a.status })),
        errors: errors.map(e => ({ errorId: `ERR-${e.id}`, type: e.errorType, message: e.message?.substring(0, 80), severity: e.severity })),
      });
    } catch { return res.json({ incidents: [], alerts: [], errors: [] }); }
  });
  // === Alerts — org-scoped real data from DB ===
  app.get("/api/alerts", async (req, res) => {
    const user = req.user as import("@shared/schema").User | undefined;
    if (user) {
      const orgData = await getUserOrg(user.id);
      if (orgData) {
        let orgId = orgData.org.id;
        const currentOrgId = Number((req.session as any)?.currentOrgId);
        if (Number.isFinite(currentOrgId) && currentOrgId > 0) {
          const [membership] = await db
            .select({ id: organizationMembers.id })
            .from(organizationMembers)
            .where(and(
              eq(organizationMembers.userId, user.id),
              eq(organizationMembers.organizationId, currentOrgId),
            ))
            .limit(1);
          if (membership) orgId = currentOrgId;
        }
        const orgCreds = await db.select({ id: apmCredentials.id, source: apmCredentials.source })
          .from(apmCredentials)
          .where(and(eq(apmCredentials.organizationId, orgId), eq(apmCredentials.isActive, true)));
        if (orgCreds.length > 0) {
          const credIds = orgCreds.map(c => c.id);
          // Fetch alerts (health rule violations) from DB
          const dbAlertRows = await db.select().from(dbAlerts)
            .where(credIds.length === 1
              ? sql`${dbAlerts.applicationId} IN (SELECT external_id::text FROM apm_applications WHERE credential_id = ${credIds[0]})`
              : sql`${dbAlerts.applicationId} IN (SELECT external_id::text FROM apm_applications WHERE credential_id = ANY(ARRAY[${sql.join(credIds.map(id => sql`${id}`), sql`, `)}]::integer[]))`)
            .orderBy(desc(dbAlerts.triggeredAt))
            .limit(200);
          // Fetch incidents from DB as well (map to alert format)
          const dbIncidentRows = await db.select().from(dbIncidents)
            .where(credIds.length === 1
              ? sql`${dbIncidents.applicationId} IN (SELECT external_id::text FROM apm_applications WHERE credential_id = ${credIds[0]})`
              : sql`${dbIncidents.applicationId} IN (SELECT external_id::text FROM apm_applications WHERE credential_id = ANY(ARRAY[${sql.join(credIds.map(id => sql`${id}`), sql`, `)}]::integer[]))`)
            .orderBy(desc(dbIncidents.startTime))
            .limit(100);
          // Map to unified alert format for the dashboard
          // Build applicationId → name map for this org's apps
          const appRows = await db.select({ externalId: dbApplications.externalId, name: dbApplications.name })
            .from(dbApplications)
            .where(credIds.length === 1
              ? eq(dbApplications.credentialId, credIds[0])
              : sql`${dbApplications.credentialId} = ANY(ARRAY[${sql.join(credIds.map(id => sql`${id}`), sql`, `)}]::integer[])`);
          const appNameMap: Record<string, string> = Object.fromEntries(appRows.map(a => [a.externalId ?? "", a.name]));

          // Count occurrences per rule name across all violation alerts
          const ruleCounts: Record<string, number> = dbAlertRows.reduce((acc: Record<string, number>, a) => {
            acc[a.name] = (acc[a.name] || 0) + 1;
            return acc;
          }, {});

          const normalizeSeverity = (sev?: string | null) => {
            const s = String(sev ?? "").toLowerCase();
            if (s.includes("critical")) return "Critical";
            if (s.includes("high") || s.includes("error")) return "High";
            if (s.includes("warn") || s.includes("medium")) return "Medium";
            return "Low";
          };
          const alertsFromViolations = dbAlertRows.map(a => ({
            alertId: `ALT-${a.id}`,
            source: a.source === "appdynamics" ? "AppDynamics" : "Dynatrace",
            severity: normalizeSeverity(a.severity),
            status: a.status,
            entity: (a.metadata as any)?.affectedEntityName ?? a.name,
            service: (a.metadata as any)?.affectedEntityType ?? "Service",
            rule: a.name,
            description: `Health rule violation: ${a.name}`,
            timestamp: a.triggeredAt?.getTime() ?? Date.now(),
            aiRiskScore: normalizeSeverity(a.severity) === "Critical" ? 85 : normalizeSeverity(a.severity) === "Medium" ? 55 : 25,
            occurrences: ruleCounts[a.name] ?? 1,
            applicationName: appNameMap[a.applicationId ?? ""] ?? "Unknown",
            relatedErrors: [],
            linkedIncident: null,
            tags: [a.source === "appdynamics" ? "AppDynamics" : "Dynatrace", normalizeSeverity(a.severity)],
          }));
          const alertsFromIncidents = dbIncidentRows.map(i => ({
            alertId: `INC-${i.id}`,
            source: i.source === "appdynamics" ? "AppDynamics" : "Dynatrace",
            severity: normalizeSeverity(i.severity),
            status: i.status === "Open" ? "Active" : "Resolved",
            entity: i.title,
            service: i.affectedServices?.[0] ?? "Application",
            rule: `Incident: ${i.title}`,
            description: i.rootCause ?? i.title,
            timestamp: i.startTime?.getTime() ?? Date.now(),
            aiRiskScore: normalizeSeverity(i.severity) === "Critical" ? 88 : 52,
            occurrences: 1,
            applicationName: appNameMap[i.applicationId ?? ""] ?? "Unknown",
            relatedErrors: [],
            linkedIncident: `INC-${i.id}`,
            tags: [i.source === "appdynamics" ? "AppDynamics" : "Dynatrace", normalizeSeverity(i.severity), "Incident"],
          }));
          const allAlerts = [...alertsFromViolations, ...alertsFromIncidents]
            .sort((a, b) => b.timestamp - a.timestamp);
          return res.json(allAlerts);
        }
      }
    }
    // Fallback: no credentials configured → empty
    return res.json([]);
  });
  app.get("/api/alerts/errors/correlated", async (req, res) => {
    const alertId = String(req.query.alertId ?? "");
    if (!alertId) return res.json([]);
    try {
      if (alertId.startsWith("ALT-")) {
        const numId = Number(alertId.slice(4));
        if (!Number.isFinite(numId)) return res.json([]);
        const [a] = await db.select({ applicationId: dbAlerts.applicationId }).from(dbAlerts).where(eq(dbAlerts.id, numId));
        if (!a?.applicationId) return res.json([]);
        const errs = await db.select().from(dbErrors)
          .where(eq(dbErrors.applicationId, a.applicationId))
          .orderBy(desc(dbErrors.lastOccurrence))
          .limit(10);
        return res.json(errs.map((e) => ({
          errorId: `ERR-${e.id}`,
          type: e.errorType ?? "Application Error",
          message: e.message ?? e.cluster ?? "Error",
          service: e.service ?? e.applicationName ?? "Service",
          server: (e.metadata as any)?.nodeName ?? "Unknown",
          count: e.frequency ?? 1,
          timestamp: e.lastOccurrence?.getTime() ?? Date.now(),
        })));
      }
      if (alertId.startsWith("INC-")) {
        const numId = Number(alertId.slice(4));
        if (!Number.isFinite(numId)) return res.json([]);
        const [inc] = await db.select({ applicationId: dbIncidents.applicationId }).from(dbIncidents).where(eq(dbIncidents.id, numId));
        if (!inc?.applicationId) return res.json([]);
        const errs = await db.select().from(dbErrors)
          .where(eq(dbErrors.applicationId, inc.applicationId))
          .orderBy(desc(dbErrors.lastOccurrence))
          .limit(10);
        return res.json(errs.map((e) => ({
          errorId: `ERR-${e.id}`,
          type: e.errorType ?? "Application Error",
          message: e.message ?? e.cluster ?? "Error",
          service: e.service ?? e.applicationName ?? "Service",
          server: (e.metadata as any)?.nodeName ?? "Unknown",
          count: e.frequency ?? 1,
          timestamp: e.lastOccurrence?.getTime() ?? Date.now(),
        })));
      }
      return res.json([]);
    } catch {
      return res.json([]);
    }
  });
  app.get("/api/alerts/:alertId/ai-analysis", async (req, res) => {
    const { alertId } = req.params;
    const numStr = alertId.startsWith("ALT-") ? alertId.slice(4) : alertId.startsWith("INC-") ? alertId.slice(4) : alertId;
    const numId = parseInt(numStr);
    let name = alertId, severity = "Warning", appName = "Application";
    if (alertId.startsWith("ALT-") && !isNaN(numId)) {
      const [a] = await db.select({ name: dbAlerts.name, severity: dbAlerts.severity }).from(dbAlerts).where(eq(dbAlerts.id, numId));
      if (a) { name = a.name; severity = a.severity; }
    } else if (alertId.startsWith("INC-") && !isNaN(numId)) {
      const [i] = await db.select({ title: dbIncidents.title, severity: dbIncidents.severity, applicationId: dbIncidents.applicationId }).from(dbIncidents).where(eq(dbIncidents.id, numId));
      if (i) { name = i.title; severity = i.severity ?? "Warning"; }
    }
    return res.json({
      summary: `AI analysis for alert: ${name}. Severity is ${severity}.`,
      rootCause: `Based on historical patterns, this ${severity.toLowerCase()} alert on ${name} is consistent with resource saturation or a recent deployment change. Review recent deployments and associated metric anomalies.`,
      recommendations: [
        "Check for recent deployments or configuration changes correlated with this alert",
        "Review related metrics (CPU, memory, error rate) around the alert trigger time",
        "Validate downstream service health to rule out cascading failures",
      ],
      confidence: severity === "Critical" ? 82 : 65,
    });
  });
  app.get("/api/alerts/:alertId/related", async (req, res) => {
    const { alertId } = req.params;
    try {
      let appId: string | null = null;
      if (alertId.startsWith("ALT-")) {
        const numId = parseInt(alertId.slice(4));
        const [a] = await db.select({ applicationId: dbAlerts.applicationId }).from(dbAlerts).where(eq(dbAlerts.id, numId));
        appId = a?.applicationId ?? null;
      } else if (alertId.startsWith("INC-")) {
        const numId = parseInt(alertId.slice(4));
        const [i] = await db.select({ applicationId: dbIncidents.applicationId }).from(dbIncidents).where(eq(dbIncidents.id, numId));
        appId = i?.applicationId ?? null;
      }
      if (!appId) return res.json({ incidents: [], errors: [], nodes: [] });
      const incidents = await db.select().from(dbIncidents).where(eq(dbIncidents.applicationId, appId)).limit(5);
      const errors = await db.select().from(dbErrors).where(eq(dbErrors.applicationId, appId)).limit(5);
      const nodes = await db.select().from(dbServers).where(eq(dbServers.applicationId, appId)).limit(5);
      return res.json({
        incidents: incidents.map(i => ({ id: i.externalId, title: i.title, severity: i.severity, status: i.status })),
        errors: errors.map(e => ({ errorId: `ERR-${e.id}`, type: e.errorType, message: e.message?.substring(0, 80), severity: e.severity })),
        nodes: nodes.map(n => ({ name: n.name, status: n.status, cpuUsage: n.cpuUsage, memoryUsage: n.memoryUsage })),
      });
    } catch { return res.json({ incidents: [], errors: [], nodes: [] }); }
  });
  app.get("/api/alerts/:alertId", async (req, res) => {
    const { alertId } = req.params;
    try {
      if (alertId.startsWith("ALT-")) {
        const numId = parseInt(alertId.slice(4));
        if (!isNaN(numId)) {
          const [a] = await db.select().from(dbAlerts).where(eq(dbAlerts.id, numId));
          if (a) {
            const [app] = await db.select({ name: dbApplications.name }).from(dbApplications).where(eq(dbApplications.externalId, a.applicationId ?? ""));
            return res.json({
              alertId, source: a.source === "appdynamics" ? "AppDynamics" : "Dynatrace",
              severity: a.severity, status: a.status,
              entity: a.name, rule: a.name, service: app?.name ?? a.applicationId ?? "Application",
              description: `Health rule violation: ${a.name}`,
              timestamp: a.triggeredAt?.getTime() ?? Date.now(),
              resolvedAt: a.resolvedAt?.getTime() ?? null,
              aiRiskScore: a.severity === "Critical" ? 85 : 55,
              applicationName: app?.name ?? "Unknown",
              metric: a.metric, threshold: a.threshold, currentValue: a.currentValue,
              linkedIncident: null, correlatedAlerts: [], tags: [a.source === "appdynamics" ? "AppDynamics" : "Dynatrace", a.severity],
            });
          }
        }
      } else if (alertId.startsWith("INC-")) {
        const numId = parseInt(alertId.slice(4));
        if (!isNaN(numId)) {
          const [i] = await db.select().from(dbIncidents).where(eq(dbIncidents.id, numId));
          if (i) {
            const [app] = await db.select({ name: dbApplications.name }).from(dbApplications).where(eq(dbApplications.externalId, i.applicationId ?? ""));
            return res.json({
              alertId, source: i.source === "appdynamics" ? "AppDynamics" : "Dynatrace",
              severity: i.severity, status: i.status === "Open" ? "Active" : "Resolved",
              entity: i.title, rule: `Incident: ${i.title}`, service: i.affectedServices?.[0] ?? "Application",
              description: i.rootCause ?? i.title,
              timestamp: i.startTime?.getTime() ?? Date.now(),
              resolvedAt: i.endTime?.getTime() ?? null,
              aiRiskScore: i.severity === "Critical" ? 88 : 52,
              applicationName: app?.name ?? "Unknown",
              linkedIncident: alertId, correlatedAlerts: [], tags: [i.source === "appdynamics" ? "AppDynamics" : "Dynatrace", i.severity ?? "Warning", "Incident"],
            });
          }
        }
      } else {
        const numId = parseInt(alertId);
        if (!isNaN(numId)) {
          const [row] = await db.select().from(dbAlerts).where(eq(dbAlerts.id, numId));
          if (row) return res.json(row);
        }
      }
      return res.status(404).json({ message: "Alert not found" });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // === Errors — org-scoped real data from DB ===
  app.get("/api/errors", async (req, res) => {
    const extractRequestPath = (metadata: any, message?: string | null): string | null => {
      const meta = metadata ?? {};
      const direct =
        meta.requestPath ?? meta.path ?? meta.requestUri ?? meta.uri ?? meta.url ?? meta.endpoint ?? null;
      if (typeof direct === "string" && direct.trim()) return direct.trim();
      const text = String(message ?? "");
      const m = text.match(/(\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]+)/);
      return m?.[1] ?? null;
    };
    const extractBusinessTransaction = (metadata: any): string | null => {
      const meta = metadata ?? {};
      const direct = meta.businessTransaction ?? meta.transactionName ?? meta.btName ?? meta.bt ?? null;
      if (typeof direct === "string" && direct.trim()) return direct.trim();
      if (Array.isArray(meta.affectedEntities)) {
        const bt = meta.affectedEntities.find((ent: any) => {
          const type = String(ent?.entityType ?? "").toUpperCase();
          return type.includes("BUSINESS_TRANSACTION");
        });
        const btName = bt?.name;
        if (typeof btName === "string" && btName.trim()) return btName.trim();
      }
      return null;
    };
    const user = req.user as import("@shared/schema").User | undefined;
    if (user) {
      const orgData = await getUserOrg(user.id);
      if (orgData) {
        const orgCreds = await db.select({ id: apmCredentials.id })
          .from(apmCredentials)
          .where(and(eq(apmCredentials.organizationId, orgData.org.id), eq(apmCredentials.isActive, true)));
        if (orgCreds.length > 0) {
          const credIds = orgCreds.map(c => c.id);
          const apps = await db.select({
            id: dbApplications.id,
            name: dbApplications.name,
            externalId: dbApplications.externalId,
            credentialId: dbApplications.credentialId,
            source: dbApplications.source,
          }).from(dbApplications)
            .where(credIds.length === 1
              ? eq(dbApplications.credentialId, credIds[0])
              : sql`${dbApplications.credentialId} = ANY(ARRAY[${sql.join(credIds.map(id => sql`${id}`), sql`, `)}]::integer[])`);

          const dbErrorRows = await db.select().from(dbErrors)
            .where(credIds.length === 1
              ? sql`${dbErrors.applicationId} IN (SELECT external_id::text FROM apm_applications WHERE credential_id = ${credIds[0]})`
              : sql`${dbErrors.applicationId} IN (SELECT external_id::text FROM apm_applications WHERE credential_id = ANY(ARRAY[${sql.join(credIds.map(id => sql`${id}`), sql`, `)}]::integer[]))`)
            .orderBy(desc(dbErrors.lastOccurrence))
            .limit(200);

          const realErrorRows = dbErrorRows.map(e => {
              const requestPath = extractRequestPath(e.metadata, e.message);
              const businessTransaction = extractBusinessTransaction(e.metadata);
              return ({
              errorId: `ERR-${e.id}`,
              type: e.errorType ?? "Application Error",
              message: e.message ?? e.cluster,
              service: e.service ?? e.applicationName ?? "Unknown Service",
              server: (e.metadata as any)?.nodeName ?? e.service ?? "Unknown",
              appId: e.applicationId,
              source: e.source === "appdynamics" ? "AppDynamics" : "Dynatrace",
              timestamp: e.lastOccurrence?.getTime() ?? Date.now(),
              count: e.frequency ?? 1,
              clusterId: e.cluster,
              severity: e.severity ?? "Medium",
              status: e.status ?? "Active",
              firstSeen: e.firstSeen?.getTime() ?? null,
              lastSeen: e.lastOccurrence?.getTime() ?? null,
              applicationName: e.applicationName,
              recommendation: "Open error detail and inspect stack/message context.",
              requestPath,
              businessTransaction,
              callToCheck: requestPath ?? businessTransaction ?? null,
          });
          });

          // Metric-derived dynamic errors (for apps where APM exposes error metrics but /events is empty)
          const latestMetricRows = await db.execute(sql`
            SELECT DISTINCT ON (entity_id, credential_id, metric_name)
              entity_id, credential_id, metric_name, value, recorded_at
            FROM apm_metrics
            WHERE entity_type = 'application'
              AND credential_id = ANY(ARRAY[${sql.join(credIds.map(id => sql`${id}`), sql`, `)}]::integer[])
              AND metric_name = ANY(ARRAY['errors_per_minute','calls_per_minute','avg_response_time'])
            ORDER BY entity_id, credential_id, metric_name, recorded_at DESC
          `);
          const lmRows = (latestMetricRows as any).rows ?? [];
          const latestMap = new Map<string, { err?: number; calls?: number; resp?: number; ts?: number }>();
          for (const r of lmRows) {
            const key = `${r.entity_id}::${r.credential_id ?? ""}`;
            const entry = latestMap.get(key) ?? {};
            if (r.metric_name === "errors_per_minute") entry.err = r.value != null ? Number(r.value) : undefined;
            if (r.metric_name === "calls_per_minute") entry.calls = r.value != null ? Number(r.value) : undefined;
            if (r.metric_name === "avg_response_time") entry.resp = r.value != null ? Number(r.value) : undefined;
            if (r.recorded_at) entry.ts = new Date(r.recorded_at).getTime();
            latestMap.set(key, entry);
          }

          const metricErrors = apps
            .map((a) => {
              const key = `${a.externalId}::${a.credentialId ?? ""}`;
              const m = latestMap.get(key);
              const err = m?.err ?? 0;
              const calls = m?.calls ?? 0;
              const resp = m?.resp ?? 0;
              const errPct = calls > 0 ? (err / calls) * 100 : 0;
              if (err <= 0 && errPct <= 0) return null;
              const severity = errPct >= 5 ? "Critical" : errPct >= 1 ? "High" : "Medium";
              const recommendation =
                errPct >= 5
                  ? "Investigate top failing endpoints, verify downstream dependencies, and roll back latest risky deployment if needed."
                  : errPct >= 1
                    ? "Inspect recent logs and trace spikes; verify retries/timeouts and dependency health."
                    : "Monitor trend and set alert threshold to catch upward movement early.";
              return {
                errorId: `METRIC-${a.id}`,
                type: "Application Error Rate Spike",
                message: `Error rate ${errPct.toFixed(2)}% (${err.toFixed(2)} errors/min of ${calls.toFixed(2)} calls/min)`,
                service: a.name,
                server: "N/A",
                appId: a.externalId,
                source: a.source === "appdynamics" ? "AppDynamics" : "Dynatrace",
                timestamp: m?.ts ?? Date.now(),
                count: Math.max(1, Math.round(err)),
                clusterId: `METRIC-${a.externalId}`,
                severity,
                status: "Active",
                firstSeen: m?.ts ?? null,
                lastSeen: m?.ts ?? null,
                applicationName: a.name,
                recommendation,
                requestPath: null,
                businessTransaction: null,
                callToCheck: null,
                _resp: resp,
              };
            })
            .filter(Boolean);

          const allRows = [...realErrorRows, ...(metricErrors as any[])];
          if (allRows.length > 0) {
            return res.json(allRows.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)));
          }
        }
      }
    }
    // Fallback: no credentials configured → empty
    return res.json([]);
  });
  app.get("/api/errors/:errorId/ai-analysis", async (req, res) => {
    if (req.params.errorId.startsWith("METRIC-")) {
      const appDbId = Number(req.params.errorId.replace("METRIC-", ""));
      if (!Number.isFinite(appDbId)) return res.json({ summary: "", rootCause: "", recommendations: [], confidence: 0 });
      const [appRow] = await db.select().from(dbApplications).where(eq(dbApplications.id, appDbId));
      if (!appRow) return res.json({ summary: "", rootCause: "", recommendations: [], confidence: 0 });
      const latestRows = await db.execute(sql`
        SELECT DISTINCT ON (metric_name) metric_name, value, recorded_at
        FROM apm_metrics
        WHERE entity_type = 'application'
          AND entity_id = ${appRow.externalId}
          AND credential_id = ${appRow.credentialId}
          AND metric_name = ANY(ARRAY['errors_per_minute','calls_per_minute','avg_response_time'])
        ORDER BY metric_name, recorded_at DESC
      `);
      const rows = (latestRows as any).rows ?? [];
      const getVal = (name: string) => Number(rows.find((r: any) => r.metric_name === name)?.value ?? 0);
      const err = getVal("errors_per_minute");
      const calls = getVal("calls_per_minute");
      const resp = getVal("avg_response_time");
      const errPct = calls > 0 ? (err / calls) * 100 : 0;
      const severity = errPct >= 5 ? "Critical" : errPct >= 1 ? "High" : "Medium";
      return res.json({
        summary: `${appRow.name} currently shows ${errPct.toFixed(2)}% error rate with ${err.toFixed(2)} errors/min and ${calls.toFixed(2)} calls/min.`,
        rootCause: `Likely service degradation pattern. Response time baseline is around ${resp.toFixed(2)}ms; elevated error rate indicates request failures under current throughput.`,
        recommendations: [
          "Inspect failing endpoints and top error signatures in application logs",
          "Validate downstream dependencies (DB/backends/external APIs) health and latency",
          "Check recent deployments/config changes and rollback if correlated with spike",
          severity === "Critical" ? "Scale service and enable protective throttling while mitigation is in progress" : "Set tighter alert thresholds for early warning",
        ],
        confidence: severity === "Critical" ? 88 : severity === "High" ? 76 : 65,
      });
    }
    const numId = parseInt(req.params.errorId.replace("ERR-", ""));
    if (isNaN(numId)) return res.json({ summary: "", rootCause: "", recommendations: [], confidence: 0 });
    try {
      const [err] = await db.select().from(dbErrors).where(eq(dbErrors.id, numId));
      if (!err) return res.json({ summary: "", rootCause: "", recommendations: [], confidence: 0 });
      const sev = err.severity ?? "Warning";
      const confidence = sev === "Critical" ? 87 : 72;
      return res.json({
        summary: `${err.errorType ?? "Application error"} detected in ${err.service ?? err.applicationName ?? "service"} with ${(err.frequency ?? 1).toLocaleString()} occurrences. ${sev === "Critical" ? "This is a high-impact issue requiring immediate attention." : "Monitoring recommended."}`,
        rootCause: `Root cause analysis indicates this ${err.errorType ?? "error"} is likely caused by: ${err.message ? err.message.substring(0, 120) + "..." : "resource exhaustion or configuration drift"}. ${err.service ? `The ${err.service} service appears to be the primary origin.` : ""}`,
        recommendations: [
          `Investigate ${err.service ?? "the affected service"} for resource saturation or configuration issues`,
          "Review recent deployments or configuration changes correlated with this error's first occurrence",
          "Set up automated alerting if occurrence count exceeds historical baseline",
          sev === "Critical" ? "Escalate to on-call engineer immediately — this error is impacting production" : "Monitor error frequency trend over the next 24 hours",
        ],
        confidence,
      });
    } catch { return res.json({ summary: "", rootCause: "", recommendations: [], confidence: 0 }); }
  });
  app.get("/api/errors/:errorId/correlated", async (req, res) => {
    if (req.params.errorId.startsWith("METRIC-")) {
      const appDbId = Number(req.params.errorId.replace("METRIC-", ""));
      if (!Number.isFinite(appDbId)) return res.json([]);
      const [appRow] = await db.select().from(dbApplications).where(eq(dbApplications.id, appDbId));
      if (!appRow) return res.json([]);
      const siblings = await db.select().from(dbApplications)
        .where(and(eq(dbApplications.credentialId, appRow.credentialId), sql`${dbApplications.id} != ${appDbId}`))
        .limit(6);
      return res.json(siblings.map((a: any) => ({
        errorId: `METRIC-${a.id}`,
        type: "Related Error Rate Signal",
        message: `Related application ${a.name}`,
        service: a.name,
        severity: "Medium",
        count: 1,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        applicationName: a.name,
      })));
    }
    const numId = parseInt(req.params.errorId.replace("ERR-", ""));
    if (isNaN(numId)) return res.json([]);
    try {
      const [err] = await db.select().from(dbErrors).where(eq(dbErrors.id, numId));
      if (!err) return res.json([]);
      const siblings = await db.select().from(dbErrors)
        .where(and(eq(dbErrors.applicationId, err.applicationId ?? ""), sql`${dbErrors.id} != ${numId}`))
        .orderBy(desc(dbErrors.frequency)).limit(6);
      return res.json(siblings.map(e => ({
        errorId: `ERR-${e.id}`, type: e.errorType ?? "Error", message: e.message?.substring(0, 100),
        service: e.service, severity: e.severity, count: e.frequency,
        firstSeen: e.firstSeen?.getTime(), lastSeen: e.lastOccurrence?.getTime(),
        applicationName: e.applicationName,
      })));
    } catch { return res.json([]); }
  });
  app.get("/api/errors/:errorId/predictions", async (req, res) => {
    if (req.params.errorId.startsWith("METRIC-")) {
      const appDbId = Number(req.params.errorId.replace("METRIC-", ""));
      if (!Number.isFinite(appDbId)) return res.json([]);
      const [appRow] = await db.select().from(dbApplications).where(eq(dbApplications.id, appDbId));
      if (!appRow) return res.json([]);
      const hist = await db.select({ t: dbMetrics.recordedAt, v: dbMetrics.value }).from(dbMetrics)
        .where(and(
          eq(dbMetrics.entityType, "application"),
          eq(dbMetrics.entityId, appRow.externalId),
          eq(dbMetrics.credentialId, appRow.credentialId),
          eq(dbMetrics.metricName, "errors_per_minute"),
        ))
        .orderBy(desc(dbMetrics.recordedAt))
        .limit(24);
      if (hist.length === 0) return res.json([]);
      const ordered = [...hist].reverse();
      return res.json(ordered.map((h: any, i: number) => ({
        timestamp: h.t.getTime() + i * 3600000,
        predicted: Math.max(0, Number(h.v ?? 0)),
        lower: Math.max(0, Number(h.v ?? 0) * 0.8),
        upper: Math.max(0, Number(h.v ?? 0) * 1.2),
      })));
    }
    const numId = parseInt(req.params.errorId.replace("ERR-", ""));
    if (isNaN(numId)) return res.json([]);
    try {
      const [err] = await db.select().from(dbErrors).where(eq(dbErrors.id, numId));
      if (!err) return res.json([]);
      const now = Date.now();
      const base = err.frequency ?? 1;
      const trend = err.frequencyTrend === "increasing" ? 1.15 : err.frequencyTrend === "decreasing" ? 0.85 : 1.0;
      return res.json(Array.from({ length: 12 }).map((_, i) => ({
        timestamp: now + i * 3600000,
        predicted: Math.round(base * Math.pow(trend, i) * (0.9 + Math.random() * 0.2)),
        lower: Math.round(base * Math.pow(trend, i) * 0.75),
        upper: Math.round(base * Math.pow(trend, i) * 1.30),
      })));
    } catch { return res.json([]); }
  });
  app.get("/api/errors/:errorId", async (req, res) => {
    const extractRequestPath = (metadata: any, message?: string | null): string | null => {
      const meta = metadata ?? {};
      const direct =
        meta.requestPath ?? meta.path ?? meta.requestUri ?? meta.uri ?? meta.url ?? meta.endpoint ?? null;
      if (typeof direct === "string" && direct.trim()) return direct.trim();
      const text = String(message ?? "");
      const m = text.match(/(\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]+)/);
      return m?.[1] ?? null;
    };
    if (req.params.errorId.startsWith("METRIC-")) {
      const appDbId = Number(req.params.errorId.replace("METRIC-", ""));
      if (!Number.isFinite(appDbId)) return res.status(404).json({ message: "Error not found" });
      const [appRow] = await db.select().from(dbApplications).where(eq(dbApplications.id, appDbId));
      if (!appRow) return res.status(404).json({ message: "Error not found" });
      const latestRows = await db.execute(sql`
        SELECT DISTINCT ON (metric_name) metric_name, value, recorded_at
        FROM apm_metrics
        WHERE entity_type = 'application'
          AND entity_id = ${appRow.externalId}
          AND credential_id = ${appRow.credentialId}
          AND metric_name = ANY(ARRAY['errors_per_minute','calls_per_minute','avg_response_time'])
        ORDER BY metric_name, recorded_at DESC
      `);
      const rows = (latestRows as any).rows ?? [];
      const getVal = (name: string) => Number(rows.find((r: any) => r.metric_name === name)?.value ?? 0);
      const err = getVal("errors_per_minute");
      const calls = getVal("calls_per_minute");
      const resp = getVal("avg_response_time");
      const [topBt] = await db.select({
        name: dbTransactions.name,
        errorRate: dbTransactions.errorRate,
        callsPerMinute: dbTransactions.callsPerMinute,
      }).from(dbTransactions)
        .where(eq(dbTransactions.applicationId, appRow.externalId))
        .orderBy(desc(dbTransactions.errorRate), desc(dbTransactions.callsPerMinute))
        .limit(1);
      const [topServer] = await db.select({
        name: dbServers.name,
      }).from(dbServers)
        .where(eq(dbServers.applicationId, appRow.externalId))
        .orderBy(desc(dbServers.alerts), desc(dbServers.cpuUsage))
        .limit(1);
      const errPct = calls > 0 ? (err / calls) * 100 : 0;
      const severity = errPct >= 5 ? "Critical" : errPct >= 1 ? "Warning" : "Low";
      const now = Date.now();
      const topPath = topBt?.name ?? null;
      return res.json({
        errorId: req.params.errorId,
        type: "Application Error Rate Spike",
        message: `Error rate is ${errPct.toFixed(2)}% (${err.toFixed(2)} errors/min / ${calls.toFixed(2)} calls/min).${topPath ? ` Top failing path: ${topPath}` : ""}`,
        severity,
        status: "Active",
        source: appRow.source === "appdynamics" ? "AppDynamics" : "Dynatrace",
        service: appRow.name,
        server: topServer?.name ?? "Unknown",
        applicationName: appRow.name,
        count: Math.max(1, Math.round(err)),
        firstOccurrence: now - 60 * 60 * 1000,
        lastOccurrence: now,
        firstSeen: now - 60 * 60 * 1000,
        duration: "1h",
        clusterId: `METRIC-${appRow.externalId}`,
        cluster: { label: "Metric-derived error cluster", matchPct: 85 },
        aiSeverityScore: Math.min(99, Math.round(errPct * 10 + (resp > 2000 ? 20 : 0))),
        userImpactCount: Math.max(1, Math.round(err * 0.5)),
        requestPath: topPath,
        businessTransaction: topPath,
        httpCode: null,
        sourceSystem: appRow.source === "appdynamics" ? "AppDynamics" : "Dynatrace",
        stackTrace: null,
        linkedIncident: null,
        debugAssistant: {
          responses: {
            "root cause": `Elevated error ratio detected for ${appRow.name}. Compare failing endpoints and dependency latency near ${new Date(now).toISOString()}.`,
            "fix": "Inspect top failing APIs, validate backend/database health, and roll back recent risky deployment if correlated.",
            "impact": `Current estimated error rate is ${errPct.toFixed(2)}%.`,
          },
        },
      });
    }
    const numId = parseInt(req.params.errorId.replace("ERR-", ""));
    if (isNaN(numId)) return res.status(404).json({ message: "Error not found" });
    try {
      const [err] = await db.select().from(dbErrors).where(eq(dbErrors.id, numId));
      if (!err) return res.status(404).json({ message: "Error not found" });
      const [app] = await db.select({ name: dbApplications.name }).from(dbApplications).where(eq(dbApplications.externalId, err.applicationId ?? ""));
      const [appDb] = await db.select({
        id: dbApplications.id,
        externalId: dbApplications.externalId,
        credentialId: dbApplications.credentialId,
      }).from(dbApplications)
        .where(eq(dbApplications.externalId, err.applicationId ?? ""))
        .limit(1);
      const [topBtForErr] = await db.select({
        name: dbTransactions.name,
      }).from(dbTransactions)
        .where(eq(dbTransactions.applicationId, err.applicationId ?? ""))
        .orderBy(desc(dbTransactions.errorRate), desc(dbTransactions.callsPerMinute))
        .limit(1);
      const [topServerForErr] = await db.select({
        name: dbServers.name,
      }).from(dbServers)
        .where(eq(dbServers.applicationId, err.applicationId ?? ""))
        .orderBy(desc(dbServers.alerts), desc(dbServers.cpuUsage))
        .limit(1);
      const now = Date.now();
      const firstMs = err.firstSeen?.getTime() ?? now - 86400000;
      const lastMs = err.lastOccurrence?.getTime() ?? now;
      const durationMins = Math.floor((lastMs - firstMs) / 60000);
      const sev = err.severity ?? "Warning";
      const aiScore = sev === "Critical" ? 85 + Math.floor(Math.random() * 12) : sev === "Warning" ? 50 + Math.floor(Math.random() * 20) : 20 + Math.floor(Math.random() * 15);
      return res.json({
        errorId: `ERR-${err.id}`,
        type: err.errorType ?? "Application Error",
        message: err.message ?? err.cluster,
        severity: sev,
        status: err.status ?? "Active",
        source: err.source === "appdynamics" ? "AppDynamics" : "Dynatrace",
        service: err.service ?? err.applicationName ?? "Unknown",
        server: (err.metadata as any)?.nodeName ?? topServerForErr?.name ?? err.service ?? "Unknown",
        applicationName: app?.name ?? err.applicationName ?? "Unknown",
        count: err.frequency ?? 1,
        firstOccurrence: firstMs,
        lastOccurrence: lastMs,
        firstSeen: firstMs,
        duration: durationMins > 60 ? `${Math.floor(durationMins / 60)}h ${durationMins % 60}m` : `${durationMins}m`,
        clusterId: err.cluster ?? "production",
        cluster: { label: err.cluster ?? "production", matchPct: 80 },
        aiSeverityScore: aiScore,
        userImpactCount: sev === "Critical" ? Math.floor((err.frequency ?? 1) * 0.4) : Math.floor((err.frequency ?? 1) * 0.1),
        requestPath: extractRequestPath(err.metadata, err.message) ?? topBtForErr?.name ?? null,
        businessTransaction: topBtForErr?.name ?? null,
        httpCode: (err.metadata as any)?.httpCode ?? null,
        sourceSystem: err.source === "appdynamics" ? "AppDynamics" : "Dynatrace",
        stackTrace: (err.metadata as any)?.stackTrace ?? null,
        linkedIncident: null,
        debugAssistant: {
          responses: {
            "root cause": `This ${err.errorType ?? "error"} in ${err.service ?? "service"} is most likely caused by: ${err.message ? err.message.substring(0, 150) : "resource exhaustion or configuration drift"}.`,
            "fix": `To resolve this: 1) Check ${err.service ?? "service"} logs around ${new Date(lastMs).toISOString()}, 2) Review recent deployments, 3) Verify resource limits are not breached.`,
            "impact": `This error has occurred ${(err.frequency ?? 1).toLocaleString()} times. ${sev === "Critical" ? "It is critically impacting production operations." : "Impact is moderate — monitor closely."}`,
          },
        },
      });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });
  // === Incidents List (org-scoped) ===
  app.get("/api/incidents", async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: "Not authenticated" });
    try {
      const user = req.user as import("@shared/schema").User;
      const orgData = await getUserOrg(user.id);
      if (!orgData) return res.json([]);

      const credRows = await db
        .select({ id: apmCredentials.id, source: apmCredentials.source })
        .from(apmCredentials)
        .where(and(
          eq(apmCredentials.organizationId, orgData.org.id),
          eq(apmCredentials.isActive, true),
        ));
      if (!credRows.length) return res.json([]);

      const credIds = credRows.map(c => c.id);
      const sourceSet = new Set(credRows.map(c => String(c.source)));

      const apps = await db
        .select({ externalId: dbApplications.externalId, id: dbApplications.id, name: dbApplications.name, credentialId: dbApplications.credentialId })
        .from(dbApplications)
        .where(credIds.length === 1
          ? eq(dbApplications.credentialId, credIds[0])
          : sql`${dbApplications.credentialId} = ANY(ARRAY[${sql.join(credIds.map(id => sql`${id}`), sql`, `)}]::integer[])`);

      const appByExternalId = new Map<string, { id: number; name: string }>();
      const appByName = new Map<string, { id: number; name: string; externalId: string }>();
      for (const a of apps) {
        const ext = String(a.externalId ?? "");
        if (ext) appByExternalId.set(ext, { id: a.id, name: a.name });
        const lower = String(a.name ?? "").trim().toLowerCase();
        if (lower) appByName.set(lower, { id: a.id, name: a.name, externalId: ext });
      }

      // Pull incidents from active sources, then match to org apps by multiple signals
      const candidateIncidents = await db
        .select()
        .from(dbIncidents)
        .where(sql`${dbIncidents.source} = ANY(ARRAY[${sql.join(Array.from(sourceSet).map(s => sql`${s}`), sql`, `)}]::text[])`)
        .orderBy(desc(dbIncidents.startTime))
        .limit(300);

      const incidents = candidateIncidents.filter((inc) => {
        const appId = String(inc.applicationId ?? "");
        if (appId && appByExternalId.has(appId)) return true;

        const impacted = Array.isArray((inc.metadata as any)?.impactedEntities) ? (inc.metadata as any).impactedEntities : [];
        for (const ent of impacted) {
          const entId = String(ent?.entityId?.id ?? ent?.id ?? "");
          if (entId && appByExternalId.has(entId)) return true;
          const entName = String(ent?.name ?? "").trim().toLowerCase();
          if (entName && appByName.has(entName)) return true;
        }

        for (const svc of inc.affectedServices ?? []) {
          const svcKey = String(svc ?? "").trim().toLowerCase();
          if (svcKey && appByName.has(svcKey)) return true;
        }

        const titleLower = String(inc.title ?? "").toLowerCase();
        for (const appName of appByName.keys()) {
          if (appName && titleLower.includes(appName)) return true;
        }
        return false;
      }).slice(0, 100);

      return res.json(incidents.map(inc => {
        const sev = inc.severity ?? "Warning";
        let appInfo = appByExternalId.get(String(inc.applicationId ?? ""));
        if (!appInfo) {
          const impacted = Array.isArray((inc.metadata as any)?.impactedEntities) ? (inc.metadata as any).impactedEntities : [];
          for (const ent of impacted) {
            const entId = String(ent?.entityId?.id ?? ent?.id ?? "");
            if (entId && appByExternalId.has(entId)) { appInfo = appByExternalId.get(entId); break; }
            const entName = String(ent?.name ?? "").trim().toLowerCase();
            if (entName && appByName.has(entName)) { appInfo = appByName.get(entName); break; }
          }
        }
        if (!appInfo) {
          for (const svc of inc.affectedServices ?? []) {
            const svcKey = String(svc ?? "").trim().toLowerCase();
            if (svcKey && appByName.has(svcKey)) { appInfo = appByName.get(svcKey); break; }
          }
        }
        return {
          incidentId: inc.externalId,
          id: inc.externalId,
          title: inc.title,
          severity: sev,
          status: inc.status,
          startTime: inc.startTime?.getTime() ?? Date.now(),
          endTime: inc.endTime?.getTime() ?? null,
          affectedServices: inc.affectedServices ?? [],
          affectedTiers: inc.affectedServices ?? [],
          rootCause: inc.rootCause ?? null,
          mttr: null,
          impactScore: sev === "Critical" ? 88 : sev === "Warning" ? 55 : 20,
          applicationName: appInfo?.name ?? inc.applicationId ?? "Unknown Application",
          applicationId: appInfo?.id ?? null,
        };
      }));
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // === Incident Detail ===
  app.get("/api/incidents/:incidentId", async (req, res) => {
    const { incidentId } = req.params;
    try {
      // Try DB first (handles showcase IDs like SC-INC-001)
      const [dbInc] = await db.select().from(dbIncidents).where(eq(dbIncidents.externalId, incidentId));
      if (dbInc) {
        const now = Date.now();
        const startMs = dbInc.startTime?.getTime() ?? now - 3600000;
        const endMs = dbInc.endTime?.getTime() ?? null;
        const durationMins = Math.floor(((endMs ?? now) - startMs) / 60000);
        const sev = dbInc.severity ?? "Warning";
        const confidence = sev === "Critical" ? 88 : 72;
        const relatedAlerts = await db.select().from(dbAlerts).where(eq(dbAlerts.applicationId, dbInc.applicationId)).limit(5);
        const [app] = await db.select({ id: dbApplications.id, name: dbApplications.name }).from(dbApplications).where(eq(dbApplications.externalId, dbInc.applicationId));
        const services: string[] = (dbInc.affectedServices as string[]) ?? [];
        return res.json({
          incidentId: dbInc.externalId,
          title: dbInc.title,
          status: dbInc.status,
          severity: sev,
          startTime: startMs,
          endTime: endMs,
          duration: `${Math.floor(durationMins / 60)}h ${durationMins % 60}m`,
          confidenceScore: confidence,
          businessImpactScore: sev === "Critical" ? 87 : 52,
          estimatedRevenueLoss: sev === "Critical" ? 18500 : 4200,
          affectedUsers: sev === "Critical" ? 4200 : 800,
          affectedApplications: app ? [{ id: app.id, name: app.name, status: sev, errorRateSpike: sev === "Critical" ? 5.2 : 1.8 }] : [],
          affectedServices: services.map((svc, i) => ({
            name: svc,
            tier: i === 0 ? "Frontend" : "Backend",
            severity: i === 0 ? sev : "Warning",
            errors: ["500 Internal Server Error", "503 Service Unavailable"].slice(0, Math.min(i + 1, 2)),
            errorRateDelta: i === 0 ? 48 : 12,
          })),
          affectedServers: [],
          rootCause: {
            hypothesis: dbInc.rootCause ?? "Root cause analysis in progress. Review recent deployments and resource metrics.",
            confidence,
            causalChains: [
              { step: 1, label: "Service Degradation", value: "Elevated latency", delta: "+180%", type: "service" },
              { step: 2, label: "Error Rate Spike", value: sev === "Critical" ? "5.2%" : "1.8%", delta: sev === "Critical" ? "+4.8%" : "+1.4%", type: "incident" },
              { step: 3, label: "User Impact", value: sev === "Critical" ? "4,200 users" : "800 users", delta: "Significant", type: "app" },
            ],
          },
          metrics: {
            cpu: Array.from({ length: 30 }).map((_, i) => ({ timestamp: startMs - (29 - i) * 300000, value: i < 15 ? 30 + Math.random() * 20 : 65 + Math.random() * 25, anomaly: i >= 18 })),
            memory: Array.from({ length: 30 }).map((_, i) => ({ timestamp: startMs - (29 - i) * 300000, value: 45 + i * 1.5 + Math.random() * 8, anomaly: i >= 22 })),
            errorRate: Array.from({ length: 30 }).map((_, i) => ({ timestamp: startMs - (29 - i) * 300000, value: i < 15 ? 0.3 + Math.random() * 0.3 : 2 + Math.random() * 3, anomaly: i >= 15 })),
            responseTime: Array.from({ length: 30 }).map((_, i) => ({ timestamp: startMs - (29 - i) * 300000, value: i < 15 ? 280 + Math.random() * 80 : 1200 + Math.random() * 2000, anomaly: i >= 15 })),
            throughput: Array.from({ length: 30 }).map((_, i) => ({ timestamp: startMs - (29 - i) * 300000, value: i < 22 ? 900 + Math.random() * 300 : 450 + Math.random() * 150, anomaly: i >= 22 })),
          },
          affectedTransactions: services.slice(0, 2).map((svc, i) => ({
            id: `tx-${i + 1}`, name: svc,
            throughputDrop: sev === "Critical" ? 52 : 22,
            errorSpike: sev === "Critical" ? 5.2 : 1.8,
            slaBreach: sev === "Critical",
            avgResponseTime: sev === "Critical" ? 4500 : 1800,
          })),
          timeline: [
            { at: startMs - 900000, event: "Metric deviation begins", detail: "Service latency and error rate begin deviating from baseline. AI engine starts causal correlation.", type: "metric", icon: "metric" },
            { at: startMs - 540000, event: "Anomaly threshold crossed", detail: "Performance metrics exceed warning thresholds. Automated health rule evaluation triggered.", type: "detection", icon: "brain" },
            { at: startMs - 180000, event: "Warning alert fired", detail: `Health rule violation detected on ${services[0] ?? "affected service"}. Escalation pending.`, type: "warning", icon: "warning" },
            { at: startMs, event: `Incident ${dbInc.externalId} created`, detail: `${sev} incident auto-created. ${services.length} services affected.`, type: "incident", icon: "incident" },
            { at: startMs + 180000, event: "AI root cause hypothesis generated", detail: `Root cause identified with ${confidence}% confidence. Remediation recommendations queued.`, type: "ai", icon: "brain" },
            { at: startMs + 360000, event: "Recommendations generated", detail: "4 prioritised remediation actions generated and ranked by confidence and estimated impact reduction.", type: "ai", icon: "brain" },
            ...(dbInc.status === "Resolved" && endMs ? [{ at: endMs, event: "Incident resolved", detail: `MTTR: ${dbInc.mttr ? `${Math.floor(dbInc.mttr / 60)}m` : `${Math.floor(((endMs) - startMs) / 60000)}m`}`, type: "resolved", icon: "resolved" }] : []),
          ],
          notes: [
            { id: "note-01", author: "AI Engine", role: "Perviewsis AI", avatar: "AI", timestamp: startMs + 180000, content: `Analysis complete: ${dbInc.rootCause ?? "Root cause identification in progress. AI is correlating signals across affected services."}`, tags: ["AI Summary", "Root Cause"] },
          ],
          autoRemediation: {
            available: sev === "Critical",
            status: "Ready",
            script: "scale-affected-service.yml",
            type: "Ansible + Terraform",
            preview: `kubectl scale deploy/${services[0]?.toLowerCase().replace(/\s+/g, '-') ?? "service"}-deployment --replicas=6\nterraform apply -var 'service_replicas=6'`,
            estimatedImpactReduction: sev === "Critical" ? 72 : 45,
            history: [],
          },
          relatedAlerts: relatedAlerts.map(a => ({
            alertId: `ALT-${a.id}`, severity: a.severity, status: a.status,
            rule: a.name, timestamp: a.triggeredAt?.getTime() ?? Date.now(),
          })),
          aiInsight: {
            summary: dbInc.rootCause ?? "AI analysis is examining patterns across correlated signals.",
            confidence,
            recommendations: [
              "Review recent deployments and configuration changes",
              "Check resource utilization trends on affected nodes",
              "Examine correlated error clusters for shared root cause",
              "Consider scaling affected services if resource bound",
            ],
          },
          aiCorrelation: {
            summary: `${dbInc.title}: AI correlation identifies this as ${sev === "Critical" ? "a high-impact cascading failure" : "a service degradation event"} requiring immediate attention.`,
            confidence: confidence / 100,
            strength: confidence,
            evidence: relatedAlerts.slice(0, 3).map((a, i) => ({ type: "Alert", detail: a.name, score: 0.9 - i * 0.1 })),
            suggestions: [
              { label: "View Related Alerts", href: "/alerts" },
              ...(app ? [{ label: `View ${app.name}`, href: `/applications/${app.id}` }] : []),
            ],
          },
        });
      }
    } catch (err: any) { console.error("Incident detail DB lookup error:", err); }
    return res.status(404).json({ message: "Incident not found" });
  });

  // === Rich App Data ===
  app.get("/api/applications/:id/rich", async (req, res) => {
    const appId = Number(req.params.id);
    const [appRow] = await db.select().from(dbApplications).where(eq(dbApplications.id, appId));
    if (!appRow) return res.json(await storage.getApplicationRichData(appId));

    const risks = await db.select().from(dbCapacityRisks).where(eq(dbCapacityRisks.appId, appId)).limit(10);
    const topRisk = risks.sort((a, b) => (b.riskScore ?? 0) - (a.riskScore ?? 0))[0];
    const baseScore = appRow.healthScore ?? Math.max(60, 100 - (appRow.errorRate ?? 0) * 6 - (appRow.avgResponseTime ?? 0) / 80);
    const slaScore = clamp(Math.round(baseScore), 40, 99);
    const likelyBreach = (appRow.errorRate ?? 0) > 3 || (appRow.avgResponseTime ?? 0) > 1500 || slaScore < 70;
    const forecastRisk = topRisk || likelyBreach
      ? {
          hoursToSLABreach: Math.max(1, Math.round((topRisk?.hoursToSaturation ?? 6))),
          confidence: Math.round((topRisk?.confidence ?? 0.82) * 100),
          score: topRisk?.riskScore ?? Math.max(72, 100 - slaScore),
        }
      : null;
    const env =
      appRow.name.toLowerCase().includes("staging") ? "Staging"
      : appRow.name.toLowerCase().includes("dev") ? "Development"
      : "Production";

    return res.json({
      slaScore,
      environment: env,
      forecastRisk,
    });
  });

  app.get("/api/applications/:id/service-risks", async (req, res) => {
    const appId = Number(req.params.id);
    const [appRow] = await db.select().from(dbApplications).where(eq(dbApplications.id, appId));
    if (!appRow) return res.json(await storage.getServiceRiskRankings(appId));

    const errors = await db.select().from(dbErrors)
      .where(eq(dbErrors.applicationId, appRow.externalId))
      .limit(200);
    if (errors.length === 0) return res.json(await storage.getServiceRiskRankings(appId));

    const grouped = new Map<string, { count: number; sev: string; trend?: string | null; sample?: string | null }>();
    for (const e of errors) {
      const key = e.service ?? "unknown-service";
      const g = grouped.get(key) ?? { count: 0, sev: e.severity ?? "Warning", trend: e.frequencyTrend, sample: e.message };
      g.count += e.frequency ?? 1;
      if ((e.severity ?? "") === "Critical") g.sev = "Critical";
      grouped.set(key, g);
    }

    const items = [...grouped.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 6)
      .map(([service, info]) => {
        const riskScore = clamp(Math.round((info.sev === "Critical" ? 75 : 45) + Math.log(info.count + 1) * 8), 30, 98);
        const trend = info.trend === "up" ? "worsening" : info.trend === "down" ? "improving" : "stable";
        return {
          service,
          tier: appRow.tier ?? "Service",
          trend,
          hypothesis: info.sample?.slice(0, 120) ?? "Service experiencing elevated errors.",
          riskScore,
          failureProbability: clamp(Math.round(riskScore * 0.9), 20, 95),
          confidence: clamp(70 + Math.round(riskScore * 0.2), 60, 95),
          recommendations: [
            "Inspect recent deployments and config changes",
            "Check database latency and dependency health",
            "Scale replicas and review resource limits",
          ],
          expectedFailureDate: info.sev === "Critical" ? new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString() : null,
        };
      });

    return res.json(items);
  });

  app.get("/api/applications/:id/http-errors", async (req, res) => {
    const appId = Number(req.params.id);
    const [appRow] = await db.select().from(dbApplications).where(eq(dbApplications.id, appId));
    if (!appRow) return res.json(await storage.getHttpErrorCategories(appId));

    const errors = await db.select().from(dbErrors)
      .where(eq(dbErrors.applicationId, appRow.externalId))
      .limit(200);
    const buckets = new Map<string, { count: number; trend: number }>();
    for (const e of errors) {
      const code = extractHttpCode(e.message) ?? "500";
      const trend = e.frequencyTrend === "up" ? 6 : e.frequencyTrend === "down" ? -3 : 0;
      const entry = buckets.get(code) ?? { count: 0, trend: 0 };
      entry.count += e.frequency ?? 1;
      entry.trend += trend;
      buckets.set(code, entry);
    }

    if (buckets.size === 0 && (appRow.errorRate ?? 0) > 0) {
      buckets.set("500", { count: Math.max(10, Math.round((appRow.errorRate ?? 1) * 40)), trend: 5 });
      buckets.set("502", { count: Math.max(5, Math.round((appRow.errorRate ?? 1) * 24)), trend: 2 });
      buckets.set("504", { count: Math.max(3, Math.round((appRow.errorRate ?? 1) * 12)), trend: 1 });
    }

    const total = [...buckets.values()].reduce((s, v) => s + v.count, 0) || 1;
    const result = [...buckets.entries()].map(([code, v]) => ({
      code,
      count: v.count,
      percentage: Math.round((v.count / total) * 100),
      trend: v.trend,
    }));

    return res.json(result.sort((a, b) => b.count - a.count).slice(0, 8));
  });

  app.get("/api/applications/:id/dependency-errors", async (req, res) => {
    const appId = Number(req.params.id);
    const [appRow] = await db.select().from(dbApplications).where(eq(dbApplications.id, appId));
    if (!appRow) return res.json(await storage.getDependencyErrors(appId));

    const errors = await db.select().from(dbErrors)
      .where(eq(dbErrors.applicationId, appRow.externalId))
      .limit(120);
    if (errors.length === 0) return res.json(await storage.getDependencyErrors(appId));

    const grouped = new Map<string, { count: number; sev: string; type?: string | null }>();
    for (const e of errors) {
      const key = e.service ?? e.cluster ?? "dependency";
      const g = grouped.get(key) ?? { count: 0, sev: e.severity ?? "Warning", type: e.errorType };
      g.count += e.frequency ?? 1;
      if ((e.severity ?? "") === "Critical") g.sev = "Critical";
      grouped.set(key, g);
    }

    const list = [...grouped.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 6)
      .map(([name, info]) => {
        const errorRate = clamp(Math.round(Math.log(info.count + 1) * 1.8), 0, 12);
        const latency = clamp(Math.round((appRow.avgResponseTime ?? 300) * (info.sev === "Critical" ? 1.8 : 1.2)), 80, 5000);
        return {
          name,
          type: info.type ?? "Dependency",
          status: info.sev === "Critical" ? "Degraded" : "Healthy",
          errorRate,
          latency,
        };
      });

    return res.json(list);
  });
  // === Servers ===
  app.get("/api/applications/:id/servers", async (req, res) => {
    const appId = Number(req.params.id);
    const [dbApp] = await db.select({
      externalId: dbApplications.externalId,
      credentialId: dbApplications.credentialId,
    }).from(dbApplications).where(eq(dbApplications.id, appId));
    if (dbApp?.externalId) {
      let fallbackCpu = 0;
      let fallbackMem = 0;
      if (dbApp.credentialId != null) {
        const [latestCpu] = await db.select({ value: dbMetrics.value }).from(dbMetrics)
          .where(and(
            eq(dbMetrics.entityType, "application"),
            eq(dbMetrics.entityId, dbApp.externalId),
            eq(dbMetrics.credentialId, dbApp.credentialId),
            eq(dbMetrics.metricName, "cpu_usage"),
          ))
          .orderBy(desc(dbMetrics.recordedAt))
          .limit(1);
        const [latestMem] = await db.select({ value: dbMetrics.value }).from(dbMetrics)
          .where(and(
            eq(dbMetrics.entityType, "application"),
            eq(dbMetrics.entityId, dbApp.externalId),
            eq(dbMetrics.credentialId, dbApp.credentialId),
            eq(dbMetrics.metricName, "memory_usage"),
          ))
          .orderBy(desc(dbMetrics.recordedAt))
          .limit(1);
        fallbackCpu = Number(latestCpu?.value ?? 0);
        fallbackMem = Number(latestMem?.value ?? 0);
      }
      const servers = await db.select().from(dbServers).where(eq(dbServers.applicationId, dbApp.externalId)).limit(50);
      if (servers.length > 0) return res.json(servers.map(s => ({
        id: s.id, name: s.name, tier: s.tier ?? "", ipAddress: s.ip ?? "", ip: s.ip ?? "",
        cpuUsage: (s.cpuUsage ?? 0) > 0 ? (s.cpuUsage ?? 0) : fallbackCpu,
        memoryUsage: (s.memoryUsage ?? 0) > 0 ? (s.memoryUsage ?? 0) : fallbackMem,
        diskUsage: s.diskUsage ?? 0,
        networkMbps: s.networkMbps ?? 0,
        status: s.status ?? "Healthy", source: s.source, lastSyncAt: s.lastSyncAt,
        alerts: s.alerts ?? 0,
      })));
    }
    return res.json([]);
  });
  app.get("/api/applications/:id/servers/:serverId", async (req, res) => {
    const [row] = await db.select().from(dbServers).where(eq(dbServers.id, Number(req.params.serverId)));
    if (!row) return res.status(404).json({ message: "Server not found" });
    return res.json(row);
  });

  // === Subscription ===
  app.get("/api/subscription", async (req, res) => { res.json(await storage.getSubscription()); });
  app.put("/api/subscription", async (req, res) => {
    const updated = await storage.updateSubscription(req.body);
    res.json(updated);
  });

  // === APM Sync & Credentials ===

  // Sync status overview
  app.get("/api/apm/sync/status", async (_req, res) => {
    try { res.json(await getSyncStatus()); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Trigger full sync (all sources)
  app.post("/api/apm/sync", async (_req, res) => {
    try {
      const result = await syncAll();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Trigger sync for one source
  app.post("/api/apm/sync/:source", async (req, res) => {
    const source = req.params.source as "appdynamics" | "dynatrace";
    if (!["appdynamics", "dynatrace"].includes(source)) {
      return res.status(400).json({ error: "source must be appdynamics or dynatrace" });
    }
    try {
      const result = await syncSource(source, req.body?.credentialId);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Discover AppDynamics metric paths and data availability (for Postman validation)
  app.post("/api/apm/metrics/discover", requireRole("Admin", "SRE"), async (req, res) => {
    const schema = z.object({
      appId: z.number().optional(),
      appName: z.string().optional(),
      credentialId: z.number().optional(),
      durationMins: z.number().optional(),
      metricPaths: z.array(z.string()).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body" });
    }

    const { appId, appName, credentialId, durationMins, metricPaths } = parsed.data;
    try {
      const user = req.user as import("@shared/schema").User;
      const orgData = await getUserOrg(user.id);
      if (!orgData) return res.status(404).json({ error: "Organization not found" });

      let resolvedAppId = appId;
      if (!resolvedAppId && appName) {
        const [row] = await db.select({ externalId: dbApplications.externalId })
          .from(dbApplications)
          .where(and(eq(dbApplications.name, appName), eq(dbApplications.source, "appdynamics")))
          .limit(1);
        if (row?.externalId) resolvedAppId = Number(row.externalId);
      }
      if (!resolvedAppId || Number.isNaN(resolvedAppId)) {
        return res.status(400).json({ error: "Provide appId or appName for AppDynamics app" });
      }

      const credWhere = credentialId
        ? and(eq(apmCredentials.id, credentialId), eq(apmCredentials.organizationId, orgData.org.id))
        : and(eq(apmCredentials.organizationId, orgData.org.id), eq(apmCredentials.source, "appdynamics"), eq(apmCredentials.isActive, true));
      const creds = await db.select().from(apmCredentials).where(credWhere).limit(1);
      const cred = creds[0];
      if (!cred) return res.status(404).json({ error: "Active AppDynamics credential not found" });

      const { AppDynamicsClient } = await import("./services/appDynamics");
      const client = new AppDynamicsClient({
        controllerUrl: cred.controllerUrl,
        account: cred.account ?? "",
        username: cred.username ?? "",
        password: decryptSecret(cred.passwordHash) ?? "",
      });

      const defaultPaths = [
        "Overall Application Performance|Calls per Minute",
        "Overall Application Performance|Average Response Time (ms)|Baseline",
        "Overall Application Performance|Average Response Time (ms)",
        "Overall Application Performance|Errors per Minute",
        "Application Infrastructure Performance|*|Individual Nodes|*|Hardware Resources|CPU|%Busy",
        "Application Infrastructure Performance|*|Individual Nodes|*|Hardware Resources|Memory|Used %",
        "Application Infrastructure Performance|*|Individual Nodes|*|JVM|Memory:Heap|Used (MB)",
        "Application Infrastructure Performance|*|Individual Nodes|*|JVM|Garbage Collection|GC Time Spent Per Minute (ms)",
        "Application Infrastructure Performance|*|Individual Nodes|*|JVM|Threads|Current No. of Threads",
        "Business Transaction Performance|Business Transactions|*|Average Response Time (ms)",
        "Backends|*|Average Response Time (ms)",
      ];
      const pathsToCheck = (metricPaths && metricPaths.length > 0) ? metricPaths : defaultPaths;
      const window = durationMins ?? 1440;

      const results = [];
      for (const p of pathsToCheck) {
        try {
          const series = await client.getMetricData(resolvedAppId, p, window);
          const values = (series ?? []).flatMap(s => s.metricValues ?? []);
          results.push({
            metricPath: p,
            seriesCount: series?.length ?? 0,
            pointCount: values.length,
            firstTs: values[0]?.startTimeInMillis ?? null,
            lastTs: values.at(-1)?.startTimeInMillis ?? null,
          });
        } catch (err: any) {
          results.push({ metricPath: p, error: err.message });
        }
      }

      res.json({
        appId: resolvedAppId,
        durationMins: window,
        checked: results,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Test a saved credential by ID (reads real password from DB)
  app.post("/api/apm/credentials/:id/test", requireRole("Admin", "SRE"), async (req, res) => {
    const credId = parseInt(req.params.id);
    if (isNaN(credId)) return res.status(400).json({ ok: false, message: "Invalid credential ID" });
    try {
      const user = req.user as import("@shared/schema").User;
      const orgData = await getUserOrg(user.id);
      if (!orgData) return res.status(404).json({ ok: false, message: "Organization not found" });

      const [cred] = await db
        .select()
        .from(apmCredentials)
        .where(and(eq(apmCredentials.id, credId), eq(apmCredentials.organizationId, orgData.org.id)));
      if (!cred) return res.status(404).json({ ok: false, message: "Credential not found" });
      if (cred.source === "appdynamics") {
        const { AppDynamicsClient } = await import("./services/appDynamics");
        const client = new AppDynamicsClient({
          controllerUrl: cred.controllerUrl,
          account: cred.account ?? "",
          username: cred.username ?? "",
          password: decryptSecret(cred.passwordHash) ?? "",
        });
        res.json(await client.testConnection());
      } else {
        const { DynatraceClient } = await import("./services/dynatrace");
        const client = new DynatraceClient({
          environmentUrl: cred.controllerUrl,
          apiToken: decryptSecret(cred.apiToken) ?? "",
        });
        res.json(await client.testConnection());
      }
    } catch (err: any) { res.status(500).json({ ok: false, message: err.message }); }
  });

  // Test connection to AppDynamics (for pre-save testing during add flow)
  app.post("/api/apm/test/appdynamics", requireAuth, async (req, res) => {
    const { controllerUrl, account, username, password } = req.body;
    if (!controllerUrl || !account || !username || !password) {
      return res.status(400).json({ ok: false, message: "controllerUrl, account, username, password required" });
    }
    const { AppDynamicsClient } = await import("./services/appDynamics");
    const client = new AppDynamicsClient({ controllerUrl, account, username, password });
    const result = await client.testConnection();
    res.json(result);
  });

  // Test connection to Dynatrace (for pre-save testing during add flow)
  app.post("/api/apm/test/dynatrace", requireAuth, async (req, res) => {
    const { environmentUrl, apiToken } = req.body;
    if (!environmentUrl || !apiToken) {
      return res.status(400).json({ ok: false, message: "environmentUrl and apiToken required" });
    }
    const { DynatraceClient } = await import("./services/dynatrace");
    const client = new DynatraceClient({ environmentUrl, apiToken });
    const result = await client.testConnection();
    res.json(result);
  });

  // List credentials
  app.get("/api/apm/credentials", requireRole("Admin", "SRE"), async (req, res) => {
    try {
      const user = req.user as import("@shared/schema").User;
      const orgData = await getUserOrg(user.id);
      if (!orgData) return res.status(404).json({ error: "Organization not found" });

      const creds = await db.select({
        id: apmCredentials.id,
        source: apmCredentials.source,
        label: apmCredentials.label,
        controllerUrl: apmCredentials.controllerUrl,
        account: apmCredentials.account,
        username: apmCredentials.username,
        isActive: apmCredentials.isActive,
        lastSyncAt: apmCredentials.lastSyncAt,
        createdAt: apmCredentials.createdAt,
      }).from(apmCredentials).where(eq(apmCredentials.organizationId, orgData.org.id));
      res.json(creds);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Add new credential
  app.post("/api/apm/credentials", requireRole("Admin", "SRE"), async (req, res) => {
    const { source, label, controllerUrl, account, username, password, apiToken, clientId, clientSecret } = req.body;
    if (!source || !controllerUrl) return res.status(400).json({ error: "source and controllerUrl required" });
    try {
      const user = req.user as import("@shared/schema").User;
      const orgData = await getUserOrg(user.id);
      if (!orgData) return res.status(404).json({ error: "Organization not found" });
      const organizationId = orgData.org.id;

      const [cred] = await db.insert(apmCredentials).values({
        source, label: label ?? "Default",
        controllerUrl, account, username,
        passwordHash: encryptSecret(password),
        apiToken: encryptSecret(apiToken),
        clientId,
        clientSecret: encryptSecret(clientSecret),
        organizationId,
      }).returning();
      res.status(201).json({ ...cred, passwordHash: undefined });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Delete credential
  app.delete("/api/apm/credentials/:id", requireRole("Admin", "SRE"), async (req, res) => {
    try {
      const credId = Number(req.params.id);
      if (!Number.isFinite(credId) || credId <= 0) {
        return res.status(400).json({ error: "Invalid credential id" });
      }

      const user = req.user as import("@shared/schema").User;
      const orgData = await getUserOrg(user.id);
      if (!orgData) return res.status(404).json({ error: "Organization not found" });

      const [cred] = await db
        .select({ id: apmCredentials.id, source: apmCredentials.source })
        .from(apmCredentials)
        .where(and(eq(apmCredentials.id, credId), eq(apmCredentials.organizationId, orgData.org.id)))
        .limit(1);
      if (!cred) return res.status(404).json({ error: "Credential not found" });

      const appsForCred = await db
        .select({ id: dbApplications.id, externalId: dbApplications.externalId })
        .from(dbApplications)
        .where(eq(dbApplications.credentialId, credId));
      const appIds = appsForCred.map(a => a.id);
      const externalIds = [...new Set(appsForCred.map(a => a.externalId))];

      await db.transaction(async (tx) => {
        if (appIds.length > 0) {
          await tx.delete(dbCapacityRisks).where(inArray(dbCapacityRisks.appId, appIds));
        }

        if (externalIds.length > 0) {
          await tx.delete(dbIncidents).where(and(
            eq(dbIncidents.source, cred.source),
            inArray(dbIncidents.applicationId, externalIds),
          ));
          await tx.delete(dbAlerts).where(and(
            eq(dbAlerts.source, cred.source),
            inArray(dbAlerts.applicationId, externalIds),
          ));
          await tx.delete(dbServers).where(and(
            eq(dbServers.source, cred.source),
            inArray(dbServers.applicationId, externalIds),
          ));
          await tx.delete(dbTransactions).where(and(
            eq(dbTransactions.source, cred.source),
            inArray(dbTransactions.applicationId, externalIds),
          ));
          await tx.delete(dbErrors).where(and(
            eq(dbErrors.source, cred.source),
            inArray(dbErrors.applicationId, externalIds),
          ));
        }

        await tx.delete(dbApplications).where(eq(dbApplications.credentialId, credId));
        await tx.delete(dbSyncLogs).where(eq(dbSyncLogs.credentialId, credId));
        await tx.delete(apmCredentials).where(and(
          eq(apmCredentials.id, credId),
          eq(apmCredentials.organizationId, orgData.org.id),
        ));

        if (externalIds.length > 0) {
          await tx.execute(sql`
            DELETE FROM apm_metrics m
            WHERE m.source = ${cred.source}
              AND m.credential_id = ${credId}
              AND m.entity_type = 'application'
              AND m.entity_id = ANY(ARRAY[${sql.join(externalIds.map(id => sql`${id}`), sql`, `)}]::text[])
              AND NOT EXISTS (
                SELECT 1
                FROM apm_applications a
                WHERE a.source = m.source
                  AND a.external_id = m.entity_id
                  AND a.credential_id = m.credential_id
              )
          `);
        }
      });

      res.json({
        success: true,
        credentialId: credId,
        deletedApplications: appIds.length,
      });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Get synced applications from DB
  app.get("/api/apm/applications", async (_req, res) => {
    try { res.json(await db.select().from(dbApplications).orderBy(dbApplications.name)); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Get synced incidents from DB
  app.get("/api/apm/incidents", async (req, res) => {
    try {
      const source = req.query.source as string | undefined;
      const query = db.select().from(dbIncidents).orderBy(desc(dbIncidents.startTime)).limit(100);
      res.json(await query);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Get synced alerts from DB
  app.get("/api/apm/alerts", async (_req, res) => {
    try { res.json(await db.select().from(dbAlerts).orderBy(desc(dbAlerts.triggeredAt)).limit(100)); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Get synced servers from DB
  app.get("/api/apm/servers", async (_req, res) => {
    try { res.json(await db.select().from(dbServers).orderBy(dbServers.name)); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Get recent sync logs
  app.get("/api/apm/sync/logs", async (_req, res) => {
    try { res.json(await db.select().from(dbSyncLogs).orderBy(desc(dbSyncLogs.startedAt)).limit(50)); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Environment variable credential status (no secrets exposed)
  app.get("/api/apm/env-status", async (_req, res) => {
    res.json({
      appDynamics: {
        configured: !!(process.env.APPDYNAMICS_URL && process.env.APPDYNAMICS_ACCOUNT && process.env.APPDYNAMICS_USERNAME && process.env.APPDYNAMICS_PASSWORD),
        url: process.env.APPDYNAMICS_URL ? process.env.APPDYNAMICS_URL.replace(/https?:\/\//, "").split(".")[0] + ".***" : null,
        account: process.env.APPDYNAMICS_ACCOUNT ?? null,
      },
      dynatrace: {
        configured: !!(process.env.DYNATRACE_URL && process.env.DYNATRACE_TOKEN),
        url: process.env.DYNATRACE_URL ? process.env.DYNATRACE_URL.replace(/https?:\/\//, "").split(".")[0] + ".***" : null,
        tokenPreview: process.env.DYNATRACE_TOKEN ? process.env.DYNATRACE_TOKEN.slice(0, 8) + "***" : null,
      },
    });
  });

  // === Sync Run Logs — protected, org-scoped ===
  // List recent sync run files for the authenticated user's organization.
  app.get("/api/admin/sync-runs", requireAuth, async (req, res) => {
    try {
      const user = req.user as any;
      const [membership] = await db.select().from(organizationMembers).where(eq(organizationMembers.userId, user.id));
      if (!membership) return res.json([]);
      const runs = listSyncRuns(membership.organizationId);
      return res.json(runs);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Download a specific sync run JSON file.
  // Strictly scoped: only the owning org can download its own files.
  app.get("/api/admin/sync-runs/:syncRunId/download", requireAuth, async (req, res) => {
    try {
      const user = req.user as any;
      const [membership] = await db.select().from(organizationMembers).where(eq(organizationMembers.userId, user.id));
      if (!membership) return res.status(403).json({ error: "No organization membership" });

      const filePath = getSyncRunFilePath(membership.organizationId, req.params.syncRunId);
      if (!filePath) return res.status(404).json({ error: "Sync run not found" });

      res.setHeader("Content-Type", "application/json");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="sync-run-${req.params.syncRunId}.json"`
      );
      fs.createReadStream(filePath).pipe(res);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  return httpServer;
}

