import { Router, Request, Response } from 'express';
import fileUpload from 'express-fileupload';
import { lookup } from 'mime-types';
import path from 'path';
import { Dirent } from 'fs';
import fs from 'fs/promises';

import middlewareShellEngineKey from '../../middleware/middlewareVerifyToken';
import {
    REQUIRED_FILE_PATH_SEGMENT,
    fileRelativePathMustIncludeShellSegment,
    resolveUnderSandbox,
    sanitizeRelativePath,
} from './shellEnginePaths';

const MAX_LOCAL_FILE_BYTES = 50 * 1024 * 1024;
const LIST_MAX_FILES_CAP = 500;
const LIST_DEFAULT_MAX_FILES = 300;
const LIST_DEFAULT_MAX_DEPTH = 24;
const LS_MAX_CHILDREN = 2000;
const LS_COUNT_MAX_NODES = 20_000;

const router = Router();

router.use(
    fileUpload({
        limits: { fileSize: MAX_LOCAL_FILE_BYTES },
        abortOnLimit: true,
    }),
);

router.post('/write', middlewareShellEngineKey, async (req: Request, res: Response) => {
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
        if (!req.files || Object.keys(req.files).length === 0) {
            return res.status(400).json({ message: 'No file uploaded' });
        }
        const file = req.files.file as fileUpload.UploadedFile;
        if (Array.isArray(file)) {
            return res.status(400).json({ message: 'Only one file can be uploaded at a time' });
        }
        await fs.mkdir(path.dirname(resolved.abs), { recursive: true });
        await fs.writeFile(resolved.abs, file.data);
        const relativePath = rel.value.split(/[/\\]/).join('/');
        const absolutePath = path.resolve(resolved.abs);
        return res.status(201).json({
            message: `File written: ${relativePath}`,
            relativePath,
            absolutePath,
            size: file.size,
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Server error' });
    }
});

async function walkFilesRecursive(params: {
    relBase: string;
    absBase: string;
    maxFiles: number;
    maxDepth: number;
    depth: number;
    out: { relativePath: string; size: number; mtimeMs: number }[];
}): Promise<void> {
    const { relBase, absBase, maxFiles, maxDepth, depth, out } = params;
    if (out.length >= maxFiles || depth > maxDepth) {
        return;
    }
    try {
        const entries = await fs.readdir(absBase, { withFileTypes: true });
        for (const ent of entries) {
            if (out.length >= maxFiles) {
                return;
            }
            const name = typeof ent.name === 'string' ? ent.name : String(ent.name);
            const rel = `${relBase}/${name}`.replace(/\\/g, '/');
            const abs = path.join(absBase, name);
            if (ent.isSymbolicLink()) {
                continue;
            }
            if (ent.isDirectory()) {
                await walkFilesRecursive({
                    relBase: rel,
                    absBase: abs,
                    maxFiles,
                    maxDepth,
                    depth: depth + 1,
                    out,
                });
            } else if (ent.isFile()) {
                const st = await fs.stat(abs);
                out.push({
                    relativePath: rel,
                    size: st.size,
                    mtimeMs: st.mtimeMs,
                });
            }
        }
    } catch (e: unknown) {
        if (e && typeof e === 'object' && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT') {
            return;
        }
        throw e;
    }
}

router.get('/list', middlewareShellEngineKey, async (req: Request, res: Response) => {
    try {
        const rawDir =
            typeof req.query.relativeDir === 'string' && req.query.relativeDir.trim() !== ''
                ? req.query.relativeDir
                : REQUIRED_FILE_PATH_SEGMENT;
        const rel = sanitizeRelativePath(rawDir);
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

        let maxFiles = LIST_DEFAULT_MAX_FILES;
        if (req.query.maxFiles !== undefined) {
            const n = Number(req.query.maxFiles);
            if (Number.isFinite(n) && n >= 1) {
                maxFiles = Math.min(LIST_MAX_FILES_CAP, Math.floor(n));
            }
        }
        let maxDepth = LIST_DEFAULT_MAX_DEPTH;
        if (req.query.maxDepth !== undefined) {
            const n = Number(req.query.maxDepth);
            if (Number.isFinite(n) && n >= 0) {
                maxDepth = Math.min(64, Math.floor(n));
            }
        }

        const relNorm = rel.value.split(/[/\\]/).join('/');
        const out: { relativePath: string; size: number; mtimeMs: number }[] = [];
        await walkFilesRecursive({
            relBase: relNorm.replace(/\/+$/, '') || relNorm,
            absBase: resolved.abs,
            maxFiles,
            maxDepth,
            depth: 0,
            out,
        });
        return res.json({ files: out });
    } catch (err: unknown) {
        console.error(err);
        return res.status(500).json({ message: 'Server error' });
    }
});

async function countNestedTree(
    absBase: string,
    maxNodes: number,
): Promise<{ files: number; folders: number; truncated: boolean }> {
    let files = 0;
    let folders = 0;
    let seen = 0;
    const stack = [absBase];
    while (stack.length > 0) {
        const dir = stack.pop() as string;
        let entries: Dirent[];
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const ent of entries) {
            if (ent.isSymbolicLink()) continue;
            seen += 1;
            if (seen > maxNodes) {
                return { files, folders, truncated: true };
            }
            if (ent.isDirectory()) {
                folders += 1;
                stack.push(path.join(dir, ent.name));
            } else if (ent.isFile()) {
                files += 1;
            }
        }
    }
    return { files, folders, truncated: false };
}

