
// State
const State = {
    dirHandle: null,
    songs: [], // Array of song objects: { id, fileHandle, metadata }
    folders: ['Unsorted'], // List of folder names (virtual or physical, for now virtual tags)
    currentView: 'all', // 'all' or folder name
    searchTerm: '',
    playingId: null,
    playingMetadata: null, // Song object of currently open modal
    isEditing: false,
    playlist: [], // Playlist for sequential playback
    playlistIndex: -1,
    lastContext: null // Backup for when modal interrupts playback
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

                        // Restore Local Cover
                        if (base.coverPath && base.coverPath.startsWith('covers/')) {
                            songData.coverPath = base.coverPath;
                            try {
                                const coversDir = await State.dirHandle.getDirectoryHandle('covers');
                                const fh = await coversDir.getFileHandle(base.coverPath.split('/')[1]);
                                const file = await fh.getFile();
                                songData.coverUrl = URL.createObjectURL(file);
                            } catch (e) {
                                // console.warn("Failed to load local cover", base.coverPath);
                            }
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
    },

    async saveCover(file, id) {
        if (!State.dirHandle) return null;
        try {
            const coversDir = await State.dirHandle.getDirectoryHandle('covers', { create: true });
            // Use ID or sanitized name
            const ext = file.name.split('.').pop();
            const filename = `cover_${id}.${ext}`;
            const fileHandle = await coversDir.getFileHandle(filename, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(file);
            await writable.close();
            return { filename, handle: fileHandle };
        } catch (e) {
            console.error("Failed to save cover", e);
            return null;
        }
    },

    async writeID3(song, coverBlob = null) {
        if (!song.handle || !window.ID3Writer) return;
        try {
            const file = await song.handle.getFile();
            const buffer = await file.arrayBuffer();
            const writer = new ID3Writer(buffer);

            // Set Frames
            if (song.title) writer.setFrame('TIT2', song.title);
            if (song.persona) writer.setFrame('TPE1', [song.persona]);
            if (song.folder) writer.setFrame('TALB', song.folder); // Album as Folder
            if (song.meta.genre) writer.setFrame('TCON', [song.meta.genre]);
            if (song.meta.bpm) writer.setFrame('TBPM', song.meta.bpm);

            // Lyrics (USLT)
            if (song.lyrics) {
                writer.setFrame('USLT', {
                    description: '',
                    lyrics: song.lyrics,
                    language: 'eng'
                });
            }

            // Cover (APIC)
            if (coverBlob) {
                const coverBuffer = await coverBlob.arrayBuffer();
                writer.setFrame('APIC', {
                    type: 3,
                    data: coverBuffer,
                    description: 'Cover',
                    useUnicodeEncoding: false // Defaults to false
                });
            }

            writer.addTag();
            const taggedBlob = writer.getBlob();

            // Write back to file
            const writable = await song.handle.createWritable();
            await writable.write(taggedBlob);
            await writable.close();
            console.log("ID3 Tags Written Successfully");
            return true;
        } catch (e) {
            console.error("ID3 Write Failed", e);
            return false;
        }
    }
};

function isAudioFile(name) {
    return /\.(mp3|wav|ogg|m4a)$/i.test(name);
}

// --- Audio Visualizer ---
const Visualizer = {
    ctx: null,
    analyser: null,
    source: null,
    dataArray: null,
    canvases: [], // Array of { el, ctx }
    animationId: null,
    isInit: false,

    init(audioElement) {
        if (this.isInit) return;

        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            this.ctx = new AudioContext();
            this.analyser = this.ctx.createAnalyser();
            this.analyser.fftSize = 64; // Low resolution for bars

            // Connect
            this.source = this.ctx.createMediaElementSource(audioElement);
            this.source.connect(this.analyser);
            this.analyser.connect(this.ctx.destination);

            this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);

            // Register Canvases
            this.addCanvas('audio-visualizer'); // Footer
            this.addCanvas('audio-visualizer-modal'); // Modal

            this.isInit = true;
            this.draw();
        } catch (e) {
            console.warn("Web Audio API init failed", e);
        }
    },

    addCanvas(id) {
        const c = document.getElementById(id);
        if (c) {
            this.canvases.push({
                el: c,
                ctx: c.getContext('2d')
            });
        }
    },

    draw() {
        this.animationId = requestAnimationFrame(() => this.draw());
        if (this.canvases.length === 0) return;

        const bufferLength = this.analyser.frequencyBinCount;
        this.analyser.getByteFrequencyData(this.dataArray);

        // Draw to all registered canvases
        this.canvases.forEach(target => {
            const w = target.el.width;
            const h = target.el.height;
            const ctx = target.ctx;

            ctx.clearRect(0, 0, w, h);

            const barWidth = (w / bufferLength) * 2;
            let x = 0;

            // LED Style Config
            const segmentHeight = 3;
            const gap = 1;

            for (let i = 0; i < bufferLength; i++) {
                const barHeight = (this.dataArray[i] / 255) * h;
                const segments = Math.floor(barHeight / (segmentHeight + gap));

                for (let j = 0; j < segments; j++) {
                    const y = h - (j * (segmentHeight + gap)) - segmentHeight;

                    // Color Gradient (Green -> Yellow -> Red)
                    const pct = j / (h / (segmentHeight + gap));
                    let color = '#4ade80'; // Green
                    if (pct > 0.4) color = '#facc15'; // Yellow
                    if (pct > 0.7) color = '#f87171'; // Red

                    ctx.fillStyle = color;
                    ctx.fillRect(x, y, barWidth, segmentHeight);
                }
                x += barWidth + 2;
            }
        });
    }
};

