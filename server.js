require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const session = require('express-session');
const cookieSession = require('cookie-session');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const path = require('path');
const db = require('./database');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Configuration
const PORT = process.env.PORT || 8080;
const SESSION_SECRET = process.env.SESSION_SECRET || 'secret-key-change-me';

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(cookieParser());

// Use cookie-based sessions (stateless) so session persists across instances.
// This stores a small signed session object in the client's cookie and
// works well for a single key like userId. We still keep express-session
// in package.json for local dev and other flows, but prefer cookie sessions
// in Cloud Run to avoid in-memory store issues.
app.set('trust proxy', 1);
const cookieSessionOptions = {
    name: 'session',
    keys: [SESSION_SECRET],
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    secure: (process.env.NODE_ENV === 'production'),
    sameSite: 'lax'
};
// Create the actual middleware instance and reuse it for Socket.IO handshakes
const cookieSessionMiddleware = cookieSession(cookieSessionOptions);
app.use(cookieSessionMiddleware);

// Provide the real middleware to Socket.IO so `socket.request.session` is populated
const sessionMiddleware = cookieSessionMiddleware;

// Auth Middleware: session-based only (reverted token/JWT fallbacks)
const requireAuth = (req, res, next) => {
    if (req.session && req.session.userId) {
        req.userId = req.session.userId;
        return next();
    }
    const wantsJson = req.xhr || req.path.startsWith('/api') || (req.headers.accept && req.headers.accept.indexOf('application/json') !== -1);
    if (wantsJson) return res.status(401).json({ error: 'Unauthorized' });
    res.redirect('/login');
};

// --- In-Memory State ---
// Map PC ID -> { socketId, status, connected }
// Only stores live connection state; PC details are fetched from DB on demand
let pcConnections = {}; 

async function startServer() {
    // Log masked DB env presence for debugging (do NOT print the secret itself)
    console.log('DB env:', {
        DB_USER: process.env.DB_USER,
        DB_DATABASE: process.env.DB_DATABASE,
        DB_PASSWORD_SET: !!process.env.DB_PASSWORD,
        DB_PASSWORD_LEN: process.env.DB_PASSWORD ? process.env.DB_PASSWORD.length : 0
    });
    try {
        const crypto = require('crypto');
        const pwd = process.env.DB_PASSWORD || '';
        console.log('  DB_PASSWORD_SHA256:', crypto.createHash('sha256').update(pwd).digest('hex'));
    } catch (e) {
        // ignore
    }

    // Attempt DB init but don't block startup indefinitely
    try {
        await Promise.race([
            db.initDb(),
            new Promise((resolve) => setTimeout(resolve, 10000))
        ]);
    } catch (err) {
        console.error('DB init error (ignored for startup):', err);
    }

    server.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}


const saltRounds = 10;

// --- Routes ---

app.get('/', (req, res) => {
    if (req.session.userId) {
        res.redirect('/dashboard');
    } else {
        res.render('home');
    }
});

app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        console.log('Login attempt for:', email);
        const { rows } = await db.query("SELECT * FROM users WHERE username = $1", [email]);
        const user = rows[0];
        console.log('  user found:', !!user);
        if (user && user.password) {
            console.log('  storedPasswordLooksHashed:', typeof user.password === 'string' && user.password.startsWith('$2'));
        }
        if (!user) {
            return res.render('login', { error: 'Invalid credentials' });
        }
        const matches = await bcrypt.compare(password, user.password);
        console.log('  password match:', matches);
        if (matches) {
            req.session.userId = user.id;
            res.redirect('/dashboard');
        } else {
            res.render('login', { error: 'Invalid credentials' });
        }
    } catch (err) {
        console.error(err);
        res.render('login', { error: 'An error occurred.' });
    }
});

// Token login for native clients: returns short-lived JWT
// token-login endpoint removed; session-based login only

app.get('/register', (req, res) => {
    res.render('register', { error: null });
});

