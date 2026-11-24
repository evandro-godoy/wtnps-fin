"""Integration tests for the monitor web UI and its supporting endpoints.

These tests validate that the FastAPI application wires the existing
engines (``MonitorRuntime``, ``HybridProvider``, ``MarketContextAnalyzer``,
``LegacyMonitorEngine``) into working HTTP/WebSocket endpoints and that the
``/monitor`` page renders without ``TemplateNotFound`` errors. No new data
collection, inference, or indicator logic is exercised here beyond what the
existing engines already provide.
"""
from __future__ import annotations

from fastapi.testclient import TestClient
import pandas as pd
import pytest
from types import SimpleNamespace

from configs.config import DEFAULT_SYMBOL, DEFAULT_TIMEFRAME
from src.api.main import app
from src.schemas.monitor_payload import MonitorPayload
from src.database import get_db
from src.utils.indicators import calculate_ema, calculate_sma
from src.services.monitor_runtime import MonitorRuntime


def test_home_page_renders() -> None:
    with TestClient(app) as client:
        response = client.get("/home")
    assert response.status_code == 200
    assert "WTNPS" in response.text


def test_monitor_page_renders() -> None:
    with TestClient(app) as client:
        response = client.get("/monitor")
    assert response.status_code == 200
    assert "monitor.js" in response.text
    assert "candles-chart" in response.text


def test_monitor_status_endpoint() -> None:
    with TestClient(app) as client:
        response = client.get("/api/monitor/status")
    assert response.status_code == 200
    payload = response.json()
    assert "active_monitors" in payload
    assert "websocket_connections" in payload
    assert "data_source" in payload
    assert payload["data_source"] in {"MT5", "Cache/Synthetic"}


def test_api_ohlc_endpoint() -> None:
    with TestClient(app) as client:
        response = client.get(
            "/api/ohlc",
            params={"symbol": DEFAULT_SYMBOL, "timeframe": DEFAULT_TIMEFRAME, "limit": 50},
        )
    assert response.status_code == 200
    payload = response.json()
    assert payload["symbol"] == DEFAULT_SYMBOL
    assert payload["timeframe"] == DEFAULT_TIMEFRAME
    assert isinstance(payload["data"], list)
    assert len(payload["data"]) > 0
    first_candle = payload["data"][0]
    for key in ("time", "open", "high", "low", "close", "volume"):
        assert key in first_candle


def test_api_monitor_predictions_endpoint_matches_monitor_payload_schema() -> None:
    with TestClient(app) as client:
        response = client.get(
            "/api/monitor-predictions",
            params={"symbol": DEFAULT_SYMBOL, "timeframe": DEFAULT_TIMEFRAME, "count": 3},
        )
    assert response.status_code == 200
    payload = response.json()
    assert payload["error"] is None
    predictions = payload["predictions"]
    assert isinstance(predictions, list)
    assert len(predictions) > 0

    # Every prediction item must be a valid MonitorPayload (the canonical
    # contract shared with the /ws/monitor WebSocket broadcast).
    for item in predictions:
        validated = MonitorPayload.model_validate(item)
        assert validated.ticker == DEFAULT_SYMBOL.upper()
        assert validated.timeframe == DEFAULT_TIMEFRAME.upper()
        assert 0.0 <= validated.ml.probability


def _receive_until(websocket, predicate, max_frames: int = 25) -> dict:
    """Read frames from the websocket until predicate matches.

    The shared ``/ws/monitor`` socket interleaves control frames (ping/pong,
    frequency_ack) with live ``MonitorPayload`` broadcasts from the always-on
    monitors started during lifespan. Any interleaved payload frame is
    validated against the canonical schema before being skipped.
    """
    for _ in range(max_frames):
        frame = websocket.receive_json()
        if predicate(frame):
            return frame
        if "ticker" in frame:
            # Interleaved live monitor broadcast: still must be schema-valid.
            MonitorPayload.model_validate(frame)
    raise AssertionError(f"Expected frame not received after {max_frames} messages")


def test_websocket_monitor_connects_and_acks_frequency_change() -> None:
    with TestClient(app) as client:
        with client.websocket_connect("/ws/monitor") as websocket:
            websocket.send_json({"action": "set_frequency", "mode": "close"})
            ack = _receive_until(websocket, lambda frame: frame.get("type") == "frequency_ack")
            assert ack["mode"] == "close"

            websocket.send_json({"action": "ping"})
            pong = _receive_until(websocket, lambda frame: frame.get("type") == "pong")
            assert pong["mode"] == "close"


