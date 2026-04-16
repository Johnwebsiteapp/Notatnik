// ===== Supabase config =====
const SUPABASE_URL = 'https://lfajvdairiuqstkygrnp.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxmYWp2ZGFpcml1cXN0a3lncm5wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxNzUyNTIsImV4cCI6MjA5MTc1MTI1Mn0.j7OeYS3plpkDdy75MMo_vhO9ZSBN8OWM_pUirNvxkI0';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
});

let currentUser = null;
let syncInFlight = false;
let currentViewNoteId = null;
let currentEditNoteId = null; // if set, save updates instead of adds
let realtimeChannel = null;


// =============================================================================
// Storage (per user, localStorage-based)
// =============================================================================
function notesKey()    { return currentUser ? `notes:${currentUser.id}`    : null; }
function lastSyncKey() { return currentUser ? `lastSync:${currentUser.id}` : null; }

function getNotes() {
    const k = notesKey();
    if (!k) return [];
    return JSON.parse(localStorage.getItem(k) || '[]');
}

function saveNotes(notes) {
    const k = notesKey();
    if (!k) return;
    localStorage.setItem(k, JSON.stringify(notes));
}

function visibleNotes() {
    return getNotes()
        .filter(n => !n.deletedAt)
        .sort((a, b) => {
            // Starred notes float to the top; within each group, newest first.
            if (!!a.starred !== !!b.starred) return a.starred ? -1 : 1;
            return new Date(b.createdAt) - new Date(a.createdAt);
        });
}

function trashedNotes() {
    return getNotes()
        .filter(n => !!n.deletedAt)
        .sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));
}

function nowIso() { return new Date().toISOString(); }

function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
}

function addNote(note) {
    const notes = getNotes();
    note.id = uuid();
    note.createdAt = nowIso();
    note.updatedAt = note.createdAt;
    note.deletedAt = null;
    note.starred = !!note.starred;
    note.pending = true;
    notes.unshift(note);
    saveNotes(notes);
    scheduleSync();
    return note;
}

function updateNote(id, patch) {
    const notes = getNotes();
    const n = notes.find(x => x.id === id);
    if (!n) return;
    Object.assign(n, patch);
    n.updatedAt = nowIso();
    n.pending = true;
    saveNotes(notes);
    scheduleSync();
}

function toggleStarred(id) {
    const notes = getNotes();
    const n = notes.find(x => x.id === id);
    if (!n) return;
    n.starred = !n.starred;
    n.updatedAt = nowIso();
    n.pending = true;
    saveNotes(notes);
    scheduleSync();
}

// Move note to trash (soft delete)
function trashNote(id) {
    const notes = getNotes();
    const n = notes.find(x => x.id === id);
    if (!n) return;
    n.deletedAt = nowIso();
    n.updatedAt = n.deletedAt;
    n.pending = true;
    saveNotes(notes);
    scheduleSync();
}

// Restore from trash
function restoreNote(id) {
    const notes = getNotes();
    const n = notes.find(x => x.id === id);
    if (!n) return;
    n.deletedAt = null;
    n.updatedAt = nowIso();
    n.pending = true;
    saveNotes(notes);
    scheduleSync();
}

// Hard delete (from localStorage + Supabase)
async function purgeNote(id) {
    const notes = getNotes().filter(n => n.id !== id);
    saveNotes(notes);
    if (currentUser && navigator.onLine) {
        try { await sb.from('notes').delete().eq('id', id); } catch (e) { console.error(e); }
    }
}

// =============================================================================
// Sync
// =============================================================================
function setSyncStatus(status) {
    const ind = document.getElementById('sync-indicator');
    if (!ind) return;
    ind.classList.remove('synced', 'syncing', 'offline', 'error');
    ind.classList.add(status);
    const titles = {
        synced:  'Zsynchronizowano',
        syncing: 'Synchronizacja...',
        offline: 'Offline — zmiany zapiszą się lokalnie',
        error:   'Błąd synchronizacji — spróbuję ponownie'
    };
    ind.title = titles[status] || '';
}

function scheduleSync() {
    clearTimeout(scheduleSync._t);
    scheduleSync._t = setTimeout(sync, 300);
}

