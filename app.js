// ===== Storage =====
function getNotes() {
    return JSON.parse(localStorage.getItem('notes') || '[]');
}

function saveNotes(notes) {
    localStorage.setItem('notes', JSON.stringify(notes));
}

function addNote(note) {
    const notes = getNotes();
    note.id = Date.now().toString();
    note.createdAt = new Date().toISOString();
    notes.unshift(note);
    saveNotes(notes);
    return note;
}

function deleteNote(id) {
    const notes = getNotes().filter(n => n.id !== id);
    saveNotes(notes);
}

// ===== Navigation =====
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
    if (screenId === 'home-screen') renderNotes();
}

// ===== Render notes list =====
function renderNotes() {
    const list = document.getElementById('notes-list');
    const notes = getNotes();
    const emptyState = document.getElementById('empty-state');
    const swipeHint = document.getElementById('swipe-hint');

    // Remove all note cards
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

        // Delete button (desktop)
        wrapper.querySelector('.note-card-delete').addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm('Czy na pewno chcesz usunąć tę notatkę?')) {
                deleteNote(note.id);
                renderNotes();
            }
        });

        // Click to view
        card.addEventListener('click', () => {
            if (!card.classList.contains('swiped')) {
                viewNote(note.id);
            }
        });

        // Swipe to delete
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
        // Only allow right swipe
        if (currentX < 0) currentX = 0;
        card.style.transform = `translateX(${currentX}px)`;
    }, { passive: true });

    card.addEventListener('touchend', () => {
        isDragging = false;
        card.classList.remove('swiping');

        if (currentX > threshold) {
            // Swipe complete - delete
            card.style.transition = 'transform 0.3s ease';
            card.style.transform = `translateX(${window.innerWidth}px)`;
            setTimeout(() => {
                deleteNote(noteId);
                renderNotes();
            }, 300);
        } else {
            // Snap back
            card.style.transition = 'transform 0.2s ease';
            card.style.transform = 'translateX(0)';
        }

        setTimeout(() => {
            card.style.transition = '';
        }, 300);
    });

    // Mouse support for desktop
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
            setTimeout(() => {
                deleteNote(noteId);
                renderNotes();
            }, 300);
        } else {
            card.style.transition = 'transform 0.2s ease';
            card.style.transform = 'translateX(0)';
        }

        setTimeout(() => {
            card.style.transition = '';
        }, 300);
    });
}

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

let currentViewNoteId = null;

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

    // Od razu włącz nagrywanie
    setTimeout(() => startRecording(), 200);
});

// Trash mode button (currently shows hint)
document.getElementById('trash-mode-btn').addEventListener('click', () => {
    const hint = document.getElementById('swipe-hint');
    hint.classList.toggle('hidden');
    document.getElementById('trash-mode-btn').classList.toggle('active-trash');
});

// ===== Text Note Save/Discard =====
document.getElementById('save-text-note').addEventListener('click', () => {
    const title = document.getElementById('text-note-title').value.trim();
    const content = document.getElementById('text-note-content').value.trim();

    if (!content && !title) {
        alert('Wpisz treść notatki.');
        return;
    }

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

function startRecording() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    recognition = new SpeechRecognition();
    recognition.lang = 'pl-PL';
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
        let interim = '';
        let finalChunk = '';

        for (let i = event.resultIndex; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
                finalChunk += transcript;
            } else {
                interim += transcript;
            }
        }

        if (finalChunk) {
            finalTranscript += finalChunk;
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
        if (isRecording) {
            try { recognition.start(); } catch (e) { stopRecording(); }
        }
    };

    recognition.start();
    isRecording = true;

    // Timer
    recSeconds = 0;
    updateTimerDisplay();
    recTimer = setInterval(() => {
        recSeconds++;
        updateTimerDisplay();
    }, 1000);

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

    if (recTimer) {
        clearInterval(recTimer);
        recTimer = null;
    }

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

    if (!content && !title) {
        alert('Nagraj lub wpisz treść notatki.');
        return;
    }

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

// ===== Init =====
renderNotes();
