from __future__ import annotations

import logging

import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots

from src.utils.timezone import market_index

logger = logging.getLogger(__name__)

_EMPTY_CHART_HTML = (
    '<div class="chart-placeholder">Sem dados disponíveis para exibir o gráfico.</div>'
)


def build_chart_components(df: pd.DataFrame) -> tuple[str, str]:
    """Build lightweight Plotly script/div components from an OHLC dataframe.

    Returns a ``(script, div)`` tuple compatible with the legacy Bokeh-based
    template contract: ``script`` is kept empty because Plotly embeds its
    rendering `<script>` tag directly inside the returned ``div`` markup, and
    ``div`` already contains a safe placeholder when no data is available.
    """
    if df is None or df.empty:
        return "", _EMPTY_CHART_HTML

    try:
        chart_index = market_index(pd.DatetimeIndex(df.index)).tz_localize(None)
        fig = make_subplots(
            rows=2,
            cols=1,
            shared_xaxes=True,
            row_heights=[0.75, 0.25],
            vertical_spacing=0.03,
        )

        fig.add_trace(
            go.Candlestick(
                x=chart_index,
                open=df["open"],
                high=df["high"],
                low=df["low"],
                close=df["close"],
                name="OHLC",
            ),
            row=1,
            col=1,
        )

        if "volume" in df.columns:
            fig.add_trace(
                go.Bar(x=chart_index, y=df["volume"], name="Volume", marker_color="#6c8ebf"),
                row=2,
                col=1,
            )

        fig.update_layout(
            template="plotly_dark",
            height=600,
            margin=dict(l=40, r=20, t=30, b=30),
            xaxis_rangeslider_visible=False,
            showlegend=False,
        )

        return "", fig.to_html(full_html=False, include_plotlyjs="cdn")
    except Exception as exc:  # pragma: no cover - defensive guard for /charts
        logger.error("Failed to build chart components: %s", exc, exc_info=True)
        return "", _EMPTY_CHART_HTML
