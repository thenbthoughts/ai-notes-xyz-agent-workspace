import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { accessSync, constants as fsConstants, readdirSync, readFileSync } from 'fs';

const execFileAsync = promisify(execFile);

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

/** Env so a GUI process lands on the Selkies / XFCE desktop (not a headless DISPLAY). */
export async function desktopLaunchEnv(): Promise<NodeJS.ProcessEnv> {
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
