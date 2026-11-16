# Daily Blog Composer

A workspace-scoped Copilot canvas for this blog. Ask Copilot to **open the Daily
Blog Composer** (canvas ID: `vincps-blog-composer`). No package installation is
required; the host supplies `@github/copilot-sdk/extension`.

## Writing a post

1. Enter an optional display title. It suggests a filename until you edit that
   filename yourself.
2. Choose a date and any tags from `Tags.json`.
3. Write plain text. Insert pictures already in `pictures/` using the picture
   picker. The preview supports text, links, tags, and `$picture.ext$` markers.
   Interactive demo markers are preserved, but only run on the actual blog.
4. Choose **Save new post**. This creates `posts/<filename>.txt` and appends
   `{ file, date, title? }` to `posts/list.json`. Tags are written as first-line
   `§Tag§` markers, matching the blog reader.
5. Review the files and commit/push with your normal Git workflow. The canvas
   never commits, pushes, or updates statistics.

Existing post files and indexed filenames are never overwritten, including
case-insensitive collisions. New files are UTF-8, and JSON reads support the
existing index's optional BOM. Atomic file writes and a save lock protect against
competing composer sessions. Avoid manually editing the index or running the
publishing task during a save. If a save reports a failure, inspect the files
before retrying. After a process crash, inspect for a partially saved post and
remove `posts/.blog-composer.lock` only when no composer save is running.

## Session state

Unfinished text and the last save result live only in the extension process.
Reopening the same live canvas instance keeps them. Closing the instance,
reloading extensions, or ending the host session discards unfinished work. There
is no private draft storage or browser local storage. Saved posts and their index
entries are normal versionable workspace files.

Agent actions:

- `get-state`: read the session draft, last save, tags, picture names, and existing
  filenames.
- `create-post`: create a post with `{ title, filename, date, tags, body }`.
  The title may be empty; the filename must end in `.txt`; dates use `YYYY-MM-DD`.

The extension entry point wires the canvas; `posts.mjs` handles validation and
filesystem writes; `server.mjs` owns a loopback-only, ephemeral HTTP server per
instance; the HTML, CSS, and client script supply the editor.

## Validation

With Node.js available:

```powershell
node --check .github\extensions\blog-composer\extension.mjs
node --test .github\extensions\blog-composer\composer.test.mjs
```

Tests create isolated temporary blogs; they do not add test posts to this blog.
After changing extension files, reload Copilot extensions before opening the canvas.
