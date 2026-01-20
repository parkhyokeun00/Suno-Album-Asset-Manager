
// State
const State = {
    dirHandle: null,
    songs: [], // Array of song objects: { id, fileHandle, metadata }
    folders: ['Unsorted'], // List of folder names (virtual or physical, for now virtual tags)
    currentView: 'all', // 'all' or folder name
    searchTerm: '',
    playingId: null,
    isEditing: false
};

// Utils
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const formatTime = (s) => {
    if (!s || isNaN(s)) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
}

// --- File System Manager ---
const FS = {
    async openVault() {
        try {
            const handle = await window.showDirectoryPicker({
                id: 'suno-vault-location',
                mode: 'readwrite'
            });
            State.dirHandle = handle;
            await this.scanVault();
            UI.showApp();
        } catch (err) {
            console.error(err);
            if (err.name !== 'AbortError') alert('Could not open folder. Please try again.');
        }
    },

    async scanVault(forceUpdate = false) {
        if (!State.dirHandle) return;

        // 1. Try to load vault.json
        let vaultData = { songs: [], folders: ['Unsorted'] };
        try {
            const fileHandle = await State.dirHandle.getFileHandle('vault.json');
            const file = await fileHandle.getFile();
            const text = await file.text();
            vaultData = JSON.parse(text);
        } catch (e) {
            console.log('No vault.json found, creating fresh state.');
        }

        State.folders = vaultData.folders || ['Unsorted'];
        State.songs = [];

        UI.showToast(forceUpdate ? "Scanning & Updating ID3..." : "Scanning Vault...");

        // Scan directory for audio files
        for await (const entry of State.dirHandle.values()) {
            if (entry.kind === 'file' && isAudioFile(entry.name)) {
                // Check if we have metadata for this file in vaultData
                let songData = vaultData.songs.find(s => s.filename === entry.name);

                // If forcing update or new file, read ID3
                if (forceUpdate || !songData) {
                    try {
                        const file = await entry.getFile();
                        const id3 = await readID3(file);

                        // Default structure
                        const base = songData || {
                            id: Date.now().toString() + Math.random(),
                            filename: entry.name,
                            folder: "Unsorted",
                            tags: [],
                            meta: { bpm: '', key: '', genre: '' },
                            prompt: '',
                            lyrics: '',
                            memo: '',
                            createdAt: new Date().toISOString().split('T')[0]
                        };

                        // Merge ID3 (Priority to ID3 if found, else keep existing/default)
                        songData = {
                            ...base,
                            title: (id3 && id3.title) ? id3.title : (base.title || entry.name.replace(/\.[^/.]+$/, "")),
                            persona: (id3 && id3.artist) ? id3.artist : (base.persona || "Unknown"),
                            coverUrl: (id3 && id3.coverUrl) ? id3.coverUrl : (base.coverUrl || null),
                            status: forceUpdate ? 'updated' : 'new'
                        };

                        // ID3 Genre merge
                        if (id3 && id3.genre) songData.meta.genre = id3.genre;
                        // Map ID3 Album to Folder if folder is Unsorted? 
                        // For now let's keep user's folder organization unless explicitly asked, 
                        // but maybe update if current is Unsorted.
                        if (id3 && id3.album && songData.folder === 'Unsorted') {
                            if (!State.folders.includes(id3.album)) State.folders.push(id3.album);
                            songData.folder = id3.album;
                        }

                    } catch (e) { console.warn("Failed to read ID3", e); }
                }

                // If still no songData (failed read and no existing), create minimal
                if (!songData) {
                    songData = {
                        id: Date.now().toString() + Math.random(),
                        filename: entry.name,
                        title: entry.name.replace(/\.[^/.]+$/, ""),
                        persona: "Unknown",
                        folder: "Unsorted",
                        tags: [],
                        meta: { bpm: '', key: '', genre: '' },
                        prompt: '', lyrics: '', memo: '',
                        createdAt: new Date().toISOString().split('T')[0],
                        coverUrl: null,
                        status: 'new'
                    };
                }

                State.songs.push({
                    ...songData,
                    handle: entry // Always attach fresh handle validation
                });

            } else if (entry.kind === 'directory') {
                // Future Recursive
            }
        }

        // Sort by new
        State.songs.sort((a, b) => b.id - a.id);

        await this.saveVault(); // Sync back
        UI.render();
        UI.showToast("Vault Updated.");
    },

    async saveVault() {
        if (!State.dirHandle) return;

        // Prepare data to save (exclude handles as they are not serializable)
        const dataToSave = {
            version: "1.0",
            folders: State.folders,
            songs: State.songs.map(s => {
                const { handle, audioUrl, status, ...rest } = s; // Exclude runtime props
                return rest;
            })
        };

        try {
            const fileHandle = await State.dirHandle.getFileHandle('vault.json', { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(JSON.stringify(dataToSave, null, 2));
            await writable.close();
        } catch (e) {
            console.error("Failed to save vault.json", e);
            UI.showToast("Failed to save changes to disk!");
        }
    },

    async importFile(fileHandle) {
        // Copy file logic
    }
};

function isAudioFile(name) {
    return /\.(mp3|wav|ogg|m4a)$/i.test(name);
}

// --- Audio Player ---
const AudioEngine = {
    el: new Audio(),

    init() {
        this.el.addEventListener('timeupdate', () => {
            const pct = (this.el.currentTime / this.el.duration) * 100;
            const bar = $('#player-progress');
            if (bar) bar.style.width = `${pct}%`;
            const time = $('#current-time');
            if (time) time.textContent = formatTime(this.el.currentTime);
        });
        this.el.addEventListener('loadedmetadata', () => {
            const d = $('#total-duration');
            if (d) d.textContent = formatTime(this.el.duration);
        });
        this.el.addEventListener('ended', () => {
            $('#play-pause-btn').innerHTML = `<i data-lucide="play" class="w-8 h-8 fill-current"></i><span class="text-xl tracking-tight uppercase">Replay</span>`;
        });
    },

    async play(song) {
        if (!song.handle) return;
        const file = await song.handle.getFile();
        const url = URL.createObjectURL(file);

        this.el.src = url;
        // this.el.play(); // Auto-play disabled by default
        State.playingId = song.id;

        // Update Button State to Play (since we paused auto-play)
        const btn = $('#play-pause-btn');
        if (btn) btn.innerHTML = `<i data-lucide="play" class="w-8 h-8 fill-current"></i><span class="text-xl tracking-tight uppercase">Play</span>`;
    },

    toggle() {
        const btn = $('#play-pause-btn');
        if (this.el.paused) {
            this.el.play();
            if (btn) btn.innerHTML = `<i data-lucide="pause" class="w-8 h-8 fill-current"></i><span class="text-xl tracking-tight uppercase">Pause</span>`;
        } else {
            this.el.pause();
            if (btn) btn.innerHTML = `<i data-lucide="play" class="w-8 h-8 fill-current"></i><span class="text-xl tracking-tight uppercase">Play</span>`;
        }
    },

    setVolume(val) {
        this.el.volume = val;
        $('#volume-label').textContent = Math.round(val * 100) + '%';
    },

    seek(pct) {
        if (this.el.duration) {
            this.el.currentTime = this.el.duration * pct;
        }
    }
};

// --- UI Manager ---
const UI = {
    showApp() {
        $('#landing-screen').classList.add('hidden');
        $('#app-container').classList.remove('hidden');
        $('#app-container').classList.remove('opacity-0');
    },

    showToast(msg) {
        const t = $('#toast');
        $('#toast-message').textContent = msg;
        t.classList.remove('translate-y-32', 'opacity-0');
        setTimeout(() => t.classList.add('translate-y-32', 'opacity-0'), 3000);
    },

    render() {
        this.renderFolders();
        this.renderGrid();
        lucide.createIcons();
    },

    renderFolders() {
        const list = $('#folder-list');
        list.innerHTML = '';
        State.folders.forEach(f => {
            const count = State.songs.filter(s => s.folder === f).length;
            const isActive = State.currentView === f;

            const div = document.createElement('div');
            div.className = `group flex items-center justify-between px-6 py-4 rounded-2xl cursor-pointer transition-all border-2 border-transparent ${isActive ? 'bg-blue-600 text-white shadow-lg' : 'text-zinc-500 hover:bg-zinc-50'}`;
            div.onclick = () => {
                State.currentView = f;
                $('#current-view-name').textContent = f;
                $('#tab-all').className = 'w-full flex items-center space-x-4 px-6 py-5 rounded-2xl transition-all mb-8 text-zinc-500 hover:bg-zinc-100'; // reset 'All' tab
                this.render();
            };

            div.innerHTML = `
                <div class="flex items-center space-x-4 overflow-hidden pointer-events-none">
                    <i data-lucide="folder" class="w-4 h-4 shrink-0 ${isActive ? 'text-white' : 'text-blue-500'}"></i>
                    <span class="font-bold text-sm truncate pr-4">${f}</span>
                </div>
                <span class="text-[10px] font-black px-2 py-0.5 rounded-full ${isActive ? 'bg-white/20' : 'bg-zinc-100 text-zinc-500'}">${count}</span>
            `;
            list.appendChild(div);
        });
    },

    renderGrid() {
        const grid = $('#asset-grid');
        grid.innerHTML = '';

        const filtered = State.songs.filter(s => {
            if (State.currentView !== 'all' && s.folder !== State.currentView) return false;
            if (State.searchTerm) {
                const q = State.searchTerm.toLowerCase();
                return s.title.toLowerCase().includes(q) || s.persona.toLowerCase().includes(q);
            }
            return true;
        });

        filtered.forEach(s => {
            const el = document.createElement('div');
            el.className = "group bg-white p-8 rounded-[3rem] border border-zinc-200 hover:border-blue-500 hover:shadow-2xl hover:shadow-blue-500/10 transition-all duration-300 cursor-pointer relative overflow-hidden active:scale-95";
            el.onclick = () => this.openModal(s.id);

            el.innerHTML = `
                 <div class="flex justify-between items-start mb-6 pointer-events-none">
                    <div class="flex items-center space-x-4">
                        <div class="w-14 h-14 bg-zinc-50 rounded-2xl flex items-center justify-center overflow-hidden transition-colors duration-300 shadow-inner group-hover:ring-2 group-hover:ring-blue-500/20">
                            ${s.coverUrl
                    ? `<img src="${s.coverUrl}" class="w-full h-full object-cover">`
                    : `<i data-lucide="music" class="w-6 h-6 text-zinc-300 group-hover:text-blue-500"></i>`
                }
                        </div>
                        <div class="max-w-[120px]">
                            <h3 class="font-black text-lg text-zinc-900 tracking-tight leading-none truncate mb-1">${s.title}</h3>
                            <p class="text-[10px] text-blue-500 font-bold uppercase tracking-widest truncate">${s.persona}</p>
                        </div>
                    </div>
                </div>
                <div class="flex flex-wrap gap-2 mt-auto">
                     <span class="px-3 py-1 bg-zinc-50 rounded-lg text-[9px] font-black text-zinc-400 uppercase tracking-wider border border-zinc-100">${s.meta.bpm || '---'} BPM</span>
                     <span class="px-3 py-1 bg-zinc-50 rounded-lg text-[9px] font-black text-zinc-400 uppercase tracking-wider border border-zinc-100">${s.meta.key || '---'}</span>
                </div>
            `;
            grid.appendChild(el);
        });
    },

    async openModal(id) {
        const s = State.songs.find(x => x.id === id);
        if (!s) return;

        State.playingMetadata = s;
        State.isEditing = false; // Reset edit state
        $('#asset-modal').classList.remove('hidden');

        // 1. Sidebar Info - Cover
        const coverCont = $('#modal-cover-container');
        if (s.coverUrl) {
            coverCont.innerHTML = `<img src="${s.coverUrl}" class="w-full h-full object-cover">`;
        } else {
            coverCont.innerHTML = `<i data-lucide="music" class="w-24 h-24 text-zinc-400 opacity-20"></i>`;
        }

        $('#modal-title-section').innerHTML = `
            <h3 class="text-3xl font-black mb-2 tracking-tighter truncate leading-tight">${s.title}</h3>
             <div class="flex items-center justify-center space-x-2 opacity-50">
                <i data-lucide="mic-2" class="w-4 h-4 text-blue-500"></i>
                <p class="text-xs font-black uppercase tracking-[0.2em]">${s.persona}</p>
            </div>
        `;

        // Update Edit Button in Sidebar
        $('#btn-edit-save').onclick = () => this.toggleEditMode();
        this.updateEditButtonUI();

        this.renderModalContent();

        // Prepare audio (No Auto Play)
        if (s.handle) {
            const file = await s.handle.getFile();
            const url = URL.createObjectURL(file);
            AudioEngine.el.src = url;
            $('#play-pause-btn').innerHTML = `<i data-lucide="play" class="w-8 h-8 fill-current"></i><span class="text-xl tracking-tight uppercase">Play</span>`;
        }
    },

    renderModalContent() {
        const s = State.playingMetadata;
        const isEd = State.isEditing;
        const contentArea = $('#asset-modal .flex-1 .space-y-16');

        // Styles for inputs
        const readStyle = "bg-transparent border-none p-0 text-zinc-900 font-bold w-full focus:outline-none cursor-default truncate";
        const editStyle = "bg-white border-b-2 border-blue-500 rounded-none px-2 py-1 text-zinc-900 font-bold w-full focus:outline-none";

        // Generate Folders Options
        const folderOptions = State.folders.map(f => `<option value="${f}" ${s.folder === f ? 'selected' : ''}>${f}</option>`).join('');

        contentArea.innerHTML = `
            <!-- Creative Intelligence Group -->
            <section class="bg-zinc-50/50 p-10 rounded-[3.5rem] border border-zinc-100/80 relative transition-all ${isEd ? 'ring-4 ring-blue-500/10' : ''}">
                <div class="flex items-center justify-between mb-8">
                    <div class="flex items-center space-x-4">
                        <div class="w-10 h-10 bg-blue-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-500/20">
                            <i data-lucide="type" class="w-5 h-5 text-white"></i>
                        </div>
                        <h4 class="text-lg font-black text-zinc-900 uppercase tracking-[0.2em]">Creative Intelligence</h4>
                    </div>
                    <!-- Inline Edit Toggle -->
                    <button onclick="VaultApp.UI.toggleEditMode()" class="px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${isEd ? 'bg-blue-600 text-white shadow-lg' : 'bg-white border border-zinc-200 text-zinc-400 hover:text-zinc-900'}">
                        ${isEd ? 'Save Changes' : 'Edit Info'}
                    </button>
                </div>
                
                <!-- Basic Info Grid -->
                <div class="grid grid-cols-2 md:grid-cols-3 gap-6 mb-10 p-6 bg-white/50 rounded-[2.5rem] border border-zinc-100/50">
                    <div>
                        <p class="text-[9px] font-black text-zinc-400 uppercase tracking-widest mb-2">Folder</p>
                        ${isEd
                ? `<select id="inp-folder" class="${editStyle}">${folderOptions}</select>`
                : `<input readonly value="${s.folder}" class="${readStyle}">`
            }
                    </div>
                    <div>
                        <p class="text-[9px] font-black text-zinc-400 uppercase tracking-widest mb-2">Persona</p>
                        <input id="inp-persona" ${isEd ? '' : 'readonly'} value="${s.persona}" class="${isEd ? editStyle : readStyle}">
                    </div>
                    <div>
                        <p class="text-[9px] font-black text-zinc-400 uppercase tracking-widest mb-2">Genre</p>
                        <input id="inp-genre" ${isEd ? '' : 'readonly'} value="${s.meta.genre || ''}" class="${isEd ? editStyle : readStyle}" placeholder="---">
                    </div>
                    <div>
                        <p class="text-[9px] font-black text-zinc-400 uppercase tracking-widest mb-2">BPM</p>
                        <input id="inp-bpm" ${isEd ? '' : 'readonly'} value="${s.meta.bpm || ''}" class="${isEd ? editStyle : readStyle}" placeholder="---">
                    </div>
                    <div>
                        <p class="text-[9px] font-black text-zinc-400 uppercase tracking-widest mb-2">Key</p>
                        <input id="inp-key" ${isEd ? '' : 'readonly'} value="${s.meta.key || ''}" class="${isEd ? editStyle : readStyle}" placeholder="---">
                    </div>
                    <div>
                        <p class="text-[9px] font-black text-zinc-400 uppercase tracking-widest mb-2">Created</p>
                        <input readonly value="${s.createdAt}" class="${readStyle} text-zinc-400">
                    </div>
                </div>

                <div class="space-y-10">
                    <div>
                        <p class="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-4 px-2">Input Prompt</p>
                        ${isEd
                ? `<textarea id="inp-prompt" class="w-full p-8 rounded-[2.5rem] bg-white border-2 border-blue-100 shadow-inner min-h-[120px] text-sm text-zinc-800 focus:outline-none focus:border-blue-500 transition-all">${s.prompt || ''}</textarea>`
                : `<div class="w-full p-8 rounded-[2.5rem] bg-white border border-zinc-200 shadow-sm min-h-[120px] text-sm text-zinc-600 italic leading-relaxed">${s.prompt || "No prompt data."}</div>`
            }
                    </div>
                    <div>
                        <p class="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-4 px-2">Written Lyrics</p>
                        ${isEd
                ? `<textarea id="inp-lyrics" class="w-full p-10 rounded-[3rem] bg-zinc-900 text-white font-mono text-sm leading-loose shadow-inner h-[400px] overflow-y-auto custom-scrollbar focus:outline-none border-2 border-transparent focus:border-blue-500">${s.lyrics || ''}</textarea>`
                : `<div class="w-full p-10 rounded-[3rem] bg-zinc-900 text-zinc-300 font-mono text-sm leading-loose shadow-inner h-[400px] overflow-y-auto custom-scrollbar">${s.lyrics || "No lyrics available."}</div>`
            }
                    </div>
                </div>
            </section>

            <!-- Asset Context Group -->
            <section class="bg-zinc-50/50 p-10 rounded-[3.5rem] border border-zinc-100/80">
                <div class="flex items-center mb-8 space-x-4">
                    <div class="w-10 h-10 bg-purple-600 rounded-2xl flex items-center justify-center shadow-lg shadow-purple-500/20">
                        <i data-lucide="info" class="w-5 h-5 text-white"></i>
                    </div>
                    <h4 class="text-lg font-black text-zinc-900 uppercase tracking-[0.2em]">Asset Context</h4>
                </div>

                <div class="space-y-10">
                    <div>
                        <p class="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-4 px-2">Tags</p>
                        <div id="modal-tags-container" class="w-full p-6 rounded-[2.5rem] bg-white border border-zinc-200 shadow-sm flex flex-wrap gap-2 min-h-[80px]">
                            ${s.tags.length > 0
                ? s.tags.map(t => `<div class="px-4 py-2 bg-zinc-100 rounded-full text-xs font-bold text-zinc-600">#${t}</div>`).join('')
                : '<span class="text-zinc-300 text-xs font-medium italic">No tags added</span>'
            }
                        </div>
                         ${isEd ? `<input id="inp-new-tag" placeholder="Add tag + Enter..." class="mt-2 w-full bg-transparent border-b border-zinc-200 px-4 py-2 text-sm focus:border-blue-500 outline-none" onkeydown="VaultApp.UI.handleAddTag(event)">` : ''}
                    </div>
                    <div>
                         <p class="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-4 px-2">Internal Memos</p>
                         ${isEd
                ? `<textarea id="inp-memo" class="w-full p-8 rounded-[2.5rem] bg-white border-2 border-blue-100 shadow-inner min-h-[150px] text-base text-zinc-800 focus:outline-none focus:border-blue-500 transition-all">${s.memo || ''}</textarea>`
                : `<div class="w-full p-8 rounded-[2.5rem] bg-white border border-zinc-200 shadow-sm min-h-[150px] text-base text-zinc-700 leading-relaxed">${s.memo || "No memos."}</div>`
            }
                    </div>
                </div>
            </section>
        `;
        lucide.createIcons();
    },

    toggleEditMode() {
        if (!State.isEditing) {
            // Enable Edit
            State.isEditing = true;
            this.updateEditButtonUI();
            this.renderModalContent();
        } else {
            // Save Changes
            this.saveMetadata();
        }
    },

    saveMetadata() {
        const s = State.playingMetadata;
        if (!s) return;

        // Gather Data
        s.folder = $('#inp-folder').value;
        s.persona = $('#inp-persona').value;
        s.meta.genre = $('#inp-genre').value;
        s.meta.bpm = $('#inp-bpm').value;
        s.meta.key = $('#inp-key').value;
        s.prompt = $('#inp-prompt').value;
        s.lyrics = $('#inp-lyrics').value;
        s.memo = $('#inp-memo').value;

        // Save
        FS.saveVault(); // Persist to JSON

        State.isEditing = false;
        this.updateEditButtonUI();
        this.renderModalContent(); // Re-render read-only
        this.render(); // Update grid (in case title/folder changed)
        this.showToast("Changes saved to Vault.");
    },

    handleAddTag(e) {
        if (e.key === 'Enter') {
            const val = e.target.value.trim();
            if (val && !State.playingMetadata.tags.includes(val)) {
                State.playingMetadata.tags.push(val);
                this.renderModalContent();

                // Re-focus and keep value if needed (or clear it) To allow multiple
                const inp = $('#inp-new-tag');
                if (inp) {
                    inp.value = ''; // clear
                    inp.focus(); // keep focus
                }
            }
        }
    },

    updateEditButtonUI() {
        const btn = $('#btn-edit-save');
        if (State.isEditing) {
            btn.innerHTML = `<i data-lucide="save" class="w-6 h-6"></i> <span>Save Metadata</span>`;
            btn.className = "w-full py-6 rounded-[2.5rem] font-black flex items-center justify-center space-x-3 active:scale-95 transition-all shadow-xl bg-blue-600 text-white hover:bg-blue-700";
        } else {
            btn.innerHTML = `<i data-lucide="edit-3" class="w-6 h-6"></i> <span>Edit Metadata</span>`;
            btn.className = "w-full py-6 rounded-[2.5rem] font-black flex items-center justify-center space-x-3 active:scale-95 transition-all shadow-xl bg-white border-2 border-zinc-900 text-zinc-900 hover:bg-zinc-900 hover:text-white";
        }
        lucide.createIcons();
    },

    closeModal() {
        AudioEngine.el.pause();
        $('#asset-modal').classList.add('hidden');
        State.playingMetadata = null;
        State.isEditing = false;
    }
};

// --- Events ---
$('#btn-open-vault').onclick = () => FS.openVault();
$('#btn-refresh').onclick = () => FS.scanVault(true);
$('#search-input').oninput = (e) => {
    State.searchTerm = e.target.value;
    UI.render();
};
$('#play-pause-btn').onclick = () => AudioEngine.toggle();
$('#volume-slider').oninput = (e) => AudioEngine.setVolume(e.target.value);
$('#tab-all').onclick = () => {
    State.currentView = 'all';
    $('#current-view-name').textContent = 'ALL LIBRARY';
    $('#tab-all').className = 'w-full flex items-center space-x-4 px-6 py-5 rounded-2xl transition-all mb-8 bg-zinc-900 text-white shadow-xl';
    UI.render();
};
$('#btn-add-folder').onclick = () => {
    const n = prompt("New Folder Name:");
    if (n) {
        State.folders.push(n);
        FS.saveVault();
        UI.render();
    }
};

// Player Seek
$('#player-controls .bg-zinc-200').onclick = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    AudioEngine.seek(pct);
};

// Init
AudioEngine.init();

// Export for debugging
window.VaultApp = {
    State, FS, UI, AudioEngine, closeModal: UI.closeModal
};

// --- ID3 Helper ---
async function readID3(file) {
    return new Promise((resolve) => {
        jsmediatags.read(file, {
            onSuccess: (tag) => {
                const t = tag.tags;
                let coverUrl = null;
                if (t.picture) {
                    try {
                        const { data, format } = t.picture;
                        let base64String = "";
                        for (let i = 0; i < data.length; i++) {
                            base64String += String.fromCharCode(data[i]);
                        }
                        coverUrl = `data:${format};base64,${window.btoa(base64String)}`;
                    } catch (e) { console.warn("Cover extract failed", e); }
                }

                resolve({
                    title: t.title,
                    artist: t.artist,
                    coverUrl: coverUrl,
                    album: t.album,
                    genre: t.genre
                });
            },
            onError: (error) => {
                console.warn("ID3 Read Error:", error);
                resolve(null);
            }
        });
    });
}
