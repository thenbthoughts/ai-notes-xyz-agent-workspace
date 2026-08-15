import { Router, Request, Response } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';

import middlewareShellEngineKey from '../../middleware/middlewareVerifyToken';
import {
    fileRelativePathMustIncludeShellSegment,
    resolveUnderSandbox,
    sanitizeRelativePath,
} from './shellEnginePaths';

const router = Router();
const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 180_000;

/** Common LibreOffice export targets (filter names accepted by --convert-to). */
const ALLOWED_FORMATS = new Set([
    'pdf',
    'docx',
    'odt',
    'doc',
    'rtf',
    'txt',
    'html',
    'epub',
    'xlsx',
    'ods',
    'csv',
    'pptx',
    'odp',
    'png',
    'jpg',
]);

function findSofficeBin(): string {
    return process.env.LIBREOFFICE_BIN || 'soffice';
}

/**
 * POST /api/shell-engine/libreoffice/convert
 * Body JSON:
 *   relativePath — input under ai-notes-xyz-agent-workspace/shell/ or .../features/
 *   format — e.g. pdf, docx, odt (default pdf)
 *   outputRelativeDir — optional output dir (default: same dir as input)
 *   timeoutMs — optional
 */
router.post('/convert', middlewareShellEngineKey, async (req: Request, res: Response) => {
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

        const formatRaw =
            typeof req.body?.format === 'string' && req.body.format.trim() !== ''
                ? req.body.format.trim().toLowerCase()
                : 'pdf';
        if (!ALLOWED_FORMATS.has(formatRaw)) {
            return res.status(400).json({
                message: `Unsupported format "${formatRaw}"`,
                allowedFormats: [...ALLOWED_FORMATS],
            });
        }

        let outDirRel = path.dirname(rel.value).split(/[/\\]/).join('/');
        if (typeof req.body?.outputRelativeDir === 'string' && req.body.outputRelativeDir.trim() !== '') {
            const outRel = sanitizeRelativePath(req.body.outputRelativeDir);
            if (!outRel.ok) {
                return res.status(400).json({ message: outRel.message });
            }
            const outSeg = fileRelativePathMustIncludeShellSegment(outRel.value);
            if (!outSeg.ok) {
                return res.status(400).json({ message: outSeg.message });
            }
            outDirRel = outRel.value.split(/[/\\]/).join('/');
        }
        const outDirResolved = resolveUnderSandbox(outDirRel);
        if (!outDirResolved.ok) {
            return res.status(400).json({ message: outDirResolved.message });
        }

        try {
            await fs.access(resolved.abs);
        } catch {
            return res.status(404).json({ message: 'Input file not found' });
        }

        await fs.mkdir(outDirResolved.abs, { recursive: true });

        const parsedTimeoutMs = Number(req.body?.timeoutMs);
        const effectiveTimeoutMs = Number.isFinite(parsedTimeoutMs)
            ? Math.min(Math.max(parsedTimeoutMs, 1), MAX_TIMEOUT_MS)
            : DEFAULT_TIMEOUT_MS;

        const soffice = findSofficeBin();
        const args = [
            '--headless',
            '--nologo',
            '--nofirststartwizard',
            '--convert-to',
            formatRaw,
            '--outdir',
            outDirResolved.abs,
            resolved.abs,
        ];

        console.log(
            'libreoffice convert:',
            new Date().toISOString(),
            soffice,
            args.join(' '),
            'timeoutMs=',
            effectiveTimeoutMs,
        );

        try {
            const { stdout, stderr } = await execFileAsync(soffice, args, {
                timeout: effectiveTimeoutMs,
                maxBuffer: 10 * 1024 * 1024,
            });

            const baseName = path.basename(resolved.abs, path.extname(resolved.abs));
            const outputFileName = `${baseName}.${formatRaw}`;
            const outputAbs = path.join(outDirResolved.abs, outputFileName);
            const outputRelativePath = `${outDirRel}/${outputFileName}`.replace(/\\/g, '/');

            try {
                const st = await fs.stat(outputAbs);
                return res.status(200).json({
                    message: 'Conversion succeeded',
                    relativePath: outputRelativePath,
                    absolutePath: path.resolve(outputAbs),
                    size: st.size,
                    format: formatRaw,
                    stdout,
                    stderr,
                });
            } catch {
                return res.status(500).json({
                    message: 'Conversion finished but output file was not found',
                    expectedRelativePath: outputRelativePath,
                    stdout,
                    stderr,
                });
            }
        } catch (error) {
            const executionError = error as Error & { stdout?: string; stderr?: string };
            return res.status(400).json({
                message: 'Conversion failed',
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
