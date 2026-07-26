import { createSlice, createAsyncThunk } from '@reduxjs/toolkit'
import axios from 'axios'

const API_URL = `${import.meta.env.VITE_API_URL}/api/sessions/`;

const api = axios.create({ baseURL: API_URL })
api.interceptors.request.use((request) => {
    const user = JSON.parse(localStorage.getItem('user'));
    if (user && user.token) {
        request.headers.Authorization = `Bearer ${user.token}`
    }
    return request
});

api.interceptors.response.use(
    (response) => response,
    (error) => {
        if (error.response?.status === 401) {
            localStorage.removeItem('user');
            window.location.replace('/login');
        }
        return Promise.reject(error)
    }
)

const VALID_ROLES = [
    'MERN Stack Developer',
    'MEAN Stack Developer',
    'Full Stack Python',
    'Full Stack Java',
    'Frontend Developer',
    'Backend Developer',
    'Data Scientist',
    'Data Analyst',
    'Machine Learning Engineer',
    'DevOps Engineer',
    'Cloud Engineer (AWS/Azure/GCP)',
    'Cybersecurity Engineer',
    'Blockchain Developer',
    'Mobile Developer (iOS/Android)',
    'Game Developer',
    'UI/UX Designer',
    'QA Automation Engineer',
    'Product Manager'
];

const normalizeRole = (value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return 'MERN Stack Developer';
    const match = VALID_ROLES.find((role) => role.toLowerCase() === trimmed.toLowerCase());
    return match || 'MERN Stack Developer';
};

const normalizeScoreValue = (value) => {
    if (value === null || value === undefined || value === '') return 0;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return 0;
        if (value > 10 && value <= 100) return value;
        if (value >= 0 && value <= 10) return value * 10;
        return value;
    }
    const trimmed = String(value).trim();
    if (!trimmed) return 0;
    const slashMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/i);
    if (slashMatch) {
        const numerator = Number(slashMatch[1]);
        const denominator = Number(slashMatch[2]);
        if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
        return Math.min(100, (numerator / denominator) * 100);
    }
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
        if (parsed > 10 && parsed <= 100) return parsed;
        if (parsed >= 0 && parsed <= 10) return parsed * 10;
        return parsed;
    }
    return 0;
};

const normalizeScores = (session) => {
    if (!session) return session;
    return {
        ...session,
        role: normalizeRole(session.role),
        overallScore: normalizeScoreValue(session.overallScore),
        metrics: session.metrics ? {
            avgTechnical: normalizeScoreValue(session.metrics.avgTechnical),
            avgConfidence: normalizeScoreValue(session.metrics.avgConfidence)
        } : { avgTechnical: 0, avgConfidence: 0 },
        questions: Array.isArray(session.questions) ? session.questions.map((question) => ({
            ...question,
            technicalScore: normalizeScoreValue(question?.technicalScore),
            confidenceScore: normalizeScoreValue(question?.confidenceScore),
        })) : []
    };
};

const initialState = {
    sessions: [],
    activeSession: null,
    isGenerating: false,
    isError: false,
    isLoading: false,
    message: ''
}

export const getSessions = createAsyncThunk('sessions/getAll', async (_, thunkAPI) => {
    try {
        const response = await api.get('/');
        return (response.data || []).map(normalizeScores);
    } catch (error) {
        const message = (error.response?.data?.message) || error.message || error.toString();
        return thunkAPI.rejectWithValue(message);
    }
})

export const createSession = createAsyncThunk('sessions/create', async (sessionData, thunkAPI) => {
    try {
        const response = await api.post('/', sessionData);
        return response.data;
    } catch (error) {
        const message = (error.response?.data?.message) || error.message || error.toString();
        return thunkAPI.rejectWithValue(message);
    }
})

