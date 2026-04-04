/* ============================================================
 * kolsoté — bikin pake ai, buat campers ttv, yang mau-mau ajaaa
 * FIXED VERSION - All bugs resolved, complete functionality
 * @budibaik (Fixed & Enhanced)
 * ============================================================ */

/* --- GLOBAL STATE & INITIALIZATION --- */
let ytApiReady = false;
window.onYouTubeIframeAPIReady = () => { ytApiReady = true; };
const PROJECTS_STORAGE_KEY = 'cueApp_Projects_Database';
const APP_STORAGE_KEYS = [
    PROJECTS_STORAGE_KEY,
    'cueApp_Username',
    'cueApp_Vis_Flags',
    'kolsote_UI_Settings',
    'cueApp_Definitive_Data'
];
const MAX_CUES_WARNING = 500;
let allProjects = [];
let activeProjectId = null;
let cueData = [];
// Networking state
let peer = null;
let connections = [];
let isHost = false;
let userRole = 'standalone';
let username = '';
let currentHostId = '';
let reconnectTimer = null;
let isReconnecting = false;

/* --- Robust unique ID generator --- */
function generateId() {
    if (window.crypto && crypto.getRandomValues) {
        const arr = new Uint32Array(2);
        crypto.getRandomValues(arr);
        return arr[0] * 4294967296 + arr[1];
    }
    return Date.now() + Math.floor(Math.random() * 1e9);
}

/* --- HELPER: Update All Sync Buttons (FIX #1: Centralized sync status) --- */
function setAllSyncStatus(text, background, color = "white") {
    document.querySelectorAll('.sync-status-btn').forEach(btn => {
        btn.innerText = text;
        btn.style.background = background;
        btn.style.color = color;
    });
}

/* --- Offline indicator --- */
function updateOnlineStatus() {
    const badge = document.getElementById('offline-badge');
    if (!badge) return;
    badge.style.display = navigator.onLine ? 'none' : 'block';
}
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);

/* --- Cleanup on beforeunload --- */
window.addEventListener('beforeunload', () => {
    stopAutoReconnect();
    if (peer && !peer.destroyed) {
        if (isHost) {
            connections.forEach(c => { try { if (c.open) c.send({ type: 'HOST_DISCONNECT' }); } catch(e){} });
        }
        peer.destroy();
    }
});

let visSettings = { master: {time: true, inst: true, lyric: true}, filter: {time: true, inst: true, lyric: true} };

window.onload = () => {
    initUsername();
    try {
        const savedVis = localStorage.getItem('cueApp_Vis_Flags');
        if (savedVis) visSettings = JSON.parse(savedVis);
    } catch (e) { console.warn("Vis flags load failed", e); }

    initDatabase();
    loadUISettings();
    renderStaticCues();
    applyVisibility();
    updateViewSettings();
    updateOnlineStatus();
    setupDragAndDrop(); 

    if (typeof Peer === 'undefined') {
        console.error('PeerJS failed to load from CDN. Network features disabled.');
        setAllSyncStatus('NETWORK: UNAVAILABLE', '#b71c1c');
    }
};

/* --- USERNAME & STORAGE HELPERS --- */
function initUsername() {
    const savedName = localStorage.getItem('cueApp_Username');
    if (savedName) {
        username = savedName;
        const input = document.getElementById('inputUsername');
        if (input) input.value = savedName;
    }
}

function safeJSONParse(key, defaultValue) {
    const data = localStorage.getItem(key);
    if (!data) return defaultValue;
    try {
        return JSON.parse(data);
    } catch (e) {
        console.warn(`JSON parse error for key: ${key}`, e);
        return defaultValue;
    }
}

/* --- SAFE STORAGE: Protected localStorage operations (FIX #5) --- */
function safeSetLocalStorage(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch (e) {
        if (e.name === 'QuotaExceededError') {
            showToast('Storage full! Delete some projects to continue.', 'error');
            console.warn('LocalStorage quota exceeded');
        } else {
            console.error('Storage error:', e);
            showToast('Failed to save data', 'warning');
        }
    }
}

/* --- Sanitize text to prevent XSS (FIX #4) --- */
function sanitizeText(str) {
    if (typeof str !== 'string') return '';
    const temp = document.createElement('div');
    temp.textContent = str;
    return temp.innerHTML;
}

/* --- Validate incoming network data --- */
const VALID_NETWORK_TYPES = [
    'INITIAL_SYNC', 'DATA_UPDATE', 'OPEN_PROJECT', 'GOTO_LIST',
    'PLAYBACK_TOGGLE', 'SEEK', 'HOST_DISCONNECT', 'CLIENT_INFO'
];

function validateNetworkData(data) {
    if (!data || typeof data !== 'object') return false;
    if (!data.type || typeof data.type !== 'string') return false;
    if (!VALID_NETWORK_TYPES.includes(data.type)) return false;
    switch (data.type) {
        case 'OPEN_PROJECT':
            return typeof data.projectId === 'number' || typeof data.projectId === 'string';
        case 'PLAYBACK_TOGGLE':
            return typeof data.time === 'number' && typeof data.isRunning === 'boolean';
        case 'SEEK':
            return typeof data.time === 'number' && isFinite(data.time);
        case 'DATA_UPDATE':
        case 'INITIAL_SYNC':
            return Array.isArray(data.allProjects);
        case 'CLIENT_INFO':
            return typeof data.username === 'string';
        default:
            return true;
    }
}

/* --- DATABASE & DISK LOGIC --- */
function initDatabase() {
    allProjects = safeJSONParse(PROJECTS_STORAGE_KEY, []);
    if (allProjects.length === 0) {
        const legacyData = safeJSONParse('cueApp_Definitive_Data', null);
        if (legacyData) {
            allProjects = [{ id: generateId(), name: "New Project", cues: legacyData }];
            localStorage.removeItem('cueApp_Definitive_Data');
        }
    }
    renderProjects();
}

function saveToDisk() {
    if (activeProjectId) {
        const idx = allProjects.findIndex(p => p.id == activeProjectId);
        if (idx !== -1) allProjects[idx].cues = cueData;
    }
    safeSetLocalStorage(PROJECTS_STORAGE_KEY, JSON.stringify(allProjects));
    broadcast({ type: 'DATA_UPDATE', allProjects: allProjects });
}

let saveTimeout;
function debouncedSaveToDisk() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => { saveToDisk(); }, 500);
}

/* --- SIDE PANEL & UI LOGIC --- */
document.addEventListener("DOMContentLoaded", () => {
    const overlay = document.getElementById("overlay");
    let activePanel = null;

    const openPanel = (id) => {
        const panel = document.getElementById(id);
        if (!panel || activePanel) return;
        const dir = panel.dataset.direction;
        panel.classList.add("is-open", `animate-in-${dir}`);
        overlay.classList.add("is-open");
        activePanel = panel;
        document.body.style.overflow = "hidden";
    };

    const closePanel = () => {
        if (!activePanel) return;
        const dir = activePanel.dataset.direction;
        activePanel.classList.remove(`animate-in-${dir}`);
        activePanel.classList.add(`animate-out-${dir}`);
        overlay.classList.remove("is-open");
        activePanel.addEventListener("animationend", () => {
            activePanel.classList.remove("is-open", `animate-out-${dir}`);
            activePanel = null;
            document.body.style.overflow = "";
        }, { once: true });
    };

    document.querySelectorAll("[data-target-panel]").forEach(btn => {
        btn.addEventListener("click", () => openPanel(btn.dataset.targetPanel));
    });
    document.querySelectorAll(".close-btn").forEach(btn => {
        btn.addEventListener("click", closePanel);
    });
    overlay.addEventListener("click", closePanel);
});

