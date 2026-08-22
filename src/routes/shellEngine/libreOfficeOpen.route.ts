import { Router, Request, Response } from 'express';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';

import middlewareShellEngineKey from '../../middleware/middlewareVerifyToken';
import { desktopLaunchEnv } from './desktopLaunchEnv';
import {
    fileRelativePathMustIncludeShellSegment,
    resolveUnderSandbox,
    sanitizeRelativePath,
} from './shellEnginePaths';

const router = Router();
const execFileAsync = promisify(execFile);

/**
 * POST /api/shell-engine/libreoffice/open
 * Body JSON: { relativePath } — opens the file in the web-desktop LibreOffice.
 */
router.post('/open', middlewareShellEngineKey, async (req: Request, res: Response) => {
    try {
        const rel = sanitizeRelativePath(req.body?.relativePath as string);
        if (!rel.ok) {
            return res.status(400).json({ message: rel.message });
        }
        const segmentOk = fileRelativePathMustIncludeShellSegment(rel.value);
        if (!segmentOk.ok) {
            return res.status(400).json({ message: segmentOk.message });
        }
        const resolved = resolveUnderSandbox(rel.value);
        if (!resolved.ok) {
            return res.status(400).json({ message: resolved.message });
        }

        try {
            const st = await fs.stat(resolved.abs);
            if (!st.isFile()) {
                return res.status(400).json({ message: 'relativePath must be a file' });
            }
        } catch (err: unknown) {
            if (err && typeof err === 'object' && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
                return res.status(404).json({ message: 'File not found' });
            }
            throw err;
        }

        const relativePath = rel.value.split(/[/\\]/).join('/');
        const absolutePath = path.resolve(resolved.abs);
        await openFileOnDesktop(absolutePath);

        return res.status(200).json({
            message: `File opened: ${relativePath}`,
            relativePath,
            absolutePath,
        });
    } catch (error) {
        console.error(error);
        const err = error as Error;
        return res.status(500).json({
            message: 'Failed to open file',
            error: err.message,
        });
    }
});

async function isSofficeBinRunning(): Promise<boolean> {
    try {
        const { stdout } = await execFileAsync('pgrep', ['-x', 'soffice.bin'], { timeout: 3000 });
        return stdout.trim().length > 0;
    } catch {
        return false;
    }
}

async function clearStaleLibreOfficeIpc(): Promise<void> {
    if (await isSofficeBinRunning()) {
        return;
    }
    try {
        const names = await fs.readdir('/tmp');
        await Promise.all(
            names
                .filter((n) => n.startsWith('OSL_PIPE_'))
                .map((n) => fs.unlink(path.join('/tmp', n)).catch(() => undefined)),
        );
    } catch {
        /* ignore */
    }
}

async function clearStaleLockFile(absolutePath: string): Promise<void> {
    if (await isSofficeBinRunning()) {
        return;
    }
    const lockPath = path.join(path.dirname(absolutePath), `.~lock.${path.basename(absolutePath)}#`);
    try {
        await fs.unlink(lockPath);
    } catch {
        /* ignore */
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function raiseLibreOfficeWindows(env: NodeJS.ProcessEnv): Promise<void> {
    try {
        await execFileAsync(
            'xdotool',
            ['search', '--onlyvisible', '--class', 'soffice', 'windowraise', 'windowactivate'],
            { timeout: 4000, env },
        );
    } catch {
        try {
            await execFileAsync(
                'xdotool',
                ['search', '--name', 'LibreOffice', 'windowraise', 'windowactivate'],
                { timeout: 3000, env },
            );
        } catch {
            /* window may still be mapping */
        }
    }
}

function openFileOnDesktop(absolutePath: string): Promise<void> {
    return (async () => {
        await clearStaleLibreOfficeIpc();
        await clearStaleLockFile(absolutePath);
        const env = await desktopLaunchEnv();
        const child = spawn(
            'soffice',
            ['--norestore', '--nologo', '--nofirststartwizard', absolutePath],
            {
                env,
                detached: true,
                stdio: 'ignore',
            },
        );

        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => resolve(), 500);
            child.once('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });

        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
            if (await isSofficeBinRunning()) {
                await raiseLibreOfficeWindows(env);
                child.unref();
                return;
            }
            if (child.exitCode !== null) {
                throw new Error(`LibreOffice exited ${child.exitCode} without opening a window`);
            }
            await sleep(400);
        }

        if (await isSofficeBinRunning()) {
            await raiseLibreOfficeWindows(env);
            child.unref();
            return;
        }
        throw new Error('LibreOffice did not stay running on the desktop');
    })();
}

export default router;
