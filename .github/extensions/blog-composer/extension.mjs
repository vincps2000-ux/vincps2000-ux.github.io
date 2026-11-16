import { createCanvas, CanvasError, joinSession } from '@github/copilot-sdk/extension';
import { fileURLToPath } from 'node:url';
import { createComposerServer } from './server.mjs';
import { draftSchema, loadCatalog, createPost } from './posts.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const instances = new Map();

async function guarded(operation) {
    try {
        return await operation();
    } catch (error) {
        throw new CanvasError(error.code || 'COMPOSER_ERROR', error.message);
    }
}

const composer = createCanvas({
    id: 'vincps-blog-composer',
    displayName: 'Daily Blog Composer',
    description: 'Compose a daily blog post with tags, pictures, and a preview, then save it to this workspace.',
    actions: [
        {
            name: 'get-state',
            description: 'Read the current session draft, saved post, available tags, and pictures.',
            handler: async ({ instanceId }) => guarded(async () => {
                const instance = instances.get(instanceId);
                if (!instance) throw new CanvasError('NOT_OPEN', 'Open the composer first.');
                return instance.getState();
            }),
        },
        {
            name: 'create-post',
            description: 'Create a new text post and index entry without committing or pushing.',
            inputSchema: draftSchema,
            handler: async ({ instanceId, input }) => guarded(async () => {
                const instance = instances.get(instanceId);
                if (!instance) throw new CanvasError('NOT_OPEN', 'Open the composer first.');
                return instance.save(input);
            }),
        },
    ],
    open: async ({ instanceId }) => guarded(async () => {
        await loadCatalog(root);
        if (!instances.has(instanceId)) {
            instances.set(instanceId, await createComposerServer({
                root,
                createPost,
                log: (message) => session.log(message),
            }));
        }
        return { url: instances.get(instanceId).url };
    }),
    onClose: async ({ instanceId }) => {
        const instance = instances.get(instanceId);
        if (instance) {
            await instance.close();
            instances.delete(instanceId);
        }
    },
});

const session = await joinSession({ canvases: [composer] });
