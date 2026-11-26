from datetime import datetime, timezone
import logging
from types import SimpleNamespace

import pandas as pd
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from src.data_handler import hybrid_data_loader, provider
from src.database import models
from src.database.repository import AssetsRatesRepository
from src.services.ohlc_service import build_ohlc_records
from src.utils.timezone import SAO_PAULO, as_sao_paulo, configure_logging_timezone, mt5_index


def test_mt5_server_wall_time_is_not_shifted():
    encoded = pd.DatetimeIndex(["2026-11-23 09:00:00"], tz="UTC")
    result = mt5_index(encoded)
    assert result[0].isoformat() == "2026-11-23T09:00:00-03:00"
    assert as_sao_paulo(datetime(2026, 11, 23, 12, tzinfo=timezone.utc)).isoformat() == (
        "2026-11-23T09:00:00-03:00"
    )


def test_mt5_provider_and_legacy_cache_use_server_time(monkeypatch, tmp_path):
    timestamp = int(pd.Timestamp("2026-11-23 09:00:00", tz="UTC").timestamp())
    raw = [{"time": timestamp, "open": 5990.0, "high": 5996.0,
            "low": 5981.0, "close": 5984.0, "tick_volume": 1, "real_volume": 2}]
    fake_mt5 = SimpleNamespace(TIMEFRAME_M5=5, copy_rates_from_pos=lambda *args: raw)
    monkeypatch.setattr(provider, "mt5", fake_mt5)
    monkeypatch.setattr(provider, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(provider.MetaTraderProvider, "is_connected", lambda self: True)
    monkeypatch.setattr(
        provider.MetaTraderProvider, "_download_rates_in_chunks",
        lambda *args: pd.DataFrame(raw),
    )
    instance = object.__new__(provider.MetaTraderProvider)
    latest = instance.get_latest_candles("WDO$", 5, 1)
    historical = instance.get_data("WDO$", "2026-11-23", "2026-11-23", 5)
    assert latest.index[0].isoformat() == "2026-11-23T09:00:00-03:00"
    assert historical.index.equals(latest.index)

    cache_file = tmp_path / "MT5_WDO_M5_legacy.parquet"
    cache_file.touch()
    legacy = historical.copy()
    legacy.index = pd.DatetimeIndex(["2026-11-23 09:00:00"], tz="UTC")
    monkeypatch.setattr(pd, "read_parquet", lambda path: legacy.copy())
    cached = provider.CacheProvider().get_data("WDO$", "2026-11-23", "2026-11-23", "M5")
    assert cached.index.equals(latest.index)


def test_repository_stores_local_wall_time_and_deduplicates_aware_instants(monkeypatch):
    fixed_now = datetime(2026, 11, 26, 11, 51, tzinfo=timezone.utc)
    monkeypatch.setattr(models, "sao_paulo_now", lambda: fixed_now)
    engine = create_engine("sqlite:///:memory:")
    models.AssetsRates.__table__.create(engine)
    row = {"open": 1.0, "high": 2.0, "low": 1.0, "close": 2.0, "volume": 4}
    with Session(engine) as db:
        local_index = pd.DatetimeIndex(["2026-11-23 09:00:00"], tz=SAO_PAULO)
        frame = pd.DataFrame([row], index=local_index)
        AssetsRatesRepository.save_rates_dataframe(db, frame, "WDO$", 300, "M5")
        frame.index = frame.index.tz_convert("UTC")
        AssetsRatesRepository.save_rates_dataframe(db, frame, "WDO$", 300, "M5")
        stored = db.query(models.AssetsRates).all()
        assert len(stored) == 1
        assert stored[0].timestamp == datetime(2026, 11, 23, 9)
        assert stored[0].created_at == datetime(2026, 11, 26, 8, 51)
        result = AssetsRatesRepository.get_rates_range(
            db, "WDO$", 300,
            datetime(2026, 11, 23, 12, tzinfo=timezone.utc),
            datetime(2026, 11, 23, 12, tzinfo=timezone.utc),
        )
        assert result.index[0].isoformat() == "2026-11-23T09:00:00-03:00"
        assert build_ohlc_records(result)[0]["time"] == "2026-11-23T09:00:00-03:00"


def test_hybrid_loader_compares_existing_and_provider_times_in_same_zone(monkeypatch):
    row = {"open": 1.0, "high": 2.0, "low": 1.0, "close": 2.0, "volume": 4}
    existing = pd.DataFrame([row], index=pd.DatetimeIndex(["2026-11-23 09:00"]))
    incoming = pd.DataFrame(
        [row, row], index=pd.DatetimeIndex(["2026-11-23 09:00", "2026-11-23 09:05"], tz=SAO_PAULO)
    )
    saved = []
    monkeypatch.setattr(AssetsRatesRepository, "get_all_rates", lambda *args: existing.copy())
    monkeypatch.setattr(
        AssetsRatesRepository, "save_rates_dataframe", lambda db, df, *args: saved.append(df.copy())
    )
    monkeypatch.setattr(
        hybrid_data_loader, "_get_expected_latest_time",
        lambda tf: SAO_PAULO.localize(datetime(2026, 11, 23, 9, 20)),
    )
    monkeypatch.setattr(
        hybrid_data_loader, "get_default_provider",
        lambda: SimpleNamespace(get_data=lambda *args: incoming.copy()),
    )
    result = hybrid_data_loader.get_hybrid_candles_sync(None, "WDO$", "M5", 10)
    assert [ts.isoformat() for ts in result.index] == [
        "2026-11-23T09:00:00-03:00", "2026-11-23T09:05:00-03:00"
    ]
    assert len(saved) == 1 and len(saved[0]) == 1


@pytest.mark.parametrize(
    ("current", "expected"),
    [
        ("2026-11-26 09:07", "2026-11-26T09:05:00-03:00"),
        ("2026-11-26 08:54", "2026-11-25T18:25:00-03:00"),
        ("2026-11-28 12:00", "2026-11-27T18:25:00-03:00"),
        ("2026-11-30 08:54", "2026-11-27T18:25:00-03:00"),
    ],
)
def test_market_expected_time_uses_sao_paulo_and_weekdays(monkeypatch, current, expected):
    now = SAO_PAULO.localize(datetime.strptime(current, "%Y-%m-%d %H:%M"))
    monkeypatch.setattr(hybrid_data_loader, "sao_paulo_now", lambda: now)
    assert hybrid_data_loader._get_expected_latest_time("M5").isoformat() == expected


def test_monitor_payload_timestamp_is_local():
    from src.services.prediction_service import build_canonical_monitor_payload

    result = build_canonical_monitor_payload(
        timestamp_value="2026-11-26T11:51:00Z",
        ticker="WDO$", timeframe="M5", ohlcv={}, indicators={}, analysis={},
        ml_signal="HOLD", ml_direction="HOLD", ml_probability=0,
        serialize_mode="json",
    )
    assert result["timestamp"] == "2026-11-26T08:51:00-03:00"


def test_chart_displays_market_wall_time(monkeypatch):
    from src.services import chart_service

    calls = []

    class Figure:
        def add_trace(self, trace, **kwargs):
            calls.append(trace)

        def update_layout(self, **kwargs):
            pass

        def to_html(self, **kwargs):
            return "chart"

    monkeypatch.setattr(chart_service, "make_subplots", lambda **kwargs: Figure())
    frame = pd.DataFrame(
        [{"open": 1, "high": 2, "low": 1, "close": 2, "volume": 4}],
        index=pd.DatetimeIndex(["2026-11-23 12:00"], tz="UTC"),
    )
    assert chart_service.build_chart_components(frame) == ("", "chart")
    assert pd.Timestamp(calls[0].x[0]) == pd.Timestamp("2026-11-23 09:00")
    assert pd.Timestamp(calls[1].x[0]) == pd.Timestamp("2026-11-23 09:00")


def test_log_formatter_uses_market_timezone(monkeypatch):
    monkeypatch.setattr(logging.Formatter, "converter", logging.Formatter.converter)
    configure_logging_timezone()
    record = logging.LogRecord("test", logging.INFO, "", 0, "test", (), None)
    record.created = datetime(2026, 11, 26, 11, 51, tzinfo=timezone.utc).timestamp()
    assert logging.Formatter().formatTime(record, "%Y-%m-%d %H:%M") == "2026-11-26 08:51"


@pytest.mark.asyncio
async def test_backtest_interprets_naive_and_offset_dates(monkeypatch):
    from src.api.routers import backtest

    captured = []

    class FakeBacktest:
        def __init__(self, db, cfg):
            captured.append(cfg)

        def run_backtest(self):
            return {"ok": True}

    monkeypatch.setattr(backtest, "BacktestEngine", FakeBacktest)
    response = await backtest.api_backtest_run(
        symbol="WDO$", timeframe="M5",
        start="2026-11-23T09:00:00", end="2026-11-23T13:00:00+00:00",
        initial_capital=100_000, position_size=1, db=None,
    )
    assert response.status_code == 200
    assert captured[0].start_date.isoformat() == "2026-11-23T09:00:00-03:00"
    assert captured[0].end_date.isoformat() == "2026-11-23T10:00:00-03:00"
