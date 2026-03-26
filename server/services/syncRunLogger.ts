/**
 * Sync Run Logger
 * Writes JSON audit files to disk for every sync that produces new or updated records.
 * Files are stored at: logs/sync-runs/{orgId}/{syncRunId}.json
 * Access is restricted to authenticated users of the owning organization.
 */

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ApiCallEntry {
  endpoint: string;
  requestParams: Record<string, any>;
  timestamp: string;
  totalFetched: number;
  newRecords: any[];
  updatedRecords: any[];
  rawResponse: any;
}

export interface SyncRunLog {
  syncRunId: string;
  orgId: number | null;
  credentialId: number | null;
  integration: string;
  startedAt: string;
  completedAt: string | null;
  totalNew: number;
  totalUpdated: number;
  entries: ApiCallEntry[];
}

export interface SyncRunSummary {
  syncRunId: string;
  orgId: number | null;
  integration: string;
  startedAt: string;
  completedAt: string | null;
  totalNew: number;
  totalUpdated: number;
  entryCount: number;
  fileSizeBytes: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const LOG_BASE = path.join(process.cwd(), "logs", "sync-runs");

// ─── SyncRunLogger class ──────────────────────────────────────────────────────

export class SyncRunLogger {
  private readonly syncRunId: string;
  private readonly orgId: number | null;
  private readonly credentialId: number | null;
  private readonly integration: string;
  private readonly startedAt: string;
  private readonly logDir: string;
  private entries: ApiCallEntry[] = [];

  constructor(opts: {
    orgId: number | null;
    credentialId: number | null;
    integration: string;
  }) {
    this.syncRunId = randomUUID();
    this.orgId = opts.orgId;
    this.credentialId = opts.credentialId;
    this.integration = opts.integration;
    this.startedAt = new Date().toISOString();
    this.logDir = path.join(LOG_BASE, String(opts.orgId ?? "unscoped"));
  }

  /**
   * Log an API call. Only stored if at least one new or updated record is present.
   */
  log(opts: {
    endpoint: string;
    requestParams: Record<string, any>;
    rawResponse: any;
    newRecords: any[];
    updatedRecords: any[];
  }): void {
    if (opts.newRecords.length === 0 && opts.updatedRecords.length === 0) return;
    this.entries.push({
      endpoint: opts.endpoint,
      requestParams: opts.requestParams,
      timestamp: new Date().toISOString(),
      totalFetched: Array.isArray(opts.rawResponse) ? opts.rawResponse.length : 1,
      newRecords: opts.newRecords,
      updatedRecords: opts.updatedRecords,
      rawResponse: opts.rawResponse,
    });
  }

  /**
   * Write the accumulated log entries to disk.
   * Returns null if there was nothing to log (no new/updated records detected).
   */
  flush(): SyncRunLog | null {
    if (this.entries.length === 0) return null;

    const totalNew = this.entries.reduce((s, e) => s + e.newRecords.length, 0);
    const totalUpdated = this.entries.reduce((s, e) => s + e.updatedRecords.length, 0);

    const log: SyncRunLog = {
      syncRunId: this.syncRunId,
      orgId: this.orgId,
      credentialId: this.credentialId,
      integration: this.integration,
      startedAt: this.startedAt,
      completedAt: new Date().toISOString(),
      totalNew,
      totalUpdated,
      entries: this.entries,
    };

    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      const filePath = path.join(this.logDir, `${this.syncRunId}.json`);
      // Mode 0o600 = owner read/write only — not world-readable
      fs.writeFileSync(filePath, JSON.stringify(log, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error("[SyncRunLogger] Failed to write log file:", err);
    }

    return log;
  }

  getSyncRunId(): string {
    return this.syncRunId;
  }
}

// ─── File helpers (used by API routes) ───────────────────────────────────────

/**
 * List all sync run log files for an organization, newest first.
 * Returns lightweight metadata by reading just the file stats + JSON header.
 */
export function listSyncRuns(orgId: number): SyncRunSummary[] {
  const orgDir = path.join(LOG_BASE, String(orgId));
  if (!fs.existsSync(orgDir)) return [];

  const files = fs.readdirSync(orgDir).filter(f => f.endsWith(".json"));

  const summaries: SyncRunSummary[] = [];
  for (const fname of files) {
    const filePath = path.join(orgDir, fname);
    try {
      const stat = fs.statSync(filePath);
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed: SyncRunLog = JSON.parse(raw);
      summaries.push({
        syncRunId: parsed.syncRunId,
        orgId: parsed.orgId,
        integration: parsed.integration,
        startedAt: parsed.startedAt,
        completedAt: parsed.completedAt,
        totalNew: parsed.totalNew,
        totalUpdated: parsed.totalUpdated,
        entryCount: parsed.entries?.length ?? 0,
        fileSizeBytes: stat.size,
      });
    } catch {
      // Corrupted or partially written file — skip
    }
  }

  return summaries.sort((a, b) =>
    new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  ).slice(0, 100);
}

/**
 * Returns the absolute file path for a sync run, or null if invalid / not found.
 * Validates the syncRunId to prevent path traversal attacks.
 */
export function getSyncRunFilePath(orgId: number, syncRunId: string): string | null {
  // Only allow valid UUID format
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(syncRunId)) {
    return null;
  }

  const orgDir = path.join(LOG_BASE, String(orgId));
  const filePath = path.resolve(path.join(orgDir, `${syncRunId}.json`));

  // Ensure the resolved path is still within the expected org directory
  if (!filePath.startsWith(path.resolve(orgDir))) return null;
  if (!fs.existsSync(filePath)) return null;

  return filePath;
}
