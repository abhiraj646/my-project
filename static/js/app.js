// Global state
let currentFiles = [];
let currentQuiz = null;
let currentAnalytics = null;
let currentQuestionIndex = 0;
let quizQuestions = [];
let currentUser = null;
// Real-time quiz stats (start from zero)
let realtimeStats = {
    totalAttempts: 0,
    correctAnswers: 0,
    totalTimeSeconds: 0,
    averageTimeSeconds: 0,
    bestScorePercent: 0
};
let questionStartTime = null;

// Use clearer counters: totalQuestions is number of generated MCQs; answeredCount is how many answered so far
realtimeStats.totalQuestions = 0;
realtimeStats.answeredCount = 0;
// track answered question ids to prevent double-counting
realtimeStats.answeredQuestionIds = [];

// Default sample data so UI looks populated even when backend is down
const DEFAULT_QUIZ = {
    questions: [
        {
            question: "According to Newton's Second Law, which equation is correct?",
            options: { A: 'Force = Mass × Acceleration', B: 'Mass = Force × Acceleration', C: 'Acceleration = Force × Mass', D: 'Force = Mass ÷ Acceleration' },
            answer: 'A',
            subject: 'Physics',
            type: 'MCQ'
        },
        {
            question: "What is inertia?",
            options: { A: 'Resistance to change in motion', B: 'A type of force', C: 'Rate of change of velocity', D: 'Energy stored in motion' },
            answer: 'A',
            subject: 'Physics',
            type: 'MCQ'
        }
    ]
};

const DEFAULT_FLASHCARDS = [
    { front: "Newton's First Law", back: "An object at rest stays at rest and an object in motion stays in motion unless acted on by an unbalanced force." },
    { front: "Inertia", back: "The tendency of an object to resist changes to its state of motion." }
];

const DEFAULT_SHORT_ANSWERS = [
    { prompt: "State Newton's Second Law.", answer: "Force equals mass times acceleration (F = ma)." },
    { prompt: "Define inertia.", answer: "Inertia is the tendency of objects to resist changes in motion." }
];

// DOM Elements
let fileInput;
let uploadDropzone;
let uploadButton;

// Initialize the application
document.addEventListener('DOMContentLoaded', function() {
    // Initialize elements safely
    fileInput = document.getElementById('fileInput');
    uploadDropzone = document.querySelector('.upload-dropzone');
    if (uploadDropzone) {
        uploadButton = uploadDropzone.querySelector('button');
    }
    
    checkAuthentication();
    if (uploadDropzone && uploadButton) {
        initializeUploadFunctionality();
    }
    setupNavigation();
    setupFlashcards();
    setupQuiz();

    // Initialize realtime stats (start from zero immediately)
    initRealtimeStats();

    // Populate UI with defaults immediately so dashboard looks alive even if backend is down
    populateDefaults();

    // Generate button logic
    const generateBtn = document.getElementById('generateBtn');
    if (generateBtn) {
        generateBtn.addEventListener('click', async function() {
            if (currentFiles.length === 0) {
                showNotification('Please upload a file first!', 'warning');
                return;
            }
            // Only process the last uploaded file
            const lastFile = currentFiles[currentFiles.length - 1];
            await processUploadedFile(lastFile.name);
        });
    }
});

// Authentication functions
async function checkAuthentication() {
    try {
        const response = await fetch('/check-auth');
    const result = await response.json();
    // Debug: log server response to help diagnose missing correctness flag
    console.log('check-answer result:', result);
        
        if (result.authenticated) {
            currentUser = result.user;
            updateNavigation(true);
            loadInitialData();
        } else {
            updateNavigation(false);
            // Redirect to login if not on login page
            if (!window.location.pathname.includes('login') && !window.location.pathname.includes('signup')) {
                window.location.href = '/login';
            }
        }
    } catch (error) {
        console.error('Auth check failed:', error);
        updateNavigation(false);
    }
}

