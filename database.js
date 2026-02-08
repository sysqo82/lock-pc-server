const { Pool } = require('pg');
const { Connector } = require('@google-cloud/cloud-sql-connector');

// Treat as GCP runtime if NODE_ENV=production or if Cloud Run / Cloud SQL envs are present
const isGcp = process.env.NODE_ENV === 'production' || !!process.env.K_SERVICE || (process.env.DB_HOST && process.env.DB_HOST.startsWith('/cloudsql'));
const INSTANCE_CONNECTION_NAME = process.env.INSTANCE_CONNECTION_NAME || 'lock-pc-server:us-central1:lock-pc-instance';

let pool;

async function initDb() {
    try {
        const connector = new Connector();

        // Helper to add a short timeout so the connector doesn't hang indefinitely
        const withTimeout = (p, ms) => Promise.race([
            p,
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
        ]);

        const ipType = process.env.DB_IP_TYPE || (isGcp ? 'PRIVATE' : 'PUBLIC');
        console.log('Using Cloud SQL connector ipType:', ipType);

        const clientOpts = await withTimeout(connector.getOptions({
            instanceConnectionName: INSTANCE_CONNECTION_NAME,
            ipType,
        }), 15000);

        pool = new Pool({
            ...clientOpts,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD ? process.env.DB_PASSWORD.trim() : undefined,
            database: process.env.DB_DATABASE,
        });

        // Test the connection (short timeout)
        const testConnect = async () => {
            const c = await pool.connect();
            c.release();
        };
        await withTimeout(testConnect(), 10000);
        console.log('Successfully connected to the database!');

        await pool.query(`CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE,
            password TEXT
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS audit_logs (
            id SERIAL PRIMARY KEY,
            pc_id TEXT,
            action TEXT,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        
        await pool.query(`CREATE TABLE IF NOT EXISTS pc_settings (
            pc_id TEXT PRIMARY KEY,
            name TEXT,
            last_seen TIMESTAMP
        )`);

        // Add owner and ip columns if they don't exist (for newer features)
        try {
            await pool.query(`ALTER TABLE pc_settings ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES users(id)`);
            await pool.query(`ALTER TABLE pc_settings ADD COLUMN IF NOT EXISTS ip TEXT`);
            // Persist last known status and timestamp for probes to read even if socket state is lost
            await pool.query(`ALTER TABLE pc_settings ADD COLUMN IF NOT EXISTS last_status TEXT`);
            await pool.query(`ALTER TABLE pc_settings ADD COLUMN IF NOT EXISTS last_status_at TIMESTAMP`);
        } catch (e) {
            console.warn('Could not alter pc_settings to add owner/ip columns:', e.message || e);
        }

        await pool.query(`CREATE TABLE IF NOT EXISTS block_periods (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id),
            from_time TEXT,
            to_time TEXT,
            days TEXT
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS reminders (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id),
            title TEXT,
            time TEXT,
            days TEXT
        )`);

        console.log('Database tables created or already exist.');
    } catch (err) {
        console.error('Error initializing database', err);
        // Do NOT exit the process here so the container can start for debugging
        // The server will log database errors on runtime queries instead.
        return;
    }
}


module.exports = {
  query: (text, params) => pool.query(text, params),
  getPool: () => pool,
  initDb
};
