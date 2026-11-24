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

from configs.config import DEFAULT_SYMBOL, DEFAULT_TIMEFRAME
from src.api.main import app
from src.schemas.monitor_payload import MonitorPayload


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
