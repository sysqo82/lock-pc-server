document.addEventListener('DOMContentLoaded', () => {
    // Use WebSocket-only transport to avoid frequent polling XHRs
    const socket = io({ transports: ['websocket'] });
    socket.emit('identify', { type: 'dashboard' });

    // Connection debug
    socket.on('connect', () => console.info('socket connected', socket.id));
    socket.on('disconnect', (reason) => console.info('socket disconnected', reason));
    socket.on('connect_error', (err) => console.error('socket connect_error', err));

    // Helper to render PC list (used by pc_update and elsewhere)
    function renderPcList(pcs) {
        const pcListEl = document.getElementById('pc-list');
        if (!pcListEl) return;
        pcListEl.innerHTML = '';
        if (!pcs || !pcs.length) {
            pcListEl.innerHTML = '<p>No known PCs.</p>';
            return;
        }
        pcs.forEach(pc => {
            const el = document.createElement('div');
            el.className = 'pc-item';

            const name = pc.name || pc.id || 'PC';
            const idHtml = pc.id ? `<small>${pc.id}</small>` : '';

            const title = document.createElement('div');
            title.innerHTML = `<strong>${name}</strong> ${idHtml}`;

            const info = document.createElement('div');
            const ip = pc.ip || 'N/A';
            // Handle status: use provided status, or fallback to Unknown
            // Be explicit: only treat actual values as valid, not undefined/null/empty
            const statusText = (pc.status && pc.status !== '') ? pc.status : 'Unknown';
            info.innerHTML = `IP: ${ip} — Status: `;
            const statusSpan = document.createElement('span');
            statusSpan.className = 'pc-status';
            statusSpan.textContent = statusText;
            info.appendChild(statusSpan);

            const actions = document.createElement('div');
            actions.className = 'pc-actions';
            const probeBtn = document.createElement('button');
            probeBtn.textContent = 'Probe';
            probeBtn.className = 'btn-probe';
            probeBtn.addEventListener('click', async () => {
                probeBtn.disabled = true;
                statusSpan.textContent = 'Probing...';
                try {
                    const res = await fetch(`/api/pc/${encodeURIComponent(pc.id)}/probe`, { headers: { 'Accept': 'application/json' } });
                    if (!res.ok) {
                        const txt = await res.text().catch(()=>res.statusText);
                        statusSpan.textContent = `Error: ${res.status}`;
                    } else {
                        const body = await res.json();
                        statusSpan.textContent = body.status || 'Unknown';
                    }
                } catch (err) {
                    console.error('Probe failed', err);
                    statusSpan.textContent = 'Probe failed';
                } finally {
                    probeBtn.disabled = false;
                }
            });
            actions.appendChild(probeBtn);

            el.appendChild(title);
            el.appendChild(info);
            el.appendChild(actions);
            pcListEl.appendChild(el);
        });
    }

    // Update PC list when server broadcasts PC state for this user
    socket.on('pc_update', (pcs) => {
        console.log('pc_update received', pcs);
        // Debug: log each PC's status explicitly
        if (pcs && pcs.length > 0) {
            pcs.forEach(pc => {
                console.log(`  PC ${pc.id}: status="${pc.status}" (type: ${typeof pc.status})`);
            });
        }
        try {
            renderPcList(pcs);
        } catch (e) {
            console.warn('Failed to render pc_update', e);
            // fallback: ensure list refreshed
            loadPcList();
        }
    });

    // When server pushes schedule updates to dashboard (or PC), reload list
    socket.on('schedule_update', (rows) => {
        console.log('schedule_update received', rows);
        try {
            if (Array.isArray(rows)) {
                rows.forEach(row => { try { row.days = JSON.parse(row.days || '[]'); } catch(e){ row.days = []; } });
                renderList(rows);
                // schedule updated for this user; refresh PC list
                loadPcList();
                return;
            }
            // server may send payload { rows, pcId, userId }
            if (rows && Array.isArray(rows.rows)) {
                rows.rows.forEach(row => { try { row.days = JSON.parse(row.days || '[]'); } catch(e){ row.days = []; } });
                renderList(rows.rows);
                loadPcList();
                return;
            }
            // fallback: reload from server
            loadList();
        } catch (e) {
            console.warn('Failed to apply schedule_update', e);
            loadList();
        }
    });

    const listEl = document.getElementById('block-periods-list');
    const form = document.getElementById('block-period-form');
    const formTitle = document.getElementById('form-title');
    const fromInput = document.getElementById('from-time');
    const toInput = document.getElementById('to-time');
    const dayCheckboxes = Array.from(document.querySelectorAll('input[name="day"]'));
    const cancelBtn = form.querySelector('.btn-cancel');

    let editingId = null;

    function humanDays(days) {
        if (!days || !days.length) return 'Everyday';
        return days.map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(', ');
    }

    async function loadList() {
        try {
            const res = await fetch('/api/block-period', { headers: { 'Accept': 'application/json' } });
            if (!res.ok) {
                if (res.status === 401) {
                    // session expired, redirect to login
                    console.warn('Not authenticated; redirecting to login');
                    window.location.href = '/login';
                    return;
                }
                throw new Error('Failed to load block periods: ' + res.status);
            }
            const contentType = res.headers.get('content-type') || '';
            if (!contentType.includes('application/json')) {
                console.warn('Unexpected response content-type for /api/block-period:', contentType);
                // fallback: redirect to login if HTML (likely a redirect)
                if (contentType.includes('text/html')) {
                    window.location.href = '/login';
                    return;
                }
                throw new Error('Invalid content-type: ' + contentType);
            }
            const periods = await res.json();
            renderList(periods);
        } catch (err) {
            console.error('Failed to load block periods', err);
        }
    }

    async function loadPcList() {
        try {
            const res = await fetch('/api/pcs', { headers: { 'Accept': 'application/json' } });
            if (!res.ok) {
                if (res.status === 401) { window.location.href = '/login'; return; }
                throw new Error('Failed to load PCs: ' + res.status);
            }
            const pcs = await res.json();
            renderPcList(pcs);
        } catch (err) {
            console.error('Failed to load PCs', err);
        }
    }

    function renderList(periods) {
        listEl.innerHTML = '';
        if (!periods.length) {
            listEl.innerHTML = '<p>No block periods yet. Add one below.</p>';
            return;
        }

        periods.forEach(p => {
            const item = document.createElement('div');
            item.className = 'block-period-item';
            item.dataset.id = p.id;
            item.innerHTML = `
                <div class="bp-info">
                    <strong>${p.from} → ${p.to}</strong>
                    <div class="bp-days">${humanDays(p.days)}</div>
                </div>
                <div class="bp-actions">
                    <button class="btn-edit">Edit</button>
                    <button class="btn-delete">Delete</button>
                </div>
            `;
            listEl.appendChild(item);
        });
    }

    function resetForm() {
        editingId = null;
        formTitle.textContent = 'Add Block Period';
        form.reset();
        dayCheckboxes.forEach(cb => cb.checked = false);
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const days = dayCheckboxes.filter(cb => cb.checked).map(cb => cb.value);
        const payload = { from: fromInput.value, to: toInput.value, days };

        try {
            if (editingId) {
                const res = await fetch(`/api/block-period/${editingId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (!res.ok) throw new Error('Update failed');
            } else {
                const res = await fetch('/api/block-period', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (!res.ok) throw new Error('Create failed');
            }
            await loadList();
            resetForm();
        } catch (err) {
            console.error('Save failed', err);
            alert('Failed to save block period');
        }
    });

    cancelBtn.addEventListener('click', (e) => {
        e.preventDefault();
        resetForm();
    });

    listEl.addEventListener('click', async (e) => {
        const parent = e.target.closest('.block-period-item');
        if (!parent) return;
        const id = parent.dataset.id;

        if (e.target.classList.contains('btn-delete')) {
            if (!confirm('Delete this block period?')) return;
            try {
                const res = await fetch(`/api/block-period/${id}`, { method: 'DELETE' });
                if (!res.ok) throw new Error('Delete failed');
                await loadList();
            } catch (err) {
                console.error('Delete failed', err);
                alert('Failed to delete');
            }
        }

        if (e.target.classList.contains('btn-edit')) {
            // Load that period and populate form
            try {
                const res = await fetch('/api/block-period', { headers: { 'Accept': 'application/json' } });
                if (!res.ok) {
                    if (res.status === 401) { window.location.href = '/login'; return; }
                    throw new Error('Failed to load for edit: ' + res.status);
                }
                const ct = res.headers.get('content-type') || '';
                if (!ct.includes('application/json')) { window.location.href = '/login'; return; }
                const periods = await res.json();
                const p = periods.find(x => String(x.id) === String(id));
                if (!p) throw new Error('Not found');
                editingId = p.id;
                formTitle.textContent = 'Edit Block Period';
                fromInput.value = p.from || '';
                toInput.value = p.to || '';
                dayCheckboxes.forEach(cb => cb.checked = (p.days || []).includes(cb.value));
                window.scrollTo({ top: form.offsetTop - 20, behavior: 'smooth' });
            } catch (err) {
                console.error('Load for edit failed', err);
                alert('Failed to load block period for editing');
            }
        }
    });

    // Initial load
    loadList();
    loadPcList();
});
