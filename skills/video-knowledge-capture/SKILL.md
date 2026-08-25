---
name: video-knowledge-capture
description: Capture one authorized public video through the local Video Knowledge Capture service, including managed download, offline transcription, deduplication, and Obsidian Inbox writeback. Use when a user asks to save or transcribe a public video link, or to query a prior capture job. Do not use for private, paid, DRM-protected, or unauthorized content.
metadata:
  short-description: Capture public videos into a local knowledge base
---

# Video Knowledge Capture

Turn one user-selected public video URL into a traceable local knowledge-base entry. The local P0004 service remains the only downloader, transcription engine, retry ledger, retained-media manager, and Obsidian writer.

## Preconditions

- Run on Windows with Node.js 20 or newer.
- The local P0004 service must be healthy at `http://127.0.0.1:43127` and its Inbox must be configured.
- For installation or host-specific setup, read [references/host-setup.md](references/host-setup.md).

## Capture

1. Accept exactly one complete `http` or `https` URL selected by the user. Reject URLs containing credentials and requests for private, paid, DRM-protected, or unauthorized content.
2. If native tools named `video_knowledge_capture` and `video_knowledge_status` are available, call them with structured arguments.
3. Otherwise invoke the bundled `scripts/p0004-client.mjs` with JSON on standard input. Do not interpolate the URL into a shell command and do not replace the local service with another downloader or a direct Markdown write.
4. Use a bounded wait of 90 seconds unless the user asks for immediate acknowledgement. Process multiple links one at a time.

For a new link, send:

```json
{"url":"https://example.com/public-video","wait_seconds":90}
```

For a later status query, send the exact opaque `job_id` returned by the first call:

```json
{"job_id":"11111111-1111-4111-8111-111111111111"}
```

## Report the Result

- `completed`: report that the note was written; include the retained-media path when returned.
- `duplicate`: report that no second note was created; still include the retained-media path when returned.
- `processing`: include `job_id` and say only that the local computer accepted the task.
- `failed`: include the stable code, retryability, concise message, and `next_action`.
- `unavailable`: say the local computer or service is unreachable; never claim the URL was queued.

Only `completed` or `duplicate` proves capture completion. Never invent titles, subtitles, summaries, paths, or success states. Say a platform is unsupported only when the stable code is `PUBLIC_MEDIA_PLATFORM_UNSUPPORTED`.
