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

const TRASH_DAYS = 30;

function daysLeftInTrash(deletedAt) {
    const ms = TRASH_DAYS * 24 * 60 * 60 * 1000;
    const left = Math.ceil((new Date(deletedAt).getTime() + ms - Date.now()) / (24 * 60 * 60 * 1000));
    return Math.max(0, left);
}

function trashedNotes() {
    return getNotes()
        .filter(n => !!n.deletedAt)
        .sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));
}

// Purge notes that have been in trash for more than TRASH_DAYS days
async function purgeExpiredNotes() {
    const expired = getNotes().filter(n => n.deletedAt && daysLeftInTrash(n.deletedAt) === 0);
    for (const n of expired) {
        await purgeNote(n.id);
    }
    if (expired.length > 0) {
        renderNotes();
        renderTrash();
    }
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
        synced:  'Zsynchronizowano — kliknij, aby zsynchronizować ręcznie',
        syncing: 'Synchronizacja...',
        offline: 'Offline — zmiany zapiszą się lokalnie',
        error:   'Błąd synchronizacji — kliknij, aby spróbować ponownie'
    };
    ind.title = titles[status] || '';
    updateOfflineBanner(status);
}

// Kliknięcie w indykator synchronizacji — wymuś ręczny sync
// + reset realtime gdyby kanał padł
document.getElementById('sync-indicator')?.addEventListener('click', () => {
    if (!currentUser) return;
    if (realtimeChannel) { sb.removeChannel(realtimeChannel); realtimeChannel = null; }
    sync();
    if (navigator.onLine) subscribeRealtime();
});

// Banner offline — widoczny na liście notatek, pokazuje liczbę zmian
// czekających na wysłanie. Znika gdy wszystko zsynchronizowane.
function updateOfflineBanner(status) {
    const banner = document.getElementById('offline-banner');
    if (!banner) return;
    const pendingCount = getNotes().filter(n => n.pending).length;
    const offline = !navigator.onLine || status === 'offline';

    if (!offline && pendingCount === 0) {
        banner.classList.add('hidden');
        return;
    }

    banner.classList.remove('hidden');
    const msg = banner.querySelector('.offline-banner-text');
    if (offline && pendingCount > 0) {
        msg.textContent = `Offline — ${pendingCount} ${pendingCount === 1 ? 'zmiana czeka' : pendingCount < 5 ? 'zmiany czekają' : 'zmian czeka'} na wysyłkę`;
    } else if (offline) {
        msg.textContent = 'Offline — notatki zapiszą się lokalnie';
    } else {
        msg.textContent = `Synchronizuję ${pendingCount} ${pendingCount === 1 ? 'zmianę' : pendingCount < 5 ? 'zmiany' : 'zmian'}…`;
    }
    banner.classList.toggle('offline', offline);
    banner.classList.toggle('syncing', !offline);
}

function scheduleSync() {
    clearTimeout(scheduleSync._t);
    scheduleSync._t = setTimeout(sync, 300);
    // Zaktualizuj banner natychmiast — licznik "pending" mógł się zmienić
    updateOfflineBanner(navigator.onLine ? 'syncing' : 'offline');
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

window.addEventListener('online', () => {
    setSyncStatus('synced');
    sync();
    // Po powrocie do sieci reaktywuj realtime (offline go nie otwiera)
    if (currentUser && !realtimeChannel) subscribeRealtime();
});
window.addEventListener('offline', () => setSyncStatus('offline'));
window.addEventListener('focus',   () => { if (currentUser) sync(); });

// visibilitychange — lepszy niż focus dla PWA/telefonów
// (focus nie zawsze odpala po wznowieniu aplikacji w standalone mode)
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentUser) {
        sync();
        // Odśwież też połączenie realtime jeśli zdążyło umrzeć
        if (navigator.onLine && !realtimeChannel) subscribeRealtime();
    }
});

// Polling fallback — sync praktycznie natychmiastowy (co 3 s).
// Cena: ~20 małych zapytań/minuta gdy tab widoczny, każde to
// SELECT WHERE updated_at > lastSync, większość wraca pusto.
// Gdy tab niewidoczny → ani razu, czyli bateria nie cierpi.
setInterval(() => {
    if (!currentUser) return;
    if (!navigator.onLine) return;
    if (document.visibilityState !== 'visible') return;
    sync();
}, 3000);

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
    purgeExpiredNotes();
    // Jeśli przyszła treść przez Web Share Target — otwórz formularz z pre-fillem
    setTimeout(consumePendingShare, 400);
}