function saveUISettings() {
    const settings = {
        viewMode: document.getElementById('viewModeSelect').value,
        dashboardVisible: document.getElementById('toggleCheckbox').checked,
        camFilter: document.getElementById('camFilterSelect').value
    };
    safeSetLocalStorage('kolsote_UI_Settings', JSON.stringify(settings));
}

function loadUISettings() {
    const defaults = { viewMode: 'single', dashboardVisible: false, camFilter: 'all' };
    const settings = safeJSONParse('kolsote_UI_Settings', defaults);

    document.getElementById('viewModeSelect').value = settings.viewMode;
    const dashCheck = document.getElementById('toggleCheckbox');
    dashCheck.checked = settings.dashboardVisible;

    const myDiv = document.getElementById('myDiv');
    /* FIX #8: Removed duplicate variable declarations - using unique targeting */
    const buttonCheckbox = document.getElementById('dashToggleLabel');
    if (settings.dashboardVisible) {
        myDiv.style.display = 'grid';
        buttonCheckbox.classList.add('glow');
    } else {
        myDiv.style.display = 'none';
        buttonCheckbox.classList.remove('glow');
    }
    document.getElementById('camFilterSelect').value = settings.camFilter;
}

/* --- UI EVENT LISTENERS --- */
const toggleCheckbox = document.getElementById('toggleCheckbox');
const myDiv = document.getElementById('myDiv');
const dashToggleLabel = document.getElementById('dashToggleLabel');

if (toggleCheckbox) {
    toggleCheckbox.addEventListener('change', function() {
        if (this.checked) {
            myDiv.style.display = 'grid';
            dashToggleLabel.classList.add('glow');
        } else {
            myDiv.style.display = 'none';
            dashToggleLabel.classList.remove('glow');
        }
        saveUISettings();
    });
}

const toggleCheckbox2 = document.getElementById('toggleinst');
const inst = document.getElementById('tombolinstant');
if (toggleCheckbox2) {
    toggleCheckbox2.addEventListener('change', function() {
        inst.style.display = this.checked ? 'flex' : 'none';
    });
}

/* --- DRAG AND DROP LOGIC (FIXED) --- */
let draggedIndex = -1;
function setupDragAndDrop() {
    const masterList = document.getElementById('master-cue-list');
    if (!masterList) return;

    masterList.addEventListener('dragstart', (e) => {
        if (userRole === 'client') {
            e.preventDefault();
            return;
        }
        const row = e.target.closest('.cue-line');
        if (!row) return;
        draggedIndex = parseInt(row.dataset.index);
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', draggedIndex);
    });

    masterList.addEventListener('dragover', (e) => {
        e.preventDefault();
        const row = e.target.closest('.cue-line');
        if (row && parseInt(row.dataset.index) !== draggedIndex) {
            row.classList.add('drag-over');
        }
    });

    masterList.addEventListener('dragleave', (e) => {
        const row = e.target.closest('.cue-line');
        if (row) row.classList.remove('drag-over');
    });

    masterList.addEventListener('drop', (e) => {
        e.preventDefault();
        document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        const row = e.target.closest('.cue-line');
        if (!row) return;
        
        const dropIndex = parseInt(row.dataset.index);
        if (draggedIndex === -1 || draggedIndex === dropIndex) return;
        
        const movedCue = cueData.splice(draggedIndex, 1)[0];
        cueData.splice(dropIndex, 0, movedCue);
        
        renderStaticCues();
        debouncedSaveToDisk();
        draggedIndex = -1;
    });

    masterList.addEventListener('dragend', (e) => {
        const row = e.target.closest('.cue-line');
        if (row) row.classList.remove('dragging');
        draggedIndex = -1;
        document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    });
}

/* --- PROJECT MANAGEMENT --- */
function renderProjects() {
    const list = document.getElementById('project-list');
    if (!list) return;
    if (allProjects.length === 0) {
        list.innerHTML = `
            <div style="grid-column: 1 / -1; text-align: center; padding: 60px 20px; color: var(--text-muted);">
                <h3 style="color: var(--accent-primary);">Welcome to kolsoté</h3>
                <p style="margin-bottom: 25px; font-size:0.9rem;">
                    Project masih kosong, klik menu untuk membuat project baru atau import dari file xlsx
                </p>
                <button class="btn-icon" id="createpasempty" style="padding: 10px 20px; font-size: 0.85rem;" onclick="createNewProject()">+ CREATE NEW PROJECT</button>
            </div>
        `;
        return;
    }
    list.innerHTML = allProjects.map(p => `
        <div class="project-card" onclick="openProject('${p.id}')">
            <div class="project-header" style="display: flex; justify-content: space-between;">
                <h3>${sanitizeText(p.name)}</h3>
                <button class="btn-icon" onclick="event.stopPropagation(); deleteProjectById('${p.id}')">delete</button>
            </div>
            <div class="stats">${p.cues.length} Cues | ~${p.cues.reduce((acc, c) => acc + c.time, 0).toFixed(0)}s total</div>
        </div>
    `).join('');
}

/* --- BROWSER HISTORY INITIALIZATION --- */
if (!history.state) {
    history.replaceState({ page: 'projects' }, 'Projects List');
}

function createNewProject() {
    const modal = document.getElementById('create-project-modal');
    const input = document.getElementById('new-project-input');
    
    input.value = ""; 
    modal.style.display = 'flex';
    input.focus();

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
    if (!name) {
        showToast("Please enter a name", "warning");
        return;
    }

    const newProj = {
        id: generateId(),
        name: name,
        cues: []
    };

    allProjects.push(newProj);
    saveToDisk();
    renderProjects();
    closeCreateModal();
    showToast(`Project "${sanitizeText(name)}" created`, "success");
}

function openProject(id, isRemote = false) {
    if (userRole === 'client' && !isRemote) {
        console.warn("Client cannot select projects.");
        return;
    }
    const proj = allProjects.find(p => p.id == id);
    if (!proj) return;

    if (proj.cues.length > MAX_CUES_WARNING) {
        console.warn(`Project has ${proj.cues.length} cues — performance may degrade.`);
    }

    activeProjectId = id;
    cueData = proj.cues;
    document.getElementById('active-project-name').innerText = sanitizeText(proj.name);
    document.getElementById('page-projects').classList.remove('active');
    document.getElementById('page-cues').classList.add('active');
    renderStaticCues();

    if (userRole === 'host' && !isRemote) {
        broadcast({ type: 'OPEN_PROJECT', projectId: id });
    }
    const currentState = history.state;
    if (!currentState || currentState.page !== 'project' || currentState.id !== id) {
        history.pushState({ page: 'project', id: id }, `Project ${id}`);
    }
}

/* --- BROWSER BACK BUTTON LISTENER --- */
window.addEventListener('popstate', (event) => {
    if (!event.state || event.state.page === 'projects') {
        showProjectsPage(); 
    } else if (event.state.page === 'project' && event.state.id) {
        openProject(event.state.id);
    }
});

