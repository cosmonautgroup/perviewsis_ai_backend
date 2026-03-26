import { db } from "../server/db";
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
} from "../shared/schema";

async function run(): Promise<void> {
  // Delete child/derived tables first to avoid FK conflicts if added later.
  await db.delete(dbMetrics);
  await db.delete(dbErrors);
  await db.delete(dbTransactions);
  await db.delete(dbServers);
  await db.delete(dbAlerts);
  await db.delete(dbIncidents);
  await db.delete(dbCapacityRisks);
  await db.delete(dbApplications);
  await db.delete(dbSyncLogs);

  console.log("[clean-apm-data] Cleared APM synced data and sync logs.");
}

run().catch((err) => {
  console.error("[clean-apm-data] Failed:", err);
  process.exit(1);
});

