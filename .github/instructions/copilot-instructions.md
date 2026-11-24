# Instruções de Arquitetura e Vibe Coding — wtnps-fin

## Ambiente e Comandos
- Gerenciador de dependências obrigatório: **Poetry** (`pyproject.toml`).
- Sempre execute scripts e testes usando `poetry run python ...` e `poetry run pytest` (nunca `pip install` global).
- Ambiente alvo de execução em produção: **Windows** (necessário para integração com MetaTrader 5).

## Regra de Ouro: Não Recriar Componentes Existentes
Antes de criar qualquer classe, serviço ou endpoint, reutilize a infraestrutura já consolidada:
- **Provedor de Dados:** `get_default_provider()` (`HybridProvider`: MT5 → Cache Parquet → Sintético) em `src/data_handler/provider.py` e `get_hybrid_candles()` em `src/data_handler/hybrid_data_loader.py`.
- **Inferência LSTM e Contexto Técnico:** `get_legacy_monitor_engine()` (`LegacyMonitorEngine.predict_on_candle`) em `src/ml/legacy_monitor_engine.py`, `LSTMVolatilityStrategy` em `src/strategies/lstm_volatility.py` e `MarketContextAnalyzer` em `src/analysis/context_analyzer.py`.
- **Motor Tempo Real e WebSocket:** `MonitorRuntime` em `src/services/monitor_runtime.py`, `RealtimeMarketMonitor` em `src/live/monitor_engine.py` e `/ws/monitor` em `src/api/websockets/monitor_ws.py`[cite: 2].
- **Contrato de Dados:** Todo payload de monitoramento deve respeitar estritamente `MonitorPayload` (`extra="forbid"`) em `src/schemas/monitor_payload.py`[cite: 2].
- **Configuração:** Parâmetros de ativos, regras ativas (`active_rules`) e caminhos ficam centralizados em `configs/config.py` e `configs/main.yaml`[cite: 2].

## Segurança e Integridade
- Nunca sobrescreva ou apague artefatos treinados em `models/` (`*.keras`, `*.joblib`) nem dados em `.cache_data/`[cite: 2].
- Nunca altere o schema do SQLite (`wtnps_trade.db` / `src/database/models.py`) sem criar migração ou preservar compatibilidade com `AssetsRatesRepository`[cite: 2].
- Toda nova funcionalidade deve incluir testes automatizados em `tests/` e passar em `poetry run pytest` antes da conclusão[cite: 2].