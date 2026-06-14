import { useEffect } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { useParams, Link } from 'react-router-dom';
import { getSessionById } from '../features/sessions/sessionSlice';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Tooltip, Legend } from 'chart.js';
import { Bar } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

const formatDuration = (start, end) => {
    if (!start || !end) return 'N/A';
    const diff = new Date(end) - new Date(start);
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
};

const sanitizeQuestionText = (text) => {
    return text ? text.replace(/^\d+[\s\.\)]+/, '').trim() : "Untitled Question";
};

const formatIdealAnswer = (text) => {
    try {
        if (!text) return "Pending evaluation.";
        let cleanText = typeof text === 'string' ? text.trim() : JSON.stringify(text);

        if (cleanText.startsWith('```')) {
            cleanText = cleanText.replace(/^```(json|java|javascript)?/, '').replace(/```$/, '').trim();
        }

        if (cleanText.startsWith('{') && cleanText.endsWith('}')) {
            const parsed = JSON.parse(cleanText);
            return parsed.verbalAnswer || parsed.idealAnswer || parsed.explanation || JSON.stringify(parsed, null, 2);
        }

        return cleanText;
    } catch (e) {
        return text;
    }
};

function SessionReview() {
    const { sessionId } = useParams();
    const dispatch = useDispatch();
    const { activeSession, isLoading } = useSelector(state => state.sessions);

    useEffect(() => {
        if (sessionId) {
            dispatch(getSessionById(sessionId));
        }
    }, [dispatch, sessionId]);

    if (isLoading) return <div className="text-center py-20 font-bold text-slate-400 animate-pulse uppercase tracking-widest">Generating Analysis...</div>;

    // Modified condition to allow viewing if status is 'completed' or even if just data exists
    if (!activeSession) {
        return (
            <div className="max-w-xl mx-auto mt-20 p-10 bg-white rounded-[2.5rem] shadow-2xl text-center border border-slate-100">
                <h2 className="text-2xl font-black text-slate-800 mb-4 uppercase">Report Not Found</h2>
                <Link to="/" className="inline-block bg-teal-600 text-white px-8 py-3 rounded-2xl font-black uppercase tracking-widest hover:bg-teal-700">Dashboard</Link>
            </div>
        );
    }

    const { overallScore, metrics, role, level, questions = [], startTime, endTime } = activeSession;
    const finalMetrics = metrics || { avgTechnical: 0, avgConfidence: 0 };

    const barData = {
        labels: questions.map((_, i) => `Q${i + 1}`),
        datasets: [{
            label: 'Technical Score',
            data: questions.map(q => q.technicalScore || 0),
            backgroundColor: questions.map(q => (q.technicalScore || 0) > 70 ? '#10b981' : '#f59e0b'),
            borderRadius: 8,
        }],
    };

    return (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12 space-y-12 animate-in fade-in duration-700">
            <div className="flex justify-between items-end border-b border-slate-100 pb-10">
                <div>
                    <span className="text-teal-600 font-black uppercase tracking-[0.2em] text-[10px]">Assessment Complete</span>
                    <h1 className="text-5xl font-black text-slate-900 tracking-tight mt-2 uppercase">
                        {role || 'Interview'} <span className="text-slate-300 font-medium lowercase text-2xl">{level}</span>
                    </h1>
                </div>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {[
                    { label: 'Overall Result', value: `${overallScore || 0}%`, color: 'teal' },
                    { label: 'Avg Technical', value: `${finalMetrics.avgTechnical || 0}%`, color: 'slate' },
                    { label: 'Avg Confidence', value: `${finalMetrics.avgConfidence || 0}%`, color: 'slate' },
                    { label: 'Session Time', value: formatDuration(startTime, endTime), color: 'slate' }
                ].map((stat, i) => (
                    <div key={i} className={`bg-white p-8 rounded-[2.5rem] shadow-sm border-l-[8px] ${stat.color === 'teal' ? 'border-teal-500' : 'border-slate-100'}`}>
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.1em]">{stat.label}</p>
                        <p className={`text-4xl font-black mt-2 ${stat.color === 'teal' ? 'text-teal-600' : 'text-slate-800'}`}>{stat.value}</p>
                    </div>
                ))}
            </div>

            <div className="bg-white p-10 rounded-[3rem] shadow-sm border border-slate-50">
                <h3 className="text-[10px] font-black text-slate-400 mb-6 uppercase tracking-[0.2em]">Per-Question Performance</h3>
                <div className="h-80">
                    <Bar data={barData} options={{ maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, max: 100 } } }} />
                </div>
            </div>

            <div className="space-y-10">
                {questions.map((q, index) => (
                    <div key={index} className="bg-white rounded-[3rem] border border-slate-100 shadow-sm p-10 space-y-8">
                        <h4 className="text-2xl font-bold text-slate-800">
                            <span className="text-teal-500 mr-2 font-black italic">Q{index + 1}.</span> {sanitizeQuestionText(q.questionText)}
                        </h4>
                        
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
                            <div className="space-y-3">
                                <label className="text-[10px] font-black text-slate-300 uppercase block ml-1">Your Submission</label>
                                <div className="bg-slate-50 p-6 rounded-[2rem]">
                                    {q.userSubmittedCode && <pre className="text-xs font-mono text-slate-700 whitespace-pre-wrap">{q.userSubmittedCode}</pre>}
                                    <p className="text-sm text-slate-600 italic mt-2">"{q.userAnswerText}"</p>
                                </div>
                            </div>
                            <div className="space-y-3">
                                <label className="text-[10px] font-black text-slate-300 uppercase block ml-1">AI Feedback</label>
                                <div className="bg-teal-50 p-6 rounded-[2rem] text-sm text-slate-700 italic">{q.aiFeedback}</div>
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

export default SessionReview;