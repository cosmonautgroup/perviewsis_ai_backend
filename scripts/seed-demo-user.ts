import { db } from "../server/db";
import {
  organizations, users, organizationMembers,
  apmCredentials, dbApplications, dbIncidents,
  dbAlerts, dbServers, dbTransactions, dbErrors,
  dbCapacityRisks,
} from "../shared/schema";
import { hashPassword } from "../server/auth";
import { eq, and } from "drizzle-orm";

const DEMO_EMAIL = "demo@Observaiq.com";
const DEMO_PASSWORD = "Demo@12345";
const DEMO_ORG_SLUG = "Observaiq-demo";
const SOURCE = "appdynamics";

const now = new Date();
const hrs = (h: number) => new Date(now.getTime() - h * 3600_000);
const days = (d: number) => new Date(now.getTime() - d * 86400_000);

async function main() {
  console.log("🌱  Seeding demo user and data…");

  // ── 1. Guard against re-running ──────────────────────────────────────────
  const [existingOrg] = await db.select().from(organizations).where(eq(organizations.slug, DEMO_ORG_SLUG));
  if (existingOrg) {
    console.log("⚠️   Demo org already exists. Skipping — delete it first to re-seed.");
    process.exit(0);
  }

  // ── 2. Create org ────────────────────────────────────────────────────────
  const [org] = await db.insert(organizations).values({
    name: "ObservaIQ Demo",
    slug: DEMO_ORG_SLUG,
    plan: "enterprise",
    maxUsers: 25,
  }).returning();
  console.log("  ✔ Org created:", org.id);

  // ── 3. Create user ───────────────────────────────────────────────────────
  const [existingUser] = await db.select().from(users).where(eq(users.email, DEMO_EMAIL));
  let demoUser = existingUser;
  if (!demoUser) {
    [demoUser] = await db.insert(users).values({
      email: DEMO_EMAIL,
      passwordHash: await hashPassword(DEMO_PASSWORD),
      name: "Demo User",
      avatarInitials: "DU",
      isEmailVerified: true,
    }).returning();
  }
  console.log("  ✔ User created:", demoUser.id, DEMO_EMAIL);

  // ── 4. Org membership ────────────────────────────────────────────────────
  await db.insert(organizationMembers).values({
    organizationId: org.id,
    userId: demoUser.id,
    role: "Admin",
    joinedAt: now,
  });
  console.log("  ✔ Membership created (Admin)");

  // ── 5. APM credential (fake controller — never synced) ───────────────────
  const [cred] = await db.insert(apmCredentials).values({
    organizationId: org.id,
    source: SOURCE,
    label: "Demo AppDynamics Controller",
    controllerUrl: "https://demo.saas.appdynamics.com",
    account: "demo-account",
    username: "demo-user",
    passwordHash: "demo-only-not-real",
    isActive: true,
  }).returning();
  const credId = cred.id;
  console.log("  ✔ APM credential created:", credId);

  // ── 6. Applications ──────────────────────────────────────────────────────
  const appDefs = [
    { externalId: "demo-app-1001", name: "EcommerceAPI",        status: "Critical",  healthScore: 42, cpm: 3420, rt: 890,  er: 4.2,  hrv: 8,  tier: "API Gateway" },
    { externalId: "demo-app-1002", name: "PaymentService",      status: "Warning",   healthScore: 65, cpm: 1280, rt: 420,  er: 1.8,  hrv: 3,  tier: "Payment" },
    { externalId: "demo-app-1003", name: "UserAuthService",     status: "Healthy",   healthScore: 91, cpm: 5600, rt: 78,   er: 0.3,  hrv: 0,  tier: "Auth" },
    { externalId: "demo-app-1004", name: "ProductCatalog",      status: "Warning",   healthScore: 72, cpm: 2100, rt: 340,  er: 2.1,  hrv: 2,  tier: "Catalog" },
    { externalId: "demo-app-1005", name: "OrderProcessor",      status: "Healthy",   healthScore: 88, cpm: 980,  rt: 210,  er: 0.9,  hrv: 1,  tier: "Orders" },
    { externalId: "demo-app-1006", name: "NotificationService", status: "Healthy",   healthScore: 95, cpm: 4300, rt: 55,   er: 0.1,  hrv: 0,  tier: "Notifications" },
    { externalId: "demo-app-1007", name: "InventoryManager",    status: "Critical",  healthScore: 38, cpm: 760,  rt: 1240, er: 7.6,  hrv: 5,  tier: "Inventory" },
    { externalId: "demo-app-1008", name: "ReportingDashboard",  status: "Healthy",   healthScore: 84, cpm: 320,  rt: 920,  er: 0.4,  hrv: 0,  tier: "Reporting" },
  ];

  const insertedApps = await db.insert(dbApplications).values(appDefs.map(a => ({
    externalId: a.externalId,
    source: SOURCE,
    credentialId: credId,
    name: a.name,
    status: a.status,
    healthRuleViolations: a.hrv,
    tier: a.tier,
    healthScore: a.healthScore,
    callsPerMinute: a.cpm,
    avgResponseTime: a.rt,
    errorRate: a.er,
    lastSyncAt: hrs(1),
  }))).returning();
  const appIdMap = Object.fromEntries(insertedApps.map(a => [a.externalId, a.id]));
  console.log("  ✔ Applications inserted:", insertedApps.length);

  // ── 7. Incidents ─────────────────────────────────────────────────────────
  await db.insert(dbIncidents).values([
    { externalId: "demo-inc-001", source: SOURCE, applicationId: "demo-app-1001", title: "High Error Rate — EcommerceAPI checkout endpoint exceeding 4% threshold", severity: "Critical", status: "Open",     startTime: hrs(3),  endTime: null,    rootCause: "Database connection pool exhaustion on checkout service", affectedServices: ["checkout-service", "cart-service"], lastSyncAt: hrs(1) },
    { externalId: "demo-inc-002", source: SOURCE, applicationId: "demo-app-1007", title: "InventoryManager Response Time Degradation > 1200ms", severity: "Critical", status: "Open",     startTime: hrs(6),  endTime: null,    rootCause: "N+1 query pattern in stock lookup API — missing index on product_id", affectedServices: ["warehouse-sync", "stock-api"], lastSyncAt: hrs(1) },
    { externalId: "demo-inc-003", source: SOURCE, applicationId: "demo-app-1002", title: "PaymentService — Increased 502 errors from upstream gateway", severity: "Warning",  status: "Open",     startTime: hrs(2),  endTime: null,    rootCause: "Third-party payment gateway intermittent timeouts", affectedServices: ["payment-gateway", "transaction-processor"], lastSyncAt: hrs(1) },
    { externalId: "demo-inc-004", source: SOURCE, applicationId: "demo-app-1004", title: "ProductCatalog — Elevated cache miss rate causing DB spikes", severity: "Warning",  status: "Open",     startTime: hrs(1),  endTime: null,    rootCause: "Redis cache eviction after deployment — cold start scenario", affectedServices: ["catalog-cache", "search-index"], lastSyncAt: hrs(1) },
    { externalId: "demo-inc-005", source: SOURCE, applicationId: "demo-app-1001", title: "EcommerceAPI — Memory heap utilisation at 88% on api-node-03", severity: "Warning",  status: "Resolved", startTime: days(1), endTime: hrs(20), rootCause: "Memory leak in session middleware, patched in v2.4.1", affectedServices: ["api-gateway", "session-store"], lastSyncAt: hrs(1) },
    { externalId: "demo-inc-006", source: SOURCE, applicationId: "demo-app-1005", title: "OrderProcessor — Batch job failed — Order reconciliation delayed", severity: "Warning",  status: "Resolved", startTime: days(2), endTime: days(1), rootCause: "Disk space full on job-runner-01, cleared by ops team", affectedServices: ["batch-processor", "reconciliation-job"], lastSyncAt: hrs(1) },
    { externalId: "demo-inc-007", source: SOURCE, applicationId: "demo-app-1003", title: "UserAuthService — JWT signing latency spike (P99 > 200ms)", severity: "Warning",  status: "Resolved", startTime: days(3), endTime: days(2), rootCause: "Certificate renewal caused brief key-rotation overhead", affectedServices: ["jwt-service", "token-cache"], lastSyncAt: hrs(1) },
    { externalId: "demo-inc-008", source: SOURCE, applicationId: "demo-app-1001", title: "EcommerceAPI — Network packet loss to downstream recommendation engine", severity: "Critical", status: "Resolved", startTime: days(5), endTime: days(4), rootCause: "NIC firmware bug on rack-02 switches, replaced", affectedServices: ["recommendation-engine", "api-gateway"], lastSyncAt: hrs(1) },
    { externalId: "demo-inc-009", source: SOURCE, applicationId: "demo-app-1007", title: "InventoryManager — Dead-lock detected in warehouse_sync transaction", severity: "Critical", status: "Resolved", startTime: days(7), endTime: days(6), rootCause: "Concurrent write contention — resolved with row-level locking", affectedServices: ["warehouse-sync", "db-primary"], lastSyncAt: hrs(1) },
    { externalId: "demo-inc-010", source: SOURCE, applicationId: "demo-app-1002", title: "PaymentService — PCI compliance health check failed on staging firewall", severity: "Warning",  status: "Resolved", startTime: days(10), endTime: days(9), rootCause: "Firewall rule update missing allow-list entry for new gateway IP", affectedServices: ["payment-gateway", "firewall"], lastSyncAt: hrs(1) },
  ]);
  console.log("  ✔ Incidents inserted: 10");

  // ── 8. Alerts ────────────────────────────────────────────────────────────
  await db.insert(dbAlerts).values([
    { externalId: "demo-alert-001", source: SOURCE, applicationId: "demo-app-1001", name: "Error Rate > 4% — EcommerceAPI",            severity: "Critical", status: "Open",     metric: "errors_per_minute", threshold: 4.0,  currentValue: 4.2,  triggeredAt: hrs(3),  lastSyncAt: hrs(1) },
    { externalId: "demo-alert-002", source: SOURCE, applicationId: "demo-app-1007", name: "Response Time > 1000ms — InventoryManager", severity: "Critical", status: "Open",     metric: "avg_response_time", threshold: 1000, currentValue: 1240, triggeredAt: hrs(6),  lastSyncAt: hrs(1) },
    { externalId: "demo-alert-003", source: SOURCE, applicationId: "demo-app-1007", name: "CPU > 90% — inventory-node-01",              severity: "Critical", status: "Open",     metric: "cpu_usage",         threshold: 90.0, currentValue: 94.3, triggeredAt: hrs(5),  lastSyncAt: hrs(1) },
    { externalId: "demo-alert-004", source: SOURCE, applicationId: "demo-app-1002", name: "502 Gateway Errors — PaymentService",        severity: "Warning",  status: "Open",     metric: "http_5xx_rate",     threshold: 0.5,  currentValue: 1.8,  triggeredAt: hrs(2),  lastSyncAt: hrs(1) },
    { externalId: "demo-alert-005", source: SOURCE, applicationId: "demo-app-1004", name: "Cache Miss Rate > 60% — ProductCatalog",     severity: "Warning",  status: "Open",     metric: "cache_miss_rate",   threshold: 60.0, currentValue: 78.2, triggeredAt: hrs(1),  lastSyncAt: hrs(1) },
    { externalId: "demo-alert-006", source: SOURCE, applicationId: "demo-app-1001", name: "Heap Memory > 85% — api-node-02",            severity: "Warning",  status: "Open",     metric: "heap_usage_pct",    threshold: 85.0, currentValue: 87.6, triggeredAt: hrs(2),  lastSyncAt: hrs(1) },
    { externalId: "demo-alert-007", source: SOURCE, applicationId: "demo-app-1005", name: "Order Queue Depth > 500",                    severity: "Warning",  status: "Open",     metric: "queue_depth",       threshold: 500,  currentValue: 612,  triggeredAt: hrs(4),  lastSyncAt: hrs(1) },
    { externalId: "demo-alert-008", source: SOURCE, applicationId: "demo-app-1007", name: "DB Query P99 > 2000ms — inventory_db",       severity: "Warning",  status: "Open",     metric: "db_query_p99",      threshold: 2000, currentValue: 2340, triggeredAt: hrs(3),  lastSyncAt: hrs(1) },
    { externalId: "demo-alert-009", source: SOURCE, applicationId: "demo-app-1001", name: "Calls Per Minute Drop > 20% — EcommerceAPI", severity: "Warning",  status: "Resolved", metric: "calls_per_minute",  threshold: 2800, currentValue: 2650, triggeredAt: days(1), resolvedAt: hrs(20), lastSyncAt: hrs(1) },
    { externalId: "demo-alert-010", source: SOURCE, applicationId: "demo-app-1003", name: "JWT Signing Latency P99 > 150ms",            severity: "Warning",  status: "Resolved", metric: "jwt_sign_p99",      threshold: 150,  currentValue: 189,  triggeredAt: days(3), resolvedAt: days(2), lastSyncAt: hrs(1) },
    { externalId: "demo-alert-011", source: SOURCE, applicationId: "demo-app-1008", name: "Report Generation > 30s — reporting-job",    severity: "Warning",  status: "Resolved", metric: "job_duration_sec",  threshold: 30,   currentValue: 42,   triggeredAt: days(2), resolvedAt: days(1), lastSyncAt: hrs(1) },
    { externalId: "demo-alert-012", source: SOURCE, applicationId: "demo-app-1006", name: "Email Notification Retry Rate > 5%",         severity: "Warning",  status: "Resolved", metric: "retry_rate",        threshold: 5.0,  currentValue: 6.8,  triggeredAt: days(4), resolvedAt: days(3), lastSyncAt: hrs(1) },
    { externalId: "demo-alert-013", source: SOURCE, applicationId: "demo-app-1004", name: "Search Index Lag > 30s",                     severity: "Warning",  status: "Resolved", metric: "index_lag_sec",     threshold: 30,   currentValue: 47,   triggeredAt: days(5), resolvedAt: days(4), lastSyncAt: hrs(1) },
    { externalId: "demo-alert-014", source: SOURCE, applicationId: "demo-app-1002", name: "Payment Timeout Rate > 1%",                  severity: "Critical", status: "Resolved", metric: "timeout_rate_pct",  threshold: 1.0,  currentValue: 2.4,  triggeredAt: days(7), resolvedAt: days(6), lastSyncAt: hrs(1) },
    { externalId: "demo-alert-015", source: SOURCE, applicationId: "demo-app-1005", name: "Disk I/O Wait > 40% — order-db",             severity: "Warning",  status: "Resolved", metric: "disk_io_wait",      threshold: 40,   currentValue: 53.2, triggeredAt: days(6), resolvedAt: days(5), lastSyncAt: hrs(1) },
  ]);
  console.log("  ✔ Alerts inserted: 15");

  // ── 9. Servers ───────────────────────────────────────────────────────────
  await db.insert(dbServers).values([
    { externalId: "demo-srv-001", source: SOURCE, applicationId: "demo-app-1001", name: "api-node-01",       ip: "10.0.1.11", role: "Application Server", tier: "API Gateway",  status: "Healthy",  cpuUsage: 44.2, memoryUsage: 61.0, diskUsage: 38.0, networkMbps: 320, alerts: 0, lastSyncAt: hrs(1) },
    { externalId: "demo-srv-002", source: SOURCE, applicationId: "demo-app-1001", name: "api-node-02",       ip: "10.0.1.12", role: "Application Server", tier: "API Gateway",  status: "Warning",  cpuUsage: 72.8, memoryUsage: 87.6, diskUsage: 42.0, networkMbps: 480, alerts: 2, lastSyncAt: hrs(1) },
    { externalId: "demo-srv-003", source: SOURCE, applicationId: "demo-app-1001", name: "api-node-03",       ip: "10.0.1.13", role: "Application Server", tier: "API Gateway",  status: "Warning",  cpuUsage: 68.1, memoryUsage: 88.0, diskUsage: 41.0, networkMbps: 410, alerts: 1, lastSyncAt: hrs(1) },
    { externalId: "demo-srv-004", source: SOURCE, applicationId: "demo-app-1002", name: "payment-node-01",   ip: "10.0.2.11", role: "Application Server", tier: "Payment",      status: "Warning",  cpuUsage: 55.4, memoryUsage: 72.3, diskUsage: 30.0, networkMbps: 180, alerts: 1, lastSyncAt: hrs(1) },
    { externalId: "demo-srv-005", source: SOURCE, applicationId: "demo-app-1003", name: "auth-node-01",      ip: "10.0.3.11", role: "Application Server", tier: "Auth",         status: "Healthy",  cpuUsage: 28.6, memoryUsage: 44.2, diskUsage: 22.0, networkMbps: 640, alerts: 0, lastSyncAt: hrs(1) },
    { externalId: "demo-srv-006", source: SOURCE, applicationId: "demo-app-1004", name: "catalog-node-01",   ip: "10.0.4.11", role: "Application Server", tier: "Catalog",      status: "Warning",  cpuUsage: 61.3, memoryUsage: 68.9, diskUsage: 55.0, networkMbps: 240, alerts: 1, lastSyncAt: hrs(1) },
    { externalId: "demo-srv-007", source: SOURCE, applicationId: "demo-app-1005", name: "order-node-01",     ip: "10.0.5.11", role: "Application Server", tier: "Orders",       status: "Healthy",  cpuUsage: 38.7, memoryUsage: 52.1, diskUsage: 48.0, networkMbps: 120, alerts: 0, lastSyncAt: hrs(1) },
    { externalId: "demo-srv-008", source: SOURCE, applicationId: "demo-app-1006", name: "notify-node-01",    ip: "10.0.6.11", role: "Application Server", tier: "Notifications",status: "Healthy",  cpuUsage: 18.2, memoryUsage: 31.5, diskUsage: 20.0, networkMbps: 90,  alerts: 0, lastSyncAt: hrs(1) },
    { externalId: "demo-srv-009", source: SOURCE, applicationId: "demo-app-1007", name: "inventory-node-01", ip: "10.0.7.11", role: "Application Server", tier: "Inventory",    status: "Critical", cpuUsage: 94.3, memoryUsage: 89.7, diskUsage: 71.0, networkMbps: 280, alerts: 3, lastSyncAt: hrs(1) },
    { externalId: "demo-srv-010", source: SOURCE, applicationId: "demo-app-1007", name: "inventory-node-02", ip: "10.0.7.12", role: "Application Server", tier: "Inventory",    status: "Warning",  cpuUsage: 82.1, memoryUsage: 76.4, diskUsage: 68.0, networkMbps: 210, alerts: 2, lastSyncAt: hrs(1) },
    { externalId: "demo-srv-011", source: SOURCE, applicationId: "demo-app-1008", name: "report-node-01",    ip: "10.0.8.11", role: "Application Server", tier: "Reporting",    status: "Healthy",  cpuUsage: 42.0, memoryUsage: 58.3, diskUsage: 63.0, networkMbps: 60,  alerts: 0, lastSyncAt: hrs(1) },
    { externalId: "demo-srv-012", source: SOURCE, applicationId: "demo-app-1001", name: "api-db-primary",    ip: "10.0.1.20", role: "Database Server",    tier: "Data",         status: "Healthy",  cpuUsage: 51.2, memoryUsage: 74.6, diskUsage: 67.0, networkMbps: 750, alerts: 0, lastSyncAt: hrs(1) },
  ]);
  console.log("  ✔ Servers inserted: 12");

  // ── 10. Business Transactions ─────────────────────────────────────────────
  await db.insert(dbTransactions).values([
    { externalId: "demo-bt-001", source: SOURCE, applicationId: "demo-app-1001", name: "/api/v2/checkout",          tier: "API Gateway",  avgResponseTime: 1240, callsPerMinute: 890,  errorRate: 6.2, status: "Slow",    lastSyncAt: hrs(1) },
    { externalId: "demo-bt-002", source: SOURCE, applicationId: "demo-app-1001", name: "/api/v2/cart/add",          tier: "API Gateway",  avgResponseTime: 320,  callsPerMinute: 2100, errorRate: 1.8, status: "Normal",  lastSyncAt: hrs(1) },
    { externalId: "demo-bt-003", source: SOURCE, applicationId: "demo-app-1001", name: "/api/v2/products/search",   tier: "API Gateway",  avgResponseTime: 680,  callsPerMinute: 1450, errorRate: 0.4, status: "Slow",    lastSyncAt: hrs(1) },
    { externalId: "demo-bt-004", source: SOURCE, applicationId: "demo-app-1001", name: "/api/v2/user/profile",      tier: "API Gateway",  avgResponseTime: 98,   callsPerMinute: 3200, errorRate: 0.1, status: "Normal",  lastSyncAt: hrs(1) },
    { externalId: "demo-bt-005", source: SOURCE, applicationId: "demo-app-1002", name: "ProcessPayment",           tier: "Payment",      avgResponseTime: 480,  callsPerMinute: 680,  errorRate: 2.1, status: "Warning", lastSyncAt: hrs(1) },
    { externalId: "demo-bt-006", source: SOURCE, applicationId: "demo-app-1002", name: "RefundTransaction",        tier: "Payment",      avgResponseTime: 290,  callsPerMinute: 120,  errorRate: 0.8, status: "Normal",  lastSyncAt: hrs(1) },
    { externalId: "demo-bt-007", source: SOURCE, applicationId: "demo-app-1003", name: "LoginUser",                tier: "Auth",         avgResponseTime: 68,   callsPerMinute: 4200, errorRate: 0.2, status: "Normal",  lastSyncAt: hrs(1) },
    { externalId: "demo-bt-008", source: SOURCE, applicationId: "demo-app-1003", name: "ValidateToken",            tier: "Auth",         avgResponseTime: 12,   callsPerMinute: 8900, errorRate: 0.05,status: "Normal",  lastSyncAt: hrs(1) },
    { externalId: "demo-bt-009", source: SOURCE, applicationId: "demo-app-1004", name: "GetProductDetails",        tier: "Catalog",      avgResponseTime: 420,  callsPerMinute: 1800, errorRate: 3.2, status: "Slow",    lastSyncAt: hrs(1) },
    { externalId: "demo-bt-010", source: SOURCE, applicationId: "demo-app-1004", name: "SearchProducts",           tier: "Catalog",      avgResponseTime: 870,  callsPerMinute: 960,  errorRate: 1.4, status: "Slow",    lastSyncAt: hrs(1) },
    { externalId: "demo-bt-011", source: SOURCE, applicationId: "demo-app-1005", name: "CreateOrder",              tier: "Orders",       avgResponseTime: 210,  callsPerMinute: 340,  errorRate: 0.9, status: "Normal",  lastSyncAt: hrs(1) },
    { externalId: "demo-bt-012", source: SOURCE, applicationId: "demo-app-1005", name: "TrackOrderStatus",         tier: "Orders",       avgResponseTime: 88,   callsPerMinute: 1200, errorRate: 0.3, status: "Normal",  lastSyncAt: hrs(1) },
    { externalId: "demo-bt-013", source: SOURCE, applicationId: "demo-app-1007", name: "StockLookup",              tier: "Inventory",    avgResponseTime: 1580, callsPerMinute: 430,  errorRate: 8.4, status: "Critical",lastSyncAt: hrs(1) },
    { externalId: "demo-bt-014", source: SOURCE, applicationId: "demo-app-1007", name: "UpdateStockQuantity",      tier: "Inventory",    avgResponseTime: 940,  callsPerMinute: 180,  errorRate: 5.1, status: "Slow",    lastSyncAt: hrs(1) },
    { externalId: "demo-bt-015", source: SOURCE, applicationId: "demo-app-1006", name: "SendEmailNotification",    tier: "Notifications",avgResponseTime: 45,   callsPerMinute: 3800, errorRate: 0.1, status: "Normal",  lastSyncAt: hrs(1) },
    { externalId: "demo-bt-016", source: SOURCE, applicationId: "demo-app-1006", name: "SendPushNotification",     tier: "Notifications",avgResponseTime: 38,   callsPerMinute: 2100, errorRate: 0.2, status: "Normal",  lastSyncAt: hrs(1) },
    { externalId: "demo-bt-017", source: SOURCE, applicationId: "demo-app-1008", name: "GenerateSalesReport",      tier: "Reporting",    avgResponseTime: 18400,callsPerMinute: 12,   errorRate: 0.8, status: "Slow",    lastSyncAt: hrs(1) },
    { externalId: "demo-bt-018", source: SOURCE, applicationId: "demo-app-1008", name: "GenerateInventoryReport",  tier: "Reporting",    avgResponseTime: 9200, callsPerMinute: 8,    errorRate: 0.4, status: "Slow",    lastSyncAt: hrs(1) },
    { externalId: "demo-bt-019", source: SOURCE, applicationId: "demo-app-1001", name: "/api/v2/orders/history",   tier: "API Gateway",  avgResponseTime: 540,  callsPerMinute: 780,  errorRate: 0.7, status: "Normal",  lastSyncAt: hrs(1) },
    { externalId: "demo-bt-020", source: SOURCE, applicationId: "demo-app-1002", name: "VerifyPaymentStatus",      tier: "Payment",      avgResponseTime: 120,  callsPerMinute: 2400, errorRate: 0.2, status: "Normal",  lastSyncAt: hrs(1) },
  ]);
  console.log("  ✔ Business Transactions inserted: 20");

  // ── 11. Errors ────────────────────────────────────────────────────────────
  await db.insert(dbErrors).values([
    { externalId: "demo-err-001", source: SOURCE, applicationId: "demo-app-1001", applicationName: "EcommerceAPI",        cluster: "production-k8s", service: "checkout-service",   errorType: "DatabaseException",      message: "Connection pool timeout after 30s — org.apache.tomcat.jdbc.pool.PoolExhaustedException",                   frequency: 847,  frequencyTrend: "up",   severity: "Critical", status: "Active",   firstSeen: days(2),  lastOccurrence: hrs(1) },
    { externalId: "demo-err-002", source: SOURCE, applicationId: "demo-app-1007", applicationName: "InventoryManager",    cluster: "production-k8s", service: "stock-api",          errorType: "QueryTimeoutException",  message: "Query execution exceeded 5000ms: SELECT * FROM stock_items WHERE product_id IN (...) — missing index",      frequency: 412,  frequencyTrend: "up",   severity: "Critical", status: "Active",   firstSeen: days(1),  lastOccurrence: hrs(1) },
    { externalId: "demo-err-003", source: SOURCE, applicationId: "demo-app-1002", applicationName: "PaymentService",      cluster: "production-k8s", service: "payment-gateway",    errorType: "HttpClientException",    message: "HTTP 502 Bad Gateway — upstream payment processor responded with no data after 10s timeout",                 frequency: 234,  frequencyTrend: "up",   severity: "Warning",  status: "Active",   firstSeen: hrs(5),   lastOccurrence: hrs(1) },
    { externalId: "demo-err-004", source: SOURCE, applicationId: "demo-app-1004", applicationName: "ProductCatalog",      cluster: "production-k8s", service: "catalog-cache",      errorType: "CacheNotFoundException", message: "Redis MISS on key 'product:details:*' — cache cold after deployment restart",                               frequency: 19200,frequencyTrend: "up",   severity: "Warning",  status: "Active",   firstSeen: hrs(2),   lastOccurrence: hrs(1) },
    { externalId: "demo-err-005", source: SOURCE, applicationId: "demo-app-1001", applicationName: "EcommerceAPI",        cluster: "production-k8s", service: "api-gateway",        errorType: "OutOfMemoryError",       message: "java.lang.OutOfMemoryError: Java heap space on api-node-02 — heap at 88% utilisation",                      frequency: 18,   frequencyTrend: "stable",severity: "Warning",  status: "Active",   firstSeen: hrs(4),   lastOccurrence: hrs(2) },
    { externalId: "demo-err-006", source: SOURCE, applicationId: "demo-app-1005", applicationName: "OrderProcessor",      cluster: "production-k8s", service: "order-processor",    errorType: "MessageQueueException",  message: "RabbitMQ queue 'orders.pending' depth 612 — consumer lag detected, messages aging > 2min",                  frequency: 72,   frequencyTrend: "up",   severity: "Warning",  status: "Active",   firstSeen: hrs(6),   lastOccurrence: hrs(1) },
    { externalId: "demo-err-007", source: SOURCE, applicationId: "demo-app-1007", applicationName: "InventoryManager",    cluster: "production-k8s", service: "warehouse-sync",     errorType: "DeadlockException",      message: "Transaction deadlock detected on table 'inventory_transactions' — rolling back and retrying",                frequency: 156,  frequencyTrend: "up",   severity: "Critical", status: "Active",   firstSeen: days(1),  lastOccurrence: hrs(1) },
    { externalId: "demo-err-008", source: SOURCE, applicationId: "demo-app-1003", applicationName: "UserAuthService",     cluster: "production-k8s", service: "jwt-service",        errorType: "SignatureException",     message: "JWT signature verification failed — token issued with rotated key still in circulation",                     frequency: 44,   frequencyTrend: "down", severity: "Warning",  status: "Active",   firstSeen: days(3),  lastOccurrence: days(1) },
    { externalId: "demo-err-009", source: SOURCE, applicationId: "demo-app-1001", applicationName: "EcommerceAPI",        cluster: "production-k8s", service: "recommendation-svc", errorType: "ConnectionRefusedException",message: "Connection refused to ML recommendation service on 10.0.9.14:8080 — service pod not ready",                frequency: 1240, frequencyTrend: "stable",severity: "Warning",  status: "Active",   firstSeen: days(2),  lastOccurrence: hrs(3) },
    { externalId: "demo-err-010", source: SOURCE, applicationId: "demo-app-1002", applicationName: "PaymentService",      cluster: "production-k8s", service: "transaction-processor",errorType: "ValidationException",   message: "Payment amount exceeds daily limit — transaction blocked by fraud prevention rule FP-2284",                 frequency: 89,   frequencyTrend: "stable",severity: "Warning",  status: "Active",   firstSeen: days(1),  lastOccurrence: hrs(2) },
    { externalId: "demo-err-011", source: SOURCE, applicationId: "demo-app-1004", applicationName: "ProductCatalog",      cluster: "production-k8s", service: "search-index",       errorType: "IndexCorruptionError",   message: "Elasticsearch shard allocation failed — 2 of 3 replicas unassigned for index products_v3",                  frequency: 23,   frequencyTrend: "stable",severity: "Warning",  status: "Active",   firstSeen: days(1),  lastOccurrence: hrs(4) },
    { externalId: "demo-err-012", source: SOURCE, applicationId: "demo-app-1008", applicationName: "ReportingDashboard",  cluster: "production-k8s", service: "reporting-job",      errorType: "TimeoutException",       message: "Report generation exceeded 30s SLA — daily-sales-report-2026-03-01 took 42.3s",                           frequency: 8,    frequencyTrend: "stable",severity: "Warning",  status: "Resolved", firstSeen: days(2),  lastOccurrence: days(1) },
    { externalId: "demo-err-013", source: SOURCE, applicationId: "demo-app-1006", applicationName: "NotificationService", cluster: "production-k8s", service: "email-sender",       errorType: "SmtpException",          message: "SMTP connection failed to relay.sendgrid.net:587 — TLS handshake timeout, retrying (attempt 3/3)",          frequency: 142,  frequencyTrend: "down", severity: "Warning",  status: "Resolved", firstSeen: days(4),  lastOccurrence: days(2) },
    { externalId: "demo-err-014", source: SOURCE, applicationId: "demo-app-1005", applicationName: "OrderProcessor",      cluster: "production-k8s", service: "reconciliation-job", errorType: "DiskSpaceException",     message: "No space left on device /data/jobs — disk usage at 100% on job-runner-01",                                 frequency: 1,    frequencyTrend: "down", severity: "Critical", status: "Resolved", firstSeen: days(2),  lastOccurrence: days(1) },
    { externalId: "demo-err-015", source: SOURCE, applicationId: "demo-app-1001", applicationName: "EcommerceAPI",        cluster: "production-k8s", service: "session-store",      errorType: "MemoryLeakDetected",     message: "Memory leak in session middleware v2.4.0 — heap growing 50MB/hour, patched in v2.4.1",                     frequency: 340,  frequencyTrend: "down", severity: "Warning",  status: "Resolved", firstSeen: days(3),  lastOccurrence: days(1) },
    { externalId: "demo-err-016", source: SOURCE, applicationId: "demo-app-1002", applicationName: "PaymentService",      cluster: "production-k8s", service: "payment-gateway",    errorType: "SSLCertificateError",    message: "SSL certificate chain incomplete for gateway.paymentco.com — intermediate cert missing from store",         frequency: 29,   frequencyTrend: "down", severity: "Critical", status: "Resolved", firstSeen: days(7),  lastOccurrence: days(5) },
    { externalId: "demo-err-017", source: SOURCE, applicationId: "demo-app-1007", applicationName: "InventoryManager",    cluster: "production-k8s", service: "db-primary",         errorType: "ReplicationLagWarning",  message: "PostgreSQL replication lag on standby exceeds 30s — risk of data loss if primary fails",                    frequency: 67,   frequencyTrend: "stable",severity: "Warning",  status: "Active",   firstSeen: days(1),  lastOccurrence: hrs(2) },
    { externalId: "demo-err-018", source: SOURCE, applicationId: "demo-app-1003", applicationName: "UserAuthService",     cluster: "production-k8s", service: "token-cache",        errorType: "CacheEvictionWarning",   message: "Redis maxmemory policy 'allkeys-lru' evicted 12,400 tokens in last 5min — consider increasing memory",     frequency: 3,    frequencyTrend: "down", severity: "Warning",  status: "Resolved", firstSeen: days(5),  lastOccurrence: days(3) },
    { externalId: "demo-err-019", source: SOURCE, applicationId: "demo-app-1004", applicationName: "ProductCatalog",      cluster: "production-k8s", service: "catalog-db",         errorType: "SlowQueryWarning",       message: "Query plan regression detected: full table scan on products table (12.8M rows) — missing composite index",   frequency: 892,  frequencyTrend: "up",   severity: "Warning",  status: "Active",   firstSeen: hrs(3),   lastOccurrence: hrs(1) },
    { externalId: "demo-err-020", source: SOURCE, applicationId: "demo-app-1001", applicationName: "EcommerceAPI",        cluster: "production-k8s", service: "checkout-service",   errorType: "NullPointerException",   message: "NullPointerException in CheckoutController.processOrder() line 284 — promo_code field null when not expected",frequency: 421,  frequencyTrend: "stable",severity: "Warning",  status: "Active",   firstSeen: days(1),  lastOccurrence: hrs(1) },
    { externalId: "demo-err-021", source: SOURCE, applicationId: "demo-app-1005", applicationName: "OrderProcessor",      cluster: "production-k8s", service: "batch-processor",    errorType: "BatchJobFailure",        message: "Scheduled batch job 'order-reconciliation-daily' failed after 45min — partial run, 342 orders not processed",frequency: 3,    frequencyTrend: "stable",severity: "Warning",  status: "Resolved", firstSeen: days(3),  lastOccurrence: days(2) },
    { externalId: "demo-err-022", source: SOURCE, applicationId: "demo-app-1006", applicationName: "NotificationService", cluster: "production-k8s", service: "push-notification",  errorType: "FCMTokenExpired",        message: "Firebase Cloud Messaging token expired for 8,412 devices — token refresh batch required",                    frequency: 8412, frequencyTrend: "down", severity: "Warning",  status: "Active",   firstSeen: days(2),  lastOccurrence: hrs(6) },
    { externalId: "demo-err-023", source: SOURCE, applicationId: "demo-app-1008", applicationName: "ReportingDashboard",  cluster: "production-k8s", service: "data-warehouse",     errorType: "ETLPipelineError",       message: "ETL pipeline 'sales_aggregation' failed at transformation step — incompatible schema change in orders table",frequency: 2,    frequencyTrend: "stable",severity: "Warning",  status: "Resolved", firstSeen: days(4),  lastOccurrence: days(3) },
  ]);
  console.log("  ✔ Errors inserted: 23");

  // ── 12. Capacity Risks ────────────────────────────────────────────────────
  const ecomAppId  = appIdMap["demo-app-1001"];
  const invAppId   = appIdMap["demo-app-1007"];
  const payAppId   = appIdMap["demo-app-1002"];
  const catAppId   = appIdMap["demo-app-1004"];

  await db.insert(dbCapacityRisks).values([
    { riskId: "demo-risk-001", source: SOURCE, name: "inventory-node-01 CPU Saturation",      type: "CPU",     severity: "Critical", entityType: "Server",      entityId: "demo-srv-009", entityName: "inventory-node-01",  current: 94.3, threshold: 90.0, hoursToSaturation: 1.2,  confidence: 0.94, riskScore: 97, affectedApp: "InventoryManager",    appId: invAppId },
    { riskId: "demo-risk-002", source: SOURCE, name: "api-node-02 Heap Memory Near Limit",    type: "Memory",  severity: "Critical", entityType: "Server",      entityId: "demo-srv-002", entityName: "api-node-02",        current: 87.6, threshold: 85.0, hoursToSaturation: 3.8,  confidence: 0.91, riskScore: 89, affectedApp: "EcommerceAPI",        appId: ecomAppId },
    { riskId: "demo-risk-003", source: SOURCE, name: "inventory-node-02 Memory Pressure",     type: "Memory",  severity: "Warning",  entityType: "Server",      entityId: "demo-srv-010", entityName: "inventory-node-02",  current: 76.4, threshold: 80.0, hoursToSaturation: 8.5,  confidence: 0.82, riskScore: 74, affectedApp: "InventoryManager",    appId: invAppId },
    { riskId: "demo-risk-004", source: SOURCE, name: "api-db-primary Disk Usage Growing",     type: "Disk",    severity: "Warning",  entityType: "Database",    entityId: "demo-srv-012", entityName: "api-db-primary",     current: 67.0, threshold: 80.0, hoursToSaturation: 24.0, confidence: 0.78, riskScore: 62, affectedApp: "EcommerceAPI",        appId: ecomAppId },
    { riskId: "demo-risk-005", source: SOURCE, name: "catalog-node-01 Disk Space — Index",    type: "Disk",    severity: "Warning",  entityType: "Server",      entityId: "demo-srv-006", entityName: "catalog-node-01",    current: 55.0, threshold: 70.0, hoursToSaturation: 36.0, confidence: 0.71, riskScore: 55, affectedApp: "ProductCatalog",      appId: catAppId },
    { riskId: "demo-risk-006", source: SOURCE, name: "EcommerceAPI Error Rate Trending Up",   type: "Network", severity: "Critical", entityType: "Application", entityId: "demo-app-1001",entityName: "EcommerceAPI",       current: 4.2,  threshold: 4.0,  hoursToSaturation: 0.5,  confidence: 0.96, riskScore: 98, affectedApp: "EcommerceAPI",        appId: ecomAppId },
    { riskId: "demo-risk-007", source: SOURCE, name: "PaymentService — Gateway Timeout Spike",type: "Network", severity: "Warning",  entityType: "Application", entityId: "demo-app-1002",entityName: "PaymentService",     current: 1.8,  threshold: 1.0,  hoursToSaturation: 2.0,  confidence: 0.87, riskScore: 81, affectedApp: "PaymentService",      appId: payAppId },
    { riskId: "demo-risk-008", source: SOURCE, name: "InventoryManager CPU — All Nodes",      type: "CPU",     severity: "Critical", entityType: "Application", entityId: "demo-app-1007",entityName: "InventoryManager",   current: 88.2, threshold: 85.0, hoursToSaturation: 2.1,  confidence: 0.93, riskScore: 95, affectedApp: "InventoryManager",    appId: invAppId },
  ]);
  console.log("  ✔ Capacity Risks inserted: 8");

  console.log("\n✅  Demo seed complete!");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Email   : demo@Observaiq.com");
  console.log("  Password: Demo@12345");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  process.exit(0);
}

main().catch(err => {
  console.error("❌  Seed failed:", err);
  process.exit(1);
});