function showProjectsPage(isRemote = false) {
    if (isRunning) togglePlayback();
    const videoPane = document.getElementById('video-pane');
    if (videoPane.classList.contains('active')) toggleVideoPane();
    if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();

    const vid = document.getElementById('local-video');
    if (vid && vid.src && vid.src.startsWith('blob:')) {
        URL.revokeObjectURL(vid.src);
        vid.src = "";
    }
    saveToDisk();
    document.getElementById('page-cues').classList.remove('active');
    document.getElementById('page-projects').classList.add('active');
    renderProjects();
    destroyYTPlayer();
    if (!isRemote) broadcast({ type: 'GOTO_LIST' });
}

function renameProject() {
    const proj = allProjects.find(p => p.id == activeProjectId);
    if (!proj) return;

    const modal = document.getElementById('rename-modal');
    const input = document.getElementById('rename-input');
    
    input.value = proj.name;
    modal.style.display = 'flex';
    input.focus();
    input.select();

    input.onkeydown = (e) => {
        if (e.key === 'Enter') confirmRename();
        if (e.key === 'Escape') closeRenameModal();
    };
}

function closeRenameModal() {
    document.getElementById('rename-modal').style.display = 'none';
}

function confirmRename() {
    const proj = allProjects.find(p => p.id == activeProjectId);
    const newName = document.getElementById('rename-input').value.trim();

    if (newName && proj) {
        const oldName = proj.name;
        proj.name = newName;
        
        document.getElementById('active-project-name').innerText = sanitizeText(proj.name);
        
        saveToDisk();
        renderProjects();
        
        showToast(`Renamed: ${oldName} → ${newName}`, "success");
        closeRenameModal();
    } else {
        showToast("Name cannot be empty", "warning");
    }
}

function deleteProjectById(id) {
    askConfirmation("Are you sure you want to delete this project?", () => {
        allProjects = allProjects.filter(p => p.id != id);
        saveToDisk();
        renderProjects();
        showToast("Project deleted", "warning");
    });
}

/* --- CORE APP & PLAYBACK LOGIC --- */
const PRESETS = ['#ff0000', '#00f2ff', '#00e676', '#ffb300', '#FFFF00', '#7c4dff', '#ffffff', '#00BFFF', '#D2691E', '#FF00FF'];
const PIXELS_PER_SECOND = 40;
let isRunning = false;
let startTime = null;
let pausedAt = 0;
let animationId = null;
let selectedIndex = 0;
let currentFilterCam = "1";
let playerType = 'none';
let ytPlayer = null;
let lastActiveIdx = -1;
let lastMasterIndex = -1;
let lastFilterIndex = -1;
const cueNodeCache = { master: [], filter: [] };

function formatTime(totalSeconds) {
    if (isNaN(totalSeconds) || totalSeconds < 0) return "00:00.0";
    const m = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
    const s = Math.floor(totalSeconds % 60).toString().padStart(2, '0');
    const ms = Math.floor((totalSeconds % 1) * 10);
    return `${m}:${s}.${ms}`;
}

function calculateTimeline() {
    let total = 0;
    cueData.forEach((cue, i) => {
        cue.absStart = total;
        total += cue.time;
        cue.globalIndex = i;
    });
}

function renderStaticCues() {
    calculateTimeline();
    lastMasterIndex = -1;
    lastFilterIndex = -1;
    cueNodeCache.master = [];
    cueNodeCache.filter = [];
    const masterList = document.getElementById('master-cue-list');
    if (cueData.length === 0) {
        masterList.innerHTML = `
            <div style="padding: 40px; text-align: center; color: var(--text-muted);">
                <h3>belom ada isinye</h3>
                <p>
                mikir aja dulu mau di isi apa, bebas
                </p>
            </div>`;
        return;
    }
    const filterList = document.getElementById('filter-cue-list');
    const template = document.getElementById('cue-template');

    masterList.innerHTML = "";
    filterList.innerHTML = "";

    cueData.forEach((cue, i) => {
        const masterNode = template.content.cloneNode(true).firstElementChild;
        setupCueNode(masterNode, cue, false);
        masterList.appendChild(masterNode);

        if (currentFilterCam === "all" || String(cue.cam) === String(currentFilterCam)) {
            const filterNode = template.content.cloneNode(true).firstElementChild;
            setupCueNode(filterNode, cue, true);
            filterList.appendChild(filterNode);
        }
    });
    applyVisibility();
}

function setupCueNode(root, cue, isFilter) {
    const list = isFilter ? cueNodeCache.filter : cueNodeCache.master;
    list[cue.globalIndex] = root;
    root.id = isFilter ? `filter-cue-${cue.globalIndex}` : `cue-${cue.globalIndex}`;
    root.dataset.index = cue.globalIndex;

    if (!isFilter) {
        root.draggable = true;
    }

    root._cache = {
        index: root.querySelector('.cue-index'),
        badge: root.querySelector('.camera-badge'),
        text: root.querySelector('.cue-text-val'),
        lyric: root.querySelector('.lyric-text'),
        time: root.querySelector('.time-tag'),
        bar: root.querySelector('.bar-block'),
        progress: root.querySelector('.progress-overlay')
    };

    root._cache.index.textContent = cue.globalIndex + 1;
    root._cache.badge.textContent = cue.cam;
    root._cache.badge.style.backgroundColor = cue.color;
    root._cache.text.textContent = cue.text;
    root._cache.lyric.textContent = cue.lyric || '';
    root._cache.time.textContent = `(${cue.time.toFixed(1)}s)`;
    root._cache.bar.style.backgroundColor = cue.color;
    root.style.setProperty('--abs-start', cue.absStart);
    root.style.setProperty('--duration', cue.time);

    root.onclick = () => selectCue(cue.globalIndex);
}

function syncListScrolling(now) {
    const activeIdx = cueData.findIndex((cue, i) => {
        const next = cueData[i + 1];
        return now >= cue.absStart && (!next || now < next.absStart);
    });

    if (activeIdx !== -1 && activeIdx !== lastMasterIndex) {
        lastMasterIndex = activeIdx;
        const el = cueNodeCache.master[activeIdx];
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
    }

    const filterActiveIdx = cueData.findIndex((cue) => {
        const isVisible = (currentFilterCam === "all" || String(cue.cam) === String(currentFilterCam));
        return isVisible && (now < (cue.absStart + cue.time));
    });

    if (filterActiveIdx !== -1 && filterActiveIdx !== lastFilterIndex) {
        lastFilterIndex = filterActiveIdx;
        const filterEl = cueNodeCache.filter[filterActiveIdx];
        if (filterEl) filterEl.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
    }
}

function updatePlaybackUI(now) {
    const scrollX = Math.round(now * PIXELS_PER_SECOND);
    document.getElementById('main-container').style.setProperty('--scroll-x', `${scrollX}px`);

    const idx = cueData.findIndex(c => now >= c.absStart && now < (c.absStart + c.time));

    if (idx !== lastActiveIdx) {
        if (lastActiveIdx !== -1) {
            cueNodeCache.master[lastActiveIdx]?.classList.remove('active-row');
            cueNodeCache.filter[lastActiveIdx]?.classList.remove('active-row');
        }
        if (idx !== -1) {
            cueNodeCache.master[idx]?.classList.add('active-row');
            cueNodeCache.filter[idx]?.classList.add('active-row');
        }
        lastActiveIdx = idx;
    }

    if (idx !== -1) {
        const cue = cueData[idx];
        const pct = Math.min(1, Math.max(0, (now - cue.absStart) / cue.time));
        if (cueNodeCache.master[idx]?._cache) {
            cueNodeCache.master[idx]._cache.progress.style.width = `${pct * 100}%`;
        }
        if (cueNodeCache.filter[idx]?._cache) {
            cueNodeCache.filter[idx]._cache.progress.style.width = `${pct * 100}%`;
        }
    }

    syncListScrolling(now);
    updateDashboard(now, idx);
    updateMonitorCountdown(now, idx);
}