// Populate UI with default quiz, flashcards, and short answers
function populateDefaults() {
    try {
        if ((!quizQuestions || quizQuestions.length === 0) && DEFAULT_QUIZ) {
            updateQuiz(DEFAULT_QUIZ);
        }

        if ((!window.generatedFlashcards || window.generatedFlashcards.length === 0) && DEFAULT_FLASHCARDS) {
            updateFlashcards(DEFAULT_FLASHCARDS);
        }

        // Short answers: render into #shortAnswersList if present
        const shortAnswersList = document.getElementById('shortAnswersList');
        if (shortAnswersList && Array.isArray(DEFAULT_SHORT_ANSWERS)) {
            shortAnswersList.innerHTML = DEFAULT_SHORT_ANSWERS.map(sa => `
                <li>
                    <strong>${sa.prompt}</strong>
                    <div class="text-gray-300">${sa.answer}</div>
                </li>
            `).join('');
        }
    } catch (e) {
        console.error('populateDefaults failed:', e);
    }
}

function updateNavigation(isLoggedIn) {
    const loginBtn = document.getElementById('userButton');
    if (loginBtn) {
        if (isLoggedIn) {
            loginBtn.innerHTML = `<i class="fas fa-user mr-2"></i>${currentUser.username}`;
            loginBtn.onclick = () => logout();
        } else {
            loginBtn.innerHTML = `<i class="fas fa-user-graduate mr-2"></i>Login`;
            loginBtn.onclick = () => window.location.href = '/login';
        }
    }
}

async function logout() {
    try {
        await fetch('/logout');
        currentUser = null;
        window.location.href = '/';
    } catch (error) {
        console.error('Logout failed:', error);
    }
}

function setupNavigation() {
    const loginBtn = document.getElementById('userButton');
    if (loginBtn) {
        loginBtn.addEventListener('click', function() {
            if (currentUser) {
                logout();
            } else {
                window.location.href = '/login';
            }
        });
    }
}

// File Upload Functionality
function initializeUploadFunctionality() {
    // Click handler for upload button
    uploadButton.addEventListener('click', () => fileInput.click());
    
    // File input change handler
    fileInput.addEventListener('change', handleFileSelect);
    
    // Drag and drop handlers
    uploadDropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadDropzone.classList.add('dragover');
    });
    
    uploadDropzone.addEventListener('dragleave', () => {
        uploadDropzone.classList.remove('dragover');
    });
    
    uploadDropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadDropzone.classList.remove('dragover');
        handleFileDrop(e);
    });
}

function handleFileSelect(e) {
    const files = Array.from(e.target.files);
    processFiles(files);
}

function handleFileDrop(e) {
    const files = Array.from(e.dataTransfer.files);
    processFiles(files);
}

async function processFiles(files) {
    const validFiles = files.filter(file => {
        const extension = file.name.split('.').pop().toLowerCase();
        return ['pdf', 'jpg', 'jpeg', 'png', 'txt'].includes(extension);
    });

    if (validFiles.length === 0) {
        showNotification('Please select valid files (PDF, JPG, PNG, TXT)', 'error');
        return;
    }

    showNotification(`Uploading ${validFiles.length} file(s)...`, 'info');

    for (const file of validFiles) {
        try {
            const formData = new FormData();
            formData.append('file', file);

            const response = await fetch('/upload', {
                method: 'POST',
                body: formData
            });

            const result = await response.json();

            if (result.success) {
                showNotification(result.success, 'success');
                currentFiles.push({
                    name: file.name,
                    type: file.type,
                    size: file.size,
                    uploadedAt: new Date().toLocaleString()
                });
                updateRecentUploads();
                // Show generate button after upload
                const generateBtn = document.getElementById('generateBtn');
                if (generateBtn) generateBtn.style.display = 'inline-block';
            } else {
                showNotification(result.error || 'Upload failed', 'error');
            }
        } catch (error) {
            showNotification('Upload failed: ' + error.message, 'error');
        }
    }
}

