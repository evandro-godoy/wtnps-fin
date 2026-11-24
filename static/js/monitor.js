/**
 * WTNPS Fin - Monitor em tempo real
 *
 * Consome os endpoints e o WebSocket já existentes no backend
 * (/api/ohlc, /api/monitor-predictions, /api/monitor/status,
 * /api/monitor/start, /api/monitor/stop e /ws/monitor) e os
 * renderiza com Plotly + alertas visuais/sonoros/desktop.
 *
 * Nenhuma lógica de coleta de dados, inferência ML ou indicadores
 * técnicos é recalculada aqui: este arquivo é puramente de apresentação.
 */
(function () {
    "use strict";

    const config = window.WTNPS_MONITOR_CONFIG || {};
    const state = {
        symbol: config.defaultSymbol || "WDO$",
        timeframe: config.defaultTimeframe || "M5",
        ohlcLimit: config.ohlcLimit || 150,
        predictionsCount: config.predictionsCount || 10,
        candles: [], // {time, open, high, low, close, volume}
        indicatorPoints: [], // {time, ema_9, ema_20, sma_20, sma_50, rsi_14}
        history: [], // last N monitor payloads (newest first)
        latestAnalysis: null,
        soundEnabled: false,
        notificationsEnabled: false,
        ws: null,
        wsReconnectTimer: null,
        audioCtx: null,
    };

    const el = (id) => document.getElementById(id);

    /**
     * Normalize any ISO-8601 timestamp variant (e.g. the trailing "Z" used by
     * Pydantic JSON mode vs. the "+00:00" offset used by pandas) to the same
     * canonical string so candle and indicator series align on the same
     * Plotly category x-axis positions.
     */
    function normalizeTime(value) {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
    }

    // ---------------------------------------------------------------
    // REST bootstrap: carga inicial de candles + predições
    // ---------------------------------------------------------------
    async function fetchJSON(url) {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Request failed (${response.status}): ${url}`);
        }
        return response.json();
    }

    async function loadInitialOhlc() {
        const url = `/api/ohlc?symbol=${encodeURIComponent(state.symbol)}&timeframe=${encodeURIComponent(state.timeframe)}&limit=${state.ohlcLimit}`;
        try {
            const data = await fetchJSON(url);
            state.candles = (data.data || []).map((row) => ({
                time: normalizeTime(row.time),
                open: row.open,
                high: row.high,
                low: row.low,
                close: row.close,
                volume: row.volume,
            }));
            renderCandleChart();
        } catch (err) {
            console.error("Failed to load initial OHLC", err);
        }
    }

    async function loadInitialPredictions() {
        const url = `/api/monitor-predictions?symbol=${encodeURIComponent(state.symbol)}&timeframe=${encodeURIComponent(state.timeframe)}&count=${state.predictionsCount}`;
        try {
            const data = await fetchJSON(url);
            const predictions = data.predictions || [];
            predictions.forEach((payload) => ingestPayload(payload, { skipAlert: true }));
        } catch (err) {
            console.error("Failed to load initial predictions", err);
        }
    }

    // ---------------------------------------------------------------
    // WebSocket streaming
    // ---------------------------------------------------------------
    function connectWebSocket() {
        const protocol = window.location.protocol === "https:" ? "wss" : "ws";
        const url = `${protocol}://${window.location.host}/ws/monitor`;
        const ws = new WebSocket(url);
        state.ws = ws;

        ws.onopen = () => {
            setWsStatus(true);
            const frequency = el("input-frequency").value;
            ws.send(JSON.stringify({ action: "set_frequency", mode: frequency }));
        };

        ws.onmessage = (event) => {
            let message;
            try {
                message = JSON.parse(event.data);
            } catch (err) {
                return;
            }
            if (!message || !message.ticker) {
                return; // pong / frequency_ack control frames
            }
            if (
                String(message.ticker).toUpperCase() !== state.symbol.toUpperCase() ||
                String(message.timeframe).toUpperCase() !== state.timeframe.toUpperCase()
            ) {
                return; // payload for a different monitored ticker/timeframe
            }
            ingestPayload(message, { skipAlert: false });
        };

        ws.onclose = () => {
            setWsStatus(false);
            state.wsReconnectTimer = window.setTimeout(connectWebSocket, 3000);
        };

        ws.onerror = () => {
            ws.close();
        };
    }

    function setWsStatus(connected) {
        const dot = el("status-ws").querySelector(".status-dot");
        dot.classList.toggle("status-dot--online", connected);
        dot.classList.toggle("status-dot--offline", !connected);
        el("status-ws-text").textContent = connected ? "conectado" : "desconectado";
    }

    // ---------------------------------------------------------------
    // Ingestão de payloads (histórico inicial + stream)
    // ---------------------------------------------------------------
    function ingestPayload(payload, options) {
        const opts = options || {};
        const timestamp = normalizeTime(payload.timestamp);
        const ohlcv = payload.ohlcv || {};
        const indicators = payload.indicators || {};
        const analysis = payload.analysis || {};
        const ml = payload.ml || {};
        const decision = payload.decision || {};

        state.indicatorPoints.push({
            time: timestamp,
            ema_9: indicators.ema_9,
            ema_20: indicators.ema_20,
            sma_20: indicators.sma_20,
            sma_50: indicators.sma_50,
            rsi_14: indicators.rsi_14,
        });
        if (state.indicatorPoints.length > 500) {
            state.indicatorPoints.shift();
        }
        state.latestAnalysis = analysis;

        // Append/replace last candle so the candlestick chart stays live.
        // The REST /api/monitor-predictions reconstruction only carries a
        // real "close" price (open/high/low are 0.0 placeholders), so only
        // upsert when the OHLC block has real, non-zero values; otherwise
        // keep the real candle already loaded from /api/ohlc untouched.
        if (ohlcv.open || ohlcv.high || ohlcv.low) {
            upsertCandle({
                time: timestamp,
                open: ohlcv.open,
                high: ohlcv.high,
                low: ohlcv.low,
                close: ohlcv.close,
                volume: ohlcv.volume,
            });
        }

        state.history.unshift(payload);
        if (state.history.length > 20) {
            state.history.pop();
        }

        updatePredictionCard(ml, decision);
        updateContextCard(analysis, indicators);
        updateHistoryTable();
        renderCandleChart();
        el("status-last-update-text").textContent = new Date(payload.timestamp).toLocaleTimeString("pt-BR");

        if (!opts.skipAlert) {
            maybeTriggerAlert(payload, ml, decision);
        }
    }

    function upsertCandle(candle) {
        const existingIndex = state.candles.findIndex((c) => c.time === candle.time);
        if (existingIndex >= 0) {
            state.candles[existingIndex] = candle;
        } else {
            state.candles.push(candle);
            if (state.candles.length > state.ohlcLimit) {
                state.candles.shift();
            }
        }
    }

    // ---------------------------------------------------------------
    // Renderização Plotly
    // ---------------------------------------------------------------
    function renderCandleChart() {
        if (!state.candles.length) {
            return;
        }
        const times = state.candles.map((c) => c.time);

        const candleTrace = {
            type: "candlestick",
            name: state.symbol,
            x: times,
            open: state.candles.map((c) => c.open),
            high: state.candles.map((c) => c.high),
            low: state.candles.map((c) => c.low),
            close: state.candles.map((c) => c.close),
            increasing: { line: { color: "#2ecc71" } },
            decreasing: { line: { color: "#e74c3c" } },
        };

        const overlayTraces = buildOverlayTraces();
        const shapes = buildLevelShapes(times);

        const layout = {
            template: "plotly_dark",
            margin: { l: 50, r: 20, t: 20, b: 30 },
            height: 460,
            // Categorical x-axis avoids huge visual gaps between trading
            // sessions (nights/weekends) that would otherwise compress all
            // candles into a tiny sliver on a real time axis.
            xaxis: { type: "category", rangeslider: { visible: false }, nticks: 10 },
            showlegend: true,
            legend: { orientation: "h" },
            shapes,
        };

        Plotly.react("candles-chart", [candleTrace, ...overlayTraces], layout, { responsive: true, displaylogo: false });
        renderRsiChart();
    }

    function buildOverlayTraces() {
        const points = state.indicatorPoints;
        if (!points.length) {
            return [];
        }
        const x = points.map((p) => p.time);
        const seriesDefs = [
            { key: "ema_9", name: "EMA 9", color: "#4f8cff" },
            { key: "ema_20", name: "EMA 20", color: "#9b59b6" },
            { key: "sma_20", name: "SMA 20", color: "#f5b041" },
            { key: "sma_50", name: "SMA 50", color: "#1abc9c" },
        ];
        return seriesDefs.map((def) => ({
            type: "scatter",
            mode: "lines",
            name: def.name,
            x,
            y: points.map((p) => p[def.key]),
            line: { color: def.color, width: 1.5 },
        }));
    }

    function buildLevelShapes(times) {
        if (!state.latestAnalysis || !times.length) {
            return [];
        }
        const x0 = times[0];
        const x1 = times[times.length - 1];
        const shapes = [];
        if (state.latestAnalysis.support) {
            shapes.push(levelShape(x0, x1, state.latestAnalysis.support, "#2ecc71"));
        }
        if (state.latestAnalysis.resistance) {
            shapes.push(levelShape(x0, x1, state.latestAnalysis.resistance, "#e74c3c"));
        }
        return shapes;
    }

    function levelShape(x0, x1, y, color) {
        return {
            type: "line",
            x0,
            x1,
            y0: y,
            y1: y,
            line: { color, dash: "dot", width: 1 },
        };
    }

    function renderRsiChart() {
        const points = state.indicatorPoints;
        if (!points.length) {
            return;
        }
        const x = points.map((p) => p.time);
        const rsiTrace = {
            type: "scatter",
            mode: "lines",
            name: "RSI 14",
            x,
            y: points.map((p) => p.rsi_14),
            line: { color: "#f5b041", width: 1.5 },
        };
        const layout = {
            template: "plotly_dark",
            margin: { l: 50, r: 20, t: 10, b: 30 },
            height: 160,
            xaxis: { type: "category", nticks: 10 },
            yaxis: { range: [0, 100] },
            shapes: [
                { type: "line", x0: x[0], x1: x[x.length - 1], y0: 70, y1: 70, line: { color: "#e74c3c", dash: "dash", width: 1 } },
                { type: "line", x0: x[0], x1: x[x.length - 1], y0: 30, y1: 30, line: { color: "#2ecc71", dash: "dash", width: 1 } },
            ],
            showlegend: false,
        };
        Plotly.react("rsi-chart", [rsiTrace], layout, { responsive: true, displaylogo: false });
    }

    // ---------------------------------------------------------------
    // Cards de predição / contexto / histórico
    // ---------------------------------------------------------------
    function updatePredictionCard(ml, decision) {
        const probabilityPct = Math.min(100, Math.max(0, (ml.probability || 0) * 100));
        el("prediction-probability-value").textContent = `${probabilityPct.toFixed(1)}%`;
        el("prediction-probability-fill").style.width = `${probabilityPct}%`;
        el("prediction-signal").textContent = ml.signal || "HOLD";
        el("prediction-direction").textContent = ml.direction || "HOLD";
        el("prediction-status").textContent = decision.status || "NÃO VALIDADO";
        el("prediction-severity").textContent = decision.severity || "TICK";
        el("prediction-reason").textContent = decision.validation_reason || "Sem validação";

        const card = el("prediction-card");
        card.classList.toggle("alert-banner--buy", ml.signal === "COMPRA" && decision.signal_valid);
        card.classList.toggle("alert-banner--sell", ml.signal === "VENDA" && decision.signal_valid);
    }

    function updateContextCard(analysis, indicators) {
        el("context-trend").textContent = analysis.trend || "INDEFINIDO";
        el("context-trend-strength").textContent = analysis.trend_strength || "INDEFINIDO";
        el("context-rsi").textContent = (indicators.rsi_14 || 0).toFixed(1);
        el("context-rsi-condition").textContent = analysis.rsi_condition || "INDEFINIDO";
        el("context-pattern").textContent = analysis.pattern || "INDEFINIDO";
        el("context-support").textContent = (analysis.support || 0).toFixed(2);
        el("context-resistance").textContent = (analysis.resistance || 0).toFixed(2);
    }

    function updateHistoryTable() {
        const tbody = el("history-table-body");
        tbody.innerHTML = "";
        state.history.forEach((payload) => {
            const ml = payload.ml || {};
            const decision = payload.decision || {};
            const ohlcv = payload.ohlcv || {};
            const row = document.createElement("tr");
            row.classList.add(ml.signal === "COMPRA" ? "row--buy" : ml.signal === "VENDA" ? "row--sell" : "");
            row.innerHTML = `
                <td>${new Date(payload.timestamp).toLocaleTimeString("pt-BR")}</td>
                <td>${(ohlcv.close || 0).toFixed(2)}</td>
                <td>${ml.signal || "HOLD"}</td>
                <td>${((ml.probability || 0) * 100).toFixed(1)}%</td>
                <td>${decision.status || "NÃO VALIDADO"}</td>
                <td>${decision.severity || "TICK"}</td>
            `;
            tbody.appendChild(row);
        });
    }

    // ---------------------------------------------------------------
    // Alertas visuais / sonoros / desktop
    // ---------------------------------------------------------------
    function maybeTriggerAlert(payload, ml, decision) {
        const probabilityPct = (ml.probability || 0) * 100;
        const isAlert = decision.severity === "ALERT" || probabilityPct > 65 || decision.signal_valid === true;
        if (!isAlert) {
            return;
        }
        const isBuy = ml.signal === "COMPRA" || ml.direction === "CALL";
        showBanner(isBuy, probabilityPct, decision.validation_reason);
        playAlertSound();
        showDesktopNotification(isBuy, probabilityPct, decision.validation_reason);
    }

    function showBanner(isBuy, probabilityPct, reason) {
        const banner = el("alert-banner");
        banner.textContent = `${isBuy ? "⬆ COMPRA" : "⬇ VENDA"} — probabilidade ${probabilityPct.toFixed(1)}% — ${reason || ""}`;
        banner.classList.remove("alert-banner--hidden", "alert-banner--buy", "alert-banner--sell");
        banner.classList.add(isBuy ? "alert-banner--buy" : "alert-banner--sell");
        window.clearTimeout(showBanner._timer);
        showBanner._timer = window.setTimeout(() => {
            banner.classList.add("alert-banner--hidden");
        }, 8000);
    }

    function playAlertSound() {
        if (!state.soundEnabled) {
            return;
        }
        try {
            if (!state.audioCtx) {
                const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
                state.audioCtx = new AudioContextCtor();
            }
            const ctx = state.audioCtx;
            const oscillator = ctx.createOscillator();
            const gain = ctx.createGain();
            oscillator.type = "sine";
            oscillator.frequency.setValueAtTime(880, ctx.currentTime);
            gain.gain.setValueAtTime(0.0001, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
            oscillator.connect(gain);
            gain.connect(ctx.destination);
            oscillator.start();
            oscillator.stop(ctx.currentTime + 0.45);
        } catch (err) {
            console.warn("Unable to play alert sound", err);
        }
    }

    function showDesktopNotification(isBuy, probabilityPct, reason) {
        if (!state.notificationsEnabled || typeof Notification === "undefined") {
            return;
        }
        if (Notification.permission !== "granted") {
            return;
        }
        const title = `WTNPS Fin — ${isBuy ? "Sinal de COMPRA" : "Sinal de VENDA"}`;
        new Notification(title, {
            body: `Probabilidade ${probabilityPct.toFixed(1)}% — ${reason || ""}`,
            tag: "wtnps-monitor-alert",
        });
    }

    // ---------------------------------------------------------------
    // Controles de UI
    // ---------------------------------------------------------------
    async function refreshStatus() {
        try {
            const data = await fetchJSON("/api/monitor/status");
            el("status-source-text").textContent = data.data_source || "—";
            el("status-monitors-text").textContent = data.active_monitors ?? 0;
            el("status-clients-text").textContent = data.websocket_connections ?? 0;
        } catch (err) {
            console.error("Failed to refresh monitor status", err);
        }
    }

    function bindControls() {
        el("input-symbol").addEventListener("change", (e) => {
            state.symbol = e.target.value.trim().toUpperCase() || state.symbol;
            reloadMarketData();
        });
        el("input-timeframe").addEventListener("change", (e) => {
            state.timeframe = e.target.value;
            reloadMarketData();
        });
        el("input-frequency").addEventListener("change", (e) => {
            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                state.ws.send(JSON.stringify({ action: "set_frequency", mode: e.target.value }));
            }
        });
        el("btn-start").addEventListener("click", async () => {
            await fetch(`/api/monitor/start?ticker=${encodeURIComponent(state.symbol)}&timeframe=${encodeURIComponent(state.timeframe)}`, { method: "POST" });
            refreshStatus();
        });
        el("btn-stop").addEventListener("click", async () => {
            await fetch(`/api/monitor/stop?ticker=${encodeURIComponent(state.symbol)}&timeframe=${encodeURIComponent(state.timeframe)}`, { method: "POST" });
            refreshStatus();
        });
        el("btn-sound").addEventListener("click", (e) => {
            state.soundEnabled = !state.soundEnabled;
            e.target.dataset.enabled = String(state.soundEnabled);
            e.target.textContent = state.soundEnabled ? "🔊 Som ativado" : "🔇 Som desativado";
            if (state.soundEnabled && !state.audioCtx) {
                const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
                state.audioCtx = new AudioContextCtor();
            }
        });
        el("btn-notify").addEventListener("click", async () => {
            if (typeof Notification === "undefined") {
                return;
            }
            const permission = await Notification.requestPermission();
            state.notificationsEnabled = permission === "granted";
            el("btn-notify").dataset.enabled = String(state.notificationsEnabled);
            el("btn-notify").textContent = state.notificationsEnabled ? "🔔 Notificações ativas" : "🔕 Notificações negadas";
        });
    }

    async function reloadMarketData() {
        state.candles = [];
        state.indicatorPoints = [];
        state.history = [];
        await loadInitialOhlc();
        await loadInitialPredictions();
    }

    // ---------------------------------------------------------------
    // Bootstrap
    // ---------------------------------------------------------------
    async function init() {
        bindControls();
        await loadInitialOhlc();
        await loadInitialPredictions();
        connectWebSocket();
        refreshStatus();
        window.setInterval(refreshStatus, 10000);
    }

    document.addEventListener("DOMContentLoaded", init);
})();
