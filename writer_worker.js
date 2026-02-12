const { PubSub } = require('@google-cloud/pubsub');
const db = require('./database');

// Config
const SUBSCRIPTION_NAME = process.env.PUBSUB_SUBSCRIPTION || process.env.PUBSUB_SUB || null;
const BATCH_FLUSH_MS = parseInt(process.env.WORKER_BATCH_FLUSH_MS || '5000', 10);
const MAX_BATCH = parseInt(process.env.WORKER_MAX_BATCH || '500', 10);

if (!SUBSCRIPTION_NAME) {
    console.error('PUBSUB_SUBSCRIPTION not set. Exiting.');
    process.exit(1);
}

let pubsub;
let sub;
let buffer = [];

async function flushBuffer() {
    if (buffer.length === 0) return;
    const entriesRaw = buffer.splice(0, buffer.length);
    // If DB pool isn't ready, requeue and skip
    if (!db.getPool()) {
        console.warn('DB pool not ready, requeueing', entriesRaw.length);
        buffer = entriesRaw.concat(buffer);
        return;
    }

    // Deduplicate entries by pcId, keep the most recent lastStatusAt
    const dedup = new Map();
    for (const item of entriesRaw) {
        const key = item.pcId;
        const prev = dedup.get(key);
        if (!prev || (item.lastStatusAt && item.lastStatusAt > prev.lastStatusAt)) {
            dedup.set(key, item);
        }
    }
    const entries = Array.from(dedup.values());
    // Build bulk upsert
    const valuesSql = [];
    const params = [];
    let idx = 1;
    for (const item of entries) {
        // item: { pcId, status, lastStatusAt }
        valuesSql.push(`($${idx++}, $${idx++}, $${idx++})`);
        params.push(item.pcId, item.status, new Date(item.lastStatusAt));
    }
    const sql = `INSERT INTO pc_settings (pc_id, last_status, last_status_at) VALUES ${valuesSql.join(',')} ON CONFLICT (pc_id) DO UPDATE SET last_status = EXCLUDED.last_status, last_status_at = EXCLUDED.last_status_at`;
    try {
        await db.query(sql, params);
        console.log(`Batched persisted ${entries.length} pc_status updates (worker)`);
    } catch (e) {
        console.error('Worker bulk persist failed:', e && e.message ? e.message : e);
        // On failure, requeue items at front with a small delay to avoid tight loop
        buffer = entries.concat(buffer);
        await new Promise(r => setTimeout(r, 500));
    }
}

async function setup() {
    try {
        await db.initDb();
    } catch (e) {
        console.error('Database initialization failed:', e && e.message ? e.message : e);
        // proceed — db.initDb logs errors but we try to continue for debugging
    }

    pubsub = new PubSub();
    sub = pubsub.subscription(SUBSCRIPTION_NAME, { flowControl: { maxMessages: 1000 } });

    // Periodic flush
    setInterval(() => {
        try { flushBuffer(); } catch (e) { console.error(e); }
    }, BATCH_FLUSH_MS);

    // Message handler
    sub.on('message', async (message) => {
        try {
            const payload = JSON.parse(message.data.toString());
            // accept either { pcId, status, lastStatusAt } or { id, status, ts }
            const pcId = payload.pcId || payload.id;
            const status = payload.status || payload.s;
            const lastStatusAt = payload.lastStatusAt || payload.ts || Date.now();
            if (pcId && status) {
                buffer.push({ pcId, status, lastStatusAt });
                if (buffer.length >= MAX_BATCH) {
                    await flushBuffer();
                }
            }
            message.ack();
        } catch (e) {
            console.error('Failed to handle message', e && e.message ? e.message : e);
            // Nack so it can be retried
            try { message.nack(); } catch (err) { console.error('nack failed', err); }
        }
    });

    sub.on('error', (err) => {
        console.error('Subscription error', err && err.message ? err.message : err);
    });

    console.log('Writer worker started, listening on subscription', SUBSCRIPTION_NAME);

    // Minimal HTTP server so Cloud Run considers the container healthy
    const http = require('http');
    const PORT = process.env.PORT || 8080;
    http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
    }).listen(PORT, () => console.log(`Writer worker HTTP health check listening on ${PORT}`));

    // Graceful shutdown: flush buffer before exit
    const shutdown = async () => {
        console.log('Shutting down worker, flushing buffer...');
        try { await flushBuffer(); } catch (e) { console.error('Flush on shutdown failed', e); }
        process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

setup();