app.post('/register', async (req, res) => {
    const { email, password } = req.body;

    try {
        const { rows } = await db.query("SELECT * FROM users WHERE username = $1", [email]);
        if (rows.length > 0) {
            return res.render('register', { error: 'User with that email already exists.' });
        }

        const hash = await bcrypt.hash(password, saltRounds);
        await db.query("INSERT INTO users (username, password) VALUES ($1, $2)", [email, hash]);
        res.redirect('/');
    } catch (err) {
        console.error(err);
        res.render('register', { error: 'An error occurred during registration.' });
    }
});

app.get('/logout', (req, res) => {
    try {
        // For cookie-session, clear by setting to null
        req.session = null;
    } catch (e) { /* ignore */ }
    try { res.clearCookie('authToken'); } catch (e) { /* ignore */ }
    res.redirect('/');
});

app.get('/dashboard', requireAuth, (req, res) => {
    res.render('dashboard');
});

// API to send commands
app.post('/api/command', requireAuth, async (req, res) => {
    const { id, command } = req.body; // command: 'lock' or 'unlock'
    
    const conn = pcConnections[id];
    if (conn && conn.connected && conn.socketId) {
        io.to(conn.socketId).emit('command', { action: command });
        // Log action
        try {
            await db.query("INSERT INTO audit_logs (pc_id, action) VALUES ($1, $2)", [id, command]);
            res.json({ success: true, message: `Sent ${command} to ${id}` });
        } catch (err) {
            console.error(err);
            res.status(500).json({ success: false, message: 'Failed to log command' });
        }
    } else {
        res.status(400).json({ success: false, message: 'PC is offline or unknown' });
    }
});

// API for block periods
app.get('/api/block-period', requireAuth, async (req, res) => {
    try {
        const userId = req.userId || (req.session && req.session.userId);
        const { rows } = await db.query("SELECT id, from_time as from, to_time as to, days FROM block_periods WHERE user_id = $1 ORDER BY id DESC", [userId]);
        rows.forEach(row => {
            try {
                row.days = JSON.parse(row.days || '[]');
            } catch (e) {
                row.days = [];
            }
        });
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load block periods.' });
    }
});

app.post('/api/block-period', requireAuth, async (req, res) => {
    const { from, to, days } = req.body;
    const daysJson = JSON.stringify(days);

    try {
        const userId = req.userId || (req.session && req.session.userId);
        const { rows } = await db.query("INSERT INTO block_periods (user_id, from_time, to_time, days) VALUES ($1, $2, $3, $4) RETURNING id", [userId, from, to, daysJson]);
        // Notify connected PCs for this user
        try { await notifyScheduleChangeForUser(userId); } catch (e) { console.warn('notifyScheduleChangeForUser failed', e); }
        res.json({ id: rows[0].id, from, to, days });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to save block period.' });
    }
});

app.delete('/api/block-period/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        const userId = req.userId || (req.session && req.session.userId);
        await db.query("DELETE FROM block_periods WHERE id = $1 AND user_id = $2", [id, userId]);
        try { await notifyScheduleChangeForUser(userId); } catch (e) { console.warn('notifyScheduleChangeForUser failed', e); }
        res.json({ success: true, message: 'Block period deleted.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete block period.' });
    }
});

app.put('/api/block-period/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    const { from, to, days } = req.body;
    const daysJson = JSON.stringify(days);

    try {
        const userId = req.userId || (req.session && req.session.userId);
        await db.query("UPDATE block_periods SET from_time = $1, to_time = $2, days = $3 WHERE id = $4 AND user_id = $5", [from, to, daysJson, id, userId]);
        try { await notifyScheduleChangeForUser(userId); } catch (e) { console.warn('notifyScheduleChangeForUser failed', e); }
        res.json({ success: true, message: 'Block period updated.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update block period.' });
    }
});

