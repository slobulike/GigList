let puzzleState = []; // Current arrangement of indices
const size = 3; // 3x3 grid
let emptyIndex = 8; // The 9th slot (index 8) is empty

const scrapbookFiles = [
    '1997-08-28-hylands-park.jpg',
    '2013-01-19-barfly.jpg',
    '2014-02-07-Koko.jpg'
];

export const initPuzzle = () => {
    // 1. Pick photo and setup state
    currentPhoto = scrapbookFiles[Math.floor(Math.random() * scrapbookFiles.length)];
    puzzleState = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    emptyIndex = 8;

    shufflePuzzle();
    renderPuzzleUI();
};

const shufflePuzzle = () => {
    // We do random valid moves instead of a random shuffle to ensure it's solvable
    for (let i = 0; i < 100; i++) {
        const neighbors = getNeighbors(emptyIndex);
        const move = neighbors[Math.floor(Math.random() * neighbors.length)];
        swap(move);
    }
};

const getNeighbors = (idx) => {
    const neighbors = [];
    const r = Math.floor(idx / size), c = idx % size;
    if (r > 0) neighbors.push(idx - size); // Top
    if (r < size - 1) neighbors.push(idx + size); // Bottom
    if (c > 0) neighbors.push(idx - 1); // Left
    if (c < size - 1) neighbors.push(idx + 1); // Right
    return neighbors;
};

const swap = (idx) => {
    [puzzleState[emptyIndex], puzzleState[idx]] = [puzzleState[idx], puzzleState[emptyIndex]];
    emptyIndex = idx;
};

window.handleTileClick = (idx) => {
    const neighbors = getNeighbors(emptyIndex);
    if (neighbors.includes(idx)) {
        swap(idx);
        renderPuzzleUI();
        checkWin();
    }
};

const checkWin = () => {
    if (puzzleState.every((val, i) => val === i)) {
        alert("Gig Photorealism Restored! You win!");
    }
};