function subscribeRealtime() {
    if (realtimeChannel) sb.removeChannel(realtimeChannel);
    // Offline — nie otwieraj websocketa, żeby nie spamować błędami.
    // Po powrocie do sieci subskrypcja odpali się w handlerze 'online'.
    if (!navigator.onLine) return;
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

// ===== Motyw (theme switcher) =====
function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme === 'default' ? '' : theme);
    document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.theme === theme);
    });
    localStorage.setItem('theme', theme);
}

document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
});

// Wczytaj motyw przy starcie
applyTheme(localStorage.getItem('theme') || 'default');

// ===== Rozmiar czcionki (suwak w profilu) =====
function applyFontScale(scale) {
    const s = Math.max(0.8, Math.min(1.5, Number(scale) || 1));
    document.documentElement.style.setProperty('--fs-scale', String(s));
    const slider = document.getElementById('font-size-slider');
    const label  = document.getElementById('fs-value');
    if (slider && Number(slider.value) !== s) slider.value = String(s);
    if (label) label.textContent = Math.round(s * 100) + '%';
    localStorage.setItem('fontScale', String(s));
}

const fontSlider = document.getElementById('font-size-slider');
if (fontSlider) {
    fontSlider.addEventListener('input', (e) => applyFontScale(e.target.value));
}

// Wczytaj zapisany rozmiar
applyFontScale(localStorage.getItem('fontScale') || '1');

// ===== Globalny rozmiar kart (desktop only — drag za krawędź) =====
// Przeciąganie jakiegokolwiek uchwytu zmienia rozmiar WSZYSTKICH kart
// jednocześnie przez zmienne CSS --card-w i --card-h ustawiane na :root.
// Wartości zapisywane w localStorage (globalnie dla listy).

const IS_DESKTOP = window.matchMedia('(hover: hover) and (pointer: fine) and (min-width: 768px)').matches;

const CARD_W_MIN = 280;
const CARD_H_MIN = 90;

function applyGlobalCardSize() {
    if (!IS_DESKTOP) return;
    const w = localStorage.getItem('cardsWidth');
    const h = localStorage.getItem('cardsHeight');
    if (w) document.documentElement.style.setProperty('--card-w', w + 'px');
    if (h) document.documentElement.style.setProperty('--card-h', h + 'px');
}
applyGlobalCardSize();

// Dokłada do wrappera uchwyty resize (tylko desktop).
// Każdy uchwyt steruje GLOBALNĄ wartością — wszystkie karty rosną/maleją razem.
function attachResizeHandles(wrapper) {
    if (!IS_DESKTOP) return;
    const card = wrapper.querySelector('.note-card');
    if (!card) return;

    const hRight  = document.createElement('div');
    hRight.className = 'resize-handle resize-right';
    hRight.title = 'Przeciągnij, aby zmienić szerokość wszystkich notatek';
    const hBottom = document.createElement('div');
    hBottom.className = 'resize-handle resize-bottom';
    hBottom.title = 'Przeciągnij, aby zmienić wysokość wszystkich notatek';
    wrapper.appendChild(hRight);
    wrapper.appendChild(hBottom);

    const startDrag = (axis) => (e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startY = e.clientY;
        const startW = wrapper.offsetWidth;
        const startH = card.offsetHeight;
        document.body.classList.add('is-resizing-card');
        document.body.classList.add(axis === 'x' ? 'resizing-x' : 'resizing-y');

        const onMove = (ev) => {
            if (axis === 'x') {
                const newW = Math.max(CARD_W_MIN, startW + (ev.clientX - startX));
                document.documentElement.style.setProperty('--card-w', newW + 'px');
            } else {
                const newH = Math.max(CARD_H_MIN, startH + (ev.clientY - startY));
                document.documentElement.style.setProperty('--card-h', newH + 'px');
            }
        };
        const onUp = () => {
            document.body.classList.remove('is-resizing-card', 'resizing-x', 'resizing-y');
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            // Zapisz finalną wartość globalnie
            const rootStyle = document.documentElement.style;
            if (axis === 'x') {
                const v = parseInt(rootStyle.getPropertyValue('--card-w'), 10);
                if (v) localStorage.setItem('cardsWidth', String(v));
            } else {
                const v = parseInt(rootStyle.getPropertyValue('--card-h'), 10);
                if (v) localStorage.setItem('cardsHeight', String(v));
            }
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    };

    hRight.addEventListener('mousedown',  startDrag('x'));
    hBottom.addEventListener('mousedown', startDrag('y'));
}

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
    updatePageNavButtons();
}

