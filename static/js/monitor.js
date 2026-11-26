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
        actionPending: false,
        marketVersion: 0,
        statusRequest: 0,
    };

    const el = (id) => document.getElementById(id);

    const marketTimeFormatter = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Sao_Paulo",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        fractionalSecondDigits: 3, hourCycle: "h23", timeZoneName: "longOffset",
    });

    function normalizeTime(value) {
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) return String(value);
        const parts = Object.fromEntries(marketTimeFormatter.formatToParts(parsed).map((part) => [part.type, part.value]));
        const offset = parts.timeZoneName.replace("GMT", "") || "+00:00";
        return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${offset}`;
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
        const version = state.marketVersion;
        const url = `/api/ohlc?symbol=${encodeURIComponent(state.symbol)}&timeframe=${encodeURIComponent(state.timeframe)}&limit=${state.ohlcLimit}&include_indicators=true`;
        try {
            const data = await fetchJSON(url);
            if (version !== state.marketVersion) return;
            const candles = (data.data || []).map((row) => ({
                time: normalizeTime(row.time),
                open: row.open,
                high: row.high,
                low: row.low,
                close: row.close,
                volume: row.volume,
            }));
            const indicatorPoints = (data.data || []).map((row) => ({
                time: normalizeTime(row.time),
                ema_9: row.ema_9, ema_20: row.ema_20,
                sma_20: row.sma_20, sma_50: row.sma_50, rsi_14: row.rsi_14,
            }));
            state.candles = mergePoints(candles, state.candles);
            state.indicatorPoints = mergePoints(indicatorPoints, state.indicatorPoints);
            if (data.warning) showMessage(data.warning, true);
            renderCandleChart();
        } catch (err) {
            if (version !== state.marketVersion) return;
            console.error("Failed to load initial OHLC", err);
            showMessage(`Erro ao carregar candles: ${err.message}`, true);
        }
    }

    function mergePoints(historical, live) {
        const byTime = new Map(historical.map((point) => [point.time, point]));
        live.forEach((point) => byTime.set(point.time, point));
        return Array.from(byTime.values())
            .sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
            .slice(-state.ohlcLimit);
    }

    async function loadInitialPredictions() {
        const version = state.marketVersion;
        const url = `/api/monitor-predictions?symbol=${encodeURIComponent(state.symbol)}&timeframe=${encodeURIComponent(state.timeframe)}&count=${state.predictionsCount}`;
        try {
            const data = await fetchJSON(url);
            if (version !== state.marketVersion) return;
            if (data.error) throw new Error(data.error);
            const predictions = data.predictions || [];
            predictions.forEach((payload) => ingestPayload(payload, { skipAlert: true }));
        } catch (err) {
            if (version !== state.marketVersion) return;
            console.error("Failed to load initial predictions", err);
            showMessage(`Erro ao carregar predições: ${err.message}`, true);
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
        const latestTime = state.history.length ? normalizeTime(state.history[0].timestamp) : "";
        const isLatest = !latestTime || Date.parse(timestamp) > Date.parse(latestTime) ||
            (timestamp === latestTime && !opts.skipAlert);

        const point = {
            time: timestamp,
            ema_9: indicators.ema_9,
            ema_20: indicators.ema_20,
            sma_20: indicators.sma_20,
            sma_50: indicators.sma_50,
            rsi_14: indicators.rsi_14,
        };
        // Historical predictions provide only a few points; the OHLC series
        // already contains the warm-started values for the whole chart.
        if (!opts.skipAlert) {
            const index = state.indicatorPoints.findIndex((p) => p.time === timestamp);
            if (index >= 0) state.indicatorPoints[index] = point;
            else state.indicatorPoints.push(point);
            state.indicatorPoints.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
            state.indicatorPoints = state.indicatorPoints.slice(-state.ohlcLimit);
        }
        if (isLatest) state.latestAnalysis = analysis;

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

        if (opts.skipAlert) state.history.push(payload);
        else state.history.unshift(payload);
        state.history.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
        state.history = state.history.slice(0, 20);

        if (isLatest) {
            updatePredictionCard(ml, decision);
            updateContextCard(analysis, indicators);
            el("status-last-update-text").textContent = new Date(payload.timestamp).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo" });
        }
        updateHistoryTable();
        renderCandleChart();

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
        if (typeof Plotly === "undefined") {
            showMessage("Erro ao carregar Plotly; verifique a conexão com a internet.", true);
            return;
        }
        if (!state.candles.length) {
            Plotly.purge("candles-chart");
            Plotly.purge("rsi-chart");
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
            if (ml.signal === "COMPRA") row.classList.add("row--buy");
            else if (ml.signal === "VENDA") row.classList.add("row--sell");
            row.innerHTML = `
                <td>${new Date(payload.timestamp).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo" })}</td>
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
        const request = ++state.statusRequest;
        try {
            const data = await fetchJSON("/api/monitor/status");
            if (request !== state.statusRequest) return;
            el("status-source-text").textContent = data.data_source || "—";
            el("status-monitors-text").textContent = data.active_monitors ?? 0;
            el("status-clients-text").textContent = data.websocket_connections ?? 0;
            const monitor = data.monitors.find((item) =>
                item.ticker.toUpperCase() === state.symbol.toUpperCase() &&
                item.timeframe.toUpperCase() === state.timeframe.toUpperCase()
            );
            if (!state.actionPending) {
                el("btn-start").disabled = !!monitor?.running;
                el("btn-stop").disabled = !monitor?.running;
            }
        } catch (err) {
            if (request !== state.statusRequest) return;
            console.error("Failed to refresh monitor status", err);
            el("btn-start").disabled = true;
            el("btn-stop").disabled = true;
            showMessage(`Erro ao consultar monitor: ${err.message}`, true);
        }
    }

    function showMessage(message, isError = false) {
        el("monitor-message").textContent = message;
        el("monitor-message").classList.toggle("error", isError);
    }

    async function monitorAction(action) {
        state.actionPending = true;
        el("btn-start").disabled = true;
        el("btn-stop").disabled = true;
        const symbol = state.symbol;
        const timeframe = state.timeframe;
        try {
            const response = await fetch("/api/monitor/" + action, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ticker: symbol, timeframe }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.detail || `HTTP ${response.status}`);
            const messages = {
                started: "Solicitação de início enviada.",
                already_running: "Monitor já está em execução.",
                stopped: "Monitor parado.",
                not_found: "Monitor não encontrado.",
            };
            if (!(result.status in messages)) throw new Error(`Resposta inesperada: ${result.status}`);
            showMessage(`${symbol} ${timeframe}: ${messages[result.status]}`, result.status === "not_found");
        } catch (err) {
            showMessage(`Erro ao ${action === "start" ? "iniciar" : "parar"} monitor: ${err.message}`, true);
        } finally {
            state.actionPending = false;
            await refreshStatus();
        }
    }

    function bindControls() {
        el("input-symbol").addEventListener("change", (e) => {
            state.symbol = e.target.value.trim().toUpperCase() || state.symbol;
            reloadMarketData();
            refreshStatus();
        });
        el("input-timeframe").addEventListener("change", (e) => {
            state.timeframe = e.target.value;
            reloadMarketData();
            refreshStatus();
        });
        el("input-frequency").addEventListener("change", (e) => {
            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                state.ws.send(JSON.stringify({ action: "set_frequency", mode: e.target.value }));
            }
        });
        el("btn-start").addEventListener("click", () => monitorAction("start"));
        el("btn-stop").addEventListener("click", () => monitorAction("stop"));
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
        state.marketVersion += 1;
        el("btn-start").disabled = true;
        el("btn-stop").disabled = true;
        state.candles = [];
        state.indicatorPoints = [];
        state.history = [];
        state.latestAnalysis = null;
        updatePredictionCard({}, {});
        updateContextCard({}, {});
        el("status-last-update-text").textContent = "—";
        el("alert-banner").classList.add("alert-banner--hidden");
        renderCandleChart();
        updateHistoryTable();
        await loadInitialOhlc();
        await loadInitialPredictions();
    }

    // ---------------------------------------------------------------
    // Bootstrap
    // ---------------------------------------------------------------
    async function init() {
        bindControls();
        refreshStatus();
        await loadInitialOhlc();
        await loadInitialPredictions();
        connectWebSocket();
        refreshStatus();
        window.setInterval(refreshStatus, 10000);
    }

    document.addEventListener("DOMContentLoaded", init);
})();
