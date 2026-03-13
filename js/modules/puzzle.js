// puzzle.js
export class GigPuzzle {
    constructor(containerId, imageUrl, gridSize = 4) {
        this.container = document.getElementById(containerId);
        this.imageUrl  = imageUrl;
        this.size      = gridSize;
        this.tiles     = [];
        this.emptyIndex = (gridSize * gridSize) - 1;

        // Guard against missing container before doing anything
        if (!this.container) {
            console.error(`GigPuzzle: container #${containerId} not found.`);
            return;
        }

        this.init();
    }

    init() {
        this.tiles = Array.from({ length: this.size * this.size }, (_, i) => i);
        this.shuffle();
        this.render();
    }

    shuffle() {
        // Shuffle via 200 valid moves from solved state — guarantees puzzle is always solvable
        for (let i = 0; i < 200; i++) {
            const neighbors = this.getNeighbors(this.emptyIndex);
            const move = neighbors[Math.floor(Math.random() * neighbors.length)];
            this.swap(this.emptyIndex, move);
            this.emptyIndex = move;
        }
    }

    getNeighbors(index) {
        const neighbors = [];
        const row = Math.floor(index / this.size);
        const col = index % this.size;

        if (row > 0)             neighbors.push(index - this.size); // up
        if (row < this.size - 1) neighbors.push(index + this.size); // down
        if (col > 0)             neighbors.push(index - 1);         // left
        if (col < this.size - 1) neighbors.push(index + 1);         // right

        return neighbors;
    }

    swap(i, j) {
        [this.tiles[i], this.tiles[j]] = [this.tiles[j], this.tiles[i]];
    }

    handleTileClick(index) {
        if (this.getNeighbors(index).includes(this.emptyIndex)) {
            this.swap(index, this.emptyIndex);
            this.emptyIndex = index;
            this.render();
            this.checkWin();
        }
    }

    checkWin() {
        if (this.tiles.every((tile, i) => tile === i)) {
            this.showWinMessage();
        }
    }

    showWinMessage() {
        // Replace the grid with an in-page win message rather than a blocking alert()
        this.container.innerHTML = `
            <div class="col-span-4 flex flex-col items-center justify-center h-full text-center p-6 gap-4">
                <p class="text-4xl">🎉</p>
                <p class="text-white font-black italic uppercase tracking-tighter text-xl">Memory Restored!</p>
                <p class="text-white/60 text-xs font-bold uppercase tracking-widest">Gig Puzzle Solved!</p>
                <button onclick="window.startNewPuzzle()"
                        class="mt-2 bg-indigo-500 hover:bg-indigo-600 text-white px-6 py-2 rounded-full font-black uppercase text-xs tracking-widest transition-all active:scale-95">
                    New Puzzle
                </button>
            </div>
        `;
    }

    render() {
        this.container.innerHTML = '';
        this.container.style.gridTemplateColumns = `repeat(${this.size}, 1fr)`;

        const emptyTileValue = (this.size * this.size) - 1;
        const multiplier     = 100 / (this.size - 1);

        this.tiles.forEach((tileValue, currentIndex) => {
            const tile = document.createElement('div');

            if (tileValue === emptyTileValue) {
                // Empty slot — not interactive
                tile.className = 'relative aspect-square border border-white/10 bg-slate-800/50 rounded-sm';
                tile.setAttribute('aria-hidden', 'true');
            } else {
                const row  = Math.floor(tileValue / this.size);
                const col  = tileValue % this.size;
                const posX = col * multiplier;
                const posY = row * multiplier;

                tile.className = 'relative aspect-square border border-white/10 cursor-pointer overflow-hidden rounded-sm hover:brightness-110 transition-all active:scale-95';
                tile.style.backgroundImage    = `url(${this.imageUrl})`;
                tile.style.backgroundSize     = `${this.size * 100}%`;
                tile.style.backgroundPosition = `${posX}% ${posY}%`;

                // Keyboard accessibility — tiles are interactive controls
                tile.setAttribute('role', 'button');
                tile.setAttribute('aria-label', `Puzzle tile ${tileValue + 1}`);
                tile.setAttribute('tabindex', '0');

                tile.onclick   = () => this.handleTileClick(currentIndex);
                tile.onkeydown = (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        this.handleTileClick(currentIndex);
                    }
                };
            }

            this.container.appendChild(tile);
        });
    }
}