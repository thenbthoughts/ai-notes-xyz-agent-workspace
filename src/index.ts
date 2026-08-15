import envKeys from './config/envKeys';
import app from './serverCommon';

// Bind 0.0.0.0 so the process accepts traffic from Docker port publishing (not only loopback).
const PORT = envKeys.EXPRESS_PORT;
const HOST = process.env.HOST ?? '0.0.0.0';

app.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
});