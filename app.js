// ===== Supabase config =====
const SUPABASE_URL = 'https://lfajvdairiuqstkygrnp.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxmYWp2ZGFpcml1cXN0a3lncm5wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxNzUyNTIsImV4cCI6MjA5MTc1MTI1Mn0.j7OeYS3plpkDdy75MMo_vhO9ZSBN8OWM_pUirNvxkI0';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
});

let currentUser = null;
let syncInFlight = false;

// ===== Storage (per user) =====
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

function nowIso() { return new Date().toISOString(); }

function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    // Fallback
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

function deleteNote(id) {
    const notes = getNotes();
    const n = notes.find(x => x.id === id);
    if (!n) return;
    n.deletedAt = nowIso();
    n.updatedAt = n.deletedAt;
    n.pending = true;
    saveNotes(notes);
    scheduleSync();
}

// ===== Sync =====
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
    // Debounce
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
            // Update local with server timestamps
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
                // Don't clobber unpushed local changes
                if (!local || !local.pending) byId.set(r.id, remoteNote);
            }
            if (!pullStamp || r.updated_at > pullStamp) pullStamp = r.updated_at;
        }

        saveNotes(Array.from(byId.values()));
        if (pullStamp) localStorage.setItem(lastSyncKey(), pullStamp);

        setSyncStatus('synced');
        if (document.getElementById('home-screen').classList.contains('active')) {
            renderNotes();
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

// ===== Auth =====
async function checkSession() {
    const { data: { session } } = await sb.auth.getSession();
    if (session) {
        onLoggedIn(session.user);
    } else {
        showScreen('auth-screen');
    }
}

function onLoggedIn(user) {
    currentUser = user;
    document.getElementById('user-email').textContent = user.email;
    setSyncStatus(navigator.onLine ? 'syncing' : 'offline');
    showScreen('home-screen');
    sync();
    subscribeRealtime();
}

let realtimeChannel = null;
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

// ===== Auth UI =====
let authMode = 'login'; // 'login' | 'signup'

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
    showScreen('auth-screen');
    document.getElementById('auth-email').value = '';
    document.getElementById('auth-password').value = '';
});

// ===== Navigation =====
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
    if (screenId === 'home-screen') renderNotes();
}

// ===== Render notes list =====
function renderNotes() {
    const list = document.getElementById('notes-list');
    const notes = visibleNotes();
    const emptyState = document.getElementById('empty-state');
    const swipeHint = document.getElementById('swipe-hint');

    list.querySelectorAll('.note-card-wrapper').forEach(c => c.remove());

    if (notes.length === 0) {
        emptyState.style.display = '';
        swipeHint.classList.add('hidden');
        return;
    }

    emptyState.style.display = 'none';
    swipeHint.classList.remove('hidden');

    notes.forEach(note => {
        const wrapper = document.createElement('div');
        wrapper.className = 'note-card-wrapper';

        const date = new Date(note.createdAt);
        const dateStr = date.toLocaleDateString('pl-PL', {
            day: 'numeric', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });

        const iconSvg = note.type === 'voice'
            ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>'
            : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';

        wrapper.innerHTML = `
            <div class="note-card-bg">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
                Usuń
            </div>
            <div class="note-card" data-id="${note.id}">
                <div class="note-card-icon">${iconSvg}</div>
                <div class="note-card-body">
                    <div class="note-card-title">${escapeHtml(note.title || 'Bez tytułu')}</div>
                    <div class="note-card-preview">${escapeHtml(note.content)}</div>
                    <div class="note-card-date">${dateStr}</div>
                </div>
                <button class="note-card-delete" title="Usuń">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                </button>
            </div>
        `;

        const card = wrapper.querySelector('.note-card');

        wrapper.querySelector('.note-card-delete').addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm('Czy na pewno chcesz usunąć tę notatkę?')) {
                deleteNote(note.id);
                renderNotes();
            }
        });

        card.addEventListener('click', () => {
            if (!card.classList.contains('swiped')) viewNote(note.id);
        });

        setupSwipe(wrapper, card, note.id);
        list.appendChild(wrapper);
    });
}

