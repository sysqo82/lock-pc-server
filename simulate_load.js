const io = require('socket.io-client');
const argv = (() => {
    try { return require('minimist')(process.argv.slice(2)); } catch (e) { return {}; }
})();

const SERVER_URL = argv.url || process.env.SERVER_URL || 'http://localhost:8081';
const CLIENTS = parseInt(argv.clients || process.env.CLIENTS || '20', 10);
const RATE_MS = parseInt(argv.rate || process.env.RATE_MS || process.env.RATE || '200', 10); // how often each client emits pc_status
const DURATION_MS = parseInt(argv.duration || process.env.DURATION_MS || process.env.DURATION || '10000', 10);
const PREFIX = argv.prefix || process.env.RUN_PREFIX || `run-${Date.now()}`;

console.log(`Simulate load -> url=${SERVER_URL}, clients=${CLIENTS}, rate=${RATE_MS}ms, duration=${DURATION_MS}ms`);

const clients = [];

for (let i = 0; i < CLIENTS; i++) {
    const id = `${PREFIX}-${process.pid}-${i}`;
    const socket = io(SERVER_URL, { reconnection: true, transports: ['websocket'] });
    socket.on('connect', () => {
        socket.emit('register_pc', { id, name: `Sim ${id}`, clientType: 'pc_app' });
        socket.emit('pc_status', { id, status: 'Unlocked' });
        const iv = setInterval(() => {
            socket.emit('pc_status', { id, status: Math.random() > 0.5 ? 'Unlocked' : 'Locked' });
        }, RATE_MS);
        socket._iv = iv;
    });
    socket.on('disconnect', () => {
        if (socket._iv) clearInterval(socket._iv);
    });
    clients.push(socket);
}

setTimeout(() => {
    console.log('Stopping simulation...');
    clients.forEach(s => {
        try { if (s._iv) clearInterval(s._iv); s.disconnect(); } catch (e) {}
    });
    setTimeout(() => process.exit(0), 500);
}, DURATION_MS);
