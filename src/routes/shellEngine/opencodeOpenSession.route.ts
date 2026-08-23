import { Router, Request, Response } from 'express';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';

import middlewareShellEngineKey from '../../middleware/middlewareVerifyToken';
import { desktopLaunchEnv } from './desktopLaunchEnv';
import {
    fileRelativePathMustIncludeShellSegment,
    resolveUnderSandbox,
    sanitizeRelativePath,
} from './shellEnginePaths';

const router = Router();
const execFileAsync = promisify(execFile);

const OPENCODE_DIR_PREFIX = 'ai-notes-xyz-agent-workspace/shell/agent-opencode/';
const SESSION_ID_RE = /^ses_[A-Za-z0-9_-]+$/;
const LAUNCH_SCRIPT_NAME = '.opencode-open-session.sh';

const TERMINAL_CANDIDATES = [
    '/usr/bin/xfce4-terminal',
    '/usr/bin/xterm',
    '/usr/bin/x-terminal-emulator',
];

const shellSingleQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

function resolveTerminalBin(): string | null {
    for (const bin of TERMINAL_CANDIDATES) {
        if (existsSync(bin)) return bin;
    }
    return null;
}

function terminalArgs(bin: string, cwd: string, scriptPath: string): string[] {
    const name = path.basename(bin);
    if (name.includes('xfce4-terminal')) {
        return [
            '--title=OpenCode session',
            `--working-directory=${cwd}`,
            '-e',
            `bash ${shellSingleQuote(scriptPath)}`,
        ];
    }
    return ['-T', 'OpenCode session', '-e', 'bash', scriptPath];
}

function assertOpencodeWorkspaceDir(
    relativeDir: string
): { ok: true } | { ok: false; message: string } {
    const normalized = relativeDir.split(/[/\\]/).join('/').replace(/\/+$/, '');
    if (!normalized.startsWith(OPENCODE_DIR_PREFIX)) {
        return {
            ok: false,
            message: `relativeDir must be under ${OPENCODE_DIR_PREFIX}`,
        };
    }
    if (normalized.includes('..')) {
        return { ok: false, message: 'relativeDir must not contain ..' };
    }
    return { ok: true };
}

function writeLaunchScript(params: {
    absDir: string;
    sessionId: string;
}): string {
    const { absDir, sessionId } = params;
    const sessionLine = sessionId
        ? `exec opencode --session ${shellSingleQuote(sessionId)} --dir "$WORKDIR"`
        : 'exec opencode --dir "$WORKDIR"';
    return [
        '#!/bin/bash',
        'set -e',
        'export PATH="/root/.opencode/bin:/config/.opencode/bin:/usr/local/bin:$PATH"',
        `export WORKDIR=${shellSingleQuote(absDir)}`,
        'cd "$WORKDIR"',
        'export HOME="$WORKDIR"',
        'export XDG_CONFIG_HOME="$WORKDIR/.xdg-config"',
        'export XDG_DATA_HOME="$WORKDIR/.xdg-data"',
        'export OPENCODE_DISABLE_AUTOUPDATE=1',
        'mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"',
        'set -a',
        'if [ -f .env ]; then . ./.env; fi',
        'set +a',
        sessionLine,
        '',
    ].join('\n');
}

async function raiseOpencodeTerminal(env: NodeJS.ProcessEnv): Promise<void> {
    try {
        await execFileAsync(
            'xdotool',
            ['search', '--onlyvisible', '--name', 'OpenCode session', 'windowraise', 'windowactivate'],
            { timeout: 4000, env }
        );
    } catch {
        /* window may still be mapping */
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST /api/shell-engine/opencode/open-session
 * Body JSON: { relativeDir, sessionId? } — opens OpenCode TUI on the web desktop.
 */
router.post('/open-session', middlewareShellEngineKey, async (req: Request, res: Response) => {
    try {
        const rel = sanitizeRelativePath(req.body?.relativeDir as string);
        if (!rel.ok) {
            return res.status(400).json({ message: rel.message });
        }
        const segmentOk = fileRelativePathMustIncludeShellSegment(rel.value);
        if (!segmentOk.ok) {
            return res.status(400).json({ message: segmentOk.message });
        }
        const prefixOk = assertOpencodeWorkspaceDir(rel.value);
        if (!prefixOk.ok) {
            return res.status(400).json({ message: prefixOk.message });
        }
        const resolved = resolveUnderSandbox(rel.value);
        if (!resolved.ok) {
            return res.status(400).json({ message: resolved.message });
        }

        try {
            const st = await fs.stat(resolved.abs);
            if (!st.isDirectory()) {
                return res.status(400).json({ message: 'relativeDir must be a directory' });
            }
        } catch (err: unknown) {
            if (err && typeof err === 'object' && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
                return res.status(404).json({ message: 'Agent (Opencode) workspace folder not found' });
            }
            throw err;
        }

        const rawSession = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
        const sessionId = SESSION_ID_RE.test(rawSession) ? rawSession : '';

        const terminalBin = resolveTerminalBin();
        if (!terminalBin) {
            return res.status(500).json({
                message: 'No desktop terminal found (xfce4-terminal or xterm)',
            });
        }

        const absDir = path.resolve(resolved.abs);
        const scriptPath = path.join(absDir, LAUNCH_SCRIPT_NAME);
        await fs.writeFile(scriptPath, writeLaunchScript({ absDir, sessionId }), {
            encoding: 'utf8',
            mode: 0o755,
        });

        const env = await desktopLaunchEnv();
        const args = terminalArgs(terminalBin, absDir, scriptPath);
        const child = spawn(terminalBin, args, {
            env,
            detached: true,
            stdio: 'ignore',
            cwd: absDir,
        });

        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => resolve(), 500);
            child.once('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });

        await sleep(600);
        await raiseOpencodeTerminal(env);
        child.unref();

        const relativeDir = rel.value.split(/[/\\]/).join('/');
        // Build Opencode web UI URL: http://localhost:4096/server/<base64(serverUrl)>/session/<id>
        // Server URL is always http://localhost:4096 inside container; base64 without padding matches example
        const serverUrl = `http://localhost:${process.env.OPENCODE_PORT || 4096}`;
        const base64Server = Buffer.from(serverUrl).toString('base64').replace(/=+$/, '');
        const webUrl = sessionId
            ? `http://localhost:${process.env.OPENCODE_PORT || 4096}/server/${base64Server}/session/${sessionId}`
            : `http://localhost:${process.env.OPENCODE_PORT || 4096}/`;
        return res.status(200).json({
            message: sessionId
                ? `Opened OpenCode session ${sessionId}`
                : 'Opened OpenCode in the thread workspace',
            relativeDir,
            sessionId,
            webUrl,
            base64Server,
        });
    } catch (error) {
        console.error(error);
        const err = error as Error;
        return res.status(500).json({
            message: 'Failed to open OpenCode session on the desktop',
            error: err.message,
        });
    }
});

export default router;