async function processUploadedFile(filename) {
    try {
        showNotification('Processing file...', 'info');
        const response = await fetch('/process', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ filename: filename })
        });
        const result = await response.json();
        if (result.summary) {
            showNotification('File processed successfully!', 'success');
            updateDashboard(result.summary, result.key_points);
            updateMCQs(result.mcqs);
            updateFlashcards(result.flashcards);
                // Render suggested YouTube video when provided
                if (result.youtube_link) {
                    renderYouTube(result.youtube_link);
                }

                // Ensure short answers are present; if not, request server-side quick generation
                if (!result.short_answers || !Array.isArray(result.short_answers) || result.short_answers.length === 0) {
                    try {
                        const saResp = await fetch('/generate-short-answers', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ filename: filename })
                        });
                        const saJson = await saResp.json();
                        if (saJson && Array.isArray(saJson.short_answers)) {
                            renderShortAnswers(saJson.short_answers);
                        }
                    } catch (e) {
                        console.error('short answer generation failed:', e);
                    }
                } else {
                    renderShortAnswers(result.short_answers);
                }
        } else if (result.error) {
            showNotification(result.error, 'error');
        }
    } catch (error) {
        showNotification('Processing failed: ' + error.message, 'error');
    }
}

function renderYouTube(url) {
    try {
        const youtubeEmbed = document.getElementById('youtubeEmbed');
        const youtubeFallback = document.getElementById('youtubeFallback');
        if (!youtubeEmbed) return;
        // Normalize short youtu.be links to full embed form
        let videoId = null;
        const m1 = url.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{6,})/);
        if (m1 && m1[1]) videoId = m1[1];
        if (videoId) {
            const iframe = document.createElement('iframe');
            iframe.width = '560';
            iframe.height = '315';
            iframe.src = `https://www.youtube.com/embed/${videoId}`;
            iframe.frameBorder = '0';
            iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
            iframe.allowFullscreen = true;
            youtubeEmbed.innerHTML = '';
            youtubeEmbed.appendChild(iframe);
            if (youtubeFallback) youtubeFallback.style.display = 'none';
        } else {
            // If we couldn't parse an ID, show the raw link
            youtubeEmbed.innerHTML = `<a href="${url}" target="_blank" class="text-purple-300">Watch suggested video</a>`;
            if (youtubeFallback) youtubeFallback.style.display = 'none';
        }
    } catch (e) {
        console.error('renderYouTube failed:', e);
    }
}

function renderShortAnswers(shortAnswers) {
    try {
        // Prefer a UL with id 'shortAnswersList' if present, else use container 'shortAnswersContainer'
        const listElem = document.getElementById('shortAnswersList');
        const container = document.getElementById('shortAnswersContainer');
        if (listElem) {
            listElem.innerHTML = shortAnswers.map(sa => `
                <li class="mb-3">
                    <strong class="text-white">${sa.prompt}</strong>
                    <div class="text-gray-300">${sa.answer}</div>
                </li>
            `).join('');
            return;
        }

        if (container) {
            container.innerHTML = `
                <h4 class="font-semibold mb-3 text-white">Short Answers</h4>
                <ul class="text-sm text-gray-300" id="shortAnswersList">
                    ${shortAnswers.map(sa => `
                        <li class="mb-3">
                            <strong>${sa.prompt}</strong>
                            <div class="text-gray-300">${sa.answer}</div>
                        </li>
                    `).join('')}
                </ul>
            `;
            return;
        }

        // If no container exists, log to console
        console.log('shortAnswers:', shortAnswers);
    } catch (e) {
        console.error('renderShortAnswers failed:', e);
    }
}

// Show MCQs in quiz section
function updateMCQs(mcqs) {
    // Robustly parse MCQs and fallback to saved/static if needed
    let validMCQs = Array.isArray(mcqs) && mcqs.length > 0 ? mcqs : null;
    // Validate MCQ format: must have question, options, answer
    if (validMCQs) {
        validMCQs = validMCQs.filter(q => q && q.question && q.options && typeof q.options === 'object');
    }
    if (!validMCQs || validMCQs.length === 0) {
        // Fallback to saved/static MCQs
        if (currentQuiz && Array.isArray(currentQuiz.questions) && currentQuiz.questions.length > 0) {
            validMCQs = currentQuiz.questions;
        } else {
            showNotification('No MCQs available.', 'warning');
            return;
        }
    }
    quizQuestions = validMCQs;
    currentQuestionIndex = 0;
    // Set total generated questions as the total for realtime stats and reset progress counters
    try {
        realtimeStats.totalQuestions = quizQuestions.length;
        realtimeStats.answeredCount = 0;
        realtimeStats.correctAnswers = 0;
        realtimeStats.totalTimeSeconds = 0;
        realtimeStats.averageTimeSeconds = 0;
        // persist lightly
        try { localStorage.setItem('studygenie_realtime_stats', JSON.stringify(realtimeStats)); } catch (e) {}
        renderRealtimeStats();
    } catch (e) {
        console.error('Failed to set realtimeStats totalQuestions', e);
    }
    displayQuestion(currentQuestionIndex);
}

