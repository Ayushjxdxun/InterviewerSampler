import asyncHandler from 'express-async-handler';
import Session from '../models/SessionModel.js';
import fetch from 'node-fetch';
import FormData from 'form-data';
import mongoose from 'mongoose';
import { Readable } from 'stream';
import { normalizeScoreValue } from '../utils/scoreUtils.js';

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';

const pushSocketUpdate = (io, userId, sessionId, status, message, session = null) => {
    io.to(userId.toString()).emit('sessionUpdate', {
        sessionId,
        status,
        message,
        session,
    });
};

export const createSession = asyncHandler(async (req, res) => {
    const { role, level, interviewType, count } = req.body;
    const userId = req.user._id;

    if (!role || !level || !interviewType || !count) {
        res.status(400);
        throw new Error('Please specify role, level, interview type, and question count.');
    }

    let session = await Session.create({
        user: userId,
        role,
        level,
        interviewType,
        status: 'pending',
    });

    const io = req.app.get('io');

    res.status(202).json({
        message: 'Session created. Generating questions asynchronously...',
        _id: session._id,
        status: 'pending',
        role: session.role,
        level: session.level,
        interviewType: session.interviewType,
        questions: [],
        createdAt: session.createdAt || new Date()
    });

    (async () => {
        try {
            pushSocketUpdate(io, userId, session._id, 'AI_GENERATING_QUESTIONS', `Generating ${count} questions for ${role}...`);

            const aiResponse = await fetch(`${AI_SERVICE_URL}/generate-questions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role, level, count, interview_type: interviewType }),
            });

            if (!aiResponse.ok) {
                const errorBody = await aiResponse.text();
                throw new Error(`AI Service error: ${aiResponse.status} - ${errorBody}`);
            }

            const aiData = await aiResponse.json();
            const codingCount = interviewType === 'coding-mix' ? Math.floor(Number(count) * 0.4) : 0;

            // Defensive: ensure we received an array of questions
            const rawQuestions = (aiData && Array.isArray(aiData.questions)) ? aiData.questions : [];
            const questionsArray = rawQuestions.map((qText, index) => ({
                questionText: String(qText || '').trim(),
                questionType: index < codingCount ? 'coding' : 'oral',
                isEvaluated: false,
                isSubmitted: false,
            }));

            session.questions = questionsArray;
            session.status = 'in-progress';
            await session.save();

            pushSocketUpdate(io, userId, session._id, 'QUESTIONS_READY', 'Questions generated successfully.', session);
        } catch (error) {
            console.error(`Session Creation Failure:`, error);
            try {
                if (session) {
                    session.status = 'failed';
                    await session.save();
                    pushSocketUpdate(io, userId, session._id, 'GENERATION_FAILED', `Generation failed: ${error.message}.`);
                }
            } catch (e) {
                console.error('Failed to mark session as failed', e);
            }
        }
    })();
});

export const getSessions = asyncHandler(async (req, res) => {
    const sessions = await Session.find({ user: req.user._id })
        .sort({ createdAt: -1 })
        .select('-questions.userAnswerText -questions.userSubmittedCode');
    res.json(sessions);
});

export const getSessionById = asyncHandler(async (req, res) => {
    const session = await Session.findOne({ _id: req.params.id, user: req.user._id });
    if (session) {
        res.json(session);
    } else {
        res.status(404);
        throw new Error('Session not found or user unauthorized.');
    }
});

export const deleteSession = asyncHandler(async (req, res) => {
    const session = await Session.findById(req.params.id);
    if (!session) {
        res.status(404);
        throw new Error('Session not found');
    }
    // Normalize user id checks - middleware sets `req.user` as the full user doc
    const requestUserId = req.user && (req.user._id ? req.user._id.toString() : (req.user.id ? req.user.id.toString() : null));
    if (!requestUserId || session.user.toString() !== requestUserId) {
        res.status(401);
        throw new Error('Not authorized');
    }
    await session.deleteOne();
    res.status(200).json({ id: req.params.id });
});

const evaluateAnswerAsync = async (io, userId, sessionId, questionIndex, audioBuffer, originalName, mimeType, code) => {
    let transcription = "";
    const questionIdx = typeof questionIndex === 'string' ? parseInt(questionIndex, 10) : questionIndex;
    
    try {
        const session = await Session.findById(sessionId);
        if (!session) return;
        const question = session.questions[questionIdx];
        if (!question) return;

        if (audioBuffer) {
            try {
                pushSocketUpdate(io, userId, sessionId, 'AI_TRANSCRIBING', `Transcribing...`);
                const formData = new FormData();
                formData.append('file', Readable.from(audioBuffer), {
                    filename: originalName || 'audio.webm',
                    contentType: mimeType || 'audio/webm',
                    knownLength: audioBuffer.length
                });

                const transResponse = await fetch(`${AI_SERVICE_URL}/transcribe`, {
                    method: 'POST',
                    body: formData,
                    headers: formData.getHeaders(),
                });

                if (transResponse.ok) {
                    const transData = await transResponse.json();
                    transcription = transData.transcription || "";
                }
            } catch (error) {
                console.error(`Transcription Error: ${error.message}`);
            }
        }

        pushSocketUpdate(io, userId, sessionId, 'AI_EVALUATING', `AI is analyzing...`);
        const evalResponse = await fetch(`${AI_SERVICE_URL}/evaluate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                question: question.questionText,
                question_type: question.questionType,
                role: session.role,
                level: session.level,
                user_answer: transcription,
                user_code: code || "",
            }),
        });

        if (!evalResponse.ok) throw new Error('AI Evaluation service failed');
        const evalData = await evalResponse.json();

        question.userAnswerText = transcription;
        question.userSubmittedCode = code || "";
        question.technicalScore = normalizeScoreValue(evalData.technicalScore);
        question.confidenceScore = normalizeScoreValue(evalData.confidenceScore);
        question.aiFeedback = evalData.aiFeedback || 'Good effort. Add a little more structure to strengthen your answer.';
        question.idealAnswer = evalData.idealAnswer || 'Pending evaluation.';
        question.isEvaluated = true;

        const allQuestionsEvaluated = session.questions.every(q => q.isEvaluated);
        if (allQuestionsEvaluated) {
            const scoreSummary = await calculateOverallScore(sessionId);
            session.overallScore = scoreSummary.overallScore || 0;
            session.metrics = { avgTechnical: scoreSummary.avgTechnical, avgConfidence: scoreSummary.avgConfidence };
            session.status = 'completed';
            session.endTime = new Date();
            await session.save();
            pushSocketUpdate(io, userId, sessionId, 'SESSION_COMPLETED', 'Session finished.', session);
        } else {
            await session.save();
            pushSocketUpdate(io, userId, sessionId, 'EVALUATION_COMPLETE', 'Feedback ready.', session);
        }
    } catch (error) {
        console.error(`Evaluation Error: ${error.message}`);
        pushSocketUpdate(io, userId, sessionId, 'EVALUATION_FAILED', `Evaluation failed.`, null);
    }
};

