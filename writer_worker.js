const { PubSub } = require('@google-cloud/pubsub');
const db = require('./database');

// Config
const SUBSCRIPTION_NAME = process.env.PUBSUB_SUBSCRIPTION || process.env.PUBSUB_SUB || null;
const DLQ_TOPIC = process.env.PUBSUB_DLQ_TOPIC || null;
const BATCH_FLUSH_MS = parseInt(process.env.WORKER_BATCH_FLUSH_MS || '3000', 10);
const MAX_BATCH = parseInt(process.env.WORKER_MAX_BATCH || '100', 10);
const MAX_RETRY = parseInt(process.env.WORKER_MAX_RETRY || '4', 10);
const BACKOFF_BASE_MS = parseInt(process.env.WORKER_BACKOFF_BASE_MS || '200', 10);

if (!SUBSCRIPTION_NAME) {
    console.error('PUBSUB_SUBSCRIPTION not set. Exiting.');
    process.exit(1);
}

let pubsub;
let sub;
let buffer = [];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function flushBuffer() {
    if (buffer.length === 0) return;
    const entriesRaw = buffer.splice(0, buffer.length);
    // If DB pool isn't ready, requeue and skip
    if (!db.getPool()) {
        console.warn('DB pool not ready, requeueing', entriesRaw.length);
        buffer = entriesRaw.concat(buffer);
        return;
    }

    // Deduplicate entries by pcId, keep most recent; collect messages for ack
    const dedup = new Map();
    const ackMap = new Map();
    for (const item of entriesRaw) {
        const key = item.payload && (item.payload.pcId || item.payload.id);
        if (!key) continue;
        const prev = dedup.get(key);
        if (!prev || (item.payload && item.payload.lastStatusAt && item.payload.lastStatusAt > prev.payload.lastStatusAt)) {
            // move previous message into ackMap (older one can be acked)
            if (prev && prev.message) {
                // ack the older one since it's superseded
                try { prev.message.ack(); } catch (e) { /* ignore */ }
            }
            dedup.set(key, item);
            ackMap.set(key, item.message);
        } else {
            // superseded entry - ack immediately
            try { item.message.ack(); } catch (e) { /* ignore */ }
        }
    }

    const entries = Array.from(dedup.values());
    if (entries.length === 0) return;

    // Build bulk upsert
    const valuesSql = [];
    const params = [];
    let idx = 1;
    for (const item of entries) {
        const payload = item.payload;
        const pcId = payload.pcId || payload.id;
        const status = payload.status || payload.s;
        const at = payload.lastStatusAt || payload.ts || Date.now();
        valuesSql.push(`($${idx++}, $${idx++}, $${idx++})`);
        params.push(pcId, status, new Date(at));
    }
    const sql = `INSERT INTO pc_settings (pc_id, last_status, last_status_at) VALUES ${valuesSql.join(',')} ON CONFLICT (pc_id) DO UPDATE SET last_status = EXCLUDED.last_status, last_status_at = EXCLUDED.last_status_at`;

    // Attempt with retries/backoff
    let attempt = 0;
    while (attempt <= MAX_RETRY) {
        try {
            await db.query(sql, params);
            console.log(`Batched persisted ${entries.length} pc_status updates (worker)`);
            // ack all processed messages
            for (const item of entries) {
                try { item.message.ack(); } catch (e) { /* ignore */ }
            }
            return;
        } catch (e) {
            attempt++;
            const msg = e && e.message ? e.message : String(e);
            console.error('Worker bulk persist failed:', msg, `attempt=${attempt}/${MAX_RETRY}`);
            if (attempt > MAX_RETRY) {
                // Give up on these entries: push to DLQ if configured, otherwise nack to allow Pub/Sub retry
                if (DLQ_TOPIC && global.__pubsub) {
                    try {
                        const topic = global.__pubsub.topic(DLQ_TOPIC);
                        for (const item of entries) {
                            try { topic.publishMessage({ json: item.payload }); } catch (err) { console.error('Failed to publish to DLQ', err); }
                            try { item.message.ack(); } catch (err) { /* ignore */ }
                        }
                        console.warn('Published failed entries to DLQ and acked originals');
                    } catch (err) {
                        console.error('DLQ publish overall failed', err);
                        for (const item of entries) {
                            try { item.message.nack(); } catch (err2) { /* ignore */ }
                        }
                    }
                } else {
                    // Nack originals to let Pub/Sub redeliver per subscription policy
                    for (const item of entries) {
                        try { item.message.nack(); } catch (err) { /* ignore */ }
                    }
                }
                return;
            }
            // exponential backoff
            const backoff = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
            await sleep(backoff);
            continue;
        }
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
    const MAX_MESSAGES = parseInt(process.env.SUBSCRIPTION_MAX_MESSAGES || '100', 10);
    sub = pubsub.subscription(SUBSCRIPTION_NAME, { flowControl: { maxMessages: MAX_MESSAGES } });

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