// Show flashcards in flashcard section
function updateFlashcards(flashcards) {
    // Robustly parse flashcards and fallback to saved/static if needed
    let validFlashcards = Array.isArray(flashcards) && flashcards.length > 0 ? flashcards : null;
    // Validate flashcard format: must have front and back
    if (validFlashcards) {
        validFlashcards = validFlashcards.filter(card => card && card.front && card.back);
    }
    if (!validFlashcards || validFlashcards.length === 0) {
        // Fallback to saved/static flashcards
        if (window.savedFlashcards && Array.isArray(window.savedFlashcards) && window.savedFlashcards.length > 0) {
            validFlashcards = window.savedFlashcards;
        } else {
            showNotification('No flashcards available.', 'warning');
            return;
        }
    }
    window.generatedFlashcards = validFlashcards;
    let currentIndex = 0;
    const flashcardElem = document.getElementById('currentFlashcard');
    if (!flashcardElem) return;
    function renderFlashcard(idx) {
        const card = validFlashcards[idx];
        // Clear any decorative duplicates when rendering a new card
        const existingDuplicates = flashcardElem.parentElement.querySelectorAll('.duplicate-card');
        existingDuplicates.forEach(d => d.remove());

        flashcardElem.innerHTML = `
            <div class="flashcard-front absolute w-full h-full flex items-center justify-center bg-dark-200 rounded-xl p-6">
                <span class="text-lg font-bold">${card.front}</span>
            </div>
            <div class="flashcard-back absolute w-full h-full flex items-center justify-center bg-dark-300 rounded-xl p-6">
                <span class="text-lg">${card.back}</span>
            </div>
        `;
        flashcardElem.classList.remove('flipped');

        // Make the flashcard container act as the 3D card
        flashcardElem.classList.add('flashcard');

        // Click on card itself should flip and leave a duplicate behind
        flashcardElem.onclick = (e) => {
            // Prevent double-handling if clicking on duplicate
            if (e.target.closest('.duplicate-card')) return;
            createDuplicateAndFlip(flashcardElem);
        };
    }
    renderFlashcard(currentIndex);
    // Add navigation
    const prevBtn = document.getElementById('prevCardBtn');
    const nextBtn = document.getElementById('nextCardBtn');
    const flipBtn = document.getElementById('flipCardBtn');
    if (prevBtn) prevBtn.onclick = () => { if (currentIndex > 0) { currentIndex--; renderFlashcard(currentIndex); } };
    if (nextBtn) nextBtn.onclick = () => { if (currentIndex < validFlashcards.length - 1) { currentIndex++; renderFlashcard(currentIndex); } };
    if (flipBtn) flipBtn.onclick = () => { createDuplicateAndFlip(flashcardElem); };

    // Helper: clone the front face and insert behind, then flip the active card
    function createDuplicateAndFlip(cardContainer) {
        try {
            // If already flipped, just unflip and remove duplicates
            if (cardContainer.classList.contains('flipped')) {
                cardContainer.classList.remove('flipped');
                const existing = cardContainer.parentElement.querySelectorAll('.duplicate-card');
                existing.forEach(d => d.remove());
                return;
            }

            // Clone the front node to create a decorative duplicate
            const front = cardContainer.querySelector('.flashcard-front');
            if (!front) return;
            const dup = front.cloneNode(true);
            dup.classList.add('duplicate-card');
            // Style the duplicate slightly smaller and behind
            dup.style.position = 'absolute';
            dup.style.left = '6px';
            dup.style.top = '6px';
            dup.style.transform = 'scale(0.98) translateZ(-1px)';
            dup.style.opacity = '0.9';
            dup.style.zIndex = '0';
            // Ensure pointer events don't block clicks
            dup.style.pointerEvents = 'none';

            // Insert the duplicate behind the card container
            cardContainer.parentElement.insertBefore(dup, cardContainer);

            // small staggered animation to make duplicate feel natural
            requestAnimationFrame(() => {
                dup.style.transform = 'translateY(6px) scale(0.975)';
                dup.style.opacity = '0.85';
            });

            // Finally flip the active card to reveal the back
            setTimeout(() => {
                cardContainer.classList.add('flipped');
            }, 60);

        } catch (e) {
            console.error('createDuplicateAndFlip failed:', e);
            // Fallback: simple toggle
            cardContainer.classList.toggle('flipped');
        }
    }
}

