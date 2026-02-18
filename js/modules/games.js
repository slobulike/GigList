// js/modules/games.js
import { GigPuzzle } from './puzzle.js';

export const switchGame = (gameType) => {
    const quizSection = document.getElementById('quiz-container');
    const puzzleSection = document.getElementById('puzzle-section');
    const navQuiz = document.getElementById('nav-quiz');
    const navPuzzle = document.getElementById('nav-puzzle');

    if (gameType === 'quiz') {
        quizSection.classList.remove('hidden');
        puzzleSection.classList.add('hidden');

        // Active Styles
        navQuiz.className = "px-3 py-1 text-[10px] font-black uppercase rounded-full bg-white shadow-sm text-indigo-600";
        navPuzzle.className = "px-3 py-1 text-[10px] font-black uppercase rounded-full text-slate-500 hover:text-slate-700";
    } else {
        quizSection.classList.add('hidden');
        puzzleSection.classList.remove('hidden');

        // Active Styles
        navPuzzle.className = "px-3 py-1 text-[10px] font-black uppercase rounded-full bg-white shadow-sm text-indigo-600";
        navQuiz.className = "px-3 py-1 text-[10px] font-black uppercase rounded-full text-slate-500 hover:text-slate-700";

        // Auto-start if empty
        const grid = document.getElementById('puzzle-grid');
        if (grid && !grid.hasChildNodes()) {
            window.startNewPuzzle();
        }
    }
};

export const startNewPuzzle = async () => {
    const data = window.journalData;
    if (!data || data.length === 0) return;

    // 1. Pick a random gig from the CURRENT user's journal
    const randomGig = data[Math.floor(Math.random() * data.length)];

    // 2. Format the Scrapbook Path: yyyy-mm-dd-venue.jpg
    const [d, m, y] = randomGig.Date.split('/');
    const formattedDate = `${y}-${m}-${d}`;
    const cleanVenue = randomGig.OfficialVenue
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-');

    const scrapbookPath = `assets/scrapbook/${formattedDate}-${cleanVenue}.jpg`;

    // 3. Define the Fallback: artist_name_stock_photo.jpg
    const cleanArtist = randomGig.Band.toLowerCase().replace(/\s+/g, '_');
    const fallbackPath = `assets/artists/${cleanArtist}_stock_photo.jpg`;

    // 4. Verify which image exists
    const imageToUse = await determineImagePath(scrapbookPath, fallbackPath);

    console.log(`🧩 Puzzle assigned: ${imageToUse}`);

    try {
        new GigPuzzle('puzzle-grid', imageToUse);
    } catch (e) {
        console.error("Puzzle failed to initialize", e);
    }
};

// Helper to check if a file exists before trying to load it in the puzzle
async function determineImagePath(primary, fallback) {
    try {
        const response = await fetch(primary, { method: 'HEAD' });
        if (response.ok) return primary;

        // If primary fails, check fallback
        const fallbackResponse = await fetch(fallback, { method: 'HEAD' });
        return fallbackResponse.ok ? fallback : 'assets/default-gig-photo.jpg';
    } catch (e) {
        return fallback; // Default to fallback on network error
    }
}