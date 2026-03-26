export const DEMO_CAUSAL_PREDICTIVE = {
  summary:
    "Critical multi-service degradation detected across EcommerceAPI and InventoryManager. Database connection pool exhaustion on the checkout service is the primary trigger, causing cascading failures into cart and order processing. Concurrent inventory deadlocks are compounding the impact. 72-hour AI forecast indicates high risk of full checkout unavailability if connection pool limits are not expanded and N+1 queries resolved.",
  confidence: 0.91,
  causalChains: [
    {
      id: "chain-001",
      title: "DB Connection Pool Exhaustion → Checkout Failure Cascade",
      confidence: 94,
      steps: [
        { time: "T-180min", event: "Slow queries accumulate", value: "P99 > 4s" },
        { time: "T-120min", event: "Connection pool saturation", value: "100% pool used" },
        { time: "T-90min",  event: "Checkout 502 errors spike", value: "6.2% error rate" },
        { time: "T-60min",  event: "Cart abandonment surge", value: "+340% timeouts" },
        { time: "T-0",      event: "Revenue impact detected", value: "~$28k/hr loss" },
      ],
      rootCause:
        "Slow queries on the checkout_items table (missing composite index on order_id + product_id) held connections beyond the 30-second pool timeout, exhausting all 100 available connections.",
      recommendation:
        "Add composite index on checkout_items(order_id, product_id). Increase pool size to 200 as immediate mitigation. Implement query timeout at 5s with circuit breaker pattern.",
    },
    {
      id: "chain-002",
      title: "InventoryManager N+1 Query → Deadlock Spiral",
      confidence: 88,
      steps: [
        { time: "T-360min", event: "Stock lookup volume increase", value: "+180% traffic" },
        { time: "T-240min", event: "N+1 queries trigger table scan", value: "12.8M rows/scan" },
        { time: "T-180min", event: "Lock contention begins", value: "14 deadlocks/min" },
        { time: "T-90min",  event: "CPU saturation on inventory-node-01", value: "94.3%" },
        { time: "T-0",      event: "Warehouse sync failures", value: "156 errors/hr" },
      ],
      rootCause:
        "StockLookup API iterates individual product queries inside a transaction loop instead of batching, causing row-level lock acquisition across thousands of rows simultaneously and creating deadlock conditions under concurrent write traffic.",
      recommendation:
        "Refactor StockLookup to use a single batched SELECT IN query. Add database-level row-level locking hints. Deploy read replicas to offload inventory queries from primary.",
    },
    {
      id: "chain-003",
      title: "PaymentService Gateway Timeout → Transaction Retry Storm",
      confidence: 82,
      steps: [
        { time: "T-120min", event: "Upstream gateway latency increases", value: "+800ms" },
        { time: "T-90min",  event: "502 errors begin", value: "1.8% error rate" },
        { time: "T-60min",  event: "Client retry logic activates", value: "3x traffic spike" },
        { time: "T-30min",  event: "Payment queue depth grows", value: "612 pending" },
        { time: "T-0",      event: "Duplicate payment risk detected", value: "Idempotency checks needed" },
      ],
      rootCause:
        "Third-party payment gateway IP block added to firewall allowlist incorrectly — intermittent connection resets cause clients to retry without idempotency tokens, risking duplicate charges.",
      recommendation:
        "Verify firewall allowlist contains all payment gateway egress IPs. Implement idempotency key enforcement in PaymentService. Add exponential backoff with jitter to payment client retry logic.",
    },
  ],
  predictions: [
    {
      metric: "EcommerceAPI Error Rate",
      current: 4.2,
      predicted72h: 8.7,
      riskLevel: "High",
      confidence: 89,
      action: "Add missing DB index and expand connection pool within 4 hours to prevent full checkout outage.",
    },
    {
      metric: "InventoryManager CPU",
      current: 94.3,
      predicted72h: 98.0,
      riskLevel: "High",
      confidence: 92,
      action: "Deploy read replicas for stock queries within 6 hours. Refactor N+1 patterns within 24 hours.",
    },
    {
      metric: "PaymentService Timeout Rate",
      current: 1.8,
      predicted72h: 3.4,
      riskLevel: "High",
      confidence: 78,
      action: "Resolve firewall allowlist issue and implement retry backoff to prevent duplicate payment incidents.",
    },
    {
      metric: "API Heap Memory (api-node-02)",
      current: 87.6,
      predicted72h: 95.0,
      riskLevel: "High",
      confidence: 84,
      action: "Force garbage collection and schedule rolling restart of api-node-02 within 2 hours.",
    },
    {
      metric: "Order Queue Depth",
      current: 612,
      predicted72h: 1840,
      riskLevel: "High",
      confidence: 76,
      action: "Scale OrderProcessor consumers from 2 to 6 instances to drain queue backlog.",
    },
    {
      metric: "ProductCatalog Cache Miss Rate",
      current: 78.2,
      predicted72h: 22.0,
      riskLevel: "Medium",
      confidence: 81,
      action: "Cache will self-warm over next 4–6 hours. Pre-warm top 1000 product pages to accelerate recovery.",
    },
  ],
  recommendations: [
    { action: "Create composite index on checkout_items(order_id, product_id)",     impact: "Eliminates primary root cause of connection pool exhaustion — estimated 80% error rate reduction", priority: "high" },
    { action: "Expand EcommerceAPI DB connection pool from 100 to 200",              impact: "Immediate mitigation preventing full checkout unavailability during index deployment", priority: "high" },
    { action: "Refactor InventoryManager StockLookup to batched SELECT IN queries",  impact: "Eliminates deadlock spiral and reduces CPU from 94% to estimated 52%", priority: "high" },
    { action: "Resolve PaymentService firewall allowlist for gateway IPs",            impact: "Stops 502 errors and retry storm — eliminates duplicate payment risk", priority: "high" },
    { action: "Deploy read replica for InventoryManager DB",                          impact: "Offloads 60% of query load from primary, preventing replication lag escalation", priority: "medium" },
    { action: "Pre-warm ProductCatalog Redis cache for top 1000 products",            impact: "Reduces cache miss rate from 78% to <10%, normalising catalog response times in 1 hour", priority: "medium" },
  ],
  relatedIssues: [
    { service: "EcommerceAPI",     issueId: "demo-inc-001", severity: "Critical" },
    { service: "InventoryManager", issueId: "demo-inc-002", severity: "Critical" },
    { service: "PaymentService",   issueId: "demo-inc-003", severity: "Warning" },
  ],
};

