import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { db } from "./db";
import {
  apmCredentials, dbApplications, dbIncidents, dbAlerts, dbServers, dbSyncLogs,
  dbErrors, dbTransactions, dbCapacityRisks, incidentNotes,
  organizations, users, organizationMembers, invitations, ROLES,
} from "@shared/schema";
import { eq, desc, and, isNull, or, sql } from "drizzle-orm";
import { syncAll, syncSource, getSyncStatus } from "./services/syncService";
import { listSyncRuns, getSyncRunFilePath } from "./services/syncRunLogger";
import {
  runCausalPredictive, runRootCause, runCorrelationInsights,
  runRecommendations, runServiceRiskRanking, runCausalPredictiveFallback, getOrgCredIds,
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
import { createAppDynamicsClient } from "./services/appDynamics";
import { createDynatraceClient } from "./services/dynatrace";
import fs from "fs";
import passport from "passport";
import {
  requireAuth, requireRole, signupUser, createInvitation, acceptInvitation, getUserOrg, hashPassword,
  createEmailVerificationForUser, verifyEmailByToken, resendEmailVerification,
} from "./auth";
import { decryptSecret, encryptSecret } from "./services/credentialCrypto";
import { sendVerificationEmail } from "./services/email";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  const getPublicAppUrl = (req: any): string => {
    const envUrl = String(process.env.APP_URL ?? "").trim();
    if (envUrl) return envUrl.replace(/\/$/, "");
    const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
    const protocol = forwardedProto || req.protocol || "http";
    const host = req.get?.("host") || req.headers.host;
    if (!host) return "http://localhost:5000";
    return `${protocol}://${host}`.replace(/\/$/, "");
  };

  const safeEncrypt = (value?: string | null) => {
    try {
      return encryptSecret(value) ?? value ?? null;
    } catch {
      return value ?? null;
    }
  };

  // ══════════════════════════════════════════════════════════════
  // AUTH ROUTES (public — no auth required)
  // ══════════════════════════════════════════════════════════════

  app.post("/api/auth/signup", async (req, res) => {
    const { email, password, name, organizationName, inviteToken } = req.body;
    if (!email || !password || !name || !organizationName) {
      return res.status(400).json({ error: "email, password, name, and organizationName are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }
    try {
      let skipEmailVerification = false;
      if (inviteToken && typeof inviteToken === "string") {
        const [inv] = await db.select().from(invitations).where(eq(invitations.token, inviteToken));
        const normalizedEmail = String(email).trim().toLowerCase();
        if (
          inv &&
          !inv.acceptedAt &&
          inv.expiresAt > new Date() &&
          String(inv.email ?? "").toLowerCase() === normalizedEmail
        ) {
          skipEmailVerification = true;
        }
      }

      const { user, org, membership } = await signupUser(email, password, name, organizationName, { skipEmailVerification });
      const { passwordHash: _, ...publicUser } = user;

      if (skipEmailVerification) {
        req.login(user, (err) => {
          if (err) return res.status(500).json({ error: "Login after signup failed" });
          (req.session as any).currentOrgId = org.id;
          return res.status(201).json({ user: publicUser, organization: org, role: membership.role });
        });
        return;
      }

      const { token } = await createEmailVerificationForUser(user);
      const appUrl = getPublicAppUrl(req);
      const verificationUrl = `${appUrl}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
      const mailResult = await sendVerificationEmail({
        to: user.email,
        name: user.name ?? "",
        verificationUrl,
        appUrl,
      });

      return res.status(201).json({
        requiresEmailVerification: true,
        email: user.email,
        verificationEmailSent: mailResult.sent,
        ...(mailResult.sent ? {} : { verificationPreviewUrl: verificationUrl }),
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/auth/login", (req, res, next) => {
    passport.authenticate("local", (err: any, user: any, info: any) => {
      if (err) return res.status(500).json({ error: "Authentication error" });
      if (!user) return res.status(401).json({ error: info?.message ?? "Invalid credentials", code: info?.code });
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

  app.get("/api/auth/verify-email", async (req, res) => {
    const token = String(req.query.token ?? "");
    const result = await verifyEmailByToken(token);
    const appUrl = getPublicAppUrl(req);
    if (!result.ok) {
      const reason = result.reason === "expired" ? "Verification link expired." : "Invalid verification link.";
      return res.status(400).send(`
        <html><body style="font-family: Arial; padding: 24px;">
          <h2>Email verification failed</h2>
          <p>${reason}</p>
          <p><a href="${appUrl}/login">Go to Login</a></p>
        </body></html>
      `);
    }
    return res.redirect(302, `${appUrl}/login?verified=1`);
  });

  app.post("/api/auth/resend-verification", async (req, res) => {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "email is required" });

    const outcome = await resendEmailVerification(email);
    if (!outcome.token) {
      return res.json({ success: true });
    }
    const appUrl = getPublicAppUrl(req);
    const verificationUrl = `${appUrl}/api/auth/verify-email?token=${encodeURIComponent(outcome.token)}`;
    const sendResult = await sendVerificationEmail({ to: email, verificationUrl, appUrl });
    return res.json({
      success: true,
      verificationEmailSent: sendResult.sent,
      ...(sendResult.sent ? {} : { verificationPreviewUrl: verificationUrl }),
    });
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

  app.get(api.auth.status.path, async (_req, res) => {
    res.json({ connected: true, useMock: false });
  });

  // === Applications ===
  // Return org-scoped real data from DB if credentials exist; empty array otherwise
  async function resolveDbApp(idParam: string) {
    const numericId = Number(idParam);
    if (Number.isFinite(numericId)) {
      const [byId] = await db.select().from(dbApplications).where(eq(dbApplications.id, numericId));
      if (byId) return byId;
    }
    const [byExternal] = await db.select().from(dbApplications).where(eq(dbApplications.externalId, idParam));
    return byExternal ?? null;
  }

  function extractMetricFromMetadata(meta: any, patterns: RegExp[], maxDepth = 4): number | null {
    if (!meta || typeof meta !== "object") return null;
    const seen = new Set<any>();
    const queue: Array<{ key: string; value: any; depth: number }> = [{ key: "", value: meta, depth: 0 }];
    const candidates: number[] = [];

    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur.depth > maxDepth) continue;
      const { key, value, depth } = cur;
      const keyLc = key.toLowerCase();

      if (typeof value === "number" && Number.isFinite(value)) {
        if (patterns.some((p) => p.test(keyLc))) candidates.push(value);
        continue;
      }

      if (typeof value === "string") {
        const asNum = Number(value);
        if (Number.isFinite(asNum) && patterns.some((p) => p.test(keyLc))) candidates.push(asNum);
        continue;
      }

      if (!value || typeof value !== "object") continue;
      if (seen.has(value)) continue;
      seen.add(value);

      if (Array.isArray(value)) {
        for (const v of value) queue.push({ key, value: v, depth: depth + 1 });
      } else {
        for (const [k, v] of Object.entries(value)) queue.push({ key: k, value: v, depth: depth + 1 });
      }
    }

    if (candidates.length === 0) return null;
    const avg = candidates.reduce((s, v) => s + v, 0) / candidates.length;
    return Number.isFinite(avg) ? avg : null;
  }

  function normalizePercent(v: number | null, fallback = 0): number {
    if (v == null || !Number.isFinite(v)) return fallback;
    if (v <= 1) return Math.max(0, Math.min(100, v * 100));
    return Math.max(0, Math.min(100, v));
  }

  function latestMetricValue(values?: { startTimeInMillis: number; value: number; count: number }[]): number | null {
    if (!Array.isArray(values) || values.length === 0) return null;
    const sorted = [...values].sort((a, b) => Number(a?.startTimeInMillis ?? 0) - Number(b?.startTimeInMillis ?? 0));
    const last = sorted[sorted.length - 1];
    const v = Number(last?.value ?? NaN);
    return Number.isFinite(v) ? v : null;
  }

  function parseNodeNameFromMetricPath(metricPath?: string | null): string | null {
    if (!metricPath) return null;
    const parts = String(metricPath).split("|").map((p) => p.trim()).filter(Boolean);
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

  async function getLiveAppdNodeMetrics(
    appExternalId: string,
    credentialId: number | null | undefined,
  ): Promise<{ cpuByNode: Map<string, number>; memByNode: Map<string, number>; diskByNode: Map<string, number> } | null> {
    const appNum = Number(appExternalId);
    if (!Number.isFinite(appNum) || !Number.isFinite(Number(credentialId))) return null;

    const [cred] = await db.select().from(apmCredentials).where(eq(apmCredentials.id, Number(credentialId)));
    if (!cred || cred.source !== "appdynamics") return null;

    let resolvedPassword = String(cred.passwordHash ?? "");
    try {
      resolvedPassword = String(decryptSecret(cred.passwordHash) ?? resolvedPassword);
    } catch {
      resolvedPassword = String(cred.passwordHash ?? "");
    }

    const client = createAppDynamicsClient({
      controllerUrl: cred.controllerUrl,
      account: cred.account ?? "",
      username: cred.username ?? "",
      password: resolvedPassword,
    });
    if (!client) return null;

    const [cpuRows, memRows, diskRows] = await Promise.all([
      client.getMetrics(appNum, "Application Infrastructure Performance|*|Individual Nodes|*|Hardware Resources|CPU|*", 60).catch(() => []),
      client.getMetrics(appNum, "Application Infrastructure Performance|*|Individual Nodes|*|Hardware Resources|Memory|*", 60).catch(() => []),
      client.getMetrics(appNum, "Application Infrastructure Performance|*|Individual Nodes|*|Hardware Resources|Disks|*", 60).catch(() => []),
    ]);

    const pickMetricLabel = (metricPath?: string | null) => {
      const parts = String(metricPath ?? "").split("|").map((p) => p.trim()).filter(Boolean);
      return String(parts[parts.length - 1] ?? "").toLowerCase();
    };

    const buildCpuMap = (rows: Array<{ metricPath?: string | null; metricValues?: { startTimeInMillis: number; value: number; count: number }[] }>) => {
      const byNode = new Map<string, Record<string, number>>();
      for (const row of rows ?? []) {
        const nodeName = parseNodeNameFromMetricPath(row.metricPath);
        const key = canonicalNodeKey(nodeName);
        const val = latestMetricValue(row.metricValues);
        if (!key || val == null) continue;
        const label = pickMetricLabel(row.metricPath);
        const cur = byNode.get(key) ?? {};
        cur[label] = val;
        byNode.set(key, cur);
      }
      const out = new Map<string, number>();
      for (const [key, m] of byNode.entries()) {
        if (Number.isFinite(m["%busy"])) {
          out.set(key, m["%busy"]);
          continue;
        }
        if (Number.isFinite(m["user"]) && Number.isFinite(m["system"])) {
          out.set(key, Math.min(100, Math.max(0, m["user"] + m["system"])));
          continue;
        }
        const vals = Object.values(m).filter((v) => Number.isFinite(v));
        if (vals.length > 0) out.set(key, vals.reduce((s, v) => s + v, 0) / vals.length);
      }
      return out;
    };

    const buildMemoryMap = (rows: Array<{ metricPath?: string | null; metricValues?: { startTimeInMillis: number; value: number; count: number }[] }>) => {
      const byNode = new Map<string, Record<string, number>>();
      for (const row of rows ?? []) {
        const nodeName = parseNodeNameFromMetricPath(row.metricPath);
        const key = canonicalNodeKey(nodeName);
        const val = latestMetricValue(row.metricValues);
        if (!key || val == null) continue;
        const label = pickMetricLabel(row.metricPath);
        const cur = byNode.get(key) ?? {};
        cur[label] = val;
        byNode.set(key, cur);
      }
      const out = new Map<string, number>();
      for (const [key, m] of byNode.entries()) {
        if (Number.isFinite(m["used %"])) {
          out.set(key, m["used %"]);
          continue;
        }
        const total = Number(m["total (mb)"] ?? NaN);
        const free = Number(m["free (mb)"] ?? NaN);
        const avail = Number(m["available (mb)"] ?? NaN);
        if (Number.isFinite(total) && total > 0 && Number.isFinite(free)) {
          out.set(key, ((total - free) / total) * 100);
          continue;
        }
        if (Number.isFinite(total) && total > 0 && Number.isFinite(avail)) {
          out.set(key, ((total - avail) / total) * 100);
          continue;
        }
      }
      return out;
    };

    const buildDiskMap = (rows: Array<{ metricPath?: string | null; metricValues?: { startTimeInMillis: number; value: number; count: number }[] }>) => {
      const grouped = new Map<string, number[]>();
      for (const row of rows ?? []) {
        const metricPath = String(row.metricPath ?? "").toLowerCase();
        if (!metricPath.includes("used") || !metricPath.includes("%")) continue;
        const nodeName = parseNodeNameFromMetricPath(row.metricPath);
        const key = canonicalNodeKey(nodeName);
        const val = latestMetricValue(row.metricValues);
        if (!key || val == null) continue;
        const arr = grouped.get(key) ?? [];
        arr.push(val);
        grouped.set(key, arr);
      }
      const out = new Map<string, number>();
      for (const [k, vals] of grouped.entries()) {
        if (!vals.length) continue;
        out.set(k, vals.reduce((s, v) => s + v, 0) / vals.length);
      }
      return out;
    };

    return {
      cpuByNode: buildCpuMap(cpuRows as any[]),
      memByNode: buildMemoryMap(memRows as any[]),
      diskByNode: buildDiskMap(diskRows as any[]),
    };
  }

  async function getLiveAppdClient(
    appExternalId: string,
    credentialId: number | null | undefined,
  ) {
    const appNum = Number(appExternalId);
    if (!Number.isFinite(appNum) || !Number.isFinite(Number(credentialId))) return null;
    const [cred] = await db.select().from(apmCredentials).where(eq(apmCredentials.id, Number(credentialId)));
    if (!cred || cred.source !== "appdynamics") return null;
    let resolvedPassword = String(cred.passwordHash ?? "");
    try {
      resolvedPassword = String(decryptSecret(cred.passwordHash) ?? resolvedPassword);
    } catch {
      resolvedPassword = String(cred.passwordHash ?? "");
    }
    const client = createAppDynamicsClient({
      controllerUrl: cred.controllerUrl,
      account: cred.account ?? "",
      username: cred.username ?? "",
      password: resolvedPassword,
    });
    if (!client) return null;
    return { client, appNum };
  }

  function resolveServerUtilization(
    server: any,
    liveAppdMetrics?: { cpuByNode: Map<string, number>; memByNode: Map<string, number>; diskByNode: Map<string, number> } | null,
  ): { cpu: number | null; memory: number | null; disk: number | null; network: number } {
    const toPercentOrNull = (value: unknown): number | null => {
      const n = Number(value ?? NaN);
      if (!Number.isFinite(n)) return null;
      return normalizePercent(n, 0);
    };
    const nodeKeys = [
      canonicalNodeKey(server.name),
      canonicalNodeKey((server.metadata as any)?.machineName),
      canonicalNodeKey(server.ip),
    ].filter(Boolean);
    const pickLive = (m: Map<string, number> | undefined) => {
      if (!m) return null;
      for (const key of nodeKeys) {
        const v = m.get(key);
        if (v != null) return v;
      }
      return null;
    };

    const meta = server.metadata as any;
    const cpuMeta = extractMetricFromMetadata(meta, [/cpu/, /processor/, /usagepercent/]);
    const memMeta = extractMetricFromMetadata(meta, [/mem/, /memory/, /ram/]);
    const diskMeta = extractMetricFromMetadata(meta, [/disk/, /storage/, /filesystem/]);
    const netMeta = extractMetricFromMetadata(meta, [/network/, /throughput/, /mbps/, /bandwidth/]);

    // Keep the same precedence as Infrastructure API:
    // persisted server value -> metadata -> live provider value.
    const cpu = toPercentOrNull(server.cpuUsage ?? cpuMeta ?? pickLive(liveAppdMetrics?.cpuByNode));
    const memory = toPercentOrNull(server.memoryUsage ?? memMeta ?? pickLive(liveAppdMetrics?.memByNode));
    const disk = toPercentOrNull(server.diskUsage ?? diskMeta ?? pickLive(liveAppdMetrics?.diskByNode));
    const network = netMeta != null && Number.isFinite(netMeta) ? Math.max(0, netMeta) : Number(server.networkMbps ?? 0);
    return { cpu, memory, disk, network };
  }

  function extractProcessesFromMetadata(meta: any): Array<{ name: string; pid: number; cpu: number; memory: number; status: string; anomaly: boolean }> {
    if (!meta || typeof meta !== "object") return [];
    const candidates: any[] = [];

    const addFromArray = (arr: any[]) => {
      for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        const name = String(item.name ?? item.processName ?? item.command ?? item.cmd ?? "").trim();
        const pidNum = Number(item.pid ?? item.processId ?? item.id ?? NaN);
        const cpuRaw = Number(item.cpu ?? item.cpuUsage ?? item.cpuPercent ?? item.cpuPercentage ?? NaN);
        const memRaw = Number(item.memory ?? item.memoryMb ?? item.memoryMB ?? item.mem ?? item.rss ?? item.rssMb ?? NaN);
        if (!name && !Number.isFinite(pidNum)) continue;
        candidates.push({
          name: name || `process-${Number.isFinite(pidNum) ? pidNum : candidates.length + 1}`,
          pid: Number.isFinite(pidNum) ? Math.trunc(pidNum) : candidates.length + 1,
          cpu: Number.isFinite(cpuRaw) ? normalizePercent(cpuRaw, 0) : 0,
          memory: Number.isFinite(memRaw) ? Math.max(0, Math.round(memRaw)) : 0,
        });
      }
    };

    const keys = ["processes", "topProcesses", "processList", "runningProcesses", "procs"];
    for (const key of keys) {
      const v = meta?.[key];
      if (Array.isArray(v)) addFromArray(v);
    }

    if (candidates.length === 0) {
      const queue: any[] = [meta];
      const seen = new Set<any>();
      while (queue.length > 0) {
        const cur = queue.shift();
        if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
        seen.add(cur);
        if (Array.isArray(cur)) {
          if (cur.length && typeof cur[0] === "object") addFromArray(cur as any[]);
          for (const x of cur) queue.push(x);
          continue;
        }
        for (const v of Object.values(cur)) queue.push(v);
      }
    }

    const dedup = new Map<string, { name: string; pid: number; cpu: number; memory: number }>();
    for (const p of candidates) {
      const key = `${p.name}:${p.pid}`;
      if (!dedup.has(key)) dedup.set(key, p);
    }

    return Array.from(dedup.values())
      .sort((a, b) => (b.cpu + b.memory / 100) - (a.cpu + a.memory / 100))
      .slice(0, 25)
      .map((p) => ({
        ...p,
        status: "Running",
        anomaly: p.cpu >= 70 || p.memory >= 1500,
      }));
  }

  app.get(api.applications.list.path, async (req, res) => {
    const user = req.user as import("@shared/schema").User | undefined;
    const controllerIdRaw = req.query.controllerId != null ? Number(req.query.controllerId) : NaN;
    const hasControllerFilter = Number.isFinite(controllerIdRaw) && controllerIdRaw > 0;
    if (user) {
      const orgData = await getUserOrg(user.id);
      if (orgData) {
        const orgCreds = await db.select({ id: apmCredentials.id })
          .from(apmCredentials)
          .where(and(eq(apmCredentials.organizationId, orgData.org.id), eq(apmCredentials.isActive, true)));
        if (orgCreds.length === 0) return res.json([]);
        const orgCredIds = orgCreds.map(c => c.id);
        if (hasControllerFilter && !orgCredIds.includes(controllerIdRaw)) return res.json([]);
        const credIds = hasControllerFilter ? [controllerIdRaw] : orgCredIds;
        const apps = await db.select().from(dbApplications)
          .where(credIds.length === 1
            ? eq(dbApplications.credentialId, credIds[0])
            : sql`${dbApplications.credentialId} = ANY(ARRAY[${sql.join(credIds.map(id => sql`${id}`), sql`, `)}]::integer[])`)
          .orderBy(dbApplications.name);
        const appExternalIds = apps.map((a) => String(a.externalId)).filter(Boolean);
        const txAggRows = appExternalIds.length === 0
          ? []
          : await db
            .select({
              applicationId: dbTransactions.applicationId,
              totalCpm: sql<number>`COALESCE(SUM(${dbTransactions.callsPerMinute}), 0)`,
              avgResponseTime: sql<number>`COALESCE(SUM(CASE WHEN ${dbTransactions.avgResponseTime} > 0 AND ${dbTransactions.callsPerMinute} > 0 THEN ${dbTransactions.avgResponseTime} * ${dbTransactions.callsPerMinute} END) / NULLIF(SUM(CASE WHEN ${dbTransactions.callsPerMinute} > 0 THEN ${dbTransactions.callsPerMinute} END), 0), 0)`,
              avgErrorRate: sql<number>`COALESCE(AVG(${dbTransactions.errorRate}), 0)`,
            })
            .from(dbTransactions)
            .where(appExternalIds.length === 1
              ? eq(dbTransactions.applicationId, appExternalIds[0])
              : sql`${dbTransactions.applicationId} = ANY(ARRAY[${sql.join(appExternalIds.map(id => sql`${id}`), sql`, `)}]::text[])`)
            .groupBy(dbTransactions.applicationId);
        const txAggMap = new Map(
          txAggRows.map((r) => [
            String(r.applicationId),
            {
              totalCpm: Number(r.totalCpm ?? 0),
              avgResponseTime: Number(r.avgResponseTime ?? 0),
              avgErrorRate: Number(r.avgErrorRate ?? 0),
            },
          ]),
        );
        return res.json(apps.map(a => ({
          ...(txAggMap.get(String(a.externalId)) ?? {}),
          id: a.id,
          name: a.name,
          status: a.status,
          description: a.description ?? "",
          healthRuleViolations: a.healthRuleViolations ?? 0,
          source: a.source,
          credentialId: a.credentialId,
          externalId: a.externalId,
          hasMetrics: (
            (a.avgResponseTime ?? 0) > 0 ||
            (a.callsPerMinute ?? 0) > 0 ||
            (a.errorRate ?? 0) > 0 ||
            (txAggMap.get(String(a.externalId))?.avgResponseTime ?? 0) > 0 ||
            (txAggMap.get(String(a.externalId))?.totalCpm ?? 0) > 0 ||
            (txAggMap.get(String(a.externalId))?.avgErrorRate ?? 0) > 0
          ),
          // Prefer synced app-level KPIs from APM source; use BT aggregates only as fallback.
          avgResponseTime: (a.avgResponseTime ?? 0) > 0
            ? a.avgResponseTime
            : ((txAggMap.get(String(a.externalId))?.avgResponseTime ?? 0) > 0
              ? txAggMap.get(String(a.externalId))!.avgResponseTime
              : null),
          callsPerMinute: (a.callsPerMinute ?? 0) > 0
            ? a.callsPerMinute
            : ((txAggMap.get(String(a.externalId))?.totalCpm ?? 0) > 0
              ? txAggMap.get(String(a.externalId))!.totalCpm
              : null),
          errorRate: (a.errorRate ?? 0) > 0
            ? a.errorRate
            : ((txAggMap.get(String(a.externalId))?.avgErrorRate ?? 0) > 0
              ? txAggMap.get(String(a.externalId))!.avgErrorRate
              : null),
          lastSyncAt: a.lastSyncAt,
        })));
      }
    }
    return res.json([]);
  });
  app.get(api.applications.get.path, async (req, res) => {
    const numId = Number(req.params.id);
    // First try DB (real synced apps)
    const a = await resolveDbApp(req.params.id);
    if (a) {
      const [txAgg] = await db
        .select({
          totalCpm: sql<number>`COALESCE(SUM(${dbTransactions.callsPerMinute}), 0)`,
          avgResponseTime: sql<number>`COALESCE(SUM(CASE WHEN ${dbTransactions.avgResponseTime} > 0 AND ${dbTransactions.callsPerMinute} > 0 THEN ${dbTransactions.avgResponseTime} * ${dbTransactions.callsPerMinute} END) / NULLIF(SUM(CASE WHEN ${dbTransactions.callsPerMinute} > 0 THEN ${dbTransactions.callsPerMinute} END), 0), 0)`,
          avgErrorRate: sql<number>`COALESCE(AVG(${dbTransactions.errorRate}), 0)`,
        })
        .from(dbTransactions)
        .where(eq(dbTransactions.applicationId, String(a.externalId)));
      const totalCpm = Number(txAgg?.totalCpm ?? 0);
      const avgResp = Number(txAgg?.avgResponseTime ?? 0);
      const avgErr = Number(txAgg?.avgErrorRate ?? 0);
      return res.json({
        id: a.id,
        name: a.name,
        status: a.status,
        healthRuleViolations: a.healthRuleViolations ?? 0,
        description: a.description ?? "",
        tier: a.tier ?? "",
        externalId: a.externalId,
        source: a.source,
        // Prefer synced app-level KPIs from APM source; use BT aggregates only as fallback.
        callsPerMinute: Number(a.callsPerMinute ?? 0) > 0 ? Number(a.callsPerMinute ?? 0) : totalCpm,
        avgResponseTime: Number(a.avgResponseTime ?? 0) > 0 ? Number(a.avgResponseTime ?? 0) : avgResp,
        errorRate: Number(a.errorRate ?? 0) > 0 ? Number(a.errorRate ?? 0) : avgErr,
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
    const durationMinsRaw = Number(req.query.durationMins ?? NaN);
    const startQ = req.query.start ? Date.parse(String(req.query.start)) : NaN;
    const endQ = req.query.end ? Date.parse(String(req.query.end)) : NaN;
    const durationFromRange = Number.isFinite(startQ) && Number.isFinite(endQ) && endQ > startQ
      ? Math.max(1, Math.round((endQ - startQ) / 60_000))
      : NaN;
    const durationMins = Number.isFinite(durationMinsRaw) && durationMinsRaw > 0
      ? durationMinsRaw
      : (Number.isFinite(durationFromRange) ? durationFromRange : 24 * 60);
    // Check if this is a real DB app; if so, return real BT data
    const dbApp = await resolveDbApp(req.params.id);
    if (dbApp?.externalId) {
      const externalId = dbApp.externalId;
      const pct = (num: number, den: number) => {
        if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return 0;
        const v = (num / den) * 100;
        return Math.max(0, v);
      };
      const fetchLiveAppdTransactions = async (client: ReturnType<typeof createAppDynamicsClient>, appExternalNum: number, duration: number) => {
        if (!client) return [] as any[];
        const [btMeta, rtRows, cpmRows, epmRows, slowRows, verySlowRows] = await Promise.all([
          client.getBusinessTransactions(appExternalNum, duration),
          client.getMetrics(appExternalNum, "Business Transaction Performance|Business Transactions|*|*|Average Response Time (ms)", duration),
          client.getMetrics(appExternalNum, "Business Transaction Performance|Business Transactions|*|*|Calls per Minute", duration),
          client.getMetrics(appExternalNum, "Business Transaction Performance|Business Transactions|*|*|Errors per Minute", duration),
          client.getMetrics(appExternalNum, "Business Transaction Performance|Business Transactions|*|*|Number of Slow Calls", duration),
          client.getMetrics(appExternalNum, "Business Transaction Performance|Business Transactions|*|*|Number of Very Slow Calls", duration),
        ]);

        const keyOfMeta = (tier: string, name: string) => `${tier}||${name}`.toLowerCase();
        const keyOfPath = (metricPath: string | null | undefined) => {
          const parts = String(metricPath ?? "").split("|");
          if (parts.length < 5) return null;
          const tier = parts[2] ?? "";
          const btName = parts.slice(3, parts.length - 1).join("|");
          if (!tier || !btName) return null;
          return keyOfMeta(tier, btName);
        };
        const btIdFromMetricName = (metricName: string | null | undefined) => {
          const m = String(metricName ?? "").match(/BT:(\d+)/i);
          if (!m) return null;
          const id = Number(m[1]);
          return Number.isFinite(id) ? id : null;
        };
        const metricWindowValue = (row: any) => {
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
          // Prefer a non-zero signal from either field; AppDynamics semantics vary by metric/window.
          if (Number.isFinite(current) && current > 0) return current;
          if (Number.isFinite(value) && value > 0) return value;
          if (duration <= 60 && Number.isFinite(current)) return current;
          if (Number.isFinite(value)) return value;
          if (Number.isFinite(current)) return current;
          return null;
        };

        const metricById = new Map<number, {
          rt?: number; cpm?: number; epm?: number; slow?: number; verySlow?: number;
          cpmSum?: number; epmSum?: number; slowSum?: number; verySlowSum?: number;
        }>();
        const metricByKey = new Map<string, {
          rt?: number; cpm?: number; epm?: number; slow?: number; verySlow?: number;
          cpmSum?: number; epmSum?: number; slowSum?: number; verySlowSum?: number;
        }>();
        const upsert = (rows: any[], field: "rt" | "cpm" | "epm" | "slow" | "verySlow") => {
          for (const row of rows ?? []) {
            const key = keyOfPath(row?.metricPath);
            const btId = btIdFromMetricName(row?.metricName);
            if (!key && btId == null) continue;
            const vals = Array.isArray(row?.metricValues) ? [...row.metricValues] : [];
            const v = metricWindowValue(row);
            if (v == null) continue;
            const totalSum = vals.reduce((s: number, p: any) => {
              const n = Number(p?.sum ?? NaN);
              return s + (Number.isFinite(n) ? n : 0);
            }, 0);
            const sumField = field === "cpm"
              ? "cpmSum"
              : field === "epm"
                ? "epmSum"
                : field === "slow"
                  ? "slowSum"
                  : field === "verySlow"
                    ? "verySlowSum"
                    : null;
            if (key) {
              const curKey = metricByKey.get(key) ?? {};
              curKey[field] = v;
              if (sumField && totalSum > 0) (curKey as any)[sumField] = totalSum;
              metricByKey.set(key, curKey);
            }
            if (btId != null) {
              const curId = metricById.get(btId) ?? {};
              curId[field] = v;
              if (sumField && totalSum > 0) (curId as any)[sumField] = totalSum;
              metricById.set(btId, curId);
            }
          }
        };
        upsert(rtRows as any[], "rt");
        upsert(cpmRows as any[], "cpm");
        upsert(epmRows as any[], "epm");
        upsert(slowRows as any[], "slow");
        upsert(verySlowRows as any[], "verySlow");

        return (btMeta ?? []).map((bt: any) => {
          const key = keyOfMeta(String(bt.tierName ?? ""), String(bt.name ?? ""));
          const btId = Number(bt.id ?? NaN);
          const m = (Number.isFinite(btId) ? metricById.get(btId) : undefined) ?? metricByKey.get(key) ?? {};
          const calls = Number(m.cpm ?? bt.callsPerMinute ?? 0);
          const errors = Number(m.epm ?? bt.errorsPerMinute ?? 0);
          const avgRt = Number(m.rt ?? bt.averageResponseTime ?? 0);
          const slowCalls = Number(m.slow ?? 0);
          const verySlowCalls = Number(m.verySlow ?? 0);
          const slowPct = Number(m.slowSum ?? 0) > 0 && Number(m.cpmSum ?? 0) > 0
            ? pct(Number(m.slowSum ?? 0), Number(m.cpmSum ?? 0))
            : pct(slowCalls, calls);
          const verySlowPct = Number(m.verySlowSum ?? 0) > 0 && Number(m.cpmSum ?? 0) > 0
            ? pct(Number(m.verySlowSum ?? 0), Number(m.cpmSum ?? 0))
            : pct(verySlowCalls, calls);
          return {
            id: Number(bt.id),
            externalId: String(bt.id),
            name: bt.name,
            tier: bt.tierName ?? "",
            avgResponseTime: avgRt,
            callsPerMinute: calls,
            errorsPerMinute: errors,
            slowCalls,
            verySlowCalls,
            slowTransactionPercent: slowPct,
            verySlowTransactionPercent: verySlowPct,
            errorRate: Number(m.epmSum ?? 0) > 0 && Number(m.cpmSum ?? 0) > 0
              ? pct(Number(m.epmSum ?? 0), Number(m.cpmSum ?? 0))
              : pct(errors, calls),
            status: errors > 5 ? "Critical" : errors > 1 ? "Warning" : "Normal",
          };
        });
      };

      // Prefer live AppDynamics BT snapshot + metric-data when available for accuracy.
      if (dbApp.source === "appdynamics" && dbApp.credentialId != null) {
        try {
          const [cred] = await db.select().from(apmCredentials).where(eq(apmCredentials.id, dbApp.credentialId));
          if (cred) {
            let resolvedPassword = String(cred.passwordHash ?? "");
            try {
              resolvedPassword = String(decryptSecret(cred.passwordHash) ?? resolvedPassword);
            } catch {
              resolvedPassword = String(cred.passwordHash ?? "");
            }
            const client = createAppDynamicsClient({
              controllerUrl: cred.controllerUrl,
              account: cred.account ?? "",
              username: cred.username ?? "",
              password: resolvedPassword,
            });
            const appExternalNum = Number(externalId);
            if (client && Number.isFinite(appExternalNum)) {
              const mapped = await fetchLiveAppdTransactions(client, appExternalNum, durationMins);
              if (mapped.length > 0) {
                mapped.sort((a, b) => Number(b.avgResponseTime ?? 0) - Number(a.avgResponseTime ?? 0));
                // Match AppDynamics list behavior: show BTs with data in selected time window.
                const withData = mapped.filter((t) =>
                  Number(t.avgResponseTime ?? 0) > 0 ||
                  Number(t.callsPerMinute ?? 0) > 0 ||
                  Number(t.errorsPerMinute ?? 0) > 0 ||
                  Number(t.slowCalls ?? 0) > 0 ||
                  Number(t.verySlowCalls ?? 0) > 0
                );
                return res.json(withData);
              }
            }
          }
        } catch (_) {
          // Fall through to DB-backed BT snapshot.
        }
      }

      const bts = await db.select().from(dbTransactions)
        .where(eq(dbTransactions.applicationId, externalId))
        .orderBy(desc(dbTransactions.avgResponseTime))
        .limit(200);
      if (bts.length > 0) {
        const mapped = bts.map((bt, i) => {
          const calls = Number(bt.callsPerMinute ?? 0);
          const errPerMinFromMeta = Number((bt.metadata as any)?.errorsPerMinute ?? NaN);
          const errPctFallback = Number(bt.errorRate ?? 0);
          const errPerMin = Number.isFinite(errPerMinFromMeta)
            ? errPerMinFromMeta
            : (calls > 0 ? (calls * errPctFallback) / 100 : 0);
          const slowCalls = Number((bt.metadata as any)?.slowCalls ?? 0);
          const verySlowCalls = Number((bt.metadata as any)?.verySlowCalls ?? 0);
          const externalNumericId = Number(bt.externalId ?? NaN);
          return {
            id: Number.isFinite(externalNumericId) ? externalNumericId : (bt.id ?? (numId * 100 + i)),
            externalId: bt.externalId ?? null,
            name: bt.name,
            tier: bt.tier ?? "",
            avgResponseTime: bt.avgResponseTime ?? 0,
            callsPerMinute: bt.callsPerMinute ?? 0,
            errorsPerMinute: errPerMin,
            slowCalls,
            verySlowCalls,
            slowTransactionPercent: pct(slowCalls, calls),
            verySlowTransactionPercent: pct(verySlowCalls, calls),
            errorRate: pct(errPerMin, calls),
            status: bt.status ?? "Normal",
          };
        });
        // DB fallback: still restrict to rows that have data to avoid blank BT rows.
        return res.json(mapped.filter((t) =>
          Number(t.avgResponseTime ?? 0) > 0 ||
          Number(t.callsPerMinute ?? 0) > 0 ||
          Number(t.errorsPerMinute ?? 0) > 0 ||
          Number(t.slowCalls ?? 0) > 0 ||
          Number(t.verySlowCalls ?? 0) > 0
        ));
      }
    }
    res.json(await storage.getBusinessTransactions(numId));
  });
  app.get("/api/applications/:id/transactions/:txId", async (req, res) => {
    const appId = Number(req.params.id);
    const txIdRaw = String(req.params.txId ?? "").trim();
    const txIdNum = Number(txIdRaw);
    const durationMinsRaw = Number(req.query.durationMins ?? NaN);
    const startQ = req.query.start ? Date.parse(String(req.query.start)) : NaN;
    const endQ = req.query.end ? Date.parse(String(req.query.end)) : NaN;
    const durationFromRange = Number.isFinite(startQ) && Number.isFinite(endQ) && endQ > startQ
      ? Math.max(1, Math.round((endQ - startQ) / 60_000))
      : NaN;
    const durationMins = Number.isFinite(durationMinsRaw) && durationMinsRaw > 0
      ? durationMinsRaw
      : (Number.isFinite(durationFromRange) ? durationFromRange : 24 * 60);
    const dbApp = await resolveDbApp(req.params.id);

    if (dbApp?.externalId) {
      const pct = (num: number, den: number) => {
        if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return 0;
        const v = (num / den) * 100;
        return Math.max(0, v);
      };
      // Prefer live AppDynamics transaction details when available.
      if (dbApp.source === "appdynamics" && dbApp.credentialId != null) {
        try {
          const [cred] = await db.select().from(apmCredentials).where(eq(apmCredentials.id, dbApp.credentialId));
          if (cred) {
            let resolvedPassword = String(cred.passwordHash ?? "");
            try {
              resolvedPassword = String(decryptSecret(cred.passwordHash) ?? resolvedPassword);
            } catch {
              resolvedPassword = String(cred.passwordHash ?? "");
            }
            const client = createAppDynamicsClient({
              controllerUrl: cred.controllerUrl,
              account: cred.account ?? "",
              username: cred.username ?? "",
              password: resolvedPassword,
            });
            const appExternalNum = Number(dbApp.externalId);
            if (client && Number.isFinite(appExternalNum)) {
              const [live, rtRows, cpmRows, epmRows, slowRows, verySlowRows] = await Promise.all([
                client.getBusinessTransactions(appExternalNum, durationMins),
                client.getMetrics(appExternalNum, "Business Transaction Performance|Business Transactions|*|*|Average Response Time (ms)", durationMins),
                client.getMetrics(appExternalNum, "Business Transaction Performance|Business Transactions|*|*|Calls per Minute", durationMins),
                client.getMetrics(appExternalNum, "Business Transaction Performance|Business Transactions|*|*|Errors per Minute", durationMins),
                client.getMetrics(appExternalNum, "Business Transaction Performance|Business Transactions|*|*|Number of Slow Calls", durationMins),
                client.getMetrics(appExternalNum, "Business Transaction Performance|Business Transactions|*|*|Number of Very Slow Calls", durationMins),
              ]);
              const match = (live ?? []).find((bt: any) => String(bt.id) === txIdRaw || (Number.isFinite(txIdNum) && bt.id === txIdNum));
              if (match) {
                const btIdFromMetricName = (metricName: string | null | undefined) => {
                  const m = String(metricName ?? "").match(/BT:(\d+)/i);
                  if (!m) return null;
                  const id = Number(m[1]);
                  return Number.isFinite(id) ? id : null;
                };
                const key = `${String(match.tierName ?? "").toLowerCase()}||${String(match.name ?? "").toLowerCase()}`;
                const extractByKey = (rows: any[]) => {
                  const matchId = Number(match.id ?? NaN);
                  let found = (rows ?? []).find((r) => {
                    const id = btIdFromMetricName(r?.metricName);
                    return id != null && Number.isFinite(matchId) && id === matchId;
                  });
                  if (!found) found = (rows ?? []).find((r) => {
                    const parts = String(r?.metricPath ?? "").split("|");
                    if (parts.length < 5) return false;
                    const tier = String(parts[2] ?? "").toLowerCase();
                    const btName = String(parts.slice(3, parts.length - 1).join("|") ?? "").toLowerCase();
                    return `${tier}||${btName}` === key;
                  });
                  if (!found) return null;
                  if (String(found?.metricName ?? "").toUpperCase().includes("METRIC DATA NOT FOUND")) return null;
                  const vals = Array.isArray(found?.metricValues) ? [...found.metricValues] : [];
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
                  const totalSum = vals.reduce((s: number, p: any) => {
                    const n = Number(p?.sum ?? NaN);
                    return s + (Number.isFinite(n) ? n : 0);
                  }, 0);
                  if (Number.isFinite(current) && current > 0) return current;
                  if (Number.isFinite(value) && value > 0) return value;
                  if (durationMins <= 60 && Number.isFinite(current)) return current;
                  if (Number.isFinite(value)) return value;
                  if (Number.isFinite(current)) return current;
                  return totalSum > 0 ? totalSum : null;
                };
                const extractSumByKey = (rows: any[]) => {
                  const matchId = Number(match.id ?? NaN);
                  let found = (rows ?? []).find((r) => {
                    const id = btIdFromMetricName(r?.metricName);
                    return id != null && Number.isFinite(matchId) && id === matchId;
                  });
                  if (!found) found = (rows ?? []).find((r) => {
                    const parts = String(r?.metricPath ?? "").split("|");
                    if (parts.length < 5) return false;
                    const tier = String(parts[2] ?? "").toLowerCase();
                    const btName = String(parts.slice(3, parts.length - 1).join("|") ?? "").toLowerCase();
                    return `${tier}||${btName}` === key;
                  });
                  if (!found) return null;
                  if (String(found?.metricName ?? "").toUpperCase().includes("METRIC DATA NOT FOUND")) return null;
                  const vals = Array.isArray(found?.metricValues) ? found.metricValues : [];
                  if (vals.length === 0) return null;
                  const totalSum = vals.reduce((s: number, p: any) => {
                    const n = Number(p?.sum ?? NaN);
                    return s + (Number.isFinite(n) ? n : 0);
                  }, 0);
                  return totalSum > 0 ? totalSum : null;
                };
                const calls = Number(extractByKey(cpmRows as any[]) ?? match.callsPerMinute ?? 0);
                const errors = Number(extractByKey(epmRows as any[]) ?? match.errorsPerMinute ?? 0);
                const avgRt = Number(extractByKey(rtRows as any[]) ?? match.averageResponseTime ?? 0);
                const slowCalls = Number(extractByKey(slowRows as any[]) ?? 0);
                const verySlowCalls = Number(extractByKey(verySlowRows as any[]) ?? 0);
                const cpmSum = Number(extractSumByKey(cpmRows as any[]) ?? 0);
                const epmSum = Number(extractSumByKey(epmRows as any[]) ?? 0);
                const slowSum = Number(extractSumByKey(slowRows as any[]) ?? 0);
                const verySlowSum = Number(extractSumByKey(verySlowRows as any[]) ?? 0);
                const slowPct = slowSum > 0 && cpmSum > 0 ? pct(slowSum, cpmSum) : pct(slowCalls, calls);
                const verySlowPct = verySlowSum > 0 && cpmSum > 0 ? pct(verySlowSum, cpmSum) : pct(verySlowCalls, calls);
                return res.json({
                  id: Number(match.id),
                  externalId: String(match.id),
                  name: match.name,
                  tier: match.tierName ?? "",
                  avgResponseTime: avgRt,
                  callsPerMinute: calls,
                  errorsPerMinute: errors,
                  slowCalls,
                  verySlowCalls,
                  slowTransactionPercent: slowPct,
                  verySlowTransactionPercent: verySlowPct,
                  errorRate: epmSum > 0 && cpmSum > 0 ? pct(epmSum, cpmSum) : pct(errors, calls),
                  status: errors > 5 ? "Critical" : errors > 1 ? "Warning" : "Normal",
                });
              }
            }
          }
        } catch (_) {
          // fall through to DB lookup
        }
      }

      const [bt] = await db.select().from(dbTransactions).where(and(
        eq(dbTransactions.applicationId, String(dbApp.externalId)),
        or(
          Number.isFinite(txIdNum) ? eq(dbTransactions.id, txIdNum) : sql`false`,
          eq(dbTransactions.externalId, txIdRaw),
        ),
      )).limit(1);

      if (bt) {
        const calls = Number(bt.callsPerMinute ?? 0);
        const errPerMinFromMeta = Number((bt.metadata as any)?.errorsPerMinute ?? NaN);
        const errPctFallback = Number(bt.errorRate ?? 0);
        const errPerMin = Number.isFinite(errPerMinFromMeta)
          ? errPerMinFromMeta
          : (calls > 0 ? (calls * errPctFallback) / 100 : 0);
        const slowCalls = Number((bt.metadata as any)?.slowCalls ?? 0);
        const verySlowCalls = Number((bt.metadata as any)?.verySlowCalls ?? 0);
        const externalNumericId = Number(bt.externalId ?? NaN);
        return res.json({
          id: Number.isFinite(externalNumericId) ? externalNumericId : (bt.id ?? appId * 100),
          externalId: bt.externalId ?? null,
          name: bt.name,
          tier: bt.tier ?? "",
          avgResponseTime: bt.avgResponseTime ?? 0,
          callsPerMinute: bt.callsPerMinute ?? 0,
          errorsPerMinute: errPerMin,
          slowCalls,
          verySlowCalls,
          slowTransactionPercent: pct(slowCalls, calls),
          verySlowTransactionPercent: pct(verySlowCalls, calls),
          errorRate: pct(errPerMin, calls),
          status: bt.status ?? "Normal",
        });
      }
    }

    const list = await storage.getBusinessTransactions(appId);
    const fallback = (list ?? []).find((t: any) => String(t.id) === txIdRaw);
    if (fallback) return res.json(fallback);
    return res.status(404).json({ message: "Transaction not found" });
  });
  app.get("/api/applications/:id/transactions/:txId/diagnostics", async (req, res) => {
    const txIdRaw = String(req.params.txId ?? "").trim();
    const txIdNum = Number(txIdRaw);
    const durationMinsRaw = Number(req.query.durationMins ?? NaN);
    const startQ = req.query.start ? Date.parse(String(req.query.start)) : NaN;
    const endQ = req.query.end ? Date.parse(String(req.query.end)) : NaN;
    const durationFromRange = Number.isFinite(startQ) && Number.isFinite(endQ) && endQ > startQ
      ? Math.max(1, Math.round((endQ - startQ) / 60_000))
      : NaN;
    const durationMins = Number.isFinite(durationMinsRaw) && durationMinsRaw > 0
      ? durationMinsRaw
      : (Number.isFinite(durationFromRange) ? durationFromRange : 24 * 60);

    const dbApp = await resolveDbApp(req.params.id);
    if (!dbApp?.externalId) {
      return res.status(404).json({ message: "Application not found" });
    }

    const pct = (num: number, den: number) => {
      if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return 0;
      return Math.max(0, (num / den) * 100);
    };
    const btIdFromMetricName = (metricName: string | null | undefined) => {
      const m = String(metricName ?? "").match(/BT:(\d+)/i);
      if (!m) return null;
      const id = Number(m[1]);
      return Number.isFinite(id) ? id : null;
    };
    const buildPoints = (row: any) => {
      const vals = Array.isArray(row?.metricValues) ? [...row.metricValues] : [];
      vals.sort((a: any, b: any) => Number(a?.startTimeInMillis ?? 0) - Number(b?.startTimeInMillis ?? 0));
      return vals.map((v: any) => {
        const current = Number(v?.current ?? NaN);
        const value = Number(v?.value ?? NaN);
        const sum = Number(v?.sum ?? NaN);
        const count = Number(v?.count ?? NaN);
        return {
          ts: Number(v?.startTimeInMillis ?? 0),
          current: Number.isFinite(current) ? current : 0,
          value: Number.isFinite(value) ? value : 0,
          sum: Number.isFinite(sum) ? sum : 0,
          count: Number.isFinite(count) ? count : 0,
          effective: Number.isFinite(current) ? current : (Number.isFinite(value) ? value : 0),
        };
      });
    };
    const sumOf = (points: any[]) => points.reduce((acc, p) => acc + Number(p?.sum ?? 0), 0);
    const latestEffective = (points: any[]) => {
      for (let i = points.length - 1; i >= 0; i--) {
        const n = Number(points[i]?.effective ?? NaN);
        if (Number.isFinite(n)) return n;
      }
      return 0;
    };

    // Live AppDynamics diagnostics (preferred for AppDynamics-backed apps)
    if (dbApp.source === "appdynamics" && dbApp.credentialId != null) {
      try {
        const [cred] = await db.select().from(apmCredentials).where(eq(apmCredentials.id, dbApp.credentialId));
        if (cred) {
          let resolvedPassword = String(cred.passwordHash ?? "");
          try {
            resolvedPassword = String(decryptSecret(cred.passwordHash) ?? resolvedPassword);
          } catch {
            resolvedPassword = String(cred.passwordHash ?? "");
          }
          const client = createAppDynamicsClient({
            controllerUrl: cred.controllerUrl,
            account: cred.account ?? "",
            username: cred.username ?? "",
            password: resolvedPassword,
          });
          const appExternalNum = Number(dbApp.externalId);
          if (client && Number.isFinite(appExternalNum)) {
            const [live, cpmRows, epmRows, slowRows, verySlowRows] = await Promise.all([
              client.getBusinessTransactions(appExternalNum, durationMins),
              client.getMetrics(appExternalNum, "Business Transaction Performance|Business Transactions|*|*|Calls per Minute", durationMins),
              client.getMetrics(appExternalNum, "Business Transaction Performance|Business Transactions|*|*|Errors per Minute", durationMins),
              client.getMetrics(appExternalNum, "Business Transaction Performance|Business Transactions|*|*|Number of Slow Calls", durationMins),
              client.getMetrics(appExternalNum, "Business Transaction Performance|Business Transactions|*|*|Number of Very Slow Calls", durationMins),
            ]);

            const match = (live ?? []).find((bt: any) => String(bt.id) === txIdRaw || (Number.isFinite(txIdNum) && bt.id === txIdNum));
            if (match) {
              const key = `${String(match.tierName ?? "").toLowerCase()}||${String(match.name ?? "").toLowerCase()}`;
              const findMetricRow = (rows: any[]) => {
                const matchId = Number(match.id ?? NaN);
                let found = (rows ?? []).find((r) => {
                  const id = btIdFromMetricName(r?.metricName);
                  return id != null && Number.isFinite(matchId) && id === matchId;
                });
                if (!found) found = (rows ?? []).find((r) => {
                  const parts = String(r?.metricPath ?? "").split("|");
                  if (parts.length < 5) return false;
                  const tier = String(parts[2] ?? "").toLowerCase();
                  const btName = String(parts.slice(3, parts.length - 1).join("|") ?? "").toLowerCase();
                  return `${tier}||${btName}` === key;
                });
                if (!found) return null;
                if (String(found?.metricName ?? "").toUpperCase().includes("METRIC DATA NOT FOUND")) return null;
                return found;
              };

              const cpmPoints = buildPoints(findMetricRow(cpmRows as any[]));
              const epmPoints = buildPoints(findMetricRow(epmRows as any[]));
              const slowPoints = buildPoints(findMetricRow(slowRows as any[]));
              const verySlowPoints = buildPoints(findMetricRow(verySlowRows as any[]));
              const cpmSum = sumOf(cpmPoints);
              const epmSum = sumOf(epmPoints);
              const slowSum = sumOf(slowPoints);
              const verySlowSum = sumOf(verySlowPoints);
              const cpmLatest = latestEffective(cpmPoints);
              const epmLatest = latestEffective(epmPoints);
              const slowLatest = latestEffective(slowPoints);
              const verySlowLatest = latestEffective(verySlowPoints);
              let snapshots: any[] = [];
              try {
                snapshots = await client.getRequestSnapshots(appExternalNum, Number(match.id), durationMins);
              } catch {
                snapshots = [];
              }
              const filteredSnapshots = (Array.isArray(snapshots) ? snapshots : []).filter((s: any) =>
                Number(s?.businessTransactionId ?? NaN) === Number(match.id)
              );
              const sortedSnapshots = (filteredSnapshots.length > 0 ? filteredSnapshots : (Array.isArray(snapshots) ? snapshots : []))
                .filter((s: any) =>
                  Boolean(s?.errorOccured) ||
                  (Array.isArray(s?.errorDetails) && s.errorDetails.length > 0) ||
                  String(s?.errorSummary ?? "").trim().length > 0 ||
                  String(s?.summary ?? "").toLowerCase().includes("[error]")
                )
                .sort((a: any, b: any) => Number(b?.localStartTime ?? b?.serverStartTime ?? 0) - Number(a?.localStartTime ?? a?.serverStartTime ?? 0))
                .slice(0, 80);

              const appErrors = await db.select().from(dbErrors)
                .where(eq(dbErrors.applicationId, String(dbApp.externalId)))
                .orderBy(desc(dbErrors.lastOccurrence))
                .limit(60);
              const txNeedle = String(match.name ?? "").toLowerCase();
              const txErrors = appErrors.filter((e: any) => {
                const hay = `${String(e.message ?? "")} ${String(e.cluster ?? "")} ${String(e.service ?? "")}`.toLowerCase();
                return txNeedle.length > 0 && hay.includes(txNeedle);
              });
              const chosenErrors = (txErrors.length > 0 ? txErrors : appErrors).slice(0, 20);

              return res.json({
                transaction: {
                  id: Number(match.id),
                  name: String(match.name ?? ""),
                  tier: String(match.tierName ?? ""),
                },
                summary: {
                  callsPerMinute: cpmLatest,
                  errorsPerMinute: epmLatest,
                  slowCalls: slowLatest,
                  verySlowCalls: verySlowLatest,
                  errorRate: cpmSum > 0 ? pct(epmSum, cpmSum) : pct(epmLatest, cpmLatest),
                  slowTransactionPercent: cpmSum > 0 ? pct(slowSum, cpmSum) : pct(slowLatest, cpmLatest),
                  verySlowTransactionPercent: cpmSum > 0 ? pct(verySlowSum, cpmSum) : pct(verySlowLatest, cpmLatest),
                },
                series: {
                  errorsPerMinute: epmPoints,
                  slowCalls: slowPoints,
                  verySlowCalls: verySlowPoints,
                  callsPerMinute: cpmPoints,
                },
                errorSamples: chosenErrors.map((e: any) => ({
                  id: e.id,
                  errorId: e.externalId,
                  cluster: e.cluster,
                  message: e.message,
                  type: e.errorType,
                  severity: e.severity,
                  status: e.status,
                  frequency: e.frequency,
                  lastOccurrence: e.lastOccurrence,
                  source: e.source,
                  details: {
                    summary: (e.metadata as any)?.summary ?? null,
                    subType: (e.metadata as any)?.subType ?? null,
                    triggeredEntity: (e.metadata as any)?.triggeredEntity ?? null,
                    affectedEntities: (e.metadata as any)?.affectedEntities ?? [],
                    properties: (e.metadata as any)?.properties ?? [],
                  },
                })),
                callSnapshots: sortedSnapshots.map((s: any) => ({
                  requestGUID: String(s?.requestGUID ?? ""),
                  localStartTime: Number(s?.localStartTime ?? s?.serverStartTime ?? 0),
                  durationMs: Number(s?.timeTakenInMilliSecs ?? 0),
                  url: String(s?.URL ?? ""),
                  summary: String(s?.summary ?? ""),
                  errorOccurred: Boolean(s?.errorOccured),
                  errorSummary: String(
                    s?.errorSummary ??
                    s?.summary ??
                    (Array.isArray(s?.errorDetails) && s.errorDetails.length > 0
                      ? String(s.errorDetails[0]?.value ?? s.errorDetails[0]?.name ?? "")
                      : "")
                  ),
                  hasDeepDiveData: Boolean(s?.hasDeepDiveData),
                  userExperience: String(s?.userExperience ?? ""),
                  httpParameters: Array.isArray(s?.httpParameters) ? s.httpParameters : [],
                  errorDetails: Array.isArray(s?.errorDetails) ? s.errorDetails : [],
                  transactionEvents: Array.isArray(s?.transactionEvents) ? s.transactionEvents : [],
                  stackTraces: Array.isArray(s?.stackTraces) ? s.stackTraces : [],
                })),
              });
            }
          }
        }
      } catch (_) {
        // Fall through to DB-backed diagnostics below.
      }
    }

    const [bt] = await db.select().from(dbTransactions).where(and(
      eq(dbTransactions.applicationId, String(dbApp.externalId)),
      or(
        Number.isFinite(txIdNum) ? eq(dbTransactions.id, txIdNum) : sql`false`,
        eq(dbTransactions.externalId, txIdRaw),
      ),
    )).limit(1);

    if (!bt) return res.status(404).json({ message: "Transaction not found" });

    const calls = Number(bt.callsPerMinute ?? 0);
    const errPerMin = Number((bt.metadata as any)?.errorsPerMinute ?? 0);
    const slowCalls = Number((bt.metadata as any)?.slowCalls ?? 0);
    const verySlowCalls = Number((bt.metadata as any)?.verySlowCalls ?? 0);
    const errors = await db.select().from(dbErrors)
      .where(eq(dbErrors.applicationId, String(dbApp.externalId)))
      .orderBy(desc(dbErrors.lastOccurrence))
      .limit(20);

    return res.json({
      transaction: {
        id: Number(bt.externalId ?? bt.id),
        name: bt.name,
        tier: bt.tier ?? "",
      },
      summary: {
        callsPerMinute: calls,
        errorsPerMinute: errPerMin,
        slowCalls,
        verySlowCalls,
        errorRate: pct(errPerMin, calls),
        slowTransactionPercent: pct(slowCalls, calls),
        verySlowTransactionPercent: pct(verySlowCalls, calls),
      },
      series: {
        errorsPerMinute: [],
        slowCalls: [],
        verySlowCalls: [],
        callsPerMinute: [],
      },
      errorSamples: errors.map((e: any) => ({
        id: e.id,
        errorId: e.externalId,
        cluster: e.cluster,
        message: e.message,
        type: e.errorType,
        severity: e.severity,
        status: e.status,
        frequency: e.frequency,
        lastOccurrence: e.lastOccurrence,
        source: e.source,
        details: {
          summary: (e.metadata as any)?.summary ?? null,
          subType: (e.metadata as any)?.subType ?? null,
          triggeredEntity: (e.metadata as any)?.triggeredEntity ?? null,
          affectedEntities: (e.metadata as any)?.affectedEntities ?? [],
          properties: (e.metadata as any)?.properties ?? [],
        },
      })),
      callSnapshots: [],
    });
  });
  app.get(api.applications.nodes.path, async (req, res) => {
    const numId = Number(req.params.id);
    // Check if this is a real DB app; if so, return real server data as nodes
    const dbApp = await resolveDbApp(req.params.id);
    if (dbApp?.externalId) {
      const externalId = dbApp.externalId;
      const servers = await db.select().from(dbServers)
        .where(eq(dbServers.applicationId, externalId))
        .limit(20);
      if (servers.length > 0) {
        return res.json(servers.map(s => ({
            id: s.id,
            name: s.name,
            tier: s.tier ?? "",
            cpuUsage: s.cpuUsage ?? 0,
            memoryUsage: s.memoryUsage ?? 0,
            status: s.status ?? "Healthy",
          })));
      }
    }
    res.json(await storage.getNodes(numId));
  });
  app.get(api.applications.metrics.path, async (req, res) => {
    const numId = Number(req.params.id);
    const metricName = String(req.query.metricName ?? "");
    const dbApp = await resolveDbApp(req.params.id);
    if (!dbApp?.externalId) return res.json(await storage.getMetrics(numId, metricName));

    const durationMins = Number(req.query.durationMins ?? 24 * 60);
    const startQ = req.query.start ? Date.parse(String(req.query.start)) : NaN;
    const endQ = req.query.end ? Date.parse(String(req.query.end)) : NaN;
    const endTs = Number.isFinite(endQ) ? endQ : Date.now();
    const startTs = Number.isFinite(startQ) ? startQ : (endTs - (Number.isFinite(durationMins) ? durationMins : 24 * 60) * 60_000);
    const requestedDurationMins = Number.isFinite(durationMins) && durationMins > 0 ? durationMins : 24 * 60;
    const effectiveDurationMins = Number.isFinite(startQ) && Number.isFinite(endQ) && endQ > startQ
      ? Math.max(1, Math.round((endQ - startQ) / 60_000))
      : requestedDurationMins;
    const points = Math.max(12, Math.min(48, Math.round((endTs - startTs) / 3_600_000)));
    const step = Math.max(60_000, Math.floor((endTs - startTs) / points));

    // For AppDynamics applications, prefer live metric series for selected window.
    if (dbApp.source === "appdynamics") {
      const externalNum = Number(dbApp.externalId);
      if (Number.isFinite(externalNum) && dbApp.credentialId != null) {
        const [cred] = await db.select().from(apmCredentials).where(eq(apmCredentials.id, dbApp.credentialId));
        if (cred) {
          let resolvedPassword = String(cred.passwordHash ?? "");
          try {
            resolvedPassword = String(decryptSecret(cred.passwordHash) ?? resolvedPassword);
          } catch {
            resolvedPassword = String(cred.passwordHash ?? "");
          }
          const client = createAppDynamicsClient({
            controllerUrl: cred.controllerUrl,
            account: cred.account ?? "",
            username: cred.username ?? "",
            password: resolvedPassword,
          });
          const key = metricName.toLowerCase();
          if (client && (key.includes("response time") || key.includes("calls per minute") || key.includes("error rate"))) {
            try {
              const aggregateByTimestamp = (rows: Array<{ metricValues?: { startTimeInMillis: number; value: number }[] }>) => {
                const byTs = new Map<number, number[]>();
                for (const row of rows ?? []) {
                  for (const p of row.metricValues ?? []) {
                    const ts = Number(p.startTimeInMillis ?? NaN);
                    const val = Number(p.value ?? NaN);
                    if (!Number.isFinite(ts) || !Number.isFinite(val)) continue;
                    const list = byTs.get(ts) ?? [];
                    list.push(val);
                    byTs.set(ts, list);
                  }
                }
                return Array.from(byTs.entries())
                  .map(([timestamp, vals]) => ({
                    timestamp,
                    value: vals.reduce((s, v) => s + v, 0) / Math.max(1, vals.length),
                  }))
                  .sort((a, b) => a.timestamp - b.timestamp);
              };

              if (key.includes("response time")) {
                const rows = await client.getResponseTimeMetrics(externalNum, effectiveDurationMins);
                const pointsOut = aggregateByTimestamp(rows).map((p) => ({ timestamp: p.timestamp, value: Number(p.value.toFixed(2)) }));
                if (pointsOut.length > 0) return res.json(pointsOut);
              } else if (key.includes("calls per minute")) {
                const rows = await client.getCallsPerMinuteMetrics(externalNum, effectiveDurationMins);
                const pointsOut = aggregateByTimestamp(rows).map((p) => ({ timestamp: p.timestamp, value: Number(p.value.toFixed(2)) }));
                if (pointsOut.length > 0) return res.json(pointsOut);
              } else if (key.includes("error rate")) {
                const [errorRows, callRows] = await Promise.all([
                  client.getErrorRateMetrics(externalNum, effectiveDurationMins),
                  client.getCallsPerMinuteMetrics(externalNum, effectiveDurationMins),
                ]);
                const errPts = aggregateByTimestamp(errorRows);
                const callMap = new Map(aggregateByTimestamp(callRows).map((p) => [p.timestamp, p.value]));
                const pointsOut = errPts.map((p) => {
                  const calls = Number(callMap.get(p.timestamp) ?? 0);
                  const errorPct = calls > 0 ? (p.value / calls) * 100 : 0;
                  return { timestamp: p.timestamp, value: Number(errorPct.toFixed(2)) };
                });
                if (pointsOut.length > 0) return res.json(pointsOut);
              }
            } catch (_) {
              // Fall back to computed synthetic series below when live metric call fails.
            }
          }
        }
      }
    }

    const [bts, servers] = await Promise.all([
      db.select().from(dbTransactions).where(eq(dbTransactions.applicationId, dbApp.externalId)).limit(100),
      db.select().from(dbServers).where(eq(dbServers.applicationId, dbApp.externalId)).limit(100),
    ]);

    const avg = (vals: number[]) => vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
    const btWeightedResp = (() => {
      const valid = bts
        .map((b) => ({ rt: Number(b.avgResponseTime ?? 0), cpm: Number(b.callsPerMinute ?? 0) }))
        .filter((x) => Number.isFinite(x.rt) && Number.isFinite(x.cpm) && x.rt > 0 && x.cpm > 0);
      const totalCalls = valid.reduce((s, x) => s + x.cpm, 0);
      if (totalCalls > 0) return valid.reduce((s, x) => s + (x.rt * x.cpm), 0) / totalCalls;
      return avg(bts.map((b) => Number(b.avgResponseTime ?? 0)).filter((v) => v > 0));
    })();
    const btCpm = bts.reduce((sum, b) => {
      const cpm = Number(b.callsPerMinute ?? 0);
      return sum + (Number.isFinite(cpm) && cpm > 0 ? cpm : 0);
    }, 0);
    const srvCpu = avg(servers.map((s) => Number(s.cpuUsage ?? 0)).filter((v) => v > 0));
    const srvMem = avg(servers.map((s) => Number(s.memoryUsage ?? 0)).filter((v) => v > 0));
    const threadBase = Math.max(20, Math.round(btCpm * 1.8));

    const key = metricName.toLowerCase();
    let base = 0;
    if (key.includes("baseline response")) base = (btWeightedResp || Number(dbApp.avgResponseTime ?? 350)) * 0.85;
    else if (key.includes("business transaction response")) base = btWeightedResp || Number(dbApp.avgResponseTime ?? 350);
    else if (key.includes("database response")) base = Math.max(10, (btWeightedResp || 300) * 0.42);
    else if (key.includes("response time")) base = btWeightedResp || Number(dbApp.avgResponseTime ?? 350);
    else if (key.includes("calls per minute")) base = btCpm || Number(dbApp.callsPerMinute ?? 10);
    else if (key.includes("cpu")) base = srvCpu || 45;
    else if (key.includes("memory")) base = srvMem || 55;
    else if (key.includes("jvm heap")) base = Math.max(128, (srvMem || 55) * 14);
    else if (key.includes("jvm gc")) base = Math.max(20, (srvCpu || 45) * 1.8);
    else if (key.includes("thread")) base = threadBase;
    else base = 50;

    const series = Array.from({ length: points }, (_, i) => {
      const ts = startTs + i * step;
      const wave = Math.sin((i + dbApp.id) * 0.55) * 0.08;
      const drift = Math.sin((i + dbApp.id) * 0.13) * 0.05;
      const value = Math.max(0, base * (1 + wave + drift));
      return { timestamp: ts, value: Number(value.toFixed(2)) };
    });
    return res.json(series);
  });
  app.get(api.applications.incidents.path, async (req, res) => {
    const numId = Number(req.params.id);
    // Check if this is a real DB app; if so, return real incident data
    const dbApp = await resolveDbApp(req.params.id);
    if (dbApp?.externalId) {
      const externalId = dbApp.externalId;
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
  app.get(api.applications.forecast.path, async (req, res) => {
    const numId = Number(req.params.id);
    const dbApp = await resolveDbApp(req.params.id);
    if (dbApp?.externalId) {
      const [txRows, servers] = await Promise.all([
        db.select().from(dbTransactions).where(eq(dbTransactions.applicationId, dbApp.externalId)).limit(150),
        db.select().from(dbServers).where(eq(dbServers.applicationId, dbApp.externalId)).limit(50),
      ]);

      const avg = (arr: number[]) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);
      const round2 = (n: number) => Math.round(n * 100) / 100;

      const responseCandidates = [
        Number(dbApp.avgResponseTime ?? NaN),
        avg(txRows.map((t) => Number(t.avgResponseTime ?? 0)).filter((v) => Number.isFinite(v) && v > 0)),
      ].filter((v) => Number.isFinite(v) && v > 0);
      const cpuCandidates = servers
        .map((s) => normalizePercent(s.cpuUsage ?? extractMetricFromMetadata(s.metadata, [/cpu/, /processor/, /usagepercent/])))
        .filter((v) => Number.isFinite(v) && v > 0);

      const baseResp = Number(responseCandidates[0] ?? 250);
      const baseCpu = Number(cpuCandidates.length > 0 ? avg(cpuCandidates) : 45);
      const reqPressure = avg(txRows.map((t) => Number(t.callsPerMinute ?? 0)).filter((v) => Number.isFinite(v) && v > 0));
      const growthBoost = Math.min(0.18, Math.max(0.02, reqPressure / 5000));

      const now = Date.now();
      const out = Array.from({ length: 7 }).map((_, i) => {
        const dayTs = now + i * 24 * 60 * 60 * 1000;
        const wave = Math.sin((i + dbApp.id) * 0.9) * 0.04;
        const trend = 1 + i * growthBoost + wave;
        const predictedResponseTime = Math.max(20, baseResp * trend);
        const predictedCpu = Math.max(1, Math.min(100, baseCpu * (1 + i * (growthBoost * 0.7) + wave)));
        const riskLevel = predictedCpu >= 85 || predictedResponseTime >= 1000
          ? "High"
          : predictedCpu >= 65 || predictedResponseTime >= 600
            ? "Medium"
            : "Low";
        return {
          timestamp: dayTs,
          predictedResponseTime: round2(predictedResponseTime),
          predictedCpu: round2(predictedCpu),
          riskLevel,
        };
      });

      return res.json(out);
    }

    const fallback = await storage.getForecast(numId);
    const normalized = (Array.isArray(fallback) ? fallback : []).map((f: any) => {
      const predictedCpu = Number(f?.predictedCpu ?? 0);
      const predictedResponseTime = Number(f?.predictedResponseTime ?? 0);
      const riskLevel = (f?.riskLevel === "Low" || f?.riskLevel === "Medium" || f?.riskLevel === "High")
        ? f.riskLevel
        : (predictedCpu >= 85 || predictedResponseTime >= 1000
            ? "High"
            : predictedCpu >= 65 || predictedResponseTime >= 600
              ? "Medium"
              : "Low");
      return {
        timestamp: Number(f?.timestamp ?? Date.now()),
        predictedResponseTime,
        predictedCpu,
        riskLevel,
      };
    });
    res.json(normalized);
  });
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
  app.get("/api/persona/business", async (req, res) => {
    const emptyPayload = {
      kpis: {
        orderVolume: 0,
        orderVolumeTrend: 0,
        revenue: 0,
        revenueTrend: 0,
        conversionRate: 0,
        conversionTrend: 0,
        slaHealth: 100,
        slaTrend: 0,
      },
      revenueAtRisk: 0,
      slaBreachProbability: 0,
      revenueHistory: [] as Array<{ timestamp: number; value: number }>,
      serviceHealthScores: [] as Array<{ service: string; score: number }>,
      riskHeatmap: [] as Array<{ tier: string; latency: number; errors: number; cpu: number; memory: number; appId: number | null }>,
      incidentBusinessImpact: [] as Array<{ incident: string; affectedUsers: number; duration: string; revenueImpact: number; incidentId?: string; alertId?: string }>,
    };

    try {
      const user = req.user as import("@shared/schema").User | undefined;
      if (!user) return res.json(emptyPayload);

      const orgData = await getUserOrg(user.id);
      if (!orgData) return res.json(emptyPayload);

      const orgCreds = await db.select({ id: apmCredentials.id })
        .from(apmCredentials)
        .where(and(eq(apmCredentials.organizationId, orgData.org.id), eq(apmCredentials.isActive, true)));
      if (orgCreds.length === 0) return res.json(emptyPayload);
      const credIds = orgCreds.map((c) => c.id);

      const apps = await db.select({
        id: dbApplications.id,
        externalId: dbApplications.externalId,
        name: dbApplications.name,
        tier: dbApplications.tier,
        status: dbApplications.status,
        healthRuleViolations: dbApplications.healthRuleViolations,
        avgResponseTime: dbApplications.avgResponseTime,
        errorRate: dbApplications.errorRate,
      }).from(dbApplications).where(credIds.length === 1
        ? eq(dbApplications.credentialId, credIds[0])
        : sql`${dbApplications.credentialId} = ANY(ARRAY[${sql.join(credIds.map((id) => sql`${id}`), sql`, `)}]::integer[])`);

      if (apps.length === 0) return res.json(emptyPayload);

      const appExternalIds = apps.map((a) => String(a.externalId)).filter(Boolean);
      const appWhere = appExternalIds.length === 1
        ? eq(dbTransactions.applicationId, appExternalIds[0])
        : sql`${dbTransactions.applicationId} = ANY(ARRAY[${sql.join(appExternalIds.map((id) => sql`${id}`), sql`, `)}]::text[])`;
      const serverWhere = appExternalIds.length === 1
        ? eq(dbServers.applicationId, appExternalIds[0])
        : sql`${dbServers.applicationId} = ANY(ARRAY[${sql.join(appExternalIds.map((id) => sql`${id}`), sql`, `)}]::text[])`;
      const incidentWhere = appExternalIds.length === 1
        ? eq(dbIncidents.applicationId, appExternalIds[0])
        : sql`${dbIncidents.applicationId} = ANY(ARRAY[${sql.join(appExternalIds.map((id) => sql`${id}`), sql`, `)}]::text[])`;
      const alertWhere = appExternalIds.length === 1
        ? eq(dbAlerts.applicationId, appExternalIds[0])
        : sql`${dbAlerts.applicationId} = ANY(ARRAY[${sql.join(appExternalIds.map((id) => sql`${id}`), sql`, `)}]::text[])`;

      const [txRows, servers, incidents, alerts] = await Promise.all([
        db.select().from(dbTransactions).where(appWhere).orderBy(desc(dbTransactions.updatedAt)).limit(1200),
        db.select().from(dbServers).where(serverWhere).orderBy(desc(dbServers.updatedAt)).limit(800),
        db.select().from(dbIncidents).where(incidentWhere).orderBy(desc(dbIncidents.startTime)).limit(400),
        db.select().from(dbAlerts).where(alertWhere).orderBy(desc(dbAlerts.triggeredAt)).limit(600),
      ]);

      const avg = (vals: number[]) => vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
      const sum = (vals: number[]) => vals.reduce((s, v) => s + v, 0);
      const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
      const round1 = (n: number) => Math.round(n * 10) / 10;
      const round2 = (n: number) => Math.round(n * 100) / 100;
      const toNum = (v: any, fallback = 0) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
      };
      const isOpenLike = (status: string | null | undefined) => {
        const s = String(status ?? "").toLowerCase();
        return s.includes("open") || s.includes("active") || s.includes("ongoing") || s.includes("critical");
      };

      const totalCallsPerMinute = sum(txRows.map((t) => Math.max(0, toNum(t.callsPerMinute, 0))));
      const avgErrorRate = clamp(avg(
        txRows.map((t) => toNum(t.errorRate, NaN)).filter((v) => Number.isFinite(v) && v >= 0)
      ) || avg(
        apps.map((a) => toNum(a.errorRate, NaN)).filter((v) => Number.isFinite(v) && v >= 0)
      ) || 0, 0, 100);
      const avgLatencyMs = clamp(avg(
        txRows.map((t) => toNum(t.avgResponseTime, NaN)).filter((v) => Number.isFinite(v) && v > 0)
      ) || avg(
        apps.map((a) => toNum(a.avgResponseTime, NaN)).filter((v) => Number.isFinite(v) && v > 0)
      ) || 0, 0, 30000);

      const healthyApps = apps.filter((a) => String(a.status ?? "").toLowerCase() === "healthy").length;
      const healthyRatio = healthyApps / Math.max(1, apps.length);
      const violationCount = sum(apps.map((a) => Math.max(0, toNum(a.healthRuleViolations, 0))));
      const openIncidents = incidents.filter((i) => isOpenLike(i.status)).length;
      const openAlerts = alerts.filter((a) => isOpenLike(a.status)).length;

      const conversionRate = round2(clamp(
        3.1 - (avgErrorRate * 0.08) - (avgLatencyMs / 3000) - (openIncidents * 0.07) + (healthyRatio * 1.5),
        0.2,
        8.5
      ));
      const avgOrderValue = clamp(58 - openIncidents * 1.2 - avgErrorRate * 0.35 + healthyRatio * 7, 20, 130);
      const orderVolume = Math.max(0, Math.round(totalCallsPerMinute * (1 - (avgErrorRate / 140))));
      const revenue = Math.max(0, Math.round(orderVolume * (conversionRate / 100) * avgOrderValue * 60));

      const slaHealth = round1(clamp(
        100
          - (avgErrorRate * 3.6)
          - (openIncidents * 3.2)
          - (openAlerts * 1.1)
          - (violationCount * 0.45)
          - (avgLatencyMs / 40),
        0,
        100
      ));
      const slaBreachProbability = round1(clamp(
        (100 - slaHealth) + (openIncidents * 1.8) + (openAlerts * 0.9) + (avgLatencyMs > 1000 ? 8 : 0),
        1,
        99
      ));
      const revenueAtRisk = Math.round(revenue * (slaBreachProbability / 100) * 0.42);

      const now = Date.now();
      const volatility = clamp(0.05 + openIncidents * 0.01 + openAlerts * 0.003, 0.04, 0.2);
      const growthBias = clamp((healthyRatio - 0.5) * 0.05, -0.02, 0.04);
      const revenueHistory = Array.from({ length: 24 }).map((_, i) => {
        const ts = now - (23 - i) * 60 * 60 * 1000;
        const wave = Math.sin((i + apps.length) * 0.62) * volatility;
        const drift = (i - 12) * (growthBias / 12);
        const value = Math.max(0, Math.round(revenue * (1 + wave + drift)));
        return { timestamp: ts, value };
      });

      const orderSeries = Array.from({ length: 24 }).map((_, i) => {
        const wave = Math.sin((i + txRows.length) * 0.58) * (volatility * 0.8);
        const drift = (i - 12) * (growthBias / 16);
        return Math.max(0, orderVolume * (1 + wave + drift));
      });
      const conversionSeries = Array.from({ length: 24 }).map((_, i) => {
        const wave = Math.cos((i + apps.length) * 0.47) * (volatility * 0.35);
        return clamp(conversionRate * (1 + wave), 0.1, 12);
      });
      const slaSeries = Array.from({ length: 24 }).map((_, i) => {
        const wave = Math.cos((i + openAlerts + 1) * 0.41) * (volatility * 26);
        return clamp(slaHealth + wave, 0, 100);
      });
      const avgSlice = (vals: number[], from: number, to: number) => avg(vals.slice(from, to));
      const pctTrend = (curr: number, prev: number, minBase = 1) => round1(((curr - prev) / Math.max(minBase, prev)) * 100);
      const orderVolumeTrend = pctTrend(avgSlice(orderSeries, 12, 24), avgSlice(orderSeries, 0, 12), 1);
      const revenueTrend = pctTrend(avg(revenueHistory.slice(12).map((p) => p.value)), avg(revenueHistory.slice(0, 12).map((p) => p.value)), 1);
      const conversionTrend = pctTrend(avgSlice(conversionSeries, 12, 24), avgSlice(conversionSeries, 0, 12), 0.1);
      const slaTrend = round1(avgSlice(slaSeries, 12, 24) - avgSlice(slaSeries, 0, 12));

      const appTxMap = new Map<string, typeof txRows>();
      for (const tx of txRows) {
        const k = String(tx.applicationId ?? "");
        const arr = appTxMap.get(k) ?? [];
        arr.push(tx);
        appTxMap.set(k, arr);
      }
      const serviceHealthScores = apps.map((a) => {
        const tx = appTxMap.get(String(a.externalId)) ?? [];
        const appErr = avg(tx.map((t) => toNum(t.errorRate, 0)).filter((v) => v >= 0)) || toNum(a.errorRate, 0);
        const appLatency = avg(tx.map((t) => toNum(t.avgResponseTime, 0)).filter((v) => v > 0)) || toNum(a.avgResponseTime, 0);
        const statusLc = String(a.status ?? "").toLowerCase();
        const statusPenalty = statusLc === "healthy" ? 0 : statusLc === "warning" ? 18 : 34;
        const score = Math.round(clamp(
          100 - statusPenalty - (toNum(a.healthRuleViolations, 0) * 2) - (appErr * 7) - (appLatency / 120),
          0,
          100
        ));
        return { service: a.name, score };
      }).sort((x, y) => y.score - x.score).slice(0, 10);

      const appByExternal = new Map(apps.map((a) => [String(a.externalId), a]));
      const tierMap = new Map<string, { lat: number[]; err: number[]; cpu: number[]; mem: number[] }>();
      const tierToAppId = new Map<string, number>();
      const ensureTier = (tierRaw: string | null | undefined) => {
        const tier = String(tierRaw ?? "").trim() || "Unassigned";
        if (!tierMap.has(tier)) tierMap.set(tier, { lat: [], err: [], cpu: [], mem: [] });
        return tier;
      };
      for (const a of apps) {
        const tier = ensureTier(a.tier);
        if (!tierToAppId.has(tier)) tierToAppId.set(tier, Number(a.id));
      }
      for (const t of txRows) {
        const tier = ensureTier(t.tier);
        tierMap.get(tier)!.lat.push(toNum(t.avgResponseTime, 0));
        tierMap.get(tier)!.err.push(toNum(t.errorRate, 0));
        if (!tierToAppId.has(tier)) {
          const app = appByExternal.get(String(t.applicationId ?? ""));
          if (app) tierToAppId.set(tier, Number(app.id));
        }
      }
      for (const s of servers) {
        const tier = ensureTier(s.tier);
        const cpu = normalizePercent(s.cpuUsage ?? extractMetricFromMetadata(s.metadata, [/cpu/, /processor/, /usagepercent/]), 0);
        const mem = normalizePercent(s.memoryUsage ?? extractMetricFromMetadata(s.metadata, [/mem/, /memory/, /ram/]), 0);
        tierMap.get(tier)!.cpu.push(cpu);
        tierMap.get(tier)!.mem.push(mem);
        if (!tierToAppId.has(tier)) {
          const app = appByExternal.get(String(s.applicationId ?? ""));
          if (app) tierToAppId.set(tier, Number(app.id));
        }
      }
      const riskHeatmap = Array.from(tierMap.entries()).map(([tier, stats]) => {
        const latRisk = Math.round(clamp(avg(stats.lat) / 25, 0, 100));
        const errRisk = Math.round(clamp(avg(stats.err) * 12, 0, 100));
        const cpuRisk = Math.round(clamp(avg(stats.cpu), 0, 100));
        const memRisk = Math.round(clamp(avg(stats.mem), 0, 100));
        return { tier, latency: latRisk, errors: errRisk, cpu: cpuRisk, memory: memRisk, appId: tierToAppId.get(tier) ?? null };
      }).sort((a, b) => Math.max(b.latency, b.errors, b.cpu, b.memory) - Math.max(a.latency, a.errors, a.cpu, a.memory)).slice(0, 10);

      const txCpmByApp = new Map<string, number>();
      for (const t of txRows) {
        const key = String(t.applicationId ?? "");
        txCpmByApp.set(key, (txCpmByApp.get(key) ?? 0) + Math.max(0, toNum(t.callsPerMinute, 0)));
      }
      const fmtDuration = (start: Date | null, end: Date | null) => {
        const s = start ? new Date(start).getTime() : Date.now();
        const e = end ? new Date(end).getTime() : Date.now();
        const mins = Math.max(1, Math.round((e - s) / 60000));
        const hrs = Math.floor(mins / 60);
        const rem = mins % 60;
        if (hrs <= 0) return `${rem}m`;
        return `${hrs}h ${rem}m`;
      };
      let incidentBusinessImpact = incidents.slice(0, 8).map((inc) => {
        const sev = String(inc.severity ?? "").toLowerCase();
        const sevMultiplier = sev.includes("critical") ? 1.45 : sev.includes("warning") ? 1.05 : 1.2;
        const appCpm = txCpmByApp.get(String(inc.applicationId ?? "")) ?? (totalCallsPerMinute / Math.max(1, apps.length));
        const affectedUsers = Math.max(20, Math.round(appCpm * 45 * sevMultiplier));
        const duration = fmtDuration(inc.startTime as any, inc.endTime as any);
        const revenueImpact = Math.max(250, Math.round(affectedUsers * (avgOrderValue * (conversionRate / 100)) * (sevMultiplier * 0.7)));
        return {
          incident: String(inc.title ?? "Service Incident"),
          affectedUsers,
          duration,
          revenueImpact,
          incidentId: String(inc.externalId ?? ""),
        };
      });

      if (incidentBusinessImpact.length === 0) {
        incidentBusinessImpact = alerts.slice(0, 6).map((a) => {
          const sev = String(a.severity ?? "").toLowerCase();
          const sevMultiplier = sev.includes("critical") ? 1.35 : 1.05;
          const appCpm = txCpmByApp.get(String(a.applicationId ?? "")) ?? (totalCallsPerMinute / Math.max(1, apps.length));
          const affectedUsers = Math.max(15, Math.round(appCpm * 30 * sevMultiplier));
          const revenueImpact = Math.max(120, Math.round(affectedUsers * (avgOrderValue * (conversionRate / 100)) * 0.45));
          return {
            incident: String(a.name ?? "Alert Triggered"),
            affectedUsers,
            duration: "Ongoing",
            revenueImpact,
            alertId: String(a.externalId ?? ""),
          };
        });
      }

      return res.json({
        kpis: {
          orderVolume,
          orderVolumeTrend,
          revenue,
          revenueTrend,
          conversionRate,
          conversionTrend,
          slaHealth: round1(slaHealth),
          slaTrend,
        },
        revenueAtRisk,
        slaBreachProbability,
        revenueHistory,
        serviceHealthScores,
        riskHeatmap,
        incidentBusinessImpact,
      });
    } catch {
      return res.json(emptyPayload);
    }
  });
  app.get("/api/persona/sre", async (req, res) => {
    try {
      const user = req.user as import("@shared/schema").User | undefined;
      if (!user) return res.json(await storage.getPersonaSre());
      const orgData = await getUserOrg(user.id);
      if (!orgData) return res.json(await storage.getPersonaSre());

      const orgCreds = await db.select({ id: apmCredentials.id })
        .from(apmCredentials)
        .where(and(eq(apmCredentials.organizationId, orgData.org.id), eq(apmCredentials.isActive, true)));
      if (orgCreds.length === 0) return res.json(await storage.getPersonaSre());
      const credIds = orgCreds.map((c) => c.id);

      const apps = await db.select({
        id: dbApplications.id,
        externalId: dbApplications.externalId,
        name: dbApplications.name,
        status: dbApplications.status,
        healthRuleViolations: dbApplications.healthRuleViolations,
        avgResponseTime: dbApplications.avgResponseTime,
        errorRate: dbApplications.errorRate,
      }).from(dbApplications).where(credIds.length === 1
        ? eq(dbApplications.credentialId, credIds[0])
        : sql`${dbApplications.credentialId} = ANY(ARRAY[${sql.join(credIds.map(id => sql`${id}`), sql`, `)}]::integer[])`);

      if (apps.length === 0) {
        return res.json({
          summary: { uptime: 99.9, uptimeTrend: 0, p99Latency: 0, latencyTrend: 0, errorRate: 0, errorTrend: 0, errorBudgetBurn: 0, budgetTrend: 0 },
          latencyHistory: [],
          errorHistory: [],
          topDegradingServices: [],
          transactionHotspots: [],
          drilldown: [],
        });
      }

      const appExternalIds = apps.map((a) => String(a.externalId)).filter(Boolean);
      const [txRows, errRows] = await Promise.all([
        appExternalIds.length === 1
          ? db.select().from(dbTransactions).where(eq(dbTransactions.applicationId, appExternalIds[0])).orderBy(desc(dbTransactions.updatedAt)).limit(600)
          : db.select().from(dbTransactions).where(sql`${dbTransactions.applicationId} = ANY(ARRAY[${sql.join(appExternalIds.map(id => sql`${id}`), sql`, `)}]::text[])`).orderBy(desc(dbTransactions.updatedAt)).limit(600),
        appExternalIds.length === 1
          ? db.select().from(dbErrors).where(eq(dbErrors.applicationId, appExternalIds[0])).orderBy(desc(dbErrors.lastOccurrence)).limit(600)
          : db.select().from(dbErrors).where(sql`${dbErrors.applicationId} = ANY(ARRAY[${sql.join(appExternalIds.map(id => sql`${id}`), sql`, `)}]::text[])`).orderBy(desc(dbErrors.lastOccurrence)).limit(600),
      ]);

      const avg = (vals: number[]) => vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
      const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
      const round2 = (n: number) => Math.round(n * 100) / 100;

      const healthyApps = apps.filter((a) => String(a.status ?? "").toLowerCase() === "healthy").length;
      const availabilityFromStatus = apps.length > 0 ? (healthyApps / apps.length) * 100 : 100;
      const violationPenalty = Math.min(12, apps.reduce((s, a) => s + Number(a.healthRuleViolations ?? 0), 0) * 0.4);
      const uptime = round2(clamp(availabilityFromStatus - violationPenalty + 2, 92, 99.99));

      const validResp = txRows.map((t) => Number(t.avgResponseTime ?? 0)).filter((v) => Number.isFinite(v) && v > 0);
      const validErr = txRows.map((t) => Number(t.errorRate ?? 0)).filter((v) => Number.isFinite(v) && v >= 0);
      const appRespFallback = apps.map((a) => Number(a.avgResponseTime ?? 0)).filter((v) => Number.isFinite(v) && v > 0);
      const appErrFallback = apps.map((a) => Number(a.errorRate ?? 0)).filter((v) => Number.isFinite(v) && v >= 0);

      const p99LatencyBase = validResp.length > 0 ? Math.max(...validResp) * 1.75 : (avg(appRespFallback) * 1.9);
      const p99Latency = Math.round(clamp(p99LatencyBase || 0, 0, 15000));
      const errorRate = round2(clamp(validErr.length > 0 ? avg(validErr) : avg(appErrFallback), 0, 100));
      const errorBudgetBurn = round2(clamp(errorRate * 11 + (p99Latency > 1200 ? 18 : 0), 0, 100));

      const now = Date.now();
      const latencyHistory = Array.from({ length: 24 }).map((_, i) => {
        const ts = now - (23 - i) * 60 * 60 * 1000;
        const wave = Math.sin((i + apps.length) * 0.5) * 0.08;
        const drift = Math.cos((i + apps.length) * 0.17) * 0.04;
        return { timestamp: ts, value: round2(clamp((p99Latency || 1) * (1 + wave + drift), 0, 20000)) };
      });
      const errorHistory = Array.from({ length: 24 }).map((_, i) => {
        const ts = now - (23 - i) * 60 * 60 * 1000;
        const wave = Math.sin((i + txRows.length) * 0.55) * 0.12;
        const drift = Math.cos((i + txRows.length) * 0.21) * 0.05;
        return { timestamp: ts, value: round2(clamp((errorRate || 0) * (1 + wave + drift), 0, 100)) };
      });

      const txByApp = new Map<string, typeof txRows>();
      for (const t of txRows) {
        const key = String(t.applicationId ?? "");
        const arr = txByApp.get(key) ?? [];
        arr.push(t);
        txByApp.set(key, arr);
      }
      const appByExternal = new Map(apps.map((a) => [String(a.externalId), a]));
      const errByAppCount = new Map<string, number>();
      for (const e of errRows) {
        const key = String(e.applicationId ?? "");
        errByAppCount.set(key, (errByAppCount.get(key) ?? 0) + Number(e.frequency ?? 1));
      }

      const topDegradingServices = apps.map((a) => {
        const tArr = txByApp.get(String(a.externalId)) ?? [];
        const latency = Math.round(avg(tArr.map((t) => Number(t.avgResponseTime ?? 0)).filter((v) => v > 0)) || Number(a.avgResponseTime ?? 0) || 0);
        const errorsPct = round2(avg(tArr.map((t) => Number(t.errorRate ?? 0)).filter((v) => v >= 0)) || Number(a.errorRate ?? 0) || 0);
        const errCount = errByAppCount.get(String(a.externalId)) ?? 0;
        const riskScore = Math.round(clamp((errorsPct * 14) + (latency / 60) + Math.min(25, errCount / 8), 0, 100));
        return { name: a.name, latency, errors: errorsPct, riskScore, appId: a.id };
      }).sort((x, y) => y.riskScore - x.riskScore).slice(0, 6);

      const transactionHotspots = txRows
        .map((t) => {
          const appMeta = appByExternal.get(String(t.applicationId ?? ""));
          return ({
          name: t.name,
          avgResponseTime: Math.round(Number(t.avgResponseTime ?? 0)),
          p99: Math.round(Number(t.avgResponseTime ?? 0) * 1.8),
          callsPerMinute: Math.round(Number(t.callsPerMinute ?? 0)),
          errorRate: round2(Number(t.errorRate ?? 0)),
          appId: appMeta?.id ?? null,
          txId: String(t.externalId ?? t.id ?? ""),
        });
        })
        .sort((a, b) => (b.errorRate * 20 + b.avgResponseTime / 40) - (a.errorRate * 20 + a.avgResponseTime / 40))
        .slice(0, 15);

      const topApp = topDegradingServices[0]?.name ?? apps[0]?.name ?? "Application";
      const topTx = transactionHotspots[0]?.name ?? "Primary Transaction";
      const drilldown = [
        { level: "Environment", name: "Production" },
        { level: "Application", name: topApp },
        { level: "Transaction", name: topTx },
      ];

      const latencyTrend = round2(((latencyHistory[23]?.value ?? 0) - (latencyHistory[11]?.value ?? 0)) / Math.max(1, latencyHistory[11]?.value ?? 1) * 100);
      const errorTrend = round2(((errorHistory[23]?.value ?? 0) - (errorHistory[11]?.value ?? 0)) / Math.max(0.01, errorHistory[11]?.value ?? 0.01) * 100);
      const uptimeTrend = round2(clamp((healthyApps / Math.max(1, apps.length)) * 2 - 1, -3, 3));
      const budgetTrend = round2(clamp(errorTrend * 0.6 + (latencyTrend > 0 ? 1.2 : -0.8), -20, 20));

      return res.json({
        summary: {
          uptime,
          uptimeTrend,
          p99Latency,
          latencyTrend,
          errorRate,
          errorTrend,
          errorBudgetBurn,
          budgetTrend,
        },
        latencyHistory,
        errorHistory,
        topDegradingServices,
        transactionHotspots,
        drilldown,
      });
    } catch {
      return res.json(await storage.getPersonaSre());
    }
  });

  // === Runtime ===
  const runtimeHandler = async (req: any, res: any) => {
    const rawService = String((req.query as any)?.service ?? req.params?.service ?? "").trim();
    const service = decodeURIComponent(rawService || "process");
    const serviceLc = service.toLowerCase();
    const appIdQ = String((req.query as any)?.appId ?? "").trim();
    const serverIdQ = Number((req.query as any)?.serverId ?? NaN);
    const pidQ = Number((req.query as any)?.pid ?? NaN);
    const serverNameQ = String((req.query as any)?.serverName ?? "").trim();
    const durationMinsQ = Number((req.query as any)?.durationMins ?? NaN);
    const durationMins = Number.isFinite(durationMinsQ) && durationMinsQ > 0 ? durationMinsQ : 180;

    const runtimeFromName = (name: string) => {
      const n = name.toLowerCase();
      if (n.includes("java") || n.includes("jvm")) return "JVM";
      if (n.includes("dotnet") || n.includes(".net") || n.includes("clr")) return ".NET CLR";
      if (n.includes("php")) return "PHP-FPM";
      if (n.includes("node")) return "Node.js";
      if (n.includes("python")) return "Python";
      return "Application Runtime";
    };

    let appExternalId = "";
    if (appIdQ) {
      const dbApp = await resolveDbApp(appIdQ);
      appExternalId = String(dbApp?.externalId ?? appIdQ);
    }

    let serverRow: any = null;
    if (Number.isFinite(serverIdQ) && serverIdQ > 0) {
      const [srv] = await db.select().from(dbServers).where(eq(dbServers.id, serverIdQ));
      serverRow = srv ?? null;
      if (!appExternalId && srv?.applicationId) appExternalId = String(srv.applicationId);
    }

    const txWhere = appExternalId
      ? eq(dbTransactions.applicationId, appExternalId)
      : sql`lower(${dbTransactions.name}) like ${`%${serviceLc}%`}`;
    const txRows = await db.select().from(dbTransactions)
      .where(txWhere)
      .orderBy(desc(dbTransactions.updatedAt))
      .limit(60);

    const errWhere = appExternalId
      ? eq(dbErrors.applicationId, appExternalId)
      : sql`lower(coalesce(${dbErrors.service}, '')) like ${`%${serviceLc}%`}`;
    const errRows = await db.select().from(dbErrors)
      .where(errWhere)
      .orderBy(desc(dbErrors.lastOccurrence))
      .limit(120);
    const alertWhere = appExternalId
      ? eq(dbAlerts.applicationId, appExternalId)
      : sql`lower(coalesce(${dbAlerts.name}, '')) like ${`%${serviceLc}%`}`;
    const alertRows = await db.select().from(dbAlerts)
      .where(alertWhere)
      .orderBy(desc(dbAlerts.triggeredAt))
      .limit(120);

    const processList = serverRow
      ? extractProcessesFromMetadata((serverRow.metadata as any) ?? {})
      : [];
    const fallbackProcesses = txRows
      .map((t) => {
        const cpm = Number(t.callsPerMinute ?? 0);
        const errRate = Number(t.errorRate ?? 0);
        const avgResp = Number(t.avgResponseTime ?? 0);
        const cpu = Math.max(1, Math.min(100, Number((cpm / 2 + errRate * 5).toFixed(1))));
        const memory = Math.max(64, Math.round(avgResp * 0.7 + cpu * 6));
        return {
          name: String(t.name ?? "worker"),
          pid: Number(t.id),
          cpu,
          memory,
          status: "Running",
          anomaly: cpu >= 70 || memory >= 1500 || errRate > 3,
        };
      })
      .sort((a, b) => (b.cpu + b.memory / 100) - (a.cpu + a.memory / 100))
      .slice(0, 25);
    const processes = processList.length > 0 ? processList : fallbackProcesses;

    const selectedProcess =
      (Number.isFinite(pidQ) ? processes.find((p) => Number(p.pid) === pidQ) : undefined)
      ?? processes.find((p) => String(p.name ?? "").toLowerCase() === serviceLc)
      ?? processes.find((p) => String(p.name ?? "").toLowerCase().includes(serviceLc))
      ?? processes[0]
      ?? {
        name: service,
        pid: Number.isFinite(pidQ) ? pidQ : 0,
        cpu: Number(serverRow?.cpuUsage ?? 0),
        memory: Math.max(64, Math.round(Number(serverRow?.memoryUsage ?? 0) * 64)),
        status: "Running",
        anomaly: false,
      };

    const relatedTx = txRows.filter((t) => {
      const name = String(t.name ?? "").toLowerCase();
      return name === String(selectedProcess.name ?? "").toLowerCase()
        || name.includes(String(selectedProcess.name ?? "").toLowerCase());
    });
    const callsPerMinute = relatedTx.length > 0
      ? relatedTx.reduce((s, t) => s + Number(t.callsPerMinute ?? 0), 0) / relatedTx.length
      : Number((txRows[0] as any)?.callsPerMinute ?? 0);
    const avgResponse = relatedTx.length > 0
      ? relatedTx.reduce((s, t) => s + Number(t.avgResponseTime ?? 0), 0) / relatedTx.length
      : Number((txRows[0] as any)?.avgResponseTime ?? 0);
    const errRateFromTx = relatedTx.length > 0
      ? relatedTx.reduce((s, t) => s + Number(t.errorRate ?? 0), 0) / relatedTx.length
      : Number((txRows[0] as any)?.errorRate ?? 0);
    const errFreq = errRows
      .filter((e) => String(e.service ?? "").toLowerCase().includes(String(selectedProcess.name ?? "").toLowerCase()))
      .reduce((s, e) => s + Number(e.frequency ?? 1), 0);

    const baseCpu = Math.max(0, Math.min(100,
      Number(selectedProcess.cpu ?? 0) || Number(serverRow?.cpuUsage ?? 0) || (callsPerMinute / 2 + errRateFromTx * 5)
    ));
    const serverMemPct = normalizePercent(Number(serverRow?.memoryUsage ?? NaN), 0);
    const processMemPct = Math.max(0, Math.min(100, (Number(selectedProcess.memory ?? 0) / 4096) * 100));
    const baseHeap = Math.max(0, Math.min(100,
      processMemPct > 0 ? processMemPct : (serverMemPct > 0 ? serverMemPct : 45)
    ));
    const baseGc = Math.max(20, Math.round((avgResponse / 4) + errRateFromTx * 35 + (baseCpu * 0.8)));
    const baseThreads = Math.max(8, Math.round((callsPerMinute * 1.4) + baseCpu * 1.1));
    const baseExceptions = Math.max(0, Number((errRateFromTx > 0 ? errRateFromTx : (errFreq / Math.max(1, durationMins / 10))).toFixed(2)));

    const points = Math.max(24, Math.min(96, Math.round(durationMins / 5)));
    const endTs = Date.now();
    const step = Math.max(60_000, Math.floor((durationMins * 60_000) / Math.max(1, points - 1)));
    const metrics = Array.from({ length: points }).map((_, idx) => {
      const ts = endTs - (points - 1 - idx) * step;
      const phase = idx / Math.max(1, points - 1);
      const wave = Math.sin((idx / Math.max(1, points - 1)) * Math.PI * 2);
      const cpuUsage = Math.max(0, Math.min(100, baseCpu + wave * 5 + phase * 6));
      const heapUsed = Math.max(0, Math.min(100, baseHeap + wave * 4 + phase * 4));
      const gcTime = Math.max(0, Math.round(baseGc + wave * 45 + phase * 30));
      const threadCount = Math.max(1, Math.round(baseThreads + wave * 12 + phase * 10));
      const exceptionRate = Math.max(0, Number((baseExceptions + wave * 0.8 + phase * 0.9).toFixed(2)));
      return { timestamp: ts, cpuUsage, heapUsed, gcTime, threadCount, exceptionRate };
    });

    const latest = metrics[metrics.length - 1] ?? { cpuUsage: 0, heapUsed: 0, gcTime: 0, threadCount: 0, exceptionRate: 0 };
    const anomalies: any[] = [];
    if (latest.gcTime >= 450) anomalies.push({ metric: "GC Pause", value: `${Math.round(latest.gcTime)}ms`, threshold: "450ms", severity: latest.gcTime >= 700 ? "Critical" : "High" });
    if (latest.cpuUsage >= 80) anomalies.push({ metric: "CPU Usage", value: `${latest.cpuUsage.toFixed(1)}%`, threshold: "80%", severity: latest.cpuUsage >= 90 ? "Critical" : "High" });
    if (latest.heapUsed >= 85) anomalies.push({ metric: "Heap Used", value: `${latest.heapUsed.toFixed(1)}%`, threshold: "85%", severity: latest.heapUsed >= 93 ? "Critical" : "High" });
    if (latest.exceptionRate >= 3) anomalies.push({ metric: "Exception Rate", value: `${latest.exceptionRate.toFixed(2)}/min`, threshold: "3/min", severity: latest.exceptionRate >= 6 ? "Critical" : "High" });

    const relatedProcesses = processes
      .filter((p) => String(p.name ?? "").trim().length > 0)
      .slice(0, 8)
      .map((p) => ({ name: String(p.name), pid: Number(p.pid ?? 0) }));

    const looksLikeId = (value: string | null | undefined) => {
      const v = String(value ?? "").trim();
      return v.length > 0 && /^\d+$/.test(v);
    };
    const pickReadable = (...values: Array<string | null | undefined>) => {
      const cleaned = values
        .map((v) => String(v ?? "").trim())
        .filter((v) => v.length > 0 && v.toLowerCase() !== "n/a" && v.toLowerCase() !== "unknown");
      if (cleaned.length === 0) return "";
      const named = cleaned.find((v) => !looksLikeId(v));
      return named ?? cleaned[0];
    };
    const isDiagnosticNoise = (value: string | null | undefined) =>
      String(value ?? "").toUpperCase().includes("DIAGNOSTIC_SESSION");
    const extractConcreteFromSummary = (summary: string | null | undefined) => {
      const raw = String(summary ?? "").trim();
      if (!raw) return { type: "", message: "" };
      const tail = raw.includes(" - ") ? raw.split(" - ").slice(1).join(" - ") : raw;
      const cleaned = tail
        .replace(/\[Stacktrace Processing Limit Reached\]/gi, "")
        .replace(/\s+/g, " ")
        .trim();
      const firstToken = cleaned.split(/\s+/)[0] ?? "";
      const inferredType = firstToken.replace(/[:]+$/g, "").trim();
      return { type: inferredType, message: cleaned };
    };
    const nonDiagnosticErrRows = errRows.filter((e) => {
      const t = String(e.errorType ?? "").toUpperCase();
      const msg = String(e.message ?? "").toUpperCase();
      const summary = String((e.metadata as any)?.errorSummary ?? "").toUpperCase();
      return t !== "DIAGNOSTIC_SESSION" && !msg.includes("DIAGNOSTIC_SESSION") && !summary.includes("DIAGNOSTIC_SESSION");
    });

    const mappedErrRows = nonDiagnosticErrRows.map((e) => {
      const md: any = (e.metadata as any) ?? {};
      const detail0 = Array.isArray(md?.errorDetails) && md.errorDetails.length > 0 ? md.errorDetails[0] : null;
      const summaryExtract = extractConcreteFromSummary(md?.summary);
      const rawType = String(detail0?.name ?? md?.subType ?? e.errorType ?? "Application Error").trim();
      const normalizedType = isDiagnosticNoise(rawType)
        ? (summaryExtract.type || "Application Error")
        : rawType;
      const rawRootCause = String(
        detail0?.value ??
        md?.errorSummary ??
        md?.summary ??
        e.message ??
        ""
      ).trim();
      const normalizedRootCause = isDiagnosticNoise(rawRootCause)
        ? (summaryExtract.message || rawRootCause)
        : rawRootCause;
      const requestPath = String(md?.requestPath ?? md?.URL ?? "").trim();
      return {
        id: Number(e.id ?? 0),
        errorId: `ERR-${String(e.id ?? "")}`,
        sourceErrorId: String(e.externalId ?? ""),
        errorType: normalizedType || "Application Error",
        message: String((normalizedRootCause || e.message || e.cluster || "Application Error")).slice(0, 220),
        service: pickReadable(
          md?.businessTransactionName,
          md?.tierName,
          md?.triggeredEntity?.name,
          e.service,
          e.applicationName,
        ) || "Unknown Service",
        status: String(e.status ?? "Active"),
        severity: String(e.severity ?? "Medium"),
        clusterId: String(e.cluster ?? ""),
        requestPath: requestPath || "",
        rootCause: normalizedRootCause || "",
        occurrences: Number(e.frequency ?? 1),
        count: Number(e.frequency ?? 1),
        firstSeen: e.firstSeen,
        lastOccurrence: e.lastOccurrence,
        lastSeen: e.lastOccurrence,
        timestamp: e.lastOccurrence?.getTime?.() ?? Date.now(),
        source: e.source === "appdynamics" ? "AppDynamics" : "Dynatrace",
        href: `/errors/ERR-${String(e.id ?? "")}`,
      };
    });

    const selectedProcessNameLc = String(selectedProcess.name ?? service).toLowerCase();
    const selectedProcessTokens = Array.from(new Set(
      selectedProcessNameLc
        .split(/[^a-z0-9]+/g)
        .map((t) => t.trim())
        .filter((t) => t.length >= 3)
    ));
    const pidText = Number.isFinite(Number(selectedProcess.pid)) && Number(selectedProcess.pid) > 0
      ? String(Number(selectedProcess.pid))
      : "";
    const scoreForProcessRelevance = (signal: string) => {
      let score = 0;
      if (!signal) return score;
      if (selectedProcessNameLc && signal.includes(selectedProcessNameLc)) score += 4;
      for (const token of selectedProcessTokens) {
        if (signal.includes(token)) score += 1;
      }
      if (pidText && signal.includes(pidText)) score += 2;
      return score;
    };

    const relatedAlerts = alertRows
      .map((a) => {
        const signal = `${String(a.name ?? "").toLowerCase()} ${String(a.metric ?? "").toLowerCase()} ${JSON.stringify((a.metadata as any) ?? {}).toLowerCase()}`;
        return { a, score: scoreForProcessRelevance(signal) };
      })
      .filter((x) => x.score > 0)
      .sort((x, y) => {
        if (y.score !== x.score) return y.score - x.score;
        const yTs = y.a.triggeredAt ? new Date(y.a.triggeredAt).getTime() : 0;
        const xTs = x.a.triggeredAt ? new Date(x.a.triggeredAt).getTime() : 0;
        return yTs - xTs;
      })
      .slice(0, 6)
      .map(({ a }) => ({
        alertId: `ALT-${String(a.id ?? "")}`,
        sourceAlertId: String(a.externalId ?? ""),
        name: String(a.name ?? "Alert"),
        severity: String(a.severity ?? "Warning"),
        status: String(a.status ?? "Active"),
        triggeredAt: a.triggeredAt,
        href: `/alerts/ALT-${String(a.id ?? "")}`,
      }));

    const scoredRelatedErrors = mappedErrRows
      .map((e) => {
        const signal = `${String(e.service ?? "").toLowerCase()} ${String(e.errorType ?? "").toLowerCase()} ${String(e.message ?? "").toLowerCase()} ${String(e.clusterId ?? "").toLowerCase()} ${String(e.requestPath ?? "").toLowerCase()} ${String(e.rootCause ?? "").toLowerCase()}`;
        return { e, score: scoreForProcessRelevance(signal) };
      })
      .filter((x) => x.score > 0)
      .sort((x, y) => {
        if (y.score !== x.score) return y.score - x.score;
        const yTs = y.e.lastSeen ? new Date(y.e.lastSeen).getTime() : 0;
        const xTs = x.e.lastSeen ? new Date(x.e.lastSeen).getTime() : 0;
        return yTs - xTs;
      });
    const relatedErrors = (
      scoredRelatedErrors.length > 0
        ? scoredRelatedErrors.map(({ e }) => e)
        : [...mappedErrRows].sort((a, b) => {
            const bTs = b.lastSeen ? new Date(b.lastSeen).getTime() : 0;
            const aTs = a.lastSeen ? new Date(a.lastSeen).getTime() : 0;
            return bTs - aTs;
          })
    ).slice(0, 6);

    if (relatedErrors.length === 0 && appExternalId) {
      try {
        const appExternalNum = Number(appExternalId);
        const [appRow] = await db.select().from(dbApplications).where(eq(dbApplications.externalId, appExternalId)).limit(1);
        if (appRow?.source === "appdynamics" && appRow.credentialId != null && Number.isFinite(appExternalNum)) {
          const [cred] = await db.select().from(apmCredentials).where(eq(apmCredentials.id, appRow.credentialId)).limit(1);
          if (cred) {
            let resolvedPassword = String(cred.passwordHash ?? "");
            try {
              resolvedPassword = String(decryptSecret(cred.passwordHash) ?? resolvedPassword);
            } catch {
              resolvedPassword = String(cred.passwordHash ?? "");
            }
            const client = createAppDynamicsClient({
              controllerUrl: cred.controllerUrl,
              account: cred.account ?? "",
              username: cred.username ?? "",
              password: resolvedPassword,
            });
            if (client) {
              const txCandidates = (relatedTx.length > 0 ? relatedTx : txRows)
                .filter((t: any) => Number.isFinite(Number(t?.externalId ?? NaN)))
                .slice(0, 6);
              const snapshotItems: any[] = [];
              for (const tx of txCandidates) {
                const btIdNum = Number(tx.externalId ?? NaN);
                if (!Number.isFinite(btIdNum)) continue;
                const snaps = await client.getRequestSnapshots(appExternalNum, btIdNum, 180).catch(() => []);
                const rows = Array.isArray(snaps) ? snaps : [];
                for (let i = 0; i < rows.length; i++) {
                  const s: any = rows[i];
                  const hasError = Boolean(s?.errorOccured)
                    || (Array.isArray(s?.errorDetails) && s.errorDetails.length > 0)
                    || String(s?.summary ?? "").toLowerCase().includes("[error]")
                    || String(s?.errorSummary ?? "").trim().length > 0;
                  if (!hasError) continue;
                  const ts = Number(s?.localStartTime ?? s?.serverStartTime ?? NaN);
                  if (!Number.isFinite(ts)) continue;
                  const detail0 = Array.isArray(s?.errorDetails) && s.errorDetails.length > 0 ? s.errorDetails[0] : null;
                  const message = String(detail0?.value ?? detail0?.name ?? s?.errorSummary ?? s?.summary ?? "Application error").trim();
                  const signal = `${String(s?.businessTransactionName ?? tx?.name ?? "").toLowerCase()} ${String(message).toLowerCase()} ${String(s?.URL ?? "").toLowerCase()}`;
                  const score = scoreForProcessRelevance(signal);
                  const syntheticId = `SNAP-${appExternalNum}-${btIdNum}-${ts}-${i}`;
                  snapshotItems.push({
                    score,
                    item: {
                      id: 0,
                      errorId: syntheticId,
                      sourceErrorId: syntheticId,
                      errorType: String(detail0?.name ?? "Business Transaction Error"),
                      message: message.slice(0, 220) || "Application error",
                      service: pickReadable(String(s?.businessTransactionName ?? ""), String(tx?.name ?? "")) || "Unknown Service",
                      status: "Active",
                      severity: "High",
                      clusterId: `SIG-snap-${btIdNum}`,
                      requestPath: String(s?.URL ?? ""),
                      rootCause: message.slice(0, 220) || "",
                      occurrences: 1,
                      count: 1,
                      firstSeen: new Date(ts),
                      lastOccurrence: new Date(ts),
                      lastSeen: new Date(ts),
                      timestamp: ts,
                      source: "AppDynamics",
                      href: `/errors/${syntheticId}`,
                    },
                  });
                }
              }
              if (snapshotItems.length > 0) {
                const dedup = new Map<string, any>();
                for (const row of snapshotItems) {
                  if (!dedup.has(row.item.errorId)) dedup.set(row.item.errorId, row);
                }
                relatedErrors.splice(
                  0,
                  relatedErrors.length,
                  ...Array.from(dedup.values())
                    .sort((a, b) => (b.score - a.score) || (Number(b.item.timestamp ?? 0) - Number(a.item.timestamp ?? 0)))
                    .slice(0, 6)
                    .map((x) => x.item)
                );
              }
            }
          }
        }
      } catch {
        // ignore snapshot fallback errors; keep existing relatedErrors value
      }
    }

    return res.json({
      service: String(selectedProcess.name ?? service),
      runtime: runtimeFromName(String(selectedProcess.name ?? service)),
      pid: Number(selectedProcess.pid ?? (Number.isFinite(pidQ) ? pidQ : 0)),
      appId: appIdQ || null,
      serverId: Number.isFinite(serverIdQ) ? serverIdQ : null,
      serverName: String(serverNameQ || serverRow?.name || "Unknown Node"),
      cpuNow: Number(latest.cpuUsage.toFixed(1)),
      heapNow: Number(latest.heapUsed.toFixed(1)),
      gcNow: Math.round(latest.gcTime),
      exceptionNow: Number(latest.exceptionRate.toFixed(2)),
      threadNow: Math.round(latest.threadCount),
      anomalies,
      aiInsight:
        anomalies.length > 0
          ? `${String(selectedProcess.name ?? service)} shows elevated runtime pressure (${anomalies.map((a: any) => a.metric).join(", ")}). Focus first on ${anomalies[0].metric} and validate downstream dependency health.`
          : `${String(selectedProcess.name ?? service)} runtime is stable in the selected window. Continue monitoring CPU/heap trend and exception drift.`,
      metrics,
      relatedProcesses,
      relatedAlerts,
      relatedErrors,
    });
  };
  app.get("/api/runtime", runtimeHandler);
  app.get("/api/runtime/:service", runtimeHandler);

  // === AI (legacy) ===
  app.get("/api/ai/insights", async (req, res) => { res.json(await storage.getAiInsights()); });

  // === AI Health Check ===
  app.get("/api/ai/health", requireAuth, async (_req, res) => {
    const health = await checkOllamaHealth();
    res.json(health);
  });
  const configuredAiTimeoutMs = Number(process.env.AI_TIMEOUT_MS ?? 180000);
  const AI_TIMEOUT_MS = Number.isFinite(configuredAiTimeoutMs) && configuredAiTimeoutMs > 0
    ? configuredAiTimeoutMs
    : 180000;
  const withAiTimeout = async <T>(promise: Promise<T>, ms = AI_TIMEOUT_MS): Promise<T> => {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`AI request timed out after ${Math.round(ms / 1000)}s`)), ms)
      ),
    ]);
  };
  const isOllamaUnavailableError = (err: any) => {
    const msg = String(err?.message ?? "").toLowerCase();
    const causeCode = String(err?.cause?.code ?? "").toUpperCase();
    return (
      causeCode === "ECONNREFUSED" ||
      msg.includes("econnrefused") ||
      msg.includes("fetch failed") ||
      msg.includes("failed to fetch") ||
      msg.includes("connect") && msg.includes("refused") ||
      msg.includes("model") && msg.includes("not found")
    );
  };

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
    let credIds: number[] | null = null;
    try {
      if (await isDemoOrg(req)) return res.json(DEMO_CAUSAL_PREDICTIVE);
      credIds = await resolveCredIds(req);
      if (!credIds) return res.status(401).json({ error: "Not authenticated" });
      const result = await withAiTimeout(runCausalPredictive(credIds), 25000);
      res.json(result);
    } catch (err: any) {
      const isOllama = isOllamaUnavailableError(err);
      const isTimeout = String(err?.message ?? "").toLowerCase().includes("timed out");
      if ((isTimeout || isOllama) && credIds) {
        const fallback = await runCausalPredictiveFallback(credIds);
        return res.json({
          ...fallback,
          summary: `${fallback.summary} AI model did not respond within 25s, so this fallback was generated from live telemetry only.`,
        });
      }
      res.status(isOllama ? 503 : 500).json({
        error: isOllama
          ? "Ollama is unavailable. Start it with: ollama serve (and ensure your model is pulled)."
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
      const result = await withAiTimeout(runRootCause(credIds, req.body?.incidentContext ?? undefined));
      res.json(result);
    } catch (err: any) {
      const isOllama = isOllamaUnavailableError(err);
      const isTimeout = String(err?.message ?? "").toLowerCase().includes("timed out");
      if (isTimeout) return res.status(504).json({ error: err.message });
      res.status(isOllama ? 503 : 500).json({
        error: isOllama
          ? "Ollama is unavailable. Start it with: ollama serve (and ensure your model is pulled)."
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
      const result = await withAiTimeout(runCorrelationInsights(credIds));
      res.json(result);
    } catch (err: any) {
      const isOllama = isOllamaUnavailableError(err);
      const isTimeout = String(err?.message ?? "").toLowerCase().includes("timed out");
      if (isTimeout) return res.status(504).json({ error: err.message });
      res.status(isOllama ? 503 : 500).json({
        error: isOllama
          ? "Ollama is unavailable. Start it with: ollama serve (and ensure your model is pulled)."
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
      const result = await withAiTimeout(runRecommendations(credIds, req.body?.rootCauseSummary ?? undefined));
      res.json(result);
    } catch (err: any) {
      const isOllama = isOllamaUnavailableError(err);
      const isTimeout = String(err?.message ?? "").toLowerCase().includes("timed out");
      if (isTimeout) return res.status(504).json({ error: err.message });
      res.status(isOllama ? 503 : 500).json({
        error: isOllama
          ? "Ollama is unavailable. Start it with: ollama serve (and ensure your model is pulled)."
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
      const result = await withAiTimeout(runServiceRiskRanking(credIds));
      res.json(result);
    } catch (err: any) {
      const isOllama = isOllamaUnavailableError(err);
      const isTimeout = String(err?.message ?? "").toLowerCase().includes("timed out");
      if (isTimeout) return res.status(504).json({ error: err.message });
      res.status(isOllama ? 503 : 500).json({
        error: isOllama
          ? "Ollama is unavailable. Start it with: ollama serve (and ensure your model is pulled)."
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

  // === Capacity Planning ===
  const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, value));
  const avg = (arr: number[]) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const scoreFromUtilization = (cpu: number, mem: number, disk: number, riskBoost = 0) =>
    clamp(Math.round(cpu * 0.4 + mem * 0.35 + disk * 0.15 + riskBoost), 0, 100);
  const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const series = (baseline: number, slope = 0, points = 48, stepHours = 1) => {
    const now = Date.now();
    const out: Array<{ ts: number; value: number }> = [];
    for (let i = points - 1; i >= 0; i--) {
      const noise = ((i % 7) - 3) * 0.35;
      const value = clamp(baseline - (i * slope) + noise, 0, 100);
      out.push({ ts: now - (i * stepHours * 3600000), value: round1(value) });
    }
    return out;
  };
  const forecastFromLast = (last: number, slope = 0.5, points = 48, stepHours = 1) => {
    const now = Date.now();
    const out: Array<{ ts: number; predicted: number; upper: number; lower: number }> = [];
    for (let i = 1; i <= points; i++) {
      const predicted = clamp(last + slope * i, 0, 100);
      out.push({
        ts: now + (i * stepHours * 3600000),
        predicted: round1(predicted),
        upper: round1(clamp(predicted + 5, 0, 100)),
        lower: round1(clamp(predicted - 5, 0, 100)),
      });
    }
    return out;
  };
  const HORIZON_POINTS: Record<string, number> = {
    "24h": 24,
    "72h": 72,
    "1w": 7 * 24,
    "3m": 90 * 24,
  };
  const deriveUtilizationFromSignals = (params: {
    appRow?: any;
    txRows?: any[];
    errRows?: any[];
    alertRows?: any[];
    incRows?: any[];
    risksRaw?: any[];
  }) => {
    const appRow = params.appRow ?? {};
    const txRows = params.txRows ?? [];
    const errRows = params.errRows ?? [];
    const alertRows = params.alertRows ?? [];
    const incRows = params.incRows ?? [];
    const risksRaw = params.risksRaw ?? [];
    const appCpm = Number(appRow.callsPerMinute ?? 0);
    const appResp = Number(appRow.avgResponseTime ?? 0);
    const appErr = Number(appRow.errorRate ?? 0);
    const appViol = Number(appRow.healthRuleViolations ?? 0);
    const txCpm = avg(txRows.map((t) => Number(t.callsPerMinute ?? 0)));
    const txResp = avg(txRows.map((t) => Number(t.avgResponseTime ?? 0)));
    const txErr = avg(txRows.map((t) => Number(t.errorRate ?? 0)));
    const errFreq = errRows.reduce((s, e) => s + Number(e.frequency ?? 0), 0);
    const activeAlerts = alertRows.filter((a) => (a.status ?? "").toLowerCase() !== "resolved").length;
    const criticalIncidents = incRows.filter((i) => (i.severity ?? "").toLowerCase() === "critical").length;
    const riskCpu = risksRaw.find((r) => String(r.type ?? "").toLowerCase().includes("cpu"));
    const riskMem = risksRaw.find((r) => String(r.type ?? "").toLowerCase().includes("mem"));
    const riskDisk = risksRaw.find((r) => String(r.type ?? "").toLowerCase().includes("disk"));
    const riskNet = risksRaw.find((r) => String(r.type ?? "").toLowerCase().includes("network"));

    const workloadScore = clamp(
      12 +
      Math.min(35, (appCpm || txCpm) / 30) +
      Math.min(20, (appResp || txResp) / 140) +
      Math.min(22, (appErr || txErr) * 10) +
      Math.min(16, errFreq / 25) +
      Math.min(12, activeAlerts * 1.8) +
      Math.min(15, criticalIncidents * 3.5) +
      Math.min(10, appViol * 1.5),
      8,
      98,
    );

    const cpu = clamp(Number(riskCpu?.current ?? (workloadScore + (appViol * 0.9))), 8, 99);
    const memory = clamp(Number(riskMem?.current ?? (workloadScore * 0.92 + Math.min(8, txErr * 4))), 8, 99);
    const disk = clamp(Number(riskDisk?.current ?? (18 + workloadScore * 0.58 + Math.min(10, errFreq / 40))), 6, 98);
    const network = clamp(Number(riskNet?.current ?? (14 + workloadScore * 0.62 + Math.min(12, (appCpm || txCpm) / 55))), 5, 98);
    return { cpu: round1(cpu), memory: round1(memory), disk: round1(disk), network: round1(network) };
  };

  app.get("/api/capacity-planning/global", async (req, res) => {
    try {
      const requestedHorizon = String(req.query.horizon ?? "72h");
      const selectedHorizon = Object.prototype.hasOwnProperty.call(HORIZON_POINTS, requestedHorizon)
        ? requestedHorizon
        : "72h";
      const selectedForecastPoints = HORIZON_POINTS[selectedHorizon] ?? 72;
      const selectedAppId = Number(req.query.appId ?? NaN);
      const selectedApp = Number.isFinite(selectedAppId)
        ? (await db.select().from(dbApplications).where(eq(dbApplications.id, selectedAppId)).limit(1))[0]
        : null;

      const appFilter = selectedApp?.externalId ? eq(dbServers.applicationId, selectedApp.externalId) : undefined;
      const [servers, apps, risksRaw, txRows, alertRows, incRows, errRows] = await Promise.all([
        appFilter
          ? db.select().from(dbServers).where(appFilter).limit(50)
          : db.select().from(dbServers),
        selectedApp?.id
          ? db.select().from(dbApplications).where(eq(dbApplications.id, selectedApp.id))
          : db.select().from(dbApplications),
        selectedApp?.id
          ? db.select().from(dbCapacityRisks).where(eq(dbCapacityRisks.appId, selectedApp.id)).orderBy(desc(dbCapacityRisks.riskScore))
          : db.select().from(dbCapacityRisks).orderBy(desc(dbCapacityRisks.riskScore)),
        selectedApp?.externalId
          ? db.select().from(dbTransactions).where(eq(dbTransactions.applicationId, selectedApp.externalId)).limit(120)
          : Promise.resolve([]),
        selectedApp?.externalId
          ? db.select().from(dbAlerts).where(eq(dbAlerts.applicationId, selectedApp.externalId)).limit(120)
          : Promise.resolve([]),
        selectedApp?.externalId
          ? db.select().from(dbIncidents).where(eq(dbIncidents.applicationId, selectedApp.externalId)).limit(120)
          : Promise.resolve([]),
        selectedApp?.externalId
          ? db.select().from(dbErrors).where(eq(dbErrors.applicationId, selectedApp.externalId)).limit(200)
          : Promise.resolve([]),
      ]);

      const liveAppdMetrics = selectedApp?.source === "appdynamics" && selectedApp.externalId
        ? await getLiveAppdNodeMetrics(selectedApp.externalId, selectedApp.credentialId)
        : null;
      const serverUtils = servers.map((s) => resolveServerUtilization(s, liveAppdMetrics));
      const cpuValues = serverUtils.map((u) => Number(u.cpu ?? 0));
      const memValues = serverUtils.map((u) => Number(u.memory ?? 0));
      const diskValues = serverUtils.map((u) => Number(u.disk ?? 0));
      const netValues = serverUtils.map((u) => clamp(Number(u.network ?? 0), 0, 100));

      const cpuWithData = cpuValues.filter((v) => Number.isFinite(v) && v > 0);
      const memWithData = memValues.filter((v) => Number.isFinite(v) && v > 0);
      const diskWithData = diskValues.filter((v) => Number.isFinite(v) && v > 0);

      let avgCpu = round1(avg(cpuWithData.length > 0 ? cpuWithData : cpuValues));
      let avgMem = round1(avg(memWithData.length > 0 ? memWithData : memValues));
      let avgDisk = round1(avg(diskWithData.length > 0 ? diskWithData : diskValues));
      let avgNet = round1(avg(netValues.filter((v) => Number.isFinite(v) && v > 0).length > 0
        ? netValues.filter((v) => Number.isFinite(v) && v > 0)
        : netValues));
      const hasServerUtilData = servers.length > 0 && (avgCpu > 0 || avgMem > 0 || avgDisk > 0);
      if (selectedApp && !hasServerUtilData) {
        const derived = deriveUtilizationFromSignals({
          appRow: selectedApp,
          txRows,
          errRows,
          alertRows,
          incRows,
          risksRaw,
        });
        avgCpu = derived.cpu;
        avgMem = derived.memory;
        avgDisk = derived.disk;
        avgNet = derived.network;
      }
      const criticalNodes = servers.filter((s, i) => {
        const unhealthy = (s.status ?? "").toLowerCase() !== "healthy";
        return unhealthy || cpuValues[i] >= 90 || memValues[i] >= 90;
      }).length;
      const warningNodes = servers.filter((s, i) => cpuValues[i] >= 80 || memValues[i] >= 80).length;
      const riskBoost = risksRaw.length ? Math.min(25, Math.round(avg(risksRaw.map((r) => Number(r.riskScore ?? 0))) * 0.2)) : 0;
      const overallRiskScore = scoreFromUtilization(avgCpu, avgMem, avgDisk, riskBoost);
      const totalReq = apps.reduce((s, a) => s + Number(a.callsPerMinute ?? 0), 0);
      const reqUtil = clamp(totalReq / Math.max(1, apps.length * 300), 0, 100);

      const cpuHistorical = series(avgCpu, -0.2);
      const memHistorical = series(avgMem, -0.15);
      const diskHistorical = series(avgDisk, -0.08);
      const netHistorical = series(avgNet, -0.1);
      const reqHistorical = series(reqUtil, -0.12);
      const maxForecastPoints = HORIZON_POINTS["3m"];
      const cpuForecastFull = forecastFromLast(cpuHistorical[cpuHistorical.length - 1]?.value ?? avgCpu, 0.35, maxForecastPoints);
      const memForecastFull = forecastFromLast(memHistorical[memHistorical.length - 1]?.value ?? avgMem, 0.28, maxForecastPoints);
      const diskForecastFull = forecastFromLast(diskHistorical[diskHistorical.length - 1]?.value ?? avgDisk, 0.22, maxForecastPoints);
      const netForecastFull = forecastFromLast(netHistorical[netHistorical.length - 1]?.value ?? avgNet, 0.25, maxForecastPoints);
      const reqForecastFull = forecastFromLast(reqHistorical[reqHistorical.length - 1]?.value ?? reqUtil, 0.3, maxForecastPoints);

      const cpuForecast = cpuForecastFull.slice(0, selectedForecastPoints);
      const memForecast = memForecastFull.slice(0, selectedForecastPoints);
      const diskForecast = diskForecastFull.slice(0, selectedForecastPoints);
      const netForecast = netForecastFull.slice(0, selectedForecastPoints);
      const reqForecast = reqForecastFull.slice(0, selectedForecastPoints);

      const horizonSummary = (hours: number) => {
        const take = Math.max(1, Math.floor(hours));
        const cpuMax = Math.max(...cpuForecastFull.slice(0, take).map((x) => x.predicted), avgCpu);
        const memoryMax = Math.max(...memForecastFull.slice(0, take).map((x) => x.predicted), avgMem);
        const diskMax = Math.max(...diskForecastFull.slice(0, take).map((x) => x.predicted), avgDisk);
        const networkMax = Math.max(...netForecastFull.slice(0, take).map((x) => x.predicted), avgNet);
        const saturationEvents = [cpuMax >= 85, memoryMax >= 85, diskMax >= 80, networkMax >= 80].filter(Boolean).length;
        return {
          cpuMax: round1(cpuMax),
          memoryMax: round1(memoryMax),
          diskMax: round1(diskMax),
          networkMax: round1(networkMax),
          saturationEvents,
        };
      };

      const grouped = new Map<string, typeof servers>();
      for (const srv of servers) {
        const key = String(srv.tier ?? srv.role ?? "default");
        const list = grouped.get(key) ?? [];
        list.push(srv);
        grouped.set(key, list);
      }
      const clusters = Array.from(grouped.entries()).map(([name, list]) => {
        const cpus = list.map((s) => Number(resolveServerUtilization(s, liveAppdMetrics).cpu ?? 0));
        const mems = list.map((s) => Number(resolveServerUtilization(s, liveAppdMetrics).memory ?? 0));
        const pendingPods = list.reduce((sum, s) => sum + Number((s.metadata as any)?.pendingPods ?? 0), 0);
        const cpuUsed = round1(avg(cpus));
        const memUsed = round1(avg(mems));
        return {
          clusterId: slugify(name || "cluster"),
          name,
          nodes: list.length,
          cpuUsed,
          memUsed,
          pendingPods,
          riskScore: scoreFromUtilization(cpuUsed, memUsed, round1(avg(list.map((s) => Number(resolveServerUtilization(s, liveAppdMetrics).disk ?? 0)))), 0),
        };
      }).sort((a, b) => b.riskScore - a.riskScore).slice(0, 8);

      const appByDbId = new Map(
        apps
          .filter((a) => Number.isFinite(Number(a.id)))
          .map((a) => [Number(a.id), a] as const),
      );
      const appByExternalId = new Map(
        apps
          .filter((a) => a.externalId != null)
          .map((a) => [String(a.externalId), a] as const),
      );
      const appByName = new Map(
        apps
          .filter((a) => a.name)
          .map((a) => [String(a.name).toLowerCase(), a] as const),
      );

      const mapAppRoute = (risk: any): string => {
        const riskAppId = Number(risk?.appId ?? NaN);
        if (Number.isFinite(riskAppId)) {
          const byDbId = appByDbId.get(riskAppId);
          if (byDbId?.id) return `/applications/${byDbId.id}/capacity`;
          const byExternalId = appByExternalId.get(String(riskAppId));
          if (byExternalId?.id) return `/applications/${byExternalId.id}/capacity`;
        }
        const affectedKey = String(risk?.affectedApp ?? "").trim();
        const matched = (affectedKey && (appByExternalId.get(affectedKey) ?? appByName.get(affectedKey.toLowerCase()))) || null;
        if (matched?.id) return `/applications/${matched.id}/capacity`;
        if (selectedApp?.id) return `/applications/${selectedApp.id}/capacity`;
        return "/capacity-planning/nodes";
      };

      const topRisksFromRows = risksRaw.slice(0, 12).map((r) => {
        const riskId = String(r.riskId);
        return {
          id: riskId,
          riskId,
          entity: r.entityName ?? r.name,
          type: r.entityType ?? "application",
          metric: r.type ?? "Resource",
          current: Math.round(Number(r.current ?? 0)),
          threshold: Math.round(Number(r.threshold ?? 85)),
          hoursToSaturation: r.hoursToSaturation != null ? Math.max(1, Math.round(Number(r.hoursToSaturation))) : null,
          riskScore: Math.round(Number(r.riskScore ?? 0)),
          href: mapAppRoute(r),
          detailHref: `/capacity-planning/detail/${riskId}`,
        };
      });

      const topRisksFallback = (() => {
        if (!servers.length) return [];
        const fallbackRows: Array<{
          id: string;
          riskId: string;
          entity: string;
          type: string;
          metric: string;
          current: number;
          threshold: number;
          hoursToSaturation: number | null;
          riskScore: number;
          href: string;
          detailHref: string;
        }> = [];

        const metricSpecs: Array<{ key: "cpu" | "memory" | "disk" | "network"; label: string; threshold: number; slopePerHour: number }> = [
          { key: "cpu", label: "CPU", threshold: 85, slopePerHour: 0.8 },
          { key: "memory", label: "Memory", threshold: 85, slopePerHour: 0.6 },
          { key: "disk", label: "Disk", threshold: 80, slopePerHour: 0.35 },
          { key: "network", label: "Network", threshold: 80, slopePerHour: 0.55 },
        ];

        for (const server of servers) {
          const util = resolveServerUtilization(server, liveAppdMetrics);
          const mappedApp = appByExternalId.get(String(server.applicationId ?? ""));
          for (const spec of metricSpecs) {
            const raw = Number((util as any)[spec.key] ?? NaN);
            if (!Number.isFinite(raw) || raw <= 0) continue;
            if (raw < 60) continue;
            const current = clamp(Math.round(raw), 0, 100);
            const over = Math.max(0, current - spec.threshold);
            const riskScore = clamp(Math.round((current / spec.threshold) * 78 + over * 2.2), 10, 99);
            const hoursToSaturation = current >= spec.threshold
              ? 1
              : Math.max(2, Math.round((spec.threshold - current) / Math.max(0.2, spec.slopePerHour)));
            const syntheticRiskId = `SYN-${server.id}-${spec.key}`;
            fallbackRows.push({
              id: syntheticRiskId,
              riskId: syntheticRiskId,
              entity: String(server.name ?? server.externalId ?? "Unknown node"),
              type: "server",
              metric: spec.label,
              current,
              threshold: spec.threshold,
              hoursToSaturation,
              riskScore,
              href: mappedApp?.id
                ? `/applications/${mappedApp.id}/capacity`
                : (selectedApp?.id ? `/applications/${selectedApp.id}/capacity` : "/capacity-planning/nodes"),
              detailHref: "",
            });
          }
        }

        return fallbackRows
          .sort((a, b) => b.riskScore - a.riskScore)
          .slice(0, 12);
      })();

      const appLevelSyntheticRisks = (() => {
        const out: Array<{
          id: string;
          riskId: string;
          entity: string;
          type: string;
          metric: string;
          current: number;
          threshold: number;
          hoursToSaturation: number | null;
          riskScore: number;
          href: string;
          detailHref: string;
        }> = [];

        for (const appRow of apps) {
          const appServers = servers.filter((s) => String(s.applicationId ?? "") === String(appRow.externalId ?? ""));
          const appUtils = appServers.map((s) => resolveServerUtilization(s, liveAppdMetrics));
          const cpuFromServers = avg(appUtils.map((u) => Number(u.cpu ?? NaN)).filter((v) => Number.isFinite(v) && v > 0));
          const memFromServers = avg(appUtils.map((u) => Number(u.memory ?? NaN)).filter((v) => Number.isFinite(v) && v > 0));
          const diskFromServers = avg(appUtils.map((u) => Number(u.disk ?? NaN)).filter((v) => Number.isFinite(v) && v > 0));

          const appCpm = Number(appRow.callsPerMinute ?? 0);
          const appResp = Number(appRow.avgResponseTime ?? 0);
          const appErr = Number(appRow.errorRate ?? 0);
          const appViol = Number(appRow.healthRuleViolations ?? 0);
          const derivedCpu = clamp(16 + Math.min(42, appCpm / 28) + Math.min(20, appResp / 120) + Math.min(14, appErr * 7) + Math.min(12, appViol * 1.6), 8, 98);
          const derivedMem = clamp(14 + Math.min(36, appCpm / 32) + Math.min(22, appResp / 150) + Math.min(14, appErr * 6) + Math.min(10, appViol * 1.2), 8, 98);
          const derivedDisk = clamp(10 + Math.min(30, appCpm / 38) + Math.min(18, appErr * 5) + Math.min(10, appViol), 6, 95);

          const cpu = Number.isFinite(cpuFromServers) && cpuFromServers > 0 ? round1(cpuFromServers) : round1(derivedCpu);
          const memory = Number.isFinite(memFromServers) && memFromServers > 0 ? round1(memFromServers) : round1(derivedMem);
          const disk = Number.isFinite(diskFromServers) && diskFromServers > 0 ? round1(diskFromServers) : round1(derivedDisk);
          const riskScore = scoreFromUtilization(cpu, memory, disk, 8);
          if (!Number.isFinite(riskScore)) continue;

          const candidates = [
            { metric: "CPU", current: cpu, threshold: 85, slope: 0.7 },
            { metric: "Memory", current: memory, threshold: 85, slope: 0.55 },
            { metric: "Disk", current: disk, threshold: 80, slope: 0.35 },
          ];
          const strongest = candidates.sort((a, b) => (b.current / b.threshold) - (a.current / a.threshold))[0];
          const current = clamp(Math.round(Number(strongest.current ?? 0)), 0, 100);
          const threshold = strongest.threshold;
          const hoursToSaturation = current >= threshold
            ? 1
            : Math.max(2, Math.round((threshold - current) / Math.max(0.2, strongest.slope)));
          const syntheticRiskId = `SYN-APP-LVL-${appRow.id}`;

          out.push({
            id: syntheticRiskId,
            riskId: syntheticRiskId,
            entity: String(appRow.name ?? appRow.externalId ?? `Application ${appRow.id}`),
            type: "application",
            metric: strongest.metric,
            current,
            threshold,
            hoursToSaturation,
            riskScore: clamp(Math.round((riskScore * 0.7) + (current / threshold) * 30), 10, 99),
            href: `/applications/${appRow.id}/capacity`,
            detailHref: "",
          });
        }

        return out.sort((a, b) => b.riskScore - a.riskScore).slice(0, 12);
      })();

      const selectedAppSignalFallback = (() => {
        if (!selectedApp) return [];
        const metricsForApp = [
          { key: "CPU", current: avgCpu, threshold: 85 },
          { key: "Memory", current: avgMem, threshold: 85 },
          { key: "Disk", current: avgDisk, threshold: 80 },
          { key: "Network", current: avgNet, threshold: 80 },
        ];
        return metricsForApp
          .filter((m) => Number.isFinite(m.current) && m.current > 0)
          .map((m) => {
            const current = clamp(Math.round(Number(m.current)), 0, 100);
            const over = Math.max(0, current - m.threshold);
            const riskScore = clamp(Math.round((current / m.threshold) * 76 + over * 2.4), 10, 99);
            const hoursToSaturation = current >= m.threshold
              ? 1
              : Math.max(2, Math.round((m.threshold - current) / 0.55));
            const syntheticRiskId = `SYN-APP-${selectedApp.id}-${m.key.toLowerCase()}`;
            return {
              id: syntheticRiskId,
              riskId: syntheticRiskId,
              entity: String(selectedApp.name ?? "Selected application"),
              type: "application",
              metric: m.key,
              current,
              threshold: m.threshold,
              hoursToSaturation,
              riskScore,
              href: `/applications/${selectedApp.id}/capacity`,
              detailHref: "",
            };
          })
          .sort((a, b) => b.riskScore - a.riskScore);
      })();

      const topRisks = (() => {
        const merged: Array<any> = [];
        const seen = new Set<string>();
        const pushUnique = (rows: Array<any>) => {
          for (const row of rows) {
            const key = `${String(row.entity ?? "").toLowerCase()}|${String(row.metric ?? "").toLowerCase()}|${String(row.href ?? "")}`;
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(row);
            if (merged.length >= 12) break;
          }
        };

        if (selectedApp) {
          const selectedAppHref = `/applications/${selectedApp.id}/capacity`;
          const selectedScopedRows = topRisksFromRows.filter((r) => String(r.href ?? "") === selectedAppHref);
          pushUnique(selectedScopedRows);
          if (merged.length < 6) pushUnique(selectedAppSignalFallback);
          if (merged.length < 6) pushUnique(topRisksFallback);
        } else {
          pushUnique(topRisksFromRows);
          if (merged.length < 8) pushUnique(appLevelSyntheticRisks);
          if (merged.length < 8) pushUnique(topRisksFallback);
        }

        return merged.slice(0, 12);
      })();

      const saturationTimeline = (topRisksFromRows.length >= 3
        ? risksRaw
          .filter((r) => Number(r.hoursToSaturation ?? 0) > 0)
          .sort((a, b) => Number(a.hoursToSaturation ?? 9999) - Number(b.hoursToSaturation ?? 9999))
          .slice(0, 8)
          .map((r) => ({
            entity: r.entityName ?? r.name,
            metric: r.type ?? "Resource",
            predictedAt: Date.now() + Math.max(1, Math.round(Number(r.hoursToSaturation ?? 1))) * 3600000,
            confidence: clamp(Number(r.confidence ?? 0.7), 0.3, 0.99),
          }))
        : topRisks
          .filter((r) => Number(r.hoursToSaturation ?? 0) > 0)
          .slice(0, 8)
          .map((r) => ({
            entity: r.entity,
            metric: r.metric,
            predictedAt: Date.now() + Math.max(1, Math.round(Number(r.hoursToSaturation ?? 1))) * 3600000,
            confidence: clamp((60 + Number(r.riskScore ?? 0) * 0.35) / 100, 0.35, 0.95),
          })));

      const currentCost = Math.round(Math.max(500, servers.length * 65 + apps.length * 30));
      const predictions = topRisks.slice(0, 4).map((r, idx) => ({
        id: r.id,
        entity: r.entity,
        metric: r.metric,
        severity: r.riskScore >= 85 ? "Critical" : r.riskScore >= 70 ? "High" : "Medium",
        message: `${r.entity} is trending toward ${r.metric} saturation.`,
        action: r.riskScore >= 85 ? "Scale immediately and tighten throttling policies." : "Plan scale-out and rebalance workload.",
        confidence: clamp((70 + r.riskScore * 0.2) / 100, 0.5, 0.96),
        costImpact: `$${Math.max(250, Math.round(r.riskScore * 18)).toLocaleString()}/mo`,
        timeToAction: idx === 0 ? "Now" : `${Math.max(2, Math.round((r.hoursToSaturation ?? 24) / 2))}h`,
      }));

      res.json({
        summary: {
          totalNodes: servers.length,
          criticalNodes,
          warningNodes,
          headroomCpu: round1(100 - avgCpu),
          headroomMemory: round1(100 - avgMem),
          overallRiskScore,
          avgCpuUtilization: avgCpu,
          avgMemoryUtilization: avgMem,
          avgDiskUtilization: avgDisk,
        },
        forecasts: {
          "24h": horizonSummary(24),
          "72h": horizonSummary(72),
          "1w": horizonSummary(7 * 24),
          "3m": horizonSummary(90 * 24),
        },
        metrics: {
          cpu: { historical: cpuHistorical, forecast: cpuForecast, threshold: 85 },
          memory: { historical: memHistorical, forecast: memForecast, threshold: 85 },
          disk: { historical: diskHistorical, forecast: diskForecast, threshold: 80 },
          network: { historical: netHistorical, forecast: netForecast, threshold: 80 },
          requests: { historical: reqHistorical, forecast: reqForecast, threshold: 85 },
        },
        topRisks,
        saturationTimeline,
        clusters,
        aiInsights: {
          costForecast: {
            current: currentCost,
            projected30d: Math.round(currentCost * 1.12),
            projected90d: Math.round(currentCost * 1.28),
            optimized: Math.round(currentCost * 0.84),
          },
          predictions,
          scalingStrategy: topRisks.length
            ? "Prioritize node pools with critical CPU/memory pressure, then apply horizontal autoscaling for high-risk services."
            : "Current utilization is stable. Maintain proactive autoscaling and watch long-term traffic growth.",
        },
      });
    } catch (err: any) {
      console.error("capacity global error:", err);
      res.status(500).json({ message: err?.message ?? "Failed to build capacity planning data" });
    }
  });

  app.get("/api/capacity-planning/nodes", async (req, res) => {
    try {
      const selectedAppId = Number(req.query.appId ?? NaN);
      const selectedApp = Number.isFinite(selectedAppId)
        ? (await db.select().from(dbApplications).where(eq(dbApplications.id, selectedAppId)).limit(1))[0]
        : null;

      const apps = selectedApp?.id
        ? [selectedApp]
        : await db.select({
          id: dbApplications.id,
          name: dbApplications.name,
          externalId: dbApplications.externalId,
          source: dbApplications.source,
        }).from(dbApplications);

      const appByExternalId = new Map(
        apps
          .filter((a) => a.externalId != null)
          .map((a) => [String(a.externalId), a] as const),
      );

      const serverFilter = selectedApp?.externalId ? eq(dbServers.applicationId, selectedApp.externalId) : undefined;
      const servers = serverFilter
        ? await db.select().from(dbServers).where(serverFilter).orderBy(desc(dbServers.lastSyncAt)).limit(500)
        : await db.select().from(dbServers).orderBy(desc(dbServers.lastSyncAt)).limit(1000);

      const nodes = servers.map((s) => {
        const resolved = resolveServerUtilization(s, null);
        const cpu = Number(resolved.cpu ?? 0);
        const memory = Number(resolved.memory ?? 0);
        const disk = Number(resolved.disk ?? 0);
        const network = clamp(Number(resolved.network ?? 0), 0, 100);
        const mappedApp = appByExternalId.get(String(s.applicationId ?? ""));
        const riskScore = scoreFromUtilization(cpu, memory, disk, 0);
        return {
          id: s.id,
          name: s.name,
          role: s.role ?? s.tier ?? "Server",
          tier: s.tier ?? "",
          status: s.status ?? "Healthy",
          cpuUsage: round1(cpu),
          memoryUsage: round1(memory),
          diskUsage: round1(disk),
          networkUsage: round1(network),
          riskScore,
          appId: mappedApp?.id ?? null,
          appName: mappedApp?.name ?? "Unknown Application",
          detailHref: mappedApp?.id ? `/applications/${mappedApp.id}/tier-nodes/${s.id}` : null,
          applicationServersHref: mappedApp?.id ? `/applications/${mappedApp.id}/tier-nodes` : null,
          lastSyncAt: s.lastSyncAt,
        };
      }).sort((a, b) => b.riskScore - a.riskScore);

      const criticalNodes = nodes.filter((n) => n.status.toLowerCase() === "critical" || n.cpuUsage >= 90 || n.memoryUsage >= 90).length;
      const warningNodes = nodes.filter((n) => n.status.toLowerCase() === "warning" || n.cpuUsage >= 80 || n.memoryUsage >= 80).length;

      res.json({
        summary: {
          totalNodes: nodes.length,
          criticalNodes,
          warningNodes,
          avgCpu: round1(avg(nodes.map((n) => n.cpuUsage))),
          avgMemory: round1(avg(nodes.map((n) => n.memoryUsage))),
          avgDisk: round1(avg(nodes.map((n) => n.diskUsage))),
        },
        nodes,
      });
    } catch (err: any) {
      console.error("capacity nodes error:", err);
      res.status(500).json({ message: err?.message ?? "Failed to load capacity nodes" });
    }
  });

  app.get("/api/capacity-planning/applications/:appId", async (req, res) => {
    try {
      const HORIZON_POINTS: Record<string, number> = {
        "24h": 24,
        "72h": 72,
        "1w": 7 * 24,
      };
      const requestedHorizon = String(req.query.horizon ?? "72h");
      const selectedHorizon = Object.prototype.hasOwnProperty.call(HORIZON_POINTS, requestedHorizon)
        ? requestedHorizon
        : "72h";
      const selectedForecastPoints = HORIZON_POINTS[selectedHorizon] ?? 72;

      const appRow = await resolveDbApp(String(req.params.appId));
      if (!appRow) return res.status(404).json({ message: "Application not found" });
      const appDbId = Number(appRow.id);
      if (!Number.isFinite(appDbId)) return res.status(400).json({ message: "Invalid application mapping" });

      const [servers, txRows, errRows, incRows, alertRows, risks] = await Promise.all([
        db.select().from(dbServers).where(eq(dbServers.applicationId, appRow.externalId)).limit(50),
        db.select().from(dbTransactions).where(eq(dbTransactions.applicationId, appRow.externalId)).limit(100),
        db.select().from(dbErrors).where(eq(dbErrors.applicationId, appRow.externalId)).limit(150),
        db.select().from(dbIncidents).where(eq(dbIncidents.applicationId, appRow.externalId)).orderBy(desc(dbIncidents.startTime)).limit(10),
        db.select().from(dbAlerts).where(eq(dbAlerts.applicationId, appRow.externalId)).orderBy(desc(dbAlerts.triggeredAt)).limit(20),
        db.select().from(dbCapacityRisks).where(eq(dbCapacityRisks.appId, appDbId)).orderBy(desc(dbCapacityRisks.riskScore)),
      ]);

      const liveAppdMetrics = appRow.source === "appdynamics"
        ? await getLiveAppdNodeMetrics(appRow.externalId, appRow.credentialId)
        : null;
      const resolvedServerUtils = servers.map((s) => resolveServerUtilization(s, liveAppdMetrics));
      const cpuVals = resolvedServerUtils
        .map((s) => Number(s.cpu ?? NaN))
        .filter((v) => Number.isFinite(v) && v > 0);
      const memVals = resolvedServerUtils
        .map((s) => Number(s.memory ?? NaN))
        .filter((v) => Number.isFinite(v) && v > 0);
      let cpu = round1(avg(cpuVals));
      let memory = round1(avg(memVals));
      const requests = Math.round(Number(appRow.callsPerMinute ?? avg(txRows.map((t) => Number(t.callsPerMinute ?? 0)))));
      const errorRate = round1(Number(appRow.errorRate ?? avg(errRows.map((e) => Number(e.frequency ?? 0) / 100))));
      const p99 = Math.round(Math.max(Number(appRow.avgResponseTime ?? 0), ...txRows.map((t) => Number(t.avgResponseTime ?? 0))));
      if (servers.length === 0 || (cpu <= 0 && memory <= 0)) {
        const derived = deriveUtilizationFromSignals({
          appRow,
          txRows,
          errRows,
          alertRows,
          incRows,
          risksRaw: risks,
        });
        cpu = derived.cpu;
        memory = derived.memory;
      }

      const activeAlerts = alertRows.filter((a) => (a.status ?? "").toLowerCase() !== "resolved").length;
      const criticalIncidents = incRows.filter((i) => (i.severity ?? "").toLowerCase() === "critical").length;
      const slaPenalty = Math.min(55, activeAlerts * 2 + criticalIncidents * 7 + Math.floor(errorRate * 2) + Math.floor(p99 / 500));
      const slaScore = clamp(98 - slaPenalty, 25, 99);
      const riskScore = risks.length ? Math.round(avg(risks.map((r) => Number(r.riskScore ?? 0)))) : scoreFromUtilization(cpu, memory, Math.max(30, errorRate * 8), 8);

      const cpuRisk = risks.find((r) => (r.type ?? "").toLowerCase() === "cpu");
      const memRisk = risks.find((r) => (r.type ?? "").toLowerCase().includes("mem"));
      const hoursToSaturation = {
        cpu: cpuRisk?.hoursToSaturation != null ? Math.max(1, Math.round(Number(cpuRisk.hoursToSaturation))) : null,
        memory: memRisk?.hoursToSaturation != null ? Math.max(1, Math.round(Number(memRisk.hoursToSaturation))) : null,
      };

      const cpuHistorical = series(cpu, -0.15);
      const memoryHistorical = series(memory, -0.12);
      const requestsHistorical = series(clamp(requests / 12, 0, 100), -0.1);
      const errorHistorical = series(clamp(errorRate * 12, 0, 100), -0.03);
      const maxForecastPoints = HORIZON_POINTS["1w"];
      const cpuForecastFull = forecastFromLast(cpuHistorical[cpuHistorical.length - 1]?.value ?? cpu, 0.32, maxForecastPoints);
      const memoryForecastFull = forecastFromLast(memoryHistorical[memoryHistorical.length - 1]?.value ?? memory, 0.3, maxForecastPoints);
      const requestsForecastFull = forecastFromLast(requestsHistorical[requestsHistorical.length - 1]?.value ?? 45, 0.25, maxForecastPoints);
      const errorForecastFull = forecastFromLast(errorHistorical[errorHistorical.length - 1]?.value ?? 15, 0.12, maxForecastPoints);
      const forecasts = {
        cpu: { historical: cpuHistorical, forecast: cpuForecastFull.slice(0, selectedForecastPoints), threshold: 85 },
        memory: { historical: memoryHistorical, forecast: memoryForecastFull.slice(0, selectedForecastPoints), threshold: 85 },
        requests: { historical: requestsHistorical, forecast: requestsForecastFull.slice(0, selectedForecastPoints), threshold: 80 },
        errorRate: { historical: errorHistorical, forecast: errorForecastFull.slice(0, selectedForecastPoints), threshold: 40 },
      };

      const services = txRows.slice(0, 12).map((t, idx) => {
        const svcCpu = clamp(Math.round(cpu * (0.7 + (idx % 4) * 0.08)), 10, 100);
        const svcMem = clamp(Math.round(memory * (0.68 + (idx % 3) * 0.1)), 10, 100);
        const svcRisk = clamp(Math.round(svcCpu * 0.45 + svcMem * 0.35 + Number(t.errorRate ?? 0) * 8), 0, 100);
        const saturationInHours = svcRisk >= 80 ? Math.max(2, 36 - svcRisk / 2) : null;
        return {
          name: t.name,
          cpu: svcCpu,
          memory: svcMem,
          requests: Math.round(Number(t.callsPerMinute ?? 0)),
          riskScore: svcRisk,
          saturationIn: saturationInHours ? `${Math.round(saturationInHours)}h` : null,
        };
      });

      const growthRate = clamp(Math.round(6 + Math.min(14, requests / 400) + Math.min(8, activeAlerts / 3)), 2, 28);
      const trafficGrowth = {
        current: requests,
        projected30d: Math.round(requests * (1 + growthRate / 100)),
        projected90d: Math.round(requests * (1 + (growthRate * 2.6) / 100)),
        growthRate,
        peakHour: "14:00 - 16:00",
      };

      const recommendations = [
        {
          id: "app-cap-1",
          action: cpu >= 85 ? "Scale application compute tier horizontally." : "Keep autoscaling policy but lower trigger threshold.",
          priority: cpu >= 85 ? "Critical" : "Medium",
          confidence: clamp((65 + cpu * 0.25) / 100, 0.5, 0.95),
          costImpact: `$${Math.max(300, Math.round(cpu * 20)).toLocaleString()}/mo`,
          estimatedTimeToScale: "30-45 mins",
        },
        {
          id: "app-cap-2",
          action: errorRate >= 5 ? "Investigate top error clusters and reduce retry storms." : "Tune request limits for predictable traffic spikes.",
          priority: errorRate >= 5 ? "High" : "Low",
          confidence: clamp((60 + errorRate * 5) / 100, 0.45, 0.92),
          costImpact: `$${Math.max(120, Math.round((errorRate + 1) * 60)).toLocaleString()}/mo`,
          estimatedTimeToScale: "15-25 mins",
        },
      ];

      const incidentCorrelation = incRows.slice(0, 5).map((inc) => ({
        id: inc.externalId,
        title: inc.title,
        capacityFactor: cpu >= 80 || memory >= 80 ? "High resource saturation during incident window" : "Traffic saturation and scaling lag",
        href: `/incidents/${inc.externalId}`,
      }));

      res.json({
        appName: appRow.name,
        riskScore,
        current: { cpu, memory, requests, errorRate, p99, slaScore },
        headroom: { cpu: round1(100 - cpu), memory: round1(100 - memory) },
        hoursToSaturation,
        forecasts,
        services,
        trafficGrowth,
        recommendations,
        incidentCorrelation,
      });
    } catch (err: any) {
      console.error("capacity app error:", err);
      res.status(500).json({ message: err?.message ?? "Failed to build application capacity data" });
    }
  });

  app.get("/api/capacity-planning/cluster/:clusterId", async (req, res) => {
    try {
      const clusterId = String(req.params.clusterId ?? "").toLowerCase();
      const allServers = await db.select().from(dbServers);
      const groups = new Map<string, typeof allServers>();
      for (const srv of allServers) {
        const groupName = String(srv.tier ?? srv.role ?? "default");
        const list = groups.get(groupName) ?? [];
        list.push(srv);
        groups.set(groupName, list);
      }

      const matchedEntry = Array.from(groups.entries()).find(([name]) => slugify(name) === clusterId)
        ?? (clusterId === "k8s-prod" ? ["k8s-prod", allServers] as [string, typeof allServers] : null);
      const clusterName = matchedEntry?.[0] ?? (clusterId || "default");
      const servers = matchedEntry?.[1] ?? [];
      const appExternalIds = Array.from(new Set(
        servers
          .map((s) => String(s.applicationId ?? "").trim())
          .filter((v) => v.length > 0)
      ));
      const relatedApps = appExternalIds.length > 0
        ? await db.select({ id: dbApplications.id, name: dbApplications.name, externalId: dbApplications.externalId })
          .from(dbApplications)
          .where(appExternalIds.length === 1
            ? eq(dbApplications.externalId, appExternalIds[0])
            : sql`${dbApplications.externalId} = ANY(ARRAY[${sql.join(appExternalIds.map((id) => sql`${id}`), sql`, `)}]::text[])`)
        : [];
      const relatedDbAppIds = relatedApps.map((a) => a.id);
      const [relatedAlerts, relatedIncidents] = relatedDbAppIds.length > 0
        ? await Promise.all([
            db.select({ id: dbAlerts.id, status: dbAlerts.status, severity: dbAlerts.severity })
              .from(dbAlerts)
              .where(appExternalIds.length === 1
                ? eq(dbAlerts.applicationId, appExternalIds[0])
                : sql`${dbAlerts.applicationId} = ANY(ARRAY[${sql.join(appExternalIds.map((id) => sql`${id}`), sql`, `)}]::text[])`)
              .limit(400),
            db.select({ id: dbIncidents.id, status: dbIncidents.status })
              .from(dbIncidents)
              .where(appExternalIds.length === 1
                ? eq(dbIncidents.applicationId, appExternalIds[0])
                : sql`${dbIncidents.applicationId} = ANY(ARRAY[${sql.join(appExternalIds.map((id) => sql`${id}`), sql`, `)}]::text[])`)
              .limit(250),
          ])
        : [[], []];

      const cpuUsedPct = round1(avg(servers.map((s) => normalizePercent(s.cpuUsage ?? extractMetricFromMetadata(s.metadata, [/cpu/, /usagepercent/])))));
      const memUsedPct = round1(avg(servers.map((s) => normalizePercent(s.memoryUsage ?? extractMetricFromMetadata(s.metadata, [/mem/, /memory/, /ram/])))));
      const diskUsedPct = round1(avg(servers.map((s) => normalizePercent(s.diskUsage ?? extractMetricFromMetadata(s.metadata, [/disk/, /storage/, /filesystem/])))));

      const nodes = servers.length;
      const pods = servers.reduce((sum, s) => sum + Number((s.metadata as any)?.pods ?? 12), 0);
      const pendingPods = servers.reduce((sum, s) => sum + Number((s.metadata as any)?.pendingPods ?? 0), 0);
      const cpuAllocatable = Math.max(nodes * 8, 1);
      const memAllocatable = Math.max(nodes * 32, 1);
      const storageGb = Math.max(nodes * 500, 1);
      const cpuUsed = round1((cpuUsedPct / 100) * cpuAllocatable);
      const memUsed = round1((memUsedPct / 100) * memAllocatable);
      const storageUsedGb = round1((diskUsedPct / 100) * storageGb);

      const poolGroups = new Map<string, typeof servers>();
      for (const srv of servers) {
        const poolName = String(srv.role ?? srv.tier ?? "general");
        const list = poolGroups.get(poolName) ?? [];
        list.push(srv);
        poolGroups.set(poolName, list);
      }
      const nodePools = Array.from(poolGroups.entries()).map(([name, list]) => {
        const poolNodes = list.length;
        const poolCpuPct = avg(list.map((s) => normalizePercent(s.cpuUsage ?? extractMetricFromMetadata(s.metadata, [/cpu/, /usagepercent/]))));
        const poolMemPct = avg(list.map((s) => normalizePercent(s.memoryUsage ?? extractMetricFromMetadata(s.metadata, [/mem/, /memory/, /ram/]))));
        const poolPods = list.reduce((sum, s) => sum + Number((s.metadata as any)?.pods ?? 10), 0);
        const poolMaxPods = Math.max(poolNodes * 32, 1);
        const score = scoreFromUtilization(poolCpuPct, poolMemPct, 40, 0);
        return {
          name,
          status: score >= 85 ? "Critical" : score >= 70 ? "Warning" : "Healthy",
          nodes: poolNodes,
          pods: poolPods,
          maxPods: poolMaxPods,
          cpuAllocatable: Math.max(poolNodes * 8, 1),
          memAllocatable: Math.max(poolNodes * 32, 1),
          cpuUsed: round1((poolCpuPct / 100) * Math.max(poolNodes * 8, 1)),
          memUsed: round1((poolMemPct / 100) * Math.max(poolNodes * 32, 1)),
        };
      }).sort((a, b) => (b.cpuUsed + b.memUsed) - (a.cpuUsed + a.memUsed));

      const cpuHistorical = series(cpuUsedPct, -0.18);
      const memHistorical = series(memUsedPct, -0.14);
      const cpuForecast = forecastFromLast(cpuHistorical[cpuHistorical.length - 1]?.value ?? cpuUsedPct, 0.3);
      const memForecast = forecastFromLast(memHistorical[memHistorical.length - 1]?.value ?? memUsedPct, 0.27);
      const daysToNewNode = cpuUsedPct >= 80 || memUsedPct >= 80 ? Math.max(2, Math.round((95 - Math.max(cpuUsedPct, memUsedPct)) / 2)) : null;
      const clusterMetadata = servers
        .map((s) => ((s.metadata as any) ?? {}))
        .filter((m) => m && typeof m === "object");
      const pickMostCommon = (values: string[]) => {
        const counts = new Map<string, number>();
        for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
        return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
      };
      const envCandidates = clusterMetadata
        .map((m) => String(m.environment ?? m.env ?? m.clusterEnvironment ?? "").trim())
        .filter(Boolean);
      const regionCandidates = clusterMetadata
        .map((m) => String(m.region ?? m.cloudRegion ?? m.location ?? m.zone ?? "").trim())
        .filter(Boolean);
      const versionCandidates = clusterMetadata
        .map((m) => String(m.k8sVersion ?? m.clusterVersion ?? m.version ?? "").trim())
        .filter(Boolean);
      const environment = pickMostCommon(envCandidates) || (clusterName.toLowerCase().includes("prod") ? "Production" : "Non-Production");
      const region = pickMostCommon(regionCandidates) || "Unknown";
      const version = pickMostCommon(versionCandidates) || "Unknown";

      const autoscalerEvents = [
        ...(daysToNewNode ? [{ ts: Date.now() - 2 * 3600000, type: "ScaleOut", detail: "Added one node due to sustained >80% utilization", status: "Completed" }] : []),
        ...(pendingPods > 0 ? [{ ts: Date.now() - 50 * 60000, type: "ScaleOut", detail: `${pendingPods} pending pods triggered scaling policy`, status: "Completed" }] : []),
      ];

      const throttlingEvents = (cpuUsedPct >= 85 || memUsedPct >= 90) ? [{
        service: "api-gateway",
        ts: Date.now() - 75 * 60000,
        duration: "8m",
        reason: cpuUsedPct >= 85 ? "CPU throttling under burst traffic" : "Container memory pressure (near OOM)",
        impact: "Elevated p95 latency and intermittent request retries",
      }] : [];

      const recommendations = [
        {
          id: "cluster-1",
          action: cpuUsedPct >= 85 ? "Add at least 1 worker node and rebalance pods." : "Keep current node count and monitor CPU trend.",
          priority: cpuUsedPct >= 85 ? "Critical" : "Low",
          confidence: clamp((65 + cpuUsedPct * 0.25) / 100, 0.5, 0.95),
          costImpact: `$${Math.max(180, Math.round((nodes * 42) + cpuUsedPct * 12)).toLocaleString()}/mo`,
        },
        {
          id: "cluster-2",
          action: pendingPods > 0
            ? "Increase max pod density or add dedicated pool for burst workloads."
            : (relatedAlerts.filter((a) => String(a.status ?? "").toLowerCase() !== "resolved").length > 0
              ? "Reduce alert pressure by tuning resource requests/limits on top noisy workloads."
              : "Tune autoscaler cooldown to avoid oscillations."),
          priority: pendingPods > 0
            ? "High"
            : (relatedAlerts.filter((a) => String(a.status ?? "").toLowerCase() !== "resolved").length > 0 ? "Medium" : "Low"),
          confidence: pendingPods > 0 ? 0.87 : 0.72,
          costImpact: pendingPods > 0
            ? `$${Math.max(300, Math.round(nodes * 35)).toLocaleString()}/mo`
            : `$${Math.max(90, Math.round(nodes * 9)).toLocaleString()}/mo`,
        },
        {
          id: "cluster-3",
          action: relatedIncidents.filter((i) => String(i.status ?? "").toLowerCase() !== "resolved").length > 0
            ? "Investigate active incidents linked to this cluster before the next traffic window."
            : "No active incidents detected; continue proactive saturation monitoring.",
          priority: relatedIncidents.filter((i) => String(i.status ?? "").toLowerCase() !== "resolved").length > 0 ? "High" : "Info",
          confidence: relatedIncidents.length > 0 ? 0.79 : 0.64,
          costImpact: "Operational",
        },
      ];

      res.json({
        clusterName,
        environment,
        version,
        region,
        current: {
          nodes,
          pods,
          pendingPods,
          cpuUsed,
          cpuAllocatable,
          memUsed,
          memAllocatable,
          storageUsedGb,
          storageGb,
        },
        nodePools,
        forecasts: {
          cpu: { historical: cpuHistorical, forecast: cpuForecast, threshold: 85 },
          memory: { historical: memHistorical, forecast: memForecast, threshold: 85 },
        },
        autoscalerEvents,
        throttlingEvents,
        daysToNewNode,
        recommendations,
        relatedApps: relatedApps.map((a) => ({ id: a.id, name: a.name, externalId: a.externalId })),
        relatedCounts: {
          alerts: relatedAlerts.length,
          activeAlerts: relatedAlerts.filter((a) => String(a.status ?? "").toLowerCase() !== "resolved").length,
          incidents: relatedIncidents.length,
          openIncidents: relatedIncidents.filter((i) => String(i.status ?? "").toLowerCase() !== "resolved").length,
        },
      });
    } catch (err: any) {
      console.error("capacity cluster error:", err);
      res.status(500).json({ message: err?.message ?? "Failed to build cluster capacity data" });
    }
  });
  // === Correlation Graph — build from real DB entities ===
  app.get("/api/correlation/graph", async (req, res) => {
    const entityId = String(req.query.entityId ?? "");
    const type = String(req.query.type ?? "");
    if (!entityId || entityId === "undefined") return res.json({ nodes: [], edges: [], summary: {} });
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
        } else if (/^PRED-(.+)$/i.test(exId)) {
          const appLookupId = exId.replace(/^PRED-/i, "");
          const app = await resolveDbApp(appLookupId);
          const appExternalId = app?.externalId ?? appLookupId;
          nodes.push({ id: exId, type: "incident", label: `Predicted incident ${exId}`, severity: "Warning" });
          const [relErrors, relAlerts, relServers] = await Promise.all([
            db.select().from(dbErrors).where(eq(dbErrors.applicationId, appExternalId)).limit(4),
            db.select().from(dbAlerts).where(eq(dbAlerts.applicationId, appExternalId)).limit(4),
            db.select().from(dbServers).where(eq(dbServers.applicationId, appExternalId)).limit(3),
          ]);
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
      const summary = nodes.reduce((acc: Record<string, number>, n: any) => {
        const key = n?.type === "incident"
          ? "incidents"
          : n?.type === "alert"
            ? "alerts"
            : n?.type === "error"
              ? "errors"
              : n?.type === "node"
                ? "nodes"
                : n?.type === "transaction"
                  ? "transactions"
                  : n?.type === "deployment"
                    ? "deployments"
                    : null;
        if (key) acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});
      return res.json({ nodes, edges, summary });
    } catch { return res.json({ nodes: [], edges: [], summary: {} }); }
  });
  // === Related entity lookups — real DB data ===
  app.get("/api/incidents/:incidentId/related", async (req, res) => {
    const { incidentId } = req.params;
    try {
      const [inc] = await db.select().from(dbIncidents).where(eq(dbIncidents.externalId, incidentId));
      let appExternalId: string | null = inc?.applicationId ?? null;
      if (!appExternalId) {
        const predMatch = /^PRED-(.+)$/i.exec(incidentId);
        if (predMatch) {
          const appLookupId = predMatch[1];
          const resolved = await resolveDbApp(appLookupId);
          appExternalId = resolved?.externalId ?? appLookupId;
        }
      }
      if (!appExternalId) return res.json({ alerts: [], errors: [], nodes: [] });
      const [app] = await db.select({ id: dbApplications.id, name: dbApplications.name }).from(dbApplications).where(eq(dbApplications.externalId, appExternalId));
      // Keep related drilldown counts aligned with correlation bar chips.
      const alerts = await db.select().from(dbAlerts).where(eq(dbAlerts.applicationId, appExternalId)).limit(4);
      const rawErrors = await db.select().from(dbErrors).where(eq(dbErrors.applicationId, appExternalId)).orderBy(desc(dbErrors.lastOccurrence)).limit(120);
      const normalizeRelatedError = (e: any) => {
        const md: any = e.metadata ?? {};
        const detail0 = Array.isArray(md?.errorDetails) && md.errorDetails.length > 0 ? md.errorDetails[0] : null;
        const rawType = String(detail0?.name ?? md?.subType ?? e.errorType ?? "Application Error").trim();
        const rawMessage = String(
          detail0?.value ??
          md?.errorSummary ??
          md?.summary ??
          e.message ??
          e.cluster ??
          "Application Error"
        ).replace(/\s+/g, " ").trim();
        const isDiagnostic = (v: string) => v.toUpperCase().includes("DIAGNOSTIC_SESSION");
        let normalizedType = rawType;
        let normalizedMessage = rawMessage;
        if (isDiagnostic(normalizedType) || isDiagnostic(normalizedMessage)) {
          const summary = String(md?.summary ?? md?.errorSummary ?? "").trim();
          const summaryTail = summary.includes(" - ") ? summary.split(" - ").slice(1).join(" - ") : summary;
          const cleaned = summaryTail.replace(/\[Stacktrace Processing Limit Reached\]/gi, "").replace(/\s+/g, " ").trim();
          if (cleaned.length > 0) {
            const exceptionMatch = cleaned.match(/\b([A-Za-z0-9_$.]*(Exception|Error))\b/);
            const inferredType = String(exceptionMatch?.[1] ?? cleaned.split(/\s+/)[0] ?? "").replace(/[:]+$/g, "").trim();
            if (inferredType && !isDiagnostic(inferredType)) normalizedType = inferredType;
            if (!isDiagnostic(cleaned)) normalizedMessage = cleaned;
          }
        }
        const requestPath = String(md?.requestPath ?? md?.URL ?? "").trim() || null;
        const businessTransaction = String(md?.businessTransactionName ?? "").trim() || null;
        const callToCheck = String(md?.requestGUID ?? "").trim() || requestPath || businessTransaction || null;
        const rootCause = normalizedMessage || null;
        const signature = `${normalizedType}|${requestPath ?? ""}|${normalizedMessage}`
          .toLowerCase()
          .replace(/[^a-z0-9|/_\-\s:.]/g, "")
          .replace(/\s+/g, "-")
          .slice(0, 180);
        return {
          errorId: `ERR-${e.id}`,
          type: normalizedType || "Application Error",
          message: normalizedMessage.substring(0, 140),
          severity: e.severity,
          occurrences: Number(e.frequency ?? 1),
          correlationScore: 0.8,
          clusterId: e.cluster ?? `SIG-${signature}`,
          source: e.source === "appdynamics" ? "AppDynamics" : "Dynatrace",
          timestamp: e.lastOccurrence?.getTime() ?? Date.now(),
          appId: e.applicationId ?? null,
          applicationName: e.applicationName ?? null,
          service: String(e.service ?? businessTransaction ?? md?.tierName ?? "Unknown Service"),
          server: String(md?.nodeName ?? md?.applicationComponentNodeName ?? md?.triggeredEntity?.name ?? "N/A"),
          firstSeen: e.firstSeen?.getTime() ?? null,
          lastSeen: e.lastOccurrence?.getTime() ?? null,
          requestPath,
          businessTransaction,
          callToCheck,
          rootCause,
          recommendation: null,
          isDiagnostic: isDiagnostic(normalizedType) || isDiagnostic(normalizedMessage),
        };
      };
      const normalizedErrors = rawErrors.map(normalizeRelatedError)
        .sort((a, b) => (Number(b.occurrences ?? 0) - Number(a.occurrences ?? 0)) || (Number(b.timestamp ?? 0) - Number(a.timestamp ?? 0)));
      const nonDiagnosticErrors = normalizedErrors.filter((e) => !e.isDiagnostic);
      const errors = (nonDiagnosticErrors.length > 0 ? nonDiagnosticErrors : normalizedErrors).slice(0, 4);
      const nodes = await db.select().from(dbServers).where(eq(dbServers.applicationId, appExternalId)).limit(3);
      return res.json({
        alerts: alerts.map(a => ({ alertId: `ALT-${a.id}`, entity: a.name, severity: a.severity, status: a.status, timestamp: a.triggeredAt?.getTime(), correlationScore: 0.82, source: a.source === "appdynamics" ? "AppDynamics" : "Dynatrace", rule: a.name, applicationId: app?.id ?? null, applicationName: app?.name ?? null })),
        errors: errors.map(({ isDiagnostic, ...row }) => row),
        nodes: nodes.map(n => ({ nodeDbId: n.id, nodeId: n.externalId ?? String(n.id), name: n.name, status: n.status, cpuUsage: n.cpuUsage, memoryUsage: n.memoryUsage, correlationScore: 0.78, role: n.role ?? "Server", correlationType: "Affected during incident window", href: app?.id ? `/applications/${app.id}/servers/${n.id}` : `/servers` })),
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
      const nodeKeys = [
        canonicalNodeKey(server.name),
        canonicalNodeKey(server.ip),
        canonicalNodeKey((server.metadata as any)?.machineName),
      ].filter(Boolean);

      // AppDynamics path: build concrete, request-level error rows from snapshots
      // to avoid repetitive generic cluster messages.
      if (server.source === "appdynamics" && server.applicationId) {
        const [appRow] = await db.select().from(dbApplications).where(eq(dbApplications.externalId, String(server.applicationId)));
        if (appRow?.externalId) {
          const live = await getLiveAppdClient(appRow.externalId, appRow.credentialId);
          if (live) {
            const txRows = await db.select().from(dbTransactions)
              .where(and(eq(dbTransactions.applicationId, appRow.externalId), eq(dbTransactions.source, "appdynamics")))
              .orderBy(desc(dbTransactions.errorRate), desc(dbTransactions.updatedAt))
              .limit(30);

            const hasError = (s: any) =>
              Boolean(s?.errorOccured) ||
              (Array.isArray(s?.errorDetails) && s.errorDetails.length > 0) ||
              String(s?.errorSummary ?? "").trim().length > 0;
            const belongsToNode = (s: any) => {
              const snapKeys = [
                canonicalNodeKey((s as any)?.applicationComponentNodeName),
                canonicalNodeKey((s as any)?.nodeName),
                canonicalNodeKey((s as any)?.applicationComponentName),
                canonicalNodeKey((s as any)?.tierName),
              ].filter(Boolean);
              return snapKeys.some((k) => nodeKeys.includes(k));
            };
            const makeGroupedMap = () => new Map<string, {
              errorId: string;
              type: string;
              message: string;
              severity: string;
              occurrences: number;
              requestPath: string | null;
              rootCause: string | null;
              firstSeen: number | null;
              lastSeen: number | null;
            }>();
            const groupedNode = makeGroupedMap();
            const groupedApp = makeGroupedMap();
            let snapCount = 0;
            const isDiagnosticNoise = (text: string) => String(text ?? "").toUpperCase().includes("DIAGNOSTIC_SESSION");
            const addGrouped = (grouped: ReturnType<typeof makeGroupedMap>, row: {
              errorId: string;
              type: string;
              message: string;
              severity: string;
              requestPath: string | null;
              rootCause: string | null;
              ts: number;
            }) => {
              const signature = `${row.type}|${row.requestPath ?? ""}|${row.message}`.toLowerCase();
              const existing = grouped.get(signature);
              if (!existing) {
                grouped.set(signature, {
                  errorId: row.errorId,
                  type: row.type,
                  message: row.message,
                  severity: row.severity,
                  occurrences: 1,
                  requestPath: row.requestPath,
                  rootCause: row.rootCause,
                  firstSeen: row.ts,
                  lastSeen: row.ts,
                });
              } else {
                existing.occurrences += 1;
                existing.lastSeen = Math.max(Number(existing.lastSeen ?? row.ts), row.ts);
                existing.firstSeen = Math.min(Number(existing.firstSeen ?? row.ts), row.ts);
              }
            };

            for (const tx of txRows) {
              if (snapCount >= 120) break;
              const btIdNum = Number(tx.externalId ?? NaN);
              if (!Number.isFinite(btIdNum)) continue;
              const snaps = await live.client.getRequestSnapshots(live.appNum, btIdNum, 180).catch(() => []);
              for (const s of Array.isArray(snaps) ? snaps : []) {
                if (!hasError(s) || !belongsToNode(s)) continue;
                snapCount++;
                const ts = Number(s?.localStartTime ?? s?.serverStartTime ?? NaN);
                if (!Number.isFinite(ts)) continue;
                const path = String(s?.URL ?? "").trim();
                const detail0 = Array.isArray(s?.errorDetails) && s.errorDetails.length > 0 ? s.errorDetails[0] : null;
                const errType = String(detail0?.name ?? "Business Transaction Error").trim();
                const rootCause = String(detail0?.value ?? s?.errorSummary ?? s?.summary ?? "").trim();
                const message = rootCause || `${errType} on request path`;
                if (isDiagnosticNoise(errType) || isDiagnosticNoise(message) || isDiagnosticNoise(rootCause)) continue;
                const row = {
                  errorId: `SNAP-${live.appNum}-${btIdNum}-${ts}`,
                  type: errType,
                  message,
                  severity: "High",
                  requestPath: path || null,
                  rootCause: rootCause || null,
                  ts,
                };
                addGrouped(groupedApp, row);
                if (belongsToNode(s)) addGrouped(groupedNode, row);
              }
            }

            const snapshotErrors = Array.from((groupedNode.size > 0 ? groupedNode : groupedApp).values())
              .sort((a, b) => (b.occurrences - a.occurrences) || (Number(b.lastSeen ?? 0) - Number(a.lastSeen ?? 0)))
              .slice(0, 20);
            if (snapshotErrors.length > 0) {
              return res.json({
                incidents: incidents.map(i => ({ id: i.externalId, title: i.title, severity: i.severity, status: i.status })),
                alerts: alerts.map(a => ({ alertId: `ALT-${a.id}`, entity: a.name, severity: a.severity, status: a.status })),
                errors: snapshotErrors,
              });
            } else {
              // When AppDynamics is connected but no concrete snapshot errors are found,
              // return an empty list instead of noisy diagnostic cluster fallbacks.
              return res.json({
                incidents: incidents.map(i => ({ id: i.externalId, title: i.title, severity: i.severity, status: i.status })),
                alerts: alerts.map(a => ({ alertId: `ALT-${a.id}`, entity: a.name, severity: a.severity, status: a.status })),
                errors: [],
              });
            }
          }
        }
      }

      const appErrors = await db.select().from(dbErrors)
        .where(eq(dbErrors.applicationId, server.applicationId ?? ""))
        .orderBy(desc(dbErrors.lastOccurrence))
        .limit(250);
      const nonDiagnosticErrors = appErrors.filter((e) => {
        const t = String(e.errorType ?? "").toUpperCase();
        const m = String(e.message ?? "").toUpperCase();
        return t !== "DIAGNOSTIC_SESSION" && !m.includes("DIAGNOSTIC_SESSION");
      });
      const isNodeError = (e: any) => {
        const m = (e?.metadata as any) ?? {};
        const candidates = [
          m?.nodeName,
          m?.applicationComponentNodeName,
          m?.triggeredEntity?.name,
          m?.machineName,
          m?.applicationComponentName,
        ]
          .map((v: any) => canonicalNodeKey(v))
          .filter(Boolean);
        if (candidates.length === 0) return false;
        return candidates.some((c: string) => nodeKeys.includes(c));
      };
      const nodeErrors = nonDiagnosticErrors.filter((e) => isNodeError(e));
      const errors = (nodeErrors.length > 0 ? nodeErrors : nonDiagnosticErrors).slice(0, 20);
      return res.json({
        incidents: incidents.map(i => ({ id: i.externalId, title: i.title, severity: i.severity, status: i.status })),
        alerts: alerts.map(a => ({ alertId: `ALT-${a.id}`, entity: a.name, severity: a.severity, status: a.status })),
        errors: errors.map(e => ({
          // Normalize fallback DB rows to look closer to AppDynamics-style concrete errors.
          // Prefer detailed metadata fields over generic cluster/session text.
          ...(() => {
            const md: any = e.metadata ?? {};
            const detail0 = Array.isArray(md?.errorDetails) && md.errorDetails.length > 0 ? md.errorDetails[0] : null;
            const normalizedType = String(detail0?.name ?? e.errorType ?? "Application Error").trim();
            const normalizedRootCause = String(
              detail0?.value ??
              md?.errorSummary ??
              md?.summary ??
              e.message ??
              ""
            ).trim();
            const normalizedMessage = normalizedRootCause || String(e.message ?? e.cluster ?? "Application Error").trim();
            const normalizedPath = String(md?.requestPath ?? md?.URL ?? "").trim() || null;
            return {
              type: normalizedType,
              message: normalizedMessage.substring(0, 120),
              requestPath: normalizedPath,
              rootCause: normalizedRootCause || null,
            };
          })(),
          errorId: `ERR-${e.id}`,
          severity: e.severity,
          occurrences: Number(e.frequency ?? 1),
          firstSeen: e.firstSeen?.getTime() ?? null,
          lastSeen: e.lastOccurrence?.getTime() ?? null,
        })),
      });
    } catch { return res.json({ incidents: [], alerts: [], errors: [] }); }
  });
  // === Alerts — org-scoped real data from DB ===
  app.get("/api/alerts", async (req, res) => {
    const incidentIdQ = String((req.query as any)?.incidentId ?? "").trim();
    const appIdQ = String((req.query as any)?.appId ?? "").trim();
    let scopedExternalAppId: string | null = null;
    if (incidentIdQ) {
      const [inc] = await db.select({ applicationId: dbIncidents.applicationId })
        .from(dbIncidents)
        .where(eq(dbIncidents.externalId, incidentIdQ));
      if (inc?.applicationId) {
        scopedExternalAppId = String(inc.applicationId);
      } else {
        const incNum = incidentIdQ.startsWith("INC-") ? Number(incidentIdQ.slice(4)) : NaN;
        if (Number.isFinite(incNum)) {
          const [incByNum] = await db.select({ applicationId: dbIncidents.applicationId })
            .from(dbIncidents)
            .where(eq(dbIncidents.id, incNum));
          if (incByNum?.applicationId) scopedExternalAppId = String(incByNum.applicationId);
        }
      }
      if (!scopedExternalAppId) {
        const predMatch = /^PRED-(.+)$/i.exec(incidentIdQ);
        if (predMatch) {
          const resolved = await resolveDbApp(predMatch[1]);
          if (resolved?.externalId) scopedExternalAppId = String(resolved.externalId);
        }
      }
      // In incident drilldown mode, never fall back to global alerts.
      if (!scopedExternalAppId && !appIdQ) {
        return res.json([]);
      }
    }
    if (!scopedExternalAppId && appIdQ) {
      const resolved = await resolveDbApp(appIdQ);
      if (resolved?.externalId) scopedExternalAppId = String(resolved.externalId);
    }

    const user = req.user as import("@shared/schema").User | undefined;
    let credIds: number[] = [];
    let scopedCreds: Array<{ id: number; source: string }> = [];
    if (user) {
      const orgData = await getUserOrg(user.id);
      if (orgData) {
        const orgCreds = await db.select({ id: apmCredentials.id, source: apmCredentials.source })
          .from(apmCredentials)
          .where(and(eq(apmCredentials.organizationId, orgData.org.id), eq(apmCredentials.isActive, true)));
        scopedCreds = orgCreds;
        credIds = orgCreds.map((c) => c.id);
      }
    }
    if (credIds.length === 0) {
      const activeCreds = await db.select({ id: apmCredentials.id, source: apmCredentials.source })
        .from(apmCredentials)
        .where(eq(apmCredentials.isActive, true));
      scopedCreds = activeCreds;
      credIds = activeCreds.map((c) => c.id);
    }
    if (credIds.length === 0) return res.json([]);

    // Map to unified alert format for currently active apps only.
    const appRows = await db.select({ id: dbApplications.id, externalId: dbApplications.externalId, name: dbApplications.name })
      .from(dbApplications)
      .where(credIds.length === 1
        ? eq(dbApplications.credentialId, credIds[0])
        : sql`${dbApplications.credentialId} = ANY(ARRAY[${sql.join(credIds.map(id => sql`${id}`), sql`, `)}]::integer[])`);
    if (appRows.length === 0) return res.json([]);
    const appNameMap: Record<string, string> = Object.fromEntries(appRows.map(a => [a.externalId ?? "", a.name]));

    let dbAlertRows = await db.select().from(dbAlerts)
      .where(credIds.length === 1
        ? sql`${dbAlerts.applicationId} IN (SELECT external_id::text FROM apm_applications WHERE credential_id = ${credIds[0]})`
        : sql`${dbAlerts.applicationId} IN (SELECT external_id::text FROM apm_applications WHERE credential_id = ANY(ARRAY[${sql.join(credIds.map(id => sql`${id}`), sql`, `)}]::integer[]))`)
      .orderBy(desc(dbAlerts.triggeredAt))
      .limit(200);
    if (scopedExternalAppId) {
      dbAlertRows = dbAlertRows.filter((a) => String(a.applicationId ?? "") === scopedExternalAppId);
    }

    // Keep request path fast: if empty, trigger background AppDynamics sync and return immediately.
    if (dbAlertRows.length === 0) {
      const appdCredIds = scopedCreds.filter((c) => c.source === "appdynamics").map((c) => c.id);
      for (const id of appdCredIds) {
        void syncSource("appdynamics", id).catch(() => undefined);
      }
      return res.json([]);
    }
    const normSeverity = (sev?: string | null) => {
      const s = String(sev ?? "").trim();
      if (s === "Warning") return "Medium";
      if (s === "Info") return "Low";
      if (s === "Error") return "High";
      if (s === "Severe") return "Critical";
      return s || "Medium";
    };

    const ruleCounts: Record<string, number> = dbAlertRows.reduce((acc: Record<string, number>, a) => {
      acc[a.name] = (acc[a.name] || 0) + 1;
      return acc;
    }, {});

    const alertsFromViolations = dbAlertRows.map(a => {
      const severity = normSeverity(a.severity);
      const appMeta = appRows.find((app) => String(app.externalId ?? "") === String(a.applicationId ?? ""));
      return {
        alertId: `ALT-${a.id}`,
        source: a.source === "appdynamics" ? "AppDynamics" : "Dynatrace",
        severity,
        status: a.status,
        entity: (a.metadata as any)?.affectedEntityName ?? a.name,
        service: (a.metadata as any)?.affectedEntityType ?? "Service",
        rule: a.name,
        description: `Health rule violation: ${a.name}`,
        timestamp: a.triggeredAt?.getTime() ?? Date.now(),
        aiRiskScore: severity === "Critical" ? 85 : severity === "High" ? 70 : severity === "Medium" ? 55 : 25,
        occurrences: ruleCounts[a.name] ?? 1,
        applicationName: appNameMap[a.applicationId ?? ""] ?? "Unknown",
        applicationId: appMeta?.id ?? null,
        applicationExternalId: a.applicationId ?? null,
        relatedErrors: [],
        linkedIncident: null,
        tags: [a.source === "appdynamics" ? "AppDynamics" : "Dynatrace", severity],
      };
    });
    const allAlerts = [...alertsFromViolations]
      .sort((a, b) => b.timestamp - a.timestamp);

    return res.json(allAlerts);
  });
  app.get("/api/alerts/errors/correlated", async (req, res) => { res.json(await storage.getCorrelatedErrors(String(req.query.alertId))); });
  app.get("/api/alerts/:alertId/ai-analysis", async (req, res) => {
    const { alertId } = req.params;
    const now = Date.now();
    const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
    const normSeverity = (sev?: string | null) => {
      const s = String(sev ?? "").trim();
      if (s === "Warning") return "Medium";
      if (s === "Info") return "Low";
      if (s === "Error") return "High";
      if (s === "Severe") return "Critical";
      return s || "Medium";
    };
    const hashSeed = (input: string) => {
      let h = 0;
      for (let i = 0; i < input.length; i++) h = ((h << 5) - h + input.charCodeAt(i)) | 0;
      return Math.abs(h);
    };
    const seed = hashSeed(alertId);

    const parsedAlertId = alertId.startsWith("ALT-") ? Number(alertId.slice(4)) : NaN;
    const parsedIncId = alertId.startsWith("INC-") ? Number(alertId.slice(4)) : NaN;
    const parsedPredAppId = alertId.startsWith("PRED-ALT-") ? Number(alertId.slice("PRED-ALT-".length)) : NaN;

    let entity = alertId;
    let healthRuleName = alertId;
    let healthRuleId: string | null = null;
    let violationName: string | null = null;
    let appName = "Application";
    let severity = "Medium";
    let status = "Active";
    let isHealthRuleViolation = false;
    let appExternalId: string | null = null;
    let appInternalId: number | null = null;
    let alertTriggeredAtMs = now - 10 * 60_000;
    let alertSource = "AppDynamics";
    let alertMd: any = {};

    if (Number.isFinite(parsedAlertId)) {
      const [a] = await db.select().from(dbAlerts).where(eq(dbAlerts.id, parsedAlertId));
      if (a) {
        const md: any = a.metadata ?? {};
        alertMd = md;
        const mdHealthRuleName = String(md?.healthRuleName ?? "").trim();
        const mdViolationName = String(md?.name ?? "").trim();
        const mdHealthRuleId = md?.healthRuleId != null ? String(md.healthRuleId) : null;
        entity = String(md?.affectedEntityName ?? a.name ?? alertId);
        healthRuleName = mdHealthRuleName || a.name;
        healthRuleId = mdHealthRuleId;
        violationName = mdViolationName || a.name;
        isHealthRuleViolation = true;
        severity = normSeverity(a.severity);
        status = a.status ?? "Active";
        appExternalId = a.applicationId ?? null;
        alertTriggeredAtMs = a.triggeredAt?.getTime?.() ?? alertTriggeredAtMs;
        alertSource = a.source === "appdynamics" ? "AppDynamics" : "Dynatrace";
        const [app] = await db.select({ id: dbApplications.id, name: dbApplications.name }).from(dbApplications).where(eq(dbApplications.externalId, a.applicationId ?? ""));
        appInternalId = app?.id ?? null;
        appName = app?.name ?? a.applicationId ?? "Application";
      }
    } else if (Number.isFinite(parsedIncId)) {
      const [i] = await db.select().from(dbIncidents).where(eq(dbIncidents.id, parsedIncId));
      if (i) {
        entity = i.title;
        healthRuleName = `Incident: ${i.title}`;
        severity = normSeverity(i.severity);
        status = i.status === "Open" ? "Active" : "Resolved";
        appExternalId = i.applicationId ?? null;
        alertTriggeredAtMs = i.startTime?.getTime?.() ?? alertTriggeredAtMs;
        const [app] = await db.select({ id: dbApplications.id, name: dbApplications.name }).from(dbApplications).where(eq(dbApplications.externalId, i.applicationId ?? ""));
        appInternalId = app?.id ?? null;
        appName = app?.name ?? i.applicationId ?? "Application";
      }
    } else if (Number.isFinite(parsedPredAppId)) {
      const [app] = await db.select({ id: dbApplications.id, externalId: dbApplications.externalId, name: dbApplications.name })
        .from(dbApplications).where(eq(dbApplications.id, parsedPredAppId));
      appName = app?.name ?? "Application";
      appExternalId = app?.externalId ?? null;
      appInternalId = app?.id ?? null;
      entity = appName;
      healthRuleName = `Predicted capacity pressure for ${appName}`;
      severity = "Medium";
      status = "Active";
    }

    const [relatedErrors, relatedIncidents, relatedAlerts, txRows, serverRows, appRow] = appExternalId
      ? await Promise.all([
          db.select().from(dbErrors).where(eq(dbErrors.applicationId, appExternalId)).orderBy(desc(dbErrors.lastOccurrence)).limit(60),
          db.select().from(dbIncidents).where(eq(dbIncidents.applicationId, appExternalId)).orderBy(desc(dbIncidents.startTime)).limit(30),
          db.select().from(dbAlerts).where(eq(dbAlerts.applicationId, appExternalId)).orderBy(desc(dbAlerts.triggeredAt)).limit(50),
          db.select().from(dbTransactions).where(eq(dbTransactions.applicationId, appExternalId)).orderBy(desc(dbTransactions.updatedAt)).limit(80),
          db.select().from(dbServers).where(eq(dbServers.applicationId, appExternalId)).limit(40),
          db.select({
            avgResponseTime: dbApplications.avgResponseTime,
            errorRate: dbApplications.errorRate,
            callsPerMinute: dbApplications.callsPerMinute,
          }).from(dbApplications).where(eq(dbApplications.externalId, appExternalId)).limit(1),
        ])
      : [[], [], [], [], [], []];

    const appMeta = Array.isArray(appRow) && appRow.length > 0 ? appRow[0] : null;
    const errorVolume = relatedErrors.reduce((s, e) => s + Number(e.frequency ?? 1), 0);
    const openIncidents = relatedIncidents.filter((i) => (i.status ?? "").toLowerCase() !== "resolved").length;
    const openAlerts = relatedAlerts.filter((a) => (a.status ?? "").toLowerCase() !== "resolved").length;
    const criticalAlerts = relatedAlerts.filter((a) => normSeverity(a.severity) === "Critical").length;
    const txWindow = txRows.slice(0, 24);
    const avgTxError = txWindow.length > 0 ? txWindow.reduce((s, t) => s + Number(t.errorRate ?? 0), 0) / txWindow.length : 0;
    const avgTxLatency = txWindow.length > 0 ? txWindow.reduce((s, t) => s + Number(t.avgResponseTime ?? 0), 0) / txWindow.length : 0;
    const callsPerMin = txWindow.length > 0 ? txWindow.reduce((s, t) => s + Number(t.callsPerMinute ?? 0), 0) / txWindow.length : Number(appMeta?.callsPerMinute ?? 0);
    const cpuVals = serverRows.map((s) => Number(s.cpuUsage ?? NaN)).filter((v) => Number.isFinite(v) && v > 0);
    const memVals = serverRows.map((s) => Number(s.memoryUsage ?? NaN)).filter((v) => Number.isFinite(v) && v > 0);
    const cpuNow = cpuVals.length > 0 ? cpuVals.reduce((s, v) => s + v, 0) / cpuVals.length : 58 + (seed % 18);
    const memNow = memVals.length > 0 ? memVals.reduce((s, v) => s + v, 0) / memVals.length : 54 + (seed % 20);
    const baselineErr = Number(appMeta?.errorRate ?? Math.max(0.6, avgTxError * 0.45));
    const currentErr = Number((avgTxError > 0 ? avgTxError : baselineErr + 1.4).toFixed(2));
    const baselineLatency = Number(appMeta?.avgResponseTime ?? Math.max(350, avgTxLatency * 0.55 || 640));
    const currentLatency = Number((avgTxLatency > 0 ? avgTxLatency : baselineLatency * 1.7).toFixed(0));
    const topError = relatedErrors[0];
    const topErrorMessage = String(topError?.message ?? topError?.errorType ?? "No dominant error signature found").slice(0, 220);

    const severityBase =
      severity === "Critical" ? 70 :
      severity === "High" ? 62 :
      severity === "Medium" ? 52 : 40;
    const riskScore = clamp(
      Math.round(
        severityBase
        + criticalAlerts * 3
        + openAlerts * 1.1
        + Math.min(14, Math.log10(1 + errorVolume) * 8)
        + Math.min(10, avgTxError * 2.8)
        + Math.min(10, currentLatency / 420)
        + Math.min(8, openIncidents * 2),
      ),
      28,
      97,
    );
    const confidence = clamp(
      Number((
        0.58
        + (riskScore / 100) * 0.26
        + Math.min(0.08, openAlerts * 0.01)
        + Math.min(0.06, relatedErrors.length * 0.005)
      ).toFixed(2)),
      0.52,
      0.96,
    );

    const mkSeries = (base: number, amp: number, unitFloor = 0) =>
      Array.from({ length: 24 }).map((_, i) => {
        const localSeed = seed % 13;
        const noise = Math.sin((i + 1) * (0.31 + localSeed * 0.006)) * amp + Math.cos((i + 1) * (0.17 + localSeed * 0.004)) * (amp * 0.42);
        const ramp = i > 15 ? (i - 15) * (amp * 0.08) : 0;
        return {
          ts: now - (23 - i) * 60 * 60 * 1000,
          value: Number(Math.max(unitFloor, base + noise + ramp).toFixed(2)),
        };
      });

    const thresholdFromMd = String(alertMd?.thresholdValue ?? alertMd?.threshold ?? "").trim();
    const metricFromMd = String(alertMd?.metricValue ?? alertMd?.currentValue ?? "").trim();
    const baselineFromMd = String(alertMd?.baselineValue ?? "").trim();
    const evalWindowFromMd = String(alertMd?.evaluationWindow ?? "").trim();

    const affectedTransactions = txWindow
      .sort((a, b) => (Number(b.errorRate ?? 0) * 5 + Number(b.avgResponseTime ?? 0) / 250) - (Number(a.errorRate ?? 0) * 5 + Number(a.avgResponseTime ?? 0) / 250))
      .slice(0, 3)
      .map((t, idx) => ({
        txId: String(t.externalId ?? t.id ?? t.name ?? `tx-${idx + 1}`),
        name: String(t.name ?? `Transaction ${idx + 1}`),
        errorRate: Number((Number(t.errorRate ?? currentErr)).toFixed(2)),
        avgResponseTime: Math.round(Number(t.avgResponseTime ?? currentLatency)),
        p99: Math.round(Math.max(200, Number(t.avgResponseTime ?? currentLatency) * 1.9)),
        callsPerMin: Math.round(Number(t.callsPerMinute ?? callsPerMin / Math.max(1, idx + 1))),
        impactLevel: Number(t.errorRate ?? 0) >= 3 || Number(t.avgResponseTime ?? 0) >= 2000 ? "High" : "Medium",
        slaBreach: Number(t.avgResponseTime ?? 0) >= 2000 || Number(t.errorRate ?? 0) >= 3,
      }));
    const txForResponse = affectedTransactions.length > 0 ? affectedTransactions : [
      {
        txId: "primary-transaction-path",
        name: "Primary Transaction Path",
        errorRate: currentErr,
        avgResponseTime: currentLatency,
        p99: Math.round(currentLatency * 1.9),
        callsPerMin: Math.round(callsPerMin || 120),
        impactLevel: currentErr >= 3 ? "High" : "Medium",
        slaBreach: currentErr >= 3 || currentLatency >= 2000,
      },
    ];

    const minsAgo = (ms: number) => `${Math.max(1, Math.round((now - ms) / 60_000))}m`;
    const alertSeverityLabel = severity;
    const strongestTx = txForResponse[0];
    const secondTx = txForResponse[1];
    const strongestError = relatedErrors[0];
    const secondError = relatedErrors[1];
    const strongestAlert = relatedAlerts[0];

    const dynamicLogs = [
      {
        level: "WARN",
        timestamp: strongestAlert?.triggeredAt?.getTime?.() ?? (alertTriggeredAtMs - 13 * 60 * 1000),
        source: appName,
        message: strongestAlert
          ? `Correlated alert ${strongestAlert.name} (${normSeverity(strongestAlert.severity)}) became active in the same application window.`
          : `Early warning: ${healthRuleName} trend exceeded baseline envelope.`,
      },
      {
        level: "ERROR",
        timestamp: strongestError?.lastOccurrence?.getTime?.() ?? (alertTriggeredAtMs - 9 * 60 * 1000),
        source: strongestError?.service ?? appName,
        message: String(strongestError?.message ?? topErrorMessage ?? "Correlated error cluster spike detected."),
      },
      {
        level: "INFO",
        timestamp: alertTriggeredAtMs - 5 * 60 * 1000,
        source: appName,
        message: `${openAlerts} active alert(s), ${openIncidents} incident(s), and ${relatedErrors.length} error signature(s) are correlated in app context.`,
      },
      {
        level: "INFO",
        timestamp: alertTriggeredAtMs - 2 * 60 * 1000,
        source: strongestTx?.name ?? appName,
        message: strongestTx
          ? `Transaction ${strongestTx.name} is at ${strongestTx.errorRate}% error rate with ${strongestTx.avgResponseTime}ms average response.`
          : `Transaction telemetry indicates elevated latency/error pressure around alert open time.`,
      },
    ]
      .filter((l) => Number.isFinite(Number(l.timestamp)))
      .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));

    const immediateActions = [
      {
        priority: alertSeverityLabel === "Critical" ? "Critical" : "High",
        effort: "Low",
        confidence: Math.round(confidence * 100),
        action: strongestTx
          ? `Stabilize ${strongestTx.name} by reducing retry pressure and scaling impacted tier.`
          : `Stabilize ${entity} by reducing retry pressure and scaling impacted tier.`,
        impactReduction: clamp(Math.round(riskScore * 0.38), 18, 45),
        command: strongestTx
          ? `Scale service behind ${strongestTx.name} by +2 and cap retries to 2 for 15 minutes.`
          : `Scale ${appName} service group by +2 and cap retries to 2 for 15 minutes.`,
      },
      {
        priority: "High",
        effort: "Medium",
        confidence: clamp(Math.round(confidence * 100) - 6, 50, 95),
        action: secondError
          ? `Contain error amplification from ${String(secondError.errorType ?? "dominant error path")} and protect high-value traffic.`
          : "Prioritize high-value transactions and shed non-critical traffic.",
        impactReduction: clamp(Math.round(riskScore * 0.24), 12, 30),
        command: strongestTx
          ? `Apply priority queue + temporary rate-limit on non-critical endpoints while protecting ${strongestTx.name}.`
          : "Apply priority queue and temporary rate-limit policy for low-priority endpoints.",
      },
    ];

    const longTermActions = [
      {
        effort: "Medium",
        confidence: clamp(Math.round(confidence * 100) - 8, 45, 92),
        action: `Tune ${healthRuleName} threshold/baseline windows using observed telemetry profile.`,
        impactReduction: clamp(Math.round(riskScore * 0.2), 10, 28),
        detail: `Recalibrate threshold (${thresholdFromMd || "default"}) against current baseline (${baselineErr.toFixed(2)}% error-rate) to reduce noise and preserve true positives.`,
      },
      {
        effort: "High",
        confidence: clamp(Math.round(confidence * 100) - 10, 40, 90),
        action: secondTx
          ? `Optimize latency/error path for ${strongestTx?.name ?? "primary transaction"} and ${secondTx.name}.`
          : "Optimize dependent service latency path and timeout/circuit-breaker configuration.",
        impactReduction: clamp(Math.round(riskScore * 0.28), 14, 34),
        detail: strongestError
          ? `Address recurrent ${String(strongestError.errorType ?? "error")} signatures and reduce cascading timeout amplification across dependent services.`
          : "Address recurrent p95/p99 regressions and reduce cascading error amplification.",
      },
    ];

    return res.json({
      applicationId: appInternalId,
      applicationExternalId: appExternalId,
      applicationName: appName,
      summary: `AI analysis for ${alertId}: elevated risk on ${appName} driven by ${healthRuleName}.`,
      primaryRootCause: `${healthRuleName} triggered on ${entity}. Dominant correlated signal: ${topErrorMessage}.`,
      confidence,
      healthRule: {
        name: isHealthRuleViolation ? healthRuleName : null,
        healthRuleId,
        violationName,
        threshold: thresholdFromMd || (severity === "Critical" ? "> 8% for 5min" : "> 5% for 5min"),
        metricAtBreach: metricFromMd || `${currentErr.toFixed(2)}%`,
        baseline: baselineFromMd || `${baselineErr.toFixed(2)}%`,
        evaluationWindow: evalWindowFromMd || "5 minutes",
        entity,
      },
      contributingFactors: [
        { factor: `Error rate pressure on ${entity}`, severity: severity === "Low" ? "Medium" : severity, value: `${currentErr.toFixed(2)}%`, baseline: `${baselineErr.toFixed(2)}%` },
        { factor: "Response-time degradation on transaction path", severity: currentLatency >= 1800 ? "High" : "Medium", value: `${Math.round(currentLatency)}ms`, baseline: `${Math.round(baselineLatency)}ms` },
        { factor: "Resource contention trend", severity: cpuNow >= 80 || memNow >= 80 ? "High" : "Medium", value: `CPU ${Math.round(cpuNow)}% / MEM ${Math.round(memNow)}%`, baseline: "CPU 55% / MEM 58%" },
      ],
      evidenceUsed: [
        { type: "Alert Stream", description: `${openAlerts} active alerts in the same app context.`, icon: "alert" },
        { type: "Error Spike", description: `${relatedErrors.length} correlated error signatures (${errorVolume.toLocaleString()} occurrences).`, icon: "error" },
        { type: "Incident Context", description: `${openIncidents} open incidents linked to this application.`, icon: "incident" },
        { type: "Runtime Metrics", description: `P95 latency ${Math.round(currentLatency)}ms with ${currentErr.toFixed(2)}% error-rate trend.`, icon: "metric" },
      ],
      causalChain: [
        { step: 1, time: `T-${minsAgo(alertTriggeredAtMs + 24 * 60_000)}`, event: "Load/rate deviation begins", detail: "Telemetry deviates from recent baseline on key service edges." },
        { step: 2, time: `T-${minsAgo(alertTriggeredAtMs + 14 * 60_000)}`, event: "Error signature amplification", detail: topErrorMessage || "Error clusters begin to increase in frequency." },
        { step: 3, time: `T-${minsAgo(alertTriggeredAtMs + 8 * 60_000)}`, event: "Latency threshold pressure", detail: `Response-time trend moved toward ${Math.round(currentLatency)}ms on affected transactions.` },
        { step: 4, time: `T-${minsAgo(alertTriggeredAtMs + 3 * 60_000)}`, event: "Health rule threshold crossed", detail: `${healthRuleName} remained above configured threshold window.` },
        { step: 5, time: `T-${minsAgo(alertTriggeredAtMs)}`, event: "Alert opened", detail: `${alertId} created in ${status} state (${alertSource}).` },
      ],
      correlatedSignals: {
        metricSpikes: [
          { metric: "CPU", value: Math.round(cpuNow), baseline: 55, unit: "%" },
          { metric: "Heap", value: Math.round(memNow), baseline: 58, unit: "%" },
          { metric: "Error Rate", value: Number(currentErr.toFixed(2)), baseline: Number(baselineErr.toFixed(2)), unit: "%" },
          { metric: "P95 Latency", value: Math.round(currentLatency), baseline: Math.round(baselineLatency), unit: "ms" },
        ],
        logs: dynamicLogs,
      },
      affectedTransactions: txForResponse,
      metricsHistory: {
        cpu: mkSeries(cpuNow * 0.86, 9, 5),
        heap: mkSeries(memNow * 0.9, 8, 8),
        errorRate: mkSeries(Math.max(0.25, currentErr * 0.62), Math.max(0.5, currentErr * 0.35), 0),
        gcPause: mkSeries(Math.max(120, currentLatency * 0.16), 70, 20),
      },
      impactForecast: {
        recurrenceProbability: clamp(riskScore + 10, 25, 97),
        slaBreach: clamp(riskScore + 6, 20, 95),
        hoursToRecurrence: severity === "Critical" ? 4 : severity === "High" ? 8 : severity === "Medium" ? 14 : 24,
        usersAffected: severity === "Critical" ? 12000 : severity === "High" ? 6800 : severity === "Medium" ? 3200 : 1200,
      },
      remediationActions: {
        immediate: immediateActions,
        longTerm: longTermActions,
      },
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
      const normSeverity = (sev?: string | null) => {
        const s = String(sev ?? "").trim();
        if (s === "Warning") return "Medium";
        if (s === "Info") return "Low";
        if (s === "Error") return "High";
        if (s === "Severe") return "Critical";
        return s || "Medium";
      };
      const buildForecast = (risk = 55) =>
        Array.from({ length: 24 }).map((_, i) => {
          const predicted = Math.max(5, Math.min(100, risk + Math.sin(i * 0.35) * 10 + Math.cos(i * 0.14) * 4));
          const actual = i < 10 ? Math.max(0, predicted - (6 - i * 0.4)) : null;
          return {
            hour: i,
            actual: actual != null ? Number(actual.toFixed(2)) : null,
            predicted: Number(predicted.toFixed(2)),
            upper: Number(Math.min(100, predicted + 8).toFixed(2)),
            lower: Number(Math.max(0, predicted - 8).toFixed(2)),
          };
        });

      if (alertId.startsWith("PRED-ALT-")) {
        const appId = Number(alertId.slice("PRED-ALT-".length));
        if (Number.isFinite(appId)) {
          const [app] = await db.select().from(dbApplications).where(eq(dbApplications.id, appId));
          const appName = app?.name ?? "Application";
          const forecastChart = buildForecast(55);
          return res.json({
            alertId,
            alertType: "predicted",
            source: "AI Forecast",
            severity: "Medium",
            status: "Active",
            entity: appName,
            rule: `Predicted capacity pressure for ${appName}`,
            service: "Application",
            description: "Forecast model predicts elevated operational pressure in upcoming hours.",
            timestamp: Date.now() - 10 * 60 * 1000,
            resolvedAt: null,
            aiRiskScore: 55,
            escalationProbability: 62,
            applicationId: app?.id ?? null,
            applicationName: appName,
            linkedIncident: null,
            correlatedAlerts: [],
            affectedEntities: [
              { type: "Application", name: appName, status: "Warning", link: app?.id ? `/applications/${app.id}` : null },
              { type: "Tier", name: "Primary Tier", status: "Warning", link: app?.id ? `/applications/${app.id}/tier-nodes` : null },
            ],
            forecastChart,
            tags: ["Forecast", "Medium", "Predicted"],
          });
        }
      }

      if (alertId.startsWith("ALT-")) {
        const numId = parseInt(alertId.slice(4));
        if (!isNaN(numId)) {
          const [a] = await db.select().from(dbAlerts).where(eq(dbAlerts.id, numId));
          if (a) {
            const md: any = a.metadata ?? {};
            const appdHealthRuleName = String(md?.healthRuleName ?? "").trim() || a.name;
            const appdViolationName = String(md?.name ?? "").trim() || a.name;
            const appdHealthRuleId = md?.healthRuleId != null ? String(md.healthRuleId) : null;
            const [app] = await db.select({ id: dbApplications.id, name: dbApplications.name }).from(dbApplications).where(eq(dbApplications.externalId, a.applicationId ?? ""));
            const severity = normSeverity(a.severity);
            const risk = severity === "Critical" ? 85 : severity === "High" ? 70 : severity === "Medium" ? 55 : 35;
            const rawCorrelated = await db.select({
              id: dbAlerts.id,
              name: dbAlerts.name,
              severity: dbAlerts.severity,
              status: dbAlerts.status,
              metric: dbAlerts.metric,
              triggeredAt: dbAlerts.triggeredAt,
              metadata: dbAlerts.metadata,
            })
              .from(dbAlerts)
              .where(and(eq(dbAlerts.applicationId, a.applicationId ?? ""), sql`${dbAlerts.id} <> ${a.id}`))
              .orderBy(desc(dbAlerts.triggeredAt))
              .limit(40);

            const baseTs = a.triggeredAt?.getTime?.() ?? Date.now();
            const baseHealthRuleName = String((a.metadata as any)?.healthRuleName ?? "").trim().toLowerCase();
            const scoredCorrelated = rawCorrelated.map((c) => {
              const cTs = c.triggeredAt?.getTime?.() ?? 0;
              const diffMin = Math.abs(baseTs - cTs) / 60000;
              const cHealthRuleName = String((c.metadata as any)?.healthRuleName ?? "").trim().toLowerCase();
              let score = 0;
              if ((a.metric ?? "") && (c.metric ?? "") && String(a.metric) === String(c.metric)) score += 3;
              if ((a.severity ?? "") && (c.severity ?? "") && String(a.severity) === String(c.severity)) score += 2;
              if (baseHealthRuleName && cHealthRuleName && baseHealthRuleName === cHealthRuleName) score += 4;
              if ((a.status ?? "") && (c.status ?? "") && String(a.status) === String(c.status)) score += 1;
              if (diffMin <= 15) score += 3;
              else if (diffMin <= 60) score += 2;
              else if (diffMin <= 360) score += 1;
              return { ...c, _score: score };
            })
              .filter((c) => c._score > 0)
              .sort((x, y) => (y._score - x._score) || ((y.triggeredAt?.getTime?.() ?? 0) - (x.triggeredAt?.getTime?.() ?? 0)));
            const correlated = (scoredCorrelated.length > 0 ? scoredCorrelated : rawCorrelated).slice(0, 5);
            return res.json({
              alertId, source: a.source === "appdynamics" ? "AppDynamics" : "Dynatrace",
              alertType: "healthRuleViolation",
              severity, status: a.status,
              entity: appdViolationName, rule: appdHealthRuleName, service: app?.name ?? a.applicationId ?? "Application",
              description: `Health rule violation: ${appdHealthRuleName}`,
              timestamp: a.triggeredAt?.getTime() ?? Date.now(),
              resolvedAt: a.resolvedAt?.getTime() ?? null,
              aiRiskScore: risk,
              escalationProbability: Math.min(95, risk + (a.status === "Active" ? 10 : 0)),
              applicationId: app?.id ?? null,
              applicationName: app?.name ?? "Unknown",
              healthRuleName: appdHealthRuleName,
              healthRuleId: appdHealthRuleId,
              violationName: appdViolationName,
              metric: a.metric, threshold: a.threshold, currentValue: a.currentValue,
              linkedIncident: null,
              correlatedAlerts: correlated.map((c) => ({
                alertId: `ALT-${c.id}`,
                entity: c.name,
                rule: String((c.metadata as any)?.healthRuleName ?? c.name),
                severity: normSeverity(c.severity),
              })),
              affectedEntities: [
                { type: "Application", name: app?.name ?? "Application", status: severity, link: app?.id ? `/applications/${app.id}` : null },
                { type: "Rule", name: a.name, status: severity, link: null },
              ],
              forecastChart: buildForecast(risk),
              tags: [a.source === "appdynamics" ? "AppDynamics" : "Dynatrace", severity],
            });
          }
        }
      } else if (alertId.startsWith("INC-")) {
        const numId = parseInt(alertId.slice(4));
        if (!isNaN(numId)) {
          const [i] = await db.select().from(dbIncidents).where(eq(dbIncidents.id, numId));
          if (i) {
            const [app] = await db.select({ id: dbApplications.id, name: dbApplications.name }).from(dbApplications).where(eq(dbApplications.externalId, i.applicationId ?? ""));
            const severity = normSeverity(i.severity);
            const risk = severity === "Critical" ? 88 : severity === "High" ? 72 : severity === "Medium" ? 52 : 35;
            return res.json({
              alertId, source: i.source === "appdynamics" ? "AppDynamics" : "Dynatrace",
              alertType: "incidentDerived",
              severity, status: i.status === "Open" ? "Active" : "Resolved",
              entity: i.title, rule: `Incident: ${i.title}`, service: i.affectedServices?.[0] ?? "Application",
              description: i.rootCause ?? i.title,
              timestamp: i.startTime?.getTime() ?? Date.now(),
              resolvedAt: i.endTime?.getTime() ?? null,
              aiRiskScore: risk,
              escalationProbability: Math.min(96, risk + (i.status === "Open" ? 8 : 0)),
              applicationId: app?.id ?? null,
              applicationName: app?.name ?? "Unknown",
              linkedIncident: alertId,
              correlatedAlerts: [],
              affectedEntities: [
                { type: "Application", name: app?.name ?? "Application", status: severity, link: app?.id ? `/applications/${app.id}` : null },
                { type: "Incident", name: i.title, status: severity, link: `/incidents/${i.externalId ?? alertId}` },
              ],
              forecastChart: buildForecast(risk),
              tags: [i.source === "appdynamics" ? "AppDynamics" : "Dynatrace", severity, "Incident"],
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
    const includeSnapshotsRaw = String((req.query as any)?.includeSnapshots ?? "").toLowerCase();
    const includeSnapshots = includeSnapshotsRaw === "1" || includeSnapshotsRaw === "true" || includeSnapshotsRaw === "yes";

    const user = req.user as import("@shared/schema").User | undefined;
    if (user) {
      const orgData = await getUserOrg(user.id);
      if (orgData) {
        const orgCreds = await db.select({ id: apmCredentials.id })
          .from(apmCredentials)
          .where(and(eq(apmCredentials.organizationId, orgData.org.id), eq(apmCredentials.isActive, true)));
        if (orgCreds.length > 0) {
          const credIds = orgCreds.map(c => c.id);
          const appRows = await db.select({
            externalId: dbApplications.externalId,
            name: dbApplications.name,
            credentialId: dbApplications.credentialId,
          }).from(dbApplications).where(credIds.length === 1
            ? eq(dbApplications.credentialId, credIds[0])
            : sql`${dbApplications.credentialId} = ANY(ARRAY[${sql.join(credIds.map(id => sql`${id}`), sql`, `)}]::integer[])`);
          const appByExternalId = new Map(appRows.map((a) => [String(a.externalId ?? ""), a]));

          const credRows = await db.select().from(apmCredentials).where(credIds.length === 1
            ? eq(apmCredentials.id, credIds[0])
            : sql`${apmCredentials.id} = ANY(ARRAY[${sql.join(credIds.map(id => sql`${id}`), sql`, `)}]::integer[])`);
          const credById = new Map(credRows.map((c) => [c.id, c]));
          const appdClientByCred = new Map<number, ReturnType<typeof createAppDynamicsClient>>();

          const getAppdClient = (credentialId: number | null | undefined) => {
            if (!Number.isFinite(Number(credentialId))) return null;
            const id = Number(credentialId);
            if (appdClientByCred.has(id)) return appdClientByCred.get(id) ?? null;
            const cred = credById.get(id);
            if (!cred || cred.source !== "appdynamics") {
              appdClientByCred.set(id, null);
              return null;
            }
            let resolvedPassword = String(cred.passwordHash ?? "");
            try {
              resolvedPassword = String(decryptSecret(cred.passwordHash) ?? resolvedPassword);
            } catch {
              resolvedPassword = String(cred.passwordHash ?? "");
            }
            const client = createAppDynamicsClient({
              controllerUrl: cred.controllerUrl,
              account: cred.account ?? "",
              username: cred.username ?? "",
              password: resolvedPassword,
            });
            appdClientByCred.set(id, client);
            return client;
          };

          const looksLikeId = (value: string | null | undefined) => {
            const v = String(value ?? "").trim();
            return v.length > 0 && /^\d+$/.test(v);
          };
          const pickReadable = (...values: Array<string | null | undefined>) => {
            const cleaned = values
              .map((v) => String(v ?? "").trim())
              .filter((v) => v.length > 0 && v.toLowerCase() !== "n/a" && v.toLowerCase() !== "unknown");
            if (cleaned.length === 0) return "";
            const named = cleaned.find((v) => !looksLikeId(v));
            return named ?? cleaned[0];
          };
          const isDiagnosticNoise = (value: string | null | undefined) =>
            String(value ?? "").toUpperCase().includes("DIAGNOSTIC_SESSION");
          const extractConcreteFromSummary = (summary: string | null | undefined) => {
            const raw = String(summary ?? "").trim();
            if (!raw) return { type: "", message: "" };
            const tail = raw.includes(" - ") ? raw.split(" - ").slice(1).join(" - ") : raw;
            const cleaned = tail
              .replace(/\[Stacktrace Processing Limit Reached\]/gi, "")
              .replace(/\s+/g, " ")
              .trim();
            const firstToken = cleaned.split(/\s+/)[0] ?? "";
            const inferredType = firstToken.replace(/[:]+$/g, "").trim();
            return { type: inferredType, message: cleaned };
          };

          const dbErrorRows = await db.select().from(dbErrors)
            .where(credIds.length === 1
              ? sql`${dbErrors.applicationId} IN (SELECT external_id::text FROM apm_applications WHERE credential_id = ${credIds[0]})`
              : sql`${dbErrors.applicationId} IN (SELECT external_id::text FROM apm_applications WHERE credential_id = ANY(ARRAY[${sql.join(credIds.map(id => sql`${id}`), sql`, `)}]::integer[]))`)
            .orderBy(desc(dbErrors.lastOccurrence))
            .limit(200);
          if (dbErrorRows.length > 0) {
            const nonDiagnosticRows = dbErrorRows.filter((e) => {
              const t = String(e.errorType ?? "").toUpperCase();
              const msg = String(e.message ?? "").toUpperCase();
              const summary = String((e.metadata as any)?.errorSummary ?? "").toUpperCase();
              return t !== "DIAGNOSTIC_SESSION" && !msg.includes("DIAGNOSTIC_SESSION") && !summary.includes("DIAGNOSTIC_SESSION");
            });

            const baseMapped = nonDiagnosticRows.map(e => {
              const md: any = (e.metadata as any) ?? {};
              const detail0 = Array.isArray(md?.errorDetails) && md.errorDetails.length > 0 ? md.errorDetails[0] : null;
              const summaryExtract = extractConcreteFromSummary(md?.summary);
              const rawType = String(detail0?.name ?? md?.subType ?? e.errorType ?? "Application Error").trim();
              const normalizedType = isDiagnosticNoise(rawType)
                ? (summaryExtract.type || "Application Error")
                : rawType;
              const rawRootCause = String(
                detail0?.value ??
                md?.errorSummary ??
                md?.summary ??
                e.message ??
                ""
              ).trim();
              const normalizedRootCause = isDiagnosticNoise(rawRootCause)
                ? (summaryExtract.message || rawRootCause)
                : rawRootCause;
              const normalizedPath = String(md?.requestPath ?? md?.URL ?? "").trim();
              const normalizedMessage = (normalizedRootCause || String(e.message ?? e.cluster ?? "Application Error").trim()).slice(0, 220);
              const signature = `${normalizedType}|${normalizedPath}|${normalizedMessage}`
                .toLowerCase()
                .replace(/[^a-z0-9|/_\-\s:.]/g, "")
                .replace(/\s+/g, "-")
                .slice(0, 180);
              return {
              errorId: `ERR-${e.id}`,
              type: normalizedType || "Application Error",
              message: normalizedMessage,
              service: pickReadable(
                md?.businessTransactionName,
                md?.tierName,
                md?.triggeredEntity?.name,
                e.service,
                e.applicationName,
              ) || "Unknown Service",
              server: pickReadable(
                md?.nodeName,
                md?.applicationComponentNodeName,
                md?.triggeredEntity?.name,
                md?.nodeId != null ? `Node ${md?.nodeId}` : null,
              ) || "N/A",
              appId: e.applicationId,
              source: e.source === "appdynamics" ? "AppDynamics" : "Dynatrace",
              timestamp: e.lastOccurrence?.getTime() ?? Date.now(),
              count: e.frequency ?? 1,
              clusterId: `SIG-${signature || String(e.cluster ?? "error").toLowerCase()}`,
              severity: e.severity ?? "Medium",
              status: e.status ?? "Active",
              firstSeen: e.firstSeen?.getTime() ?? null,
              lastSeen: e.lastOccurrence?.getTime() ?? null,
              applicationName: e.applicationName,
              requestPath: normalizedPath || null,
              businessTransaction: md?.businessTransactionName ?? null,
              callToCheck: (md?.requestGUID ?? normalizedPath) || null,
              rootCause: normalizedRootCause || null,
              recommendation: null,
              };
            });

            // Fast-path by default: return synced DB errors immediately when meaningful
            // non-diagnostic rows exist. If only diagnostic-session rows are present,
            // continue below to derive concrete request-snapshot errors.
            if (!includeSnapshots && baseMapped.length > 0) {
              return res.json(baseMapped.slice(0, 300));
            }

            // Build AppDynamics-like per-call error rows from request snapshots
            // so dashboard shows concrete error reasons instead of repeated diagnostic summaries.
            const appdDiagRows = dbErrorRows.filter((e) => e.source === "appdynamics");
            const snapshotRows: any[] = [];
            const seenKeys = new Set<string>();

            for (const e of appdDiagRows.slice(0, 40)) {
              const appExternalId = String(e.applicationId ?? "");
              const appMeta = appByExternalId.get(appExternalId);
              const credentialId = Number(appMeta?.credentialId ?? NaN);
              if (!Number.isFinite(credentialId)) continue;
              const client = getAppdClient(credentialId);
              if (!client) continue;

              const affected = Array.isArray((e.metadata as any)?.affectedEntities) ? (e.metadata as any).affectedEntities : [];
              const btEntity = affected.find((a: any) => String(a?.entityType ?? "").toUpperCase() === "BUSINESS_TRANSACTION");
              const btId = Number(btEntity?.entityId ?? NaN);
              const btName = String(btEntity?.name ?? "");
              const appIdNum = Number(appExternalId);
              if (!Number.isFinite(btId) || !Number.isFinite(appIdNum)) continue;

              let snapshots: any[] = [];
              try {
                snapshots = await client.getRequestSnapshots(appIdNum, btId, 180);
              } catch {
                snapshots = [];
              }
              for (let i = 0; i < snapshots.length; i++) {
                const s = snapshots[i];
                const hasError = Boolean(s?.errorOccured)
                  || (Array.isArray(s?.errorDetails) && s.errorDetails.length > 0)
                  || String(s?.summary ?? "").toLowerCase().includes("[error]")
                  || String(s?.errorSummary ?? "").trim().length > 0;
                if (!hasError) continue;
                const ts = Number(s?.localStartTime ?? s?.serverStartTime ?? NaN);
                if (!Number.isFinite(ts)) continue;
                const path = String(s?.URL ?? "").trim();
                const detail0 = Array.isArray(s?.errorDetails) && s.errorDetails.length > 0 ? s.errorDetails[0] : null;
                const errMessage = String(detail0?.value ?? detail0?.name ?? s?.errorSummary ?? s?.summary ?? e.message ?? "Application error");
                const key = `${appExternalId}|${btId}|${ts}|${path}|${errMessage}`;
                if (seenKeys.has(key)) continue;
                seenKeys.add(key);
                const code = (Array.isArray(s?.httpParameters)
                  ? s.httpParameters.find((p: any) => String(p?.name ?? "").toLowerCase() === "http-response-code")
                  : null)?.value ?? null;
                const guid = String(s?.requestGUID ?? "");
                const detailName = String(detail0?.name ?? e.errorType ?? "Business Transaction Error").trim();
                const detailValue = String(detail0?.value ?? "").trim();
                const summaryExtract = extractConcreteFromSummary(s?.summary ?? s?.errorSummary);
                const safeDetailName = isDiagnosticNoise(detailName)
                  ? (summaryExtract.type || "Business Transaction Error")
                  : detailName;
                const safeDetailValue = isDiagnosticNoise(detailValue)
                  ? summaryExtract.message
                  : detailValue;
                const safeErrMessage = isDiagnosticNoise(errMessage)
                  ? (summaryExtract.message || errMessage)
                  : errMessage;
                const errorReason = safeDetailValue || safeErrMessage;
                if (isDiagnosticNoise(safeDetailName) && isDiagnosticNoise(errorReason)) continue;
                const signatureRaw = `${safeDetailName}|${String(code ?? "")}|${path}|${errorReason}`.toLowerCase();
                const signature = signatureRaw
                  .replace(/[^a-z0-9|/_\-\s:.]/g, "")
                  .slice(0, 160)
                  .replace(/\s+/g, "-");
                const syntheticId = `SNAP-${appIdNum}-${btId}-${ts}-${i}`;
                snapshotRows.push({
                  errorId: syntheticId,
                  type: safeDetailName,
                  message: errorReason,
                  service: pickReadable(
                    String(s?.businessTransactionName ?? ""),
                    btName,
                    (e.metadata as any)?.tierName,
                    e.service,
                    e.applicationName,
                  ) || "Unknown Service",
                  server: pickReadable(
                    String((s as any)?.applicationComponentNodeName ?? ""),
                    String((s as any)?.applicationComponentName ?? ""),
                    String((s as any)?.applicationComponentNodeId != null ? `Node ${(s as any)?.applicationComponentNodeId}` : ""),
                    (e.metadata as any)?.triggeredEntity?.name,
                    (e.metadata as any)?.nodeName,
                  ) || "N/A",
                  appId: appExternalId,
                  source: "AppDynamics",
                  timestamp: ts,
                  count: 1,
                  clusterId: `SIG-${signature || `bt-${btId}`}`,
                  severity: e.severity ?? "High",
                  status: "Active",
                  firstSeen: ts,
                  lastSeen: ts,
                  applicationName: appMeta?.name ?? e.applicationName ?? "Unknown",
                  requestPath: path || null,
                  businessTransaction: btName || null,
                  callToCheck: guid || path || null,
                  httpCode: code ? String(code) : null,
                  recommendation: code && String(code).startsWith("4")
                    ? "Check route/endpoint mapping and client request path for 4xx failures."
                    : code && String(code).startsWith("5")
                      ? "Check server-side exception path and downstream dependencies for 5xx failures."
                      : "Inspect snapshot error details and stack traces for root-cause path.",
                });
              }
            }

            const nonRepeatedBase = baseMapped.filter((r: any) => !(r.source === "AppDynamics" && String(r.type ?? "").toUpperCase() === "DIAGNOSTIC_SESSION"));
            const merged = [...snapshotRows, ...nonRepeatedBase]
              .sort((a, b) => Number(b.timestamp ?? 0) - Number(a.timestamp ?? 0))
              .slice(0, 300);
            return res.json(merged);
          }

          // Fallback: if synced error rows are empty, derive concrete errors from BT snapshots
          // so /errors does not appear blank while application/BT data exists.
          const txRows = await db.select().from(dbTransactions)
            .where(credIds.length === 1
              ? sql`${dbTransactions.applicationId} IN (SELECT external_id::text FROM apm_applications WHERE credential_id = ${credIds[0]})`
              : sql`${dbTransactions.applicationId} IN (SELECT external_id::text FROM apm_applications WHERE credential_id = ANY(ARRAY[${sql.join(credIds.map(id => sql`${id}`), sql`, `)}]::integer[]))`)
            .orderBy(desc(dbTransactions.errorRate), desc(dbTransactions.updatedAt))
            .limit(120);

          const fallbackRows: any[] = [];
          const seenFallback = new Set<string>();
          for (const tx of txRows) {
            if (fallbackRows.length >= 300) break;
            if (tx.source !== "appdynamics") continue;
            const appExternalId = String(tx.applicationId ?? "").trim();
            const btExternalId = String(tx.externalId ?? "").trim();
            const appIdNum = Number(appExternalId);
            const btIdNum = Number(btExternalId);
            if (!Number.isFinite(appIdNum) || !Number.isFinite(btIdNum)) continue;

            const appMeta = appByExternalId.get(appExternalId);
            const credentialId = Number(appMeta?.credentialId ?? NaN);
            if (!Number.isFinite(credentialId)) continue;
            const client = getAppdClient(credentialId);
            if (!client) continue;

            let snapshots: any[] = [];
            try {
              snapshots = await client.getRequestSnapshots(appIdNum, btIdNum, 180);
            } catch {
              snapshots = [];
            }
            for (let i = 0; i < snapshots.length; i++) {
              if (fallbackRows.length >= 300) break;
              const s = snapshots[i];
              const hasError = Boolean(s?.errorOccured)
                || (Array.isArray(s?.errorDetails) && s.errorDetails.length > 0)
                || String(s?.summary ?? "").toLowerCase().includes("[error]")
                || String(s?.errorSummary ?? "").trim().length > 0;
              if (!hasError) continue;
              const ts = Number(s?.localStartTime ?? s?.serverStartTime ?? NaN);
              if (!Number.isFinite(ts)) continue;
              const detail0 = Array.isArray(s?.errorDetails) && s.errorDetails.length > 0 ? s.errorDetails[0] : null;
              const path = String(s?.URL ?? "").trim();
              const detailNameRaw = String(detail0?.name ?? "Business Transaction Error").trim();
              const summaryExtract = extractConcreteFromSummary(s?.summary ?? s?.errorSummary);
              const detailName = isDiagnosticNoise(detailNameRaw)
                ? (summaryExtract.type || "Business Transaction Error")
                : detailNameRaw;
              const messageRaw = String(detail0?.value ?? detail0?.name ?? s?.errorSummary ?? s?.summary ?? tx.name ?? "Application error");
              const message = isDiagnosticNoise(messageRaw)
                ? (summaryExtract.message || messageRaw)
                : messageRaw;
              if (isDiagnosticNoise(detailName) && isDiagnosticNoise(message)) continue;
              const key = `${appExternalId}|${btIdNum}|${ts}|${path}|${message}`;
              if (seenFallback.has(key)) continue;
              seenFallback.add(key);
              const code = (Array.isArray(s?.httpParameters)
                ? s.httpParameters.find((p: any) => String(p?.name ?? "").toLowerCase() === "http-response-code")
                : null)?.value ?? null;
              fallbackRows.push({
                errorId: `SNAP-${appIdNum}-${btIdNum}-${ts}-${i}`,
                type: detailName,
                message,
                service: pickReadable(
                  String(s?.businessTransactionName ?? ""),
                  tx.name,
                  tx.tier,
                  appMeta?.name,
                ) || "Unknown Service",
                server: pickReadable(
                  String((s as any)?.applicationComponentNodeName ?? ""),
                  String((s as any)?.applicationComponentName ?? ""),
                  String((s as any)?.applicationComponentNodeId != null ? `Node ${(s as any)?.applicationComponentNodeId}` : ""),
                ) || "N/A",
                appId: appExternalId,
                source: "AppDynamics",
                timestamp: ts,
                count: 1,
                clusterId: `BT-${btIdNum}`,
                severity: "High",
                status: "Active",
                firstSeen: ts,
                lastSeen: ts,
                applicationName: appMeta?.name ?? "Unknown",
                requestPath: path || null,
                businessTransaction: String(s?.businessTransactionName ?? tx.name ?? ""),
                callToCheck: String(s?.requestGUID ?? path ?? ""),
                httpCode: code ? String(code) : null,
                recommendation: code && String(code).startsWith("4")
                  ? "Check route/endpoint mapping and client request path for 4xx failures."
                  : code && String(code).startsWith("5")
                    ? "Check server-side exception path and downstream dependencies for 5xx failures."
                    : "Inspect snapshot error details and stack traces for root-cause path.",
              });
            }
          }
          if (fallbackRows.length > 0) {
            return res.json(
              fallbackRows
                .sort((a, b) => Number(b.timestamp ?? 0) - Number(a.timestamp ?? 0))
                .slice(0, 300)
            );
          }
        }
      }
    }
    // Fallback: no credentials configured → empty
    return res.json([]);
  });
  app.get("/api/errors/:errorId/ai-analysis", async (req, res) => {
    if (String(req.params.errorId ?? "").startsWith("SNAP-")) {
      const confidence = 0.84;
      const primaryRootCause = "Call-level AppDynamics snapshot indicates a request-path specific failure with concrete error evidence.";
      const suggestedActions = [
        "Validate request path, query/body parameters, and expected status code behavior.",
        "Check server logs around the snapshot timestamp for matching exceptions.",
        "Inspect downstream calls and dependency latency for this request path.",
      ];
      return res.json({
        summary: "Call-level AppDynamics error snapshot.",
        rootCause: primaryRootCause,
        recommendations: suggestedActions,
        confidence,
        primaryRootCause,
        contributingFactors: [
          { factor: "Request-level error evidence captured by AppDynamics snapshot", severity: "High" },
          { factor: "Endpoint/route or input mismatch likely for this call path", severity: "Medium" },
        ],
        suggestedActions,
      });
    }
    const numId = parseInt(req.params.errorId.replace("ERR-", ""));
    if (isNaN(numId)) return res.json({ summary: "", rootCause: "", recommendations: [], confidence: 0 });
    try {
      const [err] = await db.select().from(dbErrors).where(eq(dbErrors.id, numId));
      if (!err) return res.json({ summary: "", rootCause: "", recommendations: [], confidence: 0 });
      const sev = err.severity ?? "Warning";
      const confidence = (sev === "Critical" ? 87 : 72) / 100;
      const primaryRootCause = `Root cause hypothesis: ${err.message ? err.message.substring(0, 180) : "resource exhaustion or configuration drift in affected service path"}.`;
      const suggestedActions = [
        `Investigate ${err.service ?? "the affected service"} for saturation/configuration issues`,
        "Review recent deployments or config changes before first occurrence",
        "Validate downstream dependencies and timeout/error boundaries",
      ];
      return res.json({
        summary: `${err.errorType ?? "Application error"} detected in ${err.service ?? err.applicationName ?? "service"} with ${(err.frequency ?? 1).toLocaleString()} occurrences. ${sev === "Critical" ? "This is a high-impact issue requiring immediate attention." : "Monitoring recommended."}`,
        rootCause: primaryRootCause,
        recommendations: suggestedActions,
        confidence,
        primaryRootCause,
        contributingFactors: [
          { factor: `Error type: ${err.errorType ?? "Application Error"}`, severity: sev === "Critical" ? "Critical" : "High" },
          { factor: `Service context: ${err.service ?? err.applicationName ?? "Unknown Service"}`, severity: "Medium" },
          { factor: `Frequency: ${(err.frequency ?? 1).toLocaleString()} occurrences`, severity: "Medium" },
        ],
        suggestedActions: [
          ...suggestedActions,
          sev === "Critical" ? "Escalate to on-call immediately due to production impact." : "Monitor trend and auto-close if no recurrence.",
        ],
      });
    } catch { return res.json({ summary: "", rootCause: "", recommendations: [], confidence: 0 }); }
  });

  app.get("/api/errors/:errorId/correlated", async (req, res) => {
    const snap = String(req.params.errorId ?? "").match(/^SNAP-(\d+)-(\d+)-(\d+)-(\d+)$/);
    if (snap) {
      const appExternalId = String(snap[1]);
      try {
        const [alerts, incidents] = await Promise.all([
          db.select().from(dbAlerts).where(eq(dbAlerts.applicationId, appExternalId)).orderBy(desc(dbAlerts.triggeredAt)).limit(6),
          db.select().from(dbIncidents).where(eq(dbIncidents.applicationId, appExternalId)).orderBy(desc(dbIncidents.startTime)).limit(6),
        ]);
        return res.json({
          linkedIncident: incidents.find((i) => i.status === "Open")?.externalId ?? null,
          relatedAlerts: alerts.map((a) => ({
            alertId: `ALT-${a.id}`,
            severity: a.severity ?? "Warning",
            rule: a.name,
            status: a.status ?? "Active",
            timestamp: a.triggeredAt?.getTime() ?? Date.now(),
          })),
          relatedIncidents: incidents.map((i) => ({
            incidentId: i.externalId,
            title: i.title,
            severity: i.severity ?? "Warning",
            status: i.status ?? "Open",
          })),
          relatedErrors: [],
        });
      } catch {
        return res.json({ linkedIncident: null, relatedAlerts: [], relatedIncidents: [], relatedErrors: [] });
      }
    }
    const numId = parseInt(req.params.errorId.replace("ERR-", ""));
    if (isNaN(numId)) return res.json({ linkedIncident: null, relatedAlerts: [], relatedIncidents: [], relatedErrors: [] });
    try {
      const [err] = await db.select().from(dbErrors).where(eq(dbErrors.id, numId));
      if (!err) return res.json({ linkedIncident: null, relatedAlerts: [], relatedIncidents: [], relatedErrors: [] });
      const [alerts, incidents] = await Promise.all([
        db.select().from(dbAlerts).where(eq(dbAlerts.applicationId, err.applicationId ?? "")).orderBy(desc(dbAlerts.triggeredAt)).limit(6),
        db.select().from(dbIncidents).where(eq(dbIncidents.applicationId, err.applicationId ?? "")).orderBy(desc(dbIncidents.startTime)).limit(6),
      ]);
      const siblings = await db.select().from(dbErrors)
        .where(and(eq(dbErrors.applicationId, err.applicationId ?? ""), sql`${dbErrors.id} != ${numId}`))
        .orderBy(desc(dbErrors.frequency)).limit(6);
      return res.json({
        linkedIncident: incidents.find((i) => i.status === "Open")?.externalId ?? null,
        relatedAlerts: alerts.map((a) => ({
          alertId: `ALT-${a.id}`,
          severity: a.severity ?? "Warning",
          rule: a.name,
          status: a.status ?? "Active",
          timestamp: a.triggeredAt?.getTime() ?? Date.now(),
        })),
        relatedIncidents: incidents.map((i) => ({
          incidentId: i.externalId,
          title: i.title,
          severity: i.severity ?? "Warning",
          status: i.status ?? "Open",
        })),
        relatedErrors: siblings.map(e => ({
          errorId: `ERR-${e.id}`, type: e.errorType ?? "Error", message: e.message?.substring(0, 100),
          service: e.service, severity: e.severity, count: e.frequency,
          firstSeen: e.firstSeen?.getTime(), lastSeen: e.lastOccurrence?.getTime(),
          applicationName: e.applicationName,
        })),
      });
    } catch { return res.json({ linkedIncident: null, relatedAlerts: [], relatedIncidents: [], relatedErrors: [] }); }
  });

  app.get("/api/errors/:errorId/predictions", async (req, res) => {
    if (String(req.params.errorId ?? "").startsWith("SNAP-")) {
      const forecastCurve = Array.from({ length: 24 }).map((_, i) => {
        const predicted = Math.min(95, 35 + i * 1.8 + Math.random() * 4);
        return { hour: i, predicted, lower: Math.max(0, predicted - 8), upper: Math.min(100, predicted + 8) };
      });
      return res.json({
        escalationToIncident: { probability: 0.52, timeframe: "next 4h" },
        errorSpike: { probability: 0.66, multiplier: "1.8x" },
        downstreamCascade: { probability: 0.34, services: ["API", "DB"] },
        recurrence: { probability: 0.61, hoursUntil: 6 },
        forecastCurve,
      });
    }
    const numId = parseInt(req.params.errorId.replace("ERR-", ""));
    if (isNaN(numId)) return res.json({});
    try {
      const [err] = await db.select().from(dbErrors).where(eq(dbErrors.id, numId));
      if (!err) return res.json({});
      const base = Number(err.frequency ?? 1);
      const inc = err.frequencyTrend === "increasing" ? 1.08 : err.frequencyTrend === "decreasing" ? 0.93 : 1.0;
      const sevBoost = (err.severity ?? "Warning") === "Critical" ? 18 : (err.severity ?? "Warning") === "High" ? 10 : 4;
      const forecastCurve = Array.from({ length: 24 }).map((_, i) => {
        const raw = Math.min(100, Math.max(5, 25 + sevBoost + (Math.pow(inc, i) - 1) * 40 + Math.random() * 5));
        return { hour: i, predicted: raw, lower: Math.max(0, raw - 10), upper: Math.min(100, raw + 10) };
      });
      return res.json({
        escalationToIncident: { probability: Math.min(0.95, 0.2 + sevBoost / 100 + Math.min(base / 500, 0.3)), timeframe: "next 2-6h" },
        errorSpike: { probability: Math.min(0.95, 0.25 + Math.min(base / 300, 0.35)), multiplier: `${(1 + Math.min(base / 200, 2)).toFixed(1)}x` },
        downstreamCascade: { probability: Math.min(0.9, 0.15 + sevBoost / 120), services: [err.service ?? "Primary Service", "Database"] },
        recurrence: { probability: Math.min(0.95, 0.3 + Math.min(base / 400, 0.35)), hoursUntil: (err.severity ?? "Warning") === "Critical" ? 2 : 8 },
        forecastCurve,
      });
    } catch { return res.json({}); }
  });
  app.get("/api/errors/:errorId", async (req, res) => {
    const looksLikeId = (value: string | null | undefined) => {
      const v = String(value ?? "").trim();
      return v.length > 0 && /^\d+$/.test(v);
    };
    const pickReadable = (...values: Array<string | null | undefined>) => {
      const cleaned = values
        .map((v) => String(v ?? "").trim())
        .filter((v) => v.length > 0 && v.toLowerCase() !== "n/a" && v.toLowerCase() !== "unknown");
      if (cleaned.length === 0) return "";
      const named = cleaned.find((v) => !looksLikeId(v));
      return named ?? cleaned[0];
    };

    const snapMatch = String(req.params.errorId ?? "").match(/^SNAP-(\d+)-(\d+)-(\d+)-(\d+)$/);
    if (snapMatch) {
      const appExternalNum = Number(snapMatch[1]);
      const btId = Number(snapMatch[2]);
      const ts = Number(snapMatch[3]);
      const idx = Number(snapMatch[4]);
      if (Number.isFinite(appExternalNum) && Number.isFinite(btId) && Number.isFinite(ts)) {
        try {
          const [appRow] = await db.select().from(dbApplications).where(eq(dbApplications.externalId, String(appExternalNum))).limit(1);
          if (appRow?.credentialId != null && appRow.source === "appdynamics") {
            const [cred] = await db.select().from(apmCredentials).where(eq(apmCredentials.id, appRow.credentialId)).limit(1);
            if (cred) {
              let resolvedPassword = String(cred.passwordHash ?? "");
              try {
                resolvedPassword = String(decryptSecret(cred.passwordHash) ?? resolvedPassword);
              } catch {
                resolvedPassword = String(cred.passwordHash ?? "");
              }
              const client = createAppDynamicsClient({
                controllerUrl: cred.controllerUrl,
                account: cred.account ?? "",
                username: cred.username ?? "",
                password: resolvedPassword,
              });
              if (client) {
                const snaps = await client.getRequestSnapshots(appExternalNum, btId, 180);
                const candidates = (Array.isArray(snaps) ? snaps : [])
                  .filter((s: any) => Number(s?.businessTransactionId ?? NaN) === btId);
                const ordered = candidates.sort((a: any, b: any) => {
                  const ta = Number(a?.localStartTime ?? a?.serverStartTime ?? 0);
                  const tb = Number(b?.localStartTime ?? b?.serverStartTime ?? 0);
                  return Math.abs(ta - ts) - Math.abs(tb - ts);
                });
                const chosen = ordered[idx] ?? ordered[0] ?? null;
                if (chosen) {
                  const detail0 = Array.isArray(chosen?.errorDetails) && chosen.errorDetails.length > 0 ? chosen.errorDetails[0] : null;
                  const path = String(chosen?.URL ?? "");
                  const httpCode = Array.isArray(chosen?.httpParameters)
                    ? chosen.httpParameters.find((p: any) => String(p?.name ?? "").toLowerCase() === "http-response-code")?.value ?? null
                    : null;
                  const stackTrace = Array.isArray(chosen?.stackTraces) && chosen.stackTraces.length > 0
                    ? JSON.stringify(chosen.stackTraces, null, 2)
                    : null;
                  const message = String(detail0?.value ?? detail0?.name ?? chosen?.errorSummary ?? chosen?.summary ?? "Application error");
                  const sev = chosen?.errorOccured ? "High" : "Medium";
                  const when = Number(chosen?.localStartTime ?? chosen?.serverStartTime ?? ts);
                  const isErr = (s: any) =>
                    Boolean(s?.errorOccured) ||
                    (Array.isArray(s?.errorDetails) && s.errorDetails.length > 0) ||
                    String(s?.summary ?? "").toLowerCase().includes("[error]") ||
                    String(s?.errorSummary ?? "").trim().length > 0;
                  const errorCalls = ordered.filter((s: any) => isErr(s));
                  const historyStart = when - (23 * 60 * 60 * 1000);
                  const buckets = Array.from({ length: 24 }).map((_, h) => ({ hour: h, count: 0, isSpike: false }));
                  for (const s of errorCalls) {
                    const t = Number(s?.localStartTime ?? s?.serverStartTime ?? NaN);
                    if (!Number.isFinite(t) || t < historyStart || t > when) continue;
                    const h = Math.max(0, Math.min(23, Math.floor((t - historyStart) / (60 * 60 * 1000))));
                    buckets[h].count += 1;
                  }
                  const avgBucket = buckets.reduce((a, b) => a + b.count, 0) / Math.max(1, buckets.length);
                  for (const b of buckets) b.isSpike = b.count > (avgBucket * 2.2) && b.count > 1;
                  const txnName = String(chosen?.businessTransactionName ?? `BT-${btId}`);
                  const relatedSimilar = errorCalls
                    .slice(0, 5)
                    .map((s: any, i: number) => {
                      const d = Array.isArray(s?.errorDetails) && s.errorDetails.length > 0 ? s.errorDetails[0] : null;
                      return {
                        errorId: `SNAP-${appExternalNum}-${btId}-${Number(s?.localStartTime ?? s?.serverStartTime ?? when)}-${i}`,
                        type: String(d?.name ?? "Business Transaction Error"),
                        message: String(d?.value ?? s?.summary ?? s?.errorSummary ?? "Request error"),
                      };
                    });
                  const dependencyMap = [
                    { id: "svc", type: "service", label: appRow?.name ?? "Application", status: "Warning" },
                    { id: "bt", type: "component", label: txnName, status: chosen?.errorOccured ? "Critical" : "Warning" },
                    { id: "web", type: "external", label: "HTTP Endpoint", status: chosen?.errorOccured ? "Critical" : "Warning" },
                  ];
                  const dependencyEdges = [
                    { from: appRow?.name ?? "Application", to: txnName, latency: `${Math.round(Number(chosen?.timeTakenInMilliSecs ?? 0))}ms`, status: chosen?.errorOccured ? "Critical" : "Warning" },
                    { from: txnName, to: path || "URL", latency: `${Math.round(Number(chosen?.timeTakenInMilliSecs ?? 0))}ms`, status: chosen?.errorOccured ? "Critical" : "Warning" },
                  ];
                  const readableService = pickReadable(
                    String(chosen?.businessTransactionName ?? ""),
                    txnName,
                    String((chosen as any)?.tierName ?? ""),
                    `Business Transaction ${btId}`,
                  ) || `Business Transaction ${btId}`;
                  const readableServer = pickReadable(
                    String((chosen as any)?.applicationComponentNodeName ?? ""),
                    String((chosen as any)?.applicationComponentName ?? ""),
                    String((chosen as any)?.nodeName ?? ""),
                    String((chosen as any)?.applicationComponentNodeId != null ? `Node ${(chosen as any)?.applicationComponentNodeId}` : ""),
                  ) || "N/A";
                  return res.json({
                    errorId: req.params.errorId,
                    type: String(detail0?.name ?? "Business Transaction Error"),
                    message,
                    severity: sev,
                    status: "Active",
                    source: "AppDynamics",
                    service: readableService,
                    server: readableServer,
                    applicationName: appRow?.name ?? "Unknown",
                    count: 1,
                    firstOccurrence: when,
                    lastOccurrence: when,
                    firstSeen: when,
                    duration: "0m",
                    clusterId: `BT-${btId}`,
                    aiSeverityScore: chosen?.errorOccured ? 82 : 60,
                    userImpactCount: chosen?.errorOccured ? 1 : 0,
                    requestPath: path || null,
                    httpCode,
                    sourceSystem: "AppDynamics",
                    stackTrace,
                    linkedIncident: null,
                    frequencyHistory: buckets,
                    affectedTransactions: [
                      {
                        name: txnName,
                        impactedCalls: errorCalls.length,
                        errorRate: Math.min(100, Number(((errorCalls.length / Math.max(1, candidates.length)) * 100).toFixed(2))),
                        p99: Math.round(Number(chosen?.timeTakenInMilliSecs ?? 0) * 1.4),
                        revenueImpact: chosen?.errorOccured ? "High" : "Medium",
                      },
                    ],
                    dependencyMap,
                    dependencyEdges,
                    cluster: {
                      label: `BT ${txnName} Error Cluster`,
                      rootCause: message,
                      confidence: 92,
                      similarErrors: relatedSimilar,
                    },
                    debugAssistant: {
                      suggestedQuestions: [
                        "What is the exact failing call and reason?",
                        "How can I fix this endpoint error?",
                        "Which dependency is likely causing this failure?",
                      ],
                      responses: {
                        "root cause": message,
                        "fix": httpCode && String(httpCode).startsWith("4")
                          ? "Validate route mapping and client request URL/parameters. Check recent rewrites or missing pages."
                          : "Inspect application logs at the same timestamp and trace downstream dependency calls to isolate the failing component.",
                        "impact": "This is a call-level AppDynamics snapshot error entry derived from transaction diagnostics.",
                      },
                    },
                  });
                }
              }
            }
          }
        } catch {
          // fall through to DB-backed error details below
        }
      }
    }
    const numId = parseInt(req.params.errorId.replace("ERR-", ""));
    if (isNaN(numId)) return res.status(404).json({ message: "Error not found" });
    try {
      const [err] = await db.select().from(dbErrors).where(eq(dbErrors.id, numId));
      if (!err) return res.status(404).json({ message: "Error not found" });
      const [app] = await db.select({ name: dbApplications.name }).from(dbApplications).where(eq(dbApplications.externalId, err.applicationId ?? ""));
      const now = Date.now();
      const firstMs = err.firstSeen?.getTime() ?? now - 86400000;
      const lastMs = err.lastOccurrence?.getTime() ?? now;
      const durationMins = Math.floor((lastMs - firstMs) / 60000);
      const sev = err.severity ?? "Warning";
      const meta = ((err.metadata as any) ?? {}) as Record<string, any>;
      const nowIso = new Date(lastMs).toISOString();
      const baseFreq = Math.max(1, Number(err.frequency ?? 1));
      const aiScore = Math.max(
        15,
        Math.min(
          98,
          Math.round(
            (sev === "Critical" ? 78 : sev === "High" ? 62 : sev === "Medium" ? 45 : 30) +
            Math.min(18, Math.log10(baseFreq + 1) * 12)
          )
        )
      );
      const similarRows = await db.select().from(dbErrors)
        .where(and(
          eq(dbErrors.applicationId, err.applicationId ?? ""),
          sql`${dbErrors.id} != ${numId}`,
        ))
        .orderBy(desc(dbErrors.lastOccurrence))
        .limit(80);

      const historyStart = lastMs - (23 * 60 * 60 * 1000);
      const bucketSize = 60 * 60 * 1000;
      const frequencyHistory = Array.from({ length: 24 }).map((_, hour) => ({ hour, count: 0, isSpike: false }));

      const pushIntoHistory = (timeMs: number, amount: number) => {
        if (!Number.isFinite(timeMs) || !Number.isFinite(amount) || amount <= 0) return;
        if (timeMs < historyStart || timeMs > lastMs) return;
        const idx = Math.max(0, Math.min(23, Math.floor((timeMs - historyStart) / bucketSize)));
        frequencyHistory[idx].count += Math.round(amount);
      };

      pushIntoHistory(lastMs, baseFreq);
      for (const row of similarRows) {
        const t = row.lastOccurrence?.getTime() ?? row.firstSeen?.getTime() ?? null;
        if (!t) continue;
        pushIntoHistory(t, Math.max(1, Number(row.frequency ?? 1)));
      }
      const avgBucketCount = frequencyHistory.reduce((sum, b) => sum + b.count, 0) / Math.max(1, frequencyHistory.length);
      for (const b of frequencyHistory) b.isSpike = b.count > (avgBucketCount * 2.1) && b.count >= 2;

      const txRows = err.applicationId
        ? await db.select().from(dbTransactions)
          .where(eq(dbTransactions.applicationId, err.applicationId))
          .orderBy(desc(dbTransactions.updatedAt))
          .limit(40)
        : [];
      const affectedTransactions = txRows
        .map((tx) => {
          const txErrRateRaw = Number(tx.errorRate ?? 0);
          const txErrRate = txErrRateRaw <= 1 ? txErrRateRaw * 100 : txErrRateRaw;
          const callsPerMinute = Math.max(0, Number(tx.callsPerMinute ?? 0));
          const impactedCalls = Math.round(callsPerMinute * 60);
          const p99FromMeta = Number((tx.metadata as any)?.p99ResponseTime ?? NaN);
          const avgMs = Math.max(0, Number(tx.avgResponseTime ?? 0));
          return {
            name: tx.name,
            impactedCalls,
            errorRate: Number(Math.max(0, Math.min(100, txErrRate)).toFixed(2)),
            p99: Number.isFinite(p99FromMeta) ? Math.round(p99FromMeta) : Math.round(avgMs * 1.8),
            revenueImpact: txErrRate >= 5 ? "High" : txErrRate >= 1 ? "Medium" : "Low",
          };
        })
        .sort((a, b) => (b.errorRate * 100 + b.impactedCalls) - (a.errorRate * 100 + a.impactedCalls))
        .slice(0, 8);

      const mainService = pickReadable(
        meta?.businessTransactionName,
        meta?.tierName,
        err.service,
        err.applicationName,
      ) || "Application Service";
      const mainServer = pickReadable(
        meta?.nodeName,
        meta?.applicationComponentNodeName,
        meta?.triggeredEntity?.name,
        meta?.nodeId != null ? `Node ${meta.nodeId}` : null,
      ) || "N/A";
      const mainComponent = affectedTransactions[0]?.name ?? mainService;
      const dependencyMap = [
        { id: "svc", type: "service", label: app?.name ?? err.applicationName ?? "Application", status: sev === "Critical" ? "Critical" : "Warning" },
        { id: "cmp", type: "component", label: mainComponent, status: sev === "Critical" ? "Critical" : "Warning" },
        { id: "ext", type: "external", label: String(meta?.triggeredEntity?.name ?? meta?.nodeName ?? "Downstream Dependency"), status: "Warning" },
      ];
      const dependencyEdges = [
        {
          from: app?.name ?? err.applicationName ?? "Application",
          to: mainComponent,
          latency: `${Math.round(affectedTransactions[0]?.p99 ?? Number(meta?.responseTime ?? 0) ?? 0)}ms`,
          status: sev === "Critical" ? "Critical" : "Warning",
        },
        {
          from: mainComponent,
          to: String(meta?.triggeredEntity?.name ?? meta?.nodeName ?? "Dependency"),
          latency: `${Math.round((affectedTransactions[1]?.p99 ?? affectedTransactions[0]?.p99 ?? 0) * 0.8)}ms`,
          status: sev === "Critical" ? "Critical" : "Warning",
        },
      ];

      const similarErrors = similarRows
        .slice(0, 6)
        .map((row) => ({
          errorId: `ERR-${row.id}`,
          type: row.errorType ?? "Application Error",
          message: String(row.message ?? row.cluster ?? "Error").slice(0, 180),
        }));

      const linkedOpenIncident = err.applicationId
        ? await db.select({ externalId: dbIncidents.externalId })
          .from(dbIncidents)
          .where(and(eq(dbIncidents.applicationId, err.applicationId), eq(dbIncidents.status, "Open")))
          .orderBy(desc(dbIncidents.startTime))
          .limit(1)
        : [];
      return res.json({
        errorId: `ERR-${err.id}`,
        type: err.errorType ?? "Application Error",
        message: err.message ?? err.cluster,
        severity: sev,
        status: err.status ?? "Active",
        source: err.source === "appdynamics" ? "AppDynamics" : "Dynatrace",
        service: mainService,
        server: mainServer,
        applicationName: app?.name ?? err.applicationName ?? "Unknown",
        count: err.frequency ?? 1,
        firstOccurrence: firstMs,
        lastOccurrence: lastMs,
        firstSeen: firstMs,
        duration: durationMins > 60 ? `${Math.floor(durationMins / 60)}h ${durationMins % 60}m` : `${durationMins}m`,
        clusterId: err.cluster ?? "production",
        cluster: {
          label: err.cluster ?? "production",
          rootCause: err.message ?? err.cluster ?? "Service-side exception with repeated occurrences",
          confidence: Math.max(70, Math.min(96, aiScore)),
          similarErrors,
        },
        aiSeverityScore: aiScore,
        userImpactCount: sev === "Critical" ? Math.floor((err.frequency ?? 1) * 0.4) : Math.floor((err.frequency ?? 1) * 0.1),
        requestPath: meta?.requestPath ?? meta?.URL ?? null,
        httpCode: meta?.httpCode ?? null,
        sourceSystem: err.source === "appdynamics" ? "AppDynamics" : "Dynatrace",
        stackTrace: meta?.stackTrace ?? null,
        linkedIncident: linkedOpenIncident[0]?.externalId ?? null,
        frequencyHistory,
        affectedTransactions: affectedTransactions.length > 0 ? affectedTransactions : [
          {
            name: mainService,
            impactedCalls: baseFreq,
            errorRate: sev === "Critical" ? 8.5 : sev === "High" ? 4.2 : 1.3,
            p99: Math.round(Number(meta?.responseTime ?? 900)),
            revenueImpact: sev === "Critical" ? "High" : "Medium",
          },
        ],
        dependencyMap,
        dependencyEdges,
        debugAssistant: {
          suggestedQuestions: [
            "What is the exact failing flow and likely root cause?",
            "Which transactions are impacted the most right now?",
            "What should I check first to resolve this error quickly?",
          ],
          responses: {
            "root cause": `This ${err.errorType ?? "error"} in ${mainService} is most likely caused by: ${err.message ? err.message.substring(0, 180) : "resource saturation, dependency timeout, or configuration drift"} (last seen ${nowIso}).`,
            "fix": `To resolve this: 1) Check ${mainService} logs around ${nowIso}, 2) inspect impacted transactions (${affectedTransactions.slice(0, 3).map((t) => t.name).join(", ") || mainService}), 3) validate downstream dependency health and timeout settings.`,
            "impact": `This error has occurred ${(err.frequency ?? 1).toLocaleString()} times. ${sev === "Critical" ? "It is critically impacting production operations." : "Impact is moderate — monitor closely."}`,
          },
        },
      });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });
  // === Incidents List (org-scoped) ===
  app.get("/api/incidents", async (req, res) => {
    try {
      const user = req.user as import("@shared/schema").User | undefined;
      let credIds: number[] = [];
      if (user) {
        const orgData = await getUserOrg(user.id);
        if (orgData) {
          const orgCreds = await db.select({ id: apmCredentials.id })
            .from(apmCredentials)
            .where(and(eq(apmCredentials.organizationId, orgData.org.id), eq(apmCredentials.isActive, true)));
          credIds = orgCreds.map((c) => c.id);
        }
      }
      // Fallback for sessions where app-scoped pages still work without auth context.
      if (credIds.length === 0) {
        const activeCreds = await db.select({ id: apmCredentials.id })
          .from(apmCredentials)
          .where(eq(apmCredentials.isActive, true));
        credIds = activeCreds.map((c) => c.id);
      }
      if (credIds.length === 0) return res.json([]);

      const scopedApps = await db.select({
        externalId: dbApplications.externalId,
        id: dbApplications.id,
        name: dbApplications.name,
        source: dbApplications.source,
      }).from(dbApplications)
        .where(credIds.length === 1
          ? eq(dbApplications.credentialId, credIds[0])
          : sql`${dbApplications.credentialId} = ANY(ARRAY[${sql.join(credIds.map(id => sql`${id}`), sql`, `)}]::integer[])`);
      if (scopedApps.length === 0) return res.json([]);

      // Keep global incidents aligned with app pages by matching only current active apps.
      // Some historical rows may store internal app id or app name, so we include a fallback.
      const incidentsByExternalId = await db.select().from(dbIncidents)
        .where(credIds.length === 1
          ? sql`${dbIncidents.applicationId} IN (SELECT external_id::text FROM apm_applications WHERE credential_id = ${credIds[0]})`
          : sql`${dbIncidents.applicationId} IN (SELECT external_id::text FROM apm_applications WHERE credential_id = ANY(ARRAY[${sql.join(credIds.map(id => sql`${id}`), sql`, `)}]::integer[]))`)
        .orderBy(desc(dbIncidents.startTime))
        .limit(500);

      const incidents = incidentsByExternalId.length > 0
        ? incidentsByExternalId
        : await (async () => {
            const scopedExternalIds = scopedApps.map((a) => String(a.externalId)).filter(Boolean);
            const scopedNumericIds = scopedApps.map((a) => String(a.id)).filter(Boolean);
            const scopedNames = scopedApps.map((a) => String(a.name)).filter(Boolean);
            const allScopedAppKeys = Array.from(new Set([
              ...scopedExternalIds,
              ...scopedNumericIds,
              ...scopedNames,
            ])).filter(Boolean);
            if (allScopedAppKeys.length === 0) return [];
            return db.select().from(dbIncidents)
              .where(allScopedAppKeys.length === 1
                ? eq(dbIncidents.applicationId, allScopedAppKeys[0])
                : sql`${dbIncidents.applicationId} = ANY(ARRAY[${sql.join(allScopedAppKeys.map(id => sql`${id}`), sql`, `)}]::text[])`)
              .orderBy(desc(dbIncidents.startTime))
              .limit(500);
          })();

      const appMap = new Map<string, { externalId: string; id: number; name: string; source: string }>();
      for (const a of scopedApps) {
        appMap.set(String(a.externalId), a as any);
        appMap.set(String(a.id), a as any);
        appMap.set(String(a.name), a as any);
      }
      if (incidents.length === 0) {
        const now = Date.now();
        return res.json(
          scopedApps.map((a) => ({
            incidentId: `PRED-${a.id}`,
            id: `PRED-${a.id}`,
            title: `Predicted SLA breach risk for ${a.name}`,
            severity: "Warning",
            status: "Open",
            startTime: now - 10 * 60 * 1000,
            endTime: null,
            affectedServices: [a.name],
            affectedTiers: ["Application"],
            rootCause: "Forecast indicates elevated breach probability from current performance trend.",
            mttr: null,
            impactScore: 55,
            applicationName: a.name,
            applicationId: a.id,
          })),
        );
      }
      return res.json(incidents.map(inc => {
        const sev = inc.severity ?? "Warning";
        const appInfo = appMap.get(String(inc.applicationId ?? ""));
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
          mttr: inc.mttr ?? null,
          impactScore: sev === "Critical" ? 88 : sev === "Warning" ? 55 : 20,
          applicationName: appInfo?.name ?? inc.applicationId,
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
        const sev = dbInc.severity ?? "Warning";
        const relatedAlerts = await db.select().from(dbAlerts)
          .where(eq(dbAlerts.applicationId, dbInc.applicationId))
          .orderBy(desc(dbAlerts.triggeredAt))
          .limit(40);
        const relatedErrors = await db.select().from(dbErrors)
          .where(eq(dbErrors.applicationId, dbInc.applicationId))
          .orderBy(desc(dbErrors.lastOccurrence))
          .limit(40);
        const txRows = await db.select().from(dbTransactions)
          .where(eq(dbTransactions.applicationId, dbInc.applicationId))
          .orderBy(desc(dbTransactions.updatedAt))
          .limit(120);
        const [app] = await db.select({ id: dbApplications.id, name: dbApplications.name }).from(dbApplications).where(eq(dbApplications.externalId, dbInc.applicationId));
        const services: string[] = (dbInc.affectedServices as string[]) ?? [];
        const alertTimes = relatedAlerts
          .map((a) => a.triggeredAt?.getTime?.() ?? null)
          .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
        const errorTimes = relatedErrors
          .flatMap((e) => [e.firstSeen?.getTime?.() ?? null, e.lastOccurrence?.getTime?.() ?? null])
          .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
        const txTimes = txRows
          .map((t) => t.updatedAt?.getTime?.() ?? null)
          .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
        const signalTimes = [...alertTimes, ...errorTimes, ...txTimes];
        const inferredStart = signalTimes.length > 0 ? Math.min(...signalTimes) : null;
        const inferredEnd = signalTimes.length > 0 ? Math.max(...signalTimes) : null;
        const startMs = dbInc.startTime?.getTime?.()
          ?? dbInc.createdAt?.getTime?.()
          ?? inferredStart
          ?? (now - 30 * 60 * 1000);
        const endMs = dbInc.status === "Resolved"
          ? (dbInc.endTime?.getTime?.() ?? inferredEnd ?? now)
          : (dbInc.endTime?.getTime?.() ?? null);
        const durationMins = Math.max(1, Math.floor(((endMs ?? now) - startMs) / 60000));

        const severityBase = sev === "Critical" ? 72 : sev === "High" ? 66 : sev === "Warning" ? 60 : 55;
        const criticalAlerts = relatedAlerts.filter((a) => (a.severity ?? "").toLowerCase() === "critical").length;
        const openAlerts = relatedAlerts.filter((a) => (a.status ?? "").toLowerCase() !== "resolved").length;
        const errorVolume = relatedErrors.reduce((sum, e) => sum + Math.max(1, Number(e.frequency ?? 1)), 0);
        const txStress = txRows.slice(0, 30).filter((t) => Number(t.avgResponseTime ?? 0) >= 1800 || Number(t.errorRate ?? 0) >= 2).length;
        const txErrMax = txRows.slice(0, 30).reduce((m, t) => Math.max(m, Number(t.errorRate ?? 0)), 0);
        const confidenceRaw = severityBase
          + (criticalAlerts * 4)
          + (openAlerts * 1.2)
          + Math.min(12, Math.log10(1 + errorVolume) * 8)
          + Math.min(10, txStress * 1.8)
          + Math.min(6, txErrMax * 1.5)
          + Math.min(4, Math.max(0, services.length - 1))
          + (dbInc.status === "Resolved" ? -4 : 2)
          + (dbInc.rootCause ? 2 : 0);
        const confidence = Math.max(55, Math.min(96, Math.round(confidenceRaw)));
        const user = req.user as import("@shared/schema").User | undefined;
        const orgData = user ? await getUserOrg(user.id) : null;
        const orgId = orgData?.org?.id ?? null;
        const noteQuery = db.select().from(incidentNotes).where(orgId != null
          ? and(eq(incidentNotes.incidentId, dbInc.externalId), eq(incidentNotes.organizationId, orgId))
          : eq(incidentNotes.incidentId, dbInc.externalId))
          .orderBy(desc(incidentNotes.createdAt))
          .limit(100);
        const savedNotes = await noteQuery;
        const notes = (savedNotes.length > 0 ? savedNotes : [{
          id: -1 as any,
          author: "AI Engine",
          role: "Perviewsis AI",
          avatar: "AI",
          content: `Analysis complete: ${dbInc.rootCause ?? "Root cause identification in progress. AI is correlating signals across affected services."}`,
          tags: ["AI Summary", "Root Cause"],
          createdAt: new Date(startMs + 180000),
        } as any]).map((n: any) => ({
          id: String(n.id),
          author: n.author,
          role: n.role,
          avatar: n.avatar,
          timestamp: n.createdAt?.getTime?.() ?? now,
          content: n.content,
          tags: Array.isArray(n.tags) ? n.tags : [],
        }));

        const timelineBase: Array<{ at: number; event: string; detail: string; type: string; icon: string }> = [
          { at: Math.max(startMs - 10 * 60 * 1000, now - 24 * 60 * 60 * 1000), event: "Metric deviation begins", detail: "Service latency and error rate begin deviating from baseline.", type: "metric", icon: "metric" },
          { at: startMs - 3 * 60 * 1000, event: "Anomaly threshold crossed", detail: "Performance metrics exceeded warning thresholds and incident correlation started.", type: "detection", icon: "brain" },
          { at: startMs, event: `Incident ${dbInc.externalId} created`, detail: `${sev} incident auto-created. ${services.length} services affected.`, type: "incident", icon: "incident" },
        ];
        const alertTimeline = relatedAlerts
          .map((a) => ({
            at: a.triggeredAt?.getTime?.() ?? null,
            event: `Alert triggered: ${a.name}`,
            detail: `${a.severity ?? "Warning"} alert is correlated with this incident.`,
            type: "warning",
            icon: "warning",
          }))
          .filter((e) => typeof e.at === "number" && Number.isFinite(e.at))
          .slice(0, 5) as Array<{ at: number; event: string; detail: string; type: string; icon: string }>;
        const errorTimeline = relatedErrors
          .map((e) => ({
            at: e.lastOccurrence?.getTime?.() ?? e.firstSeen?.getTime?.() ?? null,
            event: `Error burst: ${e.cluster ?? e.errorType ?? "Application Error"}`,
            detail: `${Number(e.frequency ?? 1).toLocaleString()} occurrences observed on correlated services.`,
            type: "metric",
            icon: "metric",
          }))
          .filter((e) => typeof e.at === "number" && Number.isFinite(e.at))
          .slice(0, 3) as Array<{ at: number; event: string; detail: string; type: string; icon: string }>;
        const timeline = [...timelineBase, ...alertTimeline, ...errorTimeline,
          { at: startMs + 3 * 60 * 1000, event: "AI root cause hypothesis generated", detail: `Root cause identified with ${confidence}% confidence.`, type: "ai", icon: "brain" },
          ...(dbInc.status === "Resolved" && endMs ? [{ at: endMs, event: "Incident resolved", detail: `MTTR: ${dbInc.mttr ? `${Math.floor(dbInc.mttr / 60)}m` : `${Math.floor(((endMs) - startMs) / 60000)}m`}`, type: "resolved", icon: "resolved" }] : []),
        ].sort((a, b) => a.at - b.at).slice(0, 14);
        const txFromDb = txRows
          .map((t, i) => {
            const resp = Number(t.avgResponseTime ?? 0);
            const cpm = Number(t.callsPerMinute ?? 0);
            const err = Number(t.errorRate ?? 0);
            return {
              id: String(t.externalId ?? t.id ?? `tx-${i + 1}`),
              name: String(t.name ?? `Transaction ${i + 1}`),
              throughputDrop: Math.max(3, Math.min(90, Math.round((err * 8) + (resp / 180) + 8))),
              errorSpike: Math.max(0.2, Number((err > 0 ? err : 0.2).toFixed(2))),
              slaBreach: resp >= 2000 || err >= 3,
              avgResponseTime: Math.max(50, Math.round(resp || 600)),
              _cpm: cpm,
            };
          })
          .sort((a, b) => (b.errorSpike * 20 + b.avgResponseTime / 70 + b._cpm / 40) - (a.errorSpike * 20 + a.avgResponseTime / 70 + a._cpm / 40))
          .slice(0, 8);
        const affectedTransactions = txFromDb.length > 0
          ? txFromDb.map(({ _cpm, ...rest }) => rest)
          : services.slice(0, 2).map((svc, i) => ({
              id: `tx-${i + 1}`, name: svc,
              throughputDrop: sev === "Critical" ? 52 : 22,
              errorSpike: sev === "Critical" ? 5.2 : 1.8,
              slaBreach: sev === "Critical",
              avgResponseTime: sev === "Critical" ? 4500 : 1800,
            }));
        const traces = txFromDb.slice(0, 10).map((tx, i) => ({
          traceId: `TR-${dbInc.externalId}-${i + 1}`,
          name: tx.name,
          txId: tx.id,
          duration: Math.max(120, Math.round(tx.avgResponseTime * (1.4 + (i % 3) * 0.25))),
          spanCount: Math.max(3, Math.round((tx._cpm || 10) / 2) + 4),
          slowestSpan: i % 2 === 0 ? "DB query execution" : "Downstream API call",
        }));
        return res.json({
          incidentId: dbInc.externalId,
          applicationId: app?.id ?? null,
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
          affectedTransactions,
          traces,
          timeline,
          notes,
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
              { label: "View Related Alerts", href: app?.id ? `/alerts?incidentId=${encodeURIComponent(dbInc.externalId)}&appId=${encodeURIComponent(String(app.id))}` : `/alerts?incidentId=${encodeURIComponent(dbInc.externalId)}` },
              ...(app ? [{ label: `View ${app.name}`, href: `/applications/${app.id}` }] : []),
            ],
          },
        });
      }

      // Fallback for predicted incident cards generated in the app incidents page (e.g. PRED-72901)
      const predMatch = /^PRED-(.+)$/i.exec(incidentId);
      if (predMatch) {
        const appLookupId = predMatch[1];
        const app = await resolveDbApp(appLookupId);
        const now = Date.now();

        const appExternalId = app?.externalId ?? appLookupId;
        const [alerts, errors, servers, openIncidents, txRows] = await Promise.all([
          db.select().from(dbAlerts).where(eq(dbAlerts.applicationId, appExternalId)).orderBy(desc(dbAlerts.triggeredAt)).limit(40),
          db.select().from(dbErrors).where(eq(dbErrors.applicationId, appExternalId)).orderBy(desc(dbErrors.lastOccurrence)).limit(40),
          db.select().from(dbServers).where(eq(dbServers.applicationId, appExternalId)).limit(10),
          db.select().from(dbIncidents)
            .where(and(eq(dbIncidents.applicationId, appExternalId), eq(dbIncidents.status, "Active")))
            .limit(5),
          db.select().from(dbTransactions).where(eq(dbTransactions.applicationId, appExternalId)).orderBy(desc(dbTransactions.updatedAt)).limit(120),
        ]);

        const alertPressure = alerts.length;
        const errorPressure = errors.reduce((sum, e) => sum + Number(e.frequency ?? 1), 0);
        const healthViolations = Number(app?.healthRuleViolations ?? 0);
        const recentAlertTimes = alerts
          .map((a) => a.triggeredAt?.getTime?.() ?? null)
          .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
        const recentErrorTimes = errors
          .flatMap((e) => [e.firstSeen?.getTime?.() ?? null, e.lastOccurrence?.getTime?.() ?? null])
          .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
        const recentTxTimes = txRows
          .map((t) => t.updatedAt?.getTime?.() ?? null)
          .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
        const signalTimes = [...recentAlertTimes, ...recentErrorTimes, ...recentTxTimes];
        const latestSignalMs = signalTimes.length > 0 ? Math.max(...signalTimes) : now;
        const inferredWindowMins = Math.max(
          12,
          Math.min(
            180,
            12 + (alertPressure * 4) + Math.min(40, Math.floor(errorPressure / 12)) + Math.min(30, healthViolations * 3),
          ),
        );
        const startMs = Math.max(now - (24 * 60 * 60 * 1000), latestSignalMs - inferredWindowMins * 60 * 1000);
        const durationMins = Math.max(1, Math.floor((now - startMs) / 60000));

        const txStress = txRows.slice(0, 30).filter((t) => Number(t.avgResponseTime ?? 0) >= 1600 || Number(t.errorRate ?? 0) >= 1.5).length;
        const riskScore = Math.min(95, Math.max(
          45,
          45 + (healthViolations * 6) + (alertPressure * 4) + Math.floor(errorPressure / 10) + Math.min(10, txStress),
        ));
        const sev = riskScore >= 80 ? "Critical" : "Warning";
        const predictedConfidenceRaw = 54
          + (healthViolations * 3)
          + (alerts.filter((a) => (a.severity ?? "").toLowerCase() === "critical").length * 4)
          + (alertPressure * 1.5)
          + Math.min(14, Math.log10(1 + errorPressure) * 8)
          + Math.min(12, txStress * 2)
          + Math.min(6, openIncidents.length * 2);
        const confidence = Math.min(95, Math.max(60, Math.round(predictedConfidenceRaw)));
        const user = req.user as import("@shared/schema").User | undefined;
        const orgData = user ? await getUserOrg(user.id) : null;
        const orgId = orgData?.org?.id ?? null;
        const predNotes = await db.select().from(incidentNotes).where(orgId != null
          ? and(eq(incidentNotes.incidentId, incidentId), eq(incidentNotes.organizationId, orgId))
          : eq(incidentNotes.incidentId, incidentId))
          .orderBy(desc(incidentNotes.createdAt))
          .limit(100);
        const notes = (predNotes.length > 0 ? predNotes : [{
          id: -1 as any,
          author: "AI Engine",
          role: "Perviewsis AI",
          avatar: "AI",
          content: "This is a predictive incident generated from live telemetry trends. Use it as an early-warning workflow to prevent a hard outage.",
          tags: ["Prediction", "Proactive"],
          createdAt: new Date(now - 60_000),
        } as any]).map((n: any) => ({
          id: String(n.id),
          author: n.author,
          role: n.role,
          avatar: n.avatar,
          timestamp: n.createdAt?.getTime?.() ?? now,
          content: n.content,
          tags: Array.isArray(n.tags) ? n.tags : [],
        }));
        const timeline = [
          { at: startMs - 900000, event: "Baseline deviation detected", detail: "Early drift observed in throughput and latency trendlines.", type: "metric", icon: "metric" },
          { at: startMs - 420000, event: "Predictive risk model escalated", detail: `Forecast risk score reached ${riskScore}.`, type: "forecast", icon: "brain" },
          ...alerts.slice(0, 4).map((a) => ({
            at: a.triggeredAt?.getTime?.() ?? startMs - 120000,
            event: `Alert correlated: ${a.name}`,
            detail: `${a.severity ?? "Warning"} alert contributed to predictive incident confidence.`,
            type: "warning",
            icon: "warning",
          })),
          { at: startMs - 120000, event: "Proactive incident stub created", detail: `${incidentId} was generated to guide early mitigation before SLA breach.`, type: "incident", icon: "incident" },
          { at: now + 1800000, event: "Predicted breach window", detail: "Without remediation, SLA breach probability increases in the next 30-60 minutes.", type: "warning", icon: "warning" },
        ].sort((a, b) => a.at - b.at).slice(0, 14);

        const txDerived = txRows
          .map((t, i) => {
            const resp = Number(t.avgResponseTime ?? 0);
            const cpm = Number(t.callsPerMinute ?? 0);
            const err = Number(t.errorRate ?? 0);
            return {
              id: String(t.externalId ?? t.id ?? `tx-${i + 1}`),
              name: String(t.name ?? `Transaction ${i + 1}`),
              throughputDrop: Math.max(3, Math.min(90, Math.round((err * 8) + (resp / 180) + 8))),
              errorSpike: Math.max(0.2, Number((err > 0 ? err : 0.2).toFixed(2))),
              slaBreach: resp >= 2000 || err >= 3,
              avgResponseTime: Math.max(50, Math.round(resp || 600)),
              _cpm: cpm,
            };
          })
          .sort((a, b) => (b.errorSpike * 20 + b.avgResponseTime / 70 + b._cpm / 40) - (a.errorSpike * 20 + a.avgResponseTime / 70 + a._cpm / 40))
          .slice(0, 8);
        const affectedTransactions = txDerived.map(({ _cpm, ...rest }) => rest);
        const traces = txDerived.slice(0, 10).map((tx, i) => ({
          traceId: `TR-${incidentId}-${i + 1}`,
          name: tx.name,
          txId: tx.id,
          duration: Math.max(120, Math.round(tx.avgResponseTime * (1.4 + (i % 3) * 0.25))),
          spanCount: Math.max(3, Math.round((tx._cpm || 10) / 2) + 4),
          slowestSpan: i % 2 === 0 ? "DB query execution" : "Downstream API call",
        }));
        return res.json({
          incidentId,
          applicationId: app?.id ?? null,
          title: `Predicted SLA breach risk for ${app?.name ?? `application ${appLookupId}`}`,
          status: "Open",
          severity: sev,
          startTime: startMs,
          endTime: null,
          duration: `${Math.floor(durationMins / 60)}h ${durationMins % 60}m`,
          confidenceScore: confidence,
          businessImpactScore: Math.min(96, Math.round(riskScore * 0.92)),
          estimatedRevenueLoss: sev === "Critical" ? 18000 : 6500,
          affectedUsers: sev === "Critical" ? 4200 : 1300,
          affectedApplications: app ? [{
            id: app.id,
            name: app.name,
            status: sev,
            errorRateSpike: Math.max(1.2, Number(app.errorRate ?? 0)),
          }] : [],
          affectedServices: [
            {
              name: app?.tier ?? "Application tier",
              tier: app?.tier ?? "Application",
              severity: sev,
              errors: ["Forecasted latency and error-rate drift"],
              errorRateDelta: Math.max(8, Math.floor(riskScore / 3)),
            },
          ],
          affectedServers: servers.map((s) => ({
            id: s.id,
            externalId: s.externalId,
            name: s.name,
            severity: s.status === "Healthy" ? "Warning" : "Critical",
            status: s.status,
          })),
          rootCause: {
            hypothesis: "Predictive model indicates rising latency/error trend with elevated SLA breach probability in the next window.",
            confidence,
            causalChains: [
              { step: 1, label: "Forecast Trigger", value: "Risk threshold exceeded", delta: `Score ${riskScore}`, type: "forecast" },
              { step: 2, label: "Signal Correlation", value: `${alertPressure} alerts + ${errorPressure} recent errors`, delta: "Escalating", type: "service" },
              { step: 3, label: "Expected Impact", value: sev === "Critical" ? "High user impact" : "Moderate user impact", delta: "Proactive mitigation advised", type: "app" },
            ],
          },
          metrics: {
            cpu: Array.from({ length: 30 }).map((_, i) => ({ timestamp: startMs - (29 - i) * 300000, value: 30 + i * 1.1 + Math.random() * 10, anomaly: i >= 20 })),
            memory: Array.from({ length: 30 }).map((_, i) => ({ timestamp: startMs - (29 - i) * 300000, value: 50 + i * 0.8 + Math.random() * 8, anomaly: i >= 22 })),
            errorRate: Array.from({ length: 30 }).map((_, i) => ({ timestamp: startMs - (29 - i) * 300000, value: i < 18 ? 0.4 + Math.random() * 0.5 : 1.8 + Math.random() * 2.6, anomaly: i >= 18 })),
            responseTime: Array.from({ length: 30 }).map((_, i) => ({ timestamp: startMs - (29 - i) * 300000, value: i < 18 ? 300 + Math.random() * 120 : 900 + Math.random() * 1200, anomaly: i >= 18 })),
            throughput: Array.from({ length: 30 }).map((_, i) => ({ timestamp: startMs - (29 - i) * 300000, value: i < 20 ? 950 + Math.random() * 260 : 620 + Math.random() * 220, anomaly: i >= 20 })),
          },
          affectedTransactions,
          traces,
          timeline,
          notes,
          autoRemediation: {
            available: true,
            status: "Ready",
            script: "preemptive-scale-and-throttle.yml",
            type: "Ansible + Terraform",
            preview: `kubectl scale deploy/${(app?.name ?? "service").toLowerCase().replace(/\s+/g, "-")}-deployment --replicas=6\nterraform apply -var 'service_replicas=6'`,
            estimatedImpactReduction: Math.min(85, Math.max(40, Math.round(riskScore * 0.75))),
            history: [],
          },
          relatedAlerts: alerts.map((a) => ({
            alertId: `ALT-${a.id}`,
            severity: a.severity,
            status: a.status,
            rule: a.name,
            timestamp: a.triggeredAt?.getTime() ?? now,
          })),
          aiInsight: {
            summary: "Forecast suggests this service is on a degradation path. Early remediation can prevent customer-visible impact.",
            confidence,
            recommendations: [
              "Scale affected service tier preemptively",
              "Verify DB and downstream dependency saturation",
              "Tighten canary rollback thresholds for current release",
              "Reduce noisy traffic with temporary rate limiting",
            ],
          },
          aiCorrelation: {
            summary: `Predicted incident ${incidentId} is correlated with active alerts and rising error/latency signals on ${app?.name ?? `application ${appLookupId}`}.`,
            confidence: confidence / 100,
            strength: confidence,
            evidence: [
              { type: "Forecast", detail: `Risk score ${riskScore}`, score: 0.92 },
              { type: "Alerts", detail: `${alertPressure} related alert(s)`, score: 0.86 },
              { type: "Incidents", detail: `${openIncidents.length} active incident(s) for same application`, score: 0.78 },
            ],
            suggestions: [
              { label: "View Related Alerts", href: app?.id ? `/alerts?incidentId=${encodeURIComponent(incidentId)}&appId=${encodeURIComponent(String(app.id))}` : `/alerts?incidentId=${encodeURIComponent(incidentId)}` },
              ...(app ? [{ label: `Open ${app.name}`, href: `/applications/${app.id}` }] : []),
            ],
          },
        });
      }
    } catch (err: any) { console.error("Incident detail DB lookup error:", err); }
    return res.status(404).json({ message: "Incident not found" });
  });

  app.post("/api/incidents/:incidentId/notes", async (req, res) => {
    try {
      const incidentId = String(req.params.incidentId ?? "").trim();
      const content = String(req.body?.content ?? "").trim();
      if (!incidentId) return res.status(400).json({ error: "incidentId is required" });
      if (!content) return res.status(400).json({ error: "content is required" });

      const user = req.user as import("@shared/schema").User | undefined;
      const orgData = user ? await getUserOrg(user.id) : null;
      const orgId = orgData?.org?.id ?? null;
      const tagMatches = content.match(/#[a-zA-Z0-9_-]+/g) ?? [];
      const inferredTags = Array.from(new Set(tagMatches.map((t) => t.replace(/^#/, "")))).slice(0, 8);
      const suppliedTags = Array.isArray(req.body?.tags)
        ? (req.body.tags as any[]).map((t) => String(t ?? "").trim()).filter(Boolean).slice(0, 8)
        : [];
      const tags = Array.from(new Set([...suppliedTags, ...inferredTags]));

      const author = String(user?.name ?? "Operator");
      const avatar = String((user?.avatarInitials ?? author.split(" ").map((p) => p[0]).join("").toUpperCase().slice(0, 2)) || "OP");
      const role = String(orgData?.membership?.role ?? "Operator");

      const [created] = await db.insert(incidentNotes).values({
        incidentId,
        organizationId: orgId,
        userId: user?.id ?? null,
        author,
        role,
        avatar,
        content,
        tags,
      }).returning();

      return res.status(201).json({
        id: String(created.id),
        author: created.author,
        role: created.role,
        avatar: created.avatar,
        timestamp: created.createdAt?.getTime?.() ?? Date.now(),
        content: created.content,
        tags: Array.isArray(created.tags) ? created.tags : [],
      });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message ?? "Failed to add note" });
    }
  });

  // === Rich App Data ===
  app.get("/api/applications/:id/rich", async (req, res) => {
    const dbApp = await resolveDbApp(req.params.id);
    if (!dbApp) return res.json(await storage.getApplicationRichData(Number(req.params.id)));
    const [incRows, alertRows, errRows, srvRows] = await Promise.all([
      db.select().from(dbIncidents).where(eq(dbIncidents.applicationId, dbApp.externalId)).limit(100),
      db.select().from(dbAlerts).where(eq(dbAlerts.applicationId, dbApp.externalId)).limit(100),
      db.select().from(dbErrors).where(eq(dbErrors.applicationId, dbApp.externalId)).limit(200),
      db.select().from(dbServers).where(eq(dbServers.applicationId, dbApp.externalId)).limit(100),
    ]);
    const criticalInc = incRows.filter((i) => i.severity === "Critical").length;
    const activeAlerts = alertRows.filter((a) => (a.status ?? "").toLowerCase() !== "resolved").length;
    const totalErrors = errRows.reduce((sum, e) => sum + Number(e.frequency ?? 0), 0);
    const unhealthyServers = srvRows.filter((s) => (s.status ?? "").toLowerCase() !== "healthy").length;
    const appResp = Number(dbApp.avgResponseTime ?? 0);
    const appErr = Number(dbApp.errorRate ?? 0);
    const appViol = Number(dbApp.healthRuleViolations ?? 0);
    const penalty = (criticalInc * 12) + (activeAlerts * 3) + Math.min(25, Math.floor(totalErrors / 20)) + (unhealthyServers * 4)
      + Math.min(20, Math.floor(appResp / 400)) + Math.min(18, Math.floor(appErr * 3)) + Math.min(15, appViol);
    const slaScore = Math.max(35, Math.min(99, 96 - penalty));
    const forecastScore = Math.min(95, 30 + (criticalInc * 18) + (activeAlerts * 4) + Math.min(20, Math.floor(totalErrors / 25)));
    const riskLevel = forecastScore >= 80 ? "High" : forecastScore >= 55 ? "Medium" : "Low";
    const hoursToSLABreach = riskLevel === "High" ? 6 : riskLevel === "Medium" ? 18 : null;
    return res.json({
      environment: dbApp.source ?? "production",
      responseTime: appResp || null,
      errorRate: appErr || null,
      throughput: Number(dbApp.callsPerMinute ?? 0) || null,
      slaScore,
      forecastRisk: {
        score: forecastScore,
        confidence: Math.min(92, 55 + criticalInc * 8 + Math.min(20, activeAlerts)),
        hoursToSLABreach,
        level: riskLevel,
      },
    });
  });
  app.get("/api/applications/:id/service-risks", async (req, res) => {
    const dbApp = await resolveDbApp(req.params.id);
    if (!dbApp) return res.json(await storage.getServiceRiskRankings(Number(req.params.id)));
    const tx = await db.select().from(dbTransactions).where(eq(dbTransactions.applicationId, dbApp.externalId)).limit(30);
    const risks = tx.map((t, idx) => {
      const errorRate = Number(t.errorRate ?? 0);
      const response = Number(t.avgResponseTime ?? 0);
      const calls = Number(t.callsPerMinute ?? 0);
      const riskScore = Math.min(100, Math.round((errorRate * 14) + (response / 80) + (calls > 0 ? 10 : 0)));
      const trend = riskScore >= 70 ? "worsening" : riskScore >= 40 ? "stable" : "improving";
      const failureProbability = Math.min(98, Math.max(5, Math.round(riskScore * 0.9)));
      return {
        id: `${t.id}-${idx}`,
        service: t.name,
        tier: t.tier ?? "Application",
        riskScore,
        trend,
        confidence: Math.max(55, Math.min(92, 65 + Math.round(errorRate * 4))),
        failureProbability,
        hypothesis: `${t.name} shows elevated risk from ${errorRate.toFixed(2)}% errors and ${Math.round(response)}ms response time.`,
        recommendations: [
          "Prioritize error spikes and rollback recent risky deployments",
          "Validate downstream dependencies and retry/backoff behavior",
          "Scale constrained tiers and tighten alert thresholds",
        ],
        expectedFailureDate: riskScore >= 75 ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : null,
      };
    }).sort((a, b) => b.riskScore - a.riskScore);
    res.json(risks);
  });
  app.get("/api/applications/:id/http-errors", async (req, res) => {
    const dbApp = await resolveDbApp(req.params.id);
    if (!dbApp) return res.json(await storage.getHttpErrorCategories(Number(req.params.id)));
    const errors = await db.select().from(dbErrors).where(eq(dbErrors.applicationId, dbApp.externalId)).limit(200);
    const buckets = new Map<string, number>();
    for (const e of errors) {
      const label = e.errorType ?? "Unknown";
      buckets.set(label, (buckets.get(label) ?? 0) + Number(e.frequency ?? 1));
    }
    const total = Math.max(1, Array.from(buckets.values()).reduce((s, v) => s + v, 0));
    const out = Array.from(buckets.entries())
      .map(([code, count]) => ({
        code,
        count,
        percentage: Math.min(100, Math.round((count / total) * 100)),
        trend: 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
    res.json(out);
  });
  app.get("/api/applications/:id/dependency-errors", async (req, res) => {
    const dbApp = await resolveDbApp(req.params.id);
    if (!dbApp) return res.json(await storage.getDependencyErrors(Number(req.params.id)));
    const errors = await db.select().from(dbErrors).where(eq(dbErrors.applicationId, dbApp.externalId)).limit(200);
    const buckets = new Map<string, number>();
    for (const e of errors) {
      const dep = e.service ?? "Unknown dependency";
      buckets.set(dep, (buckets.get(dep) ?? 0) + Number(e.frequency ?? 1));
    }
    const out = Array.from(buckets.entries())
      .map(([name, count]) => ({
        name,
        type: name.toLowerCase().includes("db") ? "Database" : "Service",
        status: count > 20 ? "Degraded" : "Healthy",
        errorRate: Number((count / Math.max(1, errors.length)).toFixed(2)),
        latency: count > 20 ? 1200 : 350,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
    res.json(out);
  });
  // === Servers ===
  app.get("/api/applications/:id/servers", async (req, res) => {
    const dbApp = await resolveDbApp(req.params.id);
    if (dbApp?.externalId) {
      const servers = await db.select().from(dbServers).where(eq(dbServers.applicationId, dbApp.externalId)).limit(50);
      const liveAppdMetrics = dbApp.source === "appdynamics"
        ? await getLiveAppdNodeMetrics(dbApp.externalId, dbApp.credentialId)
        : null;
      if (servers.length > 0) return res.json(servers.map(s => {
        const resolved = resolveServerUtilization(s, liveAppdMetrics);
        return {
          id: s.id, name: s.name, role: s.role ?? s.tier ?? "Server", tier: s.tier ?? "", ipAddress: s.ip ?? "", ip: s.ip ?? "",
          cpuUsage: resolved.cpu, memUsage: resolved.memory, memoryUsage: resolved.memory, diskUsage: resolved.disk,
          networkMbps: resolved.network, alerts: s.alerts ?? 0,
          status: s.status ?? "Healthy", source: s.source, lastSyncAt: s.lastSyncAt,
        };
      }));
    }
    return res.json([]);
  });
  app.get("/api/applications/:id/servers/:serverId", async (req, res) => {
    const [row] = await db.select().from(dbServers).where(eq(dbServers.id, Number(req.params.serverId)));
    if (!row) return res.status(404).json({ message: "Server not found" });
    const dbApp = await resolveDbApp(req.params.id);
    const liveAppdMetrics = dbApp?.source === "appdynamics" && dbApp.externalId
      ? await getLiveAppdNodeMetrics(dbApp.externalId, dbApp.credentialId)
      : null;
    const toPercentOrNull = (value: unknown): number | null => {
      const n = Number(value ?? NaN);
      if (!Number.isFinite(n)) return null;
      return normalizePercent(n, 0);
    };
    const nodeKeys = [
      canonicalNodeKey(row.name),
      canonicalNodeKey((row.metadata as any)?.machineName),
      canonicalNodeKey(row.ip),
    ].filter(Boolean);
    const pickLive = (m: Map<string, number> | undefined) => {
      if (!m) return null;
      for (const key of nodeKeys) {
        const v = m.get(key);
        if (v != null) return v;
      }
      return null;
    };
    const meta = row.metadata as any;
    const cpuMeta = extractMetricFromMetadata(meta, [/cpu/, /processor/, /usagepercent/]);
    const memMeta = extractMetricFromMetadata(meta, [/mem/, /memory/, /ram/]);
    const diskMeta = extractMetricFromMetadata(meta, [/disk/, /storage/, /filesystem/]);
    const netMeta = extractMetricFromMetadata(meta, [/network/, /throughput/, /mbps/, /bandwidth/]);
    let processes = extractProcessesFromMetadata(meta);
    const durationMins = Number(req.query.durationMins ?? 24 * 60);
    const startQ = req.query.start ? Date.parse(String(req.query.start)) : NaN;
    const endQ = req.query.end ? Date.parse(String(req.query.end)) : NaN;
    const endTs = Number.isFinite(endQ) ? endQ : Date.now();
    const startTs = Number.isFinite(startQ) ? startQ : (endTs - (Number.isFinite(durationMins) ? durationMins : 24 * 60) * 60_000);
    const currentCpu = toPercentOrNull(row.cpuUsage ?? cpuMeta ?? pickLive(liveAppdMetrics?.cpuByNode));
    const currentMem = toPercentOrNull(row.memoryUsage ?? memMeta ?? pickLive(liveAppdMetrics?.memByNode));
    const currentDisk = toPercentOrNull(row.diskUsage ?? diskMeta ?? pickLive(liveAppdMetrics?.diskByNode));
    const currentNet = netMeta != null && Number.isFinite(netMeta) ? Math.max(0, netMeta) : Number(row.networkMbps ?? 0);

    let resourceHistory: Array<{ timestamp: number; cpu: number; memory: number; disk: number; network: number }> = [];
    let forecast: Array<{ timestamp: number; cpuPredicted: number; memPredicted: number }> = [];
    if (dbApp?.source === "appdynamics" && dbApp.externalId) {
      const live = await getLiveAppdClient(dbApp.externalId, dbApp.credentialId);
      if (live) {
        const pickMetricLabel = (metricPath?: string | null) => {
          const parts = String(metricPath ?? "").split("|").map((p) => p.trim()).filter(Boolean);
          return String(parts[parts.length - 1] ?? "").toLowerCase();
        };
        const nodeMatchKeys = nodeKeys;
        const rowMatchesNode = (metricPath?: string | null) => {
          const parsed = parseNodeNameFromMetricPath(metricPath);
          const parsedKey = canonicalNodeKey(parsed);
          return parsedKey.length > 0 && nodeMatchKeys.includes(parsedKey);
        };
        const toPointMap = (rows: Array<{ metricPath?: string | null; metricValues?: { startTimeInMillis: number; value: number; count: number }[] }>, accepts: (label: string, path?: string | null) => boolean) => {
          const out = new Map<number, number[]>();
          for (const r of rows ?? []) {
            if (!rowMatchesNode(r.metricPath)) continue;
            const label = pickMetricLabel(r.metricPath);
            if (!accepts(label, r.metricPath)) continue;
            for (const p of r.metricValues ?? []) {
              const ts = Number(p?.startTimeInMillis ?? NaN);
              const val = Number(p?.value ?? NaN);
              if (!Number.isFinite(ts) || !Number.isFinite(val)) continue;
              if (ts < startTs || ts > endTs) continue;
              const list = out.get(ts) ?? [];
              list.push(val);
              out.set(ts, list);
            }
          }
          return new Map(Array.from(out.entries()).map(([ts, vals]) => [ts, vals.reduce((s, v) => s + v, 0) / Math.max(1, vals.length)]));
        };

        const [cpuRows, memRows, diskRows] = await Promise.all([
          live.client.getMetrics(live.appNum, "Application Infrastructure Performance|*|Individual Nodes|*|Hardware Resources|CPU|*", Math.max(5, Math.round((endTs - startTs) / 60_000))).catch(() => []),
          live.client.getMetrics(live.appNum, "Application Infrastructure Performance|*|Individual Nodes|*|Hardware Resources|Memory|*", Math.max(5, Math.round((endTs - startTs) / 60_000))).catch(() => []),
          live.client.getMetrics(live.appNum, "Application Infrastructure Performance|*|Individual Nodes|*|Hardware Resources|Disks|*", Math.max(5, Math.round((endTs - startTs) / 60_000))).catch(() => []),
        ]);

        const cpuBusy = toPointMap(cpuRows as any[], (label) => label === "%busy");
        const cpuUser = toPointMap(cpuRows as any[], (label) => label === "user");
        const cpuSys = toPointMap(cpuRows as any[], (label) => label === "system");
        const cpuMap = new Map<number, number>();
        const cpuTs = new Set<number>([...cpuBusy.keys(), ...cpuUser.keys(), ...cpuSys.keys()]);
        for (const ts of cpuTs) {
          if (cpuBusy.has(ts)) cpuMap.set(ts, Number(cpuBusy.get(ts)));
          else if (cpuUser.has(ts) || cpuSys.has(ts)) cpuMap.set(ts, Number(cpuUser.get(ts) ?? 0) + Number(cpuSys.get(ts) ?? 0));
        }

        const memUsed = toPointMap(memRows as any[], (label) => label === "used %");
        const memTotal = toPointMap(memRows as any[], (label) => label === "total (mb)");
        const memFree = toPointMap(memRows as any[], (label) => label === "free (mb)");
        const memAvail = toPointMap(memRows as any[], (label) => label === "available (mb)");
        const memMap = new Map<number, number>();
        const memTs = new Set<number>([...memUsed.keys(), ...memTotal.keys(), ...memFree.keys(), ...memAvail.keys()]);
        for (const ts of memTs) {
          if (memUsed.has(ts)) memMap.set(ts, Number(memUsed.get(ts)));
          else {
            const total = Number(memTotal.get(ts) ?? NaN);
            const free = Number(memFree.get(ts) ?? NaN);
            const avail = Number(memAvail.get(ts) ?? NaN);
            if (Number.isFinite(total) && total > 0 && Number.isFinite(free)) memMap.set(ts, ((total - free) / total) * 100);
            else if (Number.isFinite(total) && total > 0 && Number.isFinite(avail)) memMap.set(ts, ((total - avail) / total) * 100);
          }
        }

        const diskMap = toPointMap(diskRows as any[], (label, path) => {
          const mp = String(path ?? "").toLowerCase();
          return mp.includes("used") && label.includes("%");
        });

        const allTimestamps = Array.from(new Set<number>([...cpuMap.keys(), ...memMap.keys(), ...diskMap.keys()]))
          .sort((a, b) => a - b);
        const rangeMinutes = Math.max(1, Math.round((endTs - startTs) / 60_000));
        const maxPoints = rangeMinutes <= 60
          ? 60
          : rangeMinutes <= 24 * 60
            ? 96
            : rangeMinutes <= 7 * 24 * 60
              ? 120
              : 140;
        const timestamps = allTimestamps.length <= maxPoints
          ? allTimestamps
          : (() => {
              const picked = new Set<number>();
              const stepIdx = (allTimestamps.length - 1) / Math.max(1, maxPoints - 1);
              for (let i = 0; i < maxPoints; i++) {
                const idx = Math.min(allTimestamps.length - 1, Math.max(0, Math.round(i * stepIdx)));
                picked.add(allTimestamps[idx]);
              }
              return Array.from(picked).sort((a, b) => a - b);
            })();

        if (timestamps.length > 0) {
          let lastCpu = Number.isFinite(Number(currentCpu)) ? Number(currentCpu) : 0;
          let lastMem = Number.isFinite(Number(currentMem)) ? Number(currentMem) : 0;
          let lastDisk = Number.isFinite(Number(currentDisk)) ? Number(currentDisk) : 0;
          for (const ts of timestamps) {
            if (cpuMap.has(ts)) lastCpu = normalizePercent(Number(cpuMap.get(ts)), lastCpu);
            if (memMap.has(ts)) lastMem = normalizePercent(Number(memMap.get(ts)), lastMem);
            if (diskMap.has(ts)) lastDisk = normalizePercent(Number(diskMap.get(ts)), lastDisk);
            resourceHistory.push({
              timestamp: ts,
              cpu: lastCpu,
              memory: lastMem,
              disk: lastDisk,
              network: Number.isFinite(currentNet) ? currentNet : 0,
            });
          }
          const slope = (vals: number[]) => {
            if (vals.length < 2) return 0;
            const last = vals[vals.length - 1];
            const prev = vals[Math.max(0, vals.length - 6)];
            return (last - prev) / Math.max(1, vals.length - Math.max(0, vals.length - 6));
          };
          const cpuVals = resourceHistory.map((p) => Number(p.cpu ?? 0));
          const memVals = resourceHistory.map((p) => Number(p.memory ?? 0));
          let cpuNext = cpuVals[cpuVals.length - 1] ?? 0;
          let memNext = memVals[memVals.length - 1] ?? 0;
          const cpuSlope = slope(cpuVals);
          const memSlope = slope(memVals);
          const lastTs = resourceHistory[resourceHistory.length - 1]?.timestamp ?? Date.now();
          for (let i = 1; i <= 8; i++) {
            cpuNext = Math.max(0, Math.min(100, cpuNext + cpuSlope));
            memNext = Math.max(0, Math.min(100, memNext + memSlope));
            forecast.push({
              timestamp: lastTs + i * 15 * 60 * 1000,
              cpuPredicted: Number(cpuNext.toFixed(2)),
              memPredicted: Number(memNext.toFixed(2)),
            });
          }
        }
      }
    }
    if (resourceHistory.length === 0) {
      // Keep charts populated even when provider did not return node-series points
      // for the selected range.
      const span = Math.max(5 * 60_000, endTs - startTs);
      const points = Math.max(12, Math.min(48, Math.round(span / 3_600_000)));
      const step = Math.max(5 * 60_000, Math.floor(span / Math.max(1, points - 1)));
      for (let i = 0; i < points; i++) {
        const ts = startTs + i * step;
        resourceHistory.push({
          timestamp: ts,
          cpu: Number.isFinite(Number(currentCpu)) ? Number(currentCpu) : 0,
          memory: Number.isFinite(Number(currentMem)) ? Number(currentMem) : 0,
          disk: Number.isFinite(Number(currentDisk)) ? Number(currentDisk) : 0,
          network: Number.isFinite(Number(currentNet)) ? Number(currentNet) : 0,
        });
      }
    }
    if (processes.length === 0) {
      // Fallback process list derived from live transaction/error activity for this node's app.
      const txRows = await db.select().from(dbTransactions)
        .where(eq(dbTransactions.applicationId, row.applicationId ?? ""))
        .orderBy(desc(dbTransactions.updatedAt))
        .limit(20);
      const errRows = await db.select().from(dbErrors)
        .where(eq(dbErrors.applicationId, row.applicationId ?? ""))
        .orderBy(desc(dbErrors.lastOccurrence))
        .limit(80);
      const errByService = new Map<string, number>();
      for (const e of errRows) {
        const svc = String(e.service ?? e.applicationName ?? "").trim();
        if (!svc) continue;
        errByService.set(svc, (errByService.get(svc) ?? 0) + Number(e.frequency ?? 1));
      }
      processes = txRows
        .map((t) => {
          const serviceName = String(t.name ?? "worker").trim();
          const cpm = Math.max(0, Number(t.callsPerMinute ?? 0));
          const avgResp = Math.max(0, Number(t.avgResponseTime ?? 0));
          const errRate = Math.max(0, Number(t.errorRate ?? 0));
          const errFreq = Number(errByService.get(serviceName) ?? 0);
          const cpu = Math.max(1, Math.min(100, Number((cpm / 2 + errRate * 5).toFixed(1))));
          const memory = Math.max(64, Math.round(avgResp * 0.8 + cpu * 6));
          return {
            name: serviceName,
            pid: Number(t.id),
            cpu,
            memory,
            status: "Running",
            anomaly: cpu >= 70 || memory >= 1500 || errFreq > 20 || errRate > 3,
          };
        })
        .sort((a, b) => (b.cpu + b.memory / 100) - (a.cpu + a.memory / 100))
        .slice(0, 25);
    }

    const appIncidents = await db.select().from(dbIncidents)
      .where(eq(dbIncidents.applicationId, row.applicationId ?? ""))
      .orderBy(desc(dbIncidents.startTime))
      .limit(20);
    const appAlerts = await db.select().from(dbAlerts)
      .where(eq(dbAlerts.applicationId, row.applicationId ?? ""))
      .orderBy(desc(dbAlerts.triggeredAt))
      .limit(30);
    const appErrors = await db.select().from(dbErrors)
      .where(eq(dbErrors.applicationId, row.applicationId ?? ""))
      .orderBy(desc(dbErrors.lastOccurrence))
      .limit(120);
    const nodeKeysForProblems = [
      canonicalNodeKey(row.name),
      canonicalNodeKey(row.ip),
      canonicalNodeKey((row.metadata as any)?.machineName),
    ].filter(Boolean);
    const nodeErrorRows = appErrors.filter((e) => {
      const m = (e?.metadata as any) ?? {};
      const cands = [
        m?.nodeName,
        m?.applicationComponentNodeName,
        m?.triggeredEntity?.name,
        m?.machineName,
      ].map((v: any) => canonicalNodeKey(v)).filter(Boolean);
      return cands.some((c: string) => nodeKeysForProblems.includes(c));
    });
    const activeInc = appIncidents.filter((i) => String(i.status ?? "").toLowerCase() === "open");
    const activeAl = appAlerts.filter((a) => String(a.status ?? "").toLowerCase() !== "resolved");
    const nodeErrCount = nodeErrorRows.reduce((s, e) => s + Number(e.frequency ?? 1), 0);
    const cpuNow = Number(currentCpu ?? 0);
    const memNow = Number(currentMem ?? 0);
    const diskNow = Number(currentDisk ?? 0);
    const forecastCpuPeak = forecast.length > 0 ? Math.max(...forecast.map((f) => Number(f.cpuPredicted ?? 0))) : cpuNow;
    const forecastMemPeak = forecast.length > 0 ? Math.max(...forecast.map((f) => Number(f.memPredicted ?? 0))) : memNow;
    const problems: any[] = [];
    if (cpuNow >= 85) {
      problems.push({
        id: `CPU-HOT-${row.id}`,
        title: `High CPU utilization on ${row.name}`,
        severity: cpuNow >= 92 ? "Critical" : "High",
        type: "CPU",
        since: Date.now() - 30 * 60 * 1000,
        duration: "30m",
        confidence: Math.min(99, Math.round(60 + cpuNow * 0.4)),
      });
    }
    if (memNow >= 85) {
      problems.push({
        id: `MEM-HOT-${row.id}`,
        title: `High memory usage on ${row.name}`,
        severity: memNow >= 92 ? "Critical" : "High",
        type: "Memory",
        since: Date.now() - 45 * 60 * 1000,
        duration: "45m",
        confidence: Math.min(99, Math.round(58 + memNow * 0.42)),
      });
    }
    if (diskNow >= 80) {
      problems.push({
        id: `DISK-HOT-${row.id}`,
        title: `Disk utilization elevated on ${row.name}`,
        severity: diskNow >= 90 ? "Critical" : "High",
        type: "Disk",
        since: Date.now() - 60 * 60 * 1000,
        duration: "1h",
        confidence: Math.min(98, Math.round(54 + diskNow * 0.4)),
      });
    }
    if (nodeErrCount > 0) {
      problems.push({
        id: `ERR-NODE-${row.id}`,
        title: `Error bursts detected on this node`,
        severity: nodeErrCount >= 40 ? "Critical" : nodeErrCount >= 15 ? "High" : "Medium",
        type: "Errors",
        since: nodeErrorRows[0]?.firstSeen?.getTime?.() ?? Date.now() - 2 * 60 * 60 * 1000,
        duration: "2h",
        confidence: Math.min(96, Math.round(52 + Math.min(40, nodeErrCount))),
      });
    }
    if (activeInc.length > 0 || activeAl.length > 0) {
      problems.push({
        id: `CORR-NODE-${row.id}`,
        title: `Correlated operational pressure (incidents/alerts)`,
        severity: activeInc.length > 0 ? "High" : "Medium",
        type: "Correlation",
        since: activeInc[0]?.startTime?.getTime?.() ?? activeAl[0]?.triggeredAt?.getTime?.() ?? Date.now() - 60 * 60 * 1000,
        duration: "1h",
        confidence: 76,
      });
    }
    if (forecastCpuPeak >= 90 || forecastMemPeak >= 90) {
      problems.push({
        id: `FCST-NODE-${row.id}`,
        title: `Forecasted saturation risk`,
        severity: (forecastCpuPeak >= 95 || forecastMemPeak >= 95) ? "Critical" : "High",
        type: "Forecast",
        expectedAt: Date.now() + 2 * 60 * 60 * 1000,
        confidence: Math.min(98, Math.round(65 + Math.max(forecastCpuPeak, forecastMemPeak) * 0.25)),
      });
    }
    return res.json({
      ...row,
      cpuUsage: currentCpu,
      memoryUsage: currentMem,
      diskUsage: currentDisk,
      networkMbps: currentNet,
      resourceHistory,
      forecast,
      processes,
      problems: problems.slice(0, 8),
    });
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

  // Test a saved credential by ID (reads real password from DB)
  app.post("/api/apm/credentials/:id/test", requireAuth, async (req, res) => {
    const credId = parseInt(req.params.id);
    if (isNaN(credId)) return res.status(400).json({ ok: false, message: "Invalid credential ID" });
    try {
      const [cred] = await db.select().from(apmCredentials).where(eq(apmCredentials.id, credId));
      if (!cred) return res.status(404).json({ ok: false, message: "Credential not found" });
      if (cred.source === "appdynamics") {
        const { AppDynamicsClient } = await import("./services/appDynamics");
        const decryptedPassword = (() => {
          try { return decryptSecret(cred.passwordHash) ?? cred.passwordHash ?? ""; }
          catch {
            if (String(cred.passwordHash ?? "").startsWith("enc:")) {
              throw new Error("Unable to decrypt AppDynamics password. Verify CREDENTIALS_ENCRYPTION_KEY.");
            }
            return cred.passwordHash ?? "";
          }
        })();
        const client = new AppDynamicsClient({
          controllerUrl: cred.controllerUrl,
          account: cred.account ?? "",
          username: cred.username ?? "",
          password: decryptedPassword,
        });
        res.json(await client.testConnection());
      } else {
        const { DynatraceClient } = await import("./services/dynatrace");
        const decryptedToken = (() => {
          try { return decryptSecret(cred.apiToken) ?? cred.apiToken ?? ""; }
          catch {
            if (String(cred.apiToken ?? "").startsWith("enc:")) {
              throw new Error("Unable to decrypt Dynatrace token. Verify CREDENTIALS_ENCRYPTION_KEY.");
            }
            return cred.apiToken ?? "";
          }
        })();
        const client = new DynatraceClient({
          environmentUrl: cred.controllerUrl,
          apiToken: decryptedToken,
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
  app.get("/api/apm/credentials", async (_req, res) => {
    try {
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
      }).from(apmCredentials);
      res.json(creds);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Add new credential
  app.post("/api/apm/credentials", requireAuth, async (req, res) => {
    const { source, label, controllerUrl, account, username, password, apiToken, clientId, clientSecret } = req.body;
    if (!source || !controllerUrl) return res.status(400).json({ error: "source and controllerUrl required" });
    try {
      const user = req.user as import("@shared/schema").User;
      const orgData = await getUserOrg(user.id);
      const organizationId = orgData?.org.id ?? null;
      const [cred] = await db.insert(apmCredentials).values({
        source, label: label ?? "Default",
        controllerUrl, account, username,
        passwordHash: safeEncrypt(password) as any,
        apiToken: safeEncrypt(apiToken) as any,
        clientId: safeEncrypt(clientId) as any,
        clientSecret: safeEncrypt(clientSecret) as any,
        organizationId,
      }).returning();
      res.status(201).json({ ...cred, passwordHash: undefined });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Delete credential
  app.delete("/api/apm/credentials/:id", async (req, res) => {
    try {
      await db.delete(apmCredentials).where(eq(apmCredentials.id, parseInt(req.params.id)));
      res.json({ success: true });
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
