const byId = (id) => document.getElementById(id);
const form = byId('composer');
let catalog;
let saved;
let filenameEdited = false;
let timer;
let pendingDraft = Promise.resolve();

function status(message, error = false) {
    byId('status').textContent = message;
    byId('status').classList.toggle('error', error);
}

async function request(url, input) {
    const response = await fetch(url, input === undefined ? {} : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
}

function draft() {
    return {
        title: byId('title').value,
        filename: byId('filename').value,
        date: byId('date').value,
        tags: [...document.querySelectorAll('#tags input:checked')].map((input) => input.value),
        body: byId('body').value,
    };
}

function setDraft(value) {
    for (const key of ['title', 'filename', 'date', 'body']) byId(key).value = value[key];
    for (const input of document.querySelectorAll('#tags input')) input.checked = value.tags.includes(input.value);
    filenameEdited = Boolean(value.filename);
    preview();
}

function preview() {
    const value = draft();
    byId('preview-title').textContent = value.title || value.filename.replace(/\.txt$/i, '') || 'Your next post';
    byId('preview-meta').textContent = `${value.date} / ${value.filename || 'Choose a filename'}`;
    byId('preview-tags').replaceChildren(...value.tags.map((name) => {
        const badge = document.createElement('span');
        badge.className = 'tag';
        const tag = catalog.tags.find((item) => item.name === name);
        badge.textContent = `${tag.emoji} ${name}`;
        return badge;
    }));
    const content = byId('preview-body');
    content.replaceChildren();
    const pattern = /\$([a-zA-Z0-9_.-]+)\$|https?:\/\/[^\s<)]+/g;
    let offset = 0;
    for (const match of value.body.matchAll(pattern)) {
        content.append(document.createTextNode(value.body.slice(offset, match.index)));
        if (match[1] && catalog.pictures.includes(match[1])) {
            const image = document.createElement('img');
            image.src = `/pictures/${encodeURIComponent(match[1])}`;
            image.alt = match[1];
            content.append(image);
        } else if (!match[1]) {
            const anchor = document.createElement('a');
            anchor.href = match[0];
            anchor.textContent = match[0];
            anchor.target = '_blank';
            anchor.rel = 'noopener noreferrer';
            content.append(anchor);
        } else {
            content.append(document.createTextNode(match[0]));
        }
        offset = match.index + match[0].length;
    }
    content.append(document.createTextNode(value.body.slice(offset)));
    byId('counts').textContent = `${value.body.trim() ? value.body.trim().split(/\s+/).length : 0} words / ${value.body.length.toLocaleString()} characters`;
    const duplicate = catalog.existingFiles.some((file) => file.toLowerCase() === value.filename.toLowerCase());
    byId('filename').setCustomValidity(duplicate && !saved ? 'This filename already exists.' : '');
}

function keepDraft() {
    const value = draft();
    pendingDraft = pendingDraft.then(() => request('/api/draft', value)).then(() => {
        status('Session draft updated. Save when ready; unfinished text is not stored on disk.');
    }).catch((error) => status(`Session draft could not be updated: ${error.message}`, true));
}

function edited(event) {
    if (event.target.id === 'filename') filenameEdited = true;
    if (event.target.id === 'title' && !filenameEdited) {
        const base = byId('title').value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100);
        byId('filename').value = base ? `${base}.txt` : '';
    }
    preview();
    clearTimeout(timer);
    if (byId('date').validity.valid) timer = setTimeout(keepDraft, 400);
}

form.addEventListener('input', edited);
byId('insert-picture').addEventListener('click', () => {
    const picture = byId('picture').value;
    if (!picture) {
        status('Choose a picture first.', true);
        return;
    }
    const body = byId('body');
    body.setRangeText(`$${picture}$`, body.selectionStart, body.selectionEnd, 'end');
    body.focus();
    edited({ target: body });
});

function showSaved(result) {
    saved = result;
    byId('editor').disabled = true;
    byId('result').hidden = false;
    byId('result-text').textContent = `Created posts/${result.file} and added its date and title to posts/list.json.`;
    status('Post saved locally. Nothing was committed or pushed.');
}

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearTimeout(timer);
    byId('editor').disabled = true;
    status('Saving your post...');
    try {
        await pendingDraft;
        showSaved(await request('/api/create', draft()));
    } catch (error) {
        byId('editor').disabled = false;
        status(`Post was not confirmed saved: ${error.message}`, true);
    }
});

byId('new-post').addEventListener('click', async () => {
    byId('new-post').disabled = true;
    try {
        clearTimeout(timer);
        await pendingDraft;
        const state = await request('/api/state');
        catalog = state.catalog;
        saved = null;
        setDraft({ ...state.draft, title: '', filename: '', body: '', tags: [] });
        await request('/api/draft', draft());
        byId('result').hidden = true;
        byId('editor').disabled = false;
        byId('title').focus();
        status('Ready for a new post.');
    } catch (error) {
        status(error.message, true);
    } finally {
        byId('new-post').disabled = false;
    }
});

async function initialize() {
    try {
        const state = await request('/api/state');
        catalog = state.catalog;
        for (const tag of catalog.tags) {
            const label = document.createElement('label');
            label.className = 'tag';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.value = tag.name;
            label.append(input, document.createTextNode(`${tag.emoji} ${tag.name}`));
            byId('tags').append(label);
        }
        for (const picture of catalog.pictures) {
            const option = document.createElement('option');
            option.value = picture;
            option.textContent = picture;
            byId('picture').append(option);
        }
        setDraft(state.draft);
        byId('editor').disabled = false;
        if (state.saved) showSaved(state.saved);
        else status('Ready to write. Your existing posts will never be overwritten.');
    } catch (error) {
        status(`Could not load the composer: ${error.message}. Reload to retry.`, true);
    }
}

void initialize();
