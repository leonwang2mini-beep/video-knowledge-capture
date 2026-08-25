"""Hermes tools for the local P0004 video knowledge capture service."""

from __future__ import annotations

import json

from .client import P0004Client


TOOLSET = "video_knowledge_capture"
CLIENT = P0004Client()


def _json_result(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _capture_handler(args, **_kwargs):
    arguments = args if isinstance(args, dict) else {}
    return _json_result(
        CLIENT.capture(
            arguments.get("url"),
            arguments.get("wait_seconds", 90),
        )
    )


def _status_handler(args, **_kwargs):
    arguments = args if isinstance(args, dict) else {}
    return _json_result(CLIENT.status(arguments.get("job_id")))


def register(ctx):
    ctx.register_tool(
        name="video_knowledge_capture",
        toolset=TOOLSET,
        schema={
            "name": "video_knowledge_capture",
            "description": (
                "Submit one authorized public video URL to the local P0004 service. "
                "It downloads when supported, transcribes locally, keeps the video, "
                "deduplicates, and writes through P0004 to Obsidian."
            ),
            "parameters": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "One complete http or https public video URL.",
                        "maxLength": 4096,
                    },
                    "wait_seconds": {
                        "type": "number",
                        "description": "Bounded local wait before returning processing; default 90.",
                        "minimum": 0,
                        "maximum": 120,
                    },
                },
                "required": ["url"],
            },
        },
        handler=_capture_handler,
        description="Send a public video URL to local P0004.",
        emoji="🎬",
    )
    ctx.register_tool(
        name="video_knowledge_status",
        toolset=TOOLSET,
        schema={
            "name": "video_knowledge_status",
            "description": "Query one P0004 media job by the opaque job_id from a prior response.",
            "parameters": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "job_id": {
                        "type": "string",
                        "description": "The UUID job_id returned by video_knowledge_capture.",
                    },
                },
                "required": ["job_id"],
            },
        },
        handler=_status_handler,
        description="Query local P0004 job status.",
        emoji="🔎",
    )
