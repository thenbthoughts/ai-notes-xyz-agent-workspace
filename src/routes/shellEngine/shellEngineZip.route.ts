import { Router, Request, Response } from 'express';
import fileUpload from 'express-fileupload';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { Dirent } from 'fs';
import fs from 'fs/promises';

import middlewareShellEngineKey from '../../middleware/middlewareVerifyToken';
import { resolveSandboxDir, resolveUnderSandbox } from './shellEnginePaths';

const MAX_ZIP_UPLOAD_BYTES = 50 * 1024 * 1024;
const ZIP_CMD_TIMEOUT_MS = 120_000;
const ZIP_MAX_BYTES = 80 * 1024 * 1024;
const UNZIP_MAX_ENTRIES = 2000;

const router = Router();

router.use(
    fileUpload({
        limits: { fileSize: MAX_ZIP_UPLOAD_BYTES },
        abortOnLimit: true,
    }),
);

const spawnCapture = (
    cmd: string,
    args: string[],
    opts: { cwd?: string; timeoutMs?: number },
): Promise<{ code: number; stdout: Buffer; stderr: string }> =>
    new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            cwd: opts.cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
        }, opts.timeoutMs ?? ZIP_CMD_TIMEOUT_MS);
        child.stdout.on('data', (d: Buffer) => out.push(d));
        child.stderr.on('data', (d: Buffer) => err.push(d));
        child.on('error', (e) => {
            clearTimeout(timer);
            reject(e);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({
                code: code ?? 1,
                stdout: Buffer.concat(out),
                stderr: Buffer.concat(err).toString('utf8'),
            });
        });
    });

const tmpName = (prefix: string, ext: string): string =>
    path.join(os.tmpdir(), `${prefix}-${Date.now()}-${randomBytes(8).toString('hex')}${ext}`);

const dirHasFiles = async (absBase: string): Promise<boolean> => {
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
            if (ent.isFile()) return true;
            if (ent.isDirectory()) stack.push(path.join(dir, ent.name));
        }
    }
    return false;
};

const isSafeZipEntry = (name: string): boolean => {
    const n = name.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!n) return false;
    if (path.isAbsolute(name) || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false;
    if (n.split('/').some((s) => s === '..' || s === '')) return false;
    return true;
};

const listZipEntries = async (zipAbs: string): Promise<string[]> => {
    const listed = await spawnCapture('unzip', ['-Z1', zipAbs], { timeoutMs: 30_000 });
    if (listed.code !== 0) {
        throw new Error(listed.stderr.trim() || 'Failed to list zip contents');
    }
    return listed.stdout
        .toString('utf8')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
};

const zipDirectoryToTemp = async (sourceAbs: string): Promise<string> => {
    const tmp = tmpName('shell-zip', '.zip');
    try {
        const zipped = await spawnCapture('zip', ['-qr', tmp, '.'], {
            cwd: sourceAbs,
            timeoutMs: ZIP_CMD_TIMEOUT_MS,
        });
        if (zipped.code !== 0) {
            await fs.unlink(tmp).catch(() => undefined);
            throw new Error(zipped.stderr.trim() || `zip exited ${zipped.code}`);
        }
        const st = await fs.stat(tmp);
        if (st.size > ZIP_MAX_BYTES) {
            await fs.unlink(tmp).catch(() => undefined);
            throw new Error(`Zip is too large (max ${Math.floor(ZIP_MAX_BYTES / (1024 * 1024))} MB)`);
        }
        return tmp;
    } catch (e) {
        await fs.unlink(tmp).catch(() => undefined);
        throw e;
    }
};

