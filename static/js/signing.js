const Signing = (() => {
  let pad = null;
  let currentDoc = null;
  let kind = null;
  let placedSigs = [];
  let currentSigDataUrl = null;

  const SAVED_SIG_PREFIX = 'savedSignature::';

  // ---------- pad ----------
  function initPad(canvas) {
    const state = { hasInk: false, drawing: false, last: null, sized: false };

    function resize() {
      const r = canvas.getBoundingClientRect();
      if (r.width < 5 || r.height < 5) return;
      const ratio = window.devicePixelRatio || 1;
      const prev = state.hasInk ? canvas.toDataURL() : null;

      canvas.width = Math.round(r.width * ratio);
      canvas.height = Math.round(r.height * ratio);

      const ctx = canvas.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(ratio, ratio);
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#1e40af';

      state.ctx = ctx;

      if (prev) {
        const img = new Image();
        img.onload = () => {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        };
        img.src = prev;
      }
      state.sized = true;
    }

    resize();

    let _resizeTimer = null;
    window.addEventListener('resize', () => {
      if (_resizeTimer) clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(() => {
        _resizeTimer = null;
        resize();
      }, 150);
    });

    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      const p = e.touches ? e.touches[0] : e;
      return { x: p.clientX - r.left, y: p.clientY - r.top };
    };

    const start = (e) => {
      if (!state.sized) resize();
      state.drawing = true;
      state.last = pos(e);
      e.preventDefault();
    };
    const move = (e) => {
      if (!state.drawing || !state.ctx) return;
      const p = pos(e);
      state.ctx.beginPath();
      state.ctx.moveTo(state.last.x, state.last.y);
      state.ctx.lineTo(p.x, p.y);
      state.ctx.stroke();
      state.last = p;
      state.hasInk = true;
      refreshSavedButtons();
      e.preventDefault();
    };
    const end = () => { state.drawing = false; };

    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);

    return {
      canvas,
      hasInk: () => state.hasInk,
      clear() {
        if (!state.ctx) resize();
        state.ctx.save();
        state.ctx.setTransform(1, 0, 0, 1, 0, 0);
        state.ctx.clearRect(0, 0, canvas.width, canvas.height);
        state.ctx.restore();
        state.hasInk = false;
        refreshSavedButtons();
      },
      toBlob: () => new Promise((res) => canvas.toBlob(res, 'image/png')),
      toDataUrl: () => canvas.toDataURL('image/png'),

      load(dataUrl, opts = {}) {
        return new Promise((resolve, reject) => {
          const ctx = canvas.getContext('2d');
          const r = canvas.getBoundingClientRect();
          const ratio = window.devicePixelRatio || 1;

          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.restore();

          const img = new Image();
          img.onload = () => {
            const scale = Math.min(r.width / img.width, r.height / img.height);
            const w = img.width * scale;
            const h = img.height * scale;
            ctx.save();
            ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
            ctx.drawImage(img, (r.width - w) / 2, (r.height - h) / 2, w, h);
            ctx.restore();

            if (opts.removeWhite) {
              try {
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const data = imageData.data;
                for (let i = 0; i < data.length; i += 4) {
                  if (data[i] >= 240 && data[i + 1] >= 240 && data[i + 2] >= 240) {
                    data[i + 3] = 0;
                  }
                }
                ctx.putImageData(imageData, 0, 0);
              } catch (e) {
                console.warn('White-removal skipped:', e);
              }
            }

            state.hasInk = true;
            refreshSavedButtons();
            resolve();
          };
          img.onerror = () => reject(new Error('Not a valid image'));
          img.src = dataUrl;
        });
      },
    };
  }

  // ---------- saved signature ----------
  const savedKey = () => `${SAVED_SIG_PREFIX}${window.CURRENT_USER}`;
  const getSaved  = () => { try { return localStorage.getItem(savedKey()); } catch { return null; } };
  const setSaved  = (v) => { try { localStorage.setItem(savedKey(), v); } catch {} };
  const rmSaved   = () => { try { localStorage.removeItem(savedKey()); } catch {} };

  function refreshSavedButtons() {
    const useBtn    = document.getElementById('useSavedSigBtn');
    const forgetBtn = document.getElementById('clearSavedSigBtn');
    const saveBtn   = document.getElementById('saveSigBtn');
    if (!useBtn || !saveBtn || !forgetBtn) return;

    const hasSaved = !!getSaved();
    useBtn.style.display = hasSaved ? 'inline-block' : 'none';
    forgetBtn.style.display = hasSaved ? 'inline-block' : 'none';
    saveBtn.disabled = !(pad && pad.hasInk());
  }

  function useSaved() { const s = getSaved(); if (s && pad) pad.load(s); }

  function saveSaved() {
    if (!pad || !pad.hasInk()) return alert('Draw or upload a signature first.');
    setSaved(pad.toDataUrl());
    refreshSavedButtons();
    alert('Signature saved for this account.');
  }

  function forgetSaved() {
    if (!confirm('Forget your saved signature?')) return;
    rmSaved();
    refreshSavedButtons();
  }

  function uploadSignature() {
    const input = document.getElementById('sigUploadInput');
    if (!input) return;
    input.value = '';
    input.click();
  }

  async function handleSignatureUpload(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    input.value = '';

    if (!file.type.startsWith('image/')) {
      alert('Please select an image file (PNG or JPEG).');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      alert('Signature file must be under 2 MB.');
      return;
    }

    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('Could not read file'));
        reader.readAsDataURL(file);
      });
      await pad.load(dataUrl, { removeWhite: true });
    } catch (err) {
      console.error('Signature upload failed:', err);
      alert('Could not load that image: ' + err.message);
    }
  }

  function detectKind(doc) {
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
  }

  // ---------- open ----------
  async function open(docId) {
    if (window.CURRENT_USER_ROLE === 'admin') {
      return alert('Admins cannot sign documents. Only the assigned officer or the CO can sign.');
    }
    try {
      currentDoc = await App.api(`/api/documents/${docId}`);
    } catch (e) {
      return alert('Failed to load: ' + e.message);
    }
    kind = detectKind(currentDoc);

    const isFinal = currentDoc.current_step_index === (currentDoc.route_chain || []).length - 1;

    document.getElementById('sigHint').textContent = isFinal
      ? 'Draw or upload your signature, then place it on the document. You can place multiple copies. As the final approver, this seals the signed PDF.'
      : 'Draw or upload your signature, then place it on the document. You can place multiple copies if needed. Confirm to advance to the next section.';

    const btn = document.getElementById('confirmManualSignBtn');
    btn.disabled = true;
    btn.textContent = isFinal ? '✅ Confirm & Approve' : '✅ Confirm & Approve';
    btn.dataset.baseLabel = btn.textContent;

    document.getElementById('manualSignModal').classList.add('active');

    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    if (!pad) pad = initPad(document.getElementById('manualSigCanvas'));
    pad.clear();

    const savedSig = getSaved();
    if (savedSig) pad.load(savedSig);
    refreshSavedButtons();

    placedSigs = [];
    currentSigDataUrl = null;

    await renderPreview(currentDoc);
  }

  async function renderPreview(doc) {
    const area = document.getElementById('manualSignRenderArea');
    const loading = document.getElementById('manualSignLoading');

    area.innerHTML = '';
    area.style.position = 'relative';
    loading.style.display = 'block';
    loading.textContent = 'Loading document preview…';

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:relative;background:#fff;color:#111;';
    area.appendChild(wrapper);

    const holder = document.createElement('div');
    holder.style.cssText = 'background:#fff;color:#111;overflow-x:auto;';
    wrapper.appendChild(holder);

    try {
      if (kind === 'image') {
        const img = document.createElement('img');
        img.style.cssText = 'max-width:100%;max-height:500px;display:block;margin:0 auto;';
        holder.appendChild(img);
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = doc.preview_url || doc.file_url; });

      } else if (kind === 'other') {
        holder.innerHTML = `<div style="padding:2rem;text-align:center;">
          Preview unavailable. <a href="${doc.file_url}" target="_blank">Open original</a>
        </div>`;

      } else if (kind === 'pdf') {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

        const fetchUrl = doc.preview_url || doc.file_url;
        const buf = await (await fetch(fetchUrl)).arrayBuffer();
        const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;

        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const vp = page.getViewport({ scale: 1.5 });

          const pageWrap = document.createElement('div');
          pageWrap.className = 'pdf-page';
          pageWrap.dataset.page = String(i - 1);
          pageWrap.style.cssText = 'position:relative;margin:0 auto 15px;width:fit-content;';

          const c = document.createElement('canvas');
          c.width = vp.width;
          c.height = vp.height;
          c.style.cssText = 'display:block;';
          pageWrap.appendChild(c);
          holder.appendChild(pageWrap);

          await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        }

      } else {
        const buf = await (await fetch(doc.file_url)).arrayBuffer();
        await window.docx.renderAsync(buf, holder, holder, {
          inWrapper: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: false,
          renderHeaders: true,
          renderFooters: true,
        });
      }
      loading.style.display = 'none';
    } catch (err) {
      console.error('Preview render error:', err);
      loading.textContent = '⚠️ Preview failed — you can still place your signature below.';
    }

    (doc.signatures || []).forEach((s) => {
      if (s.x === undefined || s.y === undefined) return;

      const pageIdx = (s.page !== undefined && s.page !== null) ? String(s.page) : '0';
      const targetPage = area.querySelector(`.pdf-page[data-page="${pageIdx}"]`)
                        || area.querySelector('.pdf-page')
                        || area;

      const wrap = document.createElement('div');
      wrap.className = 'placed-signature placed-signature-readonly';
      wrap.style.left = s.x + 'px';
      wrap.style.top = s.y + 'px';
      if (s.width) wrap.style.width = s.width + 'px';
      wrap.style.pointerEvents = 'none';

      const img = document.createElement('img');
      img.src = s.url;
      img.style.width = '100%';
      wrap.appendChild(img);

      const lbl = document.createElement('div');
      lbl.className = 'placed-signature-label';
      lbl.textContent = `✓ ${s.step || s.officer}`;
      wrap.appendChild(lbl);

      targetPage.appendChild(wrap);
    });
  }

  // ---------- place ----------
  function place() {
    if (!pad || !pad.hasInk()) return alert('Draw or upload a signature first.');

    const area = document.getElementById('manualSignRenderArea');
    const scrollWrap = document.getElementById('manualSignRenderWrap');

    const pageEl = findVisiblePage() || area;

    currentSigDataUrl = pad.toDataUrl();

    const el = document.createElement('div');
    el.className = 'placed-signature';

    const defaultWidth = window.innerWidth <= 768 ? 90 : 150;
    el.style.width = defaultWidth + 'px';

    const pr = pageEl.getBoundingClientRect();
    const sr = scrollWrap ? scrollWrap.getBoundingClientRect() : pr;

    const visibleTop = Math.max(0, sr.top - pr.top);
    const visibleBottom = Math.min(pr.height, sr.bottom - pr.top);
    const visibleHeight = Math.max(40, visibleBottom - visibleTop);

    let leftPx = Math.max(0, (pr.width - defaultWidth) / 2);
    let topPx = visibleTop + (visibleHeight / 2) - 30;

    const sigH = Math.max(40, defaultWidth * 0.4);
    topPx = Math.max(0, Math.min(pr.height - sigH, topPx));
    leftPx = Math.max(0, Math.min(pr.width - defaultWidth, leftPx));

    el.style.left = leftPx + 'px';
    el.style.top  = topPx + 'px';

    const img = document.createElement('img');
    img.src = currentSigDataUrl;
    el.appendChild(img);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'placed-sig-remove';
    removeBtn.textContent = '✖';
    removeBtn.title = 'Remove this signature';
    removeBtn.onclick = (ev) => {
      ev.stopPropagation();
      el.remove();
      placedSigs = placedSigs.filter((p) => p.el !== el);
      updateConfirmButton();
    };
    el.appendChild(removeBtn);

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'placed-sig-resize';
    resizeHandle.title = 'Drag to resize';
    el.appendChild(resizeHandle);

    pageEl.appendChild(el);
    makeDraggable(el, pageEl);
    makeResizable(el, resizeHandle);

    placedSigs.push({ el, dataUrl: currentSigDataUrl, container: pageEl });
    updateConfirmButton();
  }

  function findVisiblePage() {
    const area = document.getElementById('manualSignRenderArea');
    if (!area) return null;
    const pages = area.querySelectorAll('.pdf-page');
    if (!pages.length) return null;

    const wrap = document.getElementById('manualSignRenderWrap');
    if (!wrap) return pages[0];

    const wr = wrap.getBoundingClientRect();
    const viewportCenterY = wr.top + wr.height / 2;

    for (const p of pages) {
      const pr = p.getBoundingClientRect();
      if (pr.top <= viewportCenterY && pr.bottom >= viewportCenterY) return p;
    }
    for (const p of pages) {
      const pr = p.getBoundingClientRect();
      if (pr.bottom > wr.top && pr.top < wr.bottom) return p;
    }
    return pages[0];
  }

  function updateConfirmButton() {
    const btn = document.getElementById('confirmManualSignBtn');
    btn.disabled = placedSigs.length === 0;
    const base = btn.dataset.baseLabel || btn.textContent.replace(/^\(\d+\)\s*/, '');
    btn.dataset.baseLabel = base;
    btn.textContent = placedSigs.length > 1
      ? `(${placedSigs.length}) ${base}`
      : base;
  }

  function makeDraggable(el, container) {
    let dragging = false, ox = 0, oy = 0;
    let lastX = 0, lastY = 0;
    let autoScrollDir = 0;
    let autoScrollRAF = null;

    function getScrollParent(node) {
      let p = node?.parentElement;
      while (p && p !== document.body) {
        const style = window.getComputedStyle(p);
        if (/(auto|scroll)/.test(style.overflowY) && p.scrollHeight > p.clientHeight) {
          return p;
        }
        p = p.parentElement;
      }
      return null;
    }

    function updatePosition() {
      const cr = container.getBoundingClientRect();
      el.style.left = Math.max(0, lastX - cr.left - ox) + 'px';
      el.style.top  = Math.max(0, lastY - cr.top  - oy) + 'px';
    }

    function tickAutoScroll() {
      autoScrollRAF = null;
      if (!dragging || autoScrollDir === 0) return;
      const sp = getScrollParent(container);
      if (sp) {
        sp.scrollTop += autoScrollDir * 14;
        updatePosition();
      }
      autoScrollRAF = requestAnimationFrame(tickAutoScroll);
    }

    function checkAutoScroll(clientY) {
      const sp = getScrollParent(container);
      if (!sp) { autoScrollDir = 0; return; }
      const sr = sp.getBoundingClientRect();
      const EDGE = 80;
      if (clientY > sr.bottom - EDGE) {
        autoScrollDir = 1;
        if (!autoScrollRAF) autoScrollRAF = requestAnimationFrame(tickAutoScroll);
      } else if (clientY < sr.top + EDGE) {
        autoScrollDir = -1;
        if (!autoScrollRAF) autoScrollRAF = requestAnimationFrame(tickAutoScroll);
      } else {
        autoScrollDir = 0;
      }
    }

    const down = (e) => {
      if (e.target.closest('.placed-sig-remove')) return;
      dragging = true;
      el.classList.add('dragging');
      const p = e.touches ? e.touches[0] : e;
      const r = el.getBoundingClientRect();
      ox = p.clientX - r.left;
      oy = p.clientY - r.top;
      lastX = p.clientX;
      lastY = p.clientY;
      e.preventDefault();
    };

    const move = (e) => {
      if (!dragging) return;
      const p = e.touches ? e.touches[0] : e;
      lastX = p.clientX;
      lastY = p.clientY;
      updatePosition();
      checkAutoScroll(p.clientY);
      e.preventDefault();
    };

    const up = () => {
      dragging = false;
      autoScrollDir = 0;
      if (autoScrollRAF) { cancelAnimationFrame(autoScrollRAF); autoScrollRAF = null; }
      el.classList.remove('dragging');
    };

    el.addEventListener('mousedown', down);
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    el.addEventListener('touchstart', down, { passive: false });
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', up);
  }

  function makeResizable(el, handle) {
    let resizing = false;
    let startX = 0;
    let startWidth = 0;
    const MIN_W = 40;
    const MAX_W = 800;

    const onDown = (e) => {
      resizing = true;
      el.classList.add('resizing');
      const p = e.touches ? e.touches[0] : e;
      startX = p.clientX;
      startWidth = el.getBoundingClientRect().width;
      e.preventDefault();
      e.stopPropagation();
    };

    const onMove = (e) => {
      if (!resizing) return;
      const p = e.touches ? e.touches[0] : e;
      const deltaX = p.clientX - startX;
      let newWidth = Math.max(MIN_W, Math.min(MAX_W, startWidth + deltaX));
      el.style.width = newWidth + 'px';
      e.preventDefault();
    };

    const onUp = () => {
      resizing = false;
      el.classList.remove('resizing');
    };

    handle.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    handle.addEventListener('touchstart', onDown, { passive: false });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
  }

  // ---------- locate a signature on a PDF page ----------
  function locateSignature(el, area) {
    const elRect = el.getBoundingClientRect();
    const cx = elRect.left + elRect.width / 2;
    const cy = elRect.top + elRect.height / 2;

    const pages = area.querySelectorAll('.pdf-page');
    for (let i = 0; i < pages.length; i++) {
      const pr = pages[i].getBoundingClientRect();
      if (cx >= pr.left && cx <= pr.right && cy >= pr.top && cy <= pr.bottom) {
        return {
          page: i,
          x: elRect.left - pr.left,
          y: elRect.top - pr.top,
          width: elRect.width,
          height: elRect.height,
          page_width: pr.width,
          page_height: pr.height,
        };
      }
    }
    return null;
  }

  // ---------- confirm ----------
  async function confirm() {
    if (placedSigs.length === 0 || !currentDoc) {
      return alert('Place at least one signature on the document first.');
    }

    const btn = document.getElementById('confirmManualSignBtn');
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Saving…';

    const area = document.getElementById('manualSignRenderArea');

    try {
      // 1. Upload each unique signature PNG
      const uniqueDataUrls = [...new Set(placedSigs.map((p) => p.dataUrl))];
      const uploaded = {};
      let idx = 0;
      for (const dataUrl of uniqueDataUrls) {
        const blob = await (await fetch(dataUrl)).blob();
        const fd = new FormData();
        fd.append('file', blob, `sig_${currentDoc.id}_${Date.now()}_${idx}.png`);
        const up = await App.api('/api/documents/upload-signature', { method: 'POST', body: fd });
        uploaded[dataUrl] = up.url;
        idx++;
      }

      // 2. Build the signature records with page + position info
      const sigRecords = placedSigs.map((p) => {
        const loc = locateSignature(p.el, area);
        const img = p.el.querySelector('img');
        const rect = img.getBoundingClientRect();

        if (loc) {
          return {
            step: currentDoc.active_recipient,
            officer: window.CURRENT_USER,
            url: uploaded[p.dataUrl],
            page: loc.page,
            x: loc.x,
            y: loc.y,
            width: loc.width,
            height: loc.height,
            page_width: loc.page_width,
            page_height: loc.page_height,
            timestamp: new Date().toISOString(),
          };
        }

        return {
          step: currentDoc.active_recipient,
          officer: window.CURRENT_USER,
          url: uploaded[p.dataUrl],
          page: 0,
          x: parseFloat(p.el.style.left) || 0,
          y: parseFloat(p.el.style.top) || 0,
          width: rect.width,
          height: rect.height,
          page_width: null,
          page_height: null,
          timestamp: new Date().toISOString(),
        };
      });

      // 3. POST to server
      await App.api(`/api/documents/${currentDoc.id}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signatures: sigRecords }),
      });

      pad.clear();
      placedSigs = [];
      close();

      // --- AUTO REFRESH LOGIC ---
      if (window.location.pathname === '/co') {
          if (typeof Queue !== 'undefined' && typeof Queue.loadCO === 'function') {
              await Queue.loadCO();
          }
      } else {
          if (typeof Queue !== 'undefined' && typeof Queue.load === 'function') {
              await Queue.load();
          }
      }
      
      if (typeof Upload !== 'undefined' && typeof Upload.refresh === 'function') Upload.refresh();
      if (typeof Admin !== 'undefined' && typeof Admin.load === 'function') Admin.load();
      if (typeof Gallery !== 'undefined' && typeof Gallery.load === 'function') Gallery.load();
      if (typeof App !== 'undefined' && typeof App.loadNotifications === 'function') App.loadNotifications();

    } catch (e) {
      alert('Failed: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  function close() {
    document.getElementById('manualSignModal').classList.remove('active');
    currentDoc = null;
    placedSigs = [];
    currentSigDataUrl = null;
  }

  return {
    open, close, place, confirm,
    clearPad: () => pad && pad.clear(),
    useSaved, saveSaved, forgetSaved,
    uploadSignature, handleSignatureUpload,
  };
})();