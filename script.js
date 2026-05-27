/* ============================================================
 * kolsoté v2 — live cue manager
 * @budibaik — bikin pake ai, buat campers ttv, yang mau-mau ajaaa
 * ============================================================ */

/* author kanan bawah */
function setupGlobalListeners(){window.addEventListener("click",e=>{document.getElementById("authorBadge").contains(e.target)||collapseBadge()})}function setupBadgeInteraction(){const e=document.getElementById("authorBadge");e.addEventListener("click",t=>{t.stopPropagation(),e.classList.contains("expanded")?collapseBadge():expandBadge()})}function expandBadge(){const e=document.getElementById("authorBadge"),t=document.getElementById("badgeImage");e.classList.add("expanded"),setTimeout(()=>{e.classList.contains("expanded")&&(t.src="me.png")},100)}function collapseBadge(){const e=document.getElementById("authorBadge"),t=document.getElementById("badgeImage");e.classList.contains("expanded")&&(e.classList.remove("expanded"),t.src="https://pbs.twimg.com/profile_images/1508472991495073792/QRFRs-UO_400x400.jpg")}document.addEventListener("DOMContentLoaded",()=>{setupGlobalListeners(),setupBadgeInteraction()});
 

/* ===== FIREBASE CONFIG — replace with your own keys ===== */
const firebaseConfig = {
    apiKey:            "AIzaSyC0QPfns9EIfMasNvNOteMEIcifrwb61yU",
    authDomain:        "kolsote-01.firebaseapp.com",
    databaseURL:       "https://kolsote-01-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId:         "kolsote-01",
    storageBucket:     "kolsote-01.firebasestorage.app",
    messagingSenderId: "267838871958",
    appId:             "1:267838871958:web:8fee10a2bb19f7596325b7"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

/* ===== CONSTANTS ===== */
const PROJECTS_KEY   = 'kolsote_Projects_v2';
const VIS_FLAGS_KEY  = 'kolsote_Vis_Flags';
const UI_SETTINGS_KEY = 'kolsote_UI_Settings';
const USERNAME_KEY   = 'kolsote_Username';
const ROOM_KEY       = 'kolsote_RoomId';
const APP_KEYS = [PROJECTS_KEY, VIS_FLAGS_KEY, UI_SETTINGS_KEY, USERNAME_KEY, ROOM_KEY,
                  'cueApp_Projects_Database','cueApp_Username','cueApp_Vis_Flags',
                  'kolsote_UI_Settings','cueApp_Definitive_Data','kolsote_RoomId'];
const PRESETS = ['#ff0000','#00f2ff','#00e676','#ffb300','#FFFF00','#7c4dff',
                 '#ffffff','#00BFFF','#D2691E','#FF00FF'];
const PIXELS_PER_SECOND = 40;
const MAX_UNDO_STEPS = 30;

/* ===== STATE ===== */
let allProjects   = [];
let activeProjectId = null;
let cueData       = [];
let selectedIndex = 0;

// Playback
let isRunning     = false;
let startTime     = null;
let pausedAt      = 0;
let animationId   = null;
let playerType    = 'none';
let ytPlayer      = null;
let lastActiveIdx = -1;
let lastMasterIndex = -1;
let lastFilterIndex = -1;
const cueNodeCache = { master: [], filter: [] };
let currentFilterCam = 'all';

// Undo / Redo
let undoStack = [];
let redoStack = [];

// Firebase / Network
let currentRoomId  = 'campers';
let sessionRef     = null;
let hostActiveListener = null;
let followerListeners  = [];   // track all .on() listeners so we can .off() them cleanly
let isHost         = false;
let userRole       = 'standalone';
let username       = '';
let myFollowerRef  = null;
let globalHostActive = false;
let serverClockOffset = 0;     // ms offset between local Date.now() and server time
let knownHostIds = new Set();  // tracks project ids ever received from host, for delete detection
let _pendingNavProjectId = null; // nav race fix: nav arrived before allProjects data

// Drag & Drop touch state
let touchDragIndex  = -1;
let touchDragEl     = null;
let touchDragClone  = null;

// Visibility
let visSettings = {
    master: { time: true, inst: true, lyric: true },
    filter: { time: true, inst: true, lyric: true }
};

/* ===== YOUTUBE API ===== */
let ytApiReady = false;
window.onYouTubeIframeAPIReady = () => { ytApiReady = true; };

/* ===== SPLASH ===== */
function dismissSplash() {
    document.getElementById('splash-screen').classList.add('fade-out');
}

/* ===== UTILITIES ===== */
function generateId() {
    if (window.crypto?.getRandomValues) {
        const arr = new Uint32Array(2);
        crypto.getRandomValues(arr);
        return arr[0] * 4294967296 + arr[1];
    }
    return Date.now() + Math.floor(Math.random() * 1e9);
}

function sanitizeText(str) {
    if (typeof str !== 'string') return '';
    const el = document.createElement('div');
    el.textContent = str;
    return el.innerHTML;
}

function safeJSONParse(key, fallback) {
    try {
        const v = localStorage.getItem(key);
        return v ? JSON.parse(v) : fallback;
    } catch { return fallback; }
}

function safeSetLocal(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch (e) {
        if (e.name === 'QuotaExceededError') showToast('Storage full! Delete some projects.', 'error');
        else showToast('Failed to save.', 'warning');
    }
}

function formatTime(s) {
    if (isNaN(s) || s < 0) return '00:00.0';
    const m  = Math.floor(s / 60).toString().padStart(2, '0');
    const ss = Math.floor(s % 60).toString().padStart(2, '0');
    const ms = Math.floor((s % 1) * 10);
    return `${m}:${ss}.${ms}`;
}

/* ===== UNDO / REDO ===== */
function snapshotForUndo() {
    undoStack.push(JSON.stringify(cueData));
    if (undoStack.length > MAX_UNDO_STEPS) undoStack.shift();
    redoStack = [];
    refreshUndoButtons();
}

function undoAction() {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(cueData));
    cueData = JSON.parse(undoStack.pop());
    renderStaticCues();
    debouncedSave();
    refreshUndoButtons();
    showToast('Undo', 'info', 1500);
}

function redoAction() {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(cueData));
    cueData = JSON.parse(redoStack.pop());
    renderStaticCues();
    debouncedSave();
    refreshUndoButtons();
    showToast('Redo', 'info', 1500);
}

function refreshUndoButtons() {
    const u = document.getElementById('btn-undo');
    const r = document.getElementById('btn-redo');
    if (u) u.disabled = undoStack.length === 0;
    if (r) r.disabled = redoStack.length === 0;
}

/* ===== ONLINE / OFFLINE BADGE ===== */
function updateOnlineBadge() {
    const badge = document.getElementById('offline-badge');
    if (badge) badge.style.display = navigator.onLine ? 'none' : 'block';
}
window.addEventListener('online', updateOnlineBadge);
window.addEventListener('offline', updateOnlineBadge);
window.addEventListener('beforeunload', () => disconnectNetwork());

/* ===== INITIALISATION ===== */
window.onload = () => {
    // Migrate legacy storage key
    const legacy = safeJSONParse('cueApp_Projects_Database', null);
    if (legacy && !localStorage.getItem(PROJECTS_KEY)) {
        safeSetLocal(PROJECTS_KEY, JSON.stringify(legacy));
    }

    const savedVis = safeJSONParse(VIS_FLAGS_KEY, null);
    if (savedVis) visSettings = savedVis;

    const savedUser = localStorage.getItem(USERNAME_KEY);
    if (savedUser) {
        username = savedUser;
        const el = document.getElementById('inputUsername');
        if (el) el.value = savedUser;
    }

    allProjects = safeJSONParse(PROJECTS_KEY, []);

    // Legacy single-project migration
    if (!allProjects.length) {
        const legacyCues = safeJSONParse('cueApp_Definitive_Data', null);
        if (legacyCues) {
            allProjects = [{ id: generateId(), name: 'Imported Project', cues: legacyCues }];
            localStorage.removeItem('cueApp_Definitive_Data');
            safeSetLocal(PROJECTS_KEY, JSON.stringify(allProjects));
        }
    }

    renderProjects();
    loadUISettings();
    renderStaticCues();
    applyVisibility();
    updateViewSettings();
    updateOnlineBadge();
    setupDragAndDrop();
    setupFirebase();
    refreshUndoButtons();
    triggerHitCounter();
    setupPanels();

    // Splash auto-dismiss after 2s if user hasn't clicked
    setTimeout(dismissSplash, 2200);
};