// Register a PC and associate it with the authenticated user (stores name and local IP)
// Only creates pc_settings entry if clientType is 'pc_app'
app.post('/api/register-pc', requireAuth, async (req, res) => {
    const { id, name, localIp, clientType } = req.body;
    if (!id) return res.status(400).json({ error: 'pc id required' });

    // Only register in pc_settings table if this is a PC app client
    if (clientType === 'pc_app') {
        const now = new Date();
        const query = `
            INSERT INTO pc_settings (pc_id, name, last_seen, owner_id, ip)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (pc_id)
            DO UPDATE SET name = EXCLUDED.name, last_seen = EXCLUDED.last_seen, owner_id = EXCLUDED.owner_id, ip = EXCLUDED.ip
        `;
        try {
            const userId = req.userId || (req.session && req.session.userId);
            await db.query(query, [id, name || id, now, userId, localIp || null]);
        } catch (err) {
            console.error("Error saving PC settings:", err);
            return res.status(500).json({ error: 'Failed to register PC' });
        }
    } else {
        // For web/Android clients, just acknowledge but don't create pc_settings
        const userId = req.userId || (req.session && req.session.userId);
        console.log(`Non-PC client (${clientType}) logged in as user ${userId}, skipping pc_settings registration`);
    }

    // Send current schedule to all clients (PC app or otherwise)
    try {
        const userId = req.userId || (req.session && req.session.userId);
        const { rows } = await db.query("SELECT id, from_time as from, to_time as to, days FROM block_periods WHERE user_id = $1 ORDER BY id DESC", [userId]);
        rows.forEach(row => { try { row.days = JSON.parse(row.days || '[]'); } catch(e){ row.days = []; } });
        
        // If it's a PC app and connected via socket, send schedule only if we have blocks
        const conn = pcConnections[id];
        if (clientType === 'pc_app' && conn && conn.connected && conn.socketId) {
            if (rows && rows.length > 0) {
                console.log(`Emitting schedule_update to PC ${id} after HTTP register (socket ${conn.socketId}), rows=${rows.length}`);
                io.to(conn.socketId).emit('schedule_update', rows);
            } else {
                console.log(`Not emitting empty schedule_update to PC ${id} after HTTP register (rows=0)`);
            }
        }
    } catch (e) {
        console.warn('Failed to send schedule to PC after registration:', e.message || e);
    }

    // Notify dashboards about updated PC list
    try { broadcastUpdate(); } catch (e) { console.warn('broadcastUpdate failed', e); }

    res.json({ success: true });
});

// API to list PCs belonging to the authenticated user
app.get('/api/pcs', requireAuth, async (req, res) => {
    try {
    const userId = req.userId || (req.session && req.session.userId);
    console.log(`/api/pcs called by userId=${userId}`);
    const { rows } = await db.query("SELECT * FROM pc_settings WHERE owner_id = $1", [userId]);
    console.log(`/api/pcs returned ${rows.length} rows for userId=${userId}`);

        const list = rows.map(row => {
            const conn = pcConnections[row.pc_id] || {};
            // Priority: 1) Valid in-memory status, 2) DB status, 3) Unknown
            let status = row.last_status || 'Unknown'; // Start with DB value
            if (conn.status && conn.status !== 'Unknown') {
                status = conn.status; // Override with in-memory if it's not 'Unknown'
            }
            
            return {
                id: row.pc_id,
                name: row.name,
                connected: conn.connected || false,
                socketId: conn.socketId || null,
                status: status,
                lastSeen: row.last_seen,
                lastStatusAt: row.last_status_at || null,
                ownerId: row.owner_id || null,
                ip: row.ip || null
            };
        });

        res.json(list);
    } catch (err) {
        const userId = req.userId || (req.session && req.session.userId);
        console.error('Failed to load PCs for user', userId, err);
        res.status(500).json({ error: 'Failed to load PCs.' });
    }
});