/**
 * GET /api/shell-engine/file/ls
 * Immediate children only (like `ls`), with nested file/folder counts per directory.
 */
router.get('/ls', middlewareShellEngineKey, async (req: Request, res: Response) => {
    try {
        const rawDir =
            typeof req.query.relativeDir === 'string' && req.query.relativeDir.trim() !== ''
                ? req.query.relativeDir
                : REQUIRED_FILE_PATH_SEGMENT;
        const rel = sanitizeRelativePath(rawDir);
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

        const relNorm = rel.value.split(/[/\\]/).join('/').replace(/\/+$/, '') || rel.value;
        let dirEntries: Dirent[];
        try {
            dirEntries = await fs.readdir(resolved.abs, { withFileTypes: true });
        } catch (e: unknown) {
            if (e && typeof e === 'object' && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT') {
                return res.json({ relativeDir: relNorm, entries: [] });
            }
            throw e;
        }

        const entries: {
            relativePath: string;
            name: string;
            isDir: boolean;
            size: number;
            mtimeMs: number;
            fileCount?: number;
            folderCount?: number;
            truncated?: boolean;
        }[] = [];

        for (const ent of dirEntries) {
            if (entries.length >= LS_MAX_CHILDREN) break;
            if (ent.isSymbolicLink()) continue;
            const name = typeof ent.name === 'string' ? ent.name : String(ent.name);
            const relPath = `${relNorm}/${name}`.replace(/\\/g, '/');
            const abs = path.join(resolved.abs, name);
            let st: Awaited<ReturnType<typeof fs.stat>>;
            try {
                st = await fs.stat(abs);
            } catch {
                continue;
            }
            if (ent.isDirectory()) {
                const nested = await countNestedTree(abs, LS_COUNT_MAX_NODES);
                entries.push({
                    relativePath: relPath,
                    name,
                    isDir: true,
                    size: 0,
                    mtimeMs: st.mtimeMs,
                    fileCount: nested.files,
                    folderCount: nested.folders,
                    truncated: nested.truncated,
                });
            } else if (ent.isFile()) {
                entries.push({
                    relativePath: relPath,
                    name,
                    isDir: false,
                    size: st.size,
                    mtimeMs: st.mtimeMs,
                });
            }
        }

        entries.sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name);
        });

        return res.json({ relativeDir: relNorm, entries });
    } catch (err: unknown) {
        console.error(err);
        return res.status(500).json({ message: 'Server error' });
    }
});

router.get('/read', middlewareShellEngineKey, async (req: Request, res: Response) => {
    try {
        const rel = sanitizeRelativePath(req.query.relativePath as string);
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
        const data = await fs.readFile(resolved.abs);
        const contentType = lookup(resolved.abs) || 'application/octet-stream';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `inline; filename="${path.basename(resolved.abs)}"`);
        return res.send(data);
    } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
            return res.status(404).json({ message: 'File not found' });
        }
        console.error(err);
        return res.status(500).json({ message: 'Server error' });
    }
});

const BLOCKED_DELETE_ROOTS = new Set([
    REQUIRED_FILE_PATH_SEGMENT,
    `${REQUIRED_FILE_PATH_SEGMENT}/shell`,
    `${REQUIRED_FILE_PATH_SEGMENT}/features`,
]);

router.post('/delete', middlewareShellEngineKey, async (req: Request, res: Response) => {
    try {
        const rel = sanitizeRelativePath(req.body?.relativePath as string);
        if (!rel.ok) {
            return res.status(400).json({ message: rel.message });
        }
        const relNorm = rel.value.split(/[/\\]/).join('/').replace(/\/+$/, '');
        if (BLOCKED_DELETE_ROOTS.has(relNorm)) {
            return res.status(400).json({ message: 'Cannot delete the workspace root' });
        }
        const segmentOk = fileRelativePathMustIncludeShellSegment(relNorm);
        if (!segmentOk.ok) {
            return res.status(400).json({ message: segmentOk.message });
        }
        const resolved = resolveUnderSandbox(relNorm);
        if (!resolved.ok) {
            return res.status(400).json({ message: resolved.message });
        }
        try {
            await fs.access(resolved.abs);
        } catch {
            return res.status(404).json({ message: 'File not found' });
        }
        await fs.rm(resolved.abs, { recursive: true, force: true });
        return res.json({
            message: `Deleted: ${relNorm}`,
            relativePath: relNorm,
        });
    } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
            return res.status(404).json({ message: 'File not found' });
        }
        console.error(err);
        return res.status(500).json({ message: 'Server error' });
    }
});

export default router;