// Dashboard and Data Loading
async function loadInitialData() {
    try {
        // Load analytics
        const analyticsResponse = await fetch('/analytics');
        currentAnalytics = await analyticsResponse.json();
        updateAnalytics(currentAnalytics);

        // Load quiz
        const quizResponse = await fetch('/quiz');
        currentQuiz = await quizResponse.json();
        updateQuiz(currentQuiz);

    } catch (error) {
        console.error('Error loading initial data:', error);
    }
}

function updateRecentUploads() {
    const recentUploadsContainer = document.getElementById('recentUploads');
    if (!recentUploadsContainer) return;

    recentUploadsContainer.innerHTML = currentFiles.slice(-2).map(file => `
        <div class="flex items-center justify-between p-3 bg-dark-300 rounded-lg">
            <div class="flex items-center">
                <i class="fas fa-${getFileIcon(file.name)} ${getFileColor(file.name)} mr-3"></i>
                <span>${file.name}</span>
            </div>
            <span class="text-sm text-gray-400">${file.uploadedAt}</span>
        </div>
    `).join('');
}

function getFileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    if (ext === 'pdf') return 'file-pdf';
    if (['jpg', 'jpeg', 'png'].includes(ext)) return 'image';
    return 'file-alt';
}

function getFileColor(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    if (ext === 'pdf') return 'text-red-400';
    if (['jpg', 'jpeg', 'png'].includes(ext)) return 'text-green-400';
    return 'text-blue-400';
}

function updateDashboard(summary, keyPoints = null) {
    // Update summary section
    const summaryContent = document.getElementById('summaryContent');
    if (summaryContent) {
        summaryContent.textContent = summary || 'No summary available';
    }

    // Update key points
    const keyPointsList = document.getElementById('keyPointsList');
    if (keyPointsList) {
        let points;
        if (keyPoints && Array.isArray(keyPoints)) {
            points = keyPoints.slice(0, 3);
        } else {
            // Fallback: extract from summary
            points = (summary || '').split('. ').slice(0, 3).filter(p => p.trim().length > 0);
        }
        
        if (points.length > 0) {
            keyPointsList.innerHTML = points.map(point => `
                <li class="flex items-start">
                    <span class="w-2 h-2 bg-purple-500 rounded-full mt-2 mr-3"></span>
                    <span>${point}${!point.endsWith('.') ? '.' : ''}</span>
                </li>
            `).join('');
        }
    }
}

function updateAnalytics(analytics) {
    // Update progress bars
    if (analytics.study_progress) {
        for (const [subject, progress] of Object.entries(analytics.study_progress)) {
            const progressBar = document.querySelector(`[data-subject="${subject}"]`);
            if (progressBar) {
                progressBar.style.width = progress;
                progressBar.previousElementSibling.querySelector('span:last-child').textContent = progress;
            }
        }
    }

    // Update weak areas
    if (analytics.weak_areas) {
        for (const [area, score] of Object.entries(analytics.weak_areas)) {
            const areaElement = document.querySelector(`[data-area="${area}"]`);
            if (areaElement) {
                areaElement.style.width = score;
                areaElement.previousElementSibling.querySelector('span:last-child').textContent = score;
            }
        }
    }
}

