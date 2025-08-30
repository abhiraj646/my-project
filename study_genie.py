import os
import time
import random
import sqlite3
import json
import re
import google.generativeai as genai
from datetime import datetime
import os
import json
try:
    from PyPDF2 import PdfReader
except Exception:
    PdfReader = None
from flask import Flask, request, jsonify, render_template, session, redirect, url_for
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash
from flask_cors import CORS
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

app = Flask(__name__, template_folder='templates')

# Gemini API key (preferably set in .env); fallback to hardcoded key if not set
GEMINI_API_KEY = os.getenv('GEMINI_API_KEY', "AIzaSyBVbZCYEI3j_KEFsmyp8jZiEJb74S-XuPw")
genai.configure(api_key=GEMINI_API_KEY)
app.config['UPLOAD_FOLDER'] = 'uploads/'
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16MB max file size
app.config['SECRET_KEY'] = 'your-secret-key-change-in-production'
app.config['DATABASE'] = 'study_genie.db'
CORS(app)  # Enable CORS for all routes

# Database initialization
def init_db():
    with app.app_context():
        conn = sqlite3.connect(app.config['DATABASE'])
        cursor = conn.cursor()
        
        # Users table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        
        # User files table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS user_files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                filename TEXT NOT NULL,
                file_type TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                upload_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                processed BOOLEAN DEFAULT FALSE,
                summary TEXT,
                key_points TEXT,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
        ''')
        
        # User progress table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS user_progress (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                subject TEXT NOT NULL,
                progress_percentage INTEGER DEFAULT 0,
                weak_areas TEXT,
                quiz_stats TEXT,
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
        ''')
        
        # Quiz attempts table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS quiz_attempts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                question_id INTEGER NOT NULL,
                selected_answer TEXT,
                is_correct BOOLEAN,
                attempt_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
        ''')
        
        conn.commit()
        conn.close()

# Database connection helper
def get_db():
    conn = sqlite3.connect(app.config['DATABASE'])
    conn.row_factory = sqlite3.Row
    return conn

# Supported file extensions
ALLOWED_EXTENSIONS = {'pdf', 'jpg', 'jpeg', 'png', 'txt'}

# Function to check if the file is allowed
def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

# Authentication Routes
@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        data = request.get_json()
        username = data.get('username')
        password = data.get('password')
        
        conn = get_db()
        user = conn.execute(
            'SELECT * FROM users WHERE username = ?', (username,)
        ).fetchone()
        conn.close()
        
        if user and check_password_hash(user['password_hash'], password):
            session['user_id'] = user['id']
            session['username'] = user['username']
            return jsonify({
                'success': True,
                'message': 'Login successful',
                'user': {
                    'id': user['id'],
                    'username': user['username'],
                    'email': user['email']
                }
            })
        
        return jsonify({'error': 'Invalid username or password'}), 401
    
    return render_template('login.html')

@app.route('/signup', methods=['GET', 'POST'])
def signup():
    if request.method == 'POST':
        data = request.get_json()
        username = data.get('username')
        email = data.get('email')
        password = data.get('password')
        
        if not username or not email or not password:
            return jsonify({'error': 'All fields are required'}), 400
        
        conn = get_db()
        try:
            password_hash = generate_password_hash(password)
            conn.execute(
                'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
                (username, email, password_hash)
            )
            conn.commit()
            
            user = conn.execute(
                'SELECT * FROM users WHERE username = ?', (username,)
            ).fetchone()
            conn.close()
            
            session['user_id'] = user['id']
            session['username'] = user['username']
            
            return jsonify({
                'success': True,
                'message': 'Account created successfully',
                'user': {
                    'id': user['id'],
                    'username': user['username'],
                    'email': user['email']
                }
            })
            
        except sqlite3.IntegrityError:
            conn.close()
            return jsonify({'error': 'Username or email already exists'}), 400
    
    return render_template('signup.html')

@app.route('/logout')
def logout():
    session.clear()
    return jsonify({'success': True, 'message': 'Logged out successfully'})

@app.route('/check-auth')
def check_auth():
    if 'user_id' in session:
        return jsonify({
            'authenticated': True,
            'user': {
                'id': session['user_id'],
                'username': session['username']
            }
        })
    return jsonify({'authenticated': False})

# Home Route
@app.route('/')
def home():
    if 'user_id' in session:
        return render_template('dashboard.html')
    return render_template('index.html')


# Serve the raw index template at the same path some static servers use
@app.route('/templates/index.html')
def raw_index():
    # Return the same index template so the backend can serve the page directly
    return render_template('index.html')

# Upload Route
@app.route('/upload', methods=['POST'])
def upload_file():
    try:
        if 'file' not in request.files:
            return jsonify({'error': 'No file part'}), 400
        
        file = request.files['file']
        
        if file.filename == '':
            return jsonify({'error': 'No selected file'}), 400
        
        if file and allowed_file(file.filename):
            filename = secure_filename(file.filename)
            # Create uploads directory if it doesn't exist
            os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
            file_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
            file.save(file_path)
            
            # Return success with file info
            return jsonify({
                'success': f'File {filename} uploaded successfully',
                'filename': filename,
                'size': os.path.getsize(file_path),
                'uploaded_at': time.time()
            })
        
        return jsonify({'error': 'File type not allowed. Supported types: PDF, JPG, PNG, TXT'}), 400
    
    except Exception as e:
        return jsonify({'error': f'Upload failed: {str(e)}'}), 500

# Process Route
@app.route('/process', methods=['POST'])
def process_file():
    # Helper to robustly get Gemini response text
    def get_response_text(resp):
        if hasattr(resp, "text") and resp.text:
            return resp.text
        try:
            return resp.candidates[0].content[0].text
        except Exception:
            try:
                return str(resp)
            except:
                return ""

    try:
        data = request.get_json()
        filename = data.get('filename')
        if not filename:
            return jsonify({'error': 'Filename is required'}), 400

        file_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        if not os.path.exists(file_path):
            return jsonify({'error': 'File not found'}), 404

        # Read file content (PDF, TXT only for now)
        file_ext = filename.split('.')[-1].lower()
        file_content = ""
        if file_ext == 'pdf':
            try:
                from pdf2image import convert_from_path
                import pytesseract
                # Set tesseract path for Windows
                pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'
                images = convert_from_path(file_path, dpi=200)
                text_pages = []
                for img in images:
                    text_pages.append(pytesseract.image_to_string(img))
                file_content = "\n".join(text_pages)
            except Exception as e:
                # Primary OCR failed (likely poppler or tesseract issue). Try a non-OCR text extraction as fallback.
                try:
                    import PyPDF2
                    pages_text = []
                    with open(file_path, 'rb') as f:
                        reader = PyPDF2.PdfReader(f)
                        for p in reader.pages:
                            try:
                                pages_text.append(p.extract_text() or '')
                            except Exception:
                                pages_text.append('')
                    file_content = "\n".join(pages_text).strip()
                    # If fallback produced no text, treat as failure to extract
                    if not file_content:
                        raise Exception('No text extracted via PyPDF2')
                except Exception as e2:
                    # Provide actionable hints for the user to install poppler/tesseract
                    hint = (
                        f'PDF OCR extraction failed: {str(e)}. '\
                        f'Fallback text extraction also failed: {str(e2)}. '\
                        'If your PDF is a scanned/image PDF you need Poppler and Tesseract installed and on PATH. '\
                        'Install Poppler (provides pdftoppm) and add its bin folder to PATH: https://poppler.freedesktop.org/; '\
                        'Install Tesseract OCR: https://github.com/tesseract-ocr/tesseract and ensure the path configured in the app matches the installation. '
                        'On Windows you can install Poppler via conda/chocolatey or download binaries and add to PATH.'
                    )
                    return jsonify({'error': hint}), 500
        elif file_ext == 'txt':
            with open(file_path, 'r', encoding='utf-8') as f:
                file_content = f.read()
        else:
            file_content = "Cannot process this file type for AI summary."

        # Use Gemini API to generate summary, key points, MCQs, and flashcards
        model = genai.GenerativeModel('gemini-pro')
        # Truncate content to ~4000 chars
        truncated_content = file_content[:4000]

        # 1. Summary and key points (try Gemini, fallback to local heuristics)
        def simple_summarize(text, max_sentences=3):
            # naive sentence splitter
            sents = re.split(r'(?<=[.!?])\s+', text.strip())
            sents = [s.strip() for s in sents if s.strip()]
            return ' '.join(sents[:max_sentences]) if sents else (text[:300] + '...')

        def extract_key_points(text, max_points=4):
            sents = re.split(r'(?<=[.!?])\s+', text.strip())
            sents = [s.strip() for s in sents if s.strip()]
            points = []
            for s in sents:
                if len(points) >= max_points:
                    break
                # pick non-trivial short sentences
                if 30 < len(s) < 300:
                    points.append(s if s.endswith('.') else s + '.')
            # fallback to splitting by lines
            if not points:
                lines = [l.strip() for l in text.split('\n') if len(l.strip()) > 30]
                points = [l for l in lines[:max_points]]
            return points

        def make_mcqs_from_points(points):
            mcqs_local = []
            for i, p in enumerate(points[:3]):
                # build a simple question and dummy distractors
                q = {
                    'question': f'Which statement best matches: "{p[:80].rstrip()}..."',
                    'options': {
                        'A': p if len(p) < 200 else p[:200] + '...',
                        'B': 'A related but incorrect statement.',
                        'C': 'A somewhat plausible distractor.',
                        'D': 'An unrelated statement.'
                    },
                    'answer': 'A',
                    'subject': 'General',
                    'type': 'MCQ'
                }
                mcqs_local.append(q)
            return mcqs_local

        def make_flashcards_from_points(points):
            cards = []
            for p in points[:5]:
                cards.append({'front': (p.split('.')[0])[:80], 'back': p})
            return cards

        # Prepare result variables
        summary = ''
        key_points = []
        mcqs = []
        flashcards = []
        youtube_link = ''
        gemini_failed = False

        try:
            prompt_summary = (
                'Return ONLY valid JSON (no extra text). JSON schema:'
                '\n{\n  "summary": "string (<=100 words)",\n  "key_points": ["point1","point2","point3","point4"]\n}\n'
                f'Material:\n{truncated_content}'
            )
            response_summary = model.generate_content(prompt_summary)
            raw_summary = get_response_text(response_summary)
            print('>>> raw gemini response preview (summary):', raw_summary[:800])
            summary_json = json.loads(raw_summary)
            summary = summary_json.get('summary', '')
            key_points = summary_json.get('key_points', [])

            # MCQs via Gemini
            prompt_mcq = (
                'Return ONLY valid JSON array of 3 objects. Each object:'
                '\n{ "question": "string", "options": ["optA","optB","optC","optD"], "answer": "A" }\n'
                f'Material:\n{truncated_content}'
            )
            try:
                response_mcq = model.generate_content(prompt_mcq)
                raw_mcq = get_response_text(response_mcq)
                print('>>> raw gemini response preview (mcq):', raw_mcq[:800])
                mcqs = json.loads(raw_mcq)
            except Exception:
                mcqs = []

            # Flashcards via Gemini
            prompt_flashcard = (
                'Return ONLY valid JSON array of 3 objects: { "front": "...", "back": "..." }\n'
                f'Material:\n{truncated_content}'
            )
            try:
                response_flashcard = model.generate_content(prompt_flashcard)
                raw_flashcard = get_response_text(response_flashcard)
                print('>>> raw gemini response preview (flashcard):', raw_flashcard[:800])
                flashcards = json.loads(raw_flashcard)
            except Exception:
                flashcards = []

            # YouTube suggestion via Gemini (return a single URL or JSON with {"youtube_link": "..."})
            try:
                prompt_youtube = (
                    'Return ONLY a single YouTube URL (for example: https://www.youtube.com/watch?v=...) '
                    'or a JSON object like {"youtube_link": "<full_url>"}. Do NOT include any extra commentary. '\
                    f'Material:\n{truncated_content}'
                )
                try:
                    response_youtube = model.generate_content(prompt_youtube)
                    raw_youtube = get_response_text(response_youtube).strip()
                    print('>>> raw gemini response preview (youtube):', raw_youtube[:400])
                    # Try JSON parse first
                    try:
                        yobj = json.loads(raw_youtube)
                        if isinstance(yobj, dict):
                            youtube_link = yobj.get('youtube_link', '').strip()
                        elif isinstance(yobj, str):
                            youtube_link = yobj.strip()
                    except Exception:
                        # Fallback: extract first YouTube URL from text
                        m = re.search(r'(https?://(www\.)?youtube\.com/[^\s"\']+|https?://youtu\.be/[^\s"\']+)', raw_youtube)
                        if m:
                            youtube_link = m.group(0)
                except Exception:
                    youtube_link = ''
            except Exception:
                youtube_link = ''

        except Exception as e:
            # Log and fallback
            gemini_failed = True
            print('Gemini call failed:', str(e))

        # If Gemini failed or returned empty useful data, create local fallbacks
        if gemini_failed or not summary:
            summary = simple_summarize(truncated_content, max_sentences=3)
        if gemini_failed or not key_points:
            key_points = extract_key_points(truncated_content, max_points=4)
        if gemini_failed or not mcqs:
            mcqs = make_mcqs_from_points(key_points if key_points else [summary])
        if gemini_failed or not flashcards:
            flashcards = make_flashcards_from_points(key_points if key_points else [summary])

        return jsonify({
            'success': True,
            'summary': summary,
            'key_points': key_points,
            'mcqs': mcqs,
            'flashcards': flashcards,
            'youtube_link': youtube_link
        })
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        print('Processing error:\n', tb)
        return jsonify({'error': 'Processing failed', 'details': str(e), 'traceback': tb}), 500

# Quiz Data
QUIZ_QUESTIONS = [
    {
        'question': "According to Newton's Second Law of Motion, what is the relationship between force, mass, and acceleration?",
        'options': {
            'A': 'Force = Mass × Acceleration',
            'B': 'Mass = Force × Acceleration',
            'C': 'Acceleration = Force × Mass',
            'D': 'Force = Mass + Acceleration',
        },
        'answer': 'A',
        'subject': 'Physics',
        'type': 'MCQ'
    },
    {
        'question': "What is the SI unit of electric current?",
        'options': {
            'A': 'Volt',
            'B': 'Ampere',
            'C': 'Ohm',
            'D': 'Watt',
        },
        'answer': 'B',
        'subject': 'Physics',
        'type': 'MCQ'
    },
    {
        'question': "Which of the following is NOT a state of matter?",
        'options': {
            'A': 'Solid',
            'B': 'Liquid',
            'C': 'Gas',
            'D': 'Energy',
        },
        'answer': 'D',
        'subject': 'Chemistry',
        'type': 'MCQ'
    },
    {
        'question': "What is the chemical symbol for gold?",
        'options': {
            'A': 'Go',
            'B': 'Gd',
            'C': 'Au',
            'D': 'Ag',
        },
        'answer': 'C',
        'subject': 'Chemistry',
        'type': 'MCQ'
    },
    {
        'question': "Who developed the theory of relativity?",
        'options': {
            'A': 'Isaac Newton',
            'B': 'Albert Einstein',
            'C': 'Galileo Galilei',
            'D': 'Stephen Hawking',
        },
        'answer': 'B',
        'subject': 'Physics',
        'type': 'MCQ'
    }
]

# Flashcard Data
FLASHCARDS = [
    {
        'front': 'Newton\'s First Law',
        'back': 'An object at rest stays at rest and an object in motion stays in motion with the same speed and in the same direction unless acted upon by an unbalanced force.',
        'subject': 'Physics'
    },
    {
        'front': 'Photosynthesis',
        'back': 'The process by which plants convert light energy into chemical energy in the form of glucose.',
        'subject': 'Biology'
    },
    {
        'front': 'Mitochondria',
        'back': 'The powerhouse of the cell, responsible for producing ATP through cellular respiration.',
        'subject': 'Biology'
    },
    {
        'front': 'Ohm\'s Law',
        'back': 'V = I × R, where V is voltage, I is current, and R is resistance.',
        'subject': 'Physics'
    },
    {
        'front': 'DNA',
        'back': 'Deoxyribonucleic acid, the molecule that carries genetic instructions in living organisms.',
        'subject': 'Biology'
    }
]

# Analytics Data
ANALYTICS_DATA = {
    'study_progress': {
        'Physics': '85%',
        'Chemistry': '60%',
        'Biology': '75%',
        'Mathematics': '90%'
    },
    'weak_areas': {
        'Thermodynamics': '45%',
        'Quantum Mechanics': '55%',
        'Electromagnetism': '65%',
        'Organic Chemistry': '50%'
    },
    'quiz_stats': {
        'total_attempts': 25,
        'correct_answers': 20,
        'average_score': '80%',
        'best_score': '95%'
    },
    'time_spent': {
        'daily_average': '2.5 hours',
        'weekly_total': '17.5 hours',
        'monthly_total': '75 hours'
    }
}

# Quiz Route
@app.route('/quiz', methods=['GET'])
def quiz():
    try:
        # Return all questions for the frontend to handle navigation
        return jsonify({
            'success': True,
            'questions': QUIZ_QUESTIONS,
            'total_questions': len(QUIZ_QUESTIONS)
        })
    except Exception as e:
        return jsonify({'error': f'Failed to load quiz: {str(e)}'}), 500

# Single Question Route
@app.route('/quiz/question/<int:question_id>', methods=['GET'])
def get_question(question_id):
    try:
        if 0 <= question_id < len(QUIZ_QUESTIONS):
            return jsonify({
                'success': True,
                'question': QUIZ_QUESTIONS[question_id],
                'current_question': question_id + 1,
                'total_questions': len(QUIZ_QUESTIONS)
            })
        else:
            return jsonify({'error': 'Question not found'}), 404
    except Exception as e:
        return jsonify({'error': f'Failed to get question: {str(e)}'}), 500

# Analytics Route
@app.route('/analytics', methods=['GET'])
def analytics():
    try:
        return jsonify({
            'success': True,
            'analytics': ANALYTICS_DATA
        })
    except Exception as e:
        return jsonify({'error': f'Failed to load analytics: {str(e)}'}), 500

# Flashcards Route
@app.route('/flashcards', methods=['GET'])
def flashcards():
    try:
        return jsonify({
            'success': True,
            'flashcards': FLASHCARDS,
            'total_flashcards': len(FLASHCARDS)
        })
    except Exception as e:
        return jsonify({'error': f'Failed to load flashcards: {str(e)}'}), 500

# Single Flashcard Route
@app.route('/flashcards/<int:card_id>', methods=['GET'])
def get_flashcard(card_id):
    try:
        if 0 <= card_id < len(FLASHCARDS):
            return jsonify({
                'success': True,
                'flashcard': FLASHCARDS[card_id],
                'current_card': card_id + 1,
                'total_cards': len(FLASHCARDS)
            })
        else:
            return jsonify({'error': 'Flashcard not found'}), 404
    except Exception as e:
        return jsonify({'error': f'Failed to get flashcard: {str(e)}'}), 500

# Check Answer Route
@app.route('/quiz/check-answer', methods=['POST'])
def check_answer():
    try:
        data = request.get_json()
        question_id = data.get('question_id')
        selected_answer = data.get('answer')
        
        if question_id is None or selected_answer is None:
            return jsonify({'error': 'Question ID and answer are required'}), 400
        
        if 0 <= question_id < len(QUIZ_QUESTIONS):
            correct = QUIZ_QUESTIONS[question_id]['answer'] == selected_answer
            return jsonify({
                'success': True,
                'correct': correct,
                'correct_answer': QUIZ_QUESTIONS[question_id]['answer'],
                'explanation': f"The correct answer is {QUIZ_QUESTIONS[question_id]['answer']}: {QUIZ_QUESTIONS[question_id]['options'][QUIZ_QUESTIONS[question_id]['answer']]}"
            })
        else:
            return jsonify({'error': 'Question not found'}), 404
    except Exception as e:
        return jsonify({'error': f'Failed to check answer: {str(e)}'}), 500

if __name__ == '__main__':
    init_db()  # Initialize database tables
    app.run(debug=True)


@app.route('/generate-short-answers', methods=['POST'])
def generate_short_answers():
    """Generate short answer Q/A pairs from an uploaded file.
    This uses a simple heuristic fallback (first sentences) when a proper AI
    model isn't available. It supports .txt and .pdf files.
    """
    try:
        data = request.get_json() or {}
        filename = data.get('filename')
        if not filename:
            return jsonify({'error': 'filename required'}), 400

        filepath = os.path.join(app.config.get('UPLOAD_FOLDER', 'uploads/'), filename)
        if not os.path.exists(filepath):
            return jsonify({'error': 'file not found'}), 404

        ext = filename.rsplit('.', 1)[-1].lower()
        text = ''
        if ext == 'txt':
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                text = f.read()
        elif ext == 'pdf':
            if PdfReader is None:
                return jsonify({'error': 'PyPDF2 not available on server for PDF extraction'}), 500
            try:
                reader = PdfReader(filepath)
                for page in reader.pages:
                    try:
                        page_text = page.extract_text()
                        if page_text:
                            text += page_text + '\n'
                    except Exception:
                        continue
            except Exception as e:
                return jsonify({'error': 'failed to read PDF', 'detail': str(e)}), 500
        else:
            return jsonify({'error': 'unsupported file type for short answer generation'}), 400

        if not text or len(text.strip()) == 0:
            return jsonify({'error': 'no text extracted from file'}), 422

        # Simple heuristic: split into sentences and create short Q/A pairs.
        # Prefer splitting on newline and period. Keep it small (4 pairs).
        raw = text.replace('\n', '. ').replace('  ', ' ')
        parts = [p.strip() for p in raw.split('. ') if p.strip()]
        short_answers = []
        max_pairs = min(6, len(parts))
        for i in range(max_pairs):
            ans = parts[i][:800]
            prompt = ans.split(' ')[0:6]
            # Build a short question header from the first few words
            q = 'Explain: ' + (' '.join(prompt)).strip()
            short_answers.append({'prompt': q, 'answer': ans})

        return jsonify({'short_answers': short_answers})
    except Exception as e:
        return jsonify({'error': 'internal error', 'detail': str(e)}), 500