/* ===== PANEL SYSTEM ===== */
function setupPanels() {
    const overlay = document.getElementById('overlay');
    let activePanel = null;

    const openPanel = (id) => {
        const panel = document.getElementById(id);
        if (!panel || activePanel) return;
        // Pure CSS transition approach — just toggle the class.
        // CSS handles visibility delay so there is no JS timing race.
        panel.classList.add('is-open');
        overlay.classList.add('is-open');
        activePanel = panel;
    };

    const closePanel = () => {
        if (!activePanel) return;
        const panel = activePanel;
        activePanel = null;
        overlay.classList.remove('is-open');
        // Removing is-open triggers the CSS slide-out transition.
        // The visibility:hidden delay in CSS ensures the panel goes
        // invisible only AFTER the slide fully completes — no flash.
        panel.classList.remove('is-open');
    };

    document.querySelectorAll('[data-target-panel]').forEach(btn => {
        btn.addEventListener('click', () => openPanel(btn.dataset.targetPanel));
    });
    document.querySelectorAll('.close-btn').forEach(btn => {
        btn.addEventListener('click', closePanel);
    });
    overlay.addEventListener('click', closePanel);
}

/* ===== STORAGE ===== */
function saveToDisk() {
    if (activeProjectId !== null) {
        const idx = allProjects.findIndex(p => p.id == activeProjectId);
        if (idx !== -1) allProjects[idx].cues = cueData;
    }
    safeSetLocal(PROJECTS_KEY, JSON.stringify(allProjects));
    if (isHost) broadcastAllProjects();
}

let saveTimer;
function debouncedSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveToDisk, 500);
}

/* ===== UI SETTINGS ===== */
function saveUISettings() {
    const s = {
        viewMode:         document.getElementById('viewModeSelect')?.value || 'single',
        dashboardVisible: document.getElementById('toggleCheckbox')?.checked || false,
        camFilter:        document.getElementById('camFilterSelect')?.value || 'all'
    };
    safeSetLocal(UI_SETTINGS_KEY, JSON.stringify(s));
}

function loadUISettings() {
    const s = safeJSONParse(UI_SETTINGS_KEY, { viewMode: 'single', dashboardVisible: false, camFilter: 'all' });
    const vmEl = document.getElementById('viewModeSelect');
    const chk  = document.getElementById('toggleCheckbox');
    const cfEl = document.getElementById('camFilterSelect');
    const dash = document.getElementById('myDiv');

    if (vmEl) vmEl.value = s.viewMode;
    if (cfEl) cfEl.value = s.camFilter;
    if (chk) {
        chk.checked = s.dashboardVisible;
        if (dash) dash.style.display = s.dashboardVisible ? 'grid' : 'none';
    }
    currentFilterCam = s.camFilter || 'all';
}

// Dashboard toggle
document.addEventListener('DOMContentLoaded', () => {
    const chk = document.getElementById('toggleCheckbox');
    const dash = document.getElementById('myDiv');
    if (chk && dash) {
        chk.addEventListener('change', () => {
            dash.style.display = chk.checked ? 'grid' : 'none';
            saveUISettings();
        });
    }
});

