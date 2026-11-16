import { readFile, readdir, writeFile, rename, unlink, open, link } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const draftSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'filename', 'date', 'tags', 'body'],
    properties: {
        title: { type: 'string', maxLength: 160 },
        filename: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,99}\\.txt$' },
        date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        tags: { type: 'array', uniqueItems: true, items: { type: 'string' } },
        body: { type: 'string', maxLength: 200000 },
    },
};

export function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
}

async function readJson(filename) {
    const raw = await readFile(filename, 'utf8');
    try {
        return { raw, data: JSON.parse(raw.replace(/^\uFEFF/, '')) };
    } catch {
        fail('INVALID_DATA', `Invalid JSON in ${filename}. Repair it before saving a post.`);
    }
}

async function readIndex(root) {
    const index = await readJson(path.join(root, 'posts', 'list.json'));
    if (!Array.isArray(index.data) || !index.data.every((entry) =>
        typeof entry === 'string' || (entry && typeof entry === 'object'
            && typeof entry.file === 'string'
            && (entry.date === undefined || typeof entry.date === 'string')
            && (entry.title === undefined || typeof entry.title === 'string')))) {
        fail('INVALID_DATA', 'posts/list.json must be an array of post entries.');
    }
    return index;
}

export async function loadCatalog(root) {
    const [{ data: tags }, index, images, files] = await Promise.all([
        readJson(path.join(root, 'Tags.json')),
        readIndex(root),
        readdir(path.join(root, 'pictures'), { withFileTypes: true }),
        readdir(path.join(root, 'posts')),
    ]);
    if (!tags || typeof tags !== 'object' || Array.isArray(tags)
        || !Object.entries(tags).every(([name, value]) => name.length > 0
            && !/[\u00A7\r\n]/.test(name) && value && typeof value === 'object'
            && typeof value.color === 'string' && typeof value.emoji === 'string')) {
        fail('INVALID_DATA', 'Tags.json must contain named tags with color and emoji strings.');
    }
    return {
        tags: Object.entries(tags).map(([name, value]) => ({ name, ...value })),
        pictures: images.filter((entry) => entry.isFile()
            && /^[a-zA-Z0-9_.-]+\.(png|jpe?g|gif|webp|avif)$/i.test(entry.name))
            .map((entry) => entry.name).sort(),
        existingFiles: [...new Set([
            ...files,
            ...index.data.map((entry) => typeof entry === 'string' ? entry : entry.file),
        ])],
    };
}

export function validateDraft(input, catalog, complete = true) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some((key) => !['title', 'filename', 'date', 'tags', 'body'].includes(key))
        || typeof input.title !== 'string' || input.title.length > 160 || /[\r\n]/.test(input.title)
        || typeof input.filename !== 'string' || input.filename.length > 104
        || typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)
        || !Array.isArray(input.tags) || !input.tags.every((tag) => typeof tag === 'string')
        || new Set(input.tags).size !== input.tags.length
        || input.tags.some((tag) => !catalog.tags.some((known) => known.name === tag))
        || typeof input.body !== 'string' || input.body.length > 200000 || input.body.includes('\0')) {
        fail('INVALID_INPUT', 'Check the title, filename, date, tags, and body.');
    }
    const parsedDate = new Date(`${input.date}T00:00:00Z`);
    if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== input.date) {
        fail('INVALID_INPUT', 'Choose a valid calendar date.');
    }
    if (complete) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}\.txt$/.test(input.filename)
            || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])\.txt$/i.test(input.filename)) {
            fail('INVALID_INPUT', 'Use a safe filename ending in .txt (letters, numbers, hyphens, underscores).');
        }
        if (!input.body.trim()) fail('INVALID_INPUT', 'Write some post content before saving.');
        if (/^\u00A7[^\u00A7]+\u00A7/.test(input.body)) {
            fail('INVALID_INPUT', 'Select tags above instead of adding tag markers to the first line.');
        }
        if (catalog.existingFiles.some((file) => file.toLowerCase() === input.filename.toLowerCase())) {
            fail('ALREADY_EXISTS', 'That filename already exists. Choose a new filename; existing posts are never overwritten.');
        }
    }
    return {
        title: input.title.trim(),
        filename: input.filename,
        date: input.date,
        tags: [...input.tags],
        body: input.body.replace(/\r\n?/g, '\n'),
    };
}

export function postText(draft) {
    const tags = draft.tags.map((tag) => `\u00A7${tag}\u00A7`).join('');
    return `${tags ? `${tags}\n` : ''}${draft.body}${draft.body.endsWith('\n') ? '' : '\n'}`;
}

export async function createPost(root, input) {
    const directory = path.join(root, 'posts');
    const lockPath = path.join(directory, '.blog-composer.lock');
    let lock;
    try {
        lock = await open(lockPath, 'wx');
    } catch (error) {
        if (error.code === 'EEXIST') {
            fail('BUSY', 'Another composer is saving. Retry shortly. If a previous process crashed, remove posts/.blog-composer.lock after checking no save is running.');
        }
        throw error;
    }
    const temporaryPost = path.join(directory, `.composer-${randomUUID()}.tmp`);
    const temporaryIndex = path.join(directory, `.composer-${randomUUID()}.tmp`);
    let createdPath;
    const cleanupErrors = [];
    try {
        const catalog = await loadCatalog(root);
        const draft = validateDraft(input, catalog);
        const indexPath = path.join(directory, 'list.json');
        const index = await readIndex(root);
        const entry = { file: draft.filename, date: draft.date };
        if (draft.title) entry.title = draft.title;
        const nextIndex = JSON.stringify([...index.data, entry], null, 4) + '\n';
        await writeFile(temporaryPost, postText(draft), { flag: 'wx' });
        await writeFile(temporaryIndex, nextIndex, { flag: 'wx' });
        const postPath = path.join(directory, draft.filename);
        await link(temporaryPost, postPath);
        createdPath = postPath;
        if ((await readFile(indexPath, 'utf8')) !== index.raw) {
            fail('CONFLICT', 'The post index changed while saving. Retry the save.');
        }
        await rename(temporaryIndex, indexPath);
        createdPath = undefined;
        return { file: draft.filename, date: draft.date, title: draft.title, indexed: true };
    } finally {
        for (const filename of [createdPath, temporaryPost, temporaryIndex].filter(Boolean)) {
            try {
                await unlink(filename);
            } catch (error) {
                if (error.code !== 'ENOENT') cleanupErrors.push(`${filename}: ${error.message}`);
            }
        }
        await lock.close();
        try {
            await unlink(lockPath);
        } catch (error) {
            cleanupErrors.push(`${lockPath}: ${error.message}`);
        }
        if (cleanupErrors.length) fail('CLEANUP_FAILED', `Check saved files before retrying. Cleanup failed: ${cleanupErrors.join('; ')}`);
    }
}
