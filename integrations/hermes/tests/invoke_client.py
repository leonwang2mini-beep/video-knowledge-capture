"""Test-only subprocess adapter for the versioned Hermes client."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys


def load_client_module(client_path: str):
    spec = importlib.util.spec_from_file_location("p0004_hermes_client", client_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load client module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    if len(sys.argv) != 5:
        raise SystemExit("usage: invoke_client.py CLIENT BASE_URL ACTION JSON_ARGUMENT")
    client_path, base_url, action, raw_argument = sys.argv[1:]
    module = load_client_module(str(Path(client_path).resolve()))
    client = module.P0004Client(base_url=base_url, request_timeout=2, poll_interval=0.02)
    argument = json.loads(raw_argument)
    if action == "capture":
        result = client.capture(argument.get("url"), argument.get("wait_seconds", 2))
    elif action == "status":
        result = client.status(argument.get("job_id"))
    else:
        raise SystemExit("unsupported action")
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
