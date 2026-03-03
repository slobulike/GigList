// quiz.js
import { parseDate } from './utils.js';

let score = 0;
let timeLeft = 30;
let timerInterval = null;
let currentCorrectAnswer = "";
let shuffledGigs = [];

export const initQuiz = () => {
    const data = window.filteredResults || window.journalData;
    if (!data || data.length < 5) {
        alert("You need at least 5 gigs to play!");
        return;
    }

    // Create the shuffled deck to avoid repeats
    shuffledGigs = [...data].sort(() => Math.random() - 0.5);

    score = 0;
    timeLeft = 30;
    const scoreEl = document.getElementById('quiz-score');
    const timerEl = document.getElementById('quiz-timer');
    if(scoreEl) scoreEl.textContent = `SCORE: ${score}`;
    if(timerEl) timerEl.textContent = `00:${timeLeft}`;

    startTimer();
    nextQuestion();
};

const startTimer = () => {
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        timeLeft--;
        const timerEl = document.getElementById('quiz-timer');
        if(timerEl) timerEl.textContent = `00:${timeLeft < 10 ? '0' + timeLeft : timeLeft}`;

        if (timeLeft <= 0) {
            endGame();
        }
    }, 1000);
};

const nextQuestion = () => {
    // 1. Check if we have gigs left in our shuffled deck
    if (shuffledGigs.length === 0) {
        return endGame();
    }

    // 2. Pull the next gig from the deck
    let randomGig = shuffledGigs.pop();
    let validDate = parseDate(randomGig.Date);

    // 3. Skip invalid data rows automatically
    if (!randomGig || !randomGig.OfficialVenue || !validDate || isNaN(validDate.getTime())) {
        return nextQuestion();
    }

    const data = window.filteredResults || window.journalData;
    const isBand = window.isBandMode;

    // DYNAMIC BAND NAME: Uses the global name, or the band from the specific gig, or a generic fallback
    const bandName = window.bandName || randomGig.Band || "the band";

    // 4. Determine Question Type (0-3)
    const type = Math.floor(Math.random() * 4);
    let questionText = "";
    let options = []; // Declare as let so it can be shuffled/reassigned

    if (type === 0) {
        // --- VENUE QUESTION ---
        const monthName = validDate.toLocaleString('default', { month: 'long' });
        const year = validDate.getFullYear();

        questionText = isBand
            ? `Where did ${bandName} perform in ${monthName} ${year}?`
            : `Where did you see ${randomGig.Band} in ${monthName} ${year}?`;

        currentCorrectAnswer = randomGig.OfficialVenue;
        options = [...new Set(data.map(g => g.OfficialVenue))].filter(v => v && v !== currentCorrectAnswer);
    }
    else if (type === 1) {
        // --- YEAR QUESTION ---
        questionText = isBand
            ? `In what year did ${bandName} play at ${randomGig.OfficialVenue}?`
            : `In what year did you see ${randomGig.Band} at ${randomGig.OfficialVenue}?`;

        currentCorrectAnswer = validDate.getFullYear().toString();
        options = [...new Set(data.map(g => {
            const d = parseDate(g.Date);
            return d ? d.getFullYear().toString() : null;
        }))].filter(y => y && y !== currentCorrectAnswer);
    }
    else if (type === 2) {
        // --- FREQUENCY QUESTION ---
        const isVenueQ = Math.random() > 0.5;
        if (isVenueQ) {
            questionText = isBand
                ? `How many times have ${bandName} played at ${randomGig.OfficialVenue}?`
                : `How many times have you been to ${randomGig.OfficialVenue}?`;
            currentCorrectAnswer = data.filter(g => g.OfficialVenue === randomGig.OfficialVenue).length.toString();
        } else {
            questionText = isBand
                ? `How many unique songs have ${bandName} played?`
                : `How many times have you seen ${randomGig.Band} live?`;

            if (isBand) {
                // Falls back to a reasonable number if the live count isn't ready
                currentCorrectAnswer = (window.uniqueSongCount || "329").toString();
            } else {
                currentCorrectAnswer = data.filter(g => g.Band === randomGig.Band).length.toString();
            }
        }

        const c = parseInt(currentCorrectAnswer);
        options = [c + 1, c + 5, Math.max(1, c - 2), c + 10, Math.floor(c * 1.5)]
            .map(n => n.toString())
            .filter(n => n !== currentCorrectAnswer);
    }
    else {
        // --- FIRST PERFORMANCE QUESTION ---
        if (isBand) {
            questionText = `In what year did ${bandName} first perform at ${randomGig.OfficialVenue}?`;
            const venueGigs = data.filter(g => g.OfficialVenue === randomGig.OfficialVenue);
            const sorted = venueGigs.sort((a,b) => parseDate(a.Date) - parseDate(b.Date));
            currentCorrectAnswer = parseDate(sorted[0].Date).getFullYear().toString();
        } else {
            questionText = `Which band was the first one you logged in this journal?`;
            const sorted = [...data].sort((a,b) => parseDate(a.Date) - parseDate(b.Date));
            currentCorrectAnswer = sorted[0].Band;
        }

        options = isBand
            ? ["1994", "2001", "2010", "1996", "2024"].filter(y => y !== currentCorrectAnswer)
            : [...new Set(data.map(g => g.Band))].filter(b => b !== currentCorrectAnswer);
    }

    // Shuffle and pick 3 distractors
    options = options.sort(() => 0.5 - Math.random()).slice(0, 3);

    // Final safety fill
    while (options.length < 3) {
        options.push(isBand ? "2012" : "Unknown Venue");
    }

    options.push(currentCorrectAnswer);
    const finalOptions = [...new Set(options)].sort(() => 0.5 - Math.random()).slice(0, 4);

    renderQuestion(questionText, finalOptions);
};