export const DEMO_ROOT_CAUSE = {
  summary:
    "Primary root cause identified with 93% confidence: Database connection pool exhaustion on the EcommerceAPI checkout service, triggered by a missing composite index on the checkout_items table. The slow query pattern (full table scan over 8.4M rows) holds connections for 30+ seconds, exhausting the 100-connection pool and causing cascading 502 failures. Secondary root cause: InventoryManager N+1 query pattern inducing deadlocks under concurrent load.",
  confidence: 0.93,
  rootCauseDetails: {
    description:
      "Missing composite index on checkout_items(order_id, product_id) causes full sequential scans of the 8.4M row table for every checkout. Under production load of 890 calls/minute, this saturates the 100-connection database pool within minutes, starving all other checkout requests.",
    probableCause:
      "The index was dropped during a schema migration in the v2.4.0 deployment (3 days ago) but was never recreated. The deployment rolled back application code but did not reverse the DDL change.",
    evidencePoints: [
      "847 DatabaseException (connection pool timeout) events in last 48h — all originating from CheckoutController.processOrder()",
      "DB query P99 on checkout_items elevated to 4,200ms vs. baseline of 180ms — consistent with full table scan",
      "Connection pool utilisation hit 100% at T-180min, correlated exactly with error rate spike from 0.4% to 4.2%",
      "EXPLAIN output shows Seq Scan on checkout_items (cost=0.00..428,932 rows=8,432,100) — no index path available",
      "Error frequency trend: 'up' — 847 occurrences and growing at 34 errors/hour",
      "Incident demo-inc-001 opened 3 hours ago, root cause note already mentions connection pool — this analysis confirms and traces the origin",
      "Schema migration log shows DROP INDEX checkout_items_order_product_idx in v2.4.0 migration without corresponding recreate",
    ],
    probabilityScore: 93,
  },
  impactedServices: [
    { name: "checkout-service",       severity: "Critical", affectedSince: "3h ago" },
    { name: "cart-service",           severity: "High",     affectedSince: "3h ago" },
    { name: "EcommerceAPI (api-node-02)", severity: "High", affectedSince: "4h ago" },
    { name: "OrderProcessor queue",   severity: "Medium",   affectedSince: "4h ago" },
    { name: "recommendation-engine",  severity: "Medium",   affectedSince: "2h ago" },
    { name: "UserAuthService",        severity: "Low",      affectedSince: "Unaffected" },
  ],
  timeline: [
    { time: "T-72h",  event: "v2.4.0 deployed — migration drops checkout_items index (unnoticed)", severity: "Low" },
    { time: "T-48h",  event: "First DatabaseException errors appear (low volume, within noise threshold)", severity: "Low" },
    { time: "T-24h",  event: "Error rate climbs to 0.8% — still below alert threshold of 4%", severity: "Medium" },
    { time: "T-6h",   event: "Traffic ramp-up causes connection pool hits 80% saturation", severity: "Medium" },
    { time: "T-3h",   event: "Connection pool fully exhausted — checkout errors spike to 4.2%", severity: "Critical" },
    { time: "T-2h",   event: "Incident demo-inc-001 opened — ops team begins triage", severity: "Critical" },
    { time: "T-1.5h", event: "api-node-02 heap memory reaches 87.6% — possible secondary leak from retry accumulation", severity: "High" },
    { time: "T-0",    event: "AI Root Cause Analysis run — index drop confirmed as primary cause", severity: "Critical" },
  ],
  recommendations: [
    { action: "Immediately recreate index: CREATE INDEX CONCURRENTLY checkout_items_order_product_idx ON checkout_items(order_id, product_id)",  impact: "Eliminates full table scan — expected query time back to 180ms P99, error rate drops below 0.4%", priority: "high" },
    { action: "Temporarily increase connection pool to 200 while index build completes",                                                          impact: "Buys 2–3 hours of breathing room, prevents complete checkout outage during index creation", priority: "high" },
    { action: "Add pre-deployment index validation to CI/CD pipeline (detect missing indexes before deploy)",                                     impact: "Prevents recurrence — catches DDL regressions automatically", priority: "medium" },
    { action: "Restart api-node-02 in rolling fashion to clear heap memory accumulation",                                                         impact: "Reduces heap from 87.6% to ~45%, eliminates secondary OOM risk", priority: "medium" },
    { action: "Post-incident: add query time SLO alert (P99 > 500ms triggers warning) as leading indicator",                                      impact: "Would have caught this 48 hours earlier at first slow query appearance", priority: "low" },
  ],
  relatedIssues: [
    { service: "EcommerceAPI",     issueId: "demo-inc-001", severity: "Critical" },
    { service: "EcommerceAPI",     issueId: "demo-err-001", severity: "Critical" },
    { service: "InventoryManager", issueId: "demo-inc-002", severity: "Critical" },
    { service: "PaymentService",   issueId: "demo-inc-003", severity: "Warning" },
  ],
};

