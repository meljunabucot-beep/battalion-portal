const Chat = (() => {
  let isOpen = false;
  let activeWith = null;
  let conversations = [];
  let currentMsgs = [];
  let unreadTimer = null;
  let threadTimer = null;
  let convTimer = null;
  let lastThreadSig = null;
  let editingMessageId = null;
  let openMenuMsgId = null;

  const $ = (id) => document.getElementById(id);

  // ---------- mobile viewport ----------
  function syncViewport() {
    const panel = $('chatPanel');
    if (!panel) return;

    const isMobile = window.matchMedia('(max-width: 600px)').matches;
    if (!isMobile || !panel.classList.contains('open')) {
      panel.style.top = '';
      panel.style.height = '';
      panel.style.bottom = '';
      return;
    }

    const vv = window.visualViewport;
    if (!vv) return;

    panel.style.top = vv.offsetTop + 'px';
    panel.style.height = vv.height + 'px';
    panel.style.bottom = 'auto';

    const thread = $('chatThread');
    if (thread) thread.scrollTop = thread.scrollHeight;
  }

  // ---------- FAB badge ----------
  async function refreshUnread() {
    try {
      const { count } = await App.api('/api/messages/unread');
      const badge = $('chatFabBadge');
      if (count > 0) {
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.style.display = 'flex';
      } else {
        badge.style.display = 'none';
      }
    } catch (e) { /* silent */ }
  }

  function startUnreadPolling() {
    refreshUnread();
    if (unreadTimer) clearInterval(unreadTimer);
    unreadTimer = setInterval(refreshUnread, 30000);
  }

  // ---------- panel open/close ----------
  function toggle() {
    if (isOpen) close();
    else open();
  }

  function open() {
    isOpen = true;
    $('chatPanel').classList.add('open');
    showListView();
    loadConversations();
    startConvPolling();
    refreshUnread();
    syncViewport();
  }

  function close() {
    isOpen = false;
    $('chatPanel').classList.remove('open');
    $('chatPanel').style.top = '';
    $('chatPanel').style.height = '';
    $('chatPanel').style.bottom = '';
    activeWith = null;
    cancelEdit();
    hideMsgMenu();
    stopThreadPolling();
    stopConvPolling();
    showListView();
  }

  // ---------- conversation list ----------
  function showListView() {
    $('chatListView').style.display = 'flex';
    $('chatThreadView').style.display = 'none';
    $('chatBackBtn').style.display = 'none';
    $('chatTitle').textContent = 'Messages';
  }

  function showThreadView(username) {
    $('chatListView').style.display = 'none';
    $('chatThreadView').style.display = 'flex';
    $('chatBackBtn').style.display = 'inline-block';
    $('chatTitle').textContent = username;
  }

  function back() {
    activeWith = null;
    cancelEdit();
    hideMsgMenu();
    stopThreadPolling();
    showListView();
    loadConversations();
    startConvPolling();
    refreshUnread();
  }

  async function loadConversations() {
    try {
      const data = await App.api('/api/messages/conversations');
      conversations = data.conversations || [];
      renderList();
    } catch (e) {
      $('chatConvList').innerHTML =
        `<div class="chat-empty" style="color:var(--danger);">Failed to load: ${App.escapeHtml(e.message)}</div>`;
    }
  }

  function renderList() {
    const q = ($('chatSearch')?.value || '').trim().toLowerCase();
    const filtered = conversations.filter((c) =>
      !q || c.with.toLowerCase().includes(q)
    );

    if (!filtered.length) {
      $('chatConvList').innerHTML =
        '<div class="chat-empty">No users found.</div>';
      return;
    }

    $('chatConvList').innerHTML = filtered.map((c) => {
      const initial = c.with.slice(0, 1).toUpperCase();
      const hue = hashHue(c.with);
      const last = c.last
        ? `${c.last_from === 'me' ? 'You: ' : ''}${App.escapeHtml(c.last)}`
        : '<em style="opacity:0.6;">No messages yet</em>';
      const unread = c.unread > 0
        ? `<span class="chat-conv-unread">${c.unread}</span>` : '';
      
      const deleteBtn = `
        <button type="button" class="chat-conv-delete" title="Delete conversation"
                onclick="Chat.deleteConv(event, '${App.escapeHtml(c.with)}')">🗑️</button>
      `;

      return `
        <div class="chat-conv-item" onclick="Chat.openThread('${App.escapeHtml(c.with)}')">
          <div class="chat-avatar" style="background:hsl(${hue},45%,35%);">${initial}</div>
          <div class="chat-conv-body">
            <div class="chat-conv-name">${App.escapeHtml(c.with)}
              <span class="chat-conv-role">${App.escapeHtml(c.role || '')}</span>
            </div>
            <div class="chat-conv-preview">${last}</div>
          </div>
          ${unread}
          ${deleteBtn}
        </div>`;
    }).join('');
  }

  function filter() {
    renderList();
  }

  function startConvPolling() {
    stopConvPolling();
    convTimer = setInterval(() => {
      if (isOpen && !activeWith) loadConversations();
    }, 10000);
  }

  function stopConvPolling() {
    if (convTimer) { clearInterval(convTimer); convTimer = null; }
  }

  // ---------- thread ----------
  async function openThread(username) {
    activeWith = username;
    lastThreadSig = null;
    cancelEdit();
    hideMsgMenu();
    showThreadView(username);
    stopConvPolling();
    $('chatThread').innerHTML = '<div class="chat-empty">Loading…</div>';
    await loadThread();
    await markRead();
    startThreadPolling();
    setTimeout(() => $('chatInput')?.focus(), 60);
  }

  async function loadThread() {
    if (!activeWith) return;
    try {
      const msgs = await App.api(`/api/messages/thread/${encodeURIComponent(activeWith)}`);
      const sig = (msgs.length ? msgs[msgs.length - 1].id : '') + ':' + msgs.length;
      currentMsgs = msgs;
      if (sig === lastThreadSig) return;
      lastThreadSig = sig;
      renderThread(msgs);
    } catch (e) {
      $('chatThread').innerHTML =
        `<div class="chat-empty" style="color:var(--danger);">${App.escapeHtml(e.message)}</div>`;
    }
  }

  function renderThread(msgs) {
    const me = window.CURRENT_USER;
    const container = $('chatThread');
    if (!msgs.length) {
      container.innerHTML = '<div class="chat-empty">No messages yet. Say hello.</div>';
      return;
    }
    const atBottom = (container.scrollHeight - container.scrollTop - container.clientHeight) < 60;

    container.innerHTML = msgs.map((m) => {
      const mine = m.sender === me;
      const t = new Date(m.created_at).toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit',
      });
      const d = new Date(m.created_at).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric',
      });
      const editedTag = m.edited_at ? ' • <em>edited</em>' : '';
      const readTag = mine ? (m.read_at ? ' • Read' : '') : '';
      const menuBtn = mine
        ? `<button type="button" class="chat-msg-menu-btn" title="Options"
                   onclick="Chat.showMsgMenu(event, '${m.id}')">⋯</button>`
        : '';
      return `
        <div class="chat-msg ${mine ? 'me' : 'them'}" data-msg-id="${m.id}">
          <div class="chat-msg-bubble">
            ${menuBtn}
            <span class="chat-msg-text">${App.escapeHtml(m.content)}</span>
          </div>
          <div class="chat-msg-meta">${d} • ${t}${editedTag}${readTag}</div>
        </div>`;
    }).join('');

    if (atBottom) container.scrollTop = container.scrollHeight;
  }

  async function markRead() {
    if (!activeWith) return;
    try {
      await App.api(`/api/messages/thread/${encodeURIComponent(activeWith)}/read`, {
        method: 'POST',
      });
      refreshUnread();
    } catch (e) { /* silent */ }
  }

  function startThreadPolling() {
    stopThreadPolling();
    threadTimer = setInterval(() => {
      if (isOpen && activeWith) {
        loadThread();
        markRead();
      }
    }, 5000);
  }

  function stopThreadPolling() {
    if (threadTimer) { clearInterval(threadTimer); threadTimer = null; }
  }

  // ---------- message menu ----------
  function showMsgMenu(ev, msgId) {
    ev.stopPropagation();
    const menu = $('chatMsgMenu');
    if (!menu) return;

    const btnRect = ev.currentTarget.getBoundingClientRect();
    menu.style.display = 'block';

    const menuRect = menu.getBoundingClientRect();

    let left = btnRect.right - menuRect.width;
    if (left < 8) left = 8;
    if (left + menuRect.width > window.innerWidth - 8) {
      left = window.innerWidth - menuRect.width - 8;
    }

    const GAP = 6;
    let top;
    if (btnRect.top >= menuRect.height + GAP) {
      top = btnRect.top - menuRect.height - GAP;
    } else if (window.innerHeight - btnRect.bottom >= menuRect.height + GAP) {
      top = btnRect.bottom + GAP;
    } else {
      top = Math.max(
        8,
        Math.min(window.innerHeight - menuRect.height - 8, btnRect.bottom + GAP)
      );
    }

    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    openMenuMsgId = msgId;
  }

  function hideMsgMenu() {
    const menu = $('chatMsgMenu');
    if (menu) menu.style.display = 'none';
    openMenuMsgId = null;
  }

  function startEdit() {
    if (!openMenuMsgId) return;
    const m = currentMsgs.find((x) => x.id === openMenuMsgId);
    hideMsgMenu();
    if (!m) return;

    editingMessageId = m.id;
    const input = $('chatInput');
    input.value = m.content;
    input.focus();
    $('chatEditBanner').style.display = 'flex';
    $('chatEditPreview').textContent = m.content;
    $('chatSendBtn').textContent = 'Save';
  }

  function cancelEdit() {
    editingMessageId = null;
    const banner = $('chatEditBanner');
    if (banner) banner.style.display = 'none';
    const sendBtn = $('chatSendBtn');
    if (sendBtn) sendBtn.textContent = 'Send';
    const input = $('chatInput');
    if (input && editingMessageId === null && !input.dataset.keepValue) {
      input.value = '';
    }
  }

  async function unsend() {
    if (!openMenuMsgId) return;
    const id = openMenuMsgId;
    hideMsgMenu();
    if (!confirm('Unsend this message? It will be removed for both sides.')) return;
    try {
      await App.api(`/api/messages/${id}`, { method: 'DELETE' });
      lastThreadSig = null;
      await loadThread();
    } catch (e) {
      alert('Failed to unsend: ' + e.message);
    }
  }

  async function deleteConv(ev, username) {
    ev.stopPropagation();
    if (!confirm(`Delete the entire conversation with ${username}?\n\nThis will remove all messages for both sides.`)) return;
    try {
      await App.api(`/api/messages/thread/${encodeURIComponent(username)}`, { method: 'DELETE' });
      if (activeWith === username) {
        back();
      }
      await loadConversations();
      refreshUnread();
    } catch (e) {
      alert('Failed to delete conversation: ' + e.message);
    }
  }

  // ---------- send / save ----------
  async function send(ev) {
    ev.preventDefault();
    const input = $('chatInput');
    const content = input.value.trim();
    if (!content || !activeWith) return;

    if (editingMessageId) {
      const id = editingMessageId;
      const sendBtn = $('chatSendBtn');
      sendBtn.disabled = true;
      try {
        await App.api(`/api/messages/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        });
        input.value = '';
        editingMessageId = null;
        $('chatEditBanner').style.display = 'none';
        sendBtn.textContent = 'Send';
        lastThreadSig = null;
        await loadThread();
      } catch (e) {
        alert('Failed to edit: ' + e.message);
      } finally {
        sendBtn.disabled = false;
      }
      return;
    }

    input.value = '';
    try {
      await App.api(`/api/messages/thread/${encodeURIComponent(activeWith)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      lastThreadSig = null;
      await loadThread();
      const t = $('chatThread');
      t.scrollTop = t.scrollHeight;
    } catch (e) {
      alert('Failed to send: ' + e.message);
      input.value = content;
    }
  }

  // ---------- helpers ----------
  function hashHue(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffffff;
    return Math.abs(h) % 360;
  }

  // ---------- boot ----------
  document.addEventListener('DOMContentLoaded', () => {
    if (!$('chatFab')) return;
    startUnreadPolling();

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncViewport);
      window.visualViewport.addEventListener('scroll', syncViewport);
    }
    window.addEventListener('orientationchange', () => {
      setTimeout(syncViewport, 200);
    });
    window.addEventListener('resize', syncViewport);

    const input = $('chatInput');
    if (input) {
      input.addEventListener('focus', () => setTimeout(syncViewport, 100));
      input.addEventListener('focus', () => setTimeout(syncViewport, 350));
      input.addEventListener('blur',  () => setTimeout(syncViewport, 100));
    }

    document.addEventListener('click', (e) => {
      const menu = $('chatMsgMenu');
      if (!menu || menu.style.display !== 'block') return;
      if (e.target.closest('#chatMsgMenu')) return;
      if (e.target.closest('.chat-msg-menu-btn')) return;
      hideMsgMenu();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (editingMessageId) {
        cancelEdit();
        const inp = $('chatInput');
        if (inp) inp.value = '';
      } else {
        hideMsgMenu();
      }
    });
  });

  return {
    toggle, open, close, back,
    openThread, send, filter,
    showMsgMenu, startEdit, unsend, cancelEdit,
    deleteConv,
  };
})();