// Quiz Functionality
function setupQuiz() {
    const prevBtn = document.getElementById('prevQuestionBtn');

    if (prevBtn) {
        prevBtn.addEventListener('click', loadPreviousQuestion);
    }

    // Add submit handler to radio buttons
    const optionsContainer = document.getElementById('quizOptions');
    if (optionsContainer) {
        optionsContainer.addEventListener('change', function(e) {
            if (e.target.name === 'quiz-answer') {
                handleQuizSubmit(e);
            }
        });
    }
}

function updateQuiz(quizData) {
    if (quizData && quizData.questions) {
        quizQuestions = quizData.questions;
        // update totalQuestions for realtime stats
        try {
            realtimeStats.totalQuestions = quizQuestions.length;
            // reset answered counters to reflect new quiz
            realtimeStats.answeredCount = 0;
            realtimeStats.answeredQuestionIds = [];
            realtimeStats.correctQuestionIds = [];
            realtimeStats.correctAnswers = 0;
            realtimeStats.totalTimeSeconds = 0;
            realtimeStats.averageTimeSeconds = 0;
            renderRealtimeStats();
        } catch (e) {
            console.error('Failed to set realtimeStats in updateQuiz', e);
        }
        if (quizQuestions.length > 0) {
            displayQuestion(currentQuestionIndex);
        }
    }
}

function displayQuestion(index) {
    if (index < 0 || index >= quizQuestions.length) return;

    const question = quizQuestions[index];
    const questionElement = document.getElementById('questionText');
    const optionsContainer = document.getElementById('quizOptions');
    const questionCounter = document.getElementById('questionCounter');
    const quizSubject = document.getElementById('quizSubject');
    const quizType = document.getElementById('quizType');

    if (questionElement && optionsContainer && questionCounter && quizSubject && quizType) {
        // Update question counter
        questionCounter.textContent = `Question ${index + 1} of ${quizQuestions.length}`;
        
        // Update subject and type
        quizSubject.textContent = question.subject || 'General';
        quizType.textContent = question.type || 'MCQ';
        
        // Update question text
        questionElement.textContent = question.question;
        
        // Update options
        optionsContainer.innerHTML = Object.entries(question.options).map(([key, value]) => `
            <label class="flex items-center p-4 bg-dark-200 rounded-lg cursor-pointer hover:bg-dark-300 transition-colors">
                <input type="radio" name="quiz-answer" value="${key}" class="mr-3 accent-purple-500">
                <span>${value}</span>
            </label>
        `).join('');
    // Start timer for this question
    questionStartTime = Date.now();
    }
}

async function loadNextQuestion() {
    if (currentQuestionIndex < quizQuestions.length - 1) {
        currentQuestionIndex++;
        displayQuestion(currentQuestionIndex);
    } else {
        showNotification('This is the last question!', 'info');
    }
}

async function loadPreviousQuestion() {
    if (currentQuestionIndex > 0) {
        currentQuestionIndex--;
        displayQuestion(currentQuestionIndex);
    } else {
        showNotification('This is the first question!', 'info');
    }
}

