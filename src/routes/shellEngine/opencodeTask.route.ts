import { Router, Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';

import middlewareShellEngineKey from '../../middleware/middlewareVerifyToken';
import envKeys from '../../config/envKeys';

const router = Router();
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const AGENT_CONTAINER_ROOT = 'ai-notes-xyz-agent-workspace/shell/agent';

function sanitizeTaskId(raw: string): string {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return '';
    // prefer hex safe, fallback to alphanum _ -
    const hex = trimmed.replace(/[^a-fA-F0-9]/g, '').slice(0, 64);
    if (hex.length >= 12) return hex;
    const fallback = trimmed.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    return fallback;
}

function getContainerPaths(taskId: string) {
    const safe = sanitizeTaskId(taskId);
    const base = path.resolve(envKeys.FILE_STORAGE_PATH);
    const taskRoot = path.join(base, AGENT_CONTAINER_ROOT, safe);
    const inputDir = path.join(taskRoot, 'input');
    const outputDir = path.join(taskRoot, 'output');
    const skillsDir = path.join(taskRoot, 'skills');
    const promptPath = path.join(inputDir, 'prompt.md');
    const outputPath = path.join(outputDir, `output-${safe}.md`);
    const outputAltPath = path.join(outputDir, 'output.md');
    const webhookPath = path.join(inputDir, 'webhook-context.md');
    const opencodePath = path.join(taskRoot, 'opencode.json');
    const dotOpencodePath = path.join(taskRoot, '.opencode', 'opencode.json');
    return { safe, taskRoot, inputDir, outputDir, skillsDir, promptPath, outputPath, outputAltPath, webhookPath, opencodePath, dotOpencodePath };
}

async function writeOpencodeConfig(taskRoot: string, opencodePath: string, dotOpencodePath: string, apiKey: string, model: string) {
    const key = String(apiKey || '').trim();
    const mdl = String(model || 'openrouter/auto').trim() || 'openrouter/auto';
    // Do not rely on env; use passed key directly if provided, otherwise empty (opencode will use env at runtime if set via shell)
    const config = {
        $schema: 'https://opencode.ai/config.json',
        provider: {
            openrouter: {
                npm: '@ai-sdk/openai-compatible',
                options: {
                    baseURL: 'https://openrouter.ai/api/v1',
                    apiKey: key || '',
                },
                models: {},
            },
        },
        model: `openrouter/${mdl.replace(/^openrouter\//, '')}`,
    };
    await fs.mkdir(path.dirname(opencodePath), { recursive: true });
    await fs.mkdir(path.dirname(dotOpencodePath), { recursive: true });
    await fs.writeFile(opencodePath, JSON.stringify(config, null, 2), 'utf-8');
    await fs.writeFile(dotOpencodePath, JSON.stringify(config, null, 2), 'utf-8');
}

async function fallbackDirectLlm(taskId: string, safe: string, promptText: string, webhookMd: string, skillsBlock: string, apiKey: string, model: string, outputPath: string) {
    const key = String(apiKey || '').trim();
    const mdl = String(model || 'openrouter/auto').replace(/^openrouter\//, '');
    if (!key) {
        const fallback = `# Task ${safe} — Fallback Output\n\n**Prompt:**\n${promptText}\n\n**Webhook context:**\n${webhookMd || '(none)'}\n\n**Skills:**\n${skillsBlock ? skillsBlock.slice(0, 2000) : '(none)'}\n\nThis output was generated without an LLM (OPENROUTER_API_KEY not configured). In production, OpenRouter would synthesize the final answer here.\n`;
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, fallback, 'utf-8');
        return;
    }
    const systemPrompt = `You are an AI agent executing a task in an isolated workspace.\nYou have the user's prompt, webhook context and skills.\nYour job is to produce the final user-facing Markdown answer.`;
    const userContent = [
        `Task ID: ${taskId} (${safe})`,
        `Prompt:\n${promptText}`,
        webhookMd ? `Webhook context:\n${webhookMd}` : '',
        skillsBlock ? `Active skills:\n${skillsBlock}` : '',
        `Instruction: You are executing a task inside an isolated workspace. The user's original request is in prompt.md. Perform the task completely. When you have finished, write ONLY the final user-facing answer to /workspace/output/output-${safe}.md (container path). The output file is mandatory. Must contain complete final answer in Markdown.`,
    ].filter(Boolean).join('\n\n');
    try {
        const res = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
                model: mdl.includes('/') ? mdl : `openrouter/${mdl}`,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userContent },
                ],
                temperature: 0.7,
                max_tokens: 4000,
            },
            {
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://ai-notes-xyz.local',
                    'X-Title': 'ai-notes-xyz-agent-workspace',
                },
                timeout: 120000,
                validateStatus: () => true,
            }
        );
        if (res.status < 200 || res.status >= 300) {
            throw new Error(`OpenRouter ${res.status}: ${JSON.stringify(res.data).slice(0, 500)}`);
        }
        const data: any = res.data;
        const content = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || '# Result\n\nNo content';
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, String(content), 'utf-8');
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const fallback = `# Task ${safe} — Error Fallback\n\nPrompt:\n${promptText}\n\nError: ${msg}\n\nThis is a fallback output after LLM failure.\n`;
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, fallback, 'utf-8');
        throw e;
    }
}