export const submitAnswer = asyncHandler(async (req, res) => {
    const sessionId = req.params.id;
    const userId = req.user._id;
    const { questionIndex, code } = req.body;

    const session = await Session.findById(sessionId);
    if (!session || session.user.toString() !== userId.toString()) {
        res.status(404);
        throw new Error('Session not found or user unauthorized.');
    }

    const questionIdx = parseInt(questionIndex, 10);
    const question = session.questions && session.questions[questionIdx];
    if (!question) {
        res.status(400);
        throw new Error('Invalid question index');
    }

    question.userSubmittedCode = code || "";
    question.isSubmitted = true;
    await session.save();

    res.status(202).json({ message: 'Processing...', status: 'received' });

    evaluateAnswerAsync(
        req.app.get('io'), 
        userId, 
        sessionId, 
        questionIdx, 
        req.file ? Buffer.from(req.file.buffer) : null, 
        req.file?.originalname, 
        req.file?.mimetype, 
        code || ""
    );
});

export const calculateOverallScore = async (sessionId) => {
    const results = await Session.aggregate([
        { $match: { _id: new mongoose.Types.ObjectId(sessionId) } },
        { $unwind: '$questions' },
        {
            $group: {
                _id: '$_id',
                avgTechnical: { $avg: { $cond: [{ $eq: ['$questions.isEvaluated', true] }, '$questions.technicalScore', 0] } },
                avgConfidence: { $avg: { $cond: [{ $eq: ['$questions.isEvaluated', true] }, '$questions.confidenceScore', 0] } }
            }
        },
        {
            $project: {
                _id: 0,
                overallScore: { $round: [{ $avg: ['$avgTechnical', '$avgConfidence'] }, 0] },
                avgTechnical: { $round: ['$avgTechnical', 0] },
                avgConfidence: { $round: ['$avgConfidence', 0] },
            }
        }
    ]);
    return results[0] || { overallScore: 0, avgTechnical: 0, avgConfidence: 0 };
};

export const endSession = asyncHandler(async (req, res) => {
    const sessionId = req.params.id;
    const userId = req.user._id;
    const session = await Session.findById(sessionId);

    if (!session || session.user.toString() !== userId.toString()) {
        res.status(404);
        throw new Error('Session not found or unauthorized.');
    }

    const scoreSummary = await calculateOverallScore(sessionId);
    session.overallScore = scoreSummary.overallScore || 0;
    session.status = 'completed';
    session.endTime = new Date();
    session.metrics = { avgTechnical: scoreSummary.avgTechnical, avgConfidence: scoreSummary.avgConfidence };
    await session.save();

    pushSocketUpdate(req.app.get('io'), userId, sessionId, 'SESSION_COMPLETED', 'Ended.', session);
    res.json({ message: 'Session ended.', session });
});