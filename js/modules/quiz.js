// quiz.js
let score = 0;
let timeLeft = 30;
let timerInterval = null;
let currentCorrectAnswer = "";

export const initQuiz = () => {
    const data = window.filteredResults || window.journalData;
    if (!data || data.length < 5) {
        alert("You need at least 5 gigs in your list to play!");
        return;
    }

    score = 0;
    timeLeft = 30;
    document.getElementById('quiz-score').textContent = `SCORE: ${score}`;
    document.getElementById('quiz-timer').textContent = `00:${timeLeft}`;

    startTimer();
    nextQuestion();
};

const startTimer = () => {
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        timeLeft--;
        document.getElementById('quiz-timer').textContent = `00:${timeLeft < 10 ? '0' + timeLeft : timeLeft}`;

        if (timeLeft <= 0) {
            endGame();
        }
    }, 1000);
};

const nextQuestion = () => {
    const data = window.filteredResults || window.journalData;

    const getSafeDate = (gig) => {
        if (!gig || !gig.Date) return null;
        const d = new Date(gig.Date);
        return isNaN(d.getTime()) ? null : d;
    };

    let randomGig = null;
    let validDate = null;
    let attempts = 0;

    while (attempts < 20) {
        const candidate = data[Math.floor(Math.random() * data.length)];
        validDate = getSafeDate(candidate);
        if (candidate && candidate.Band && candidate.OfficialVenue && validDate) {
            randomGig = candidate;
            break;
        }
        attempts++;
    }

    if (!randomGig) return endGame();

    // 0 = Venue, 1 = Year, 2 = Frequency
    const type = Math.floor(Math.random() * 3);
    let questionText = "";
    let options = [];

    if (type === 0) {
        const monthName = validDate.toLocaleString('default', { month: 'long' });
        questionText = `Where did you see ${randomGig.Band} in ${monthName} ${validDate.getFullYear()}?`;
        currentCorrectAnswer = randomGig.OfficialVenue;
        options = [...new Set(data.map(g => g.OfficialVenue))].filter(v => v && v !== currentCorrectAnswer);
    }
    else if (type === 1) {
        questionText = `In what year did you see ${randomGig.Band} at ${randomGig.OfficialVenue}?`;
        currentCorrectAnswer = validDate.getFullYear().toString();
        options = [...new Set(data.map(g => {
            const d = getSafeDate(g);
            return d ? d.getFullYear().toString() : null;
        }))].filter(y => y && y !== currentCorrectAnswer);
    }
    else {
        // NEW: Frequency Question
        const isVenueQ = Math.random() > 0.5;
        if (isVenueQ) {
            questionText = `How many times have you been to ${randomGig.OfficialVenue}?`;
            const count = data.filter(g => g.OfficialVenue === randomGig.OfficialVenue).length;
            currentCorrectAnswer = count.toString();
        } else {
            questionText = `How many times have you seen ${randomGig.Band} live?`;
            const count = data.filter(g => g.Band === randomGig.Band).length;
            currentCorrectAnswer = count.toString();
        }

        // Generate number distractors close to the real answer
        const c = parseInt(currentCorrectAnswer);
        options = [c + 1, c + 2, c - 1, c + 5, c * 2]
            .filter(n => n > 0 && n.toString() !== currentCorrectAnswer)
            .map(n => n.toString());
    }

    // Shuffle and pick 3 distractors
    options = options.sort(() => 0.5 - Math.random()).slice(0, 3);

    // Final safety check for distractors
    while (options.length < 3) {
        options.push((Math.floor(Math.random() * 10) + 1).toString());
    }

    options.push(currentCorrectAnswer);
    const finalOptions = [...new Set(options)].sort(() => 0.5 - Math.random()).slice(0, 4);

    renderQuestion(questionText, finalOptions);
};

const renderQuestion = (question, options) => {
    const body = document.getElementById('quiz-body');
    body.innerHTML = `
        <div id="question-container" class="mb-8">
            <p class="text-2xl md:text-3xl font-black text-white italic uppercase tracking-tight">${question}</p>
        </div>
        <div class="grid grid-cols-1 gap-3 w-full max-w-md">
            ${options.map(opt => `
                <button onclick="window.checkAnswer('${opt.replace(/'/g, "\\'")}')"
                        class="bg-white/10 border-2 border-white/10 text-white p-4 rounded-2xl font-bold hover:bg-white/20 hover:border-indigo-400 transition-all active:scale-95">
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
        // Brief success flash
        document.getElementById('game-arena').classList.add('bg-green-900');
        setTimeout(() => document.getElementById('game-arena').classList.remove('bg-green-900'), 200);
        nextQuestion();
    } else {
        // Time penalty for wrong answer
        timeLeft = Math.max(0, timeLeft - 3);
        document.getElementById('game-arena').classList.add('bg-red-900');
        setTimeout(() => document.getElementById('game-arena').classList.remove('bg-red-900'), 200);
        nextQuestion();
    }
};

const endGame = () => {
    clearInterval(timerInterval);

    // Save High Score
    const highScore = localStorage.getItem('giglist_quiz_hi') || 0;
    let newBest = false;
    if (score > highScore) {
        localStorage.setItem('giglist_quiz_hi', score);
        newBest = true;
    }

    const body = document.getElementById('quiz-body');
    body.innerHTML = `
        <div class="space-y-6">
            <h3 class="text-5xl font-black text-white italic uppercase">TIME'S UP!</h3>
            <div class="space-y-1">
                <p class="text-2xl text-indigo-300 font-bold uppercase">Score: ${score}</p>
                <p class="text-sm text-slate-400 font-bold uppercase">${newBest ? '🔥 NEW PERSONAL BEST! 🔥' : `Best: ${highScore}`}</p>
            </div>
            <button onclick="window.initQuiz()" class="bg-indigo-600 text-white px-8 py-4 rounded-full font-black uppercase tracking-widest hover:scale-105 transition-all">
                Play Again
            </button>
        </div>
    `;
};

// Expose to window for the button click
window.initQuiz = initQuiz;
window.startQuiz = initQuiz;