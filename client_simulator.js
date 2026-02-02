const io = require('socket.io-client');

// Replace with your server URL in production (e.g. https://my-app.herokuapp.com)
const SERVER_URL = 'http://localhost:3000'; 
const PC_ID = 'pc-test-' + Math.floor(Math.random() * 1000);

const socket = io(SERVER_URL);

console.log(`Simulating PC Client: ${PC_ID}`);

socket.on('connect', () => {
    console.log('Connected to server');
    
    // 1. Register
    socket.emit('register_pc', { 
        id: PC_ID, 
        name: `Test PC ${PC_ID}` 
    });

    // 2. Report initial status
    socket.emit('pc_status', { status: 'Unlocked' });
});

socket.on('command', (data) => {
    console.log(`RECEIVED COMMAND: ${data.action.toUpperCase()}`);
    
    // Simulate performing the action
    if (data.action === 'lock') {
        console.log('*** PC LOCKED ***');
        socket.emit('pc_status', { status: 'Locked' });
    } else if (data.action === 'unlock') {
        console.log('*** PC UNLOCKED ***');
        socket.emit('pc_status', { status: 'Unlocked' });
    }
});

socket.on('disconnect', () => {
    console.log('Disconnected from server');
});