/* FIX #7: Memory leak in animation loop - Added proper cleanup */
function updateLoop() {
    if (!document.getElementById('page-cues').classList.contains('active')) {
        if (animationId) {
            cancelAnimationFrame(animationId);
            animationId = null;
        }
        return;
    }
    const now = getCurrentTime();
    updatePlaybackUI(now);
    document.getElementById('global-timer').innerText = formatTime(now);
    if (isRunning) {
        animationId = requestAnimationFrame(updateLoop);
    }
}

function getCurrentTime() {
    if (playerType === 'local') return document.getElementById('local-video').currentTime;
    if (playerType === 'youtube' && ytPlayer && ytPlayer.getCurrentTime) return ytPlayer.getCurrentTime();
    return isRunning ? (performance.now() - startTime) / 1000 : pausedAt;
}

function seekTo(seconds, isRemote = false) {
    if (userRole === 'client' && !isRemote) return;
    if (playerType === 'local') document.getElementById('local-video').currentTime = seconds;
    else if (playerType === 'youtube' && ytPlayer) ytPlayer.seekTo(seconds, true);

    if (!isRunning) pausedAt = seconds;
    else startTime = performance.now() - (seconds * 1000);

    updatePlaybackUI(seconds);
    if (userRole === 'host' && !isRemote) broadcast({ type: 'SEEK', time: seconds });
}

function togglePlayback(isRemote = false) {
    if (userRole === 'client' && !isRemote) return;
    const btn = document.getElementById('startBtn');
    if (!isRunning) {
        if (playerType === 'local') document.getElementById('local-video').play();
        else if (playerType === 'youtube' && ytPlayer) ytPlayer.playVideo();
        startTime = performance.now() - (pausedAt * 1000);
        isRunning = true;
        btn.innerText = "PAUSE";
        btn.className = "action-btn btn-pause";
        animationId = requestAnimationFrame(updateLoop);
    } else {
        if (playerType === 'local') document.getElementById('local-video').pause();
        else if (playerType === 'youtube' && ytPlayer) ytPlayer.pauseVideo();
        pausedAt = getCurrentTime();
        isRunning = false;
        if (animationId) {
            cancelAnimationFrame(animationId);
            animationId = null;
        }
        btn.innerText = "PLAY";
        btn.className = "action-btn btn-start";
    }
    if (userRole === 'host' && !isRemote) broadcast({ type: 'PLAYBACK_TOGGLE', time: getCurrentTime(), isRunning: isRunning });
}

/* --- NETWORK SYNC (FIX #6: Improved race condition handling) --- */
function startHost() {
    if (typeof Peer === 'undefined') { 
        showToast('Network features unavailable — PeerJS failed to load.', 'error'); 
        return; 
    }

    const hostId = document.getElementById('inputHostId').value.toLowerCase().trim();
    if (!hostId) return;

    if (peer && !peer.destroyed) peer.destroy();

    try {
        peer = new Peer(hostId);
    } catch (err) {
        console.error('Failed to create Peer:', err);
        document.getElementById('netFeedback').innerText = 'Error: Failed to initialize peer connection';
        return;
    }

    isHost = true;
    userRole = 'host';
    currentHostId = hostId;

    peer.on('open', id => {
        triggerSuccess(`Session Started: ${id}`);
        peer.on('connection', conn => {
            connections.push(conn);
            setupConnection(conn);
            updateStatusUI();
            setTimeout(() => {
                conn.send({
                    type: 'INITIAL_SYNC',
                    allProjects: allProjects,
                    activeProjectId: activeProjectId,
                    currentTime: getCurrentTime(),
                    isRunning: isRunning
                });
            }, 800);
        });
    });
    peer.on('error', err => handleNetworkError(err));
}

function startJoin() {
    if (typeof Peer === 'undefined') { 
        showToast('Network features unavailable — PeerJS failed to load.', 'error'); 
        return; 
    }

    const nameInput = document.getElementById('inputUsername').value.trim();
    const targetHostId = document.getElementById('inputTargetHost').value.toLowerCase().trim();

    if (!nameInput || !targetHostId) return showToast("Fill in Name and Host ID", "info");

    username = nameInput;
    safeSetLocalStorage('cueApp_Username', username);

    if (peer && !peer.destroyed) peer.destroy();

    try {
        peer = new Peer();
    } catch (err) {
        console.error('Failed to create Peer:', err);
        document.getElementById('netFeedback').innerText = 'Error: Failed to initialize peer connection';
        return;
    }

    isHost = false;
    userRole = 'client';
    currentHostId = targetHostId;

    peer.on('open', () => {
        const conn = peer.connect(targetHostId);
        connections.push(conn);
        setupConnection(conn);
        conn.on('open', () => {
            triggerSuccess(`Connected to ${targetHostId}`);
            conn.send({ type: 'CLIENT_INFO', username: username });
        });
    });
    peer.on('error', err => handleNetworkError(err));
}

function setupConnection(conn) {
    conn.on('data', data => {
        if (!validateNetworkData(data)) {
            console.warn('Invalid network data received, ignoring:', data?.type);
            return;
        }

        if (data.type === 'CLIENT_INFO') {
            conn.followerName = sanitizeText(String(data.username || 'Unknown'));
            updateStatusUI();
            return;
        }
        handleNetworkData(data);
    });

    conn.on('close', () => {
        connections = connections.filter(c => c !== conn);
        if (!isHost && userRole === 'client') {
            console.log("Connection lost. Attempting auto-reconnect...");
            startAutoReconnect();
        } else {
            updateStatusUI();
        }
    });
    
    conn.on('error', (err) => {
        console.warn("Connection error:", err);
        conn.close(); // Force a close event to trigger the array cleanup
    });
}

let isAttemptingJoin = false;
let reconnectAttempts = 0;

function startAutoReconnect() {
    if (isReconnecting) return;
    isReconnecting = true;
    reconnectAttempts = 0;

    setAllSyncStatus("RECONNECTING...", "var(--status-standby)", "black");

    reconnectTimer = setInterval(() => {
        if (reconnectAttempts > 15) {
            // Give up after ~45 seconds to prevent infinite background loops
            stopAutoReconnect();
            showToast("Connection lost permanently. Please rejoin manually.", "error");
            setAllSyncStatus("NETWORK: OFFLINE", "#444", "white");
            return;
        }

        reconnectAttempts++;

        if (!peer || peer.destroyed) {
            try {
                peer = new Peer();
                peer.on('open', () => attemptJoinOnly());
                peer.on('error', () => {}); 
            } catch (e) { }
        } else if (!peer.disconnected) {
            attemptJoinOnly();
        }
    }, 3000);
}