const unzipArchive = async (zipAbs: string, destAbs: string): Promise<{ extracted: number }> => {
    const entries = await listZipEntries(zipAbs);
    if (entries.length === 0) {
        throw new Error('Zip is empty');
    }
    if (entries.length > UNZIP_MAX_ENTRIES) {
        throw new Error(`Zip has too many entries (max ${UNZIP_MAX_ENTRIES})`);
    }
    for (const name of entries) {
        if (!isSafeZipEntry(name)) {
            throw new Error(`Zip contains an unsafe path: ${name}`);
        }
    }
    await fs.mkdir(destAbs, { recursive: true });
    const extracted = await spawnCapture(
        'unzip',
        [
            '-o',
            '-qq',
            '-d',
            destAbs,
            zipAbs,
            '-x',
            '__MACOSX/*',
            '*/__MACOSX/*',
            '*.DS_Store',
            '*/.DS_Store',
            'Thumbs.db',
            '*/Thumbs.db',
        ],
        { timeoutMs: ZIP_CMD_TIMEOUT_MS },
    );
    if (extracted.code !== 0) {
        throw new Error(extracted.stderr.trim() || `unzip exited ${extracted.code}`);
    }
    const fileCount = entries.filter((n) => !n.endsWith('/')).length;
    return { extracted: fileCount };
};

const sendZipFile = (res: Response, tmpAbs: string, zipName: string): void => {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(zipName)}"`);
    res.sendFile(tmpAbs, (err) => {
        void fs.unlink(tmpAbs).catch(() => undefined);
        if (err && !res.headersSent) {
            res.status(500).json({ message: 'Failed to send zip' });
        }
    });
};

const zipErrorStatus = (msg: string): number =>
    /zip|unzip|unsafe|empty|too many|too large|ENOENT|not found|no files/i.test(msg) ? 400 : 500;

const assertZipFolder = async (
    source: { rel: string; abs: string },
): Promise<{ ok: true } | { ok: false; status: number; message: string }> => {
    const st = await fs.stat(source.abs).catch(() => null);
    if (!st) {
        return { ok: false, status: 404, message: 'Folder not found' };
    }
    if (!st.isDirectory()) {
        return { ok: false, status: 400, message: 'relativeDir must be a folder' };
    }
    if (!(await dirHasFiles(source.abs))) {
        return { ok: false, status: 400, message: 'This folder has no files to zip' };
    }
    return { ok: true };
};

/**
 * GET /api/shell-engine/zip?relativeDir=...
 * Create a zip of a folder with system `zip` and stream it.
 */
router.get('/', middlewareShellEngineKey, async (req: Request, res: Response) => {
    try {
        const source = resolveSandboxDir(
            typeof req.query.relativeDir === 'string' ? req.query.relativeDir : undefined,
            'relativeDir',
        );
        if (!source.ok) {
            return res.status(source.status).json({ message: source.message });
        }
        const folder = await assertZipFolder(source);
        if (!folder.ok) {
            return res.status(folder.status).json({ message: folder.message });
        }
        const tmp = await zipDirectoryToTemp(source.abs);
        const zipName = `${path.basename(source.rel) || 'folder'}.zip`;
        return sendZipFile(res, tmp, zipName);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to zip folder';
        const status = zipErrorStatus(msg);
        if (status === 500) console.error(err);
        return res.status(status).json({ message: status === 500 ? 'Server error' : msg });
    }
});

/**
 * POST /api/shell-engine/zip
 * Create a zip on disk. JSON: { relativeDir, destRelativePath }
 */
router.post('/', middlewareShellEngineKey, async (req: Request, res: Response) => {
    try {
        const source = resolveSandboxDir(
            typeof req.body?.relativeDir === 'string' ? req.body.relativeDir : undefined,
            'relativeDir',
        );
        if (!source.ok) {
            return res.status(source.status).json({ message: source.message });
        }
        const dest = resolveSandboxDir(
            typeof req.body?.destRelativePath === 'string' ? req.body.destRelativePath : undefined,
            'destRelativePath',
        );
        if (!dest.ok) {
            return res.status(dest.status).json({ message: dest.message });
        }
        const folder = await assertZipFolder(source);
        if (!folder.ok) {
            return res.status(folder.status).json({ message: folder.message });
        }
        const destRel = dest.rel.toLowerCase().endsWith('.zip') ? dest.rel : `${dest.rel}.zip`;
        const destResolved = resolveUnderSandbox(destRel);
        if (!destResolved.ok) {
            return res.status(400).json({ message: destResolved.message });
        }
        const tmp = await zipDirectoryToTemp(source.abs);
        try {
            await fs.mkdir(path.dirname(destResolved.abs), { recursive: true });
            await fs.copyFile(tmp, destResolved.abs);
        } finally {
            await fs.unlink(tmp).catch(() => undefined);
        }
        const written = await fs.stat(destResolved.abs);
        return res.status(201).json({
            message: `Zipped ${source.rel} → ${destRel}`,
            relativePath: destRel,
            absolutePath: path.resolve(destResolved.abs),
            size: written.size,
        });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to zip folder';
        const status = zipErrorStatus(msg);
        if (status === 500) console.error(err);
        return res.status(status).json({ message: status === 500 ? 'Server error' : msg });
    }
});

