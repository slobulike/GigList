// puzzle.js
export class GigPuzzle {
    constructor(containerId, imageUrl, gridSize = 4) {
        this.container = document.getElementById(containerId);
        this.imageUrl = imageUrl;
        this.size = gridSize; // 4x4
        this.tiles = []; // Flat array of [0, 1, 2... 15]
        this.emptyIndex = (gridSize * gridSize) - 1;
        this.init();
    }


    init() {
        // Create solved array
        this.tiles = Array.from({ length: this.size * this.size }, (_, i) => i);
        this.shuffle();
        this.render();
    }

    shuffle() {
        // Shuffle by making 200 valid moves from the solved state
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

        if (row > 0) neighbors.push(index - this.size); // Top
        if (row < this.size - 1) neighbors.push(index + this.size); // Bottom
        if (col > 0) neighbors.push(index - 1); // Left
        if (col < this.size - 1) neighbors.push(index + 1); // Right
        return neighbors;
    }

    swap(i, j) {
        [this.tiles[i], this.tiles[j]] = [this.tiles[j], this.tiles[i]];
    }

    handleTileClick(index) {
        const neighbors = this.getNeighbors(index);
        if (neighbors.includes(this.emptyIndex)) {
            this.swap(index, this.emptyIndex);
            this.emptyIndex = index;
            this.render();
            this.checkWin();
        }
    }

    checkWin() {
        const isWin = this.tiles.every((tile, i) => tile === i);
        if (isWin) {
            setTimeout(() => alert("🎉 Memory Restored! Gig Puzzle Solved!"), 200);
        }
    }

    render() {
        this.container.innerHTML = '';
        this.container.style.gridTemplateColumns = `repeat(${this.size}, 1fr)`;

        this.tiles.forEach((tileValue, currentIndex) => {
            const tile = document.createElement('div');
            tile.className = 'relative aspect-square border border-white/10 cursor-pointer overflow-hidden rounded-sm';

            if (tileValue === (this.size * this.size) - 1) {
                    tile.classList.add('bg-slate-800/50'); // Empty slot
                } else {
                    // 1. Calculate the original position of this tile in the 4x4 grid
                    const row = Math.floor(tileValue / this.size);
                    const col = tileValue % this.size;

                    // 2. The key math: Percentage must be (coord / (size - 1)) * 100
                    const multiplier = 100 / (this.size - 1);
                    const posX = col * multiplier;
                    const posY = row * multiplier;

                    tile.style.backgroundImage = `url(${this.imageUrl})`;
                    tile.style.backgroundSize = `${this.size * 100}%`; // 400% for a 4x4
                    tile.style.backgroundPosition = `${posX}% ${posY}%`;

                    tile.onclick = () => this.handleTileClick(currentIndex);
                }
                this.container.appendChild(tile);
            });
    }
}