const renderQuestion = (question, options) => {
    const body = document.getElementById('quiz-body');
    if (!body) return;

    body.innerHTML = `
        <div id="question-container" class="mb-8">
            <p class="text-2xl md:text-4xl font-black text-white italic uppercase tracking-tighter leading-tight">${question}</p>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 w-full">
            ${options.map(opt => `
                <button onclick="window.checkAnswer('${opt.replace(/'/g, "\\'")}')"
                        class="bg-white/10 border-2 border-white/20 text-white p-6 rounded-2xl font-bold hover:bg-white/30 hover:border-white transition-all active:scale-95 text-xl">
                    ${opt}
                </button>
            `).join('')}
        </div>
    `;
};

window.checkAnswer = (selected) => {
    if (selected === currentCorrectAnswer) {
        score += 10;
        document.getElementById('quiz-score').textContent = `SCORE: ${score}`;
        document.getElementById('game-arena').classList.add('bg-green-600/40');
        setTimeout(() => document.getElementById('game-arena').classList.remove('bg-green-600/40'), 300);
        nextQuestion();
    } else {
        timeLeft = Math.max(0, timeLeft - 3);
        document.getElementById('game-arena').classList.add('bg-red-600/40');
        setTimeout(() => document.getElementById('game-arena').classList.remove('bg-red-600/40'), 300);
        nextQuestion();
    }
};

const endGame = () => {
    clearInterval(timerInterval);
    const highScoreKey = window.isBandMode ? `hi_${window.bandName}` : 'giglist_quiz_hi';
    const highScore = localStorage.getItem(highScoreKey) || 0;

    let newBest = false;
    if (score > highScore) {
        localStorage.setItem(highScoreKey, score);
        newBest = true;
    }

    const body = document.getElementById('quiz-body');
    body.innerHTML = `
        <div class="text-center py-10">
            <h3 class="text-6xl font-black text-white italic uppercase mb-4">FINISH!</h3>
            <p class="text-3xl text-white font-bold mb-2">SCORE: ${score}</p>
            <p class="text-white/60 font-bold uppercase mb-8">${newBest ? '⭐ NEW RECORD! ⭐' : `Best: ${highScore}`}</p>
            <button onclick="window.initQuiz()" class="bg-white text-blue-600 px-10 py-5 rounded-full font-black uppercase tracking-widest hover:scale-105 transition-all shadow-xl">
                Try Again
            </button>
        </div>
    `;
};

window.initQuiz = initQuiz;
window.startQuiz = initQuiz;