export const DEMO_CORRELATION_INSIGHTS = {
  summary:
    "AI analysis uncovered 4 high-confidence correlations across 8 services. The most significant: a causal chain connecting the EcommerceAPI DB pool exhaustion to downstream InventoryManager deadlocks via shared transaction coordinator traffic. A temporal correlation shows PaymentService 502 errors and EcommerceAPI checkout failures began within 8 minutes of each other, suggesting a common upstream network event. Two anomaly clusters identified — one around database layer saturation, one around memory pressure across API-tier nodes.",
  confidence: 0.87,
  correlations: [
    {
      id: "corr-001",
      title: "EcommerceAPI Checkout Errors ↔ InventoryManager Deadlocks",
      description:
        "When checkout error rate exceeds 2%, InventoryManager deadlock frequency increases by 340% within 15 minutes. The shared database transaction coordinator becomes a bottleneck as checkout retries flood inventory stock reservation calls.",
      type: "causal",
      strength: 0.91,
      services: ["EcommerceAPI", "InventoryManager", "checkout-service", "warehouse-sync"],
      evidence: [
        "Checkout error rate exceeded 2% at T-180min; InventoryManager deadlocks rose from 4/min to 18/min at T-165min (15-min lag)",
        "Both services share the same PostgreSQL primary — transaction coordinator log confirms cross-service lock contention",
        "847 checkout exceptions and 156 warehouse-sync errors share identical stack trace prefixes in connection acquisition",
        "CPU on inventory-node-01 (94.3%) correlates with checkout call volume at r=0.89",
      ],
    },
    {
      id: "corr-002",
      title: "PaymentService 502s ↔ EcommerceAPI Checkout Failures — Common Network Event",
      description:
        "Both PaymentService and EcommerceAPI began experiencing elevated errors within 8 minutes of each other at T-120min. Traffic analysis suggests a brief network partition or packet loss event on rack-02 switches affected both services simultaneously before the database bottleneck became dominant.",
      type: "temporal",
      strength: 0.84,
      services: ["PaymentService", "EcommerceAPI", "api-gateway", "payment-gateway"],
      evidence: [
        "PaymentService 502 errors began at T-122min; EcommerceAPI checkout failures at T-120min — 2-minute temporal overlap",
        "Network interface error counters on rack-02 switches show 0.3% packet loss starting T-125min",
        "Both services share rack-02 network segment; UserAuthService (different rack) was unaffected at same time",
        "Firewall log shows 14 dropped connection attempts from payment gateway IP range between T-125min and T-115min",
      ],
    },
    {
      id: "corr-003",
      title: "API-Tier Memory Pressure Cluster — EcommerceAPI api-node-02 & api-node-03",
      description:
        "Heap memory on api-node-02 (87.6%) and api-node-03 (88.0%) is growing at the same rate (+2.1%/hour) with 97% correlation. Root pattern: retry storm from checkout failures is accumulating pending HTTP response objects in memory, indicating a common memory leak in the async response handler.",
      type: "service",
      strength: 0.97,
      services: ["api-node-02", "api-node-03", "checkout-service"],
      evidence: [
        "Heap growth rate on api-node-02: +2.08%/hour; api-node-03: +2.14%/hour — virtually identical slopes",
        "Memory growth began exactly at checkout error spike onset — consistent with retry accumulation hypothesis",
        "GC log shows increasing Old Gen pressure with 0 heap reclamation on long-lived HTTP response objects",
        "Session middleware v2.4.0 memory leak bug (reported in demo-err-015) matches the growth pattern observed",
      ],
    },
    {
      id: "corr-004",
      title: "ProductCatalog Cache Miss → Checkout Latency Amplification",
      description:
        "ProductCatalog's 78.2% cache miss rate is contributing an additional 280ms to every checkout page load that includes product detail calls. This compounds the DB connection wait time, pushing total checkout latency from 890ms to 1,170ms during checkout, worsening user-perceived failures.",
      type: "error",
      strength: 0.79,
      services: ["ProductCatalog", "EcommerceAPI", "catalog-cache"],
      evidence: [
        "Cache miss rate increased from 8% to 78% following ProductCatalog deployment restart 2 hours ago",
        "Waterfall trace shows product-detail API calls adding 280ms overhead on cache-miss paths",
        "EcommerceAPI slow transaction list: /api/v2/checkout is the #1 slowest BT at 1,240ms — product detail calls visible in trace",
        "Cache miss rate trending up — cold start effect, will self-resolve in 4–6 hours without intervention",
      ],
    },
  ],
  anomalyClusters: [
    {
      cluster: "Database Layer Saturation",
      frequency: "847 events in 48h, accelerating",
      impact: "High",
      events: ["Connection pool timeout", "Query P99 > 4s", "Deadlock detected", "Replication lag > 30s"],
    },
    {
      cluster: "API-Tier Memory Pressure",
      frequency: "18 OOM warnings in 4h, steady",
      impact: "High",
      events: ["Heap > 85%", "GC Old Gen pressure", "HTTP response object leak", "Retry accumulation"],
    },
    {
      cluster: "Queue Backlog Accumulation",
      frequency: "72 MessageQueueException in 6h, growing",
      impact: "Medium",
      events: ["Order queue depth 612", "Consumer lag > 2min", "RabbitMQ backpressure", "Batch job delay"],
    },
    {
      cluster: "Cache Cold Start (Post-Deploy)",
      frequency: "19,200 cache misses in 2h, resolving",
      impact: "Medium",
      events: ["Redis MISS 78.2%", "Catalog DB query spike", "Search index lag", "Elevated response times"],
    },
  ],
  serviceEventMap: [
    { service: "EcommerceAPI",        relatedEvents: ["DB connection pool exhausted", "Heap OOM warning", "Checkout 502 errors", "Network packet loss"],  riskContribution: 34 },
    { service: "InventoryManager",    relatedEvents: ["N+1 query deadlocks", "CPU saturation 94%", "Replication lag", "Warehouse sync failures"],           riskContribution: 28 },
    { service: "PaymentService",      relatedEvents: ["Gateway 502 errors", "Firewall packet drop", "Payment timeout retry storm"],                          riskContribution: 18 },
    { service: "ProductCatalog",      relatedEvents: ["Redis cache miss 78%", "Search index lag", "Catalog DB spike"],                                       riskContribution: 10 },
    { service: "OrderProcessor",      relatedEvents: ["Queue depth 612", "Consumer lag", "Batch reconciliation delay"],                                       riskContribution: 7 },
    { service: "UserAuthService",     relatedEvents: ["JWT key rotation lag (resolved)", "Token cache eviction (resolved)"],                                  riskContribution: 2 },
    { service: "NotificationService", relatedEvents: ["SMTP timeout (resolved)", "FCM token expiry batch needed"],                                            riskContribution: 1 },
    { service: "ReportingDashboard",  relatedEvents: ["ETL pipeline schema mismatch (resolved)", "Report generation SLA breach (resolved)"],                  riskContribution: 0 },
  ],
  recommendations: [
    { action: "Address database layer saturation cluster first — index + pool size expansion",     impact: "Resolves 34% of total risk contribution in the system, unblocks checkout service", priority: "high" },
    { action: "Isolate InventoryManager on dedicated DB primary to break cross-service contention", impact: "Prevents EcommerceAPI and InventoryManager from sharing lock contention", priority: "high" },
    { action: "Deploy circuit breaker between EcommerceAPI and InventoryManager stock calls",       impact: "Breaks causal chain — checkout service degrades gracefully if inventory is slow", priority: "medium" },
    { action: "Pre-warm ProductCatalog cache to reduce compounding latency contribution",            impact: "Reduces checkout latency by ~280ms immediately, improving user experience", priority: "medium" },
  ],
  relatedIssues: [
    { service: "EcommerceAPI",     issueId: "demo-inc-001", severity: "Critical" },
    { service: "InventoryManager", issueId: "demo-inc-002", severity: "Critical" },
    { service: "PaymentService",   issueId: "demo-inc-003", severity: "Warning" },
    { service: "ProductCatalog",   issueId: "demo-inc-004", severity: "Warning" },
  ],
};

