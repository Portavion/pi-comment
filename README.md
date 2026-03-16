# pi-feedback

A standalone [Pi](https://github.com/mariozechner/pi) extension for two browser-based workflows:

- `/feedback-code` — give feedback on the current git diff in a web UI
- `/feedback-file <file.md>` — annotate a markdown file in a web UI

This repository includes both:
- the installable Pi extension at the repo root
- the minimal source/build pipeline needed to regenerate the UI assets

## Origin and attribution

This project was extracted from and is based on code from
[Plannotator](https://github.com/backnotprop/plannotator) by backnotprop.

It keeps only the Pi browser workflows for:
- code feedback
- markdown annotation

It intentionally omits the broader Plannotator feature set such as plan mode,
plan history/versioning, sharing/portal integrations, and other monorepo apps.

Original upstream license: **MIT OR Apache-2.0**.
See:
- `LICENSE`
- `LICENSE-MIT`
- `LICENSE-APACHE`
- `NOTICE`

## Install

From this repository root:

```bash
pi install .
```

Or run it without installing:

```bash
pi -e .
```

## Build the UI

Install dependencies first:

```bash
bun install
```

Then build both UIs and copy them into the extension root:

```bash
bun run build
```

This generates:
- `annotator.html`
- `review-editor.html`

from the source in:
- `apps/annotator/`
- `apps/review/`
- `packages/editor/`
- `packages/review-editor/`
- `packages/ui/`
- `packages/shared/`

## Development

Run the UI apps independently:

```bash
bun run dev:annotator
bun run dev:review
```

## Commands

### `/feedback-code`

Opens a local browser UI for giving feedback on your current uncommitted changes. The UI can switch between supported diff types and send code feedback back into the Pi session.

### `/feedback-file <file.md>`

Opens a local browser UI for annotating a markdown or MDX file. Submitted feedback is sent back into the Pi session.

## Repo layout

- `index.ts` — Pi extension entry point
- `server.ts` — lightweight local feedback/annotation server helpers
- `apps/annotator/` — source app for the annotation UI
- `apps/review/` — source app for the code feedback UI
- `packages/editor/` — annotator app component entry
- `packages/review-editor/` — code feedback app component entry
- `packages/ui/` — shared UI components/hooks/utils
- `packages/shared/` — shared non-UI helpers and types

## Remote sessions

If `PLANNOTATOR_REMOTE=1` is set, or Pi is running over SSH, the extension avoids auto-opening the browser unless a browser is explicitly configured.

Useful environment variables:

- `PLANNOTATOR_REMOTE=1`
- `PLANNOTATOR_PORT=19432`
- `PLANNOTATOR_BROWSER=/path/to/browser`