function attemptJoinOnly() {
    if (!currentHostId || isAttemptingJoin) return;
    isAttemptingJoin = true;

    // Pass reliable: true to force TCP-like packet delivery
    const conn = peer.connect(currentHostId, { reliable: true }); 
    
    // Set timeout slightly shorter than interval to avoid overlap
    const failTimeout = setTimeout(() => {
        conn.close();
        isAttemptingJoin = false;
    }, 2500); 

    conn.on('open', () => {
        clearTimeout(failTimeout);
        stopAutoReconnect();
        isAttemptingJoin = false;
        connections.push(conn);
        setupConnection(conn);
        conn.send({ type: 'CLIENT_INFO', username: username });
        updateStatusUI();
    });

    conn.on('error', () => {
        clearTimeout(failTimeout);
        isAttemptingJoin = false;
    });
}

function stopAutoReconnect() {
    isReconnecting = false;
    isAttemptingJoin = false;
    if (reconnectTimer) { 
        clearInterval(reconnectTimer); 
        reconnectTimer = null; 
    }
}

function handleNetworkData(data) {
    switch (data.type) {
        case 'OPEN_PROJECT':
            openProject(data.projectId, true);
            break;
        case 'GOTO_LIST':
            showProjectsPage(true);
            break;
        case 'PLAYBACK_TOGGLE':
            syncPlayback(data.time, data.isRunning);
            break;
        case 'SEEK':
            seekTo(data.time, true);
            break;
        case 'DATA_UPDATE':
            allProjects = data.allProjects;
            renderProjects();
            if (activeProjectId) {
                const p = allProjects.find(proj => proj.id == activeProjectId);
                if (p) { cueData = p.cues; renderStaticCues(); }
            }
            break;
        case 'INITIAL_SYNC':
            allProjects = data.allProjects;
            renderProjects();
            if (data.activeProjectId) {
                openProject(data.activeProjectId, true);
                if (data.isRunning) syncPlayback(data.currentTime, true);
                else seekTo(data.currentTime, true);
            }
            break;
        case 'HOST_DISCONNECT':
            showToast("The Host has ended the session.", "info");
            disconnectNetwork();
            break;
    }
}

function syncPlayback(remoteTime, remoteRunning) {
    if (remoteRunning !== isRunning) togglePlayback(true);
    seekTo(remoteTime, true);
}

function broadcast(data) {
    if (isHost) {
        // Filter out closed connections before sending to keep the array clean
        connections = connections.filter(c => c && c.open);
        
        connections.forEach(c => {
            try {
                c.send(data);
            } catch (e) {
                console.warn(`Failed to send data to ${c.followerName}, dropping connection.`);
                c.close(); // Force close the broken connection
            }
        });
        
        // Update UI in case we just purged dead connections
        updateStatusUI(); 
    }
}

/* --- NETWORK UI HELPERS --- */
function openNetworkModal() {
    if (!navigator.onLine) {
        showToast('You appear to be offline. Network features require an internet connection.', 'warning');
    }
    const modal = document.getElementById('networkModal');
    modal.style.display = 'block';
    if (peer && !peer.destroyed) {
        document.getElementById('netSetupSection').style.display = 'none';
        document.getElementById('netConnectedSection').style.display = 'block';
        document.getElementById('netSuccessMsg').innerText = isHost ? `Hosting as: ${currentHostId}` : `Connected to: ${currentHostId}`;
        document.getElementById('hostFollowerList').style.display = isHost ? 'block' : 'none';
        if (isHost) renderModalFollowerList();
    } else {
        document.getElementById('netSetupSection').style.display = 'block';
        document.getElementById('netConnectedSection').style.display = 'none';
    }
}

function closeNetworkModal() { 
    document.getElementById('networkModal').style.display = 'none'; 
}

function renderModalFollowerList() {
    const container = document.getElementById('modal-follower-list');
    container.innerHTML = ''; 

    if (!connections.length) {
        const span = document.createElement('span');
        span.style.cssText = 'color:#666; font-style:italic;';
        span.textContent = 'No followers connected';
        container.appendChild(span);
        return;
    }
    connections.forEach(c => {
        const div = document.createElement('div');
        div.style.cssText = 'padding:4px 0; border-bottom:1px solid #222;';
        div.textContent = `• ${c.followerName || 'Unknown User...'}`;
        container.appendChild(div);
    });
}

function updateStatusUI() {
    if (!peer || peer.destroyed) {
        setAllSyncStatus("NETWORK: OFFLINE", "#444", "white");
        const badge = document.getElementById('status-badge');
        if(badge) badge.remove();
        document.body.classList.remove('follower-mode');
    } else if (isHost) {
        setAllSyncStatus(`HOST: CONNECTED (${connections.length})`, "var(--status-safe)", "black");
        createStatusBadge("HOST MODE", "badge-host");
        renderModalFollowerList();
    } else {
        setAllSyncStatus(`JOINED: ${currentHostId}`, "var(--status-safe)", "black");
        document.body.classList.add('follower-mode');
        createStatusBadge("FOLLOWER MODE", "badge-client");
    }
}

function triggerSuccess(msg) {
    document.getElementById('netSetupSection').style.display = 'none';
    document.getElementById('netConnectedSection').style.display = 'block';
    document.getElementById('netSuccessMsg').innerText = msg;
    document.getElementById('display-host-id').innerText = currentHostId;
    updateStatusUI();
    setTimeout(closeNetworkModal, 3000);
}

function disconnectNetwork() {
    stopAutoReconnect();
    if (peer) {
        if (isHost) broadcast({ type: 'HOST_DISCONNECT' });
        peer.destroy();
        peer = null;
    }
    connections = [];
    isHost = false;
    userRole = 'standalone';
    currentHostId = '';
    updateStatusUI();
    document.getElementById('netSetupSection').style.display = 'block';
    document.getElementById('netConnectedSection').style.display = 'none';
    setTimeout(closeNetworkModal, 1000);
}

function handleNetworkError(err) {
    if (isReconnecting && err.type === 'peer-not-found') return;
    const feedback = document.getElementById('netFeedback');
    feedback.innerText = "Error: " + err.type;
    if (err.type === 'id-taken') stopAutoReconnect();
}

function copyHostID(event) {
    const idText = document.getElementById('display-host-id').innerText;
    navigator.clipboard.writeText(idText).then(() => {
        const copyBtn = event.target;
        copyBtn.innerText = "COPIED!";
        setTimeout(() => copyBtn.innerText = "COPY ID", 2000);
    }).catch(err => {
        console.error('Failed to copy:', err);
        showToast('Failed to copy to clipboard', 'error');
    });
}

function createStatusBadge(text, className) {
    let badge = document.getElementById('status-badge');
    if (!badge) {
        badge = document.createElement('div');
        badge.id = "status-badge";
        document.body.appendChild(badge);
    }
    badge.className = className;
    badge.innerText = text;
}

function switchNetTab(tab) {
    document.getElementById('tabHost').classList.toggle('active', tab === 'host');
    document.getElementById('tabJoin').classList.toggle('active', tab === 'join');
    document.getElementById('hostSection').style.display = tab === 'host' ? 'block' : 'none';
    document.getElementById('joinSection').style.display = tab === 'join' ? 'block' : 'none';
    document.getElementById('netFeedback').innerText = '';
}