export const DEMO_RECOMMENDATIONS = {
  summary:
    "12 prioritised actions identified across 5 services. 4 immediate actions address the active production incident causing ~$28k/hr revenue impact. 5 preventive actions address systemic weaknesses that will cause recurrence within 72 hours if unaddressed. 3 architectural improvements for long-term reliability. Estimated full resolution time: 6–8 hours for critical items.",
  confidence: 0.88,
  immediateActions: [
    {
      action: "Recreate missing database index on checkout_items(order_id, product_id)",
      impact: "Eliminates primary root cause — DB query time drops from 4,200ms to ~180ms P99, checkout error rate expected to fall from 4.2% to under 0.4% within 10 minutes of index creation completing",
      priority: "high",
      effort: "low",
      targetService: "EcommerceAPI / checkout-service",
      estimatedResolutionTime: "45–60 minutes (index build time on 8.4M row table)",
    },
    {
      action: "Expand EcommerceAPI database connection pool from 100 to 200 connections",
      impact: "Immediate headroom while index is being built — prevents complete checkout availability loss during the 45-60 minute index creation window",
      priority: "high",
      effort: "low",
      targetService: "EcommerceAPI",
      estimatedResolutionTime: "5 minutes (config change + rolling restart)",
    },
    {
      action: "Refactor InventoryManager StockLookup API to use batched SELECT IN queries instead of N+1 pattern",
      impact: "Eliminates deadlock spiral — reduces CPU from 94.3% to estimated 48%, clears warehouse-sync errors, reduces DB query count by 95%",
      priority: "high",
      effort: "medium",
      targetService: "InventoryManager / stock-api",
      estimatedResolutionTime: "3–4 hours (code change + deploy)",
    },
    {
      action: "Update firewall allowlist to include all PaymentGateway egress IPs and implement idempotency keys on payment retry logic",
      impact: "Stops 502 errors and retry storm, eliminates duplicate payment risk, reduces payment-related error rate from 1.8% to below 0.2%",
      priority: "high",
      effort: "low",
      targetService: "PaymentService / firewall",
      estimatedResolutionTime: "30 minutes (firewall rule + code deploy)",
    },
    {
      action: "Rolling restart of api-node-02 and api-node-03 to clear heap accumulation",
      impact: "Resets heap from 87.6% to ~30%, eliminates OOM risk, clears accumulated retry response objects from session middleware leak",
      priority: "high",
      effort: "low",
      targetService: "EcommerceAPI / api-node-02, api-node-03",
      estimatedResolutionTime: "15 minutes (rolling restart, no downtime)",
    },
    {
      action: "Scale OrderProcessor consumer instances from 2 to 6 to drain queue backlog of 612 messages",
      impact: "Queue drains within 20 minutes, prevents order processing delays from compounding, eliminates SLA breach risk on pending orders",
      priority: "medium",
      effort: "low",
      targetService: "OrderProcessor",
      estimatedResolutionTime: "20 minutes",
    },
  ],
  preventiveActions: [
    {
      action: "Add automated database index validation step to CI/CD deployment pipeline",
      impact: "Prevents recurrence of the current incident — detects missing or dropped indexes before reaching production, estimated to catch 90% of DDL regression issues",
      priority: "high",
      effort: "medium",
      targetService: "Platform / CI-CD pipeline",
    },
    {
      action: "Implement circuit breaker pattern between EcommerceAPI and InventoryManager",
      impact: "Breaks causal failure chain — checkout degrades gracefully (shows cached inventory data) instead of failing completely when inventory is slow or down",
      priority: "high",
      effort: "high",
      targetService: "EcommerceAPI / InventoryManager",
    },
    {
      action: "Deploy dedicated read replica for InventoryManager to offload stock query traffic",
      impact: "Separates read and write load — prevents future CPU saturation and eliminates cross-service DB contention with EcommerceAPI",
      priority: "medium",
      effort: "medium",
      targetService: "InventoryManager / DB infrastructure",
    },
    {
      action: "Add query latency SLO alert (P99 > 500ms = Warning, P99 > 2000ms = Critical) as leading indicator",
      impact: "Would have detected current incident 48 hours earlier at first slow query appearance, enabling proactive resolution before user impact",
      priority: "medium",
      effort: "low",
      targetService: "All services / Monitoring",
    },
    {
      action: "Implement Redis cache pre-warming job triggered on every ProductCatalog deployment",
      impact: "Eliminates future cold-start cache miss storms post-deploy — maintains <10% miss rate even immediately after deployment",
      priority: "medium",
      effort: "medium",
      targetService: "ProductCatalog / cache infrastructure",
    },
  ],
  recommendations: [
    { action: "Recreate checkout_items index (immediate — top priority)",              impact: "Resolves primary root cause in ~60 minutes", priority: "high" },
    { action: "Fix InventoryManager N+1 query pattern",                                impact: "Resolves deadlock spiral and CPU saturation", priority: "high" },
    { action: "Fix PaymentService firewall allowlist",                                  impact: "Stops gateway 502 errors and retry storm", priority: "high" },
    { action: "Implement circuit breaker for checkout → inventory calls",               impact: "Long-term resilience improvement", priority: "medium" },
    { action: "Add DB index validation to CI/CD pipeline",                              impact: "Prevents class of DDL regression incidents", priority: "medium" },
  ],
  relatedIssues: [
    { service: "EcommerceAPI",     issueId: "demo-inc-001", severity: "Critical" },
    { service: "InventoryManager", issueId: "demo-inc-002", severity: "Critical" },
    { service: "PaymentService",   issueId: "demo-inc-003", severity: "Warning" },
  ],
};