// Pokaż/ukryj strzałki nawigacji zależnie od bieżącej strony
function updatePageNavButtons() {
    const prev = document.getElementById('page-nav-prev');
    const next = document.getElementById('page-nav-next');
    if (prev) prev.classList.toggle('disabled', currentPage <= 0);
    if (next) next.classList.toggle('disabled', currentPage >= LAST_PAGE);
}

document.getElementById('page-nav-next')?.addEventListener('click', () => {
    setPage(currentPage + 1, true);
});
document.getElementById('page-nav-prev')?.addEventListener('click', () => {
    setPage(currentPage - 1, true);
});

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
                const wrapperEl = cardEl.closest('.note-card-wrapper');
                // Faza 1: dokończ slide w prawo + fade (260ms)
                cardEl.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
                cardEl.style.transform = `translateX(${pagerWidth}px)`;
                cardEl.style.opacity = '0';
                // Faza 2: zwiń wrapper (max-height → 0), sąsiedzi podjeżdżają
                setTimeout(() => {
                    if (wrapperEl) {
                        const h = wrapperEl.offsetHeight;
                        wrapperEl.style.maxHeight = h + 'px';
                        wrapperEl.style.overflow = 'hidden';
                        wrapperEl.style.transition = 'max-height 0.25s ease, margin-top 0.25s ease';
                        requestAnimationFrame(() => {
                            wrapperEl.style.maxHeight = '0px';
                            wrapperEl.style.marginTop = '-10px';
                        });
                    }
                }, 260);
                // Po obu fazach — commit do storage + re-render
                setTimeout(() => {
                    trashNote(noteId);
                    renderNotes();
                    renderTrash();
                }, 520);
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

