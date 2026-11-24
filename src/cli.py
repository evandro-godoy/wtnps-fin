"""Command-line entrypoint to run the WTNPS Fin monitor in the background.

Starts the canonical FastAPI application (``src.api.main:app``) with Uvicorn
in production mode (no autoreload) and optionally opens the ``/monitor`` page
in the default web browser. Intended to be used either directly::

    poetry run wtnps-monitor

or wrapped by the Windows helper scripts under ``scripts/``.
"""
from __future__ import annotations

import argparse
import logging
import threading
import time
import webbrowser

from configs.config import HOST, LOG_FORMAT, LOG_LEVEL, PORT

logger = logging.getLogger(__name__)


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse CLI arguments for the monitor entrypoint."""
    parser = argparse.ArgumentParser(
        prog="wtnps-monitor",
        description="Start the WTNPS Fin FastAPI monitor server.",
    )
    parser.add_argument("--host", default=HOST, help=f"Bind host (default: {HOST})")
    parser.add_argument("--port", type=int, default=PORT, help=f"Bind port (default: {PORT})")
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Do not automatically open the /monitor page in the default browser.",
    )
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Enable autoreload (development only; disabled by default for background runs).",
    )
    return parser.parse_args(argv)


def _open_browser_when_ready(host: str, port: int, delay_seconds: float = 1.5) -> None:
    """Open the monitor page in the default browser after a short delay."""
    display_host = "127.0.0.1" if host in {"0.0.0.0", ""} else host
    url = f"http://{display_host}:{port}/monitor"

    def _open() -> None:
        time.sleep(delay_seconds)
        try:
            webbrowser.open(url)
        except Exception as exc:  # pragma: no cover - best-effort UX helper
            logger.warning("Could not open browser automatically: %s", exc)

    threading.Thread(target=_open, daemon=True).start()


def main(argv: list[str] | None = None) -> None:
    """Run the FastAPI application with Uvicorn in background-friendly mode."""
    import uvicorn

    args = _parse_args(argv)
    logging.basicConfig(level=getattr(logging, LOG_LEVEL), format=LOG_FORMAT)

    if not args.no_browser:
        _open_browser_when_ready(args.host, args.port)

    uvicorn.run(
        "src.api.main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


if __name__ == "__main__":
    main()
