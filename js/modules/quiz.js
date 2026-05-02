// quiz.js
import { parseDate } from './utils.js';

const QUESTION_POOL_SIZE = 25; // Pre-generate more than you'll ever see in 30s

let score                = 0;
let timeLeft             = 30;
let timerInterval        = null;
let questionPool         = []; // Pre-built list of { questionText, options, correctAnswer, journalKey }
let questionIndex        = 0;
let missedQuestions      = []; // { questionText, correctAnswer, journalKey } for wrong answers

export const initQuiz = () => {
    const data = window.filteredResults || window.journalData;
    if (!data || data.length < 5) {
        alert("You need at least 5 gigs to play!");
        return;
    }

    score         = 0;
    timeLeft      = 30;
    questionIndex = 0;
    missedQuestions = [];
    questionPool  = buildQuestionPool(data, QUESTION_POOL_SIZE);

    if (questionPool.length === 0) {
        alert("Couldn't generate any questions from your gig data!");
        return;
    }

    const scoreEl = document.getElementById('quiz-score');
    const timerEl = document.getElementById('quiz-timer');
    if (scoreEl) scoreEl.textContent = `SCORE: ${score}`;
    if (timerEl) timerEl.textContent = `00:${timeLeft}`;

    startTimer();
    nextQuestion();
};

/**
 * Builds a shuffled pool of unique questions up to `limit`.
 * Uniqueness is enforced by a `gig_key + type` signature — same gig can't
 * appear twice with the same question type, but can appear in different types.
 */
function buildQuestionPool(data, limit) {
    const isBand   = window.isBandMode;
    const bandName = window.bandName;

    const candidates = [...data]
        .filter(g => g.Date && g.OfficialVenue && parseDate(g.Date) && !isNaN(parseDate(g.Date).getTime()))
        .sort(() => Math.random() - 0.5);

    const pool = [];
    const seen = new Set();

    // Type 3 is a global question (same answer regardless of gig) — generate once
    const globalQ = buildQuestion(3, candidates[0], parseDate(candidates[0].Date), data, isBand, bandName);
    if (globalQ) {
        seen.add('global|3');
        pool.push(globalQ);
    }

    // Types 0-2 are gig-specific — iterate candidates
    for (const gig of candidates) {
        if (pool.length >= limit) break;

        const validDate = parseDate(gig.Date);
        const gigKey    = gig['Journal Key'] || gig.Date + gig.Band;

        const types = [0, 1, 2].sort(() => Math.random() - 0.5);

        for (const type of types) {
            if (pool.length >= limit) break;

            const sig = `${gigKey}|${type}`;
            if (seen.has(sig)) continue;

            const q = buildQuestion(type, gig, validDate, data, isBand, bandName);
            if (!q) continue;

            seen.add(sig);
            pool.push(q);
        }
    }

    return pool.sort(() => Math.random() - 0.5);
}

/**
 * Builds a single question object for a given type and gig.
 * Returns null if the question can't be constructed (e.g. missing data).
 */
function buildQuestion(type, gig, validDate, data, isBand, bandName) {
    let questionText = '';
    let correctAnswer = '';
    let options = [];

    const displayBand = isBand ? (bandName || gig.Band || 'the band') : gig.Band;

    if (type === 0) {
        // VENUE QUESTION
        const monthName = validDate.toLocaleString('default', { month: 'long' });
        const year      = validDate.getFullYear();
        questionText  = isBand
            ? `Where did ${displayBand} perform in ${monthName} ${year}?`
            : `Where did you see ${gig.Band} in ${monthName} ${year}?`;
        correctAnswer = gig.OfficialVenue;
        options = [...new Set(data.map(g => g.OfficialVenue))]
            .filter(v => v && v !== correctAnswer);

    } else if (type === 1) {
        // YEAR QUESTION
        questionText  = isBand
            ? `In what year did ${displayBand} play at ${gig.OfficialVenue}?`
            : `In what year did you see ${gig.Band} at ${gig.OfficialVenue}?`;
        correctAnswer = validDate.getFullYear().toString();
        options = [...new Set(data.map(g => {
            const d = parseDate(g.Date);
            return d ? d.getFullYear().toString() : null;
        }))].filter(y => y && y !== correctAnswer);

    } else if (type === 2) {
        // FREQUENCY QUESTION
        const isVenueQ = Math.random() > 0.5;
        if (isVenueQ) {
            questionText  = isBand
                ? `How many times have ${displayBand} played at ${gig.OfficialVenue}?`
                : `How many times have you been to ${gig.OfficialVenue}?`;
            correctAnswer = data.filter(g => g.OfficialVenue === gig.OfficialVenue).length.toString();
        } else {
            questionText  = isBand
                ? `How many unique songs have ${displayBand} played?`
                : `How many times have you seen ${gig.Band} live?`;
            correctAnswer = isBand
                ? (window.uniqueSongCount || 0).toString()
                : data.filter(g => g.Band === gig.Band).length.toString();
        }
        const c = parseInt(correctAnswer);
        options = [c + 1, c + 5, Math.max(1, c - 2), c + 10, Math.floor(c * 1.5)]
            .map(n => n.toString())
            .filter(n => n !== correctAnswer);

    } else {
        // FIRST PERFORMANCE QUESTION
        if (isBand) {
            questionText = `In what year did ${displayBand} first perform at ${gig.OfficialVenue}?`;
            const venueGigs = data
                .filter(g => g.OfficialVenue === gig.OfficialVenue)
                .sort((a, b) => parseDate(a.Date) - parseDate(b.Date));
            if (venueGigs.length === 0) return null;
            correctAnswer = parseDate(venueGigs[0].Date).getFullYear().toString();
            options = ["1994","2001","2010","1996","2024"].filter(y => y !== correctAnswer);
        } else {
            questionText = `Which band was the first one you logged in this journal?`;
            const sorted = [...data].sort((a, b) => parseDate(a.Date) - parseDate(b.Date));
            if (sorted.length === 0) return null;
            correctAnswer = sorted[0].Band;
            options = [...new Set(data.map(g => g.Band))].filter(b => b && b !== correctAnswer);
        }
    }

    // Need at least 3 distractors to build 4 options
    if (!correctAnswer || options.length < 1) return null;

    options = options.sort(() => 0.5 - Math.random()).slice(0, 3);
    while (options.length < 3) {
        options.push(isBand ? "2012" : "Unknown Venue");
    }

    options.push(correctAnswer);
    const finalOptions = [...new Set(options)].sort(() => 0.5 - Math.random()).slice(0, 4);

    return { questionText, options: finalOptions, correctAnswer, journalKey: gig?.['Journal Key'] || null };
}