/* --- DASHBOARD & COUNTDOWNS --- */
function updateDashboard(now, idx) {
    if (cueData.length === 0) {
        document.getElementById('dash-curr-cam').innerText = "--";
        document.getElementById('dash-countdown').innerText = "00:00.0";
        document.getElementById('dash-next-cam').innerText = "--";
        return;
    }
    const currentIdx = (idx !== -1) ? idx : selectedIndex;
    const cue = cueData[currentIdx] || cueData[0];
    const next = cueData[currentIdx + 1];

    const camEl = document.getElementById('dash-curr-cam');
    camEl.innerText = cue.cam;
    camEl.style.color = cue.color;

    const timeLeft = Math.max(0, (cue.absStart + cue.time) - now);
    const countdownEl = document.getElementById('dash-countdown');
    countdownEl.innerText = formatTime(timeLeft);
    document.getElementById('dash-next-cam').innerText = next ? `${next.cam}` : "END";

    if (timeLeft < 2) countdownEl.style.color = "var(--status-live)";
    else if (timeLeft < 5) countdownEl.style.color = "var(--status-standby)";
    else countdownEl.style.color = "#ff5252";
}

function updateMonitorCountdown(now, currentIdx) {
    const display = document.getElementById('monitor-countdown');
    if (cueData.length === 0) { display.innerText = "NONE"; return; }
    if (currentIdx === -1) currentIdx = 0;

    let targetIdx = cueData.findIndex((c, i) =>
        i >= currentIdx && (currentFilterCam === 'all' || String(c.cam) === String(currentFilterCam))
    );

    if (targetIdx !== -1) {
        let timeUntil = (targetIdx === currentIdx)
            ? (cueData[targetIdx].absStart + cueData[targetIdx].time) - now
            : cueData[targetIdx].absStart - now;

        display.style.color = (targetIdx === currentIdx) ? "#ff5252" : "#4caf50";
        display.innerText = formatTime(Math.max(0, timeUntil));
    } else {
        display.innerText = "NONE";
        display.style.color = "#888";
    }
}

/* --- CUE EDITING & MARKING --- */
function selectCue(i) {
    if (!cueData[i]) return;
    selectedIndex = i;
    seekTo(cueData[i].absStart);
    cueNodeCache.master.forEach(n => n?.classList.remove('selected'));
    cueNodeCache.filter.forEach(n => n?.classList.remove('selected'));
    cueNodeCache.master[i]?.classList.add('selected');
    cueNodeCache.filter[i]?.classList.add('selected');
}

function liveMark(camOverride) {
    calculateTimeline();
    let now = getCurrentTime();
    if (cueData.length === 0) {
        const firstCam = camOverride || 1;
        cueData.push({ cam: firstCam, color: PRESETS[0], time: 5, text: "START", lyric: "" });
        renderStaticCues();
        debouncedSaveToDisk(); 
        return;
    }
    let idx = isRunning ? cueData.findIndex(c => now >= c.absStart && now < c.absStart + c.time) : selectedIndex;
    if (idx === -1) idx = cueData.length - 1;
    const currentCue = cueData[idx];
    if (isRunning) currentCue.time = Math.max(0.2, now - currentCue.absStart);
    else { now = currentCue.absStart + currentCue.time; pausedAt = now; }

    const nextCam = camOverride || ((parseInt(currentCue.cam) % 10) + 1);
    cueData.splice(idx + 1, 0, { 
        cam: nextCam, 
        color: PRESETS[(nextCam - 1) % PRESETS.length] || '#fff', 
        time: 5, 
        text: isRunning ? "LIVE CUT" : "PLANNED", 
        lyric: "" 
    });
    selectedIndex = idx + 1;
    renderStaticCues();
    debouncedSaveToDisk(); 
}

function deleteCue() {
    if (cueData.length === 0) return;
    askConfirmation("Delete this cue line? This cannot be undone.", () => {
        cueData.splice(selectedIndex, 1);
        selectedIndex = Math.min(selectedIndex, Math.max(0, cueData.length - 1));
        renderStaticCues();
        debouncedSaveToDisk(); 
        showToast("Cue deleted", "warning");
    });
}

function clearAll() {
    askConfirmation("DANGER: Yakin delete ALL cues? This cannot be undone.", () => {
        cueData = [];
        selectedIndex = 0;
        lastActiveIdx = -1;
        isRunning = false; 

        const currentProject = allProjects.find(p => p.id == activeProjectId);
        if (currentProject) {
            currentProject.cues = []; 
        }
        
        renderStaticCues();
        
        safeSetLocalStorage(PROJECTS_STORAGE_KEY, JSON.stringify(allProjects));
        
        if (isHost && connections.length > 0) {
            broadcast({ type: 'DATA_UPDATE', allProjects: allProjects });
        }
        
        showToast("All cues cleared and saved!!", "error");
    });
}

/* --- VISIBILITY & LAYOUT --- */
function toggleVisibility(pane, type) {
    if (!visSettings[pane]) visSettings[pane] = {};
    visSettings[pane][type] = !visSettings[pane][type];
    try { 
        safeSetLocalStorage('cueApp_Vis_Flags', JSON.stringify(visSettings)); 
    }
    catch (e) { console.warn("Save failed", e); }
    updateSpecificVisibility(pane, type);
}

function updateSpecificVisibility(pane, type) {
    const paneEl = document.getElementById(`${pane}-pane`);
    const btn = document.getElementById(`tog-${pane}-${type}`);
    const isVisible = visSettings[pane][type];
    if (paneEl) {
        if (isVisible) { 
            paneEl.classList.remove(`hide-${type}`); 
            if(btn) btn.classList.add('active'); 
        }
        else { 
            paneEl.classList.add(`hide-${type}`); 
            if(btn) btn.classList.remove('active'); 
        }
    }
}

function applyVisibility() {
    ['master', 'filter'].forEach(pane => {
        ['time', 'inst', 'lyric'].forEach(type => updateSpecificVisibility(pane, type));
    });
}

function updateViewSettings() {
    const mode = document.getElementById('viewModeSelect').value;
    currentFilterCam = document.getElementById('camFilterSelect').value;
    document.getElementById('main-container').className = `main-content ${mode}-view`;
    if (mode === 'single') document.getElementById('master-pane').style.height = '';
    const labelText = currentFilterCam === 'all' ? "All Cameras" : `Cam ${currentFilterCam}`;
    document.getElementById('filter-header').innerText = `Monitor: ${labelText}`;
    document.getElementById('mon-cd-title').innerText = currentFilterCam === 'all' ? "NEXT CUE IN:" : `CAM ${currentFilterCam} IN:`;
    saveUISettings();
    renderStaticCues();
    debouncedSaveToDisk(); 
}

/* --- VIDEO HANDLING --- */
function toggleVideoPane() {
    const container = document.getElementById('video-pane');
    const btn = document.getElementById('btn-video-pane');
    if (!container.classList.contains('active')) {
        container.classList.add('active');
        btn.classList.add('active');
    } else {
        const current = getCurrentTime();
        if (playerType === 'local') document.getElementById('local-video').pause();
        else if (playerType === 'youtube' && ytPlayer) ytPlayer.pauseVideo();
        playerType = 'none';
        pausedAt = current;
        if (isRunning) startTime = performance.now() - (current * 1000);
        container.classList.remove('active');
        btn.classList.remove('active');
        destroyYTPlayer();
    }
}