// Zamienia URL-e w tekście na klikalne <a target="_blank">.
// Wykrywa http(s)://… i www.…  Reszta pozostaje plain textem.
// Używamy najpierw escapeHtml żeby XSS-owe teksty nie wpływały na DOM.
function linkifyHtml(text) {
    const escaped = escapeHtml(text);
    return escaped.replace(
        /\b((?:https?:\/\/|www\.)[^\s<]+[^\s<.,;:!?)'"`])/gi,
        (url) => {
            const href = url.match(/^https?:\/\//i) ? url : 'https://' + url;
            return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="note-link">${url}</a>`;
        }
    );
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

// Animuje usunięcie pojedynczej karty (slide/unosi się/shake), a po
// zakończeniu animacji wywołuje onComplete. Gdy karty nie ma w DOM
// (np. widok listy zamknięty) — od razu odpala callback.
function animateCardRemoval(card, animationClass, onComplete) {
    if (!card) { onComplete(); return; }
    const wrapper = card.closest('.note-card-wrapper');
    if (!wrapper) { onComplete(); return; }
    wrapper.classList.add(animationClass);
    let done = false;
    const finish = () => { if (done) return; done = true; onComplete(); };
    wrapper.addEventListener('animationend', finish, { once: true });
    // Fallback gdyby przeglądarka nie odpaliła animationend (np. display:none w trakcie)
    setTimeout(finish, 800);
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
        attachResizeHandles(wrapper);
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
                    <div class="note-trash-expiry">${(() => { const d = daysLeftInTrash(note.deletedAt); return d === 0 ? 'Usuwa się dzisiaj' : d === 1 ? 'Zostaje 1 dzień' : `Zostaje ${d} dni`; })()}</div>
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
            const card = wrapper.querySelector('.note-card');
            animateCardRemoval(card, 'removing-restore', () => {
                restoreNote(note.id);
                renderNotes();
                renderTrash();
            });
        });
        wrapper.querySelector('.note-card-action-btn.purge').addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!confirm('Usunąć na zawsze? Tej operacji nie można cofnąć.')) return;
            const card = wrapper.querySelector('.note-card');
            animateCardRemoval(card, 'removing-purge', async () => {
                await purgeNote(note.id);
                renderTrash();
            });
        });
        list.appendChild(wrapper);
        attachResizeHandles(wrapper);
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
    document.getElementById('view-note-content').innerHTML = linkifyHtml(note.content);
    document.getElementById('view-note-date').textContent = new Date(note.createdAt).toLocaleDateString('pl-PL', {
        day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    showOverlay('view-note-screen');
}

document.getElementById('delete-from-view').addEventListener('click', () => {
    if (!currentViewNoteId) return;
    if (!confirm('Przenieść notatkę do kosza?')) return;
    const id = currentViewNoteId;
    currentViewNoteId = null;
    hideAllOverlays();
    // Overlay zjeżdża w prawo 300ms — daj mu chwilę, potem animuj kartę
    setTimeout(() => {
        const card = document.querySelector(`#notes-list .note-card[data-id="${id}"]`);
        animateCardRemoval(card, 'removing-trash', () => {
            trashNote(id);
            renderNotes();
            renderTrash();
        });
    }, 320);
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
    sessionStartTranscript = finalTranscript;
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

// Klik na <a> w kontentedytowalnym otwiera link zamiast stawiać kursor
document.getElementById('view-note-content').addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    window.open(a.href, '_blank', 'noopener,noreferrer');
});

// Po zakończeniu edycji (blur) — zre-linkifikuj żeby nowe URL-e wklejone
// w trakcie pisania stały się klikalne. Robimy to tylko gdy treść się
// zmieniła względem zapisanej (czyli po flushu), żeby nie resetować
// kursora podczas pisania.
document.getElementById('view-note-content').addEventListener('blur', () => {
    flushViewEdit();
    if (!currentViewNoteId) return;
    const el = document.getElementById('view-note-content');
    const plain = el.textContent || '';
    el.innerHTML = linkifyHtml(plain);
});

// Enter w widoku notatki: zachowujemy plain-text linebreak + auto-numerowanie list.
document.getElementById('view-note-content').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();

    const el = e.currentTarget;
    const text = el.textContent || '';
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
        document.execCommand('insertLineBreak');
        return;
    }

    // Oblicz offset kursora w textContent
    const range = sel.getRangeAt(0);
    const pre = range.cloneRange();
    pre.selectNodeContents(el);
    pre.setEnd(range.endContainer, range.endOffset);
    const pos = pre.toString().length;

    const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
    const lineEndIdx = text.indexOf('\n', pos);
    const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx;
    const line = text.substring(lineStart, lineEnd);

    const numMatch = line.match(/^(\s*)(\d+)\.(\s?)(.*)$/);
    const bulletMatch = line.match(/^(\s*)([-*•])\s(.*)$/);
    const match = numMatch || bulletMatch;

    if (!match) {
        document.execCommand('insertLineBreak');
        return;
    }

    const rest = numMatch ? match[4] : match[3];
    if (rest.trim() === '') {
        // Pusty element — wyjdź z listy: usuń prefiks i zrób break
        for (let i = 0; i < line.length; i++) {
            document.execCommand('delete');
        }
        document.execCommand('insertLineBreak');
        return;
    }

    const indent = match[1];
    const sepSpace = numMatch ? match[3] : ' ';
    const prefix = numMatch
        ? `${indent}${parseInt(match[2], 10) + 1}.${sepSpace}`
        : `${indent}${match[2]} `;

    document.execCommand('insertLineBreak');
    document.execCommand('insertText', false, prefix);
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
    sessionStartTranscript = '';
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
// Auto-numerowanie list: "1. coś" + Enter → nowa linia zaczyna się "2. ".
// Dla punktorów "- " / "* " kontynuuje ten sam znak. Pusty element listy
// + Enter → wychodzimy z listy (czyszczenie prefiksu).
(function setupListAutoContinue() {
    const ta = document.getElementById('text-note-content');
    if (!ta) return;

    ta.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey) return;

        const val = ta.value;
        const pos = ta.selectionStart;
        // Tylko gdy brak zaznaczenia — nie nadpisujemy zaznaczonego tekstu
        if (ta.selectionEnd !== pos) return;

        const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
        const lineEndIdx = val.indexOf('\n', pos);
        const lineEnd = lineEndIdx === -1 ? val.length : lineEndIdx;
        const line = val.substring(lineStart, lineEnd);

        // "  3. tekst" lub "3.tekst" — spacja po kropce opcjonalna
        const numMatch = line.match(/^(\s*)(\d+)\.(\s?)(.*)$/);
        // "- tekst" / "* tekst" — punktory (tu wymagamy spacji, żeby
        // nie mylić myślnika w tekście z punktorem)
        const bulletMatch = line.match(/^(\s*)([-*•])\s(.*)$/);

        const match = numMatch || bulletMatch;
        if (!match) return;

        const indent = match[1];
        const marker = match[2];
        const sepSpace = numMatch ? match[3] : ' '; // spacja po markerze (lub jej brak przy "1.foo")
        const rest    = numMatch ? match[4] : match[3];

        // Pusty element listy (np. "3. " / "3." bez treści) + Enter → wyjdź z listy
        if (rest.trim() === '') {
            e.preventDefault();
            ta.setRangeText('', lineStart, lineEnd, 'end');
            return;
        }

        // Kontynuacja listy — zachowaj styl (ze spacją lub bez, jak w oryginale)
        e.preventDefault();
        const prefix = numMatch
            ? `\n${indent}${parseInt(marker, 10) + 1}.${sepSpace}`
            : `\n${indent}${marker} `;
        ta.setRangeText(prefix, pos, pos, 'end');

        // Wymuś input event, żeby ewentualne resize/auto-grow zadziałały
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
})();

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
let activeSessionId = 0;   // incremented on each new recognition session
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