// Probe a PC for status: emits a status request to the PC and waits briefly for a response
app.get('/api/pc/:id/probe', requireAuth, async (req, res) => {
    const pcId = req.params.id;
    try {
        // verify ownership
        const { rows } = await db.query("SELECT owner_id FROM pc_settings WHERE pc_id = $1", [pcId]);
        const userId = req.userId || (req.session && req.session.userId);
        if (!rows || !rows[0] || rows[0].owner_id !== userId) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        let conn = pcConnections[pcId];
        // If we don't have a mapping, the PC may be reconnecting after a deploy.
        // Retry scanning active sockets for a short window (2s) before giving up.
        const scanTimeoutMs = 2000;
        const scanIntervalMs = 100;
        const scanStart = Date.now();
        let foundConn = !!(conn && conn.connected && conn.socketId);
        try {
            while (!foundConn && (Date.now() - scanStart) < scanTimeoutMs) {
                // If a `pc_status` event created/updated `pcConnections[pcId]`, pick it up immediately
                if (pcConnections[pcId] && pcConnections[pcId].socketId) {
                    conn = pcConnections[pcId];
                    foundConn = true;
                    break;
                }
                for (const [sid, sock] of io.sockets.sockets) {
                    try {
                        if (sock && sock.pcId === pcId) {
                            conn = pcConnections[pcId] = pcConnections[pcId] || {};
                            conn.connected = true;
                            conn.socketId = sid;
                            conn.status = conn.status || 'Unknown';
                            foundConn = true;
                            break;
                        }
                    } catch (e) { /* ignore per-socket errors */ }
                }
                if (!foundConn) await new Promise(r => setTimeout(r, scanIntervalMs));
            }
        } catch (e) {
            console.warn('Error scanning sockets during probe recovery', e);
        }

            if (!conn || !conn.connected || !conn.socketId) {
            // If we don't have an active socket mapping, attempt to return the
            // last-known persisted status from the DB (if available) so callers
            // can display a reasonable value instead of always failing.
            try {
                const { rows: persistRows } = await db.query("SELECT last_status, last_status_at FROM pc_settings WHERE pc_id = $1", [pcId]);
                if (persistRows && persistRows[0] && persistRows[0].last_status) {
                    return res.json({ status: persistRows[0].last_status, lastStatusAt: persistRows[0].last_status_at, stale: true });
                }
            } catch (e) {
                console.warn('Error reading last_status from DB during probe', e && e.message ? e.message : e);
            }

            // No persisted status available; return 503 so the client/UI can retry.
            return res.status(503).json({ error: 'PC is offline or not connected (may be reconnecting). Retry after a few seconds.', retryAfterSeconds: 5 });
        }

        const start = Date.now();
        console.log(`Probe start for pc ${pcId}: start=${start}, connSnapshot=`, Object.assign({}, conn));

        // Try fast-path: emit a status_request with a probeId and wait for a direct reply
        const sock = io.sockets.sockets.get(conn.socketId);
        const probeId = `${Date.now()}-${Math.random().toString(36).slice(2,9)}`;
        let replied = false;
        let replyPayload = null;

        if (sock) {
            try {
                // Listen once for status_reply from this socket
                const replyPromise = new Promise((resolve) => {
                    // Handler for explicit status_reply (fast-path)
                    const replyHandler = (payload) => {
                        try {
                            console.log(`status_reply received on fast-path from socket ${sock.id}:`, payload);
                            if (payload && payload.probeId === probeId) {
                                resolve({ status: payload.status, lastStatusAt: payload.lastStatusAt || Date.now() });
                            }
                        } catch (e) {
                            // ignore
                        }
                    };

                    // Handler for legacy/normal pc_status emissions coming from the client
                    const pcStatusHandler = (payload) => {
                        try {
                            // payload expected to be an object like { id, status }
                            if (payload && ((payload.id && payload.id === pcId) || payload.status)) {
                                resolve({ status: payload.status || conn.status || 'Unknown', lastStatusAt: Date.now() });
                            }
                        } catch (e) {
                            // ignore
                        }
                    };

                    sock.once('status_reply', replyHandler);
                    sock.once('pc_status', pcStatusHandler);
                    // safety: handlers are one-shot; Promise.race below will timeout if neither fires
                });

                // Emit the request containing probeId
                sock.emit('status_request', { reason: 'probe', probeId });
                console.log(`Emitted status_request (probeId=${probeId}) to socket ${conn.socketId} for pc ${pcId}`);

                // Wait for reply or timeout (3s)
                const timeoutMs = 3000;
                replyPayload = await Promise.race([
                    replyPromise,
                    new Promise(resolve => setTimeout(() => resolve(null), timeoutMs))
                ]);

                if (replyPayload) {
                    replied = true;
                    // normalize into our conn state
                    conn.status = replyPayload.status || conn.status || 'Unknown';
                    conn.lastStatusAt = replyPayload.lastStatusAt || Date.now();
                }
            } catch (e) {
                console.warn('Fast-path probe reply handling failed', e);
            }
        }

        // If fast-path didn't return a reply, fall back to polling stored lastStatusAt (legacy behavior)
        if (!replied) {
            const timeoutMs = 3000;
            const intervalMs = 100;
            let elapsed = 0;
            while (elapsed < timeoutMs) {
                const last = conn.lastStatusAt || 0;
                if (last >= start) break;
                await new Promise(r => setTimeout(r, intervalMs));
                elapsed += intervalMs;
            }
        }

        console.log(`Probe finished for pc ${pcId}: start=${start}, finalLast=${conn.lastStatusAt || 0}, finalStatus=${conn.status || 'Unknown'}`);

        return res.json({ status: conn.status || 'Unknown', lastStatusAt: conn.lastStatusAt || null, probed: true });
    } catch (err) {
        console.error('Probe failed for pc', pcId, err);
        res.status(500).json({ error: 'Probe failed' });
    }
});

