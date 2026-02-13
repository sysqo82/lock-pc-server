# Deployment & Cost Reduction Recommendations

This file collects concrete, actionable steps to reduce Cloud Run and Cloud SQL costs for the `lock-pc-server` service.

## 1) Cloud Run tuning (quick wins)

- Deploy with controlled concurrency and instance limits. Example command:

```bash
gcloud run deploy lock-pc-server \
  --image gcr.io/PROJECT/lock-pc-server:latest \
  --region us-central1 \
  --platform managed \
  --concurrency 80 \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 2 \
  --max-instances 50 \
  --allow-unauthenticated \
  --set-env-vars DB_POOL_MAX=5,PC_STATUS_PERSIST_MS=30000,BROADCAST_DEBOUNCE_MS=1000
```

- Why: increase `concurrency` so fewer instances handle the same throughput (reduces memory-seconds and CPU-seconds). Cap `max-instances` to prevent runaway scaling. Keep a few `min-instances` to reduce cold start churn.

## 2) Environment variables (important defaults)

- `DB_POOL_MAX=5` — limits connections per Cloud Run instance. Tune to `max_instances * DB_POOL_MAX` <= allowed Cloud SQL connections.
- `PC_STATUS_PERSIST_MS=30000` — only persist status every 30s if unchanged.
- `BROADCAST_DEBOUNCE_MS=1000` — coalesce frequent broadcasts within 1s.

Set these in Cloud Run or CI/CD.

## 3) Connection pooling (PgBouncer) — recommended if you hit connection limits

- Problem: many Cloud Run instances each opening multiple DB connections can exhaust Cloud SQL capacity and cause connection churn.
- Options:
  - Run PgBouncer as a separate small service (Cloud Run or GKE) inside the same VPC and point app `PGHOST` to PgBouncer. Use Serverless VPC Connector for Cloud Run.
  - Run PgBouncer on a small Compute Engine instance or small GKE node.

- Basic plan (Cloud Run PgBouncer):
  1. Deploy PgBouncer container (official images exist) to Cloud Run with Serverless VPC Connector and private IP to Cloud SQL.
  2. Configure PgBouncer to pool with `pool_mode = transaction`, `max_client_conn` large, and a small number of `default_pool_size` per pgbouncer process.
  3. Point `database.js` pool to PgBouncer host:port and reduce `DB_POOL_MAX` on the app to a low number (1–2).

## 4) Caching (fast ROI)

- Use Cloud Memorystore (Redis) or in-process TTL caching for frequently-read items (block_periods, reminders, pc_settings lookups). This can eliminate repeated DB reads.
- Example approach:
  - Cache per-user `block_periods` and `reminders` for 30–120s.
  - Invalidate cached data when writing (e.g., after `/api/block-period` writes, clear the cache for that user and then schedule a push).

## 5) App-level changes we already applied

- Reduced frequent full-table `SELECT * FROM pc_settings` scans and added per-owner payload caching to avoid identical emits.
- Debounced broadcasts and reduced DB writes for frequent `pc_status` events.
- Added PG pool tuning (env `DB_POOL_MAX`) to reduce connections per instance.

## 6) Monitoring & validation

- Enable Cloud Monitoring dashboards for:
  - Cloud Run: CPU, memory, request count, instance count, concurrency per instance.
  - Cloud SQL: active connections, CPU, memory, slow queries.
  - Instrument app to log DB queries/sec and pool usage.

- After deploying the above changes, validate using a short load test (e.g., `client_simulator.js`) and compare:
  - Cloud Run instance count and memory-seconds before/after
  - Cloud SQL connection count and query/sec before/after

## 7) Next steps I can take for you

- Generate an exact Cloud Run revision config with tuned `concurrency`, `memory`, and `maxInstances` using your current traffic metrics (if you share avg/peak RPS and latency targets).
- Create a small `pgbouncer` deployment manifest or Docker setup tuned for Cloud SQL.
- Add optional Redis integration in the code to cache `block_periods` and `reminders` with invalidation.

---
Be happy to implement any of the next steps above — tell me which one and I'll proceed.
