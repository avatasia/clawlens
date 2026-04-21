#!/usr/bin/env python3

import json
import sys
from datetime import datetime


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        payload = {}

    if payload.get("hook_event_name") != "Stop":
        json.dump({"continue": True}, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0

    stamp = datetime.now().strftime("%H:%M:%S")
    json.dump(
        {
            "continue": True,
            "systemMessage": f"Stop says: [done {stamp}]",
        },
        sys.stdout,
        ensure_ascii=False,
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