async function sync() {
    if (syncInFlight || !currentUser) return;
    if (!navigator.onLine) { setSyncStatus('offline'); return; }

    syncInFlight = true;
    setSyncStatus('syncing');

    try {
        const notes = getNotes();
        const byId = new Map(notes.map(n => [n.id, n]));

        // 1) PUSH pending local changes
        const pending = notes.filter(n => n.pending);
        for (const n of pending) {
            const payload = {
                id: n.id,
                user_id: currentUser.id,
                title: n.title || '',
                content: n.content || '',
                type: n.type,
                created_at: n.createdAt,
                updated_at: n.updatedAt,
                deleted_at: n.deletedAt,
                starred: !!n.starred
            };
            let data, error;
            ({ data, error } = await sb.from('notes').upsert(payload).select().single());
            // Graceful degradation if `starred` column doesn't exist yet in DB
            if (error && /starred/i.test(error.message || '')) {
                delete payload.starred;
                ({ data, error } = await sb.from('notes').upsert(payload).select().single());
            }
            if (error) throw error;
            n.updatedAt = data.updated_at;
            n.createdAt = data.created_at;
            n.deletedAt = data.deleted_at;
            if (typeof data.starred === 'boolean') n.starred = data.starred;
            n.pending = false;
        }
        saveNotes(Array.from(byId.values()));

        // 2) PULL remote changes since last sync
        const lastSync = localStorage.getItem(lastSyncKey());
        let q = sb.from('notes').select('*').eq('user_id', currentUser.id);
        if (lastSync) q = q.gt('updated_at', lastSync);
        const { data: remote, error: pullErr } = await q;
        if (pullErr) throw pullErr;

        let pullStamp = lastSync;
        for (const r of remote) {
            const local = byId.get(r.id);
            // If the DB row literally doesn't include `starred` (e.g. column not
            // yet created), preserve whatever local had instead of resetting to
            // false — otherwise the star would flip off right after the user
            // toggled it on.
            const remoteHasStarred = Object.prototype.hasOwnProperty.call(r, 'starred');
            const resolvedStarred = remoteHasStarred
                ? !!r.starred
                : (local ? !!local.starred : false);
            const remoteNote = {
                id: r.id,
                title: r.title,
                content: r.content,
                type: r.type,
                createdAt: r.created_at,
                updatedAt: r.updated_at,
                deletedAt: r.deleted_at,
                starred: resolvedStarred,
                pending: false
            };
            if (!local || new Date(r.updated_at) >= new Date(local.updatedAt)) {
                if (!local || !local.pending) byId.set(r.id, remoteNote);
            }
            if (!pullStamp || r.updated_at > pullStamp) pullStamp = r.updated_at;
        }

        saveNotes(Array.from(byId.values()));
        if (pullStamp) localStorage.setItem(lastSyncKey(), pullStamp);

        setSyncStatus('synced');
        if (!document.getElementById('pager').classList.contains('hidden')) {
            renderNotes();
            renderTrash();
        }
    } catch (err) {
        console.error('Sync error:', err);
        setSyncStatus('error');
    } finally {
        syncInFlight = false;
    }
}

window.addEventListener('online',  () => { setSyncStatus('synced'); sync(); });
window.addEventListener('offline', () => setSyncStatus('offline'));
window.addEventListener('focus',   () => { if (currentUser) sync(); });

// =============================================================================
// Auth
// =============================================================================
async function checkSession() {
    const { data: { session } } = await sb.auth.getSession();
    if (session) onLoggedIn(session.user);
    else         showAuth();
}

function onLoggedIn(user) {
    currentUser = user;
    document.getElementById('user-email').textContent = user.email;
    setSyncStatus(navigator.onLine ? 'syncing' : 'offline');
    hideAllOverlays();
    document.getElementById('pager').classList.remove('hidden');
    requestAnimationFrame(() => {
        layoutPager();
        setPage(0, false); // start on Home
    });
    sync();
    subscribeRealtime();
}

function subscribeRealtime() {
    if (realtimeChannel) sb.removeChannel(realtimeChannel);
    realtimeChannel = sb.channel(`notes:${currentUser.id}`)
        .on('postgres_changes',
            { event: '*', schema: 'public', table: 'notes', filter: `user_id=eq.${currentUser.id}` },
            () => scheduleSync())
        .subscribe();
}

sb.auth.onAuthStateChange((_event, session) => {
    if (session && !currentUser) onLoggedIn(session.user);
});

// =============================================================================
// Auth UI
// =============================================================================
let authMode = 'login';

function setAuthMode(mode) {
    authMode = mode;
    document.getElementById('auth-subtitle').textContent = mode === 'login'
        ? 'Zaloguj się, aby synchronizować notatki'
        : 'Utwórz konto — notatki będą dostępne na każdym urządzeniu';
    document.getElementById('auth-submit').textContent = mode === 'login' ? 'Zaloguj się' : 'Zarejestruj się';
    document.getElementById('auth-toggle').textContent = mode === 'login'
        ? 'Nie masz konta? Zarejestruj się'
        : 'Masz już konto? Zaloguj się';
    showAuthError('');
}

function showAuthError(msg) {
    const el = document.getElementById('auth-error');
    if (!msg) { el.classList.add('hidden'); return; }
    el.textContent = msg;
    el.classList.remove('hidden');
}

document.getElementById('auth-toggle').addEventListener('click', () => {
    setAuthMode(authMode === 'login' ? 'signup' : 'login');
});

