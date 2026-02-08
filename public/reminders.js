document.addEventListener('DOMContentLoaded', () => {
    // Socket already initialized in block_periods.js
    // We'll use the same socket instance
    const socket = window.io ? io({ transports: ['websocket'] }) : null;
    
    if (!socket) {
        console.error('Socket.IO not available for reminders');
        return;
    }

    let editingReminderId = null;

    // Load reminders on page load
    loadReminders();

    // Listen for reminder updates from server
    socket.on('reminder_update', (rows) => {
        console.log('reminder_update received', rows);
        try {
            if (Array.isArray(rows)) {
                renderReminderList(rows);
            }
        } catch (e) {
            console.warn('Failed to render reminder_update', e);
            loadReminders();
        }
    });

    async function loadReminders() {
        try {
            const res = await fetch('/api/reminder', { headers: { 'Accept': 'application/json' } });
            if (!res.ok) {
                console.error('Failed to load reminders:', res.statusText);
                return;
            }
            const rows = await res.json();
            renderReminderList(rows);
        } catch (err) {
            console.error('Error loading reminders:', err);
        }
    }

    function renderReminderList(rows) {
        const listEl = document.getElementById('reminders-list');
        if (!listEl) return;
        
        listEl.innerHTML = '';
        
        if (!rows || !rows.length) {
            listEl.innerHTML = '<p>No reminders yet.</p>';
            return;
        }

        rows.forEach(r => {
            const item = document.createElement('div');
            item.className = 'reminder-item';
            
            const dayNames = {
                mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu',
                fri: 'Fri', sat: 'Sat', sun: 'Sun'
            };
            
            const daysDisplay = (r.days && r.days.length > 0)
                ? r.days.map(d => dayNames[d] || d).join(', ')
                : 'No days selected';

            item.innerHTML = `
                <div class="reminder-info">
                    <strong>${escapeHtml(r.title)}</strong>
                    <div class="reminder-details">Time: ${r.time} | Days: ${daysDisplay}</div>
                </div>
                <div class="reminder-actions">
                    <button class="btn-edit" data-id="${r.id}">Edit</button>
                    <button class="btn-delete" data-id="${r.id}">Delete</button>
                </div>
            `;
            
            listEl.appendChild(item);
        });

        // Attach event listeners for edit and delete buttons
        listEl.querySelectorAll('.btn-edit').forEach(btn => {
            btn.addEventListener('click', () => editReminder(parseInt(btn.dataset.id), rows));
        });

        listEl.querySelectorAll('.btn-delete').forEach(btn => {
            btn.addEventListener('click', () => deleteReminder(parseInt(btn.dataset.id)));
        });
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function editReminder(id, rows) {
        const reminder = rows.find(r => r.id === id);
        if (!reminder) return;

        editingReminderId = id;
        
        document.getElementById('reminder-form-title').textContent = 'Edit Reminder';
        document.getElementById('reminder-title').value = reminder.title;
        document.getElementById('reminder-time').value = reminder.time;
        
        // Clear and set day checkboxes
        document.querySelectorAll('input[name="reminder-day"]').forEach(cb => {
            cb.checked = reminder.days && reminder.days.includes(cb.value);
        });

        // Scroll to form
        document.querySelector('.reminder-form-wrapper').scrollIntoView({ behavior: 'smooth' });
    }

    async function deleteReminder(id) {
        if (!confirm('Delete this reminder?')) return;

        try {
            const res = await fetch(`/api/reminder/${id}`, {
                method: 'DELETE',
                headers: { 'Accept': 'application/json' }
            });

            if (!res.ok) {
                alert('Failed to delete reminder');
                return;
            }

            await loadReminders();
        } catch (err) {
            console.error('Error deleting reminder:', err);
            alert('Error deleting reminder');
        }
    }

    // Handle reminder form submission
    const reminderForm = document.getElementById('reminder-form');
    if (reminderForm) {
        reminderForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const title = document.getElementById('reminder-title').value.trim();
            const time = document.getElementById('reminder-time').value;
            const dayCheckboxes = document.querySelectorAll('input[name="reminder-day"]:checked');
            const days = Array.from(dayCheckboxes).map(cb => cb.value);

            if (!title || !time) {
                alert('Please fill in all required fields');
                return;
            }

            if (days.length === 0) {
                alert('Please select at least one day');
                return;
            }

            const payload = { title, time, days };

            try {
                let res;
                if (editingReminderId) {
                    res = await fetch(`/api/reminder/${editingReminderId}`, {
                        method: 'PUT',
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'application/json'
                        },
                        body: JSON.stringify(payload)
                    });
                } else {
                    res = await fetch('/api/reminder', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'application/json'
                        },
                        body: JSON.stringify(payload)
                    });
                }

                if (!res.ok) {
                    alert('Failed to save reminder');
                    return;
                }

                // Reset form
                reminderForm.reset();
                editingReminderId = null;
                document.getElementById('reminder-form-title').textContent = 'Add Reminder';

                await loadReminders();
            } catch (err) {
                console.error('Error saving reminder:', err);
                alert('Error saving reminder');
            }
        });
    }

    // Handle cancel button
    const cancelBtn = document.querySelector('.btn-reminder-cancel');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
            reminderForm.reset();
            editingReminderId = null;
            document.getElementById('reminder-form-title').textContent = 'Add Reminder';
        });
    }
});