@pytest.mark.parametrize("available,expected", [(350, 150), (240, 40), (200, 0)])
def test_ohlc_indicators_use_200_prior_candles(monkeypatch, available, expected):
    from src.api.routers import market_data

    index = pd.date_range("2026-01-01", periods=available, freq="5min", tz="UTC")
    close = pd.Series(range(available), index=index, dtype=float) ** 2 + 100
    data = pd.DataFrame({
        "open": close, "high": close + 1, "low": close - 1,
        "close": close, "volume": 1,
    })
    requested = []

    def load(db, symbol, timeframe, limit, background_tasks):
        requested.append(limit)
        return data.copy()

    monkeypatch.setattr(market_data, "get_hybrid_candles", load)
    provider = SimpleNamespace(get_latest_candles=lambda **kwargs: data.copy())
    monkeypatch.setattr(app.state, "container", SimpleNamespace(data_provider=provider), raising=False)
    app.dependency_overrides[get_db] = lambda: None
    try:
        client = TestClient(app, raise_server_exceptions=True)
        response = client.get("/api/ohlc", params={"limit": 150, "include_indicators": True})
        client.close()
    finally:
        app.dependency_overrides.pop(get_db, None)
    assert response.status_code == 200
    result = response.json()
    assert requested == [350]
    assert len(result["data"]) == expected
    assert ("warning" in result) == (expected < 150)
    if expected:
        first = result["data"][0]
        assert first["time"] == index[200].isoformat()
        assert first["ema_9"] == pytest.approx(calculate_ema(close, 9).iloc[200])
        assert first["ema_20"] == pytest.approx(calculate_ema(close, 20).iloc[200])
        assert first["sma_50"] == pytest.approx(calculate_sma(close, 50).iloc[200])


@pytest.mark.asyncio
async def test_default_monitors_respect_enabled_assets(monkeypatch, tmp_path):
    from src.services import monitor_runtime

    config_dir = tmp_path / "configs"
    config_dir.mkdir()
    (config_dir / "main.yaml").write_text(
        "assets:\n"
        "  - ticker: WDO$\n    enabled: true\n"
        "    live_trading: {enabled: true, timeframe_str: M5}\n"
        "  - ticker: WIN$\n    enabled: false\n"
        "    live_trading: {enabled: true, timeframe_str: M5}\n"
        "  - ticker: OTHER\n    enabled: true\n"
        "    live_trading: {enabled: false, timeframe_str: H1}\n"
        "  - ticker: TEST\n    enabled: true\n"
        "    live_trading: {enabled: true, timeframe_str: H1}\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(monitor_runtime, "APP_ROOT", tmp_path)
    runtime = MonitorRuntime()
    started = []

    async def ensure_worker():
        return None

    async def start(ticker, timeframe):
        started.append((ticker, timeframe))
        return {"ticker": ticker, "timeframe": timeframe}

    monkeypatch.setattr(runtime, "_ensure_persist_worker", ensure_worker)
    monkeypatch.setattr(runtime, "start_monitor", start)
    await runtime.start_default_monitors()
    assert started == [("WDO$", "M5"), ("TEST", "H1")]


@pytest.mark.asyncio
async def test_default_monitors_validate_before_starting(monkeypatch, tmp_path):
    from src.services import monitor_runtime

    config_dir = tmp_path / "configs"
    config_dir.mkdir()
    (config_dir / "main.yaml").write_text(
        "assets:\n"
        "  - ticker: WDO$\n    enabled: true\n"
        "    live_trading: {enabled: true, timeframe_str: M5}\n"
        "  - ticker: INVALID\n    enabled: true\n"
        "    live_trading: {enabled: true}\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(monitor_runtime, "APP_ROOT", tmp_path)
    runtime = MonitorRuntime()
    started = []

    async def start(ticker, timeframe):
        started.append((ticker, timeframe))

    monkeypatch.setattr(runtime, "start_monitor", start)
    with pytest.raises(ValueError, match="ticker or timeframe"):
        await runtime.start_default_monitors()
    assert not started
    assert runtime._persist_worker_task is None


def test_cli_uses_selector_loop_on_windows(monkeypatch):
    import asyncio
    import sys
    import uvicorn
    from src import cli

    if sys.platform != "win32":
        pytest.skip("Windows-specific event loop")
    policies = []
    calls = []
    monkeypatch.setattr(asyncio, "set_event_loop_policy", policies.append)
    monkeypatch.setattr(uvicorn, "run", lambda *args, **kwargs: calls.append(kwargs))
    cli.main(["--no-browser"])
    assert isinstance(policies[0], asyncio.WindowsSelectorEventLoopPolicy)
    assert calls[0]["loop"] == "none"
