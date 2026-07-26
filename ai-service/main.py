import uvicorn
import os
import io
import json
import re
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from typing import Optional
from groq import Groq

load_dotenv()

AI_SERVICE_PORT = int(os.getenv("AI_SERVICE_PORT", 8000))
MODEL_NAME = os.getenv("GROQ_MODEL_NAME", "mixtral-8x7b-32768")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")

client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None


def _build_fallback_questions(role: str, level: str, count: int, interview_type: str) -> list[str]:
    base_questions = [
        f"For a {role} at the {level} level, how would you architect a system that stays reliable under burst traffic?",
        f"Walk through how you would debug a production issue in a {role} service with incomplete logs and high latency.",
        f"Describe the trade-offs you would make when scaling a {role} application for 10x more users.",
        f"How would you improve maintainability and test coverage in a {role} codebase without slowing delivery?",
        f"Explain how you would handle data consistency and rollback strategies for a {role} feature rollout.",
    ]

    if interview_type == "coding-mix":
        base_questions = [
            f"Implement a rate-limited queue for a {role} service and explain its complexity trade-offs.",
            f"Given a large dataset, how would you optimize a search or aggregation flow used by a {role} app?",
            *base_questions[:3],
        ]

    return base_questions[:count]


def _normalize_score_value(value) -> int:
    if value is None:
        return 0
    if isinstance(value, (int, float)):
        numeric = float(value)
        if numeric > 10 and numeric <= 100:
            return int(round(numeric))
        if numeric >= 0 and numeric <= 10:
            return int(round(numeric * 10))
        return int(round(numeric))
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return 0
        slash_match = re.search(r'^(\d+(?:\.\d+)?)\s*/\s*(\d+(?:\.\d+)?)$', text)
        if slash_match:
            numerator = float(slash_match.group(1))
            denominator = float(slash_match.group(2))
            if denominator > 0:
                return int(round((numerator / denominator) * 100))
        out_of_match = re.search(r'^(\d+(?:\.\d+)?)\s*out\s+of\s+(\d+(?:\.\d+)?)$', text, re.I)
        if out_of_match:
            numerator = float(out_of_match.group(1))
            denominator = float(out_of_match.group(2))
            if denominator > 0:
                return int(round((numerator / denominator) * 100))
        try:
            numeric = float(text)
        except ValueError:
            return 0
        if numeric > 10 and numeric <= 100:
            return int(round(numeric))
        if numeric >= 0 and numeric <= 10:
            return int(round(numeric * 10))
        return int(round(numeric))
    return 0


def _build_fallback_evaluation(question_type: str, role: str, level: str, user_answer: Optional[str], user_code: Optional[str]):
    has_substance = bool((user_answer or '').strip() or (user_code or '').strip())
    technical_score = 72 if has_substance else 35
    confidence_score = 70 if has_substance else 30
    feedback = (
        f"The answer shows a solid foundation for a {level} {role} role. "
        "Add concrete trade-off analysis and edge-case handling to strengthen it."
        if has_substance else
        f"The response was too brief to evaluate effectively for a {level} {role} role. "
        "Provide a more concrete explanation or code sample."
    )
    ideal_answer = (
        f"Discuss the main constraints, propose a clear approach, and justify the trade-offs for a {level} {role} role."
    )
    return {
        "technicalScore": technical_score,
        "confidenceScore": confidence_score,
        "aiFeedback": feedback,
        "idealAnswer": ideal_answer,
    }

app = FastAPI(title="AI Interviewer Microservice", version="1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
        
        if not client:
            return QuestionResponse(
                questions=_build_fallback_questions(request.role, request.level, request.count, request.interview_type),
                model_used="fallback"
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
    try:
        audio_bytes = await file.read()

        if not client:
            raise HTTPException(status_code=503, detail="AI transcription service is unavailable because no Groq API key is configured.")
        
        # Wrapped memory bytes in an io.BytesIO stream structure to prevent Groq API payload clipping
        transcription = client.audio.transcriptions.create(
            file=(file.filename or "audio.webm", io.BytesIO(audio_bytes)),
            model="whisper-large-v3",
        )
            
        return {"transcription": transcription.text.strip()}

    except Exception as e:
        print(f"Transcription error: {e}")
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
            "Grade fairly and supportively. If the answer is blank or gibberish, give a low score (around 20-35). "
            "If the answer shows some correct thinking, reward it with a moderate score (around 50-80). "
            "Only give very low scores for completely irrelevant or empty responses. "
            "Respond ONLY with a JSON object containing keys: 'technicalScore', 'confidenceScore', 'aiFeedback', 'idealAnswer'. "
            "Use integers from 0 to 100 for both scores. "
             f"Context: {assessment_instruction}"
        )
        
        user_prompt = (
            f"Role: {request.role}\nQuestion: {request.question}\nLevel: {request.level}\n"
            f"Verbal Answer: {request.user_answer or 'None'}\nCode Answer: {request.user_code or 'None'}\n"
        )
        
        if not client:
            return EvaluationResponse(**_build_fallback_evaluation(request.question_type, request.role, request.level, request.user_answer, request.user_code))

        response = client.chat.completions.create(
            model=MODEL_NAME,
            messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
            response_format={"type": "json_object"},
            temperature=0.1,
        )
        
        response_text = response.choices[0].message.content.strip()
        evaluation_data = json.loads(response_text)
        evaluation_data["technicalScore"] = max(0, min(100, _normalize_score_value(evaluation_data.get("technicalScore", 0))))
        evaluation_data["confidenceScore"] = max(0, min(100, _normalize_score_value(evaluation_data.get("confidenceScore", 0))))
        return EvaluationResponse(**evaluation_data)

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=AI_SERVICE_PORT, reload=False)