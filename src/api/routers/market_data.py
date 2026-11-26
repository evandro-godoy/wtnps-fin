from __future__ import annotations

from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from configs.config import DEFAULT_LIMIT, DEFAULT_SYMBOL, DEFAULT_TIMEFRAME, MAX_LIMIT
from src.api.dependencies import get_state_from_request
from src.data_handler.hybrid_data_loader import get_hybrid_candles
from src.database import get_db
from src.database.repository import MarketAnalysisRepository
from src.services.ohlc_service import build_ohlc_records
from src.utils.indicators import add_basic_indicators
from src.utils.timezone import as_sao_paulo

router = APIRouter()


@router.get("/api/ohlc", response_class=JSONResponse)
async def api_ohlc(
    request: Request,
    symbol: str = DEFAULT_SYMBOL,
    timeframe: str = DEFAULT_TIMEFRAME,
    limit: int = DEFAULT_LIMIT,
    include_indicators: bool = False,
    db: Session = Depends(get_db),
    background_tasks: BackgroundTasks = BackgroundTasks(),
) -> dict[str, Any]:
    if limit <= 0 or limit > MAX_LIMIT:
        raise HTTPException(status_code=400, detail=f"limit deve estar entre 1 e {MAX_LIMIT}")

    warmup = 200 if include_indicators else 0
    if limit + warmup > MAX_LIMIT:
        raise HTTPException(status_code=400, detail=f"limit com aquecimento não pode exceder {MAX_LIMIT}")
    df = get_hybrid_candles(db, symbol, timeframe, limit + warmup, background_tasks)
    if include_indicators and len(df) < limit + warmup:
        provider_df = get_state_from_request(request).data_provider.get_latest_candles(
            ticker=symbol, timeframe=timeframe, count=limit + warmup
        )
        if len(provider_df) > len(df):
            df = provider_df
    if include_indicators and not df.empty:
        df = add_basic_indicators(
            df.copy(), ema_periods=[9, 20], sma_periods=[20, 50],
            rsi_period=14, overwrite=True,
        )
        df = df.iloc[warmup:].tail(limit)
    records = build_ohlc_records(df)
    if include_indicators:
        for record, (_, row) in zip(records, df.iterrows()):
            for name in ("ema_9", "ema_20", "sma_20", "sma_50", "rsi"):
                value = row[name]
                record["rsi_14" if name == "rsi" else name] = (
                    float(value) if value == value else None
                )

    result = {
        "symbol": symbol,
        "timeframe": timeframe,
        "count": len(records),
        "latest": records[-1] if records else None,
        "data": records,
        "source": "Hybrid (DB + Provider)" if not df.empty else "No Data",
    }
    if include_indicators and len(df) < limit:
        result["warning"] = "Histórico insuficiente para exibir todos os candles com 200 candles de aquecimento."
    return result


@router.get("/api/analysis", response_class=JSONResponse)
async def api_analysis(
    request: Request,
    symbol: str = DEFAULT_SYMBOL,
    timeframe: str = DEFAULT_TIMEFRAME,
    limit: int = DEFAULT_LIMIT,
    db: Session = Depends(get_db),
    background_tasks: BackgroundTasks = BackgroundTasks(),
) -> dict[str, Any]:
    if limit <= 0 or limit > MAX_LIMIT:
        raise HTTPException(status_code=400, detail=f"limit deve estar entre 1 e {MAX_LIMIT}")

    df = get_hybrid_candles(db, symbol, timeframe, limit, background_tasks)
    if df.empty:
        raise HTTPException(status_code=503, detail="Dados de mercado não disponíveis no momento")

    state = get_state_from_request(request)
    context = state.market_analyzer.analyze(df)
    timestamp = df.index[-1]

    try:
        MarketAnalysisRepository.save_analysis(db, symbol, timeframe, timestamp, context, len(df))
    except Exception:
        pass

    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "candles_analyzed": len(df),
        "timestamp": as_sao_paulo(timestamp).isoformat(),
        "analysis": context,
    }


@router.get("/api/combined", response_class=JSONResponse)
@router.get("/api/ohlc-with-analysis", response_class=JSONResponse)
async def api_combined(
    request: Request,
    symbol: str = DEFAULT_SYMBOL,
    timeframe: str = DEFAULT_TIMEFRAME,
    limit: int = DEFAULT_LIMIT,
    db: Session = Depends(get_db),
    background_tasks: BackgroundTasks = BackgroundTasks(),
) -> dict[str, Any]:
    if limit <= 0 or limit > MAX_LIMIT:
        raise HTTPException(status_code=400, detail=f"limit deve estar entre 1 e {MAX_LIMIT}")

    df = get_hybrid_candles(db, symbol, timeframe, limit, background_tasks)
    if df.empty:
        raise HTTPException(status_code=503, detail="Dados de mercado não disponíveis no momento")

    state = get_state_from_request(request)
    records = build_ohlc_records(df)
    context = state.market_analyzer.analyze(df)

    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "count": len(records),
        "timestamp": as_sao_paulo(df.index[-1]).isoformat() if not df.empty else None,
        "latest": records[-1] if records else None,
        "ohlc": records,
        "analysis": context,
    }
