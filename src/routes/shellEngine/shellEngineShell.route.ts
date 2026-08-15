import { Router, Request, Response } from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import middlewareShellEngineKey from '../../middleware/middlewareVerifyToken';

const router = Router();
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
const execAsync = promisify(exec);

router.post('/execute', middlewareShellEngineKey, async (req: Request, res: Response) => {
    try {
        const {
            command,
            timeoutMs,
        } = req.body;
        console.log('execute command: ', new Date().toISOString(), '. command=', command, '. with timeout.', timeoutMs);

        if (typeof command !== 'string' || command.trim().length === 0) {
            return res.status(400).json({ message: 'A non-empty command string is required' });
        }

        const parsedTimeoutMs = Number(timeoutMs);
        const effectiveTimeoutMs = Number.isFinite(parsedTimeoutMs)
            ? Math.min(Math.max(parsedTimeoutMs, 1), MAX_TIMEOUT_MS)
            : DEFAULT_TIMEOUT_MS;

        try {
            const { stdout, stderr } = await execAsync(command, { timeout: effectiveTimeoutMs });

            if (stderr!=='') {
                return res.status(400).json({
                    message: 'Command execution failed',
                    error: 'Command execution failed',
                    stdout,
                    stderr,
                });
            }

            return res.status(200).json({
                message: 'Command executed successfully',
                stdout,
                stderr,
            });
        } catch (error) {
            const executionError = error as Error & { stdout?: string; stderr?: string };
            return res.status(400).json({
                message: 'Command execution failed',
                error: executionError.message,
                stdout: executionError.stdout ?? '',
                stderr: executionError.stderr ?? '',
            });
        }
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Server error' });
    }
});

export default router;