// ===== Swipe to Delete =====
function setupSwipe(wrapper, card, noteId) {
    let startX = 0;
    let currentX = 0;
    let isDragging = false;
    const threshold = 120;

    card.addEventListener('touchstart', (e) => {
        startX = e.touches[0].clientX;
        currentX = 0;
        isDragging = true;
        card.classList.add('swiping');
    }, { passive: true });

    card.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        currentX = e.touches[0].clientX - startX;
        if (currentX < 0) currentX = 0;
        card.style.transform = `translateX(${currentX}px)`;
    }, { passive: true });

    card.addEventListener('touchend', () => {
        isDragging = false;
        card.classList.remove('swiping');

        if (currentX > threshold) {
            card.style.transition = 'transform 0.3s ease';
            card.style.transform = `translateX(${window.innerWidth}px)`;
            setTimeout(() => { deleteNote(noteId); renderNotes(); }, 300);
        } else {
            card.style.transition = 'transform 0.2s ease';
            card.style.transform = 'translateX(0)';
        }
        setTimeout(() => { card.style.transition = ''; }, 300);
    });

    card.addEventListener('mousedown', (e) => {
        startX = e.clientX;
        currentX = 0;
        isDragging = true;
        card.classList.add('swiping');
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        currentX = e.clientX - startX;
        if (currentX < 0) currentX = 0;
        card.style.transform = `translateX(${currentX}px)`;
    });

    document.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;
        card.classList.remove('swiping');

        if (currentX > threshold) {
            card.style.transition = 'transform 0.3s ease';
            card.style.transform = `translateX(${window.innerWidth}px)`;
            setTimeout(() => { deleteNote(noteId); renderNotes(); }, 300);
        } else {
            card.style.transition = 'transform 0.2s ease';
            card.style.transform = 'translateX(0)';
        }
        setTimeout(() => { card.style.transition = ''; }, 300);
    });
}

let currentViewNoteId = null;

function viewNote(id) {
    const note = getNotes().find(n => n.id === id);
    if (!note) return;

    currentViewNoteId = id;
    document.getElementById('view-note-title').textContent = note.title || 'Bez tytułu';
    document.getElementById('view-note-type').textContent = note.type === 'voice' ? 'Notatka głosowa' : 'Notatka pisemna';
    document.getElementById('view-note-content').textContent = note.content;

    const date = new Date(note.createdAt);
    document.getElementById('view-note-date').textContent = date.toLocaleDateString('pl-PL', {
        day: 'numeric', month: 'long', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });

    showScreen('view-note-screen');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ===== Top Bar Buttons =====
document.getElementById('open-text-btn').addEventListener('click', () => {
    document.getElementById('text-note-title').value = '';
    document.getElementById('text-note-content').value = '';
    showScreen('text-note-screen');
    document.getElementById('text-note-title').focus();
});

document.getElementById('open-voice-btn').addEventListener('click', () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        alert('Twoja przeglądarka nie wspiera rozpoznawania mowy. Użyj Chrome lub Edge.');
        return;
    }

    document.getElementById('voice-note-title').value = '';
    document.getElementById('voice-note-content').textContent = '';
    finalTranscript = '';
    recSeconds = 0;
    document.getElementById('recorder-time').textContent = '00:00';
    document.getElementById('recording-status').textContent = 'Kliknij aby nagrywać';
    document.getElementById('recording-status').classList.remove('active');
    document.getElementById('recorder-circle').classList.remove('recording');
    showScreen('voice-note-screen');

    setTimeout(() => startRecording(), 200);
});

document.getElementById('trash-mode-btn').addEventListener('click', () => {
    const hint = document.getElementById('swipe-hint');
    hint.classList.toggle('hidden');
    document.getElementById('trash-mode-btn').classList.toggle('active-trash');
});

// ===== Text Note Save/Discard =====
document.getElementById('save-text-note').addEventListener('click', () => {
    const title = document.getElementById('text-note-title').value.trim();
    const content = document.getElementById('text-note-content').value.trim();

    if (!content && !title) { alert('Wpisz treść notatki.'); return; }

    addNote({ title, content, type: 'text' });
    showScreen('home-screen');
});

document.getElementById('discard-text').addEventListener('click', () => {
    showScreen('home-screen');
});

