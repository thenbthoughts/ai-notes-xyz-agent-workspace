import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';

import envKeys from '../config/envKeys';

function safeKeyEqual(provided: string, expected: string): boolean {
    try {
        const a = Buffer.from(provided, 'utf8');
        const b = Buffer.from(expected, 'utf8');
        if (a.length !== b.length) {
            return false;
        }
        return timingSafeEqual(a, b);
    } catch {
        return false;
    }
}

function headerString(v: string | string[] | undefined): string | undefined {
    if (typeof v === 'string') {
        return v;
    }
    if (Array.isArray(v) && typeof v[0] === 'string') {
        return v[0];
    }
    return undefined;
}

/**
 * Send `X-API-Token: <same value as process.env.API_TOKEN>`.
 */
const middlewareShellEngineKey = (req: Request, res: Response, next: NextFunction) => {
    try {
        const expected = envKeys.API_TOKEN;
        if (!expected) {
            return res.status(503).json({
                message: 'API_TOKEN is not configured',
            });
        }

        const provided = headerString(req.headers['x-api-token']);
        if (!provided || !safeKeyEqual(provided, expected)) {
            return res.status(401).json({ message: 'Invalid or missing API token' });
        }

        next();
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Server error' });
    }
};

export default middlewareShellEngineKey;
