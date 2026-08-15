import path from 'path';

const envKeys = {
    EXPRESS_PORT: 2001,
    API_TOKEN: process.env.API_TOKEN || '',
    /** Absolute path; defaults to `<cwd>/data`. Override with env `FILE_STORAGE_PATH`. */
    FILE_STORAGE_PATH: process.env.FILE_STORAGE_PATH
        ? path.resolve(process.env.FILE_STORAGE_PATH)
        : path.resolve(process.cwd(), 'data'),
};

if (
    typeof process.env.EXPRESS_PORT === 'string' &&
    Number(process.env.EXPRESS_PORT) >= 1
) {
    envKeys.EXPRESS_PORT = Number(process.env.EXPRESS_PORT);
}

console.log("envKeys", envKeys);

export default envKeys;