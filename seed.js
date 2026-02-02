require('dotenv').config();
const db = require('./database');
const bcrypt = require('bcrypt');

const args = process.argv.slice(2);
const username = args[0] || 'admin@admin.com';
const password = args[1] || 'password123';

const saltRounds = 10;

bcrypt.hash(password, saltRounds, async (err, hash) => {
    if (err) {
        console.error('Error hashing password:', err);
        return;
    }
    const query = `
        INSERT INTO users (username, password) 
        VALUES ($1, $2) 
        ON CONFLICT (username) 
        DO UPDATE SET password = EXCLUDED.password;
    `;
    try {
        await db.query(query, [username, hash]);
        console.log(`User '${username}' created/updated successfully.`);
    } catch (err) {
        console.error('Error inserting user:', err);
    } finally {
        db.pool.end();
    }
});
