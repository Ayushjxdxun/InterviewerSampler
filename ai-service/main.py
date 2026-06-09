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
# Mixtral-8x7b is excellent, fast, open-source, and perfectly replaces local mistral
MODEL_NAME = os.getenv("GROQ_MODEL_NAME", "mixtral-8x7b-32768")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")

if not GROQ_API_KEY:
    print("WARNING: GROQ_API_KEY environment variable is missing!")

# Initialize cloud client
client = Groq(api_key=GROQ_API_KEY)

app = FastAPI(title="AI Interviewer Microservice", version="1.0")

origins = ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Lazy loading setup to prevent Out-Of-Memory errors
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
    return {"message": "Hello from AI Interviewer Microservice !", "model": MODEL_NAME}

@app.post("/generate-questions", response_model=QuestionResponse)
async def generate_questions(request: QuestionResquest):
    try:
        if request.interview_type == "coding-mix":
            coding_count = int(request.count * 0.2)
            oral_count = int(request.count) - int(coding_count)
            instruction = (
                f"Generate exactly {request.count} questions. "
                f"The first {coding_count} questions MUST be coding challenges requiring function implementation. "
                f"The remaining {oral_count} questions MUST be conceptual oral questions."
            )
        else:
            instruction = f"Generate exactly {request.count} conceptual oral questions. Do Not generate any coding or implementation challenges."

        # 1. Update system prompt to strictly demand JSON
        system_prompt = (
            "You are a professional technical interviewer. "
            "Output ONLY a JSON object containing a single key 'questions' which is an array of strings. "
            "Do not include any numbering, markdown, or conversational text inside the question strings. "
            f"Crucial: {instruction}"
        )

        user_prompt = (
            f"Role: {request.role}\n"
            f"Level: {request.level}\n"
        )
        
        # 2. Add response_format={"type": "json_object"}
        response = client.chat.completions.create(
            model=MODEL_NAME,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            response_format={"type": "json_object"}, 
            temperature=0.6,
        )

        raw_text = response.choices[0].message.content.strip()
        
        # 3. Safely parse the JSON
        data = json.loads(raw_text)
        questions = data.get("questions", [])

        # Fallback safeguard in case AI returns a string instead of a list
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
        
        # Load model lazily
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
        if request.question_type == "oral":
            assessment_instruction = (
                "This is a conceptual oral question. Focus purely on candidate's verbal explanation. "
                "Ignore any code blocks. "
                "CRITICAL: If the transcript is empty, nonsense (e.g. 'blah blah','testing') or irrelevant to the question, SCORE 0."
            )
        else:
            assessment_instruction = (
                "This is a coding challenge question. Evaluate the code logic and efficiency. "
                "Use the transcription only for insight into their thought process. "
                "CRITICAL: If the code is 'undefined', empty, just random comments, or random characters, SCORE 0."
            )
        
        system_prompt = (
            "You are a strict technical interviewer. "
            "Do NOT hallucinate positive reviews for bad input. "
            "RULE 1: If the answer is gibberish, irrelevant, or missing, return 'technicalScore':0 and 'confidenceScore':0. "
            "RULE 2: For 'idealAnswer', provide a clean Markdown string. Do NOT return a nested JSON object. "
            f"Context:{assessment_instruction}"
            "Respond ONLY with a JSON object. "
            "Required keys: 'technicalScore' (0-100), 'confidenceScore' (0-100), 'aiFeedback', 'idealAnswer'. "
        )
        user_prompt = (
            f"Role: {request.role}\n"
            f"Question: {request.question}\n"
            f"Level: {request.level}\n"
            f"Verbal Answer: {request.user_answer or 'No verbal answer provided'}\n"
            f"Code Answer: {request.user_code or 'No code provided'}\n"
        )
        
        response = client.chat.completions.create(
            model=MODEL_NAME,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            response_format={"type": "json_object"},
            temperature=0.1,
        )
        
        response_text = response.choices[0].message.content.strip()
        try:
            evaluation_data = json.loads(response_text)
            if 'idealAnswer' in evaluation_data and not isinstance(evaluation_data['idealAnswer'], str):
                evaluation_data['idealAnswer'] = json.dumps(evaluation_data['idealAnswer'])
            return EvaluationResponse(**evaluation_data)
        except json.JSONDecodeError:
            import re
            fixed_text = re.sub(r'[\r\n\t]', ' ', response_text)
            try:
                evaluation_data = json.loads(fixed_text)
                if 'idealAnswer' in evaluation_data and not isinstance(evaluation_data['idealAnswer'], str):
                    evaluation_data['idealAnswer'] = json.dumps(evaluation_data['idealAnswer'])
                return EvaluationResponse(**evaluation_data)
            except:
                print(f"Failed to parse response: {response_text}")
                return EvaluationResponse(technicalScore=0, confidenceScore=0, aiFeedback="Failed to parse response", idealAnswer="Failed to parse response")

    except Exception as e:
        print(f"Failed to generate response: {e}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=AI_SERVICE_PORT, reload=False)