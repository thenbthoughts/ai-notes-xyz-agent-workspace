import { Router, Request, Response } from 'express';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { accessSync, constants as fsConstants, readdirSync, readFileSync } from 'fs';

import middlewareShellEngineKey from '../../middleware/middlewareVerifyToken';
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

const XFCE_ENV_KEYS = [
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XDG_RUNTIME_DIR',
    'XDG_SESSION_TYPE',
    'DBUS_SESSION_BUS_ADDRESS',
    'XAUTHORITY',
    'SESSION_MANAGER',
    'HOME',
] as const;

function readProcEnviron(pid: number): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of readFileSync(`/proc/${pid}/environ`).toString('utf8').split('\0')) {
        const eq = part.indexOf('=');
        if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
    }
    return out;
}

async function xfceSessionEnv(): Promise<Record<string, string>> {
    try {
        const { stdout } = await execFileAsync('pgrep', ['-n', 'xfce4-session'], { timeout: 2000 });
        const pid = Number(String(stdout).trim());
        if (!Number.isFinite(pid) || pid <= 0) return {};
        const proc = readProcEnviron(pid);
        const picked: Record<string, string> = {};
        for (const key of XFCE_ENV_KEYS) {
            if (proc[key]) picked[key] = proc[key];
        }
        return picked;
    } catch {
        return {};
    }
}

async function desktopLaunchEnv(): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = { ...process.env, ...(await xfceSessionEnv()) };
    env.HOME = env.HOME && env.HOME !== '/' ? env.HOME : '/config';
    env.XDG_RUNTIME_DIR = env.XDG_RUNTIME_DIR || '/config/.XDG';

    const wayland = findWaylandDisplay(env.XDG_RUNTIME_DIR);
    if (wayland && !env.DISPLAY) {
        delete env.DISPLAY;
        env.XDG_SESSION_TYPE = 'wayland';
        env.GDK_BACKEND = 'wayland';
        env.WAYLAND_DISPLAY = wayland;
        return env;
    }

    env.DISPLAY = env.DISPLAY || guessX11Display();
    env.XDG_SESSION_TYPE = env.XDG_SESSION_TYPE || 'x11';
    env.GDK_BACKEND = env.GDK_BACKEND || 'x11';
    return env;
}

function findWaylandDisplay(runtimeDir: string): string | null {
    // labwc is wayland-1; selkies capture is wayland-0.
    for (const name of ['wayland-1', 'wayland-0']) {
        try {
            accessSync(path.join(runtimeDir, name), fsConstants.F_OK);
            return name;
        } catch {
            /* try next */
        }
    }
    return null;
}

function guessX11Display(): string {
    try {
        const sock = readdirSync('/tmp/.X11-unix').find((n) => /^X\d+$/.test(n));
        if (sock) return `:${sock.slice(1)}`;
    } catch {
        /* ignore */
    }
    const fromEnv = process.env.DISPLAY?.trim();
    return fromEnv || ':1';
}

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