export const getSessionById = createAsyncThunk('sessions/getOne', async (sessionId, thunkAPI) => {
    try {
        const response = await api.get(`/${sessionId}`);
        return normalizeScores(response.data);
    } catch (error) {
        const message = (error.response?.data?.message) || error.message || error.toString();
        return thunkAPI.rejectWithValue(message);
    }
})

export const deleteSession = createAsyncThunk('sessions/delete', async (sessionId, thunkAPI) => {
    try {
        const response = await api.delete(`/${sessionId}`);
        return response.data.id;
    } catch (error) {
        const message = (error.response?.data?.message) || error.message || error.toString();
        return thunkAPI.rejectWithValue(message);
    }
})

export const submitAnswer = createAsyncThunk('sessions/submitAnswer', async ({ sessionId, formData }, thunkAPI) => {
    try {
        const response = await api.post(`/${sessionId}/submit-answer`, formData);
        return response.data;
    } catch (error) {return thunkAPI.rejectWithValue(error.response?.data?.message || error.message);}
})

export const endSession = createAsyncThunk('sessions/endSession', async (sessionId, thunkAPI) => {
    try {
        const response = await api.post(`/${sessionId}/end`);
        return response.data;
    } catch (error) {
        const message = (error.response?.data?.message) || error.message || error.toString();
        return thunkAPI.rejectWithValue(message);
    }
})

export const sessionSlice = createSlice({
    name: 'sessions',
    initialState,
    reducers: {
        reset: (state) => {
            state.isError = false;
            state.message = '';
            state.isLoading = false;
            state.isGenerating = false;
        },
        socketUpdateSession: (state, action) => {
            const { sessionId, status, message, session } = action.payload;
            state.message = message;

            if (status === 'QUESTIONS_READY' || status === 'GENERATION_FAILED') {
                state.isGenerating = false;
            }

            if (session && state.activeSession && state.activeSession._id === sessionId) {
                state.activeSession.questions = state.activeSession.questions.map((currentQ, index) => {
                    const incomingQ = session?.questions?.[index];
                    if (!incomingQ) return currentQ;
                    if (incomingQ.isEvaluated) return incomingQ;
                    if (currentQ.isSubmitted && !incomingQ.isSubmitted) return currentQ;
                    return incomingQ;
                });
                state.activeSession.overallScore = session.overallScore;
                state.activeSession.status = session.status;
                state.activeSession.metrics = session.metrics;
            }
        },
        setActiveSession: (state, action) => {
            state.activeSession = action.payload;
        }
    },
    extraReducers: (builder) => {
        builder
            .addCase(getSessions.pending, (state) => { state.isLoading = true; })
            .addCase(getSessions.fulfilled, (state, action) => {
                state.isLoading = false;
                state.sessions = action.payload;
            })
            .addCase(getSessions.rejected, (state, action) => {
                state.isLoading = false;
                state.isError = true;
                state.message = action.payload;
            })
            .addCase(createSession.pending, (state) => { state.isLoading = true; state.isGenerating = true; state.activeSession = null; })
            .addCase(createSession.fulfilled, (state) => { state.isLoading = false; })
            .addCase(createSession.rejected, (state, action) => {
                state.isLoading = false;
                state.isError = true;
                state.isGenerating = false;
                state.message = action.payload;
            })
            .addCase(getSessionById.fulfilled, (state, action) => {
                state.activeSession = action.payload;
            })
            .addCase(deleteSession.fulfilled, (state, action) => {
                state.isLoading = false;
                state.sessions = state.sessions.filter(s => s._id !== action.payload);
            })
            .addCase(submitAnswer.fulfilled, (state, action) => {
                state.isLoading = false;
                if (action.payload && Array.isArray(action.payload.questions)) {
                    state.activeSession = action.payload;
                }
            })
            .addCase(submitAnswer.rejected, (state, action) => {
                state.isError = true;
                state.message = action.payload;
            });
    }
})

export const { reset, socketUpdateSession, setActiveSession } = sessionSlice.actions;
export default sessionSlice.reducer;