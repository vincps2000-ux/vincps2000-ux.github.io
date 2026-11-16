import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { createPost, loadCatalog, postText, validateDraft } from './posts.mjs';
import { createComposerServer } from './server.mjs';

async function fixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blog-composer-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'posts'));
    await mkdir(path.join(root, 'pictures'));
    await writeFile(path.join(root, 'Tags.json'), JSON.stringify({
        Tools: { color: '#f97316', emoji: 'T' },
        API: { color: '#f59e0b', emoji: 'A' },
    }));
    await writeFile(path.join(root, 'posts', 'list.json'),
        '\uFEFF' + JSON.stringify(['Legacy.txt', { file: 'Existing.txt', date: '2026-01-01', extra: 'preserve' }]));
    await writeFile(path.join(root, 'posts', 'Existing.txt'), 'Existing content\n');
    return root;
}

function draft(overrides = {}) {
    return {
        title: 'A daily experiment',
        filename: 'DailyExperiment.txt',
        date: '2026-11-16',
        tags: ['Tools', 'API'],
        body: 'Tested an API.\r\n$example.png$\r\nhttps://example.com',
        ...overrides,
    };
}

test('creates a UTF-8 tagged text post and compatible index while retaining old entries', async (t) => {
    const root = await fixture(t);
    const result = await createPost(root, draft({ body: 'Gr\u00FC\u00DFe \u{1F680}' }));
    assert.deepEqual(result, { file: 'DailyExperiment.txt', date: '2026-11-16', title: 'A daily experiment', indexed: true });
    assert.equal(await readFile(path.join(root, 'posts', result.file), 'utf8'),
        '\u00A7Tools\u00A7\u00A7API\u00A7\nGr\u00FC\u00DFe \u{1F680}\n');
    const index = JSON.parse(await readFile(path.join(root, 'posts', 'list.json'), 'utf8'));
    assert.equal(index[0], 'Legacy.txt');
    assert.equal(index[1].extra, 'preserve');
    assert.deepEqual(index[2], { file: result.file, date: result.date, title: result.title });
    assert.deepEqual((await readdir(path.join(root, 'posts'))).sort(),
        ['DailyExperiment.txt', 'Existing.txt', 'list.json'].sort());
});

test('normalizes line endings and omits optional tags and title', async (t) => {
    const root = await fixture(t);
    await createPost(root, draft({ title: '', tags: [] }));
    assert.equal(await readFile(path.join(root, 'posts', 'DailyExperiment.txt'), 'utf8'),
        'Tested an API.\n$example.png$\nhttps://example.com\n');
    const index = JSON.parse(await readFile(path.join(root, 'posts', 'list.json'), 'utf8'));
    assert.equal(Object.hasOwn(index.at(-1), 'title'), false);
    assert.equal(postText({ tags: [], body: 'One\n' }), 'One\n');
});

test('rejects duplicate names in the index or directory without overwriting files', async (t) => {
    const root = await fixture(t);
    for (const filename of ['existing.txt', 'Legacy.txt', 'LIST.txt']) {
        if (filename === 'LIST.txt') await writeFile(path.join(root, 'posts', 'list.TXT'), 'Unindexed');
        await assert.rejects(createPost(root, draft({ filename })), { code: 'ALREADY_EXISTS' });
    }
    assert.equal(await readFile(path.join(root, 'posts', 'Existing.txt'), 'utf8'), 'Existing content\n');
});

test('validates paths, Windows device names, dates, unknown tags, and content', async (t) => {
    const root = await fixture(t);
    const catalog = await loadCatalog(root);
    for (const input of [
        draft({ filename: '..\\escape.txt' }), draft({ filename: '../escape.txt' }),
        draft({ filename: 'CON.txt' }), draft({ filename: 'post.html' }),
        draft({ date: '2026-02-29' }), draft({ date: '2026-13-01' }),
        draft({ tags: ['Unknown'] }), draft({ tags: ['Tools', 'Tools'] }),
        draft({ body: '  ' }), draft({ body: '\u00A7Tools\u00A7\nText' }),
        draft({ title: 'Title\nInjected' }), draft({ body: '\0' }),
        draft({ body: 'a'.repeat(200001) }), draft({ extra: true }),
    ]) {
        assert.throws(() => validateDraft(input, catalog), { code: 'INVALID_INPUT' });
    }
    assert.equal(validateDraft(draft({ date: '2028-02-29' }), catalog).date, '2028-02-29');
    assert.equal(validateDraft(draft({ filename: '', body: '' }), catalog, false).body, '');
});