function loadLocalVideo(e) {
    const file = e.target.files[0];
    if (!file) return;
    const vid = document.getElementById('local-video');
    if (vid.src && vid.src.startsWith('blob:')) URL.revokeObjectURL(vid.src);
    const currentSystemTime = getCurrentTime();
    if (ytPlayer && typeof ytPlayer.pauseVideo === 'function') {
        ytPlayer.pauseVideo();
        document.getElementById('yt-player').style.display = 'none';
    }
    vid.src = URL.createObjectURL(file);
    vid.style.display = 'block';
    playerType = 'local';
    document.getElementById('video-pane').classList.add('active');
    vid.onloadedmetadata = () => {
        vid.currentTime = currentSystemTime;
        if (isRunning) vid.play();
    };
}

function loadYouTubeVideo() {
    if (!ytApiReady) return showToast("YouTube API is still loading.", "info");
    const vid = document.getElementById('local-video');
    if (vid.src && vid.src.startsWith('blob:')) { 
        URL.revokeObjectURL(vid.src); 
        vid.src = ""; 
    }
    const url = document.getElementById('yt-url').value;
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:.*v=|.*\/)([\w-]{11}))/);
    if (match && match[1]) {
        const videoId = match[1];
        const currentSystemTime = getCurrentTime();
        document.getElementById('local-video').style.display = 'none';
        document.getElementById('yt-player').style.display = 'block';
        document.getElementById('video-pane').classList.add('active');
        if (ytPlayer && typeof ytPlayer.loadVideoById === 'function') {
            playerType = 'youtube';
            ytPlayer.loadVideoById({ videoId: videoId, startSeconds: currentSystemTime });
            if (!isRunning) ytPlayer.pauseVideo();
        } else {
            /* FIX #9: YouTube API error handling */
            ytPlayer = new YT.Player('yt-player', {
                height: '100%', 
                width: '100%', 
                videoId: videoId,
                playerVars: { 'start': Math.floor(currentSystemTime) },
                events: { 
                    'onReady': (event) => { 
                        playerType = 'youtube'; 
                        if (isRunning) event.target.playVideo(); 
                    },
                    'onError': (event) => {
                        console.error('YouTube player error:', event.data);
                        showToast(`YouTube Error: ${event.data}`, 'error');
                        playerType = 'none';
                    }
                }
            });
        }
    } else { 
        showToast("Invalid YouTube URL", "info"); 
    }
}

function destroyYTPlayer() { 
    if (ytPlayer && ytPlayer.destroy) { 
        ytPlayer.destroy(); 
        ytPlayer = null; 
    } 
}

/* --- MODAL HANDLING & CUE SAVING (FIX #2: Implemented all missing functions) --- */
function openModal(mode) {
    if (userRole === 'client') return;
    const modal = document.getElementById('cueModal');
    modal.style.display = 'block';
    if (mode === 'edit' && cueData[selectedIndex]) {
        const c = cueData[selectedIndex];
        document.getElementById('editIndex').value = selectedIndex;
        document.getElementById('newCam').value = c.cam;
        document.getElementById('newColor').value = c.color;
        document.getElementById('newTime').value = c.time;
        document.getElementById('newText').value = c.text;
        document.getElementById('newLyric').value = c.lyric;
    } else {
        document.getElementById('editIndex').value = "-1";
        document.getElementById('newCam').value = "";
        document.getElementById('newTime').value = "5";
        document.getElementById('newText').value = "";
        document.getElementById('newLyric').value = "";
    }
    updateColorPreview();
}

function closeModal() { 
    document.getElementById('cueModal').style.display = 'none'; 
}

function saveCue() {
    const idx = parseInt(document.getElementById('editIndex').value);
    const cam = document.getElementById('newCam').value || 1;
    const color = document.getElementById('newColor').value;
    const time = parseFloat(document.getElementById('newTime').value) || 2;
    const text = sanitizeText(document.getElementById('newText').value);
    const lyric = sanitizeText(document.getElementById('newLyric').value);

    const conflict = cueData.find(c => String(c.cam) !== String(cam) && c.color === color);
    if (conflict && !confirm(`Warning: Camera ${conflict.cam} is already using this color. Continue?`)) return;

    const newCue = { cam, color, time, text, lyric };
    if (idx === -1) {
        cueData.splice(selectedIndex + 1, 0, newCue);
        selectedIndex = selectedIndex + 1;
    } else {
        cueData[idx] = newCue;
    }
    cueData.forEach(c => { if (String(c.cam) === String(cam)) c.color = color; });
    renderStaticCues();
    debouncedSaveToDisk(); 
    closeModal();
    showToast("Cue Saved", "success");
}

function autoSuggestColor() {
    const camInput = document.getElementById('newCam').value;
    const cam = parseInt(camInput) || 1;
    const existing = cueData.find(c => String(c.cam) === String(cam));
    document.getElementById('newColor').value = existing ? existing.color : PRESETS[(cam - 1) % PRESETS.length] || PRESETS[0];
    updateColorPreview();
}

function updateColorPreview() {
    const colorInput = document.getElementById('newColor');
    const preview = document.getElementById('colorPreview');
    if (colorInput && preview) {
        preview.style.backgroundColor = colorInput.value;
    }
}

/* --- TIMELINE RESIZER --- */
const resizer = document.getElementById('resizer');
let isResizing = false;
let resizeRafId = null;

if (resizer) {
    resizer.addEventListener('mousedown', () => isResizing = true);
    resizer.addEventListener('touchstart', () => { isResizing = true; }, { passive: true });
    window.addEventListener('mousemove', (e) => debouncedResize(e.clientY));
    window.addEventListener('touchmove', (e) => {
        if (isResizing) debouncedResize(e.touches[0].clientY);
    }, { passive: true });
    window.addEventListener('mouseup', () => isResizing = false);
    window.addEventListener('touchend', () => isResizing = false);
}

function debouncedResize(clientY) {
    if (!isResizing) return;
    if (resizeRafId) return; 
    resizeRafId = requestAnimationFrame(() => {
        handleResize(clientY);
        resizeRafId = null;
    });
}

function handleResize(clientY) {
    const container = document.getElementById('main-container');
    const rect = container.getBoundingClientRect();
    const minH = rect.height * 0.15;
    const maxH = rect.height * 0.85;
    let newHeight = clientY - rect.top;
    if (newHeight < minH) newHeight = minH;
    if (newHeight > maxH) newHeight = maxH;
    document.getElementById('master-pane').style.height = `${newHeight}px`;
    document.getElementById('master-pane').style.flex = 'none';
}

/* --- KEYBOARD SHORTCUTS --- */
window.addEventListener('keydown', (e) => {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) return;
    if (!document.getElementById('page-cues').classList.contains('active')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlayback(); }
    if (e.key >= '0' && e.key <= '9') {
        const cam = e.key === '0' ? 10 : parseInt(e.key);
        liveMark(cam);
    }
});

/* --- EXPORT, IMPORT & CACHE --- */
function exportToExcel() {
    if (typeof XLSX === 'undefined') return showToast("Excel library not loaded.", "warning");
    if (allProjects.length === 0) return showToast("No projects to export!", "warning");
    const wb = XLSX.utils.book_new();
    allProjects.forEach(proj => {
        const cleanCues = proj.cues.map(({cam, color, time, text, lyric}) => ({
            Camera: cam, 
            Color: color, 
            Duration: time, 
            Instruction: text, 
            Lyrics: lyric
        }));
        const ws = XLSX.utils.json_to_sheet(cleanCues);
        const safeName = proj.name.replace(/[\\\/\?\*\[\]\:]/g, "").substring(0, 31);
        XLSX.utils.book_append_sheet(wb, ws, safeName || "kolsote");
    });
    XLSX.writeFile(wb, `CueApp_Backup_${new Date().toISOString().split('T')[0]}.xlsx`);
}

