// ---------------- Theme (light / dark) ----------------
const Theme = {
  current() {
    return document.documentElement.getAttribute('data-theme') || 'light';
  },

  apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch (e) {}
    this.refreshButton();
  },

  toggle() {
    this.apply(this.current() === 'dark' ? 'light' : 'dark');
  },

  refreshButton() {
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    const isDark = this.current() === 'dark';
    btn.textContent = isDark ? '☀️' : '🌙';
    btn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
  },

  init() { this.refreshButton(); },
};

document.addEventListener('DOMContentLoaded', () => Theme.init());


// ---------------- Password visibility toggle ----------------
function togglePassword(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;

  const eyeOn  = btn.querySelector('.icon-eye');
  const eyeOff = btn.querySelector('.icon-eye-off');

  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';

  if (eyeOn)  eyeOn.style.display  = showing ? 'block' : 'none';
  if (eyeOff) eyeOff.style.display = showing ? 'none'  : 'block';

  btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  input.focus();
}


// ---------------- App ----------------
const App = {
  async api(path, opts = {}) {
    // Add cache: 'no-store' right here
    const res = await fetch(path, { credentials: 'include', cache: 'no-store', ...opts });
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).detail || msg; } catch {}
      throw new Error(msg);
    }
    return res.json();
  },

  escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[c]));
  },

  openModal(id)  { document.getElementById(id).classList.add('active'); },
  closeModal(id) { document.getElementById(id).classList.remove('active'); },

  // ---------------- Mobile nav ----------------
  toggleMobileNav(force) {
    const open = force === undefined
      ? !document.body.classList.contains('nav-open')
      : force;
    document.body.classList.toggle('nav-open', open);
  },

  // ---------------- kind detection ----------------
  detectKind(doc) {
    if (doc.preview_url && doc.preview_url.toLowerCase().endsWith('.pdf')) {
      return 'pdf';
    }
    const t = (doc.file_type || '').toLowerCase();
    const n = (doc.file_name || '').toLowerCase();
    if (t.includes('wordprocessingml') || n.endsWith('.docx')) return 'docx';
    if (t.includes('spreadsheetml') || n.endsWith('.xlsx')) return 'xlsx';
    if (t === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
    if (t.startsWith('image/')) return 'image';
    return 'other';
  },

  // ---------------- mobile docx auto-scaling ----------------
  fitDocxToContainer(area) {
    if (!area) return;
    const containerWidth = area.clientWidth;
    if (containerWidth < 40) return;

    const sections = area.querySelectorAll('.docx-wrapper > section.docx, section.docx');
    if (!sections.length) return;

    const naturalWidth = sections[0].scrollWidth || sections[0].offsetWidth;
    if (naturalWidth <= 0) return;

    const scale = Math.min(1, containerWidth / naturalWidth);

    sections.forEach((sec) => {
      sec.style.transform = `scale(${scale})`;
      sec.style.transformOrigin = 'top left';
      const naturalHeight = sec.offsetHeight;
      const shrunkHeight = naturalHeight * scale;
      sec.style.marginBottom = `${shrunkHeight - naturalHeight}px`;
    });

    const wrapper = area.querySelector('.docx-wrapper');
    if (wrapper) {
      wrapper.style.width = '100%';
      wrapper.style.maxWidth = '100%';
    }
  },

  // ---------------- inline renderer ----------------
  async renderInline(doc, kind, container, opts = {}) {
    container.innerHTML = '';
    const wrapper = document.createElement('div');
    const widthStyle = opts.width ? `width:${opts.width}px;max-width:100%;` : '';
    wrapper.style.cssText = `position:relative;background:#fff;color:#111;max-width:100%;overflow-x:auto;${widthStyle}`;
    container.appendChild(wrapper);

    if (kind === 'image') {
      const img = document.createElement('img');
      img.style.cssText = 'max-width:100%;max-height:500px;display:block;margin:0 auto;';
      wrapper.appendChild(img);
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = doc.file_url; });

    } else if (kind === 'pdf') {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

      const fetchUrl = doc.preview_url || doc.file_url;
      const buf = await (await fetch(fetchUrl)).arrayBuffer();
      const pdf = await window.pdfjsLib.getDocument({ data: buf, verbosity: 0 }).promise;

      const outputScale = window.devicePixelRatio || 1;
      
      // Calculate the available width of the container (minus padding)
      const availableWidth = Math.min(Math.max(container.clientWidth - 40, 320), 1200);

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        
        // Calculate the exact scale to fit the width
        const probeVp = page.getViewport({ scale: 1 });
        const renderScale = availableWidth / probeVp.width;
        const vp = page.getViewport({ scale: renderScale });

        const pageWrap = document.createElement('div');
        pageWrap.className = 'pdf-page';
        pageWrap.dataset.page = String(i - 1);
        pageWrap.style.cssText =
          `position:relative;margin:0 auto 15px;` + // Center the page
          `width:${vp.width}px;height:${vp.height}px;` +
          `flex-shrink:0;`;

        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');

        // High resolution canvas
        canvas.width = Math.floor(vp.width * outputScale);
        canvas.height = Math.floor(vp.height * outputScale);
        
        canvas.style.cssText = 
          `display:block; background:#fff; ` +
          `width:${vp.width}px; height:${vp.height}px;`;

        pageWrap.appendChild(canvas);
        wrapper.appendChild(pageWrap);

        const renderContext = {
          canvasContext: context,
          transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
          viewport: vp,
        };

        await page.render(renderContext).promise;
      }

      // Overlay existing signatures
      const sigs = doc.signatures || [];
      sigs.forEach((sig) => {
        if (sig.x === undefined || sig.y === undefined) return;
        const pageIdx = (sig.page !== undefined && sig.page !== null) ? String(sig.page) : '0';
        const targetPage = wrapper.querySelector(`.pdf-page[data-page="${pageIdx}"]`) || wrapper.querySelector('.pdf-page');
        if (!targetPage) return;

        const currentW = targetPage.offsetWidth || 1;
        const currentH = targetPage.offsetHeight || 1;
        const recordedW = sig.page_width || currentW;
        const recordedH = sig.page_height || currentH;
        const fx = currentW / recordedW;
        const fy = currentH / recordedH;

        const el = document.createElement('div');
        el.className = 'placed-signature placed-signature-readonly';
        el.style.left = (sig.x * fx) + 'px';
        el.style.top  = (sig.y * fy) + 'px';
        if (sig.width) el.style.width = (sig.width * fx) + 'px';
        el.style.pointerEvents = 'none';

        const img = document.createElement('img');
        img.src = sig.url;
        img.style.width = '100%';
        img.style.display = 'block';
        el.appendChild(img);

        const label = document.createElement('div');
        label.className = 'placed-signature-label';
        label.textContent = `✓ ${sig.step || sig.officer}`;
        el.appendChild(label);
        targetPage.appendChild(el);
      });

      return wrapper;

    } else if (kind === 'docx') {
      const buf = await (await fetch(doc.file_url)).arrayBuffer();
      const holder = document.createElement('div');
      holder.style.cssText = 'background:#fff;color:#111;overflow-x:auto;';
      wrapper.appendChild(holder);
      await window.docx.renderAsync(buf, holder, holder, {
        inWrapper: true,
        breakPages: true,
        ignoreLastRenderedPageBreak: false,
        renderHeaders: true,
        renderFooters: true,
      });
      if (window.innerWidth <= 768) {
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        App.fitDocxToContainer(holder);
      }

    } else if (kind === 'xlsx') {
      const buf = await (await fetch(doc.file_url)).arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const html = XLSX.utils.sheet_to_html(wb.Sheets[wb.SheetNames[0]]);
      const holder = document.createElement('div');
      holder.style.cssText = 'background:#fff;color:#111;overflow-x:auto;padding:1rem;max-width:100%;width:100%;box-sizing:border-box;';
      holder.innerHTML = html;
      wrapper.appendChild(holder);

    } else {
      container.innerHTML = `
        <div style="text-align:center;padding:2rem;">
          <p>Inline preview unavailable for this file type.</p>
          <a class="btn btn-gold" href="${doc.file_url}" target="_blank" download>📥 Download</a>
        </div>`;
      return null;
    }

    // Non-PDF kinds: overlay signatures at the top of the wrapper
    const sigs = doc.signatures || [];
    sigs.forEach((sig) => {
      if (sig.x === undefined || sig.y === undefined) return;

      const el = document.createElement('div');
      el.className = 'placed-signature placed-signature-readonly';
      el.style.left = sig.x + 'px';
      el.style.top  = sig.y + 'px';
      if (sig.width) el.style.width = sig.width + 'px';
      el.style.pointerEvents = 'none';

      const img = document.createElement('img');
      img.src = sig.url;
      img.style.width = '100%';
      img.style.display = 'block';
      el.appendChild(img);

      const label = document.createElement('div');
      label.className = 'placed-signature-label';
      label.textContent = `✓ ${sig.step || sig.officer}`;
      el.appendChild(label);

      wrapper.appendChild(el);
    });

    return wrapper;
  },

  // ---------------- view modal ----------------
  async viewDoc(id) {
    try {
      const d = await this.api(`/api/documents/${id}`);
      document.getElementById('previewTitle').textContent =
        `${d.title} (${d.origin_office.toUpperCase()})`;

      const logs = (d.history_logs || []).map((l) => `• ${this.escapeHtml(l)}`).join('<br>');
      const route = (d.route_chain || []).map((r) => r.toUpperCase()).join(' ➔ ');

      const lastReturn = (d.returns || []).slice(-1)[0];
      const showMarked = d.status === 'RETURNED' && lastReturn &&
        (lastReturn.marked_url ||
         (lastReturn.marked_pages && lastReturn.marked_pages.length));

      const myOffices = window.CURRENT_USER_OFFICES || [];
      const canResubmit =
        window.CURRENT_USER_ROLE === 'uploader' &&
        d.status === 'RETURNED' &&
        myOffices.includes(d.origin_office);

      let metaHtml = `
        <strong>File:</strong> ${this.escapeHtml(d.file_name)} |
        <strong>Holder:</strong> <span style="color:var(--gold);">${this.escapeHtml(d.active_recipient.toUpperCase())}</span> |
        <strong>Status:</strong> ${d.status}<br>
        <strong>Route:</strong> ${route}<br>
        <div style="margin-top:0.4rem;padding:0.5rem;background:var(--surface-2);border-radius:3px;font-size:0.8rem;">
          <strong>Audit Trail:</strong><br>${logs}
        </div>`;

      if (showMarked) {
        metaHtml += `
          <div style="margin-top:0.75rem;padding:0.6rem 0.75rem;background:#fee2e2;color:#991b1b;border-left:4px solid #b3232f;border-radius:4px;font-size:0.85rem;">
            <strong>⚠️ RETURNED for correction.</strong>
            Red marks below show what needs fixing. Reason: <em>${this.escapeHtml(lastReturn.reason)}</em>
          </div>`;
      }

      if (canResubmit) {
        metaHtml += `
          <div style="margin-top:0.75rem;display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;">
            <button class="btn btn-primary"
                    onclick="App.resubmit('${d.id}')"
                    style="display:inline-flex;gap:0.5rem;align-items:center;">
              📤 Re-upload Corrected File &amp; Resend
            </button>
            <span style="font-size:0.78rem;color:var(--text-muted);">
              Replaces the file, clears signatures, restarts from ${(d.route_chain[0] || '').toUpperCase()}.
            </span>
          </div>`;
      }

      document.getElementById('previewMeta').innerHTML = metaHtml;

      const c = document.getElementById('previewContainer');
      c.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-muted);">Loading preview…</div>';

      this.openModal('previewModal');
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      const kind = this.detectKind(d);
      const widthHint = showMarked && lastReturn.canvas_width
        ? lastReturn.canvas_width
        : null;

      let wrapper = null;
      try {
        wrapper = await this.renderInline(d, kind, c, { width: widthHint });
      } catch (err) {
        console.error('Preview render failed:', err);
        c.innerHTML = `
          <div style="text-align:center;padding:2rem;">
            <p>Preview couldn't be rendered.</p>
            <a class="btn btn-gold" href="${d.file_url}" target="_blank" download>📥 Download</a>
          </div>`;
      }

      if (showMarked && wrapper) {
        if (lastReturn.marked_pages && lastReturn.marked_pages.length) {
          for (const mp of lastReturn.marked_pages) {
            const pageWrap = c.querySelector(`.pdf-page[data-page="${mp.page}"]`)
                          || c.querySelector('.pdf-page');
            if (!pageWrap) continue;
            const img = document.createElement('img');
            img.src = mp.url;
            img.alt = 'return marks';
            img.style.cssText =
              'position:absolute;top:0;left:0;width:100%;height:100%;' +
              'pointer-events:none;z-index:10;';
            pageWrap.appendChild(img);
          }
        } else if (lastReturn.marked_url) {
          const overlay = document.createElement('img');
          overlay.src = lastReturn.marked_url;
          overlay.style.cssText =
            'position:absolute;top:0;left:0;width:100%;height:auto;' +
            'pointer-events:none;z-index:10;';
          overlay.alt = 'return marks';
          wrapper.appendChild(overlay);
        }
      }

      const returns = d.returns || [];
      let returnsHtml = '';
      if (returns.length > 0) {
        returnsHtml = `
          <div style="margin-top:1rem;">
            <div style="font-weight:bold;color:var(--danger);">
              ↩️ Return History (${returns.length})
            </div>
            ${returns.map((r) => `
              <div style="margin-top:0.6rem;padding:0.6rem 0.75rem;border-left:3px solid var(--danger);background:var(--surface-2);border-radius:4px;font-size:0.85rem;">
                <div style="color:var(--text-muted);font-size:0.78rem;">
                  <strong style="color:var(--danger);">${this.escapeHtml(r.officer)}</strong>
                  — ${new Date(r.timestamp).toLocaleString()}
                  ${r.step ? ` (${this.escapeHtml(r.step)})` : ''}
                </div>
                <div style="margin-top:0.3rem;">${this.escapeHtml(r.reason)}</div>
              </div>
            `).join('')}
          </div>`;
      }

      const gallery = document.getElementById('signatureGallery');
      const sigs = d.signatures || [];
      const sigsHtml = sigs.length === 0 ? '' : `
        <div style="margin-top:1rem;font-weight:bold;color:var(--gold);">✒️ Signatures (${sigs.length})</div>
        <div style="display:flex;flex-wrap:wrap;gap:0.5rem;margin-top:0.5rem;">
          ${sigs.map(s => `
            <div style="display:flex;gap:0.5rem;align-items:center;background:var(--surface-2);border:1px solid var(--gold);border-radius:4px;padding:4px 8px;">
              <img src="${s.url}" style="height:28px;background:#fff;border-radius:2px;padding:2px;" />
              <div style="font-size:0.7rem;line-height:1.1;">
                <strong>${this.escapeHtml(s.step || s.officer)}</strong><br>
                ${new Date(s.timestamp).toLocaleString()}
              </div>
            </div>`).join('')}
        </div>`;

      gallery.innerHTML = returnsHtml + sigsHtml;
    } catch (e) {
      alert('Failed to load preview: ' + e.message);
    }
  },

  // ---------------- resubmit (uploader) ----------------
  async resubmit(docId) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.docx,.xlsx,.png,.jpg,.jpeg';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;

      const ok = confirm(
        `Re-upload "${file.name}" and resend this document?\n\n` +
        `• The current file will be replaced.\n` +
        `• All existing signatures will be cleared.\n` +
        `• The workflow will restart from the first section.`
      );
      if (!ok) return;

      const fd = new FormData();
      fd.append('file', file);

      try {
        await this.api(`/api/documents/${docId}/resubmit`, {
          method: 'POST',
          body: fd,
        });
        alert('Corrected file submitted. The workflow has been restarted.');
        this.closeModal('previewModal');
        if (typeof Upload !== 'undefined' && Upload.refresh) Upload.refresh();
        if (typeof Queue !== 'undefined' && Queue.load) Queue.load();
        if (typeof Queue !== 'undefined' && Queue.loadCO) Queue.loadCO();
        if (typeof Admin !== 'undefined' && Admin.load) Admin.load();
        if (typeof Gallery !== 'undefined' && Gallery.load) Gallery.load();
      } catch (e) {
        alert('Failed: ' + e.message);
      }
    };
    input.click();
  },

  // ---------------- announcements (admin only) ----------------
  openAnnouncementModal()  { this.openModal('announcementModal'); },
  closeAnnouncementModal() { this.closeModal('announcementModal'); },

  async submitAnnouncement(ev) {
    ev.preventDefault();
    const title = document.getElementById('annTitle').value.trim();
    const priority = document.getElementById('annPriority').value;
    const content = document.getElementById('annContent').value.trim();
    if (!title || !content) return;

    try {
      await this.api('/api/announcements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, priority, content }),
      });
      location.reload();
    } catch (e) {
      alert('Failed: ' + e.message);
    }
  },

  async deleteAnnouncement(id) {
    if (!confirm('Delete this announcement?')) return;
    try {
      await this.api(`/api/announcements/${id}`, { method: 'DELETE' });
      location.reload();
    } catch (e) {
      alert('Failed: ' + e.message);
    }
  },

  // ---------------- notification ticker ----------------
  async loadNotifications() {
    const track = document.getElementById('tickerTrack');
    if (!track) return;
    try {
      const notifs = await this.api('/api/notifications');
      track.innerHTML = notifs.map((n) => `
        <a class="ticker-item ${n.priority === 'high' ? 'high' : ''}" href="${n.link}">
          <span class="ticker-icon">${n.icon}</span>
          <span>${this.escapeHtml(n.text)}</span>
        </a>
      `).join('');
    } catch (e) {
      console.error('Notifications failed:', e);
    }
  },
};

document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('tickerTrack')) {
    App.loadNotifications();
    setInterval(() => App.loadNotifications(), 30000);
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest('.nav-btn') && window.innerWidth <= 768) {
      App.toggleMobileNav(false);
    }
  });

  window.addEventListener('resize', () => {
    const areas = document.querySelectorAll('#manualSignRenderArea, #returnRenderArea, #previewContainer');
    areas.forEach((area) => {
      if (area.querySelector('.docx-wrapper')) App.fitDocxToContainer(area);
    });
  });
});