async function handleQuizSubmit(e) {
    const selectedAnswer = e.target.value;
    
    if (!selectedAnswer) {
        showNotification('Please select an answer', 'warning');
        return;
    }
    // compute time taken for this question (seconds)
    const timeTakenSeconds = questionStartTime ? Math.max(0, (Date.now() - questionStartTime) / 1000) : 0;

    try {
        const response = await fetch('/quiz/check-answer', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                question_id: currentQuestionIndex,
                answer: selectedAnswer
            })
        });

        const result = await response.json();

        if (result.success) {
            // Fallback: if server didn't return explicit correctness, infer from local question data
            let isCorrect = false;
            if (typeof result.correct === 'boolean') {
                isCorrect = result.correct;
            } else {
                try {
                    const expected = quizQuestions[currentQuestionIndex] && quizQuestions[currentQuestionIndex].answer;
                    isCorrect = (expected && expected.toString() === selectedAnswer.toString());
                } catch (e) {
                    isCorrect = false;
                }
            }
            // Update realtime stats with the resolved correctness
            updateRealtimeStats(Boolean(isCorrect), timeTakenSeconds, currentQuestionIndex);

            // Add visual feedback
            const optionsContainer = document.getElementById('quizOptions');
            const optionLabels = optionsContainer.querySelectorAll('label');
            
            // Remove any existing feedback classes
            optionLabels.forEach(label => {
                label.classList.remove('correct-answer', 'incorrect-answer');
            });
            
            // Find the selected option
            const selectedOption = e.target.closest('label');
            
            if (isCorrect) {
                // Correct answer - show green
                selectedOption.classList.add('correct-answer');
                showNotification('Correct! 🎉', 'success');
                // realtime stats are updated separately (updateRealtimeStats) and will refresh UI
                
                // Automatically move to next question after a short delay
                setTimeout(() => {
                    if (currentQuestionIndex < quizQuestions.length - 1) {
                            currentQuestionIndex++;
                            displayQuestion(currentQuestionIndex);
                        } else {
                            showNotification('Quiz completed! 🎉', 'success');
                        }
                }, 1500); // 1.5 second delay
                
            } else {
                // Incorrect answer - show red
                selectedOption.classList.add('incorrect-answer');
                showNotification('Incorrect! Try again.', 'error');
                
                // Also show the correct answer in green
                const correctAnswer = quizQuestions[currentQuestionIndex].answer;
                optionLabels.forEach(label => {
                    const radioInput = label.querySelector('input[type="radio"]');
                    if (radioInput && radioInput.value === correctAnswer) {
                        label.classList.add('correct-answer');
                    }
                });
            }
            
            // Debug: Log the applied classes
            console.log('Selected option classes:', selectedOption.classList);
            console.log('All option labels:', optionLabels);
        }
    } catch (error) {
        showNotification('Failed to check answer', 'error');
        console.error('Quiz submit error:', error);
    }
}

// Real-time stats helpers
function initRealtimeStats() {
    // Ensure full schema so other helpers can rely on fields
    realtimeStats = {
        totalAttempts: 0,
        correctAnswers: 0,
        totalTimeSeconds: 0,
        averageTimeSeconds: 0,
        bestScorePercent: 0,
        totalQuestions: 0,
        answeredCount: 0,
        answeredQuestionIds: [],
        correctQuestionIds: []
    };
    // render immediately so UI shows zeros
    renderRealtimeStats();
}

function updateRealtimeStats(wasCorrect, timeSeconds, questionId) {
    try {
        questionId = typeof questionId !== 'undefined' ? questionId : null;

        // If this question was not answered before, mark it answered
        const alreadyAnswered = questionId !== null && realtimeStats.answeredQuestionIds.includes(questionId);
        if (!alreadyAnswered) {
            if (questionId !== null) realtimeStats.answeredQuestionIds.push(questionId);
            realtimeStats.answeredCount += 1;
        }

        // Ensure correctQuestionIds exists
        if (!Array.isArray(realtimeStats.correctQuestionIds)) realtimeStats.correctQuestionIds = [];

        // Latest-answer-wins: if previously marked correct and now incorrect -> decrement; if previously incorrect and now correct -> increment
        const wasPreviouslyCorrect = questionId !== null && realtimeStats.correctQuestionIds.includes(questionId);
        if (wasCorrect) {
            if (!wasPreviouslyCorrect) {
                // newly correct
                realtimeStats.correctQuestionIds.push(questionId);
                realtimeStats.correctAnswers += 1;
            }
        } else {
            if (wasPreviouslyCorrect) {
                // answer changed from correct to incorrect
                realtimeStats.correctQuestionIds = realtimeStats.correctQuestionIds.filter(id => id !== questionId);
                realtimeStats.correctAnswers = Math.max(0, realtimeStats.correctAnswers - 1);
            }
        }

        // Update timing (always add; average is over answeredCount)
        realtimeStats.totalTimeSeconds += Number(timeSeconds || 0);
        realtimeStats.averageTimeSeconds = realtimeStats.answeredCount > 0 ? (realtimeStats.totalTimeSeconds / realtimeStats.answeredCount) : 0;

        // compute current percent against total generated questions
        const denom = realtimeStats.totalQuestions > 0 ? realtimeStats.totalQuestions : realtimeStats.answeredCount;
        const currentPercent = denom > 0 ? Math.round((realtimeStats.correctAnswers / denom) * 100) : 0;
        if (currentPercent > realtimeStats.bestScorePercent) realtimeStats.bestScorePercent = currentPercent;

        // persist lightly to localStorage so page reloads keep recent values
        try { localStorage.setItem('studygenie_realtime_stats', JSON.stringify(realtimeStats)); } catch (e) {}

        renderRealtimeStats();
    } catch (e) {
        console.error('updateRealtimeStats error', e);
    }
}

