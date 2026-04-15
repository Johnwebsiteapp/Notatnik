// ===== Supabase config =====
const SUPABASE_URL = 'https://lfajvdairiuqstkygrnp.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxmYWp2ZGFpcml1cXN0a3lncm5wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxNzUyNTIsImV4cCI6MjA5MTc1MTI1Mn0.j7OeYS3plpkDdy75MMo_vhO9ZSBN8OWM_pUirNvxkI0';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
});

let currentUser = null;
let syncInFlight = false;
let currentViewNoteId = null;
let realtimeChannel = null;

// =============================================================================
// Sound (Web Audio API) — short tick for mic + save only, silent elsewhere
// =============================================================================
let audioCtx = null;

function playTick(freq = 800, durationMs = 80, gainPeak = 0.12) {
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const t = audioCtx.currentTime;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t);
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(gainPeak, t + 0.005);
        gain.gain.exponentialRampToValueAtTime(0.0005, t + durationMs / 1000);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + durationMs / 1000 + 0.02);
    } catch (e) { /* ignore */ }
}

function soundMicClick() { playTick(720, 70); }
function soundSaveClick() { playTick(980, 110, 0.14); }

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
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
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
    note.pending = true;
    notes.unshift(note);
    saveNotes(notes);
    scheduleSync();
    return note;
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
                deleted_at: n.deletedAt
            };
            const { data, error } = await sb.from('notes').upsert(payload).select().single();
            if (error) throw error;
            n.updatedAt = data.updated_at;
            n.createdAt = data.created_at;
            n.deletedAt = data.deleted_at;
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
            const remoteNote = {
                id: r.id,
                title: r.title,
                content: r.content,
                type: r.type,
                createdAt: r.created_at,
                updatedAt: r.updated_at,
                deletedAt: r.deleted_at,
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
    // Wait for pager layout pass before positioning the track to page 1,
    // otherwise the leftmost (trash) panel flashes for one frame.
    requestAnimationFrame(() => {
        layoutPager();
        setPage(1, false);
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
    hideAllOverlays();
    document.getElementById(id).classList.add('active');
}

function hideAllOverlays() {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
}

// =============================================================================
// Pager (swipe between 3 pages)
// =============================================================================
let currentPage = 1; // 0 = trash, 1 = home, 2 = profile
let pagerWidth = 0;

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
    currentPage = Math.max(0, Math.min(2, idx));
    applyPageTransform(animate);
    document.querySelectorAll('.pager-dot').forEach((d, i) => {
        d.classList.toggle('active', i === currentPage);
    });
    if (currentPage === 0) renderTrash();
    else if (currentPage === 1) renderNotes();
}

// Track whether last gesture was a horizontal swipe — used to suppress card clicks
let pagerSwipedRecently = false;

// Touch swipe
(function setupPagerSwipe() {
    const pager = document.getElementById('pager');
    const track = document.getElementById('pager-track');
    let startX = 0, startY = 0, dx = 0, dragging = false, axis = null;
    const EDGE_OVERSHOOT_DAMP = 0.35;
    const SWIPE_THRESHOLD_FRAC = 0.2; // 20% of screen triggers page change

    // Only the pager dots and form controls block swipe start.
    // Note cards and empty areas all allow swipe — a horizontal finger drag
    // across a card scrolls the pager, not opens the card.
    function isInteractiveTarget(el) {
        return !!el.closest('input, textarea, [contenteditable="true"], .pager-dot');
    }

    pager.addEventListener('touchstart', (e) => {
        pagerSwipedRecently = false;
        if (isInteractiveTarget(e.target)) { dragging = false; return; }
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        dx = 0;
        dragging = true;
        axis = null;
        track.style.transition = 'none';
    }, { passive: true });

    pager.addEventListener('touchmove', (e) => {
        if (!dragging) return;
        const cx = e.touches[0].clientX;
        const cy = e.touches[0].clientY;
        const ddx = cx - startX;
        const ddy = cy - startY;

        if (!axis) {
            if (Math.abs(ddx) > 8 || Math.abs(ddy) > 8) {
                axis = Math.abs(ddx) > Math.abs(ddy) ? 'x' : 'y';
            }
        }
        if (axis !== 'x') return;

        dx = ddx;
        if (Math.abs(dx) > 10) pagerSwipedRecently = true;
        // Dampen overshoot at edges
        if ((currentPage === 0 && dx > 0) || (currentPage === 2 && dx < 0)) {
            dx = dx * EDGE_OVERSHOOT_DAMP;
        }
        const totalPx = -currentPage * pagerWidth + dx;
        track.style.transform = `translate3d(${totalPx}px, 0, 0)`;
    }, { passive: true });

    pager.addEventListener('touchend', () => {
        if (!dragging) return;
        dragging = false;
        if (axis !== 'x') { applyPageTransform(true); return; }

        const threshold = pagerWidth * SWIPE_THRESHOLD_FRAC;
        let next = currentPage;
        if (dx > threshold)      next = currentPage - 1;
        else if (dx < -threshold) next = currentPage + 1;
        setPage(next, true);
    });

    // Mouse drag for desktop (optional nice-to-have)
    let mDragging = false;
    pager.addEventListener('mousedown', (e) => {
        if (isInteractiveTarget(e.target)) return;
        startX = e.clientX; startY = e.clientY;
        dx = 0; axis = null; mDragging = true;
        track.style.transition = 'none';
    });
    window.addEventListener('mousemove', (e) => {
        if (!mDragging) return;
        const ddx = e.clientX - startX;
        const ddy = e.clientY - startY;
        if (!axis) {
            if (Math.abs(ddx) > 8 || Math.abs(ddy) > 8) {
                axis = Math.abs(ddx) > Math.abs(ddy) ? 'x' : 'y';
            }
        }
        if (axis !== 'x') return;
        dx = ddx;
        if (Math.abs(dx) > 10) pagerSwipedRecently = true;
        if ((currentPage === 0 && dx > 0) || (currentPage === 2 && dx < 0)) {
            dx = dx * EDGE_OVERSHOOT_DAMP;
        }
        const totalPx = -currentPage * pagerWidth + dx;
        track.style.transform = `translate3d(${totalPx}px, 0, 0)`;
    });
    window.addEventListener('mouseup', () => {
        if (!mDragging) return;
        mDragging = false;
        if (axis !== 'x') { applyPageTransform(true); return; }
        const threshold = pagerWidth * SWIPE_THRESHOLD_FRAC;
        let next = currentPage;
        if (dx > threshold)      next = currentPage - 1;
        else if (dx < -threshold) next = currentPage + 1;
        setPage(next, true);
    });
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
        wrapper.innerHTML = `
            <div class="note-card" data-id="${note.id}">
                <div class="note-card-icon">${noteIconSvg(note.type)}</div>
                <div class="note-card-body">
                    <div class="note-card-preview">${escapeHtml(note.content)}</div>
                    <div class="note-card-date">${formatDate(note.createdAt)}</div>
                </div>
                <div class="note-card-actions">
                    <button class="note-card-action-btn purge" title="Usuń" aria-label="Usuń">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                    </button>
                </div>
            </div>
        `;

        const card = wrapper.querySelector('.note-card');
        wrapper.querySelector('.note-card-action-btn.purge').addEventListener('click', (e) => {
            e.stopPropagation();
            trashNote(note.id);
            renderNotes();
            renderTrash();
        });
        card.addEventListener('click', (e) => {
            // Swallow the click if it was tail of a horizontal pager swipe
            if (pagerSwipedRecently) { pagerSwipedRecently = false; return; }
            viewNote(note.id);
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

// =============================================================================
// New note buttons (text + voice)
// =============================================================================
document.getElementById('open-text-btn').addEventListener('click', () => {
    document.getElementById('text-note-content').value = '';
    showOverlay('text-note-screen');
    document.getElementById('text-note-content').focus();
});

document.getElementById('open-voice-btn').addEventListener('click', () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        alert('Twoja przeglądarka nie wspiera rozpoznawania mowy. Użyj Chrome lub Edge.');
        return;
    }
    soundMicClick(); // play synchronously within user gesture

    document.getElementById('voice-note-content').textContent = '';
    finalTranscript = '';
    recSeconds = 0;
    document.getElementById('recorder-time').textContent = '00:00';
    document.getElementById('recording-status').textContent = 'Kliknij aby nagrywać';
    document.getElementById('recording-status').classList.remove('active');
    document.getElementById('recorder-circle').classList.remove('recording');
    showOverlay('voice-note-screen');

    setTimeout(() => startRecording(), 200);
});

// =============================================================================
// Text note save/discard
// =============================================================================
document.getElementById('save-text-note').addEventListener('click', () => {
    const content = document.getElementById('text-note-content').value.trim();
    if (!content) { alert('Wpisz treść notatki.'); return; }
    soundSaveClick();
    addNote({ title: '', content, type: 'text' });
    hideAllOverlays();
    renderNotes();
});

document.getElementById('discard-text').addEventListener('click', () => {
    hideAllOverlays();
});

// =============================================================================
// Voice note
// =============================================================================
let recognition = null;
let isRecording = false;
let finalTranscript = '';
let recTimer = null;
let recSeconds = 0;
let sessionActive = false;
let sessionFinalized = false;

document.getElementById('recorder-circle').addEventListener('click', () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        alert('Twoja przeglądarka nie wspiera rozpoznawania mowy. Użyj Chrome lub Edge.');
        return;
    }
    soundMicClick();
    if (isRecording) stopRecording();
    else startRecording();
});

function buildRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return null;

    const r = new SpeechRecognition();
    r.lang = 'pl-PL';
    r.continuous = false;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onstart = () => { sessionActive = true; sessionFinalized = false; };

    r.onresult = (event) => {
        if (!sessionActive || sessionFinalized) return;

        let interim = '';
        let finalChunk = '';
        let hasFinal = false;

        for (let i = 0; i < event.results.length; i++) {
            const result = event.results[i];
            const transcript = result[0].transcript;
            if (result.isFinal) { finalChunk += transcript; hasFinal = true; }
            else                { interim += transcript; }
        }

        if (hasFinal) {
            sessionFinalized = true;
            const trimmed = finalChunk.trim();
            if (trimmed) {
                finalTranscript += (finalTranscript && !finalTranscript.endsWith(' ') ? ' ' : '') + trimmed;
            }
        }

        const container = document.getElementById('voice-note-content');
        container.innerHTML = escapeHtml(finalTranscript) +
            (interim && !hasFinal ? '<span class="interim">' + escapeHtml(interim) + '</span>' : '');
    };

    r.onerror = (event) => {
        console.error('Speech recognition error:', event.error);
        if (event.error === 'no-speech') return;
        if (event.error === 'not-allowed') {
            alert('Brak dostępu do mikrofonu. Zezwól na dostęp w ustawieniach przeglądarki.');
            stopRecording();
            return;
        }
        stopRecording();
    };

    r.onend = () => {
        sessionActive = false;
        if (!isRecording) return;
        setTimeout(() => {
            if (!isRecording) return;
            try {
                recognition = buildRecognition();
                if (recognition) recognition.start();
            } catch (e) {
                console.error('Recognition restart failed:', e);
                stopRecording();
            }
        }, 200);
    };

    return r;
}

function startRecording() {
    recognition = buildRecognition();
    if (!recognition) return;
    sessionActive = false;
    sessionFinalized = false;
    recognition.start();
    isRecording = true;

    recSeconds = 0;
    updateTimerDisplay();
    recTimer = setInterval(() => { recSeconds++; updateTimerDisplay(); }, 1000);

    document.getElementById('recorder-circle').classList.add('recording');
    document.getElementById('recording-status').textContent = 'Nagrywanie...';
    document.getElementById('recording-status').classList.add('active');
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

    document.getElementById('recorder-circle').classList.remove('recording');
    document.getElementById('recording-status').textContent = 'Kliknij aby nagrywać';
    document.getElementById('recording-status').classList.remove('active');

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
    soundSaveClick();
    addNote({ title: '', content, type: 'voice' });
    hideAllOverlays();
    renderNotes();
});

document.getElementById('discard-voice').addEventListener('click', () => {
    stopRecording();
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