test('refuses corrupt and unsupported repository data instead of replacing it', async (t) => {
    const root = await fixture(t);
    const indexPath = path.join(root, 'posts', 'list.json');
    for (const text of ['{broken', '{}', '[{"date":"2026-11-16"}]']) {
        await writeFile(indexPath, text);
        await assert.rejects(createPost(root, draft()), { code: 'INVALID_DATA' });
        assert.equal(await readFile(indexPath, 'utf8'), text);
        assert.equal((await readdir(path.join(root, 'posts'))).some((file) => file.startsWith('.')), false);
    }
    await writeFile(indexPath, '[]');
    await writeFile(path.join(root, 'Tags.json'), '[]');
    await assert.rejects(createPost(root, draft()), { code: 'INVALID_DATA' });
});

test('serializes competing writers with an explicit busy error', async (t) => {
    const root = await fixture(t);
    const results = await Promise.allSettled([
        createPost(root, draft()), createPost(root, draft({ filename: 'AnotherPost.txt' })),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'BUSY');
    const entries = JSON.parse(await readFile(path.join(root, 'posts', 'list.json'), 'utf8'));
    assert.equal(entries.length, 3);
});

test('catalog only offers supported safe picture filenames', async (t) => {
    const root = await fixture(t);
    for (const name of ['example.png', 'animated.gif', 'unsafe name.jpg', 'script.svg', 'file.txt']) {
        await writeFile(path.join(root, 'pictures', name), '');
    }
    await mkdir(path.join(root, 'pictures', 'directory.png'));
    assert.deepEqual((await loadCatalog(root)).pictures, ['animated.gif', 'example.png']);
});

test('HTTP composer retains session state, saves posts, and resets saved state for the next post', async (t) => {
    const root = await fixture(t);
    const errors = [];
    const server = await createComposerServer({ root, createPost, log: async (message) => errors.push(message) });
    t.after(() => server.close());
    const origin = new URL(server.url).origin;
    const post = (url, input, headers = {}) => fetch(new URL(url, server.url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin, ...headers },
        body: JSON.stringify(input),
    });
    const html = await fetch(server.url);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /Daily blog composer/);
    assert.match(html.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal((await fetch(new URL('/composer.js', server.url))).status, 200);
    const input = draft({ body: 'Gr\u00FC\u00DFe \u{1F680}' });
    assert.equal((await post('/api/draft', input)).status, 200);
    assert.equal((await server.getState()).draft.body, input.body);
    assert.equal((await (await fetch(new URL('/api/state', server.url))).json()).draft.body, input.body);
    const saved = await post('/api/create', input);
    assert.equal(saved.status, 201);
    assert.equal((await saved.json()).indexed, true);
    assert.equal((await server.getState()).saved.file, input.filename);
    assert.equal((await post('/api/create', input)).status, 409);
    assert.equal((await post('/api/draft', draft({ title: '', filename: '', body: '' }))).status, 200);
    assert.equal((await server.getState()).saved, null);
    assert.ok(errors.some((message) => message.includes('already exists')));
});

test('HTTP endpoints reject cross-origin writes, bad JSON, invalid hosts, and traversal', async (t) => {
    const root = await fixture(t);
    const server = await createComposerServer({ root, createPost, log: async () => {} });
    t.after(() => server.close());
    const origin = new URL(server.url).origin;
    const headers = { 'Content-Type': 'application/json', Origin: origin };
    assert.equal((await fetch(new URL('/api/create', origin), {
        method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body: JSON.stringify(draft()),
    })).status, 403);
    assert.equal((await fetch(new URL('/api/create', origin), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft()),
    })).status, 403);
    assert.equal((await fetch(new URL('/api/create', origin), {
        method: 'POST', headers, body: '{invalid',
    })).status, 400);
    assert.equal((await fetch(new URL('/api/create', origin), {
        method: 'POST', headers, body: JSON.stringify(draft({ filename: '../outside.txt' })),
    })).status, 400);
    assert.equal((await fetch(new URL('/pictures/%2e%2e%5cTags.json', origin))).status, 404);
    const invalidHostStatus = await new Promise((resolve, reject) => {
        const request = httpRequest(origin, { headers: { Host: 'attacker.example' } }, (response) => {
            response.resume();
            response.on('end', () => resolve(response.statusCode));
        });
        request.on('error', reject);
        request.end();
    });
    assert.equal(invalidHostStatus, 403);
    assert.equal((await readdir(path.join(root, 'posts'))).includes('DailyExperiment.txt'), false);
});
