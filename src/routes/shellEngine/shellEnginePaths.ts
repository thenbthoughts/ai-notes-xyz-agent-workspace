import path from 'path';

import envKeys from '../../config/envKeys';

export const WORKSPACE_ROOT = 'ai-notes-xyz-agent-workspace';
export const SHELL_FOLDER = 'shell';
export const FEATURES_FOLDER = 'features';

/** Default list/ls directory (workspace root). */
export const REQUIRED_FILE_PATH_SEGMENT = WORKSPACE_ROOT;

export function shellEngineDataRoot(): string {
    return envKeys.FILE_STORAGE_PATH;
}

export function sanitizeRelativePath(
    raw: string | undefined,
): { ok: true; value: string } | { ok: false; message: string } {
    if (typeof raw !== 'string' || raw.trim() === '') {
        return { ok: false, message: 'relativePath is required' };
    }
    const normalized = path.normalize(raw.trim());
    if (path.isAbsolute(normalized)) {
        return { ok: false, message: 'relativePath must be relative' };
    }
    const segments = normalized.split(/[/\\]/).filter((s) => s.length > 0);
    if (segments.some((s) => s === '..')) {
        return { ok: false, message: 'relativePath must not contain ..' };
    }
    return { ok: true, value: normalized };
}

export function fileRelativePathMustIncludeShellSegment(
    relativePath: string,
): { ok: true } | { ok: false; message: string } {
    const normalized = relativePath.split(/[/\\]/).join('/');
    const segments = normalized.split('/').filter((s) => s.length > 0);
    if (segments[0] !== WORKSPACE_ROOT) {
        return {
            ok: false,
            message:
                `relativePath must be under "${WORKSPACE_ROOT}/shell/..." ` +
                `or "${WORKSPACE_ROOT}/features/..."`,
        };
    }
    if (segments.length === 1) {
        return { ok: true };
    }
    if (segments[1] === SHELL_FOLDER || segments[1] === FEATURES_FOLDER) {
        return { ok: true };
    }
    return {
        ok: false,
        message:
            `relativePath must be under "${WORKSPACE_ROOT}/shell/..." ` +
            `or "${WORKSPACE_ROOT}/features/..."`,
    };
}

export function resolveUnderSandbox(
    relativePath: string,
): { ok: true; abs: string } | { ok: false; message: string } {
    const base = path.resolve(shellEngineDataRoot());
    const abs = path.resolve(base, relativePath);
    const rel = path.relative(base, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return { ok: false, message: 'Path escapes user sandbox' };
    }
    return { ok: true, abs };
}

export function resolveSandboxDir(
    raw: string | undefined,
    field: string,
): { ok: true; rel: string; abs: string } | { ok: false; status: number; message: string } {
    const rel = sanitizeRelativePath(raw);
    if (!rel.ok) {
        return { ok: false, status: 400, message: `${field}: ${rel.message}` };
    }
    const relNorm = rel.value.split(/[/\\]/).join('/').replace(/\/+$/, '');
    const segmentOk = fileRelativePathMustIncludeShellSegment(relNorm);
    if (!segmentOk.ok) {
        return { ok: false, status: 400, message: segmentOk.message };
    }
    const resolved = resolveUnderSandbox(relNorm);
    if (!resolved.ok) {
        return { ok: false, status: 400, message: resolved.message };
    }
    return { ok: true, rel: relNorm, abs: resolved.abs };
}
