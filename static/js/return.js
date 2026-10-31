const Return = (() => {
  let currentDoc = null;
  let pages = [];             
  let activePage = null;
  let drawing = false;
  let last = null;

  async function open(docId) {
    try {
      currentDoc = await App.api(`/api/documents/${docId}`);
    } catch (e) {
      return alert('Failed to load: ' + e.message);
    }

    document.getElementById('returnReason').value = '';
    document.getElementById('returnModal').classList.add('active');

    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    await renderDoc(currentDoc);
  }

  function close() {
    document.getElementById('returnModal').classList.remove('active');
    currentDoc = null;
    pages = [];
    activePage = null;
    drawing = false;
  }

  function showError(area, loading, msg) {
    console.error('[Return]', msg);
    loading.style.display = 'none';
    area.innerHTML = `<div style="padding:2rem;text-align:center;color:#b3232f;font-size:0.9rem;">
      ⚠️ ${App.escapeHtml(msg)}<br>
      <small style="color:#6b7280;display:block;margin-top:0.5rem;">
        You can still submit a return with a written reason.
      </small>
    </div>`;
  }

  async function renderDoc(doc) {
    const area = document.getElementById('returnRenderArea');
    const loading = document.getElementById('returnLoading');

    area.innerHTML = '';
    loading.style.display = 'block';
    loading.textContent = 'Loading document…';

    pages = [];
    activePage = null;

    const kind = detectKind(doc);

    try {
      if (kind === 'image') {
        await renderImage(doc, area);
      } else if (kind === 'other') {
        return showError(area, loading, 'Preview not available for this file type.');
      } else if (kind === 'pdf') {
        await renderPdf(doc, area);
      } else {
        await renderDocx(doc, area);
      }

      if (!pages.length) {
        showError(area, loading, 'Nothing was rendered.');
      } else {
        loading.style.display = 'none';
      }
    } catch (err) {
      console.error('[Return] render error:', err);
      showError(area, loading, err.message || String(err));
    }
  }

  async function renderPdf(doc, area) {
    if (!window.pdfjsLib) {
      throw new Error('PDF renderer not loaded. Refresh the page.');
    }

    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

    const fetchUrl = doc.preview_url || doc.file_url;
    const resp = await fetch(fetchUrl, { credentials: 'include' });
    if (!resp.ok) throw new Error(`Could not fetch document (HTTP ${resp.status}).`);

    const buf = await resp.arrayBuffer();
    if (buf.byteLength < 100) throw new Error('Document file is empty.');

    const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
    if (!pdf.numPages) throw new Error('The document has no pages.');

    const probe = await pdf.getPage(1);
    const probeVp = probe.getViewport({ scale: 1 });
    const available = Math.max(window.innerWidth - 80, 320);
    const targetWidth = Math.min(available, 900);
    const renderScale = targetWidth / probeVp.width;

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: renderScale });
      const w = Math.ceil(vp.width);
      const h = Math.ceil(vp.height);

      const wrap = document.createElement('div');
      wrap.className = 'return-page-wrap';
      wrap.dataset.page = String(i - 1);
      wrap.style.cssText =
        `position:relative;display:block;width:${w}px;height:${h}px;` +
        `margin:0 auto 15px;`;

      const pageC = document.createElement('canvas');
      pageC.width = w;
      pageC.height = h;
      pageC.style.cssText =
        `display:block;width:${w}px;height:${h}px;background:#fff;`;
      wrap.appendChild(pageC);
      area.appendChild(wrap);

      await page.render({ canvasContext: pageC.getContext('2d'), viewport: vp }).promise;

      const drawC = document.createElement('canvas');
      drawC.className = 'return-draw-canvas';
      drawC.width = w;
      drawC.height = h;
      drawC.style.cssText =
        `position:absolute;top:0;left:0;width:${w}px;height:${h}px;` +
        `cursor:crosshair;touch-action:none;z-index:5;`;
      wrap.appendChild(drawC);

      setupPage(pages.length, wrap, drawC);
    }
  }

  async function renderImage(doc, area) {
    const wrap = document.createElement('div');
    wrap.className = 'return-page-wrap';
    wrap.style.cssText = 'position:relative;display:inline-block;margin:0 auto 15px;';

    const img = document.createElement('img');
    img.style.cssText = 'display:block;max-width:100%;';
    wrap.appendChild(img);
    area.appendChild(wrap);

    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = doc.preview_url || doc.file_url;
    });

    const w = img.clientWidth || img.naturalWidth || 800;
    const h = img.clientHeight || img.naturalHeight || 1000;

    const drawC = document.createElement('canvas');
    drawC.className = 'return-draw-canvas';
    drawC.width = w;
    drawC.height = h;
    drawC.style.cssText =
      `position:absolute;top:0;left:0;width:${w}px;height:${h}px;` +
      `cursor:crosshair;touch-action:none;z-index:5;`;
    wrap.appendChild(drawC);

    setupPage(0, wrap, drawC);
  }

  async function renderDocx(doc, area) {
    const buf = await (await fetch(doc.file_url)).arrayBuffer();
    const holder = document.createElement('div');
    holder.className = 'return-page-wrap';
    holder.style.cssText = 'position:relative;background:#fff;';
    area.appendChild(holder);

    await window.docx.renderAsync(buf, holder, holder, {
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
      renderHeaders: true,
      renderFooters: true,
    });

    const w = holder.clientWidth || 800;
    const h = holder.clientHeight || 1000;

    const drawC = document.createElement('canvas');
    drawC.className = 'return-draw-canvas';
    drawC.width = w;
    drawC.height = h;
    drawC.style.cssText =
      `position:absolute;top:0;left:0;width:${w}px;height:${h}px;` +
      `cursor:crosshair;touch-action:none;z-index:5;`;
    holder.appendChild(drawC);

    setupPage(0, holder, drawC);
  }

  function setupPage(index, wrap, canvas) {
    const entry = {
      index,
      wrap,
      canvas,
      ctx: canvas.getContext('2d'),
      hasInk: false,
      undoStack: [],
    };
    entry.ctx.strokeStyle = '#e11d48';
    entry.ctx.lineWidth = 3;
    entry.ctx.lineCap = 'round';
    entry.ctx.lineJoin = 'round';

    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      const p = e.touches ? e.touches[0] : e;
      return { x: p.clientX - r.left, y: p.clientY - r.top };
    };

    const pushUndo = () => {
      try { entry.undoStack.push(canvas.toDataURL()); } catch {}
      if (entry.undoStack.length > 20) entry.undoStack.shift();
    };

    const down = (e) => {
      activePage = entry;
      pushUndo();
      drawing = true;
      last = pos(e);
      e.preventDefault();
    };
    const move = (e) => {
      if (!drawing || activePage !== entry) return;
      const p = pos(e);
      entry.ctx.beginPath();
      entry.ctx.moveTo(last.x, last.y);
      entry.ctx.lineTo(p.x, p.y);
      entry.ctx.stroke();
      last = p;
      entry.hasInk = true;
      e.preventDefault();
    };
    const up = () => { drawing = false; };

    canvas.addEventListener('mousedown', down);
    canvas.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    canvas.addEventListener('touchstart', down, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', up);

    pages.push(entry);
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

  function clearMarks() {
    for (const p of pages) {
      p.ctx.clearRect(0, 0, p.canvas.width, p.canvas.height);
      p.hasInk = false;
      p.undoStack = [];
    }
    activePage = null;
  }

  function undoLast() {
    const target = activePage && activePage.undoStack.length
      ? activePage
      : [...pages].reverse().find((p) => p.hasInk && p.undoStack.length);
    if (!target) return;
    const prev = target.undoStack.pop();
    const img = new Image();
    img.onload = () => {
      target.ctx.clearRect(0, 0, target.canvas.width, target.canvas.height);
      target.ctx.drawImage(img, 0, 0);
    };
    img.src = prev;
  }

  async function submit() {
    if (!currentDoc) return;
    const docId = currentDoc.id; // <--- CAPTURED SAFELY HERE
    
    const reason = document.getElementById('returnReason').value.trim();
    if (!reason) return alert('Please describe the mistake that needs correcting.');

    const btn = document.getElementById('submitReturnBtn');
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Submitting…';

    try {
      const markedPages = [];
      for (const p of pages) {
        if (!p.hasInk) continue;
        const blob = await new Promise((res) => p.canvas.toBlob(res, 'image/png'));
        const fd = new FormData();
        fd.append('file', blob, `marks_${docId}_p${p.index}_${Date.now()}.png`);
        const up = await App.api('/api/documents/upload-return-mark', { method: 'POST', body: fd });
        markedPages.push({
          page: p.index,
          url: up.url,
          path: up.path,
        });
      }

      await App.api(`/api/documents/${docId}/return`, { // <--- USES docId SAFELY
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason,
          marked_pages: markedPages,
        }),
      });

      close();
      if (typeof Queue !== 'undefined' && Queue.load) Queue.load();
      if (typeof Queue !== 'undefined' && Queue.loadCO) Queue.loadCO();
      if (typeof Upload !== 'undefined' && Upload.refresh) Upload.refresh();
      if (typeof Admin !== 'undefined' && Admin.load) Admin.load();
    } catch (e) {
      alert('Failed: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  return { open, close, clearMarks, undoLast, submit };
})();