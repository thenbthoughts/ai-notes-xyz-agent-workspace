import express, { Request, Response } from 'express';
import morgan from 'morgan';
import cookieParser from 'cookie-parser'; // Import cookie-parser

import routesAll from './routes/routesAll';

const app = express();
app.use(express.json({
    limit: '10mb',
}));
app.use(cookieParser());

// Use morgan to log requests
app.use(morgan('dev'));

app.use('/api', routesAll);
app.use('/', express.static('dist'));

// Catch-all handler to serve index.html for client-side routing
app.get('*', (req: Request, res: Response) => {
    return res.send('Welcome to ai notes xyz shell. The page you are looking for is not found.');
});

export default app;