document.getElementById('auth-submit').addEventListener('click', async () => {
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    if (!email || !password) { showAuthError('Podaj email i hasło.'); return; }
    if (password.length < 6) { showAuthError('Hasło musi mieć co najmniej 6 znaków.'); return; }

    const btn = document.getElementById('auth-submit');
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = '...';

    try {
        const fn = authMode === 'login' ? 'signInWithPassword' : 'signUp';
        const { data, error } = await sb.auth[fn]({ email, password });
        if (error) { showAuthError(error.message); return; }
        if (data.user && data.session) {
            onLoggedIn(data.user);
        } else if (data.user && !data.session) {
            showAuthError('Sprawdź email i potwierdź konto, potem zaloguj się.');
            setAuthMode('login');
        }
    } catch (e) {
        showAuthError(e.message || 'Nieoczekiwany błąd.');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
});

document.getElementById('auth-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('auth-submit').click();
});

// ===== Zmiana hasła =====
const changePasswordBtn  = document.getElementById('change-password-btn');
const changePasswordForm = document.getElementById('change-password-form');
const cancelChangeBtn    = document.getElementById('cancel-change-password');
const confirmChangeBtn   = document.getElementById('confirm-change-password');
const newPasswordInput   = document.getElementById('new-password');
const confirmPasswordInput = document.getElementById('confirm-password');
const changePasswordError   = document.getElementById('change-password-error');
const changePasswordSuccess = document.getElementById('change-password-success');

function resetChangePasswordForm() {
    changePasswordForm.classList.add('hidden');
    newPasswordInput.value = '';
    confirmPasswordInput.value = '';
    changePasswordError.classList.add('hidden');
    changePasswordError.textContent = '';
    changePasswordSuccess.classList.add('hidden');
}

changePasswordBtn.addEventListener('click', () => {
    const isHidden = changePasswordForm.classList.contains('hidden');
    if (isHidden) {
        changePasswordForm.classList.remove('hidden');
        newPasswordInput.focus();
    } else {
        resetChangePasswordForm();
    }
});

cancelChangeBtn.addEventListener('click', () => resetChangePasswordForm());

confirmChangeBtn.addEventListener('click', async () => {
    const newPass     = newPasswordInput.value;
    const confirmPass = confirmPasswordInput.value;

    changePasswordError.classList.add('hidden');
    changePasswordSuccess.classList.add('hidden');

    if (newPass.length < 6) {
        changePasswordError.textContent = 'Hasło musi mieć co najmniej 6 znaków.';
        changePasswordError.classList.remove('hidden');
        return;
    }
    if (newPass !== confirmPass) {
        changePasswordError.textContent = 'Hasła nie są identyczne.';
        changePasswordError.classList.remove('hidden');
        return;
    }

    confirmChangeBtn.disabled = true;
    confirmChangeBtn.textContent = 'Zapisywanie…';

    const { error } = await sb.auth.updateUser({ password: newPass });

    confirmChangeBtn.disabled = false;
    confirmChangeBtn.textContent = 'Zapisz';

    if (error) {
        changePasswordError.textContent = error.message || 'Błąd zmiany hasła.';
        changePasswordError.classList.remove('hidden');
    } else {
        changePasswordSuccess.classList.remove('hidden');
        newPasswordInput.value = '';
        confirmPasswordInput.value = '';
        setTimeout(() => resetChangePasswordForm(), 2000);
    }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
    if (!confirm('Wylogować? Notatki zostaną na serwerze.')) return;
    if (realtimeChannel) { sb.removeChannel(realtimeChannel); realtimeChannel = null; }
    await sb.auth.signOut();
    currentUser = null;
    hidePager();
    showAuth();
    document.getElementById('auth-email').value = '';
    document.getElementById('auth-password').value = '';
});

// =============================================================================
// Overlays (auth, note form screens) + Pager visibility
// =============================================================================
function showAuth() {
    hidePager();
    hideAllOverlays();
    document.getElementById('auth-screen').classList.add('active');
}

function hidePager() {
    document.getElementById('pager').classList.add('hidden');
}

function showOverlay(id) {
    // If another overlay is already open, slide it out to the left (push deeper)
    // so the new screen can slide in from the right cleanly.
    const current = document.querySelector('.screen.active:not(#auth-screen)');
    if (current && current.id !== id) {
        current.classList.add('slide-out-left');
        current.addEventListener('transitionend', () => {
            current.classList.remove('active', 'slide-out-left');
        }, { once: true });
    } else {
        hideAllOverlays();
    }
    // Flush view edit before leaving view-note-screen
    if (document.getElementById('view-note-screen').classList.contains('active')) {
        flushViewEdit();
    }
    document.getElementById(id).classList.add('active');
}

function hideAllOverlays() {
    // Before removing the view overlay, flush any pending in-place edit.
    if (document.getElementById('view-note-screen').classList.contains('active')) {
        flushViewEdit();
    }
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active', 'slide-out-left'));
}

