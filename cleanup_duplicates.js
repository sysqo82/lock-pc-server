// Cleanup script to remove duplicate POOKY-PC entries
// Keeps only the most recently seen entry for each PC name

require('dotenv').config();
const db = require('./database');

async function cleanupDuplicates() {
    try {
        await db.initDb();
        console.log('Database initialized');

        // Find all PCs grouped by name
        const { rows: pcs } = await db.query(`
            SELECT pc_id, name, last_seen, owner_id
            FROM pc_settings
            WHERE name = 'POOKY-PC'
            ORDER BY last_seen DESC
        `);

        console.log(`\nFound ${pcs.length} POOKY-PC entries:`);
        pcs.forEach((pc, i) => {
            console.log(`  ${i + 1}. ${pc.pc_id} - last_seen: ${pc.last_seen} - owner: ${pc.owner_id}`);
        });

        if (pcs.length <= 1) {
            console.log('\nNo duplicates to clean up.');
            process.exit(0);
        }

        // Keep the most recent one, delete the rest
        const keepId = pcs[0].pc_id;
        const deleteIds = pcs.slice(1).map(p => p.pc_id);

        console.log(`\nKeeping: ${keepId}`);
        console.log(`Deleting: ${deleteIds.join(', ')}`);

        for (const id of deleteIds) {
            await db.query('DELETE FROM pc_settings WHERE pc_id = $1', [id]);
            console.log(`  Deleted ${id}`);
        }

        console.log('\nCleanup complete!');
        process.exit(0);
    } catch (err) {
        console.error('Error during cleanup:', err);
        process.exit(1);
    }
}

cleanupDuplicates();
