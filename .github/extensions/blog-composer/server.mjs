import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog, validateDraft, fail } from './posts.mjs';

const assets = new Map([
    ['/', ['composer.html', 'text/html; charset=utf-8']],
    ['/composer.css', ['composer.css', 'text/css; charset=utf-8']],
    ['/composer.js', ['composer.js', 'text/javascript; charset=utf-8']],
]);
const assetRoot = fileURLToPath(new URL('./', import.meta.url));

export async function createComposerServer({ root, createPost, log }) {
    const today = new Date();
    const localDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    let draft = { title: '', filename: '', date: localDate, tags: [], body: '' };
    let saved = null;
    let saving = false;
    let origin;
    const getState = async () => ({ draft, saved, catalog: await loadCatalog(root) });
    const save = async (input) => {
        if (saving) fail('BUSY', 'A save is already running.');
        saving = true;
        try {
            const validated = validateDraft(input, await loadCatalog(root));
            const result = await createPost(root, input);
            draft = validated;
            saved = result;
            return result;
        } finally {
            saving = false;
        }
    };
    const server = createServer(async (request, response) => {
        const reply = (status, data) => {
            response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify(data));
        };
        try {
            response.setHeader('Cache-Control', 'no-store');
            response.setHeader('X-Content-Type-Options', 'nosniff');
            response.setHeader('Referrer-Policy', 'no-referrer');
            response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'");
            if (request.headers.host !== new URL(origin).host) {
                reply(403, { error: 'Invalid host.' });
                return;
            }
            const url = new URL(request.url, origin);
            if (request.method === 'GET') {
                if (url.pathname === '/api/state') {
                    reply(200, await getState());
                } else if (assets.has(url.pathname)) {
                    const [filename, contentType] = assets.get(url.pathname);
                    const content = await readFile(path.join(assetRoot, filename));
                    response.writeHead(200, { 'Content-Type': contentType });
                    response.end(content);
                } else if (url.pathname.startsWith('/pictures/')) {
                    const name = decodeURIComponent(url.pathname.slice('/pictures/'.length));
                    const catalog = await loadCatalog(root);
                    if (!catalog.pictures.includes(name)) {
                        reply(404, { error: 'Picture not found.' });
                        return;
                    }
                    const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif' };
                    const content = await readFile(path.join(root, 'pictures', name));
                    response.writeHead(200, { 'Content-Type': types[path.extname(name).toLowerCase()] });
                    response.end(content);
                } else {
                    reply(404, { error: 'Not found.' });
                }
                return;
            }
            if (request.method !== 'POST' || !['/api/draft', '/api/create'].includes(url.pathname)) {
                reply(405, { error: 'Method not allowed.' });
                return;
            }
            if (request.headers.origin !== origin
                || request.headers['content-type']?.split(';')[0] !== 'application/json') {
                reply(403, { error: 'Use the composer page to submit JSON.' });
                return;
            }
            let body = '';
            let size = 0;
            request.setEncoding('utf8');
            for await (const chunk of request) {
                size += Buffer.byteLength(chunk);
                if (size > 1024 * 1024) fail('INVALID_INPUT', 'The post is too large.');
                body += chunk;
            }
            let input;
            try {
                input = JSON.parse(body);
            } catch {
                fail('INVALID_INPUT', 'Invalid JSON request.');
            }
            if (url.pathname === '/api/draft') {
                if (saving) fail('BUSY', 'A save is running. Wait before editing.');
                draft = validateDraft(input, await loadCatalog(root), false);
                saved = null;
                reply(200, { savedInSession: true });
            } else {
                reply(201, await save(input));
            }
        } catch (error) {
            await log(`Blog composer: ${error.message}`);
            const status = ['INVALID_INPUT', 'INVALID_DATA'].includes(error.code) ? 400
                : ['ALREADY_EXISTS', 'BUSY', 'CONFLICT'].includes(error.code) ? 409 : 500;
            if (!response.headersSent) reply(status, { error: error.message, code: error.code || 'COMPOSER_ERROR' });
            else response.destroy(error);
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    server.on('error', (error) => { void log(`Blog composer server: ${error.message}`); });
    return {
        url: `${origin}/`,
        getState,
        save,
        close: () => new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
            server.closeIdleConnections();
        }),
    };
}