// =============================================================================
// Pager (swipe between 3 pages)
// =============================================================================
let currentPage = 0; // 0 = home, 1 = profile
let pagerWidth = 0;
const LAST_PAGE = 1;
const CARD_DELETE_THRESHOLD = 120; // px swipe-right on a card to trash it

function layoutPager() {
    const pager = document.getElementById('pager');
    const track = document.getElementById('pager-track');
    const pages = track.querySelectorAll('.page');
    pagerWidth = pager.offsetWidth;
    pages.forEach(p => p.style.width = pagerWidth + 'px');
    track.style.width = (pagerWidth * pages.length) + 'px';
    applyPageTransform(false);
}

function applyPageTransform(animate) {
    const track = document.getElementById('pager-track');
    track.style.transition = animate ? 'transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none';
    track.style.transform = `translate3d(${-currentPage * pagerWidth}px, 0, 0)`;
}

function setPage(idx, animate = true) {
    currentPage = Math.max(0, Math.min(LAST_PAGE, idx));
    applyPageTransform(animate);
    document.querySelectorAll('.pager-dot').forEach((d, i) => {
        d.classList.toggle('active', i === currentPage);
    });
    if (currentPage === 0) renderNotes();
}

// Track whether last gesture was a horizontal swipe — used to suppress card clicks
let pagerSwipedRecently = false;

// Gestures:
//   - Finger starts on a note-card AND moves RIGHT → card-swipe-to-trash
//   - Finger starts elsewhere OR moves LEFT          → pager swipe (home ↔ profile)
//   - Finger moves mostly vertically                 → native scroll
(function setupSwipeGestures() {
    const pager = document.getElementById('pager');
    const track = document.getElementById('pager-track');
    let startX = 0, startY = 0, dx = 0;
    let dragging = false;
    let axis = null;     // 'x' | 'y' | null
    let mode = null;     // 'card' | 'pager' | null (decided after axis=x)
    let cardEl = null;   // when mode==='card'

    const EDGE_OVERSHOOT_DAMP = 0.35;
    const SWIPE_THRESHOLD_FRAC = 0.2; // 20% of screen = page change

    function blockedTarget(el) {
        return !!el.closest('input, textarea, [contenteditable="true"], .pager-dot, .note-card-action-btn');
    }

    function findCard(target) {
        return target && target.closest ? target.closest('.note-card-wrapper .note-card') : null;
    }

    function begin(clientX, clientY, target) {
        pagerSwipedRecently = false;
        if (blockedTarget(target)) { dragging = false; return; }
        startX = clientX;
        startY = clientY;
        dx = 0;
        axis = null;
        mode = null;
        cardEl = currentPage === 0 ? findCard(target) : null;
        dragging = true;
        track.style.transition = 'none';
    }

    function move(clientX, clientY) {
        if (!dragging) return;
        const ddx = clientX - startX;
        const ddy = clientY - startY;

        if (!axis) {
            if (Math.abs(ddx) > 8 || Math.abs(ddy) > 8) {
                axis = Math.abs(ddx) > Math.abs(ddy) ? 'x' : 'y';
            }
        }
        if (axis !== 'x') return;
        dx = ddx;
        if (Math.abs(dx) > 10) pagerSwipedRecently = true;

        if (!mode) {
            // Decide which gesture at first horizontal motion
            mode = (cardEl && dx > 0) ? 'card' : 'pager';
        }

        if (mode === 'card') {
            // Only allow rightward swipe on a card
            const clamped = Math.max(0, dx);
            cardEl.style.transform = `translateX(${clamped}px)`;
            cardEl.classList.add('swiping');
        } else {
            // Pager swipe (any horizontal direction)
            let damped = dx;
            if ((currentPage === 0 && dx > 0) || (currentPage === LAST_PAGE && dx < 0)) {
                damped = dx * EDGE_OVERSHOOT_DAMP;
            }
            const totalPx = -currentPage * pagerWidth + damped;
            track.style.transform = `translate3d(${totalPx}px, 0, 0)`;
        }
    }

    function end() {
        if (!dragging) return;
        dragging = false;

        if (axis !== 'x' || !mode) { applyPageTransform(true); return; }

        if (mode === 'card' && cardEl) {
            cardEl.classList.remove('swiping');
            if (dx > CARD_DELETE_THRESHOLD) {
                const noteId = cardEl.dataset.id;
                cardEl.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
                cardEl.style.transform = `translateX(${pagerWidth}px)`;
                cardEl.style.opacity = '0';
                setTimeout(() => {
                    trashNote(noteId);
                    renderNotes();
                    renderTrash();
                }, 260);
            } else {
                cardEl.style.transition = 'transform 0.2s ease';
                cardEl.style.transform = 'translateX(0)';
                setTimeout(() => { cardEl.style.transition = ''; cardEl.style.transform = ''; }, 220);
            }
        } else if (mode === 'pager') {
            const threshold = pagerWidth * SWIPE_THRESHOLD_FRAC;
            let next = currentPage;
            if (dx > threshold)      next = currentPage - 1;
            else if (dx < -threshold) next = currentPage + 1;
            setPage(next, true);
        }

        mode = null;
        cardEl = null;
    }

    pager.addEventListener('touchstart', (e) => begin(e.touches[0].clientX, e.touches[0].clientY, e.target), { passive: true });
    pager.addEventListener('touchmove',  (e) => move(e.touches[0].clientX, e.touches[0].clientY),              { passive: true });
    pager.addEventListener('touchend',   end);
    pager.addEventListener('touchcancel', end);

    // Mouse drag (desktop)
    pager.addEventListener('mousedown',  (e) => begin(e.clientX, e.clientY, e.target));
    window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
    window.addEventListener('mouseup',   end);
})();

