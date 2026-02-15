// puzzle.js
let tiles = []; // [0, 1, 2, 3, 4, 5, 6, 7, 8] where 8 is empty
let correctOrder = [0, 1, 2, 3, 4, 5, 6, 7, 8];
let currentPhoto = "";

// Example list - you will populate this with your actual assets
const scrapbookFiles = [
    '1997-02-20-brighton-centre.jpg',
    // add more filenames here
];

export const initPuzzle = () => {
    const arena = document.getElementById('game-arena');

    // 1. Pick random photo
    currentPhoto = scrapbookFiles[Math.floor(Math.random() * scrapbookFiles.length)];

    // 2. Extract Info for Title
    const parts = currentPhoto.replace('.jpg', '').split('-');
    const dateStr = `${parts[0]}-${parts[1]}-${parts[2]}`;
    const venueSlug = parts.slice(3).join(' '); // "brighton centre"

    // 3. Setup UI
    arena.innerHTML = `
        <div class="flex flex-col h-full w-full">
            <div class="text-center mb-4">
                <p class="text-[10px] font-bold text-amber-400 uppercase tracking-widest">Sliding Puzzle</p>
                <h3 id="puzzle-title" class="text-xl font-black text-white italic uppercase">${venueSlug} (${parts[0]})</h3>
            </div>

            <div id="puzzle-grid" class="grid grid-cols-3 gap-1 w-full aspect-square max-w-[400px] mx-auto bg-slate-800 border-2 border-white/10 rounded-xl overflow-hidden">
                </div>

            <button onclick="window.initPuzzle()" class="mt-6 text-slate-400 text-[10px] font-bold uppercase tracking-widest hover:text-white transition-colors">
                Skip / New Photo
            </button>
        </div>
    `;

    renderTiles();
};

const renderTiles = () => {
    const grid = document.getElementById('puzzle-grid');
    grid.innerHTML = '';

    // For now, let's just show the logic of a 3x3 grid
    // Tiles will be 33.33% wide/high
    correctOrder.forEach((pos) => {
        const tile = document.createElement('div');
        tile.className = "relative w-full h-full bg-cover bg-no-repeat cursor-pointer border border-black/20";
        tile.style.backgroundImage = `url('assets/scrapbook/${currentPhoto}')`;

        // Calculate background position
        const row = Math.floor(pos / 3);
        const col = pos % 3;
        tile.style.backgroundPosition = `${col * 50}% ${row * 50}%`;
        tile.style.backgroundSize = "300% 300%";

        grid.appendChild(tile);
    });
};

window.initPuzzle = initPuzzle;