// ---------------- Upload desk ----------------
const Upload = {
  offices: [],
  selected: [],

  init(offices) {
    this.offices = offices || [];
    this.refresh();
  },

  toggle(cb) {
    if (cb.checked) {
      if (!this.selected.includes(cb.value)) this.selected.push(cb.value);
    } else {
      this.selected = this.selected.filter((v) => v !== cb.value);
    }
    this.preview();
  },

    preview() {
    const p = document.getElementById('sequencePreview');
    if (!p) return;

    if (!this.selected.length) {
      p.textContent = 'Routing Path: Select at least one section above.';
      return;
    }

    const hasCO = this.selected.includes('co');
    const sections = this.selected.filter((x) => x !== 'co');

    let out = '';
    if (sections.length) {
      out = sections.map((r, i) => `[${i + 1}] ${r.toUpperCase()}`).join(' ➔ ');
      out += hasCO
        ? ' ➔ <strong style="color:#27ae60;">[FINAL] CO</strong>'
        : ' <strong style="color:#27ae60;">[FINAL]</strong>';
    } else if (hasCO) {
      out = '<strong style="color:#27ae60;">[FINAL] CO</strong>';
    }

    const note = hasCO
      ? ''
      : ' <em style="color:var(--text-muted);">(no CO approval)</em>';

    p.innerHTML = `<strong>Routing Path:</strong> ${out}${note}`;
  },

  fileSelected(input) {
    const el = document.getElementById('selectedFileName');
    if (input.files && input.files[0]) {
      el.textContent = `📁 ${input.files[0].name} (${(input.files[0].size / 1024).toFixed(1)} KB)`;
    } else {
      el.textContent = '📄 Click to select file…';
    }
  },

  async submit(ev) {
    ev.preventDefault();
    if (!this.selected.length) return alert('Select at least one section.');

    const file = document.getElementById('docFile').files[0];
    if (!file) return alert('Attach a file.');

    const originOffice = document.getElementById('originOffice')?.value;
    if (!originOffice) return alert('Origin office is required.');

    const btn = document.getElementById('uploadBtn');
    const progressWrap = document.getElementById('uploadProgress');
    const progressFill = document.getElementById('uploadProgressFill');
    const progressPct = document.getElementById('uploadProgressPct');
    const progressBytes = document.getElementById('uploadProgressBytes');

    const fmtBytes = (n) => {
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
      return `${(n / 1024 / 1024).toFixed(1)} MB`;
    };

    btn.disabled = true;
    const origLabel = btn.textContent;
    btn.textContent = 'Uploading…';
    progressWrap.style.display = 'block';
    progressFill.style.width = '0%';
    progressPct.textContent = '0%';
    progressBytes.textContent = `${fmtBytes(file.size)}`;

    const fd = new FormData();
    fd.append('title', document.getElementById('docTitle').value);
    fd.append('type', 'General Document');
    fd.append('remarks', document.getElementById('docRemarks').value);
    fd.append('route_chain', JSON.stringify(this.selected));
    fd.append('origin_office', originOffice);
    fd.append('file', file);

    // XHR instead of fetch — needed because fetch has no upload progress.
    const result = await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/documents');
      xhr.withCredentials = true;

            xhr.upload.addEventListener('progress', (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.round((e.loaded / e.total) * 100);
        
        if (progressFill) progressFill.style.width = pct + '%';
        if (progressPct) progressPct.textContent = pct + '%';
        if (progressBytes) progressBytes.textContent =
          `${fmtBytes(e.loaded)} of ${fmtBytes(e.total)}`;
      });

      xhr.upload.addEventListener('load', () => {
        if (progressFill) progressFill.style.width = '100%';
        if (progressPct) progressPct.textContent = '100%';
        if (progressBytes) progressBytes.textContent = 'Processing on server…';
      });

      xhr.onload = () => {
        let body = null;
        try { body = JSON.parse(xhr.responseText); } catch (e) {}
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve({ ok: true, data: body });
        } else {
          const detail = body?.detail || xhr.statusText || 'Upload failed';
          resolve({ ok: false, error: detail });
        }
      };

      xhr.onerror = () => resolve({ ok: false, error: 'Network error' });
      xhr.onabort = () => resolve({ ok: false, error: 'Upload cancelled' });

      xhr.send(fd);
    });

    try {
      if (!result.ok) {
        throw new Error(result.error);
      }

      document.getElementById('uploadForm').reset();
      this.selected = [];
      this.preview();
      document.getElementById('selectedFileName').textContent = '📄 Click to select file…';
      document.querySelectorAll('#recipientBox input[type=checkbox]').forEach((cb) => (cb.checked = false));
      this.refresh();
    } catch (e) {
      alert('Upload failed: ' + e.message);
    } finally {
      // Keep the progress bar visible for a beat so the user sees 100%,
      // then hide it.
      setTimeout(() => {
        progressWrap.style.display = 'none';
        progressFill.style.width = '0%';
      }, 1200);
      btn.disabled = false;
      btn.textContent = origLabel;
    }
  },

  async refresh() {
    const tbody = document.getElementById('sectionDocTableBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Loading…</td></tr>';
    try {
      const officesParam = encodeURIComponent(this.offices.join(','));
      const docs = await App.api(`/api/documents?origin_offices=${officesParam}`);
      if (!docs.length) {
        tbody.innerHTML =
          '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);">No submissions yet.</td></tr>';
        return;
      }
      tbody.innerHTML = '';
      for (const d of docs) {
        const chain = (d.route_chain || []).map((r, i) => {
          const label = r.toUpperCase();
          return i === d.current_step_index
            ? `<strong style="color:var(--gold);">[${label}]</strong>`
            : label;
        }).join(' ➔ ');
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td data-label="Office"><strong>${App.escapeHtml(d.origin_office.toUpperCase())}</strong></td>
          <td data-label="Title"><strong>${App.escapeHtml(d.title)}</strong><br><small>${App.escapeHtml(d.file_name)}</small></td>
          <td data-label="Holder"><strong style="color:var(--gold);">${App.escapeHtml(d.active_recipient.toUpperCase())}</strong></td>
          <td data-label="Chain"><small>${chain}</small></td>
          <td data-label="Status"><span class="status-badge status-${d.status}">${d.status}</span></td>
          <td data-label="Actions">
            <div class="action-group">
              <button class="btn btn-gold btn-sm" onclick="App.viewDoc('${d.id}')">👁️ View</button>
              <button class="btn btn-danger btn-sm" onclick="Upload.del('${d.id}')">🗑️ Delete</button>
            </div>
          </td>`;
        tbody.appendChild(tr);
      }
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:red;">${e.message}</td></tr>`;
    }
  },

  async del(id) {
    if (!confirm('Delete this document?')) return;
    try {
      await App.api(`/api/documents/${id}`, { method: 'DELETE' });
      this.refresh();
    } catch (e) { alert(e.message); }
  },
};


// ---------------- Review queue (officer) ----------------
const Queue = {
  offices: [],

  init(offices) {
    this.offices = offices || [];
    this.load();
  },

  async load() {
    const tbody = document.getElementById('queueBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Loading…</td></tr>';
    try {
      const officesParam = encodeURIComponent(this.offices.join(','));
      
      // Make sure &status=PENDING is here!
      const docs = await App.api(
        `/api/documents?active_recipients=${officesParam}&status=PENDING`
      );
      
      if (!docs.length) {
        tbody.innerHTML =
          '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);">Nothing in your section\'s queue.</td></tr>';
        return;
      }
      
      tbody.innerHTML = '';
      for (const d of docs) {
        // ... rest of the rendering logic
        const chain = (d.route_chain || []).map((r, i) => {
          const label = r.toUpperCase();
          return i === d.current_step_index
            ? `<strong style="color:var(--gold);">[${label}]</strong>`
            : label;
        }).join(' ➔ ');
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td data-label="Origin"><strong>${App.escapeHtml(d.origin_office.toUpperCase())}</strong></td>
          <td data-label="Subject">${App.escapeHtml(d.title)}</td>
          <td data-label="Holder"><strong style="color:var(--gold);">${App.escapeHtml(d.active_recipient.toUpperCase())}</strong></td>
          <td data-label="Chain"><small>${chain}</small></td>
          <td data-label="Status"><span class="status-badge status-${d.status}">${d.status}</span></td>
          <td data-label="Actions">
            <div class="action-group">
              <button class="btn btn-gold btn-sm" onclick="App.viewDoc('${d.id}')">👁️ View</button>
              ${window.CURRENT_USER_ROLE === 'admin' ? '' : `
              <button class="btn btn-success btn-sm" onclick="Signing.open('${d.id}')">✒️ Sign</button>
              <button class="btn btn-danger btn-sm" onclick="Return.open('${d.id}')">↩️ Return</button>
              `}
            </div>
          </td>`;
        tbody.appendChild(tr);
      }
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:red;">${e.message}</td></tr>`;
    }
  },

  async loadCO() {
    const tbody = document.getElementById('queueBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Loading…</td></tr>';
    try {
      const pending = await App.api(`/api/documents?active_recipient=co&status=PENDING`);
      const archived = await App.api(`/api/documents?status=APPROVED`);
      const docs = [...pending, ...archived];
      if (!docs.length) {
        tbody.innerHTML =
          '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);">No items.</td></tr>';
        return;
      }
      tbody.innerHTML = '';
      for (const d of docs) {
        const chain = (d.route_chain || []).map((r, i) => {
          const label = r.toUpperCase();
          return i === d.current_step_index
            ? `<strong style="color:var(--gold);">[${label}]</strong>`
            : label;
        }).join(' ➔ ');
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td data-label="Origin"><strong>${App.escapeHtml(d.origin_office.toUpperCase())}</strong></td>
          <td data-label="Subject">${App.escapeHtml(d.title)}</td>
          <td data-label="Holder"><strong style="color:var(--gold);">${App.escapeHtml(d.active_recipient.toUpperCase())}</strong></td>
          <td data-label="Chain"><small>${chain}</small></td>
          <td data-label="Status"><span class="status-badge status-${d.status}">${d.status}</span></td>
          <td data-label="Actions">
            <div class="action-group">
              <button class="btn btn-gold btn-sm" onclick="App.viewDoc('${d.id}')">👁️ View</button>
              ${window.CURRENT_USER_ROLE === 'admin'
                ? ''
                : (d.status === 'PENDING' && d.active_recipient === 'co'
                    ? `<button class="btn btn-success btn-sm" onclick="Signing.open('${d.id}')">✒️ Final Approve</button>
                       <button class="btn btn-danger btn-sm" onclick="Return.open('${d.id}')">↩️ Return</button>`
                    : '')}
            </div>
          </td>`;
        tbody.appendChild(tr);
      }
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:red;">${e.message}</td></tr>`;
    }
  },

  initCO() { this.loadCO(); },
};


// ---------------- Admin desk ----------------
const Admin = {
  _monitorTimer: null,
  _userStatusTimer: null,

  init() { this.load(); },

  async load() {
    const tbody = document.getElementById('reviewTableBody');
    if (!tbody) return;
    const section = document.getElementById('adminSectionFilter')?.value || 'ALL';
    const q = document.getElementById('docSearchInput')?.value.trim() || '';

    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Loading…</td></tr>';
    const params = new URLSearchParams();
    if (section !== 'ALL') params.set('origin_office', section);
    if (q) params.set('q', q);

    try {
      const docs = await App.api(`/api/documents?${params.toString()}`);
      if (!docs.length) {
        tbody.innerHTML =
          '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);">No documents.</td></tr>';
        return;
      }
      tbody.innerHTML = '';
      for (const d of docs) {
        const chain = (d.route_chain || []).map((r, i) => {
          const label = r.toUpperCase();
          return i === d.current_step_index
            ? `<strong style="color:var(--gold);">[${label}]</strong>`
            : label;
        }).join(' ➔ ');
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td data-label="Origin"><strong>${App.escapeHtml(d.origin_office.toUpperCase())}</strong></td>
          <td data-label="Title"><strong>${App.escapeHtml(d.title)}</strong><br><small>${App.escapeHtml(d.file_name)}</small></td>
          <td data-label="Holder"><strong style="color:var(--gold);">${App.escapeHtml(d.active_recipient.toUpperCase())}</strong></td>
          <td data-label="Chain"><small>${chain}</small></td>
          <td data-label="Status"><span class="status-badge status-${d.status}">${d.status}</span></td>
          <td data-label="Actions">
            <div class="action-group">
              <button class="btn btn-gold btn-sm" onclick="App.viewDoc('${d.id}')">👁️ View</button>
              <button class="btn btn-danger btn-sm" onclick="Admin.del('${d.id}')">🗑️ Delete</button>
            </div>
          </td>`;
        tbody.appendChild(tr);
      }
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:red;">${e.message}</td></tr>`;
    }
  },

  async del(id) {
    if (!confirm('Delete this document permanently?')) return;
    try {
      await App.api(`/api/documents/${id}`, { method: 'DELETE' });
      this.load();
    } catch (e) { alert(e.message); }
  },

  // ---- Full system restore ----
  initRestoreForm() {
    const confirmField = document.getElementById('restoreConfirm');
    const restoreBtn = document.getElementById('restoreBtn');
    const fileInput = document.getElementById('restoreFile');
    if (!confirmField || !restoreBtn || !fileInput) return;

    const updateBtnState = () => {
      const hasFile = fileInput.files && fileInput.files.length > 0;
      const confirmed = confirmField.value.trim().toUpperCase() === 'RESTORE';
      restoreBtn.disabled = !(hasFile && confirmed);
    };

    confirmField.addEventListener('input', updateBtnState);
    updateBtnState();
  },

  restoreFileSelected(input) {
    const el = document.getElementById('restoreFileName');
    if (input.files && input.files[0]) {
      const f = input.files[0];
      const sizeMB = (f.size / 1024 / 1024).toFixed(2);
      el.textContent = `📦 ${f.name} (${sizeMB} MB)`;
    } else {
      el.textContent = '📄 Click to select backup file…';
    }
    const confirmField = document.getElementById('restoreConfirm');
    const restoreBtn = document.getElementById('restoreBtn');
    if (confirmField && restoreBtn) {
      const hasFile = input.files && input.files.length > 0;
      const confirmed = confirmField.value.trim().toUpperCase() === 'RESTORE';
      restoreBtn.disabled = !(hasFile && confirmed);
    }
  },

  async submitRestore(ev) {
    ev.preventDefault();

    const fileInput = document.getElementById('restoreFile');
    const confirmField = document.getElementById('restoreConfirm');
    const btn = document.getElementById('restoreBtn');

    const file = fileInput.files[0];
    if (!file) return alert('Select a backup file first.');
    if (confirmField.value.trim().toUpperCase() !== 'RESTORE') {
      return alert('Type RESTORE exactly to confirm.');
    }

    const ok1 = confirm(
      `⚠️ RESTORE FROM BACKUP\n\n` +
      `This will REPLACE the current database and all uploaded files with ` +
      `the contents of:\n\n    ${file.name}\n\n` +
      `A safety copy of the current state will be saved first.\n\n` +
      `Continue?`
    );
    if (!ok1) return;

    const ok2 = confirm(
      `This is your LAST chance to cancel.\n\n` +
      `Once you click OK, the restore begins and users will be logged out.\n\n` +
      `Proceed with restore?`
    );
    if (!ok2) return;

    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Restoring… This may take a minute…';

    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('confirm', 'RESTORE');

      const result = await App.api('/admin/backup/restore', {
        method: 'POST',
        body: fd,
      });

      alert(
        `✅ Restore complete.\n\n` +
        `Backup was created: ${result.backup_created_at || 'unknown'}\n` +
        `Safety copy saved to: ${result.safety_backup}\n\n` +
        `${result.message || ''}`
      );

      location.href = '/';
    } catch (e) {
      alert('Restore failed: ' + e.message);
      btn.disabled = false;
      btn.textContent = orig;
    }
  },

  // ---- System monitor ----
  initMonitor() {
    const grid = document.getElementById('monitorGrid');
    if (!grid) return;

    this.refreshMonitor();
    if (this._monitorTimer) clearInterval(this._monitorTimer);
    this._monitorTimer = setInterval(() => this.refreshMonitor(), 10000);

    window.addEventListener('beforeunload', () => {
      if (this._monitorTimer) clearInterval(this._monitorTimer);
    });
  },

  async refreshMonitor() {
    const grid = document.getElementById('monitorGrid');
    if (!grid) return;
    try {
      const s = await App.api('/api/system/stats');
      this.renderMonitor(s);
    } catch (e) {
      console.error('System monitor failed:', e);
      const t = document.getElementById('monitorUpdated');
      if (t) t.textContent = '⚠️ ' + e.message;
    }
  },

  renderMonitor(s) {
    const fmtBytes = (n) => {
      if (!n) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let i = 0;
      while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
      return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
    };
    const fmtDuration = (sec) => {
      sec = Math.floor(sec);
      const d = Math.floor(sec / 86400);
      const h = Math.floor((sec % 86400) / 3600);
      const m = Math.floor((sec % 3600) / 60);
      if (d > 0) return `${d}d ${h}h`;
      if (h > 0) return `${h}h ${m}m`;
      return `${m}m`;
    };
    const setBar = (id, pct) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.width = Math.min(100, Math.max(0, pct)) + '%';
      el.classList.remove('warn', 'danger');
      if (pct >= 90) el.classList.add('danger');
      else if (pct >= 75) el.classList.add('warn');
    };

    // CPU
    document.getElementById('mCpuValue').textContent = `${s.cpu.percent.toFixed(1)}%`;
    setBar('mCpuBar', s.cpu.percent);
    document.getElementById('mCpuSub').textContent = `${s.cpu.cores} core${s.cpu.cores !== 1 ? 's' : ''}`;

    // Memory
    document.getElementById('mMemValue').textContent = `${s.memory.percent.toFixed(0)}%`;
    setBar('mMemBar', s.memory.percent);
    const swapText = s.memory.swap_total > 0
      ? `Swap: ${fmtBytes(s.memory.swap_used)} / ${fmtBytes(s.memory.swap_total)}`
      : 'No swap';
    document.getElementById('mMemSub').textContent =
      `${fmtBytes(s.memory.used)} / ${fmtBytes(s.memory.total)} • ${swapText}`;

    // Disk
    document.getElementById('mDiskValue').textContent = `${s.disk.percent.toFixed(0)}%`;
    setBar('mDiskBar', s.disk.percent);
    document.getElementById('mDiskSub').textContent =
      `${fmtBytes(s.disk.used)} / ${fmtBytes(s.disk.total)} (${fmtBytes(s.disk.free)} free)`;

    // Load
    document.getElementById('mLoadValue').textContent =
      `${s.load.one.toFixed(2)} / ${s.load.five.toFixed(2)} / ${s.load.fifteen.toFixed(2)}`;

    // Temperature
    const tempEl = document.getElementById('mTempValue');
    const tempSub = document.getElementById('mTempSub');
    if (s.temperature_c !== null && s.temperature_c !== undefined) {
      tempEl.textContent = `${s.temperature_c.toFixed(1)} °C`;
      let cls = 'ok';
      if (s.temperature_c >= 80) cls = 'danger';
      else if (s.temperature_c >= 70) cls = 'warn';
      tempSub.textContent = `CPU sensor • ${cls}`;
    } else {
      tempEl.textContent = '—';
      tempSub.textContent = 'Sensor not available';
    }

    // Uptime
    document.getElementById('mUptimeValue').textContent = fmtDuration(s.uptime_seconds);

    // Storage
    document.getElementById('mStorageValue').textContent = fmtBytes(s.storage.size);
    document.getElementById('mStorageSub').textContent =
      `${s.storage.files} file${s.storage.files !== 1 ? 's' : ''}`;

    // Database
    document.getElementById('mDbValue').textContent = fmtBytes(s.database.size);
    document.getElementById('mDbSub').textContent =
      `${s.counts.users} users • ${s.counts.documents} docs • ${s.counts.offices} offices`;

    // Updated timestamp
    const upd = document.getElementById('monitorUpdated');
    if (upd) {
      const d = new Date(s.timestamp * 1000);
      upd.textContent = `Updated ${d.toLocaleTimeString()}`;
    }
  },

  // ---- Live "who's online" refresh ----
  initUserStatus() {
    const table = document.getElementById('activeUsersTable');
    if (!table) return;

    // Immediate fetch, then poll
    this.refreshUserStatus();
    if (this._userStatusTimer) clearInterval(this._userStatusTimer);
    this._userStatusTimer = setInterval(() => this.refreshUserStatus(), 30000);

    window.addEventListener('beforeunload', () => {
      if (this._userStatusTimer) clearInterval(this._userStatusTimer);
    });
  },

  async refreshUserStatus() {
    const table = document.getElementById('activeUsersTable');
    if (!table) return;

    try {
      const data = await App.api('/api/system/online');
      const onlineSet = new Set(data.online.map((u) => u.id));

      // Update dots
      table.querySelectorAll('tr[data-user-id]').forEach((row) => {
        const uid = row.getAttribute('data-user-id');
        const dot = row.querySelector('.user-status-dot');
        if (!dot) return;

        const isOnline = onlineSet.has(uid);
        dot.classList.toggle('online', isOnline);
        dot.classList.toggle('offline', !isOnline);

        // Update tooltip
        dot.title = isOnline ? 'Online now' : 'Offline';
      });

      // Update summary count
      const count = document.getElementById('onlineCount');
      if (count) count.textContent = onlineSet.size;

    } catch (e) {
      console.error('Online status refresh failed:', e);
    }
  },

  // ---- Change password modal ----
  openPwModal(userId, username) {
    const modal = document.getElementById('pwModal');
    if (!modal) return;

    document.getElementById('pwTargetUser').textContent = username;
    document.getElementById('pwForm').action = `/admin/users/${userId}/change-password`;
    document.getElementById('pwNew').value = '';
    document.getElementById('pwConfirm').value = '';

    const err = document.getElementById('pwError');
    err.style.display = 'none';
    err.textContent = '';

    modal.classList.add('active');
    setTimeout(() => document.getElementById('pwNew').focus(), 60);
  },

  closePwModal() {
    const modal = document.getElementById('pwModal');
    if (modal) modal.classList.remove('active');
  },

  submitPwChange(ev) {
    const pw = document.getElementById('pwNew').value;
    const cf = document.getElementById('pwConfirm').value;
    const err = document.getElementById('pwError');

    if (pw.length < 8) {
      ev.preventDefault();
      err.textContent = 'Password must be at least 8 characters.';
      err.style.display = 'block';
      return false;
    }
    if (pw !== cf) {
      ev.preventDefault();
      err.textContent = 'Passwords do not match.';
      err.style.display = 'block';
      return false;
    }
    return true;
  },
};


// ---------------- Signed Document Gallery ----------------
const Gallery = {
  offices: [],
  isAdmin: false,
  _debounceTimer: null,
  currentDocs: [],

  init(opts) {
    this.offices = opts.offices || [];
    this.isAdmin = !!opts.isAdmin;
    this.load();
  },

  debouncedLoad() {
    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => this.load(), 250);
  },

  async load() {
    const grid = document.getElementById('galleryGrid');
    const countEl = document.getElementById('galleryCount');
    
    if (!grid) {
      console.error("ERROR: 'galleryGrid' div is missing from the HTML!");
      return;
    }

    grid.innerHTML = '<div class="gallery-empty">Loading signed documents…</div>';

    const q = document.getElementById('gallerySearch')?.value.trim() || '';
    const officeFilter = document.getElementById('galleryOfficeFilter')?.value || '';

    const params = new URLSearchParams();
    params.set('status', 'APPROVED');
    if (q) params.set('q', q);

    if (this.isAdmin && officeFilter && officeFilter !== 'ALL') {
      params.set('origin_office', officeFilter);
    }
    // Removed the 'else if' block so the backend handles the signature filtering

    try {
      const docs = await App.api(`/api/documents?${params.toString()}`);
      console.log("Fetched approved docs:", docs); // Debugging line
      
      this.currentDocs = docs;
      
      if (countEl) {
          countEl.textContent = `${docs.length} document${docs.length === 1 ? '' : 's'}`;
      }

      if (!docs.length) {
        grid.innerHTML = `
          <div class="gallery-empty">
            No signed documents match your search.
          </div>`;
        return;
      }

      // --- GROUPING LOGIC ---
      const grouped = {};
      docs.forEach(d => {
        let approvalTimeStr = d.created_at;
        if (d.signatures && d.signatures.length > 0) {
          approvalTimeStr = d.signatures[d.signatures.length - 1].timestamp;
        }
        
        const dateObj = new Date(approvalTimeStr);
        
        // Format as "October 28, 2026" for the header
        const dateKey = dateObj.toLocaleDateString('en-US', { 
            year: 'numeric', month: 'long', day: 'numeric' 
        });
        
        if (!grouped[dateKey]) {
            grouped[dateKey] = { docs: [], sortTime: dateObj.getTime() };
        }
        grouped[dateKey].docs.push(d);
      });

      // Sort groups by date (Newest first)
      const sortedDates = Object.keys(grouped).sort((a, b) => {
        return grouped[b].sortTime - grouped[a].sortTime;
      });

      // Render Groups
      grid.innerHTML = sortedDates.map(dateStr => {
        const cardsHtml = grouped[dateStr].docs.map(d => this.card(d)).join('');
        return `
          <div class="gallery-date-group">
            <div class="gallery-date-header">
              <span>📅 ${dateStr}</span>
            </div>
            <div class="gallery-grid">
              ${cardsHtml}
            </div>
          </div>
        `;
      }).join('');

    } catch (e) {
      console.error("Gallery Load Error:", e);
      grid.innerHTML = `<div class="gallery-empty" style="color:var(--danger);">
        Failed to load: ${App.escapeHtml(e.message)}
      </div>`;
    }
  },
  
  async downloadAll() {
    if (!this.currentDocs || this.currentDocs.length === 0) {
      return alert("No documents to download.");
    }

    const btn = document.getElementById('downloadAllBtn');
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '📦 Zipping...';

    try {
      const docIds = this.currentDocs.map(d => d.id);
      
      const res = await fetch('/api/documents/download-archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc_ids: docIds }),
        credentials: 'include'
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Download failed');
      }

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Signed_Archive_${new Date().toISOString().slice(0,10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);

    } catch (e) {
      alert(e.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  },

  card(d) {
    const title = App.escapeHtml(d.title);
    const file = App.escapeHtml(d.file_name);
    const office = App.escapeHtml(d.origin_office.toUpperCase());
    const type = App.escapeHtml(d.type);
    
    let approvalTimeStr = d.created_at;
    if (d.signatures && d.signatures.length > 0) {
      approvalTimeStr = d.signatures[d.signatures.length - 1].timestamp;
    }
    
    const dateObj = new Date(approvalTimeStr);
    const timePart = dateObj.toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit'
    });
    
    const sigCount = (d.signatures || []).length;
    const fileUrl = d.file_url;

    return `
      <div class="gallery-card">
        <div class="gallery-badges">
          <span class="gallery-office-badge">${office}</span>
          <span class="gallery-type-badge">${type}</span>
        </div>
        <div class="gallery-title">${title}</div>
        <div class="gallery-meta">
          📄 ${file}
        </div>
        <div class="gallery-meta">
          🕒 ${timePart} &nbsp;•&nbsp; ✒️ ${sigCount} signature${sigCount === 1 ? '' : 's'}
        </div>
        <div class="gallery-actions">
          <button class="btn btn-gold btn-sm" onclick="App.viewDoc('${d.id}')">👁️ View</button>
          <a class="btn btn-primary btn-sm"
             href="${fileUrl}"
             download="${file}">📥 Download</a>
        </div>
      </div>
    `;
  },
};