// Transcript zebrany PRZED rozpoczęciem bieżącej sesji rozpoznawania.
// Każda sesja dodaje tekst na wierzch tego bufora.
let sessionStartTranscript = '';

// Czas ostatniej aktywności mowy (interim lub final) — dla auto-restartu
let lastSpeechTime = 0;

// Ile milisekund ciszy akceptujemy zanim pokażemy stan "paused"
const SILENCE_GRACE_MS = 5000;

function buildRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return null;

    const r = new SpeechRecognition();
    r.lang = 'pl-PL';
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    const myId = ++activeSessionId;

    r.onstart = () => { sessionActive = true; };

    r.onresult = (event) => {
        if (myId !== activeSessionId) return; // stale event from old session
        lastSpeechTime = Date.now();

        // MIUI/Xiaomi bugi które obsługujemy:
        //  (a) te same finals pod wieloma indeksami (duplikat w event.results)
        //  (b) rozszerzanie final-a: najpierw "idę" jako final, potem "idę do"
        //      jako osobny final — wygląda jakby silnik refine-ował poprzedni
        //  (c) resultIndex resetowany do 0 → cała lista event.results re-fire-owana
        //
        // Rozwiązanie: zawsze przebudowujemy cały tekst sesji od zera,
        // łącząc finals w jedną listę z wykrywaniem refine-ów i duplikatów.

        let interim = '';
        const finals = [];
        for (let i = 0; i < event.results.length; i++) {
            const res = event.results[i];
            if (res.isFinal) {
                const text = res[0].transcript.trim();
                if (text) finals.push(text);
            } else {
                interim += res[0].transcript;
            }
        }

        // Zmerge-uj finals: jeśli nowy final zaczyna się od poprzedniego,
        // to traktuj jako refine (zastąp). Jeśli jest identyczny — pomiń.
        const phrases = [];
        for (const text of finals) {
            if (phrases.length > 0) {
                const last = phrases[phrases.length - 1];
                const lastLow = last.toLowerCase();
                const textLow = text.toLowerCase();
                if (textLow === lastLow) continue;                   // czysty duplikat
                if (textLow.startsWith(lastLow + ' ') || textLow === lastLow) {
                    phrases[phrases.length - 1] = text;              // refine (rozszerzenie)
                    continue;
                }
                if (lastLow.startsWith(textLow + ' ') || lastLow === textLow) {
                    continue;                                        // nowy jest zawarty w starym
                }
            }
            phrases.push(text);
        }

        // KRYTYCZNE: Xiaomi po wznowieniu sesji czasem emituje ponownie
        // tekst z POPRZEDNIEJ sesji w event.results. Jeśli pierwsze frazy
        // nowej sesji są już końcówką sessionStartTranscript — odrzuć je,
        // inaczej zduplikowały by się 1x lub więcej razy.
        const startLow = sessionStartTranscript.toLowerCase().trim();
        while (phrases.length > 0) {
            const firstLow = phrases[0].toLowerCase();
            // fraza jest już końcem sessionStart? → pomiń
            if (startLow.endsWith(firstLow) || startLow.endsWith(' ' + firstLow)) {
                phrases.shift();
            } else {
                break;
            }
        }

        const sessionText = phrases.join(' ');
        const sep = (sessionStartTranscript && sessionText && !sessionStartTranscript.endsWith(' ')) ? ' ' : '';
        finalTranscript = sessionStartTranscript + sep + sessionText;

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

        // Jeśli użytkownik mówił w ciągu ostatnich 5 sekund — kontynuuj
        // po cichu nową sesją (jest jedna emisja earcona, ale dyktowanie
        // nie urywa się na każdej krótkiej przerwie w mowie).
        const silenceMs = Date.now() - lastSpeechTime;
        if (silenceMs < SILENCE_GRACE_MS) {
            // Przed nową sesją: stan sprzed niej = obecny finalTranscript
            sessionStartTranscript = finalTranscript;
            try {
                recognition = buildRecognition();
                if (recognition) {
                    recognition.start();
                    return; // zostajemy w stanie recording
                }
            } catch (e) {
                console.error('Auto-restart failed:', e);
            }
        }

        // Dłuższa cisza (≥5s) lub błąd — przejście w stan pauzy
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
    // Zanim stworzymy recognition — zapamiętaj obecny tekst jako bazę
    // dla nowej sesji. Wszystkie wyniki z tej sesji zostaną doklejone
    // do niej, bez ryzyka zdublowania tekstu sprzed pauzy.
    sessionStartTranscript = finalTranscript;
    // Liczymy ciszę od momentu startu — jeśli użytkownik nic nie powie
    // i silnik zakończy sesję, trafimy w stan "paused" zamiast loopa.
    lastSpeechTime = Date.now();

    recognition = buildRecognition();
    if (!recognition) return;
    sessionActive = false;
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

// Zielony przycisk akceptacji w ekranach edycji — zachowanie zależne od ekranu:
//   • text-note-screen  → zapisz treść (jak kliknięcie "Zapisz")
//   • voice-note-screen → zatrzymaj mikrofon + zapisz treść
//   • view-note-screen  → flush inline-edit i wróć do listy
document.querySelectorAll('.accept-btn[data-action="accept"]').forEach(btn => {
    btn.addEventListener('click', () => {
        const screen = btn.closest('.screen');
        if (!screen) return;
        if (screen.id === 'text-note-screen') {
            document.getElementById('save-text-note').click();
        } else if (screen.id === 'voice-note-screen') {
            document.getElementById('save-voice-note').click();
        } else if (screen.id === 'view-note-screen') {
            flushViewEdit();
            currentViewNoteId = null;
            hideAllOverlays();
        } else {
            hideAllOverlays();
        }
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
// Web Share Target — odbieranie treści udostępnionej z innych aplikacji
// (Android: TikTok/FB/Messenger/Chrome → "Udostępnij" → Notatnik)
// =============================================================================
// Przy starcie czytamy parametry z URL-a; jeśli ktoś "udostępnił" nam tekst,
// zapisujemy go w sessionStorage i po zalogowaniu otwieramy ekran nowej
// notatki z pre-fillowaną treścią.

(function captureIncomingShare() {
    const params = new URLSearchParams(window.location.search);
    const title = params.get('shared_title');
    const text  = params.get('shared_text');
    const url   = params.get('shared_url');
    if (!title && !text && !url) return;
    sessionStorage.setItem('pendingShare', JSON.stringify({ title, text, url }));
    // Wyczyść URL, żeby odświeżenie strony nie odpalało importu ponownie
    history.replaceState({}, '', window.location.pathname);
})();

function consumePendingShare() {
    const raw = sessionStorage.getItem('pendingShare');
    if (!raw) return;
    sessionStorage.removeItem('pendingShare');

    let data;
    try { data = JSON.parse(raw); } catch { return; }

    const parts = [];
    if (data.title) parts.push(data.title);
    if (data.text)  parts.push(data.text);
    if (data.url)   parts.push(data.url);
    const content = parts.filter(Boolean).join('\n\n').trim();
    if (!content) return;

    // Otwórz ekran notatki tekstowej z pre-fillowaną treścią
    currentEditNoteId = null;
    const ta = document.getElementById('text-note-content');
    if (!ta) return;
    ta.value = content;
    document.querySelector('#text-note-screen .screen-title').textContent = 'Udostępniona treść';
    showOverlay('text-note-screen');
    // Kursor na końcu (żeby user mógł dopisać coś jeszcze)
    setTimeout(() => {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
    }, 350);
}

// =============================================================================
// Init
// =============================================================================
checkSession();
