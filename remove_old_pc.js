const fs = require('fs');
const path = require('path');
const db = require('./database');

const OLD_PC_ID = 'b6a8dace-ba0d-4285-9f63-2baf910e7938';

async function main() {
  try {
    console.log('Initializing DB...');
    await db.initDb();
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);

    console.log('Reading pc_settings row for', OLD_PC_ID);
    const { rows: pcRows } = await db.query('SELECT * FROM pc_settings WHERE pc_id = $1', [OLD_PC_ID]);
    fs.writeFileSync(path.join(backupDir, `pc_settings_${OLD_PC_ID}.json`), JSON.stringify(pcRows, null, 2));

    console.log('Reading audit_logs rows for', OLD_PC_ID);
    const { rows: auditRows } = await db.query('SELECT * FROM audit_logs WHERE pc_id = $1 ORDER BY id ASC', [OLD_PC_ID]);
    fs.writeFileSync(path.join(backupDir, `audit_logs_${OLD_PC_ID}.json`), JSON.stringify(auditRows, null, 2));

    if (!pcRows || pcRows.length === 0) {
      console.log('No pc_settings row found for', OLD_PC_ID);
    } else {
      console.log('Deleting pc_settings row for', OLD_PC_ID);
      await db.query('DELETE FROM pc_settings WHERE pc_id = $1', [OLD_PC_ID]);
      console.log('Delete completed.');
    }

    // Close pool if available
    try {
      const pool = db.getPool && db.getPool();
      if (pool && typeof pool.end === 'function') {
        await pool.end();
      }
    } catch (e) { /* ignore */ }

    console.log('Backup files written to:', backupDir);
    console.log('Done.');
  } catch (err) {
    console.error('Error during remove_old_pc:', err);
    process.exitCode = 2;
  }
}

main();
