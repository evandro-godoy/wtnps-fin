"""Application and market timestamps in the São Paulo timezone."""
from __future__ import annotations

import logging
from datetime import datetime

import pandas as pd
import pytz

SAO_PAULO = pytz.timezone("America/Sao_Paulo")


def sao_paulo_now() -> datetime:
    return datetime.now(SAO_PAULO)


def as_sao_paulo(value: datetime) -> datetime:
    if value.tzinfo is None:
        return SAO_PAULO.localize(value, is_dst=None)
    return value.astimezone(SAO_PAULO)


def database_datetime(value: datetime) -> datetime:
    """Convert aware instants to the local, timezone-naive database format."""
    return as_sao_paulo(value).replace(tzinfo=None)


def market_index(index: pd.DatetimeIndex) -> pd.DatetimeIndex:
    if index.tz is None:
        return index.tz_localize(SAO_PAULO)
    return index.tz_convert(SAO_PAULO)


def mt5_index(index: pd.DatetimeIndex) -> pd.DatetimeIndex:
    """Interpret MT5 server wall times, including older UTC-labelled caches."""
    if index.tz is not None and str(index.tz) in ("UTC", "UTC+00:00"):
        index = index.tz_localize(None)
    return market_index(index)


def configure_logging_timezone() -> None:
    """Use São Paulo time for standard logging formatters."""
    logging.Formatter.converter = staticmethod(
        lambda timestamp: datetime.fromtimestamp(timestamp, SAO_PAULO).timetuple()
    )