// --- Audio Player ---
const AudioEngine = {
    el: new Audio(),

    init() {
        // Modal Play Button (Persistent)
        const modalBtn = $('#play-pause-btn');
        if (modalBtn) modalBtn.onclick = () => this.toggle();

        this.el.addEventListener('play', () => {
            if (!Visualizer.isInit) Visualizer.init(this.el);
            if (Visualizer.ctx && Visualizer.ctx.state === 'suspended') Visualizer.ctx.resume();

            // Ensure Footer is updated even if played from Modal
            let song = State.songs.find(s => s.id === State.playingId);
            if (!song && State.playingMetadata) song = State.playingMetadata; // Fallback to modal song

            if (song) {
                State.playingId = song.id;
                if (UI.updateFooter) UI.updateFooter(song);
            }
            this.updateButtonState(true);
        });

        this.el.addEventListener('pause', () => {
            this.updateButtonState(false);
        });

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

        // Footer Controls - Delay slightly to ensure DOM
        setTimeout(() => {
            const fBtn = $('#btn-play-pause-footer');
            if (fBtn) fBtn.onclick = () => this.toggle();
            $('#btn-prev').onclick = () => this.playNextPrev(-1);
            $('#btn-next').onclick = () => this.playNextPrev(1);
        }, 100);

        // Playlist Auto-Advance
        this.el.addEventListener('ended', () => {
            if (State.playlist.length > 0 && State.playlistIndex < State.playlist.length - 1) {
                State.playlistIndex++;
                this.play(State.playlist[State.playlistIndex]);
            } else {
                $('#play-pause-btn').innerHTML = `<i data-lucide="play" class="w-8 h-8 fill-red-600 text-red-600"></i><span class="text-xl tracking-tight uppercase">Replay</span>`;
                lucide.createIcons();
            }
        });
    },

    async play(song) {
        if (!song.handle) return;

        // Setup Visualizer logic on first play if needed, handled in init 'play' listener

        const file = await song.handle.getFile();
        const url = URL.createObjectURL(file);

        this.el.src = url;
        this.el.play();
        State.playingId = song.id;

        // Force UI Sync Immediately
        if (UI.updateFooter) UI.updateFooter(song);

        // If Play All active and modal open, ensure modal content updates if we want?
        // Actually for now let's just keep playing. 
        // If the user wants to see the new song they can click it. 
        // Or we can auto-update modal if open?
        // Let's auto-update modal Metadata if it is open!
        if (State.playingMetadata && document.getElementById('asset-modal').classList.contains('hidden') === false) {
            // Only if playing a *different* song than showed? 
            // Actually UI.openModal sets State.playingMetadata. 
            // Let's separate "openModal" from "setModalContent".
            // For now, simpler: If playing from playlist, we probably want to see it.
            if (State.playingMetadata.id !== song.id) {
                UI.openModal(song.id);
            }
        }

        // Update Button State to Play
        this.updateButtonState(true);
    },

    updateButtonState(isPlaying) {
        // Modal Button
        const btn = $('#play-pause-btn');
        if (btn) {
            if (isPlaying) {
                btn.innerHTML = `<i data-lucide="pause" class="w-8 h-8 fill-white text-white"></i><span class="text-xl tracking-tight uppercase">Pause</span>`;
            } else {
                btn.innerHTML = `<i data-lucide="play" class="w-8 h-8 fill-red-600 text-red-600"></i><span class="text-xl tracking-tight uppercase">Play</span>`;
            }
        }

        // Footer Button
        const fBtn = $('#btn-play-pause-footer');
        if (fBtn) {
            if (isPlaying) {
                fBtn.innerHTML = `<i data-lucide="pause" class="w-5 h-5 fill-current"></i>`;
            } else {
                fBtn.innerHTML = `<i data-lucide="play" class="w-5 h-5 fill-current"></i>`;
            }
        }
        lucide.createIcons();
    },

    playFolder(folderName) {
        // Get songs
        const songs = State.songs.filter(s => {
            if (folderName === 'all') return true;
            return s.folder === folderName;
        }).sort((a, b) => b.id - a.id);

        if (songs.length === 0) {
            UI.showToast("No songs to play.");
            return;
        }

        State.playlist = songs;
        State.playlistIndex = 0;
        this.play(State.playlist[0]);
        UI.showToast(`Playing ${songs.length} tracks...`);
        // Note: Modal open removed
    },

    playNextPrev(dir) {
        if (State.playlist.length === 0) return;
        let newIdx = State.playlistIndex + dir;
        if (newIdx >= 0 && newIdx < State.playlist.length) {
            State.playlistIndex = newIdx;
            this.play(State.playlist[newIdx]);
        }
    },

    toggle() {
        if (this.el.paused) {
            this.el.play();
        } else {
            this.el.pause();
        }
        // State listeners handle UI
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

    toggleMobileMenu() {
        const sidebar = $('#app-sidebar');
        const overlay = $('#sidebar-overlay');
        sidebar.classList.toggle('-translate-x-full');
        overlay.classList.toggle('hidden');
    },

    updateFooter(song) {
        const footer = $('#footer-player');
        footer.classList.remove('translate-y-full'); // Show footer

        $('#footer-title').textContent = song.title;
        $('#footer-artist').textContent = song.persona;

        if (song.coverUrl) {
            $('#footer-cover').innerHTML = `<img src="${song.coverUrl}" class="w-full h-full object-cover">`;
        } else {
            $('#footer-cover').innerHTML = `<i data-lucide="music" class="w-6 h-6 text-zinc-300"></i>`;
        }
        lucide.createIcons();
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
            // Add Drag-Reorder Support (Folder Draggable)
            div.draggable = true;
            div.ondragstart = (e) => {
                // If dragging a folder, mark type
                if (e.target === div || div.contains(e.target)) {
                    e.dataTransfer.setData('type/folder', f);
                    e.dataTransfer.effectAllowed = 'move';
                }
            };

            div.className = `group flex items-center justify-between px-6 py-4 rounded-2xl cursor-pointer transition-all border-2 border-transparent ${isActive ? 'bg-blue-600 text-white shadow-lg' : 'text-zinc-500 hover:bg-zinc-50'}`;
            div.onclick = () => {
                State.currentView = f;
                $('#current-view-name').textContent = f;
                $('#tab-all').className = 'w-full flex items-center space-x-4 px-6 py-5 rounded-2xl transition-all mb-8 text-zinc-500 hover:bg-zinc-100'; // reset 'All' tab
                this.render();
            };

            // Drop Target Logic (Asset -> Folder AND Folder -> Folder Reorder)
            div.ondragover = (e) => {
                e.preventDefault();
                div.classList.add('border-blue-500', 'bg-blue-50');
            };
            div.ondragleave = () => {
                div.classList.remove('border-blue-500', 'bg-blue-50');
            };
            div.ondrop = (e) => {
                e.preventDefault();
                div.classList.remove('border-blue-500', 'bg-blue-50');

                // Check if reordering folders
                const draggedFolder = e.dataTransfer.getData('type/folder');
                if (draggedFolder && draggedFolder !== f) {
                    this.reorderFolders(draggedFolder, f);
                    return;
                }

                // Else moving song
                const songId = e.dataTransfer.getData('text/plain');
                if (songId) UI.moveSongToFolder(songId, f);
            };

            // Context Menu
            div.oncontextmenu = (e) => {
                e.preventDefault();
                this.showContextMenu(e, f);
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

    // --- Folder Operations ---
    async createFolder() {
        const name = prompt("Enter new folder name:");
        if (name && !State.folders.includes(name)) {
            State.folders.push(name);
            await FS.saveVault();
            this.render();
            this.showToast(`Folder '${name}' created.`);
        } else if (name && State.folders.includes(name)) {
            this.showToast("Folder already exists.");
        }
    },

    async reorderFolders(src, dest) {
        const oldIdx = State.folders.indexOf(src);
        const newIdx = State.folders.indexOf(dest);
        if (oldIdx > -1 && newIdx > -1) {
            State.folders.splice(oldIdx, 1);
            State.folders.splice(newIdx, 0, src);
            await FS.saveVault();
            this.render();
            this.showToast(`Folder '${src}' reordered.`);
        }
    },

    showContextMenu(e, folder) {
        const menu = $('#ctx-menu');
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;
        menu.classList.remove('hidden');

        // Handlers
        $('#ctx-rename').onclick = async () => {
            menu.classList.add('hidden');
            const newName = prompt("Rename folder:", folder);
            if (newName && newName !== folder && !State.folders.includes(newName)) {
                // Update folder list
                const idx = State.folders.indexOf(folder);
                State.folders[idx] = newName;
                // Update songs
                State.songs.forEach(s => {
                    if (s.folder === folder) s.folder = newName;
                });

                // If viewing this folder, update view
                if (State.currentView === folder) {
                    State.currentView = newName;
                    $('#current-view-name').textContent = newName;
                }

                await FS.saveVault();
                this.render();
                this.showToast("Folder renamed.");
            } else if (newName && newName === folder) {
                this.showToast("Folder name is the same.");
            } else if (newName && State.folders.includes(newName)) {
                this.showToast("Folder with that name already exists.");
            }
        };

        $('#ctx-delete').onclick = async () => {
            menu.classList.add('hidden');
            if (folder === 'Unsorted') {
                alert("Cannot delete 'Unsorted' folder.");
                return;
            }
            if (confirm(`Delete folder "${folder}"? Assets will be moved to Unsorted.`)) {
                // Move songs
                State.songs.forEach(s => {
                    if (s.folder === folder) s.folder = "Unsorted";
                });
                // Remove folder
                State.folders = State.folders.filter(x => x !== folder);

                // Reset view if needed
                if (State.currentView === folder) {
                    State.currentView = 'Unsorted';
                    $('#current-view-name').textContent = 'Unsorted';
                }

                await FS.saveVault();
                this.render();
                this.showToast("Folder deleted.");
            }
        };

        // Hide on click elsewhere
        const closer = () => {
            menu.classList.add('hidden');
            window.removeEventListener('click', closer);
        };
        setTimeout(() => window.addEventListener('click', closer), 10);
    },
    // -------------------------

    renderGrid() {
        const grid = $('#asset-grid');
        grid.innerHTML = '';

        const filtered = State.songs.filter(s => {
            if (State.currentView !== 'all' && s.folder !== State.currentView) return false;
            if (State.searchTerm) {
                const q = State.searchTerm.toLowerCase();
                return s.title.toLowerCase().includes(q) || s.persona.toLowerCase().includes(q) || s.tags.some(t => t.toLowerCase().includes(q));
            }
            return true;
        });

        filtered.forEach(s => {
            const el = document.createElement('div');
            el.draggable = true;
            el.ondragstart = (e) => {
                e.dataTransfer.setData('text/plain', s.id);
                e.dataTransfer.effectAllowed = 'move';
            };

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
                <div class="flex flex-wrap gap-2 mt-auto text-[9px] font-black text-zinc-400 uppercase tracking-wider pointer-events-none">
                     <span class="px-3 py-1 bg-zinc-50 rounded-lg border border-zinc-100">${s.meta.bpm || '---'} BPM</span>
                     <span class="px-3 py-1 bg-zinc-50 rounded-lg border border-zinc-100">${s.meta.key || '---'}</span>
                </div>
            `;
            grid.appendChild(el);
        });
    },

    moveSongToFolder(id, folder) {
        const s = State.songs.find(x => x.id === id);
        if (s && s.folder !== folder) {
            s.folder = folder;
            FS.saveVault();
            this.render();
            this.showToast(`Moved to ${folder}`);
        }
    },

    async openModal(id) {
        const s = State.songs.find(x => x.id === id);
        if (!s) return;

        State.playingMetadata = s;
        State.isEditing = false; // Reset edit state
        $('#asset-modal').classList.remove('hidden');

        // 1. Sidebar Info - Cover
        // 1. Sidebar Info - Cover
        const coverCont = $('#modal-cover-container');
        coverCont.className = `w-72 h-72 rounded-[4.5rem] bg-zinc-200 shadow-2xl flex items-center justify-center relative overflow-hidden shrink-0 group cursor-pointer`;
        coverCont.onclick = () => {
            if (State.isEditing) UI.handleChangeCover();
        };

        const renderCover = () => {
            if (s.coverUrl) {
                coverCont.innerHTML = `
                    <img src="${s.coverUrl}" class="w-full h-full object-cover transition-opacity ${State.isEditing ? 'opacity-50' : ''}">
                    ${State.isEditing ? `<div class="absolute inset-0 flex items-center justify-center"><i data-lucide="upload" class="w-12 h-12 text-zinc-900"></i></div>` : ''}
                `;
            } else {
                coverCont.innerHTML = `
                    <i data-lucide="music" class="w-24 h-24 text-zinc-400 opacity-20"></i>
                     ${State.isEditing ? `<div class="absolute inset-0 flex items-center justify-center bg-black/10"><i data-lucide="upload" class="w-12 h-12 text-zinc-500"></i></div>` : ''}
                `;
            }
            lucide.createIcons();
        };
        renderCover();

        // Pass renderCover to be callable from toggleEditMode if we want dynamic update? 
        // Actually toggleEditMode re-renders content, but cover is outside content area.
        // Let's attach renderCover to UI instance or re-call openModal logic? 
        // Better: Make updateModalCover function.
        this.updateModalCover = renderCover;

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
            // Check if we are already playing this song (e.g. from playlist)
            if (State.playingId !== s.id) {
                // New song selection from Modal: Backup context
                State.lastContext = {
                    playlist: [...State.playlist],
                    index: State.playlistIndex,
                    id: State.playingId,
                    wasPlaying: !AudioEngine.el.paused
                };

                // Clear playlist context locally for this modal session
                State.playlist = [];
                State.playlistIndex = -1;

                const file = await s.handle.getFile();
                const url = URL.createObjectURL(file);
                AudioEngine.el.src = url;

                // Reset Main Play Button (since new source is paused)
                AudioEngine.updateButtonState(false);

                // Safe re-attach listener
                const mBtn = $('#play-pause-btn');
                if (mBtn) mBtn.onclick = () => AudioEngine.toggle();

            } else {
                // Already playing this song (e.g. opened modal while playlist running)
                // Just sync button state
                AudioEngine.updateButtonState(!AudioEngine.el.paused);

                // Safe re-attach listener
                const mBtn = $('#play-pause-btn');
                if (mBtn) mBtn.onclick = () => AudioEngine.toggle();
            }
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
            if (this.updateModalCover) this.updateModalCover(); // Update Cover UI
        } else {
            // Save Changes
            this.saveMetadata();
        }
    },

    async handleChangeCover() {
        try {
            const [fileHandle] = await window.showOpenFilePicker({
                types: [{
                    description: 'Images',
                    accept: { 'image/*': ['.png', '.gif', '.jpeg', '.jpg', '.webp'] }
                }]
            });
            const file = await fileHandle.getFile();

            // Save to Vault
            const saved = await FS.saveCover(file, State.playingMetadata.id);
            if (saved) {
                // For now, use object URL for immediate display
                // Real persistence relies on reading 'covers' folder on load. 
                // But for "Local Vault" just creating a URL from the saved file handle or file is fine.
                // We should store referencing logic.
                // For this session: 
                const url = URL.createObjectURL(file);
                State.playingMetadata.coverUrl = url;
                State.playingMetadata.coverPath = 'covers/' + saved.filename;

                // Update UI
                this.updateModalCover();
                this.showToast("Cover updated!");
            }
        } catch (e) {
            console.log("Cover change cancelled", e);
        }
    },

    async saveMetadata() {
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

        this.showToast("Saving & Writing to MP3...");

        // Write ID3
        let coverBlob = null;
        if (s.coverUrl) {
            try {
                const r = await fetch(s.coverUrl);
                coverBlob = await r.blob();
            } catch (e) { console.warn("Failed to fetch cover for ID3", e); }
        }
        await FS.writeID3(s, coverBlob);

        // Save Vault JSON
        await FS.saveVault();

        State.isEditing = false;
        this.updateEditButtonUI();
        this.renderModalContent(); // Re-render read-only
        if (this.updateModalCover) this.updateModalCover(); // Refresh Cover (remove overlay)
        this.render(); // Update grid (in case title/folder changed)
        this.showToast("Metadata & MP3 Saved!");
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

    async closeModal() {
        AudioEngine.el.pause();
        $('#asset-modal').classList.add('hidden');
        State.playingMetadata = null; // Clear context
        State.isEditing = false;

        // Restore Context if we interrupted something
        if (State.lastContext) {
            State.playlist = State.lastContext.playlist;
            State.playlistIndex = State.lastContext.index;

            const oldId = State.lastContext.id;
            const oldSong = State.songs.find(x => x.id === oldId);

            if (oldSong) {
                // Restore Audio Source
                try {
                    const file = await oldSong.handle.getFile();
                    AudioEngine.el.src = URL.createObjectURL(file);
                    // Don't auto-resume, just be ready. 
                    // Or if user wants seamless return? 
                    // User said: "Entire playback should not be playing report's song".
                    // Implies stopping Report song is key.
                    // Restoring source means Footer matches Audio.
                    State.playingId = oldId;
                    UI.updateFooter(oldSong);
                    AudioEngine.updateButtonState(false); // Paused
                } catch (e) { console.error("Failed to restore context", e); }
            } else {
                // If no old song, just reset UI?
                UI.updateFooter(null);
            }
            State.lastContext = null;
        }
    }
};

// --- Events ---
$('#btn-open-vault').onclick = () => FS.openVault();
$('#btn-refresh').onclick = () => FS.scanVault(true);
$('#btn-add-folder').onclick = () => UI.createFolder();
$('#btn-play-folder').onclick = () => AudioEngine.playFolder(State.currentView);
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

// Privacy Policy
$('#link-privacy').onclick = (e) => {
    e.preventDefault();
    alert("Privacy Policy:\n\nSuno Local Vault is a generic local-first application.\nAll data (music, metadata, vault.json) is stored exclusively on your local device.\nNo data is transmitted to any external servers.");
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