function renderRealtimeStats() {
    // Try to update several possible DOM targets. Templates may use different IDs.
    const correctElem = document.getElementById('correctAnswersStat') || document.getElementById('correctAnswers');
    const totalElem = document.getElementById('totalAttemptsStat');
    const avgElem = document.getElementById('averageTimeStat');
    const bestElem = document.getElementById('bestScoreStat');

    if (correctElem) {
        // If original uses 'current/total' format, update accordingly
        if (correctElem.id === 'correctAnswers') {
            const total = realtimeStats.totalQuestions || 0;
            correctElem.textContent = `${realtimeStats.correctAnswers}/${total}`;
        } else {
            correctElem.textContent = `${realtimeStats.correctAnswers}`;
        }
    }
    // Show answered count if available
    if (totalElem) totalElem.textContent = `${realtimeStats.answeredCount}`;
    // Support alternative IDs present in templates
    const avgAlt = document.getElementById('averageTime');
    const bestAlt = document.getElementById('bestScore');
    if (avgElem) avgElem.textContent = `${Math.round(realtimeStats.averageTimeSeconds)}s`;
    if (avgAlt) avgAlt.textContent = `${Math.round(realtimeStats.averageTimeSeconds)}s`;
    if (bestElem) bestElem.textContent = `${realtimeStats.bestScorePercent}%`;
    if (bestAlt) bestAlt.textContent = `${realtimeStats.bestScorePercent}%`;
}

// Flashcards Functionality
function setupFlashcards() {
    const flipButton = document.getElementById('flipCardBtn');
    const nextButton = document.getElementById('nextCardBtn');
    const prevButton = document.getElementById('prevCardBtn');
    const flashcard = document.getElementById('currentFlashcard');

    // Flip behavior is set when flashcards are rendered (updateFlashcards)

    if (nextButton) {
        nextButton.addEventListener('click', loadNextFlashcard);
    }

    if (prevButton) {
        prevButton.addEventListener('click', loadPreviousFlashcard);
    }
}

function loadNextFlashcard() {
    showNotification('Loading next flashcard...', 'info');
    // Implement flashcard rotation logic
}

function loadPreviousFlashcard() {
    showNotification('Loading previous flashcard...', 'info');
    // Implement flashcard rotation logic
}

// Utility Functions
function showNotification(message, type = 'info') {
    // Create notification element
    const notification = document.createElement('div');
    let bgColor = 'bg-blue-600';
    
    if (type === 'success') bgColor = 'bg-green-600';
    else if (type === 'error') bgColor = 'bg-red-600';
    else if (type === 'warning') bgColor = 'bg-yellow-600';
    
    notification.className = `fixed top-20 right-6 z-50 px-6 py-3 rounded-lg shadow-lg transform transition-all duration-300 ${bgColor} text-white`;
    notification.textContent = message;
    notification.style.transform = 'translateX(100%)';

    document.body.appendChild(notification);

    // Animate in
    setTimeout(() => {
        notification.style.transform = 'translateX(0)';
    }, 100);

    // Remove after 3 seconds
    setTimeout(() => {
        notification.style.transform = 'translateX(100%)';
        setTimeout(() => {
            document.body.removeChild(notification);
        }, 300);
    }, 3000);
}

