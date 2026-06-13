// backend/controllers/sessionController.js
import asyncHandler from 'express-async-handler';
import Session from '../models/SessionModel.js';
import fetch from 'node-fetch';
import fs from 'fs';
import FormData from 'form-data';
import path from 'path';
import mongoose from 'mongoose';

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';

const pushSocketUpdate = (io, userId, sessionId, status, message, session = null) => {
    io.to(userId.toString()).emit('sessionUpdate', {
        sessionId,
        status,
        message,
        session,
    });
};

const createSession = asyncHandler(async (req, res) => {
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
                body: JSON.stringify({
                    role,
                    level,
                    count,
                    interview_type: interviewType
                }),
            });

            if (!aiResponse.ok) {
                const errorBody = await aiResponse.text();
                throw new Error(`AI Service error: ${aiResponse.status} - ${errorBody}`);
            }

            const aiData = await aiResponse.json();
            const codingCount = interviewType === 'coding-mix' ? Math.floor(count * 0.2) : 0;
            const questionsArray = aiData.questions.map((qText, index) => ({
                questionText: qText,
                questionType: index < codingCount ? 'coding' : 'oral',
                isEvaluated: false,
                isSubmitted: false,
            }));

            session.questions = questionsArray;
            session.status = 'in-progress';
            await session.save();

            pushSocketUpdate(io, userId, session._id, 'QUESTIONS_READY', 'Questions generated successfully.', session);

        } catch (error) {
            console.error(`Session Creation Failure for ${session._id}:`, error.message);
            session.status = 'failed';
            await session.save();
            pushSocketUpdate(io, userId, session._id, 'GENERATION_FAILED', `Generation failed: ${error.message}.`);
        }
    })();
});

const getSessions = asyncHandler(async (req, res) => {
    const sessions = await Session.find({ user: req.user._id })
        .sort({ createdAt: -1 })
        .select('-questions.userAnswerText -questions.userSubmittedCode');
    res.json(sessions);
});

const getSessionById = asyncHandler(async (req, res) => {
    const session = await Session.findOne({ _id: req.params.id, user: req.user._id });
    if (session) {
        res.json(session);
    } else {
        res.status(404);
        throw new Error('Session not found or user unauthorized.');
    }
});

const deleteSession = asyncHandler(async (req, res) => {
    const session = await Session.findById(req.params.id);
    if (!session) {
        res.status(404);
        throw new Error('Session not found');
    }
    if (session.user.toString() !== req.user.id) {
        res.status(401);
        throw new Error('Not authorized');
    }
    await session.deleteOne();
    res.status(200).json({ id: req.params.id });
});

const evaluateAnswerAsync = async (io, userId, sessionId, questionIndex, audioFilePath = null, code = null) => {
    let transcription = "";
    const questionIdx = typeof questionIndex === 'string' ? parseInt(questionIndex, 10) : questionIndex;
    const session = await Session.findById(sessionId);
    if (!session) return;

    const question = session.questions[questionIdx];
    if (!question) return;

    if (audioFilePath) {
        try {
            pushSocketUpdate(io, userId, sessionId, 'AI_TRANSCRIBING', `Transcribing...`);
            const formData = new FormData();
            formData.append('file', fs.createReadStream(audioFilePath));

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
        } finally {
            if (audioFilePath && fs.existsSync(audioFilePath)) fs.unlinkSync(audioFilePath);
        }
    }

    try {
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
        question.technicalScore = evalData.technicalScore;
        question.confidenceScore = evalData.confidenceScore;
        question.aiFeedback = evalData.aiFeedback;
        question.idealAnswer = evalData.idealAnswer;
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
        pushSocketUpdate(io, userId, sessionId, 'EVALUATION_FAILED', `Evaluation failed.`, session);
    }
};

const submitAnswer = asyncHandler(async (req, res) => {
    const sessionId = req.params.id;
    const { questionIndex, code } = req.body;
    const userId = req.user._id;

    const session = await Session.findById(sessionId);
    if (!session || session.user.toString() !== userId.toString()) {
        res.status(404);
        throw new Error('Session not found or user unauthorized.');
    }

    const questionIdx = parseInt(questionIndex, 10);
    const question = session.questions[questionIdx];
    if (!question) {
        res.status(400);
        throw new Error(`Question not found.`);
    }

    let audioFilePath = req.file ? req.file.path : null;

    question.isSubmitted = true;
    await session.save();

    res.status(202).json({ message: 'Processing...', status: 'received' });

    const io = req.app.get('io');
    evaluateAnswerAsync(io, userId, sessionId, questionIdx, audioFilePath, code || null);
});

const calculateOverallScore = async (sessionId) => {
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

const endSession = asyncHandler(async (req, res) => {
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

    const io = req.app.get('io');
    pushSocketUpdate(io, userId, sessionId, 'SESSION_COMPLETED', 'Ended.', session);
    res.json({ message: 'Session ended.', session });
});

export { createSession, getSessionById, getSessions, submitAnswer, endSession, calculateOverallScore, deleteSession };