// Notify connected PCs for a given user about schedule changes
async function notifyScheduleChangeForUser(userId) {
    try {
        const { rows } = await db.query("SELECT id, from_time as from, to_time as to, days FROM block_periods WHERE user_id = $1 ORDER BY id DESC", [userId]);
        rows.forEach(row => { try { row.days = JSON.parse(row.days || '[]'); } catch(e){ row.days = []; } });

        const pcs = await db.query("SELECT pc_id FROM pc_settings WHERE owner_id = $1", [userId]);
        for (const r of pcs.rows) {
            const pcId = r.pc_id;
            const conn = pcConnections[pcId];
            if (conn && conn.connected && conn.socketId) {
                if (rows && rows.length > 0) {
                    console.log(`Emitting schedule_update to pc ${pcId} (socket ${conn.socketId}), rows=${rows.length}`);
                    io.to(conn.socketId).emit('schedule_update', rows);
                } else {
                    console.log(`Not emitting empty schedule_update to pc ${pcId} (socket ${conn.socketId})`);
                }
            }
        }
        // Also notify any dashboard clients for this user (only emit if there are blocks)
        try {
            if (rows && rows.length > 0) {
                io.to(`dashboard:${userId}`).emit('schedule_update', rows);
            } else {
                console.log(`Not emitting empty schedule_update to dashboard:${userId}`);
            }
        } catch (e) {
            console.warn('Failed to emit schedule_update to dashboard room', e);
        }
    } catch (err) {
        console.error('Failed to notify schedule change for user', userId, err);
    }
}


// --- Socket.IO Logic ---
// Make session available on Socket.IO sockets
const wrap = middleware => (socket, next) => middleware(socket.request, {}, next);
io.use(wrap(sessionMiddleware));

// Socket.IO uses the existing session middleware only. Token-based handshake
// handling was removed to revert to session-only behavior.
// (If a persistent session store is later added, Socket.IO will use it via
// the wrapped session middleware above.)