const startTimer = () => {
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        timeLeft--;
        const timerEl = document.getElementById('quiz-timer');
        if (timerEl) timerEl.textContent = `00:${timeLeft < 10 ? '0' + timeLeft : timeLeft}`;
        if (timeLeft <= 0) endGame();
    }, 1000);
};

const nextQuestion = () => {
    if (questionIndex >= questionPool.length) return endGame();

    const q = questionPool[questionIndex++];
    renderQuestion(q.questionText, q.options);
};

const renderQuestion = (question, options) => {
    const body = document.getElementById('quiz-body');
    if (!body) return;

    body.innerHTML = `
        <div id="question-container" class="mb-8" role="status" aria-live="polite">
            <p class="text-2xl md:text-4xl font-black text-white italic uppercase tracking-tighter leading-tight">${question}</p>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 w-full" role="group" aria-label="Answer options">
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
    const arena   = document.getElementById('game-arena');
    const scoreEl = document.getElementById('quiz-score');

    const current = questionPool[questionIndex - 1];

    if (selected === current?.correctAnswer) {
        score += 10;
        if (scoreEl) scoreEl.textContent = `SCORE: ${score}`;
        arena?.classList.add('bg-green-600/40');
        setTimeout(() => arena?.classList.remove('bg-green-600/40'), 300);
    } else {
        timeLeft = Math.max(0, timeLeft - 3);
        arena?.classList.add('bg-red-600/40');
        setTimeout(() => arena?.classList.remove('bg-red-600/40'), 300);
        if (current) {
            missedQuestions.push({
                questionText:  current.questionText,
                correctAnswer: current.correctAnswer,
                journalKey:    current.journalKey || null,
            });
        }
    }
    nextQuestion();
};

const endGame = async () => {
    clearInterval(timerInterval);

    const isBand       = window.isBandMode;
    const highScoreKey = isBand ? `hi_${window.bandName}` : 'giglist_quiz_hi';
    const localBest    = parseInt(localStorage.getItem(highScoreKey) || '0', 10);
    const newBest      = score > localBest;

    if (newBest) localStorage.setItem(highScoreKey, score);

    if (!isBand) {
        await _saveQuizScore(score);
    }

    const body = document.getElementById('quiz-body');
    if (!body) return;

    const missedHtml = missedQuestions.length > 0 ? `
        <div class="w-full mt-6 text-left">
            <p class="text-[9px] font-black uppercase tracking-widest text-white/40 mb-3">You missed these</p>
            <div class="space-y-2">
                ${missedQuestions.map(m => `
                    <div class="bg-white/10 rounded-2xl px-4 py-3 space-y-1">
                        <p class="text-[10px] font-bold text-white/50 leading-snug">${m.questionText}</p>
                        <div class="flex items-center justify-between gap-3">
                            <p class="text-sm font-black text-white">${m.correctAnswer}</p>
                            ${m.journalKey ? `
                            <button onclick="document.getElementById('feed-game-modal')?.remove(); window.viewGigDetails('${m.journalKey.replace(/'/g, "\\'")}')"
                                    class="flex-shrink-0 text-[9px] font-black uppercase tracking-widest text-indigo-400 hover:text-indigo-300 transition-colors">
                                View gig →
                            </button>` : ''}
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>` : '';

    body.innerHTML = `
        <div class="flex flex-col items-center w-full py-6">
            <h3 class="text-6xl font-black text-white italic uppercase mb-4">FINISH!</h3>
            <p class="text-3xl text-white font-bold mb-2">SCORE: ${score}</p>
            <p class="text-white/60 font-bold uppercase mb-6">${newBest ? '⭐ NEW RECORD! ⭐' : `Best: ${localBest}`}</p>
            <button onclick="window.initQuiz()"
                    class="bg-white text-blue-600 px-10 py-5 rounded-full font-black uppercase tracking-widest hover:scale-105 transition-all shadow-xl">
                Try Again
            </button>
            ${missedHtml}
        </div>
    `;
};

async function _saveQuizScore(finalScore) {
    const userId = window.currentUser?.id;
    if (!userId) return;
    try {
        const { supabase } = await import('./supabase.js');

        const { data: existing } = await supabase
            .from('quiz_scores')
            .select('total_played, best_score')
            .eq('user_id', userId)
            .single();

        const newTotal = (existing?.total_played || 0) + 1;
        const prevBest = existing?.best_score ?? null;
        const newBest  = prevBest !== null ? Math.max(prevBest, finalScore) : finalScore;

        await supabase.from('quiz_scores').upsert({
            user_id:      userId,
            total_played: newTotal,
            best_score:   newBest,
            updated_at:   new Date().toISOString()
        }, { onConflict: 'user_id' });
    } catch (e) {
        console.debug('quiz score save:', e);
    }
}

window.initQuiz  = initQuiz;
window.startQuiz = initQuiz;