export const DEMO_SERVICE_RISK_RANKING = {
  summary:
    "8 services ranked by composite risk score combining incident history, active alert count, error rates, resource utilisation and failure trend. 2 services in Critical risk tier requiring immediate intervention. 2 services in High risk tier with active alerts. 4 services in low-risk Healthy tier. EcommerceAPI and InventoryManager together account for 62% of total platform risk.",
  confidence: 0.90,
  rankings: [
    {
      rank: 1,
      service: "EcommerceAPI",
      riskLevel: "Critical",
      riskScore: 96,
      trend: "Worsening",
      reasoning:
        "Connection pool exhaustion causing 4.2% checkout error rate. Heap memory at 87.6% on 2 of 3 nodes. 8 open alerts. Primary revenue-generating service — every minute of degradation costs ~$467.",
      incidents: 4,
      alerts: 4,
      errors: 6,
      topFactors: ["DB connection pool 100% saturated", "Heap memory 87.6%", "Error rate 4.2%", "6.2% checkout BT error rate"],
    },
    {
      rank: 2,
      service: "InventoryManager",
      riskLevel: "Critical",
      riskScore: 93,
      trend: "Worsening",
      reasoning:
        "CPU at 94.3% on primary node. Deadlock rate 14/min and growing. N+1 query pattern causing cascading DB lock contention. No redundant instances — single point of failure for all stock operations.",
      incidents: 3,
      alerts: 3,
      errors: 4,
      topFactors: ["CPU 94.3%", "14 deadlocks/min", "1,580ms avg response time", "8.4% BT error rate"],
    },
    {
      rank: 3,
      service: "PaymentService",
      riskLevel: "High",
      riskScore: 79,
      trend: "Worsening",
      reasoning:
        "Active 502 gateway errors with retry storm creating duplicate payment risk. Firewall misconfiguration is the root cause but not yet fixed. PCI compliance sensitive — continued degradation increases regulatory exposure.",
      incidents: 2,
      alerts: 2,
      errors: 3,
      topFactors: ["502 gateway errors 1.8%", "Retry storm active", "Payment timeout 2.4%", "Idempotency risk"],
    },
    {
      rank: 4,
      service: "ProductCatalog",
      riskLevel: "High",
      riskScore: 68,
      trend: "Stable",
      reasoning:
        "Cache miss rate at 78.2% following deployment restart — self-resolving but currently adding 280ms overhead to every checkout call and causing search index lag. DB scan queries at full table scan due to missing Elasticsearch shard.",
      incidents: 1,
      alerts: 2,
      errors: 3,
      topFactors: ["Cache miss 78.2%", "Search index lag", "Catalog DB full scan", "280ms checkout overhead"],
    },
    {
      rank: 5,
      service: "OrderProcessor",
      riskLevel: "Medium",
      riskScore: 44,
      trend: "Stable",
      reasoning:
        "Queue depth at 612 and growing due to checkout backlog spillover. Consumer capacity (2 instances) insufficient to handle retry traffic from EcommerceAPI degradation. No active errors but at risk of SLA breach on pending orders.",
      incidents: 1,
      alerts: 1,
      errors: 2,
      topFactors: ["Queue depth 612", "Consumer lag > 2min", "Only 2 consumer instances"],
    },
    {
      rank: 6,
      service: "ReportingDashboard",
      riskLevel: "Low",
      riskScore: 18,
      trend: "Improving",
      reasoning:
        "All previous incidents resolved. ETL pipeline schema mismatch fixed. Report generation SLA breach resolved. Low traffic service with no downstream dependencies. Minor disk usage growth (63%) worth monitoring.",
      incidents: 0,
      alerts: 0,
      errors: 2,
      topFactors: ["Disk usage 63% (non-critical)", "Report SLA breach resolved"],
    },
    {
      rank: 7,
      service: "NotificationService",
      riskLevel: "Low",
      riskScore: 12,
      trend: "Improving",
      reasoning:
        "SMTP timeout issue resolved. FCM token expiry batch in progress (8,412 devices). Low error rate of 0.1%. High throughput (4,300 calls/min) with no active incidents. Self-contained service with no critical path dependencies.",
      incidents: 0,
      alerts: 0,
      errors: 2,
      topFactors: ["FCM token batch in progress", "SMTP resolved"],
    },
    {
      rank: 8,
      service: "UserAuthService",
      riskLevel: "Low",
      riskScore: 8,
      trend: "Improving",
      reasoning:
        "Healthiest service in the stack. JWT key rotation issue resolved 24h ago. Zero open incidents. Zero open alerts. 99.7% success rate on token validation (ValidateToken BT: 12ms avg). Stable at 91% health score.",
      incidents: 0,
      alerts: 0,
      errors: 1,
      topFactors: ["JWT rotation resolved", "Token cache eviction resolved"],
    },
  ],
  recommendations: [
    { action: "Immediate: Recreate checkout_items DB index to resolve EcommerceAPI critical risk",     impact: "Drops EcommerceAPI risk score from 96 to estimated 31 within 60 minutes", priority: "high" },
    { action: "Immediate: Refactor InventoryManager N+1 queries and expand to 2 instances",            impact: "Drops InventoryManager risk score from 93 to estimated 28, eliminates single point of failure", priority: "high" },
    { action: "Urgent: Fix PaymentService firewall allowlist and add idempotency keys",                 impact: "Drops PaymentService risk score from 79 to estimated 15, eliminates regulatory risk", priority: "high" },
    { action: "Scale OrderProcessor to 6 consumer instances to drain queue backlog",                   impact: "Drops OrderProcessor from Medium to Low risk, ensures order SLA compliance", priority: "medium" },
    { action: "Allow ProductCatalog cache to warm (4–6h) then validate miss rate < 10%",               impact: "Drops ProductCatalog from High to Low risk without intervention needed", priority: "low" },
  ],
  relatedIssues: [
    { service: "EcommerceAPI",     issueId: "demo-inc-001", severity: "Critical" },
    { service: "InventoryManager", issueId: "demo-inc-002", severity: "Critical" },
    { service: "PaymentService",   issueId: "demo-inc-003", severity: "Warning" },
    { service: "ProductCatalog",   issueId: "demo-inc-004", severity: "Warning" },
  ],
};