// Dots tap to jump
document.querySelectorAll('.pager-dot').forEach(d => {
    d.addEventListener('click', () => setPage(parseInt(d.dataset.page, 10), true));
});

// Resize
window.addEventListener('resize', layoutPager);

// =============================================================================
// Rendering: note cards + trash cards
// =============================================================================
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function noteIconSvg(type) {
    return type === 'voice'
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>'
        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
}

function formatDate(iso) {
    return new Date(iso).toLocaleDateString('pl-PL', {
        day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

// FLIP-style reorder animation: snapshot positions → re-render → animate from
// old position to new via transform. Cards glide to their new slot.
function animateReorder(listEl, renderFn) {
    const before = new Map();
    listEl.querySelectorAll('.note-card-wrapper').forEach(w => {
        const card = w.querySelector('.note-card');
        if (!card) return;
        before.set(card.dataset.id, w.getBoundingClientRect());
    });

    renderFn();

    listEl.querySelectorAll('.note-card-wrapper').forEach(w => {
        const card = w.querySelector('.note-card');
        if (!card) return;
        const id = card.dataset.id;
        const prev = before.get(id);
        if (!prev) return;
        const now = w.getBoundingClientRect();
        const dy = prev.top - now.top;
        const dx = prev.left - now.left;
        if (dx === 0 && dy === 0) return;
        w.style.transition = 'none';
        w.style.transform = `translate(${dx}px, ${dy}px)`;
        requestAnimationFrame(() => {
            w.style.transition = 'transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1)';
            w.style.transform = '';
        });
    });
}

function renderNotes() {
    const list = document.getElementById('notes-list');
    const notes = visibleNotes();
    const emptyState = document.getElementById('empty-state');

    list.querySelectorAll('.note-card-wrapper').forEach(c => c.remove());

    if (notes.length === 0) { emptyState.style.display = ''; return; }
    emptyState.style.display = 'none';

    notes.forEach(note => {
        const wrapper = document.createElement('div');
        wrapper.className = 'note-card-wrapper';
        const starClass = note.starred ? 'starred' : '';
        const starSvg = note.starred
            ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>'
            : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';

        wrapper.innerHTML = `
            <div class="note-card-bg">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
                Do kosza
            </div>
            <div class="note-card" data-id="${note.id}">
                <div class="note-card-icon">${noteIconSvg(note.type)}</div>
                <div class="note-card-body">
                    <div class="note-card-preview">${escapeHtml(note.content)}</div>
                    <div class="note-card-date">${formatDate(note.createdAt)}</div>
                </div>
                <button class="note-card-star ${starClass}" title="${note.starred ? 'Odepnij' : 'Przypnij na górze'}" aria-label="Gwiazdka">
                    ${starSvg}
                </button>
            </div>
        `;
        const card = wrapper.querySelector('.note-card');
        card.addEventListener('click', () => {
            if (pagerSwipedRecently) { pagerSwipedRecently = false; return; }
            viewNote(note.id);
        });
        wrapper.querySelector('.note-card-star').addEventListener('click', (e) => {
            e.stopPropagation();
            toggleStarred(note.id);
            animateReorder(list, renderNotes);
        });
        list.appendChild(wrapper);
    });
}

function renderTrash() {
    const list = document.getElementById('trash-list');
    const notes = trashedNotes();
    const emptyState = document.getElementById('trash-empty');

    list.querySelectorAll('.note-card-wrapper').forEach(c => c.remove());

    if (notes.length === 0) { emptyState.style.display = ''; return; }
    emptyState.style.display = 'none';

    notes.forEach(note => {
        const wrapper = document.createElement('div');
        wrapper.className = 'note-card-wrapper';
        wrapper.innerHTML = `
            <div class="note-card" data-id="${note.id}">
                <div class="note-card-icon">${noteIconSvg(note.type)}</div>
                <div class="note-card-body">
                    <div class="note-card-preview">${escapeHtml(note.content)}</div>
                    <div class="note-card-date">Usunięto ${formatDate(note.deletedAt)}</div>
                </div>
                <div class="note-card-actions">
                    <button class="note-card-action-btn restore" title="Przywróć" aria-label="Przywróć">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="1 4 1 10 7 10"></polyline>
                            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
                        </svg>
                    </button>
                    <button class="note-card-action-btn purge" title="Usuń na zawsze" aria-label="Usuń na zawsze">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                    </button>
                </div>
            </div>
        `;

        wrapper.querySelector('.note-card-action-btn.restore').addEventListener('click', (e) => {
            e.stopPropagation();
            restoreNote(note.id);
            renderNotes();
            renderTrash();
        });
        wrapper.querySelector('.note-card-action-btn.purge').addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!confirm('Usunąć na zawsze? Tej operacji nie można cofnąć.')) return;
            await purgeNote(note.id);
            renderTrash();
        });
        list.appendChild(wrapper);
    });
}