io.on('connection', (socket) => {
    console.log('New connection:', socket.id);
    try {
        const sess = socket.request && socket.request.session;
        console.log('Connection debug:', { socketId: socket.id, sessionUserId: sess && sess.userId, cookiePresent: !!(socket.request && socket.request.headers && socket.request.headers.cookie) });
        try {
            const transport = socket && socket.conn && socket.conn.transport && socket.conn.transport.name;
            const hs = socket.handshake || {};
            console.log('Connection transport/handshake:', { transport: transport || 'unknown', query: hs.query || null, headersPresent: !!hs.headers });
        } catch (e) {
            console.warn('Failed to log handshake details', e && e.message ? e.message : e);
        }
    } catch (e) {
        console.warn('Connection debug failed to read session info', e && e.message ? e.message : e);
    }

    // Initial handshake or 'register' event determines if it's a PC or Dashboard
    

    socket.on('identify', async (data) => {
        console.log('Identify handler called for socket', socket.id, 'payload=', data);
        if (data.type === 'dashboard') {
            // Determine user id from session only (token fallback removed)
            const sess = socket.request && socket.request.session;
            const userId = sess && sess.userId;

            if (userId) {
                console.log(`Identify debug: resolved dashboard userId=${userId} for socket ${socket.id}`);
                socket.join(`dashboard:${userId}`);
                // Send initial state for that user only
                try {
                    const { rows } = await db.query("SELECT * FROM pc_settings WHERE owner_id = $1", [userId]);
                    const list = rows.map(row => {
                        const conn = pcConnections[row.pc_id] || {};
                        // Priority: 1) Valid in-memory status, 2) DB status, 3) Unknown
                        let status = row.last_status || 'Unknown';
                        if (conn.status && conn.status !== 'Unknown') {
                            status = conn.status;
                        }
                        return {
                            id: row.pc_id,
                            name: row.name,
                            connected: conn.connected || false,
                            socketId: conn.socketId || null,
                            status: status,
                            lastSeen: row.last_seen,
                            lastStatusAt: row.last_status_at || null,
                            ownerId: row.owner_id || null,
                            ip: row.ip || null
                        };
                    });
                    socket.emit('pc_update', list);
                } catch (e) {
                    console.error('Failed to send initial PC list to dashboard user', userId, e);
                    socket.emit('pc_update', []);
                }
            } else {
                // No session user id - join a non-authenticated dashboard room if desired
                socket.join('dashboard:anon');
                socket.emit('pc_update', []);
            }
        }
    });

    socket.on('register_pc', async (data) => {
        const { id, name, clientType, localIp } = data;
        console.log(`Client Registered: ${id}, type: ${clientType || 'unknown'}`);
        
        // Only register in pc_settings and pcConnections if this is a PC app
        if (clientType === 'pc_app') {
            // Ensure connection state object exists and merge rather than
            // blindly replace. This preserves any status set earlier by a
            // pc_status event (which may arrive before register_pc).
            if (!pcConnections[id]) pcConnections[id] = {};
            pcConnections[id].connected = true;
            pcConnections[id].socketId = socket.id;
            
            // If we don't have a status in memory, try to load it from DB
            // DON'T default to 'Unknown' on register - let broadcastUpdate use DB value
            if (!pcConnections[id].status) {
                try {
                    const { rows } = await db.query("SELECT last_status FROM pc_settings WHERE pc_id = $1", [id]);
                    if (rows && rows[0] && rows[0].last_status) {
                        pcConnections[id].status = rows[0].last_status;
                        console.log(`Restored status from DB for ${id}: ${rows[0].last_status}`);
                    }
                    // If DB has no status, leave in-memory undefined so broadcastUpdate uses DB fallback
                } catch (err) {
                    console.warn(`Could not load last_status from DB for ${id}:`, err);
                    // On error, also leave undefined rather than forcing 'Unknown'
                }
            }

            // Attach pc id to the socket for easier lookup on disconnect
            try { socket.pcId = id; } catch (e) { /* ignore */ }

            // Update DB (include IP if provided)
            // First, try to find existing PC with same name (to avoid duplicates on reinstall)
            try {
                // Get the owner_id for this socket's session (if authenticated)
                let ownerId = null;
                try {
                    if (socket.request && socket.request.session && socket.request.session.userId) {
                        ownerId = socket.request.session.userId;
                    }
                } catch (e) { /* ignore */ }

                // Check if there's an existing PC with this name
                // PC apps don't have authenticated sessions, so we match by name only
                // and preserve the existing owner_id if found
                let existingPcId = null;
                let existingOwnerId = null;
                
                console.log(`🔍 register_pc: Checking for existing PC with name="${name}", new_id=${id}`);
                
                if (name) {
                    // Always search by name only, ordered by most recent to pick the "active" one
                    const query = "SELECT pc_id, owner_id FROM pc_settings WHERE name = $1 ORDER BY last_seen DESC LIMIT 1";
                    const params = [name];
                    
                    const { rows } = await db.query(query, params);
                    console.log(`🔍 Search query returned ${rows ? rows.length : 0} results`);
                    
                    if (rows && rows.length > 0) {
                        existingPcId = rows[0].pc_id;
                        existingOwnerId = rows[0].owner_id;
                        console.log(`✅ Found existing PC: name="${name}", pc_id=${existingPcId}, owner_id=${existingOwnerId}. Will merge new_id=${id} into existing.`);
                    } else {
                        console.log(`❌ No existing PC found with name="${name}". Will create new entry with id=${id}`);
                    }
                }
                
                // If we found an existing PC, preserve its owner_id
                if (existingPcId && existingOwnerId) {
                    ownerId = existingOwnerId;
                    console.log(`📌 Preserving owner_id=${ownerId} from existing PC`);
                }

                // Use the existing pc_id if found, otherwise use the new id
                const finalPcId = existingPcId || id;
                console.log(`💾 finalPcId=${finalPcId}, ownerId=${ownerId}, name=${name || id}`);

                // Upsert the PC settings
                const query = `
                    INSERT INTO pc_settings (pc_id, name, last_seen, ip, owner_id) 
                    VALUES ($1, $2, $3, $4, $5) 
                    ON CONFLICT (pc_id) 
                    DO UPDATE SET name = EXCLUDED.name, last_seen = EXCLUDED.last_seen, ip = COALESCE(EXCLUDED.ip, pc_settings.ip), owner_id = COALESCE(EXCLUDED.owner_id, pc_settings.owner_id)
                `;
                const result = await db.query(query, [finalPcId, name || id, new Date(), localIp || null, ownerId]);
                console.log(`💾 Upsert complete: rowCount=${result.rowCount}, finalPcId=${finalPcId}`);

                // If we merged into an existing PC, update the in-memory connections to use the old pc_id
                if (existingPcId && existingPcId !== id) {
                    console.log(`Merging new pc_id ${id} into existing ${existingPcId} in memory`);
                    // Move connection state from new id to existing id
                    pcConnections[existingPcId] = pcConnections[id];
                    delete pcConnections[id];
                    socket.pcId = existingPcId;
                    // Use existingPcId for the rest of this handler
                    data.id = existingPcId;
                }
            } catch (err) {
                console.error("Error saving PC settings:", err);
            }
        } else {
            console.log(`Non-PC client (${clientType}) connected, skipping pc_settings registration`);
            // For web/Android clients, we don't add to pcConnections or pc_settings
            return;
        }

        // Try to read owner from DB and send schedule if available
        const pcId = data.id; // Use potentially updated id after merge
        try {
            const { rows: ownerRows } = await db.query("SELECT owner_id FROM pc_settings WHERE pc_id = $1", [pcId]);
            if (ownerRows && ownerRows[0] && ownerRows[0].owner_id) {
                const ownerId = ownerRows[0].owner_id;
                // If we have an owner and there are saved block periods, push them to this PC now
                try {
                    const { rows: periods } = await db.query("SELECT id, from_time as from, to_time as to, days FROM block_periods WHERE user_id = $1 ORDER BY id DESC", [ownerId]);
                    periods.forEach(r => { try { r.days = JSON.parse(r.days || '[]'); } catch(e){ r.days = []; } });
                    const conn = pcConnections[pcId];
                    if (conn && conn.connected && conn.socketId) {
                        console.log(`Emitting schedule_update to PC ${pcId} on socket register (socket ${conn.socketId}), rows=${periods.length}`);
                        io.to(conn.socketId).emit('schedule_update', periods);
                    }
                } catch (e) {
                    console.warn('Failed to push saved schedule to PC on socket register', e.message || e);
                }
            }
        } catch (e) {
            console.warn('Failed to read owner for PC on socket register', e.message || e);
        }

        // Don't broadcast here - wait for pc_status to provide actual status
        // Broadcasting now would send "Unknown" since pc_status hasn't arrived yet
    });

    // Also listen for any explicit status_reply events on this socket for debugging
    socket.on('status_reply', (payload) => {
        try {
            console.log(`status_reply received (global): socket=${socket.id}, payload=`, payload);
        } catch (e) {
            console.warn('Failed to log global status_reply', e && e.message ? e.message : e);
        }
    });

    socket.on('pc_status', async (data) => {
        try {
            console.log(`🔵 pc_status event received on socket ${socket.id}`, { rawData: JSON.stringify(data) });
            
            // Prefer explicit id sent by the client (helps when register_pc hasn't been processed yet)
            const incomingId = (data && data.id) ? data.id : (Object.keys(pcConnections).find(k => pcConnections[k].socketId === socket.id) || socket.pcId);
            if (!incomingId) {
                console.log(`❌ pc_status received but no incomingId could be resolved (socket=${socket.id})`, { data });
                return;
            }

            const now = Date.now();
            console.log(`✅ pc_status received: pcId=${incomingId}, socket=${socket.id}, status=${data && data.status}, now=${now}`);

            // Ensure mapping exists and associate this socket with the pc id
            if (!pcConnections[incomingId]) pcConnections[incomingId] = {};
            const prev = Object.assign({}, pcConnections[incomingId]);
            pcConnections[incomingId].status = data && data.status ? data.status : pcConnections[incomingId].status || 'Unknown';
            pcConnections[incomingId].lastStatusAt = now;
            pcConnections[incomingId].connected = true;
            pcConnections[incomingId].socketId = socket.id;

            // Attach pcId to socket for future lookups
            try { socket.pcId = incomingId; } catch (e) { /* ignore */ }

            console.log(`📊 pc_status mapping updated for ${incomingId}`, { prev, nowState: pcConnections[incomingId] });

            // Persist last known status to DB so probes can read authoritative state
            try {
                console.log(`💾 Updating database: pc_id=${incomingId}, status=${pcConnections[incomingId].status}`);
                const result = await db.query("UPDATE pc_settings SET last_status = $1, last_status_at = $2 WHERE pc_id = $3", [pcConnections[incomingId].status, new Date(pcConnections[incomingId].lastStatusAt), incomingId]);
                console.log(`✅ Database updated for ${incomingId}, rowCount=${result.rowCount}`);
            } catch (err) {
                console.error('❌ Error persisting pc_status to DB', err && err.message ? err.message : err);
            }

            await broadcastUpdate();
            console.log(`📡 broadcastUpdate completed for ${incomingId}`);
        } catch (err) {
            console.error('❌ Error handling pc_status', err);
        }
    });

    socket.on('disconnect', async () => {
        const pcId = Object.keys(pcConnections).find(k => pcConnections[k].socketId === socket.id) || socket.pcId;
        if (pcId) {
            console.log(`PC App Disconnected: ${pcId}`);
            if (!pcConnections[pcId]) pcConnections[pcId] = {};
            pcConnections[pcId].connected = false;
            pcConnections[pcId].socketId = null;
             // Update DB last seen
            try {
                await db.query("UPDATE pc_settings SET last_seen = $1 WHERE pc_id = $2", [new Date(), pcId]);
            } catch (err) {
                console.error("Error updating last_seen for PC:", err);
            }

            await broadcastUpdate();
        } else {
            console.log(`Client disconnected (non-PC or unregistered)`);
        }
    });
});