async function tryOpencodeCli(taskId: string, safe: string, taskRoot: string, outputPath: string, model: string, apiKey: string): Promise<boolean> {
    const mdl = String(model || 'openrouter/auto').replace(/^openrouter\//, '');
    const opencodeBin = '/usr/local/bin/opencode';
    try {
        await fs.access(opencodeBin);
    } catch {
        return false;
    }
    // Try opencode run via shell command
    // We use shell command to mimic user request "instead call shell command"
    const promptTemplate = `You are executing a task inside an isolated workspace. The user's request is at /workspace/input/prompt.md (container) or ${path.join(taskRoot, 'input', 'prompt.md')}. Read it, perform the task, and write ONLY the final answer to ${outputPath}`;
    const cmd = `cd "${taskRoot}" && OPENROUTER_API_KEY="${String(apiKey || '').replace(/"/g, '\\"')}" timeout 120 opencode run --model openrouter/${mdl} "${promptTemplate.replace(/"/g, '\\"')}" 2>&1 || true`;
    try {
        const { stdout, stderr } = await execAsync(cmd, { timeout: 130000, maxBuffer: 10 * 1024 * 1024 });
        console.log(`[opencodeTask ${safe}] opencode run stdout:`, stdout?.slice(0, 2000));
        if (stderr) console.log(`[opencodeTask ${safe}] stderr:`, stderr?.slice(0, 2000));
        // Check if output was created
        try {
            await fs.access(outputPath);
            return true;
        } catch {
            // try alt path
            try {
                await fs.access(path.join(taskRoot, 'output', 'output.md'));
                // copy to expected
                await fs.copyFile(path.join(taskRoot, 'output', 'output.md'), outputPath);
                return true;
            } catch {}
            return false;
        }
    } catch (e) {
        console.warn(`[opencodeTask ${safe}] opencode run failed`, e);
        return false;
    }
}

async function runTaskAsync(params: { taskId: string; prompt: string; openRouterApiKey?: string; openRouterModel?: string; webhookContext?: string; skills?: string }) {
    const { taskId, prompt, openRouterApiKey, openRouterModel, webhookContext, skills } = params;
    const { safe, taskRoot, inputDir, outputDir, skillsDir, promptPath, outputPath, webhookPath, opencodePath, dotOpencodePath } = getContainerPaths(taskId);
    if (!safe) throw new Error('Invalid taskId');
    console.log(`[opencodeTask ${safe}] starting async, taskRoot=${taskRoot}`);
    try {
        await fs.mkdir(inputDir, { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(skillsDir, { recursive: true });
        await fs.mkdir(path.join(taskRoot, '.opencode'), { recursive: true });
        await fs.writeFile(promptPath, String(prompt || ''), 'utf-8');
        if (webhookContext) {
            await fs.writeFile(webhookPath, String(webhookContext), 'utf-8');
        }
        if (skills) {
            await fs.writeFile(path.join(skillsDir, '_active-skills.md'), String(skills), 'utf-8');
        }
        const apiKey = String(openRouterApiKey || '').trim();
        const model = String(openRouterModel || 'openrouter/auto').trim() || 'openrouter/auto';
        await writeOpencodeConfig(taskRoot, opencodePath, dotOpencodePath, apiKey, model);

        // Try shell-based opencode first (call shell command) - uses passed apiKey via env
        const opencodeOk = await tryOpencodeCli(taskId, safe, taskRoot, outputPath, model, apiKey);
        if (opencodeOk) {
            console.log(`[opencodeTask ${safe}] opencode CLI succeeded, output at ${outputPath}`);
            return;
        }
        console.log(`[opencodeTask ${safe}] opencode CLI did not produce output, falling back to direct OpenRouter`);
        // Fallback direct LLM (still via http, but inside container)
        let webhookMd = '';
        try { webhookMd = await fs.readFile(webhookPath, 'utf-8'); } catch {}
        let skillsBlock = '';
        try { skillsBlock = await fs.readFile(path.join(skillsDir, '_active-skills.md'), 'utf-8'); } catch {}
        await fallbackDirectLlm(taskId, safe, prompt, webhookMd, skillsBlock, apiKey, model, outputPath);
        console.log(`[opencodeTask ${safe}] fallback direct LLM wrote ${outputPath}`);
    } catch (e) {
        console.error(`[opencodeTask ${safe}] async failed`, e);
        // Ensure output exists as error file so poller can pick it up
        try {
            await fs.access(outputPath);
        } catch {
            const errMsg = e instanceof Error ? e.message : String(e);
            const fallback = `# Task ${safe} — Failed\n\nPrompt:\n${String(prompt).slice(0, 2000)}\n\nError: ${errMsg}\n`;
            await fs.mkdir(outputDir, { recursive: true });
            await fs.writeFile(outputPath, fallback, 'utf-8');
        }
    }
}

// POST /api/shell-engine/opencode/task  -> dispatch
router.post('/task', middlewareShellEngineKey, async (req: Request, res: Response) => {
    try {
        const { taskId, prompt, openRouterApiKey, openRouterModel, webhookContext, skills } = req.body as {
            taskId?: string;
            prompt?: string;
            openRouterApiKey?: string;
            openRouterModel?: string;
            webhookContext?: string;
            skills?: string;
        };
        if (!taskId || typeof taskId !== 'string' || !taskId.trim()) {
            return res.status(400).json({ message: 'taskId is required' });
        }
        if (typeof prompt !== 'string' || !prompt.trim()) {
            return res.status(400).json({ message: 'prompt is required' });
        }
        if (prompt.length > 50000) {
            return res.status(400).json({ message: 'prompt too long' });
        }
        const safe = sanitizeTaskId(taskId);
        if (!safe) return res.status(400).json({ message: 'Invalid taskId' });
        // Check if already dispatched and output exists? allow re-dispatch
        const { outputPath } = getContainerPaths(taskId);
        // Fire async without awaiting
        setImmediate(() => {
            runTaskAsync({ taskId, prompt, openRouterApiKey, openRouterModel, webhookContext, skills }).catch((e) => console.error(e));
        });
        // Also ensure we write prompt synchronously quickly before returning?
        // Do quick write so status can be polled
        const { inputDir, promptPath } = getContainerPaths(taskId);
        await fs.mkdir(inputDir, { recursive: true });
        await fs.writeFile(promptPath, String(prompt), 'utf-8');
        return res.status(202).json({ message: 'Task dispatched to container', taskId: safe, status: 'working' });
    } catch (e) {
        console.error('opencode dispatch error', e);
        return res.status(500).json({ message: 'Server error' });
    }
});

// GET /api/shell-engine/opencode/task/:taskId  -> status
router.get('/task/:taskId', middlewareShellEngineKey, async (req: Request, res: Response) => {
    try {
        const taskId = String(req.params.taskId || '').trim();
        const safe = sanitizeTaskId(taskId);
        if (!safe) return res.status(400).json({ message: 'Invalid taskId' });
        const { outputPath, promptPath, taskRoot } = getContainerPaths(taskId);
        let hasPrompt = false;
        let hasOutput = false;
        let outputSize = 0;
        let outputMtime: number | null = null;
        try { await fs.access(promptPath); hasPrompt = true; } catch {}
        try {
            const st = await fs.stat(outputPath);
            hasOutput = true;
            outputSize = st.size;
            outputMtime = st.mtimeMs;
        } catch {
            // try alt
            try {
                const st2 = await fs.stat(path.join(taskRoot, 'output', 'output.md'));
                hasOutput = true;
                outputSize = st2.size;
                outputMtime = st2.mtimeMs;
            } catch {}
        }
        if (!hasPrompt && !hasOutput) return res.status(404).json({ message: 'Task not found in container' });
        const status = hasOutput ? 'completed' : 'working';
        return res.json({ taskId: safe, status, hasPrompt, hasOutput, outputSize, outputMtime, outputPath: hasOutput ? `output/output-${safe}.md` : null });
    } catch (e) {
        console.error('opencode status error', e);
        return res.status(500).json({ message: 'Server error' });
    }
});

// GET /api/shell-engine/opencode/task/:taskId/output  -> read output.md
router.get('/task/:taskId/output', middlewareShellEngineKey, async (req: Request, res: Response) => {
    try {
        const taskId = String(req.params.taskId || '').trim();
        const safe = sanitizeTaskId(taskId);
        if (!safe) return res.status(400).json({ message: 'Invalid taskId' });
        const { outputPath, outputAltPath } = getContainerPaths(taskId);
        let data: string | null = null;
        let usedPath = outputPath;
        try {
            data = await fs.readFile(outputPath, 'utf-8');
        } catch {
            try {
                data = await fs.readFile(outputAltPath, 'utf-8');
                usedPath = outputAltPath;
            } catch {
                return res.status(404).json({ message: 'Output file not found' });
            }
        }
        if (data == null) return res.status(404).json({ message: 'Output file not found' });
        // Return as json with content, also support raw markdown via query? keep json
        res.setHeader('Content-Type', 'application/json');
        return res.json({ taskId: safe, outputPath: path.relative(path.resolve(envKeys.FILE_STORAGE_PATH), usedPath).replace(/\\/g, '/'), content: data, size: Buffer.byteLength(data, 'utf-8') });
    } catch (e) {
        console.error('opencode output read error', e);
        return res.status(500).json({ message: 'Server error' });
    }
});

// POST /api/shell-engine/opencode/shell  -> explicitly run a shell command (user requested "instead call shell command")
// This is a thin wrapper that requires token and runs command via shell inside container
router.post('/shell', middlewareShellEngineKey, async (req: Request, res: Response) => {
    try {
        const { command, timeoutMs } = req.body as { command?: string; timeoutMs?: number };
        if (typeof command !== 'string' || !command.trim()) return res.status(400).json({ message: 'command is required' });
        const effectiveTimeout = Number.isFinite(Number(timeoutMs)) ? Math.min(Math.max(Number(timeoutMs), 1), 120000) : 15000;
        console.log(`[opencode shell] exec: ${command} timeout=${effectiveTimeout}`);
        try {
            const { stdout, stderr } = await execAsync(command, { timeout: effectiveTimeout, maxBuffer: 10 * 1024 * 1024 });
            if (stderr && stderr.trim()) {
                return res.status(400).json({ message: 'Command execution failed', stdout, stderr });
            }
            return res.json({ message: 'Command executed', stdout, stderr });
        } catch (err: any) {
            return res.status(400).json({ message: 'Command execution failed', error: err.message, stdout: err.stdout ?? '', stderr: err.stderr ?? '' });
        }
    } catch (e) {
        console.error('shell exec error', e);
        return res.status(500).json({ message: 'Server error' });
    }
});

export default router;