/* ===== PROJECT MANAGEMENT ===== */
function renderProjects() {
    const list = document.getElementById('project-list');
    if (!list) return;
    if (!allProjects.length) {
        list.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--muted);">
            <p style="margin-bottom:16px;font-family:var(--font-mono);font-size:0.8rem;">belom ada project. bikin dulu.</p>
            <button class="panel-item follower-hidden" onclick="createNewProject()" style="display:inline-block;">＋ NEW PROJECT</button>
        </div>`;
        return;
    }
    list.innerHTML = allProjects.map(p => {
        const total = p.cues.reduce((a, c) => a + (c.time || 0), 0);
        return `<div class="project-card" onclick="openProject('${p.id}')">
            <div class="project-card-header">
                <div class="project-card-title">${sanitizeText(p.name)}</div>
                <button class="project-del-btn" onclick="event.stopPropagation();deleteProjectById('${p.id}')">✕</button>
            </div>
            <div class="project-stats">${p.cues.length} cues &nbsp;·&nbsp; ${formatTime(total)} total</div>
        </div>`;
    }).join('');
}

if (!history.state) history.replaceState({ page: 'projects' }, '');

function createNewProject() {
    const modal = document.getElementById('create-project-modal');
    const input = document.getElementById('new-project-input');
    input.value = '';
    modal.style.display = 'flex';
    setTimeout(() => input.focus(), 50);
    input.onkeydown = (e) => {
        if (e.key === 'Enter') confirmCreateProject();
        if (e.key === 'Escape') closeCreateModal();
    };
}

function closeCreateModal() {
    document.getElementById('create-project-modal').style.display = 'none';
}

function confirmCreateProject() {
    const name = document.getElementById('new-project-input').value.trim();
    if (!name) { showToast('Enter a project name', 'warning'); return; }
    allProjects.push({ id: generateId(), name, cues: [] });
    saveToDisk();
    renderProjects();
    closeCreateModal();
    showToast(`"${sanitizeText(name)}" created`, 'success');
}

function openProject(id, isRemote = false) {
    if (userRole === 'client' && !isRemote) return;
    const proj = allProjects.find(p => p.id == id);
    if (!proj) return;

    activeProjectId = id;
    cueData = proj.cues ? proj.cues.map(c => Object.assign({}, c)) : [];
    undoStack = []; redoStack = [];
    refreshUndoButtons();

    document.getElementById('active-project-name').innerText = sanitizeText(proj.name);
    document.getElementById('page-projects').classList.remove('active');
    document.getElementById('page-cues').classList.add('active');
    renderStaticCues();

    if (isHost && !isRemote) {
        sessionRef?.child('nav').set({ page: 'project', projectId: id });
    }
    if (!history.state || history.state.page !== 'project' || history.state.id !== id) {
        history.pushState({ page: 'project', id }, '');
    }
}

window.addEventListener('popstate', (e) => {
    if (!e.state || e.state.page === 'projects') showProjectsPage();
    else if (e.state.page === 'project' && e.state.id) openProject(e.state.id);
});

function showProjectsPage(isRemote = false) {
    if (isRunning) togglePlayback();
    const vp = document.getElementById('video-pane');
    if (vp?.classList.contains('active')) toggleVideoPane();
    if (ytPlayer?.stopVideo) ytPlayer.stopVideo();

    const vid = document.getElementById('local-video');
    if (vid?.src?.startsWith('blob:')) { URL.revokeObjectURL(vid.src); vid.src = ''; }

    saveToDisk();
    document.getElementById('page-cues').classList.remove('active');
    document.getElementById('page-projects').classList.add('active');
    renderProjects();
    destroyYTPlayer();
    if (isHost && !isRemote) sessionRef?.child('nav').set({ page: 'list' });
}

function renameProject() {
    if (userRole === 'client') return;
    const proj = allProjects.find(p => p.id == activeProjectId);
    if (!proj) return;
    const modal = document.getElementById('rename-modal');
    const input = document.getElementById('rename-input');
    input.value = proj.name;
    modal.style.display = 'flex';
    setTimeout(() => { input.focus(); input.select(); }, 50);
    input.onkeydown = (e) => {
        if (e.key === 'Enter') confirmRename();
        if (e.key === 'Escape') closeRenameModal();
    };
}

function closeRenameModal() { document.getElementById('rename-modal').style.display = 'none'; }

function confirmRename() {
    const proj = allProjects.find(p => p.id == activeProjectId);
    const name = document.getElementById('rename-input').value.trim();
    if (!name) { showToast('Name cannot be empty', 'warning'); return; }
    if (proj) {
        proj.name = name;
        document.getElementById('active-project-name').innerText = sanitizeText(name);
        saveToDisk();
        renderProjects();
        // Broadcast updated nav so followers also get the new project name
        if (isHost) {
            sessionRef?.child('nav').set({ page: 'project', projectId: activeProjectId });
        }
        showToast(`Renamed to "${sanitizeText(name)}"`, 'success');
    }
    closeRenameModal();
}

function deleteProjectById(id) {
    askConfirm('Delete this project? Cannot be undone.', () => {
        allProjects = allProjects.filter(p => p.id != id);
        saveToDisk();
        renderProjects();
        showToast('Project deleted', 'warning');
    });
}

/* ===== TIMELINE CALCULATION ===== */
function calculateTimeline() {
    let total = 0;
    cueData.forEach((cue, i) => {
        cue.absStart = total;
        total += cue.time || 0;
        cue.globalIndex = i;
    });
}

/* ===== RENDER CUE LISTS ===== */
function renderStaticCues() {
    calculateTimeline();
    lastMasterIndex = -1; lastFilterIndex = -1;
    cueNodeCache.master = []; cueNodeCache.filter = [];

    const masterList = document.getElementById('master-cue-list');
    const filterList = document.getElementById('filter-cue-list');
    if (!masterList) return;

    if (!cueData.length) {
        masterList.innerHTML = `<div style="padding:40px;text-align:center;color:var(--muted);font-family:var(--font-mono);font-size:0.8rem;">
            belom ada cue. tekan ADD atau tandai langsung.<br><br>
            <span style="font-size:0.65rem;color:#333;">tips: 1–0 keyboard = mark cam 1–10</span>
        </div>`;
        if (filterList) filterList.innerHTML = '';
        return;
    }

    const template = document.getElementById('cue-template');
    masterList.innerHTML = '';
    if (filterList) filterList.innerHTML = '';

    cueData.forEach((cue, i) => {
        const masterNode = template.content.cloneNode(true).firstElementChild;
        setupCueNode(masterNode, cue, false);
        masterList.appendChild(masterNode);

        if (filterList && (currentFilterCam === 'all' || String(cue.cam) === String(currentFilterCam))) {
            const filterNode = template.content.cloneNode(true).firstElementChild;
            setupCueNode(filterNode, cue, true);
            filterList.appendChild(filterNode);
        }
    });
    applyVisibility();
}

function setupCueNode(root, cue, isFilter) {
    const cache = isFilter ? cueNodeCache.filter : cueNodeCache.master;
    cache[cue.globalIndex] = root;
    root.id = isFilter ? `filter-cue-${cue.globalIndex}` : `cue-${cue.globalIndex}`;
    root.dataset.index = cue.globalIndex;
    // draggable starts false — long-press mousedown handler enables it
    root.draggable = false;

    root._c = {
        index:    root.querySelector('.cue-index'),
        badge:    root.querySelector('.camera-badge'),
        text:     root.querySelector('.cue-text-val'),
        lyric:    root.querySelector('.lyric-text'),
        time:     root.querySelector('.time-tag'),
        bar:      root.querySelector('.bar-block'),
        progress: root.querySelector('.progress-overlay')
    };

    root._c.index.textContent   = cue.globalIndex + 1;
    root._c.badge.textContent   = cue.cam;
    root._c.badge.style.backgroundColor = cue.color;
    root._c.text.textContent    = cue.text || '';
    root._c.lyric.textContent   = cue.lyric || '';
    root._c.time.textContent    = `(${(cue.time||0).toFixed(1)}s)`;
    root._c.bar.style.backgroundColor = cue.color;
    root.style.setProperty('--abs-start', cue.absStart);
    root.style.setProperty('--duration', cue.time);

    root.onclick = () => selectCue(cue.globalIndex);

    // Touch drag (mobile)
    if (!isFilter) {
        root.addEventListener('touchstart', onTouchDragStart, { passive: true });
        root.addEventListener('touchmove',  onTouchDragMove,  { passive: false });
        root.addEventListener('touchend',   onTouchDragEnd,   { passive: true });
    }
}

/* ===== CUE SELECTION & EDITING ===== */
function selectCue(i) {
    if (!cueData[i]) return;
    selectedIndex = i;
    seekTo(cueData[i].absStart);
    cueNodeCache.master.forEach(n => n?.classList.remove('selected'));
    cueNodeCache.filter.forEach(n => n?.classList.remove('selected'));
    cueNodeCache.master[i]?.classList.add('selected');
    cueNodeCache.filter[i]?.classList.add('selected');
}

function openModal(mode) {
    if (userRole === 'client') return;
    const modal = document.getElementById('cueModal');
    modal.style.display = 'flex';
    if (mode === 'edit' && cueData[selectedIndex]) {
        const c = cueData[selectedIndex];
        document.getElementById('editIndex').value = selectedIndex;
        document.getElementById('newCam').value    = c.cam;
        document.getElementById('newColor').value  = c.color;
        document.getElementById('newTime').value   = c.time;
        document.getElementById('newText').value   = c.text;
        document.getElementById('newLyric').value  = c.lyric;
        document.getElementById('modalTitle').innerText = 'Edit Cue';
    } else {
        document.getElementById('editIndex').value = '-1';
        document.getElementById('newCam').value    = '';
        document.getElementById('newTime').value   = '5';
        document.getElementById('newText').value   = '';
        document.getElementById('newLyric').value  = '';
        document.getElementById('modalTitle').innerText = 'Add Cue';
    }
    updateColorPreview();
}

function closeModal() { document.getElementById('cueModal').style.display = 'none'; }

function saveCue() {
    const idx    = parseInt(document.getElementById('editIndex').value);
    const cam    = document.getElementById('newCam').value || 1;
    const color  = document.getElementById('newColor').value;
    const time   = parseFloat(document.getElementById('newTime').value) || 2;
    const text   = sanitizeText(document.getElementById('newText').value);
    const lyric  = sanitizeText(document.getElementById('newLyric').value);

    snapshotForUndo();

    const newCue = { cam, color, time, text, lyric };
    if (idx === -1) {
        cueData.splice(selectedIndex + 1, 0, newCue);
        selectedIndex = selectedIndex + 1;
    } else {
        cueData[idx] = newCue;
    }
    // Apply same color to all cues of same cam
    cueData.forEach(c => { if (String(c.cam) === String(cam)) c.color = color; });

    renderStaticCues();
    debouncedSave();
    closeModal();
    showToast('Cue saved', 'success');
}

function autoSuggestColor() {
    const cam = parseInt(document.getElementById('newCam').value) || 1;
    const existing = cueData.find(c => String(c.cam) === String(cam));
    document.getElementById('newColor').value = existing ? existing.color : PRESETS[(cam - 1) % PRESETS.length] || PRESETS[0];
    updateColorPreview();
}

function updateColorPreview() {
    const v = document.getElementById('newColor')?.value;
    const p = document.getElementById('colorPreview');
    if (p && v) p.style.backgroundColor = v;
}

function deleteCue() {
    if (!cueData.length) return;
    askConfirm('Delete selected cue?', () => {
        snapshotForUndo();
        cueData.splice(selectedIndex, 1);
        selectedIndex = Math.min(selectedIndex, Math.max(0, cueData.length - 1));
        renderStaticCues();
        debouncedSave();
        showToast('Cue deleted', 'warning');
    });
}

function clearAll() {
    askConfirm('DELETE ALL CUES in this project?', () => {
        snapshotForUndo();
        cueData = [];
        selectedIndex = 0; lastActiveIdx = -1;
        isRunning = false;
        const proj = allProjects.find(p => p.id == activeProjectId);
        if (proj) proj.cues = [];
        renderStaticCues();
        safeSetLocal(PROJECTS_KEY, JSON.stringify(allProjects));
        if (isHost) broadcastCues([]);
        showToast('All cues cleared', 'error');
    });
}

/* ===== LIVE MARK ===== */
function liveMark(camOverride) {
    if (userRole === 'client') return;
    calculateTimeline();
    let now = getCurrentTime();

    if (!cueData.length) {
        snapshotForUndo();
        const firstCam = camOverride || 1;
        cueData.push({ cam: firstCam, color: PRESETS[0], time: 5, text: 'START', lyric: '' });
        renderStaticCues(); debouncedSave(); return;
    }

    let idx = isRunning
        ? cueData.findIndex(c => now >= c.absStart && now < c.absStart + c.time)
        : selectedIndex;
    if (idx === -1) idx = cueData.length - 1;

    const currentCue = cueData[idx];
    snapshotForUndo();

    if (isRunning) currentCue.time = Math.max(0.2, now - currentCue.absStart);
    else { now = currentCue.absStart + currentCue.time; pausedAt = now; }

    const nextCam = camOverride || ((parseInt(currentCue.cam) % 10) + 1);
    cueData.splice(idx + 1, 0, {
        cam: nextCam,
        color: PRESETS[(nextCam - 1) % PRESETS.length] || '#fff',
        time: 5,
        text: isRunning ? 'LIVE CUT' : 'PLANNED',
        lyric: ''
    });
    selectedIndex = idx + 1;
    renderStaticCues(); debouncedSave();
}

/* ===== VISIBILITY / LAYOUT ===== */
function toggleVisibility(pane, type) {
    if (!visSettings[pane]) visSettings[pane] = {};
    visSettings[pane][type] = !visSettings[pane][type];
    safeSetLocal(VIS_FLAGS_KEY, JSON.stringify(visSettings));
    applyOneVis(pane, type);
}

function applyOneVis(pane, type) {
    const el  = document.getElementById(`${pane}-pane`);
    const btn = document.getElementById(`tog-${pane}-${type}`);
    const on  = visSettings[pane]?.[type] !== false;
    el?.classList.toggle(`hide-${type}`, !on);
    btn?.classList.toggle('active', on);
}

function applyVisibility() {
    ['master','filter'].forEach(pane =>
        ['time','inst','lyric'].forEach(type => applyOneVis(pane, type))
    );
}

function updateViewSettings() {
    const mode = document.getElementById('viewModeSelect')?.value || 'single';
    currentFilterCam = document.getElementById('camFilterSelect')?.value || 'all';
    const mc = document.getElementById('main-container');
    if (mc) mc.className = `main-content ${mode}-view`;
    if (mode === 'single') {
        const mp = document.getElementById('master-pane');
        if (mp) mp.style.height = '';
    }
    const label = currentFilterCam === 'all' ? 'All Cameras' : `Cam ${currentFilterCam}`;
    const fh = document.getElementById('filter-header');
    const mct = document.getElementById('mon-cd-title');
    if (fh)  fh.innerText  = `Monitor: ${label}`;
    if (mct) mct.innerText = currentFilterCam === 'all' ? 'NEXT CUE IN' : `CAM ${currentFilterCam} IN`;
    saveUISettings();
    renderStaticCues();
}

/* ===== PLAYBACK ENGINE ===== */
function getCurrentTime() {
    if (playerType === 'local') return document.getElementById('local-video')?.currentTime || 0;
    if (playerType === 'youtube' && ytPlayer?.getCurrentTime) return ytPlayer.getCurrentTime();
    return isRunning ? (performance.now() - startTime) / 1000 : pausedAt;
}

function togglePlayback(isRemote = false) {
    if (userRole === 'client' && !isRemote) return;
    const btn = document.getElementById('startBtn');

    if (!isRunning) {
        const vid = document.getElementById('local-video');
        if (playerType === 'local') vid?.play();
        else if (playerType === 'youtube' && ytPlayer) ytPlayer.playVideo();
        startTime = performance.now() - (pausedAt * 1000);
        isRunning = true;
        if (btn) { btn.innerText = '⏸ PAUSE'; btn.className = 'play-btn btn-pause'; }
        animationId = requestAnimationFrame(updateLoop);
    } else {
        const vid = document.getElementById('local-video');
        if (playerType === 'local') vid?.pause();
        else if (playerType === 'youtube' && ytPlayer) ytPlayer.pauseVideo();
        pausedAt = getCurrentTime();
        isRunning = false;
        if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
        if (btn) { btn.innerText = '▶ PLAY'; btn.className = 'play-btn btn-start'; }
    }

    if (isHost && !isRemote) {
        sessionRef?.child('playback').set({
            time: getCurrentTime(), isRunning, ts: Date.now()
        });
    }
}

function seekTo(seconds, isRemote = false) {
    if (userRole === 'client' && !isRemote) return;
    const vid = document.getElementById('local-video');
    if (playerType === 'local' && vid) vid.currentTime = seconds;
    else if (playerType === 'youtube' && ytPlayer) ytPlayer.seekTo(seconds, true);
    if (!isRunning) pausedAt = seconds;
    else startTime = performance.now() - (seconds * 1000);
    updatePlaybackUI(seconds);
    if (isHost && !isRemote) {
        sessionRef?.child('playback').set({ time: seconds, isRunning, ts: Date.now() });
    }
}

function updateLoop() {
    if (!document.getElementById('page-cues')?.classList.contains('active')) {
        if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
        return;
    }
    const now = getCurrentTime();
    updatePlaybackUI(now);
    const timer = document.getElementById('global-timer');
    if (timer) timer.innerText = formatTime(now);
    if (isRunning) animationId = requestAnimationFrame(updateLoop);
}

function updatePlaybackUI(now) {
    const scrollX = Math.round(now * PIXELS_PER_SECOND);
    document.getElementById('main-container')?.style.setProperty('--scroll-x', `${scrollX}px`);

    const idx = cueData.findIndex(c => now >= c.absStart && now < (c.absStart + c.time));

    if (idx !== lastActiveIdx) {
        cueNodeCache.master[lastActiveIdx]?.classList.remove('active-row');
        cueNodeCache.filter[lastActiveIdx]?.classList.remove('active-row');
        cueNodeCache.master[idx]?.classList.add('active-row');
        cueNodeCache.filter[idx]?.classList.add('active-row');
        lastActiveIdx = idx;
    }

    if (idx !== -1) {
        const cue = cueData[idx];
        const pct = Math.min(1, Math.max(0, (now - cue.absStart) / cue.time));
        const wp  = `${pct * 100}%`;
        if (cueNodeCache.master[idx]?._c) cueNodeCache.master[idx]._c.progress.style.width = wp;
        if (cueNodeCache.filter[idx]?._c) cueNodeCache.filter[idx]._c.progress.style.width = wp;
    }

    syncListScrolling(now);
    updateDashboard(now, idx);
    updateMonitorCountdown(now, idx);
}

function syncListScrolling(now) {
    const masterIdx = cueData.findIndex((c, i) => {
        const nxt = cueData[i + 1];
        return now >= c.absStart && (!nxt || now < nxt.absStart);
    });
    if (masterIdx !== -1 && masterIdx !== lastMasterIndex) {
        lastMasterIndex = masterIdx;
        cueNodeCache.master[masterIdx]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    const filterIdx = cueData.findIndex(c => {
        const vis = currentFilterCam === 'all' || String(c.cam) === String(currentFilterCam);
        return vis && now < (c.absStart + c.time);
    });
    if (filterIdx !== -1 && filterIdx !== lastFilterIndex) {
        lastFilterIndex = filterIdx;
        cueNodeCache.filter[filterIdx]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

function updateDashboard(now, idx) {
    const camEl  = document.getElementById('dash-curr-cam');
    const cdEl   = document.getElementById('dash-countdown');
    const nextEl = document.getElementById('dash-next-cam');
    if (!camEl) return;

    if (!cueData.length) {
        camEl.innerText = '--'; cdEl.innerText = '00:00.0'; nextEl.innerText = '--'; return;
    }
    const ci  = idx !== -1 ? idx : selectedIndex;
    const cue = cueData[ci] || cueData[0];
    const nxt = cueData[ci + 1];

    camEl.innerText = cue.cam;
    camEl.style.color = cue.color;
    const left = Math.max(0, (cue.absStart + cue.time) - now);
    cdEl.innerText = formatTime(left);
    cdEl.style.color = left < 2 ? 'var(--live)' : left < 5 ? 'var(--standby)' : 'var(--live)';
    nextEl.innerText = nxt ? String(nxt.cam) : 'END';
}

function updateMonitorCountdown(now, idx) {
    const el = document.getElementById('monitor-countdown');
    if (!el) return;
    if (!cueData.length) { el.innerText = 'NONE'; return; }
    if (idx === -1) idx = 0;
    const ti = cueData.findIndex((c, i) =>
        i >= idx && (currentFilterCam === 'all' || String(c.cam) === String(currentFilterCam))
    );
    if (ti !== -1) {
        const t = ti === idx
            ? (cueData[ti].absStart + cueData[ti].time) - now
            : cueData[ti].absStart - now;
        el.style.color = ti === idx ? 'var(--live)' : 'var(--safe)';
        el.innerText = formatTime(Math.max(0, t));
    } else { el.innerText = 'NONE'; el.style.color = 'var(--muted)'; }
}

/* ===== DRAG AND DROP — long-press to activate ===== */
/*
 * Strategy:
 * - Mouse: cue rows are NOT draggable by default. On mousedown we start a
 *   500ms long-press timer. If the pointer stays still long enough the row
 *   becomes draggable=true and a programmatic dragstart fires. Any movement
 *   or mouseup before the timer fires cancels it — so normal scrolling and
 *   tapping are never blocked.
 *
 * - Touch: same idea. touchstart begins a 500ms timer. Movement > 8px
 *   cancels the timer (user is scrolling). When the timer fires the row gets
 *   a visual "ready" pulse and we switch to manual touch-drag tracking.
 */

const LONG_PRESS_MS  = 500;   // hold time before drag activates
const MOVE_CANCEL_PX = 8;     // movement threshold that cancels a press

let draggedIndex  = -1;
let dragReady     = false;     // true while a long-press activated, before drop

// Mouse long-press state
let mouseLpTimer  = null;
let mouseLpRow    = null;
let mouseLpStart  = { x: 0, y: 0 };

// Touch long-press / drag state
let touchLpTimer  = null;
let touchLpRow    = null;
let touchLpStart  = { x: 0, y: 0 };

function setupDragAndDrop() {
    const masterList = document.getElementById('master-cue-list');
    if (!masterList) return;

    /* ---------- MOUSE ---------- */

    // mousedown — start long-press timer; row is NOT yet draggable
    masterList.addEventListener('mousedown', (e) => {
        if (userRole === 'client') return;
        const row = e.target.closest('.cue-line');
        if (!row) return;
        // Ensure draggable is off until long-press fires
        row.draggable = false;
        cancelMouseLp();
        mouseLpRow   = row;
        mouseLpStart = { x: e.clientX, y: e.clientY };

        mouseLpTimer = setTimeout(() => {
            if (!mouseLpRow) return;
            // Activate drag on this row
            mouseLpRow.draggable = true;
            mouseLpRow.classList.add('drag-ready');
            draggedIndex = parseInt(mouseLpRow.dataset.index);
            // Trigger the native drag via a synthetic dragstart; the browser
            // will call our dragstart listener below naturally once draggable=true
            // Just visual feedback — actual drag triggers on next mousemove
        }, LONG_PRESS_MS);
    });

    // Cancel long-press if mouse moves too much before timer fires
    masterList.addEventListener('mousemove', (e) => {
        if (!mouseLpRow || draggedIndex !== -1) return;
        const dx = Math.abs(e.clientX - mouseLpStart.x);
        const dy = Math.abs(e.clientY - mouseLpStart.y);
        if (dx > MOVE_CANCEL_PX || dy > MOVE_CANCEL_PX) cancelMouseLp();
    });

    window.addEventListener('mouseup', () => {
        cancelMouseLp();
    });

    // dragstart only fires now that draggable=true was set after long-press
    masterList.addEventListener('dragstart', (e) => {
        if (userRole === 'client') { e.preventDefault(); return; }
        const row = e.target.closest('.cue-line');
        if (!row || !row.classList.contains('drag-ready')) {
            e.preventDefault(); return;
        }
        draggedIndex = parseInt(row.dataset.index);
        dragReady    = true;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        // Set minimal drag image so the ghost doesn't obscure the list
        const ghost = document.createElement('div');
        ghost.style.cssText = `width:1px;height:1px;opacity:0;position:fixed;top:-9999px`;
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, 0, 0);
        setTimeout(() => ghost.remove(), 0);
    });

    masterList.addEventListener('dragover', (e) => {
        if (!dragReady) return;
        e.preventDefault();
        const row = e.target.closest('.cue-line');
        document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        if (row && parseInt(row.dataset.index) !== draggedIndex) row.classList.add('drag-over');
    });

    masterList.addEventListener('dragleave', (e) => {
        // Only clear if leaving the list entirely
        if (!masterList.contains(e.relatedTarget))
            document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    });

    masterList.addEventListener('drop', (e) => {
        e.preventDefault();
        if (!dragReady) return;
        const row = e.target.closest('.cue-line');
        document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        if (!row) return;
        const dropIdx = parseInt(row.dataset.index);
        if (draggedIndex !== -1 && dropIdx !== draggedIndex) {
            snapshotForUndo();
            const moved = cueData.splice(draggedIndex, 1)[0];
            cueData.splice(dropIdx, 0, moved);
            renderStaticCues(); debouncedSave();
        }
        resetMouseDrag();
    });

    masterList.addEventListener('dragend', () => {
        document.querySelectorAll('.dragging,.drag-over,.drag-ready')
            .forEach(el => el.classList.remove('dragging','drag-over','drag-ready'));
        resetMouseDrag();
    });
}

function cancelMouseLp() {
    clearTimeout(mouseLpTimer); mouseLpTimer = null;
    if (mouseLpRow) {
        mouseLpRow.draggable = false;
        mouseLpRow.classList.remove('drag-ready');
    }
    mouseLpRow = null;
}

function resetMouseDrag() {
    draggedIndex = -1; dragReady = false;
    document.querySelectorAll('[draggable="true"].cue-line').forEach(el => {
        el.draggable = false;
        el.classList.remove('drag-ready','dragging');
    });
}

/* ---------- TOUCH ----------
 * Assigned per cue-line in setupCueNode.
 * touchstart → start long-press timer (scroll is still free)
 * touchmove  → if timer not fired: let scroll happen normally
 *              if drag mode active: move the clone
 * touchend   → if drag mode active: drop; else just let tap/select fire
 */

function onTouchDragStart(e) {
    if (userRole === 'client') return;
    cancelTouchLp();
    const row    = e.currentTarget;
    const touch  = e.touches[0];
    touchLpRow   = row;
    touchLpStart = { x: touch.clientX, y: touch.clientY };

    touchLpTimer = setTimeout(() => {
        if (!touchLpRow) return;
        // Activate touch drag
        touchDragIndex = parseInt(touchLpRow.dataset.index);
        touchDragEl    = touchLpRow;

        // Haptic if available
        if (navigator.vibrate) navigator.vibrate(40);

        // Build floating clone
        const rect = touchLpRow.getBoundingClientRect();
        touchDragClone = touchLpRow.cloneNode(true);
        touchDragClone.style.cssText = `
            position:fixed; pointer-events:none; z-index:9999;
            opacity:0.85; width:${rect.width}px;
            left:${rect.left}px; top:${rect.top}px;
            box-shadow:0 8px 24px rgba(0,0,0,0.6);
            border:1px solid var(--accent); border-radius:4px;
            transition: transform 0.05s;
        `;
        document.body.appendChild(touchDragClone);
        touchLpRow.classList.add('dragging');
    }, LONG_PRESS_MS);
}

function onTouchDragMove(e) {
    const touch = e.touches[0];

    // If timer hasn't fired yet, check for scroll intent and cancel if moved
    if (touchLpTimer !== null) {
        const dx = Math.abs(touch.clientX - touchLpStart.x);
        const dy = Math.abs(touch.clientY - touchLpStart.y);
        if (dx > MOVE_CANCEL_PX || dy > MOVE_CANCEL_PX) cancelTouchLp();
        return; // allow native scroll — do NOT preventDefault here
    }

    // Drag mode is active
    if (touchDragIndex === -1 || !touchDragClone) return;
    e.preventDefault(); // now block scroll since we're dragging

    touchDragClone.style.top  = `${touch.clientY - 26}px`;
    touchDragClone.style.left = `${touch.clientX - 60}px`;

    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    // Temporarily hide clone so elementFromPoint can see through it
    touchDragClone.style.display = 'none';
    const elBelow = document.elementFromPoint(touch.clientX, touch.clientY);
    touchDragClone.style.display = '';
    elBelow?.closest('.cue-line')?.classList.add('drag-over');
}

function onTouchDragEnd(e) {
    cancelTouchLp(); // always kill the timer

    if (touchDragIndex === -1) return; // drag was never activated, normal tap

    touchDragClone?.remove(); touchDragClone = null;
    touchDragEl?.classList.remove('dragging');

    const touch    = e.changedTouches[0];
    // Hide clone before hit-testing
    const elBelow  = document.elementFromPoint(touch.clientX, touch.clientY);
    const row      = elBelow?.closest('.cue-line');

    if (row) {
        const dropIdx = parseInt(row.dataset.index);
        if (dropIdx !== touchDragIndex) {
            snapshotForUndo();
            const moved = cueData.splice(touchDragIndex, 1)[0];
            cueData.splice(dropIdx, 0, moved);
            renderStaticCues(); debouncedSave();
        }
    }

    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    touchDragIndex = -1; touchDragEl = null;
}

function cancelTouchLp() {
    clearTimeout(touchLpTimer); touchLpTimer = null;
    if (touchLpRow) touchLpRow.classList.remove('drag-ready');
    touchLpRow = null;
    // If drag was never activated, reset
    if (touchDragIndex === -1) { touchDragClone?.remove(); touchDragClone = null; }
}

/* ===== RESIZER ===== */
let isResizing = false; let resizeRafId = null;
document.addEventListener('DOMContentLoaded', () => {
    const resizer = document.getElementById('resizer');
    if (!resizer) return;
    resizer.addEventListener('mousedown', () => { isResizing = true; });
    resizer.addEventListener('touchstart', () => { isResizing = true; }, { passive: true });
    window.addEventListener('mousemove', (e) => { if (isResizing && !resizeRafId) {
        resizeRafId = requestAnimationFrame(() => { doResize(e.clientY); resizeRafId = null; }); }
    });
    window.addEventListener('touchmove', (e) => {
        if (isResizing && !resizeRafId) {
            resizeRafId = requestAnimationFrame(() => { doResize(e.touches[0].clientY); resizeRafId = null; });
        }
    }, { passive: true });
    window.addEventListener('mouseup',  () => { isResizing = false; });
    window.addEventListener('touchend', () => { isResizing = false; });
});

function doResize(clientY) {
    const mc = document.getElementById('main-container');
    const mp = document.getElementById('master-pane');
    if (!mc || !mp) return;
    const r   = mc.getBoundingClientRect();
    const min = r.height * 0.15, max = r.height * 0.85;
    const h   = Math.min(max, Math.max(min, clientY - r.top));
    mp.style.height = `${h}px`;
    mp.style.flex   = 'none';
}

/* ===== KEYBOARD SHORTCUTS ===== */
window.addEventListener('keydown', (e) => {
    const tag = document.activeElement.tagName;
    if (['INPUT','TEXTAREA','SELECT'].includes(tag)) return;
    if (!document.getElementById('page-cues')?.classList.contains('active')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlayback(); }
    if (e.key >= '1' && e.key <= '9') liveMark(parseInt(e.key));
    if (e.key === '0') liveMark(10);
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undoAction(); }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); redoAction(); }
});

/* ===== VIDEO HANDLING ===== */
function toggleVideoPane() {
    const container = document.getElementById('video-pane');
    if (!container.classList.contains('active')) {
        container.classList.add('active');
    } else {
        const t = getCurrentTime();
        if (playerType === 'local') document.getElementById('local-video')?.pause();
        else if (playerType === 'youtube' && ytPlayer) ytPlayer.pauseVideo();
        playerType = 'none'; pausedAt = t;
        if (isRunning) startTime = performance.now() - (t * 1000);
        container.classList.remove('active');
        destroyYTPlayer();
    }
}

function loadLocalVideo(e) {
    const file = e.target.files[0];
    if (!file) return;
    const vid = document.getElementById('local-video');
    if (vid.src?.startsWith('blob:')) URL.revokeObjectURL(vid.src);
    const t = getCurrentTime();
    if (ytPlayer?.pauseVideo) { ytPlayer.pauseVideo(); document.getElementById('yt-player').style.display = 'none'; }
    vid.src = URL.createObjectURL(file);
    vid.style.display = 'block';
    playerType = 'local';
    document.getElementById('video-pane').classList.add('active');
    vid.onloadedmetadata = () => { vid.currentTime = t; if (isRunning) vid.play(); };
    // Clean up blob URL on unload
    vid.onended = () => {};
}

function loadYouTubeVideo() {
    if (!ytApiReady) { showToast('YouTube API loading…', 'info'); return; }
    const vid = document.getElementById('local-video');
    if (vid?.src?.startsWith('blob:')) { URL.revokeObjectURL(vid.src); vid.src = ''; }
    const url   = document.getElementById('yt-url')?.value || '';
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:.*v=|.*\/))([\w-]{11})/);
    if (!match) { showToast('Invalid YouTube URL', 'info'); return; }
    const videoId = match[1];
    const t = getCurrentTime();
    document.getElementById('local-video').style.display  = 'none';
    document.getElementById('yt-player').style.display    = 'block';
    document.getElementById('video-pane').classList.add('active');
    if (ytPlayer?.loadVideoById) {
        playerType = 'youtube';
        ytPlayer.loadVideoById({ videoId, startSeconds: t });
        if (!isRunning) ytPlayer.pauseVideo();
    } else {
        ytPlayer = new YT.Player('yt-player', {
            height: '100%', width: '100%', videoId,
            playerVars: { start: Math.floor(t) },
            events: {
                onReady: (ev) => { playerType = 'youtube'; if (isRunning) ev.target.playVideo(); },
                onError: ()   => { showToast('YouTube error', 'error'); playerType = 'none'; }
            }
        });
    }
}

function destroyYTPlayer() {
    if (ytPlayer?.destroy) { ytPlayer.destroy(); ytPlayer = null; }
}

/* ===== FIREBASE / NETWORK ===== */
function setupFirebase() {
    // Calibrate clock offset against Firebase server time
    db.ref('/.info/serverTimeOffset').once('value', snap => {
        serverClockOffset = snap.val() || 0;
    });

    db.ref('/.info/connected').on('value', snap => {
        const badge = document.getElementById('offline-badge');
        if (badge) badge.style.display = snap.val() === true ? 'none' : 'block';
    });

    currentRoomId = localStorage.getItem(ROOM_KEY) || 'campers';
    const input = document.getElementById('inputRoomId');
    if (input) input.value = currentRoomId;
    sessionRef = db.ref(`kolsote/sessions/${currentRoomId}`);
    checkRoomStatus();
}

function handleRoomIdInput() {
    // Sanitize: allow only alphanumeric, hyphens, underscores
    const input = document.getElementById('inputRoomId');
    input.value = input.value.replace(/[^a-zA-Z0-9\-_]/g, '').toLowerCase();
    checkRoomStatus();
}

function checkRoomStatus() {
    // Clean up previous listener
    if (hostActiveListener && sessionRef) {
        sessionRef.child('isHostActive').off('value', hostActiveListener);
        hostActiveListener = null;
    }

    const input = document.getElementById('inputRoomId');
    const raw = (input?.value || '').trim().replace(/[^a-zA-Z0-9\-_]/g, '').toLowerCase();
    currentRoomId = raw || 'campers';
    localStorage.setItem(ROOM_KEY, currentRoomId);
    sessionRef = db.ref(`kolsote/sessions/${currentRoomId}`);

    hostActiveListener = (snap) => {
        globalHostActive = snap.val() === true;
        updateNetworkUI();
    };
    sessionRef.child('isHostActive').on('value', hostActiveListener);
}

function openNetworkModal() {
    const modal = document.getElementById('networkModal');
    if (!navigator.onLine) showToast('You appear offline', 'warning');
    modal.style.display = 'flex';
    const input = document.getElementById('inputRoomId');
    if (input) input.value = currentRoomId;

    if (userRole !== 'standalone') {
        document.getElementById('netSetupSection').style.display    = 'none';
        document.getElementById('netConnectedSection').style.display = 'block';
        document.getElementById('netSuccessMsg').innerText = isHost
            ? `Hosting Room: ${currentRoomId.toUpperCase()}`
            : `Joined Room: ${currentRoomId.toUpperCase()} as ${username}`;
        document.getElementById('hostFollowerList').style.display = isHost ? 'block' : 'none';
    } else {
        document.getElementById('netSetupSection').style.display    = 'block';
        document.getElementById('netConnectedSection').style.display = 'none';
        checkRoomStatus();
    }
}

function closeNetworkModal() { document.getElementById('networkModal').style.display = 'none'; }

function updateNetworkUI() {
    const statusEl = document.getElementById('netStatusMessage');
    const hostBtn  = document.getElementById('btnHostAction');
    const joinSec  = document.getElementById('joinSection');
    if (globalHostActive) {
        if (statusEl) statusEl.innerText = `Room "${currentRoomId}" is active. You can join.`;
        if (hostBtn)  hostBtn.style.display = 'none';
        if (joinSec)  joinSec.style.display = 'block';
    } else {
        if (statusEl) statusEl.innerText = `Room "${currentRoomId}" is vacant. You can host.`;
        if (hostBtn)  hostBtn.style.display = 'block';
        if (joinSec)  joinSec.style.display = 'none';
    }
}

function startHost() {
    sessionRef.onDisconnect().remove();
    sessionRef.child('isHostActive').set(true);

    isHost = true; userRole = 'host';

    // Broadcast full project list so followers get everything on join
    broadcastAllProjects();

    // Broadcast current nav state
    sessionRef.child('nav').set({ page: activeProjectId ? 'project' : 'list', projectId: activeProjectId });

    // If already inside a project, also broadcast its cues immediately
    if (activeProjectId !== null) {
        const proj = allProjects.find(p => p.id == activeProjectId);
        if (proj) sessionRef.child('activeCues').set(proj.cues);
    }

    sessionRef.child('followers').set(null);
    const flListener = sessionRef.child('followers').on('value', snap => {
        renderFollowerList(snap.val() || {});
    });
    followerListeners.push({ ref: sessionRef.child('followers'), listener: flListener, event: 'value' });

    updateNetworkStatus();
    document.getElementById('netSetupSection').style.display    = 'none';
    document.getElementById('netConnectedSection').style.display = 'block';
    document.getElementById('netSuccessMsg').innerText = `Hosting: ${currentRoomId.toUpperCase()}`;
    document.getElementById('hostFollowerList').style.display = 'block';
    setTimeout(closeNetworkModal, 1800);
}

function startJoin() {
    const nameInput = document.getElementById('inputUsername');
    const name = nameInput?.value.trim();
    if (!name) { showToast('Enter your username', 'info'); return; }

    username = name;
    safeSetLocal(USERNAME_KEY, username);
    isHost = false; userRole = 'client';

    myFollowerRef = sessionRef.child('followers').push();
    myFollowerRef.set({ name: username });
    myFollowerRef.onDisconnect().remove();

    // Register all listeners so they can be cleaned up
    const addListener = (path, event, handler) => {
        const ref = sessionRef.child(path);
        const l = ref.on(event, handler);
        followerListeners.push({ ref, listener: l, event });
    };

    // Sync full projects list from host — triggers on join and on every host change
    addListener('allProjects', 'value', snap => {
        // data is null when host has zero projects — treat as empty array
        const data = snap.val();
        const hostProjects = Array.isArray(data) ? data : [];
        const hostIds = new Set(hostProjects.map(p => String(p.id)));

        knownHostIds = knownHostIds || new Set();

        // Mark every project the host is currently broadcasting as known
        hostProjects.forEach(p => knownHostIds.add(String(p.id)));

        // Rebuild: keep local-only projects + fresh host projects
        const localOnly = allProjects.filter(p => !knownHostIds.has(String(p.id)));
        allProjects = [...localOnly, ...hostProjects];

        renderProjects();

        // If the follower is inside a project that the host just deleted, kick back to list
        if (activeProjectId !== null && !hostIds.has(String(activeProjectId))) {
            showToast('Host deleted this project', 'warning');
            showProjectsPage(true);
            return;
        }

        // If inside a surviving project, refresh its cues + title from updated data
        if (activeProjectId !== null) {
            const proj = allProjects.find(p => p.id == activeProjectId);
            if (proj) {
                cueData = proj.cues ? proj.cues.map(c => Object.assign({}, c)) : [];
                renderStaticCues();
                const titleEl = document.getElementById('active-project-name');
                if (titleEl) titleEl.innerText = sanitizeText(proj.name);
            }
        }

        // Fix race: if nav fired before allProjects arrived (stub "Loading…" state),
        // re-resolve the pending nav now that real project data is here.
        if (_pendingNavProjectId !== null) {
            const proj = allProjects.find(p => p.id == _pendingNavProjectId);
            if (proj) {
                activeProjectId = _pendingNavProjectId;
                _pendingNavProjectId = null;
                cueData = proj.cues ? proj.cues.map(c => Object.assign({}, c)) : [];
                document.getElementById('active-project-name').innerText = sanitizeText(proj.name);
                document.getElementById('page-projects').classList.remove('active');
                document.getElementById('page-cues').classList.add('active');
                renderStaticCues();
            }
        }
    });

    addListener('activeCues', 'value', snap => {
        const data = snap.val();
        if (!Array.isArray(data)) return;
        // Update cueData and also patch allProjects so list stays consistent
        cueData = data;
        if (activeProjectId !== null) {
            const idx = allProjects.findIndex(p => p.id == activeProjectId);
            if (idx !== -1) allProjects[idx].cues = data;
        }
        calculateTimeline();
        renderStaticCues();
    });

    addListener('nav', 'value', snap => {
        const nav = snap.val();
        if (!nav) return;
        if (nav.page === 'project' && nav.projectId) {
            // Look up from synced allProjects (should exist by now via allProjects listener)
            const proj = allProjects.find(p => p.id == nav.projectId);
            activeProjectId = nav.projectId;
            if (proj) {
                _pendingNavProjectId = null; // clear any stale pending nav
                cueData = proj.cues ? proj.cues.map(c => Object.assign({}, c)) : [];
                document.getElementById('active-project-name').innerText = sanitizeText(proj.name);
                document.getElementById('page-projects').classList.remove('active');
                document.getElementById('page-cues').classList.add('active');
                renderStaticCues();
            } else {
                // allProjects hasn't arrived yet — store nav and resolve once it does
                _pendingNavProjectId = nav.projectId;
                cueData = [];
                document.getElementById('active-project-name').innerText = 'Loading…';
                document.getElementById('page-projects').classList.remove('active');
                document.getElementById('page-cues').classList.add('active');
                renderStaticCues();
            }
        } else if (nav.page === 'list') {
            _pendingNavProjectId = null;
            showProjectsPage(true);
        }
    });

    addListener('playback', 'value', snap => {
        if (isHost) return;
        const pb = snap.val();
        if (!pb) return;

        // Clock offset compensation: adjust for network latency
        const ageMs = (Date.now() + serverClockOffset) - (pb.ts || 0);
        const compensated = pb.time + (pb.isRunning ? Math.min(ageMs / 1000, 2) : 0);

        if (pb.isRunning !== isRunning) togglePlayback(true);
        seekTo(Math.max(0, compensated), true);
    });

    addListener('isHostActive', 'value', snap => {
        if (snap.val() === null || snap.val() === false) {
            if (userRole === 'client') {
                showToast('Host ended the session', 'info');
                disconnectNetwork();
            }
        }
    });

    updateNetworkStatus();
    document.getElementById('netSetupSection').style.display    = 'none';
    document.getElementById('netConnectedSection').style.display = 'block';
    document.getElementById('netSuccessMsg').innerText = `Joined as ${username} · Room: ${currentRoomId.toUpperCase()}`;
    document.getElementById('hostFollowerList').style.display = 'none';
    setTimeout(closeNetworkModal, 1800);
}

function disconnectNetwork() {
    // Clean up ALL listeners before disconnecting
    followerListeners.forEach(({ ref, listener, event }) => {
        try { ref.off(event, listener); } catch {}
    });
    followerListeners = [];

    if (isHost) {
        try { sessionRef?.remove(); } catch {}
    } else if (userRole === 'client') {
        try { myFollowerRef?.remove(); } catch {}
    }

    isHost = false; userRole = 'standalone'; myFollowerRef = null;
    knownHostIds = new Set();
    _pendingNavProjectId = null;
    updateNetworkStatus();
    document.getElementById('netSetupSection').style.display    = 'block';
    document.getElementById('netConnectedSection').style.display = 'none';
    checkRoomStatus();
    setTimeout(closeNetworkModal, 800);
}

// Broadcast just the active project's cues (fast, for playback sync)
function broadcastCues(cues) {
    if (!isHost || !sessionRef) return;
    sessionRef.child('activeCues').set(cues);
}

// Broadcast full projects list (for project/cue add, edit, delete, rename)
function broadcastAllProjects() {
    if (!isHost || !sessionRef) return;
    // Write a clean copy without circular refs or DOM props
    const payload = allProjects.map(p => ({
        id:   p.id,
        name: p.name,
        cues: (p.cues || []).map(c => ({
            cam:   c.cam,
            color: c.color,
            time:  c.time,
            text:  c.text  || '',
            lyric: c.lyric || ''
        }))
    }));
    sessionRef.child('allProjects').set(payload);
    // Also update activeCues for the currently open project
    if (activeProjectId !== null) {
        const proj = allProjects.find(p => p.id == activeProjectId);
        if (proj) sessionRef.child('activeCues').set(proj.cues || []);
    }
}

function renderFollowerList(followersObj) {
    const container = document.getElementById('modal-follower-list');
    if (!container) return;
    const keys = Object.keys(followersObj);
    if (!keys.length) {
        container.innerHTML = '<span style="color:var(--muted);font-size:0.75rem;">No followers yet</span>';
    } else {
        container.innerHTML = keys.map(k =>
            `<div class="follower-entry">⬤ ${sanitizeText(followersObj[k]?.name || 'Unknown')}</div>`
        ).join('');
    }
    // Update follower pills in header
    const count = keys.length;
    const pillText = count ? `${count} follower${count > 1 ? 's' : ''}` : '';
    ['follower-pill','follower-pill-cues'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.display = count ? 'block' : 'none';
        el.textContent = pillText.toUpperCase();
    });
}

function updateNetworkStatus() {
    const isConnected = userRole !== 'standalone';
    // Net dots
    ['net-dot-proj','net-dot-cues'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.className = 'net-dot' + (isHost ? ' host-dot' : isConnected ? ' live' : '');
    });
    // Net labels
    const label = isHost
        ? `HOST: ${currentRoomId.toUpperCase()}`
        : isConnected
            ? `JOINED: ${currentRoomId.toUpperCase()}`
            : 'OFFLINE';
    document.querySelectorAll('#net-label-proj, #net-label-cues').forEach(el => { el.innerText = label; });

    // Status badge
    const badge = document.getElementById('status-badge');
    if (badge) {
        badge.style.display = isConnected ? 'block' : 'none';
        badge.className = isHost ? 'badge-host' : 'badge-client';
        badge.innerText = isHost ? `HOST: ${currentRoomId.toUpperCase()}` : `FOLLOWER: ${currentRoomId.toUpperCase()}`;
    }

    // Follower mode body class
    document.body.classList.toggle('follower-mode', userRole === 'client');
}

/* ===== IMPORT / EXPORT ===== */
function parseImportedRows(jsonData) {
    return jsonData.map(row => {
        const dur = parseFloat(row.Duration);
        const cam = parseInt(row.Camera, 10);
        return {
            cam:   Number.isFinite(cam) && cam >= 0 ? cam : 1,
            color: typeof row.Color === 'string' && row.Color.startsWith('#') ? row.Color : '#7c4dff',
            time:  Number.isFinite(dur) && dur >= 0 ? dur : 5,
            text:  String(row.Instruction || '').substring(0, 200),
            lyric: String(row.Lyrics || '').substring(0, 500)
        };
    });
}

function checkImportDuplicate(name) {
    return allProjects.find(p =>
        p.name.toLowerCase() === name.toLowerCase() && p.cues.length > 0
    );
}

function exportToExcel() {
    if (typeof XLSX === 'undefined') { showToast('Excel library not loaded', 'warning'); return; }
    if (!allProjects.length) { showToast('No projects to export', 'warning'); return; }
    const wb = XLSX.utils.book_new();
    allProjects.forEach(proj => {
        const rows = proj.cues.map(({ cam, color, time, text, lyric }) =>
            ({ Camera: cam, Color: color, Duration: time, Instruction: text, Lyrics: lyric })
        );
        const ws = XLSX.utils.json_to_sheet(rows);
        const safeName = proj.name.replace(/[\\\/\?\*\[\]\:]/g,'').substring(0,31) || 'kolsote';
        XLSX.utils.book_append_sheet(wb, ws, safeName);
    });
    XLSX.writeFile(wb, `kolsote_backup_${new Date().toISOString().split('T')[0]}.xlsx`);
    showToast('Exported!', 'success');
}

function importFromExcel(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
            wb.SheetNames.forEach(name => {
                const cues = parseImportedRows(XLSX.utils.sheet_to_json(wb.Sheets[name]));
                if (cues.length && !checkImportDuplicate(name)) {
                    allProjects.push({ id: generateId(), name: name || `Imported ${Date.now()}`, cues });
                }
            });
            saveToDisk(); renderProjects(); showToast('Import successful!', 'success');
        } catch (err) { console.error(err); showToast('Failed to parse file', 'error'); }
    };
    reader.readAsArrayBuffer(file);
    event.target.value = '';
}

async function importFromGoogleSheet() {
    const urlInput = document.getElementById('gsheet-url');
    const btn      = document.getElementById('gsheet-import-btn');
    const url = urlInput?.value.trim();
    if (!url) { showToast('Paste a Google Sheet URL first', 'warning'); return; }
    const match = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (!match) { showToast('Invalid Google Sheet URL', 'error'); return; }

    if (btn) { btn.innerText = 'LOADING…'; btn.disabled = true; }
    try {
        const res = await fetch(`https://docs.google.com/spreadsheets/d/${match[1]}/export?format=xlsx`);
        if (!res.ok) throw new Error('Fetch failed — is the sheet public?');
        const wb = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: 'array' });
        wb.SheetNames.forEach(name => {
            const cues = parseImportedRows(XLSX.utils.sheet_to_json(wb.Sheets[name]));
            if (cues.length && !checkImportDuplicate(name)) {
                allProjects.push({ id: generateId(), name: name || 'Imported Link', cues });
            }
        });
        saveToDisk(); renderProjects();
        if (urlInput) urlInput.value = '';
        showToast('Google Sheet imported!', 'success');
    } catch (err) {
        console.error(err);
        showToast('Import failed. Check sheet is public.', 'error');
    } finally {
        if (btn) { btn.innerText = 'LOAD'; btn.disabled = false; }
    }
}

