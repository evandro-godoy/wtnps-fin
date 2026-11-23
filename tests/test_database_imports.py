import os
from pathlib import Path
import subprocess
import sys


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def run_python(*args, cwd):
    env = os.environ.copy()
    env.pop('PYTHONPATH', None)
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    return subprocess.run(
        [sys.executable, *args],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
    )


def test_models_runs_directly_from_another_directory(tmp_path):
    result = run_python(str(PROJECT_ROOT / 'src' / 'database' / 'models.py'), cwd=tmp_path)
    assert result.returncode == 0, result.stderr


def test_models_runs_as_module():
    result = run_python('-m', 'src.database.models', cwd=PROJECT_ROOT)
    assert result.returncode == 0, result.stderr


def test_package_reexports_the_original_models():
    code = (
        'from src.database import Base\n'
        'assert \"ohlcv_data\" in Base.metadata.tables\n'
        'from src.database import OHLCVData, TechnicalIndicators, MarketAnalysis, DataProviderLog\n'
        'from src.database import models\n'
        'assert all(getattr(models, cls.__name__) is cls for cls in '
        '(OHLCVData, TechnicalIndicators, MarketAnalysis, DataProviderLog))\n'
        'assert OHLCVData.metadata is Base.metadata\n'
    )
    result = run_python('-c', code, cwd=PROJECT_ROOT)
    assert result.returncode == 0, result.stderr
