const normalizeScoreValue = (value) => {
    if (value === null || value === undefined || value === '') return 0;

    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return 0;
        return value > 100 ? Math.min(value, 100) : value;
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return 0;

        const slashMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/i);
        if (slashMatch) {
            const numerator = Number(slashMatch[1]);
            const denominator = Number(slashMatch[2]);
            if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
            const percent = (numerator / denominator) * 100;
            return percent > 100 ? 100 : percent;
        }

        const outOfMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*out\s+of\s+(\d+(?:\.\d+)?)$/i);
        if (outOfMatch) {
            const numerator = Number(outOfMatch[1]);
            const denominator = Number(outOfMatch[2]);
            if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
            const percent = (numerator / denominator) * 100;
            return percent > 100 ? 100 : percent;
        }

        const parsed = Number(trimmed);
        if (Number.isFinite(parsed)) {
            if (parsed > 10 && parsed <= 100) return parsed;
            if (parsed >= 0 && parsed <= 10) return parsed * 10;
            return parsed;
        }

        return 0;
    }

    return 0;
};

export { normalizeScoreValue };