/* ===== CONFIRM MODAL ===== */
let _confirmCb = null;
function askConfirm(msg, cb) {
    document.getElementById('confirm-message').innerText = msg;
    _confirmCb = cb;
    document.getElementById('confirm-modal').style.display = 'flex';
    document.getElementById('confirm-action-btn').onclick = () => { _confirmCb?.(); closeConfirmModal(); };
}
function closeConfirmModal() {
    document.getElementById('confirm-modal').style.display = 'none';
    _confirmCb = null;
}

function clearAppCache() {
    askConfirm('Permanently delete ALL projects and settings? Cannot be undone.', () => {
        APP_KEYS.forEach(k => localStorage.removeItem(k));
        showToast('Cache cleared. Reloading…', 'error');
        setTimeout(() => location.reload(), 1000);
    });
}

/* ===== TOAST NOTIFICATIONS ===== */
function showToast(msg, type = 'info', duration = 3000) {
    const c = document.getElementById('toast-container');
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerHTML = `<span>${sanitizeText(msg)}</span>`;
    c.appendChild(t);
    setTimeout(() => {
        t.classList.add('fade-out');
        t.addEventListener('animationend', () => t.remove(), { once: true });
    }, duration);
}

/* ===== HIT COUNTER ===== */
async function triggerHitCounter() {
    const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbypSvShfM6qBhRHc0nWW7kF85wUgK--SXIlRmv4VICu3Cmb32YC4VjXtdgpoLzIe4QBtQ/exec';
    const el = document.getElementById('global-hit-count');
    try {
        const res  = await fetch(SCRIPT_URL);
        const data = await res.json();
        if (el && data?.count) el.innerText = String(data.count).padStart(3, '0');
    } catch { if (el) el.innerText = '---'; }
}

/* ===== PWA ===== */
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(r => console.log('SW scope:', r.scope))
            .catch(e => console.warn('SW registration failed:', e));
    });
}