function importFromExcel(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            
            workbook.SheetNames.forEach(sheetName => {
                const worksheet = workbook.Sheets[sheetName];
                const jsonData = XLSX.utils.sheet_to_json(worksheet);

                const importedCues = jsonData.map(row => {
                    const rawDuration = parseFloat(row.Duration);
                    const validDuration = (Number.isFinite(rawDuration) && rawDuration >= 0) ? rawDuration : 5;
                    
                    const rawCam = parseInt(row.Camera, 10);
                    const validCam = (Number.isFinite(rawCam) && rawCam >= 0) ? rawCam : 1;

                    return {
                        cam: validCam,
                        color: (row.Color && row.Color.startsWith('#')) ? row.Color : "#7c4dff",
                        time: validDuration,
                        text: String(row.Instruction || "").substring(0, 200),
                        lyric: String(row.Lyrics || "").substring(0, 500)
                    };
                });

                if (importedCues.length > 0) {
                    allProjects.push({ 
                        id: generateId(), 
                        name: sheetName || `Imported ${new Date().toLocaleTimeString()}`, 
                        cues: importedCues 
                    });
                }
            });

            saveToDisk(); 
            renderProjects();
            showToast("Import Successful!", "success");
        } catch (err) {
            console.error("Excel Import Error:", err);
            showToast("Failed to parse Excel file. Ensure it matches the expected template.", "error");
        }
    };
    reader.readAsArrayBuffer(file);
}

async function importFromGoogleSheet() {
    const urlInput = document.getElementById('gsheet-url');
    const importBtn = document.getElementById('gsheet-import-btn');
    
    if (!urlInput) return;
    
    const urlValue = urlInput.value.trim();
    if (!urlValue) {
        showToast("Please paste a valid URL first", "warning");
        return;
    }

    const sheetIdMatch = urlValue.match(/\/d\/([a-zA-Z0-9-_]+)/);
    
    if (!sheetIdMatch) {
        showToast("Invalid Google Sheet URL format", "error");
        return;
    }

    const spreadsheetId = sheetIdMatch[1];
    const exportUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=xlsx`;

    if (importBtn) {
        importBtn.innerText = "FETCHING...";
        importBtn.disabled = true;
    }

    try {
        const response = await fetch(exportUrl);
        
        if (!response.ok) {
            throw new Error("Failed to fetch. Is the sheet set to 'Anyone with the link can view'?");
        }

        const arrayBuffer = await response.arrayBuffer();
        const data = new Uint8Array(arrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });

        workbook.SheetNames.forEach(sheetName => {
            const worksheet = workbook.Sheets[sheetName];
            const jsonData = XLSX.utils.sheet_to_json(worksheet);

            const importedCues = jsonData.map(row => {
                const rawDuration = parseFloat(row.Duration);
                const validDuration = (Number.isFinite(rawDuration) && rawDuration >= 0) ? rawDuration : 5;
                
                const rawCam = parseInt(row.Camera, 10);
                const validCam = (Number.isFinite(rawCam) && rawCam >= 0) ? rawCam : 1;

                return {
                    cam: validCam,
                    color: (row.Color && row.Color.startsWith('#')) ? row.Color : "#7c4dff",
                    time: validDuration,
                    text: sanitizeText(String(row.Instruction || "")).substring(0, 200),
                    lyric: sanitizeText(String(row.Lyrics || "")).substring(0, 500)
                };
            });

            if (importedCues.length > 0) {
                allProjects.push({ 
                    id: generateId(), 
                    name: sheetName || `Imported Link ${new Date().toLocaleTimeString()}`, 
                    cues: importedCues 
                });
            }
        });

        saveToDisk(); 
        renderProjects();
        
        showToast("Import Successful!", "success");
        urlInput.value = '';

    } catch (error) {
        console.error("Google Sheet Import Error:", error);
        showToast("Import failed. Check console or make sure Sheet is public.", "error");
    } finally {
        if (importBtn) {
            importBtn.innerText = "LOAD LINK";
            importBtn.disabled = false;
        }
    }
}

/* --- Confirmation Logic --- */
let confirmCallback = null;

function askConfirmation(msg, onConfirm) {
    const modal = document.getElementById('confirm-modal');
    const msgElement = document.getElementById('confirm-message');
    const confirmBtn = document.getElementById('confirm-action-btn');

    msgElement.innerText = msg;
    confirmCallback = onConfirm;
    
    modal.style.display = 'flex';

    confirmBtn.onclick = () => {
        if (confirmCallback) confirmCallback();
        closeConfirmModal();
    };
}

function closeConfirmModal() {
    document.getElementById('confirm-modal').style.display = 'none';
    confirmCallback = null;
}

function clearAppCache() {
    askConfirmation(
        "This will permanently delete ALL projects, settings, and local data. This cannot be undone. Are you sure?", 
        () => {
            APP_STORAGE_KEYS.forEach(key => localStorage.removeItem(key));
            showToast("System Purged. Reloading...", "error");
            
            setTimeout(() => {
                location.reload();
            }, 1000);
        }
    );
}

function showToast(msg, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${sanitizeText(msg)}</span>`;

    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('fade-out');
        toast.addEventListener('animationend', () => {
            toast.remove();
        }, { once: true });
    }, duration);
}

/* --- SPLASH SCREEN HANDLER --- */
document.addEventListener('DOMContentLoaded', () => {
    const splash = document.getElementById('splash-screen');
    const startBtn = document.getElementById('splash-start-btn');
    const audio = document.getElementById('splash-audio');

    if (startBtn) {
        startBtn.addEventListener('click', () => {
            if (audio) {
                audio.volume = 1;
                audio.play().catch(err => console.warn('Audio play failed:', err));
            }
            triggerGlobalHitCounter();
            startBtn.innerText = "ACCESS GRANTED";
            startBtn.style.borderColor = "var(--status-safe)";
            startBtn.style.color = "var(--status-safe)";

            setTimeout(() => {
                if (splash) {
                    splash.classList.add('fade-out');
                    setTimeout(() => splash.remove(), 600);
                }
            }, 4000);
        });
    }
    const gsheetBtn = document.getElementById('gsheet-import-btn');
    if (gsheetBtn) {
        gsheetBtn.addEventListener('click', importFromGoogleSheet);
    }
});

/* --- GOOGLE SHEETS HIT COUNTER --- */
async function triggerGlobalHitCounter() {
    const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbypSvShfM6qBhRHc0nWW7kF85wUgK--SXIlRmv4VICu3Cmb32YC4VjXtdgpoLzIe4QBtQ/exec";
    const counterEl = document.getElementById('global-hit-count');

    try {
        const response = await fetch(GOOGLE_SCRIPT_URL);
        const data = await response.json();

        if (data && data.count) {
            counterEl.innerText = data.count.toString().padStart(3, '0');
        }
    } catch (error) {
        console.error("Counter Error:", error);
        counterEl.innerText = "OFFLINE";
    }
}

/* --- PWA SERVICE WORKER REGISTRATION --- */
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('PWA active on scope:', reg.scope))
            .catch(err => console.log('PWA registration failed:', err));
    });
}