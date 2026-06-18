// js/modules/games.js
import { GigPuzzle } from './puzzle.js';

// Difficulty -> grid size mapping. Session-only (resets on page reload).
const DIFFICULTY_GRID_SIZES = { easy: 3, medium: 4, hard: 5 };
let currentDifficulty = 'medium';
let currentImage      = null; // remembers the active puzzle image across difficulty changes

const setActiveDifficultyButtons = (level) => {
    Object.keys(DIFFICULTY_GRID_SIZES).forEach(key => {
        const btn = document.getElementById(`puzzle-difficulty-${key}`);
        if (!btn) return;
        btn.classList.toggle('bg-indigo-500', key === level);
        btn.classList.toggle('text-white', key === level);
        btn.classList.toggle('text-slate-400', key !== level);
    });
};

export const setPuzzleDifficulty = (level) => {
    if (!DIFFICULTY_GRID_SIZES[level]) return;
    currentDifficulty = level;
    setActiveDifficultyButtons(level);

    // Rebuild with the SAME image at the new grid size, if we have one.
    // Falls back to picking a fresh image/gig if none is set yet.
    if (currentImage) {
        buildPuzzle(currentImage);
    } else {
        startNewPuzzle();
    }
};

// Builds (or rebuilds) the puzzle grid for a given image at the current difficulty.
const buildPuzzle = (imageUrl) => {
    currentImage = imageUrl;
    const gridSize = DIFFICULTY_GRID_SIZES[currentDifficulty] || 4;

    try {
        new GigPuzzle('puzzle-grid', imageUrl, gridSize);
    } catch (e) {
        console.error("Puzzle failed to initialize:", e);
    }
};

// Call this when the puzzle modal/session opens fresh, so the next
// startNewPuzzle() picks a brand-new image rather than reusing the last one.
export const resetPuzzleImage = () => {
    currentImage = null;
};

export const switchGame = (gameType) => {
    const quizSection   = document.getElementById('quiz-container');
    const puzzleSection = document.getElementById('puzzle-section');
    const navQuiz       = document.getElementById('nav-quiz');
    const navPuzzle     = document.getElementById('nav-puzzle');

    // Guard against missing DOM elements
    if (!quizSection || !puzzleSection || !navQuiz || !navPuzzle) return;

    const activeClass   = "px-3 py-1 text-[10px] font-black uppercase rounded-full bg-white shadow-sm text-indigo-600";
    const inactiveClass = "px-3 py-1 text-[10px] font-black uppercase rounded-full text-slate-500 hover:text-slate-700";

    if (gameType === 'quiz') {
        quizSection.classList.remove('hidden');
        puzzleSection.classList.add('hidden');
        navQuiz.className   = activeClass;
        navPuzzle.className = inactiveClass;
    } else {
        quizSection.classList.add('hidden');
        puzzleSection.classList.remove('hidden');
        navPuzzle.className = activeClass;
        navQuiz.className   = inactiveClass;

        // Auto-start if the grid is empty
        const grid = document.getElementById('puzzle-grid');
        if (grid && !grid.hasChildNodes()) {
            window.startNewPuzzle();
        }
    }
};

export const startNewPuzzle = async () => {
    const data = window.journalData;
    if (!data || data.length === 0) return;

    // Pick a random gig, guarding against missing fields
    const candidates = data.filter(g => g.Date && g.OfficialVenue && g.Band);
    if (candidates.length === 0) return;

    const randomGig = candidates[Math.floor(Math.random() * candidates.length)];

    // Build scrapbook path: assets/scrapbook/yyyy-mm-dd-venue-slug.jpg
    const [d, m, y]   = randomGig.Date.split('/');
    const formattedDate = `${y}-${m}-${d}`;
    const cleanVenue    = randomGig.OfficialVenue
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

    const scrapbookPath = `assets/scrapbook/${formattedDate}-${cleanVenue}.jpg`;

    // Fallback: artist stock photo
    const cleanArtist = randomGig.Band.toLowerCase().replace(/\s+/g, '_');
    const fallbackPath = `assets/artists/${cleanArtist}_stock_photo.jpg`;

    const imageToUse = await determineImagePath(scrapbookPath, fallbackPath);
    buildPuzzle(imageToUse);
};

// Expose globally so puzzle.js's win-screen "New Puzzle" button (which has no
// module import access) can trigger a fresh puzzle without relying on app.js wiring.
window.startNewPuzzle = startNewPuzzle;

// Guaranteed fallback — an Unsplash concert photo that is always available
const DEFAULT_PUZZLE_IMAGE = 'https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?auto=format&fit=crop&w=800&q=75';

// Probes image paths with HEAD requests to find the first one that exists
async function determineImagePath(primary, fallback) {
    try {
        const res = await fetch(primary, { method: 'HEAD' });
        if (res.ok) return primary;

        const fallbackRes = await fetch(fallback, { method: 'HEAD' });
        return fallbackRes.ok ? fallback : DEFAULT_PUZZLE_IMAGE;
    } catch {
        return DEFAULT_PUZZLE_IMAGE;
    }
}