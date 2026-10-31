const Activities = (() => {
  let current = new Date();
  let selectedDate = null;
  let activitiesByDate = {};

  const $ = (id) => document.getElementById(id);
    const OFFICE_COLORS = {
    s1: '#3b82f6',       // Blue
    s2: '#9D00FF',       // white
    s3: '#10b981',       // Green
    s4: '#f59e0b',       // Orange
    s6: '#06b6d4',       // Cyan
    s7: '#ec4899',       // Pink
    hhc: '#6b7280',      // Gray
    motorpol: '#ef4444', // Red
    atr: '#FF8C00',      // dark Orange
    finance: '#14b8a6',  // Teal
    exo: '#FFFF00',      // yellow
    general: '#a3a3a3'   // Default Gray
  };

  function getOfficeColor(office) {
    if (!office) return OFFICE_COLORS.general;
    return OFFICE_COLORS[office.toLowerCase()] || OFFICE_COLORS.general;
  }

  const OFFICE_LABELS = {
    s1: 'S1 — Personnel',
    s2: 'S2 — Intelligence',
    s3: 'S3 — Operations',
    s4: 'S4 — Logistics',
    s6: 'S6 — Signal',
    s7: 'S7 — Civil Affairs',
    hhc: 'HHC — Headquarters',
    motorpol: 'Motorpol',
    atr: 'ATR',
    finance: 'Finance',
    exo: 'EXO — Executive',
    general: 'General / Admin'
  };

  function renderLegend() {
    const el = $('activityLegend');
    if (!el) return;
    
    el.innerHTML = Object.entries(OFFICE_COLORS).map(([code, color]) => {
      const label = OFFICE_LABELS[code] || code.toUpperCase();
      return `
        <div class="legend-item">
          <span class="legend-color" style="background:${color}"></span>
          <span class="legend-label">${label}</span>
        </div>`;
    }).join('');
  }
  const monthNames = [
    'January','February','March','April','May','June',
    'July','August','September','October','November','December',
  ];

  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(y, m, d) { return `${y}-${pad(m + 1)}-${pad(d)}`; }
  function todayYmd() {
    const t = new Date();
    return ymd(t.getFullYear(), t.getMonth(), t.getDate());
  }

  function init() {
    renderLegend(); // <-- Add this line

    const params = new URLSearchParams(window.location.search);
    const dateParam = params.get('date');
    if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      const [y, m, d] = dateParam.split('-').map(Number);
      current = new Date(y, m - 1, d);
      selectedDate = dateParam;
    } else {
      selectedDate = todayYmd();
    }
    load();
  }

  async function load() {
    const y = current.getFullYear();
    const m = current.getMonth();
    const monthStr = `${y}-${pad(m + 1)}`;

    try {
      const rows = await App.api(`/api/activities?month=${monthStr}`);
      activitiesByDate = {};
      for (const a of rows) {
        (activitiesByDate[a.activity_date] ||= []).push(a);
      }
      renderCalendar();
      renderList();
    } catch (e) {
      $('calGrid').innerHTML =
        `<div style="grid-column:1/-1;padding:2rem;text-align:center;color:var(--danger);">
          Failed to load: ${App.escapeHtml(e.message)}
        </div>`;
    }
  }

  function renderCalendar() {
    const y = current.getFullYear();
    const m = current.getMonth();
    $('calTitle').textContent = `${monthNames[m]} ${y}`;

    const firstIdx = new Date(y, m, 1).getDay();
    const total = new Date(y, m + 1, 0).getDate();
    const prevLast = new Date(y, m, 0).getDate();
    const today = todayYmd();

    const cells = [];
    for (let i = firstIdx; i > 0; i--) {
      cells.push(`<div class="activity-cal-day other-month"><span class="daynum">${prevLast - i + 1}</span></div>`);
    }
    for (let d = 1; d <= total; d++) {
      const date = ymd(y, m, d);
      const acts = activitiesByDate[date] || [];
      const classes = ['activity-cal-day'];
      if (date === today) classes.push('today');
      if (date === selectedDate) classes.push('selected');
      if (acts.length) classes.push('has-activities');
      const dots = acts.length
        ? `<div class="activity-cal-dots">${acts.slice(0, 3).map((a) => `<span style="background:${getOfficeColor(a.office)}"></span>`).join('')}</div>`
        : '';
      cells.push(
        `<div class="${classes.join(' ')}" onclick="Activities.select('${date}')">
          <span class="daynum">${d}</span>${dots}
        </div>`
      );
    }
    const trailing = (7 - ((firstIdx + total) % 7)) % 7;
    for (let i = 1; i <= trailing; i++) {
      cells.push(`<div class="activity-cal-day other-month"><span class="daynum">${i}</span></div>`);
    }

    $('calGrid').innerHTML = cells.join('');
  }

  function renderList() {
    const list = $('activityList');
    if (!selectedDate) {
      list.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:1rem;">Pick a date to view activities.</p>';
      $('listTitle').textContent = 'Activities';
      return;
    }

    const [y, m, d] = selectedDate.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    $('listTitle').textContent = dt.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });

    const acts = activitiesByDate[selectedDate] || [];
    if (!acts.length) {
      list.innerHTML = `
        <p style="color:var(--text-muted);text-align:center;padding:1.5rem;">
          No activities for this day.<br>
          <button class="btn btn-gold btn-sm" style="margin-top:0.75rem;"
                  onclick="Activities.openAdd('${selectedDate}')">➕ Add one</button>
        </p>`;
      return;
    }

    const me = window.CURRENT_USER;
    const isAdmin = window.CURRENT_USER_ROLE === 'admin';

    list.innerHTML = acts.map((a) => {
      const mine = a.created_by === me;
      const canEdit = mine || isAdmin;
      const time = a.activity_time ? `<span class="act-time">🕒 ${App.escapeHtml(a.activity_time)}</span>` : '';
      
      const officeBadge = `<span class="act-office-badge" style="background:${getOfficeColor(a.office)}; color:#fff;">${App.escapeHtml((a.office || 'GEN').toUpperCase())}</span>`;
      const loc = a.location ? `<div class="act-loc">📍 ${App.escapeHtml(a.location)}</div>` : '';
      const desc = a.description ? `<div class="act-desc">${App.escapeHtml(a.description)}</div>` : '';
      const actions = canEdit ? `
        <div class="act-actions">
          <button class="btn btn-gold btn-sm" onclick="Activities.openEdit('${a.id}')">✏️</button>
          <button class="btn btn-danger btn-sm" onclick="Activities.remove('${a.id}')">🗑️</button>
        </div>` : '';
      return `
        <div class="act-card" style="border-left-color: ${getOfficeColor(a.office)};">
          <div class="act-head">
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
              ${officeBadge}
              <strong class="act-title">${App.escapeHtml(a.title)}</strong>
              ${time}  <!-- MOVED HERE -->
            </div>
          </div>
          ${loc}
          ${desc}
          <div class="act-meta">Added by ${App.escapeHtml(a.created_by)}</div>
          ${actions}
        </div>`;
    }).join('');
  }

  function select(date) {
    selectedDate = date;
    renderCalendar();
    renderList();
  }

  function prevMonth() {
    current = new Date(current.getFullYear(), current.getMonth() - 1, 1);
    load();
  }
  function nextMonth() {
    current = new Date(current.getFullYear(), current.getMonth() + 1, 1);
    load();
  }
  function today() {
    current = new Date();
    selectedDate = todayYmd();
    load();
  }

    function openAdd(date) {
    $('activityModalTitle').textContent = 'Add Activity';
    $('actId').value = '';
    $('actTitle').value = '';
    $('actDate').value = date || selectedDate || todayYmd();
    $('actTimeHour').value = '';
    $('actTimeMinute').value = '';
    $('actLocation').value = '';
    $('actDesc').value = '';
    $('actSaveBtn').textContent = 'Save';
    $('activityModal').classList.add('active');
    setTimeout(() => $('actTitle').focus(), 60);
  }

  function openEdit(id) {
    for (const date in activitiesByDate) {
      const found = activitiesByDate[date].find((a) => a.id === id);
      if (found) {
        $('activityModalTitle').textContent = 'Edit Activity';
        $('actId').value = found.id;
        $('actTitle').value = found.title;
        $('actDate').value = found.activity_date;

        if (found.activity_time) {
          const [h, m] = found.activity_time.split(':');
          $('actTimeHour').value = h;
          $('actTimeMinute').value = m;
        } else {
          $('actTimeHour').value = '';
          $('actTimeMinute').value = '';
        }

        $('actLocation').value = found.location || '';
        $('actDesc').value = found.description || '';
        $('actSaveBtn').textContent = 'Save Changes';
        $('activityModal').classList.add('active');
        setTimeout(() => $('actTitle').focus(), 60);
        return;
      }
    }
    alert('Activity not found.');
  }

  function closeModal() {
    $('activityModal').classList.remove('active');
  }

  async function save(ev) {
    ev.preventDefault();
    const id = $('actId').value;
    const hh = $('actTimeHour').value;
    const mm = $('actTimeMinute').value;
    const timeValue = (hh && mm) ? `${hh}:${mm}` : null;

    const payload = {
      title: $('actTitle').value.trim(),
      description: $('actDesc').value.trim() || null,
      location: $('actLocation').value.trim() || null,
      activity_date: $('actDate').value,
      activity_time: timeValue,
    };
    if (!payload.title || !payload.activity_date) {
      alert('Title and date are required.');
      return false;
    }

    $('actSaveBtn').disabled = true;
    try {
      if (id) {
        await App.api(`/api/activities/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } else {
        await App.api('/api/activities', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      }
      closeModal();
      const [y, m] = payload.activity_date.split('-').map(Number);
      if (y !== current.getFullYear() || (m - 1) !== current.getMonth()) {
        current = new Date(y, m - 1, 1);
      }
      selectedDate = payload.activity_date;
      await load();
    } catch (e) {
      alert('Failed: ' + e.message);
    } finally {
      $('actSaveBtn').disabled = false;
    }
    return false;
  }

  async function remove(id) {
    if (!confirm('Delete this activity?')) return;
    try {
      await App.api(`/api/activities/${id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      alert('Failed: ' + e.message);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('calGrid')) init();
  });

  return { init, load, select, prevMonth, nextMonth, today, openAdd, openEdit, closeModal, save, remove };
})();