// =============================================================================
// View note
// =============================================================================
function viewNote(id) {
    const note = getNotes().find(n => n.id === id);
    if (!note) return;
    currentViewNoteId = id;
    document.getElementById('view-note-type').textContent = note.type === 'voice' ? 'Notatka głosowa' : 'Notatka pisemna';
    document.getElementById('view-note-content').textContent = note.content;
    document.getElementById('view-note-date').textContent = new Date(note.createdAt).toLocaleDateString('pl-PL', {
        day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    showOverlay('view-note-screen');
}

document.getElementById('delete-from-view').addEventListener('click', () => {
    if (!currentViewNoteId) return;
    if (!confirm('Przenieść notatkę do kosza?')) return;
    trashNote(currentViewNoteId);
    currentViewNoteId = null;
    hideAllOverlays();
    renderNotes();
    renderTrash();
});

// Mic button inside the view — switches to the voice dictation screen in edit
// mode so the user can keep dictating more text into the same note.
document.getElementById('mic-from-view').addEventListener('click', () => {
    if (!currentViewNoteId) return;
    flushViewEdit();                // save any unsaved typing first
    const note = getNotes().find(n => n.id === currentViewNoteId);
    if (!note) return;

    currentEditNoteId = note.id;
    document.getElementById('voice-note-content').textContent = note.content || '';
    finalTranscript = note.content || '';
    recSeconds = 0;
    document.getElementById('recorder-time').textContent = '00:00';
    document.getElementById('recording-status').textContent = 'Kliknij aby kontynuować nagrywanie';
    document.getElementById('recording-status').classList.remove('active');
    document.getElementById('recorder-circle').classList.remove('recording');
    document.querySelector('#voice-note-screen .screen-title').textContent = 'Edycja notatki';
    showOverlay('voice-note-screen');
});

// In-place edit: typing in #view-note-content auto-saves the note (debounced).
let viewEditDebounce = null;
function flushViewEdit() {
    if (viewEditDebounce) { clearTimeout(viewEditDebounce); viewEditDebounce = null; }
    if (!currentViewNoteId) return;
    const el = document.getElementById('view-note-content');
    if (!el) return;
    const content = (el.textContent || '').trim();
    const note = getNotes().find(n => n.id === currentViewNoteId);
    if (!note) return;
    if ((note.content || '').trim() === content) return;   // nothing to save
    updateNote(currentViewNoteId, { content });
}

document.getElementById('view-note-content').addEventListener('input', () => {
    if (!currentViewNoteId) return;
    if (viewEditDebounce) clearTimeout(viewEditDebounce);
    viewEditDebounce = setTimeout(flushViewEdit, 700);
});

// Prevent Enter from inserting a <div> on some browsers — keep it plain text-ish
document.getElementById('view-note-content').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        document.execCommand('insertLineBreak');
    }
});

// =============================================================================
// New note buttons (text + voice)
// =============================================================================
document.getElementById('open-trash-btn').addEventListener('click', () => {
    renderTrash();
    showOverlay('trash-screen');
});

document.getElementById('open-text-btn').addEventListener('click', () => {
    currentEditNoteId = null;
    document.getElementById('text-note-content').value = '';
    document.querySelector('#text-note-screen .screen-title').textContent = 'Notatka pisemna';
    showOverlay('text-note-screen');
    document.getElementById('text-note-content').focus();
});

document.getElementById('open-voice-btn').addEventListener('click', () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        alert('Twoja przeglądarka nie wspiera rozpoznawania mowy. Użyj Chrome lub Edge.');
        return;
    }

    currentEditNoteId = null;

    document.getElementById('voice-note-content').textContent = '';
    finalTranscript = '';
    recSeconds = 0;
    document.getElementById('recorder-time').textContent = '00:00';
    document.getElementById('recording-status').textContent = 'Kliknij aby nagrywać';
    document.getElementById('recording-status').classList.remove('active');
    document.getElementById('recorder-circle').classList.remove('recording');
    document.querySelector('#voice-note-screen .screen-title').textContent = 'Notatka głosowa';
    showOverlay('voice-note-screen');

    setTimeout(() => startRecording(), 200);
});