// ===== Voice Note =====
let recognition = null;
let isRecording = false;
let finalTranscript = '';
let recTimer = null;
let recSeconds = 0;
let seenFinalIndices = new Set(); // fix for Android Chrome duplicating onresult events

document.getElementById('recorder-circle').addEventListener('click', () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        alert('Twoja przeglądarka nie wspiera rozpoznawania mowy. Użyj Chrome lub Edge.');
        return;
    }
    if (isRecording) stopRecording();
    else startRecording();
});

function startRecording() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    seenFinalIndices.clear();
    recognition = new SpeechRecognition();
    recognition.lang = 'pl-PL';
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
        let interim = '';

        // Walk ALL results and only commit finals we haven't seen yet in this session.
        // event.resultIndex is unreliable on Android Chrome (Xiaomi/MIUI) — it may stay
        // at 0 and re-emit the same final result causing 10-20x duplication.
        for (let i = 0; i < event.results.length; i++) {
            const result = event.results[i];
            const transcript = result[0].transcript;
            if (result.isFinal) {
                if (!seenFinalIndices.has(i)) {
                    finalTranscript += transcript;
                    seenFinalIndices.add(i);
                }
            } else {
                interim += transcript;
            }
        }

        const container = document.getElementById('voice-note-content');
        container.innerHTML = escapeHtml(finalTranscript) +
            (interim ? '<span class="interim">' + escapeHtml(interim) + '</span>' : '');
    };

    recognition.onerror = (event) => {
        console.error('Speech recognition error:', event.error);
        if (event.error === 'no-speech') return;
        if (event.error === 'not-allowed') {
            alert('Brak dostępu do mikrofonu. Zezwól na dostęp w ustawieniach przeglądarki.\n\nUwaga: Rozpoznawanie mowy wymaga serwera HTTP (localhost) — nie działa z file://.');
            stopRecording();
            return;
        }
        stopRecording();
    };

    recognition.onend = () => {
        // New session — results list resets, so our seen-set must reset too.
        seenFinalIndices.clear();
        if (isRecording) {
            // Small delay so the browser fully tears down the old session before we
            // start a new one (avoids race that also contributes to duplicates).
            setTimeout(() => {
                if (isRecording) {
                    try { recognition.start(); } catch (e) { stopRecording(); }
                }
            }, 120);
        }
    };

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
        recognition.stop();
        recognition = null;
    }
    if (recTimer) { clearInterval(recTimer); recTimer = null; }

    document.getElementById('recorder-circle').classList.remove('recording');
    document.getElementById('recording-status').textContent = 'Kliknij aby nagrywać';
    document.getElementById('recording-status').classList.remove('active');

    const container = document.getElementById('voice-note-content');
    container.textContent = finalTranscript;
}

function updateTimerDisplay() {
    const min = String(Math.floor(recSeconds / 60)).padStart(2, '0');
    const sec = String(recSeconds % 60).padStart(2, '0');
    document.getElementById('recorder-time').textContent = `${min}:${sec}`;
}

document.getElementById('save-voice-note').addEventListener('click', () => {
    stopRecording();

    const title = document.getElementById('voice-note-title').value.trim();
    const content = document.getElementById('voice-note-content').textContent.trim();

    if (!content && !title) { alert('Nagraj lub wpisz treść notatki.'); return; }

    addNote({ title, content, type: 'voice' });
    showScreen('home-screen');
});

document.getElementById('discard-voice').addEventListener('click', () => {
    stopRecording();
    showScreen('home-screen');
});

// ===== Delete from view =====
document.getElementById('delete-from-view').addEventListener('click', () => {
    if (currentViewNoteId && confirm('Czy na pewno chcesz usunąć tę notatkę?')) {
        deleteNote(currentViewNoteId);
        currentViewNoteId = null;
        showScreen('home-screen');
    }
});

// ===== Back buttons =====
document.querySelectorAll('.back-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        stopRecording();
        showScreen(btn.dataset.screen);
    });
});

// ===== PWA: Install prompt + Service Worker =====
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    // Show banner unless user previously dismissed it
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
    if (outcome === 'dismissed') {
        localStorage.setItem('installDismissed', '1');
    }
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

// ===== Init =====
checkSession();
