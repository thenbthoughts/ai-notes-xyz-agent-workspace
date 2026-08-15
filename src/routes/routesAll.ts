import { Router, Request, Response } from 'express';

import routesShellEngineAbout from './shellEngine/shellEngineAbout.route';
import routesShellEngineShell from './shellEngine/shellEngineShell.route';
import routesShellEngineFile from './shellEngine/shellEngineFile.route';
import routesShellEngineZip from './shellEngine/shellEngineZip.route';
import routesLibreOffice from './shellEngine/libreOfficeConvert.route';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
    return res.send('Welcome to ai-notes-xyz-agent-workspace.');
});

router.use('/shell-engine/about', routesShellEngineAbout);

// shell engine: shell and file ops are separate mounts (requires API_TOKEN)
router.use('/shell-engine/run-shell', routesShellEngineShell);
router.use('/shell-engine/file', routesShellEngineFile);
router.use('/shell-engine/zip', routesShellEngineZip);
router.use('/shell-engine/libreoffice', routesLibreOffice);

export default router;