async function broadcastUpdate() {
    try {
        // Query DB for PC details and emit per-owner pc_update lists to dashboard rooms
        const { rows } = await db.query("SELECT * FROM pc_settings");

        // Build per-owner mapping
        const byOwner = {};
        rows.forEach(row => {
            const owner = row.owner_id || null;
            if (!owner) return; // skip unowned
            if (!byOwner[owner]) byOwner[owner] = [];
            const conn = pcConnections[row.pc_id] || {};
            // Priority: 1) Valid in-memory status, 2) DB status, 3) Unknown
            let status = row.last_status || 'Unknown'; // Start with DB value
            if (conn.status && conn.status !== 'Unknown') {
                status = conn.status; // Override with in-memory if it's not 'Unknown'
            }
            byOwner[owner].push({
                id: row.pc_id,
                name: row.name,
                connected: conn.connected || false,
                socketId: conn.socketId || null,
                status: status,
                lastSeen: row.last_seen,
                lastStatusAt: row.last_status_at || null,
                ownerId: row.owner_id || null,
                ip: row.ip || null
            });
        });

        // Emit to each owner's dashboard room
        for (const ownerIdStr of Object.keys(byOwner)) {
            const list = byOwner[ownerIdStr];
            console.log(`Emitting pc_update to dashboard:${ownerIdStr}, pcs=${list.length}`);
            // Log the actual payload for debugging
            list.forEach(pc => {
                console.log(`  PC: ${pc.id}, status="${pc.status}", lastStatusAt=${pc.lastStatusAt}, dbLastStatus from row`);
            });
            io.to(`dashboard:${ownerIdStr}`).emit('pc_update', list);
        }
    } catch (e) {
        console.warn('broadcastUpdate emit failed', e);
    }
}

startServer();