// Edit button — opens the matching note screen prefilled, without auto-starting mic.
function openEditScreen(note) {
    currentEditNoteId = note.id;
    if (note.type === 'voice') {
        document.getElementById('voice-note-content').textContent = note.content || '';
        finalTranscript = note.content || '';
        recSeconds = 0;
        document.getElementById('recorder-time').textContent = '00:00';
        document.getElementById('recording-status').textContent = 'Kliknij aby kontynuować nagrywanie';
        document.getElementById('recording-status').classList.remove('active');
        document.getElementById('recorder-circle').classList.remove('recording');
        document.querySelector('#voice-note-screen .screen-title').textContent = 'Edycja notatki';
        showOverlay('voice-note-screen');
        // Do NOT auto-start recording in edit mode
    } else {
        document.getElementById('text-note-content').value = note.content || '';
        document.querySelector('#text-note-screen .screen-title').textContent = 'Edycja notatki';
        showOverlay('text-note-screen');
        document.getElementById('text-note-content').focus();
    }
}

// =============================================================================
// Text note save/discard
// =============================================================================
document.getElementById('save-text-note').addEventListener('click', () => {
    const content = document.getElementById('text-note-content').value.trim();
    if (!content) { alert('Wpisz treść notatki.'); return; }

    if (currentEditNoteId) {
        updateNote(currentEditNoteId, { content });
        currentEditNoteId = null;
    } else {
        addNote({ title: '', content, type: 'text' });
    }
    hideAllOverlays();
    renderNotes();
});

// discard-text handler defined further below in the edit section

// =============================================================================
// Voice note
// =============================================================================
let recognition = null;
let isRecording = false;
let finalTranscript = '';
let recTimer = null;
let recSeconds = 0;
let sessionActive = false;
let recentCommits = []; // {text, time}[] for content-based dedup
let wakeLock = null;

document.getElementById('recorder-circle').addEventListener('click', () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        alert('Twoja przeglądarka nie wspiera rozpoznawania mowy. Użyj Chrome lub Edge.');
        return;
    }
    if (isRecording) {
        stopRecording();
    } else {
        startRecording();
    }
});

// Wake Lock: keep screen on during recording
async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) {
        console.warn('Wake lock unavailable:', e);
    }
}

async function releaseWakeLock() {
    if (wakeLock) {
        try { await wakeLock.release(); } catch (e) { /* ignore */ }
        wakeLock = null;
    }
}

// If page becomes visible again during recording, re-acquire wake lock
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isRecording && !wakeLock) {
        acquireWakeLock();
    }
});

// Dedup: reject near-identical final chunks within a short window.
// Handles Xiaomi/MIUI re-emitting the same final at new result indices.
function tryCommitFinal(rawChunk) {
    const trimmed = (rawChunk || '').trim();
    if (!trimmed) return;

    const now = Date.now();
    // Same text committed in the last 2.5s → skip
    if (recentCommits.some(c => c.text === trimmed && now - c.time < 2500)) return;
    // Tail of finalTranscript already ends with this exact chunk → skip
    const tail = finalTranscript.trimEnd();
    if (tail.endsWith(trimmed) && tail.length >= trimmed.length) return;

    finalTranscript += (finalTranscript && !finalTranscript.endsWith(' ') ? ' ' : '') + trimmed;
    recentCommits.push({ text: trimmed, time: now });
    // Keep buffer small — prune anything older than 5 seconds
    recentCommits = recentCommits.filter(c => now - c.time < 5000);
}

function buildRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return null;

    const r = new SpeechRecognition();
    r.lang = 'pl-PL';
    // continuous=true minimizes session restarts → Android stops playing the
    // system start/stop beep on every dictation pause. Dedup (tryCommitFinal)
    // handles any same-text re-emission from buggy engines like MIUI Chrome.
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onstart = () => { sessionActive = true; };

    r.onresult = (event) => {
        // No sessionActive guard — onresult can fire before onstart on some
        // Android builds; dedup (tryCommitFinal) already handles stragglers.
        let interim = '';
        // Walk from resultIndex (where the new/changed results begin) to end.
        const startIdx = typeof event.resultIndex === 'number' ? event.resultIndex : 0;
        for (let i = startIdx; i < event.results.length; i++) {
            const res = event.results[i];
            const transcript = res[0].transcript;
            if (res.isFinal) tryCommitFinal(transcript);
            else             interim += transcript;
        }

        const container = document.getElementById('voice-note-content');
        container.innerHTML = escapeHtml(finalTranscript) +
            (interim ? '<span class="interim">' + escapeHtml(interim) + '</span>' : '');
    };

    r.onerror = (event) => {
        console.error('Speech recognition error:', event.error);
        if (event.error === 'no-speech') return;
        if (event.error === 'not-allowed') {
            alert('Brak dostępu do mikrofonu. Zezwól na dostęp w ustawieniach przeglądarki.');
            stopRecording();
            return;
        }
        // Other errors: let onend handle restart logic
    };

    r.onend = () => {
        sessionActive = false;
        if (!isRecording) return;
        // Don't auto-restart — each recognition.start() triggers an Android
        // system earcon. Instead, switch to "paused" state so the user can
        // tap the mic to continue (same behaviour as Gboard).
        isRecording = false;
        recognition = null;
        const circle = document.getElementById('recorder-circle');
        const status = document.getElementById('recording-status');
        if (circle) circle.classList.remove('recording');
        if (circle) circle.classList.add('paused');
        if (status) { status.textContent = 'Dotknij aby kontynuować'; status.classList.remove('active'); }
        if (recTimer) { clearInterval(recTimer); recTimer = null; }
        // Keep wake lock — user will likely tap to resume shortly
    };

    return r;
}

function startRecording() {
    recognition = buildRecognition();
    if (!recognition) return;
    sessionActive = false;
    recentCommits = [];
    try {
        recognition.start();
    } catch (e) {
        console.error('recognition.start failed:', e);
        return;
    }
    isRecording = true;
    acquireWakeLock();

    recSeconds = 0;
    updateTimerDisplay();
    recTimer = setInterval(() => { recSeconds++; updateTimerDisplay(); }, 1000);

    const circle = document.getElementById('recorder-circle');
    const status = document.getElementById('recording-status');
    if (circle) { circle.classList.remove('paused'); circle.classList.add('recording'); }
    if (status) { status.textContent = 'Nagrywanie...'; status.classList.add('active'); }
}

function stopRecording() {
    if (recognition) {
        isRecording = false;
        try { recognition.stop(); } catch (e) { /* ignore */ }
        recognition = null;
    } else {
        isRecording = false;
    }
    if (recTimer) { clearInterval(recTimer); recTimer = null; }
    releaseWakeLock();

    const circle = document.getElementById('recorder-circle');
    const status = document.getElementById('recording-status');
    if (circle) { circle.classList.remove('recording'); circle.classList.remove('paused'); }
    if (status) {
        status.textContent = 'Kliknij aby nagrywać';
        status.classList.remove('active');
    }

    const container = document.getElementById('voice-note-content');
    if (container) container.textContent = finalTranscript;
}

function updateTimerDisplay() {
    const min = String(Math.floor(recSeconds / 60)).padStart(2, '0');
    const sec = String(recSeconds % 60).padStart(2, '0');
    document.getElementById('recorder-time').textContent = `${min}:${sec}`;
}

document.getElementById('save-voice-note').addEventListener('click', () => {
    stopRecording();
    const content = document.getElementById('voice-note-content').textContent.trim();
    if (!content) { alert('Nagraj treść notatki.'); return; }

    if (currentEditNoteId) {
        updateNote(currentEditNoteId, { content });
        currentEditNoteId = null;
    } else {
        addNote({ title: '', content, type: 'voice' });
    }
    hideAllOverlays();
    renderNotes();
});

document.getElementById('discard-voice').addEventListener('click', () => {
    stopRecording();
    currentEditNoteId = null;
    hideAllOverlays();
});

document.getElementById('discard-text').addEventListener('click', () => {
    currentEditNoteId = null;
    hideAllOverlays();
});

// =============================================================================
// Back buttons (return to pager)
// =============================================================================
document.querySelectorAll('.back-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        stopRecording();
        hideAllOverlays();
    });
});

// =============================================================================
// PWA: Install prompt + Service Worker
// =============================================================================
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (localStorage.getItem('installDismissed') !== '1') {
        document.getElementById('install-banner').classList.remove('hidden');
    }
});

document.getElementById('install-accept').addEventListener('click', async () => {
    const banner = document.getElementById('install-banner');
    if (!deferredInstallPrompt) { banner.classList.add('hidden'); return; }
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    banner.classList.add('hidden');
    if (outcome === 'dismissed') localStorage.setItem('installDismissed', '1');
});

document.getElementById('install-dismiss').addEventListener('click', () => {
    document.getElementById('install-banner').classList.add('hidden');
    localStorage.setItem('installDismissed', '1');
});

window.addEventListener('appinstalled', () => {
    document.getElementById('install-banner').classList.add('hidden');
    deferredInstallPrompt = null;
});

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch((err) => {
            console.error('SW registration failed:', err);
        });
    });
}

// =============================================================================
// Init
// =============================================================================
checkSession();