/**
 * POST /api/shell-engine/zip/extract
 * Extract with system `unzip`. destRelativeDir + relativePath, or destRelativeDir + file.
 */
router.post('/extract', middlewareShellEngineKey, async (req: Request, res: Response) => {
    let tmpZip = '';
    try {
        const dest = resolveSandboxDir(
            typeof req.body?.destRelativeDir === 'string' ? req.body.destRelativeDir : undefined,
            'destRelativeDir',
        );
        if (!dest.ok) {
            return res.status(dest.status).json({ message: dest.message });
        }

        const uploaded = req.files?.file as fileUpload.UploadedFile | fileUpload.UploadedFile[] | undefined;
        const file = Array.isArray(uploaded) ? uploaded[0] : uploaded;
        const rawZipPath = typeof req.body?.relativePath === 'string' ? req.body.relativePath : '';

        let zipAbs = '';
        if (file && file.data) {
            tmpZip = tmpName('shell-unzip', '.zip');
            await fs.writeFile(tmpZip, file.data);
            zipAbs = tmpZip;
        } else if (rawZipPath) {
            const zip = resolveSandboxDir(rawZipPath, 'relativePath');
            if (!zip.ok) {
                return res.status(zip.status).json({ message: zip.message });
            }
            const zipSt = await fs.stat(zip.abs).catch(() => null);
            if (!zipSt || !zipSt.isFile()) {
                return res.status(404).json({ message: 'Zip file not found' });
            }
            zipAbs = zip.abs;
        } else {
            return res.status(400).json({ message: 'Provide relativePath or upload file' });
        }

        const result = await unzipArchive(zipAbs, dest.abs);
        return res.json({
            message: `Extracted ${result.extracted} file(s) into ${dest.rel}`,
            destRelativeDir: dest.rel,
            extracted: result.extracted,
        });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to unzip';
        const status = zipErrorStatus(msg);
        if (status === 500) console.error(err);
        return res.status(status).json({ message: status === 500 ? 'Server error' : msg });
    } finally {
        if (tmpZip) {
            await fs.unlink(tmpZip).catch(() => undefined);
        }
    }
});

/**
 * DELETE /api/shell-engine/zip
 * Delete a .zip file. JSON or query: { relativePath }
 */
router.delete('/', middlewareShellEngineKey, async (req: Request, res: Response) => {
    try {
        const raw =
            typeof req.body?.relativePath === 'string'
                ? req.body.relativePath
                : typeof req.query.relativePath === 'string'
                  ? req.query.relativePath
                  : undefined;
        const zip = resolveSandboxDir(raw, 'relativePath');
        if (!zip.ok) {
            return res.status(zip.status).json({ message: zip.message });
        }
        if (!zip.rel.toLowerCase().endsWith('.zip')) {
            return res.status(400).json({ message: 'relativePath must be a .zip file' });
        }
        const st = await fs.stat(zip.abs).catch(() => null);
        if (!st) {
            return res.status(404).json({ message: 'Zip file not found' });
        }
        if (!st.isFile()) {
            return res.status(400).json({ message: 'relativePath must be a .zip file' });
        }
        await fs.rm(zip.abs, { force: true });
        return res.json({
            message: `Deleted: ${zip.rel}`,
            relativePath: zip.rel,
        });
    } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
            return res.status(404).json({ message: 'Zip file not found' });
        }
        console.error(err);
        return res.status(500).json({ message: 'Server error' });
    }
});

export default router;
