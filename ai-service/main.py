import uvicorn
import os
import io
import json
import tempfile
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from typing import Optional
from groq import Groq
import whisper
from pydub import AudioSegment

load_dotenv()

AI_SERVICE_PORT = int(os.getenv("AI_SERVICE_PORT", 8000))
MODEL_NAME = os.getenv("GROQ_MODEL_NAME", "mixtral-8x7b-32768")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")

if not GROQ_API_KEY:
    print("WARNING: GROQ_API_KEY environment variable is missing!")

client = Groq(api_key=GROQ_API_KEY)

app = FastAPI(title="AI Interviewer Microservice", version="1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_WHISPER_MODEL = None

def get_whisper_model():
    
    global _WHISPER_MODEL
    if _WHISPER_MODEL is None:
        print("Loading Whisper Model on demand...")
        _WHISPER_MODEL = whisper.load_model("base.en")
        print("Whisper Model Loaded Successfully")
    return _WHISPER_MODEL

class QuestionResquest(BaseModel):
    role: str = "MERN Stack Developer"
    level: str = "Junior"
    count: int = 5
    interview_type: str = "coding-mix"

class QuestionResponse(BaseModel):
    questions: list[str]
    model_used: str

class EvaluationRequest(BaseModel):
    question: str
    question_type: str
    role: str
    level: str
    user_answer: Optional[str] = None
    user_code: Optional[str] = None

class EvaluationResponse(BaseModel):
    technicalScore: int
    confidenceScore: int
    aiFeedback: str
    idealAnswer: str

@app.get("/")
async def root():
    return {"message": "Hello from AI Interviewer Microservice!", "model": MODEL_NAME}

@app.post("/generate-questions", response_model=QuestionResponse)
async def generate_questions(request: QuestionResquest):
    try:
        if request.interview_type == "coding-mix":
            coding_count = int(request.count * 0.4)
            oral_count = int(request.count) - int(coding_count)
            instruction = (
                f"1. Generate exactly {request.count} questions. "
                f"2. {coding_count} questions must be complex coding challenges that require algorithmic efficiency. "
                f"3. {oral_count} questions must be senior-level system design or scenario-based architectural questions or coding based questions."
            )
        else:
            instruction = f"1. Generate exactly {request.count} high-level conceptual/architectural questions or normal coding questions. Do not generate basic 'What is X' definitions."

        system_prompt = (
            "You are a Lead Staff Engineer and Technical Interviewer at a tech company. "
            "YOUR MISSION: Create an interview that is both engaging and challenging interview. "
            "STRICT CONSTRAINTS:\n"
            "- AVOID generic questions like 'What is a closure?' or 'Define component lifecycle'.\n"
            "- USE scenario-based questions: 'How would you architect X to handle Y concurrent users?' or 'Debug this complex race condition scenario...'\n"
            "- For coding challenges, prioritize edge cases, memory optimization, and time complexity.\n"
            "- Output ONLY a JSON object with a key 'questions' (an array of strings).\n"
            "- Do not include markdown, numbering, or preamble text.\n"
            f"Contextual Instructions: {instruction}"
        )

        user_prompt = (
            f"Target Role: {request.role}\n"
            f"Target Seniority: {request.level}\n"
            "Generate questions that test your expertise."
        )
        
        response = client.chat.completions.create(
            model=MODEL_NAME,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            response_format={"type": "json_object"}, 
            temperature=0.7,
        )

        raw_text = response.choices[0].message.content.strip()
        data = json.loads(raw_text)
        questions = data.get("questions", [])

        if isinstance(questions, str):
            questions = [q.strip() for q in questions.split('\n') if q.strip()]

        return QuestionResponse(questions=questions[:request.count], model_used=MODEL_NAME)

    except Exception as e:
        print(f"Failed to generate questions: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    temp_audio_path = None
    try:
        audio_bytes = await file.read()
        audio_in_memory = io.BytesIO(audio_bytes)
        audio_segment = AudioSegment.from_file(audio_in_memory)
        with tempfile.NamedTemporaryFile(delete=False, suffix=".mp3") as tmp:
            temp_audio_path = tmp.name
            audio_segment.export(temp_audio_path, format="mp3")
        
        model = get_whisper_model()
        result = model.transcribe(temp_audio_path)
        os.remove(temp_audio_path)
        return {"transcription": result["text"].strip()}

    except Exception as e:
        if temp_audio_path and os.path.exists(temp_audio_path):
            os.remove(temp_audio_path)
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/evaluate", response_model=EvaluationResponse)
async def evaluate(request: EvaluationRequest):
    try:
        assessment_instruction = (
            "This is a conceptual oral question. Focus on conceptual understanding." if request.question_type == "oral" 
            else "This is a coding challenge. Evaluate logic, efficiency, and edge cases."
        )
        
        system_prompt = (
            "You are a senior-level technical interviewer. "
            "RULE: If answer is gibberish or irrelevant, return technicalScore: 0. "
            "Respond ONLY with a JSON object containing keys: 'technicalScore', 'confidenceScore', 'aiFeedback', 'idealAnswer'. "
            f"Context: {assessment_instruction}"
        )
        
        user_prompt = (
            f"Role: {request.role}\nQuestion: {request.question}\nLevel: {request.level}\n"
            f"Verbal Answer: {request.user_answer or 'None'}\nCode Answer: {request.user_code or 'None'}\n"
        )
        
        response = client.chat.completions.create(
            model=MODEL_NAME,
            messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
            response_format={"type": "json_object"},
            temperature=0.1,
        )
        
        response_text = response.choices[0].message.content.strip()
        evaluation_data = json.loads(response_text)
        return EvaluationResponse(**evaluation_data)

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=AI_SERVICE_PORT, reload=False)