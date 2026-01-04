# ml_forecast.py
# ============================================================
# Forecast (scikit-learn) — diário e competência
# - Série diária contínua (preenche dias faltantes com 0)
# - Treina 2 alvos: income e expense
# - Validação temporal (walk-forward) + escolha baseline vs ML
# - Predição multi-step com recursão
# - Predição de categorias (heurística robusta) para compor UI
# - Serializa modelos via pickle+base64
#
# Robustez (anti-500 / contrato / NoneType.predict):
# - load seguro (_safe_load_model): não explode se b64 inválido/corrompido
# - fallback automático: se algo != baseline e model == None => baseline
# - _predict_one tolera model None e/ou ausência de numpy
# - ordenação/normalização defensiva do histórico (datas e tipos)
# - funções "V2" (objeto completo) e "V1" (lista) para compatibilidade com response_model antigo
# ============================================================

from __future__ import annotations

import base64
import pickle
from dataclasses import dataclass
from datetime import datetime, timedelta
from math import sin, cos, pi, sqrt
from typing import Any, Optional, Dict, List, Tuple

# scikit-learn / numpy (opcional)
try:
    import numpy as np
    from sklearn.linear_model import Ridge
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler
    from sklearn.ensemble import HistGradientBoostingRegressor
except Exception as e:
    np = None
    Ridge = None
    Pipeline = None
    StandardScaler = None
    HistGradientBoostingRegressor = None
    _SKLEARN_IMPORT_ERROR = e
else:
    _SKLEARN_IMPORT_ERROR = None


# -----------------------------
# Estatística básica (fallback sem numpy)
# -----------------------------
def _py_mean(xs: List[float]) -> float:
    if not xs:
        return 0.0
    return float(sum(xs) / float(len(xs)))


def _py_std(xs: List[float]) -> float:
    """
    Desvio padrão populacional (compatível com np.std padrão).
    """
    n = len(xs)
    if n <= 1:
        return 0.0
    mu = _py_mean(xs)
    var = sum((x - mu) ** 2 for x in xs) / float(n)
    return float(sqrt(var))


def _mean(xs: List[float]) -> float:
    if np is not None:
        return float(np.mean(np.array(xs, dtype=float))) if xs else 0.0
    return _py_mean(xs)


def _std(xs: List[float]) -> float:
    if np is not None:
        return float(np.std(np.array(xs, dtype=float))) if len(xs) > 1 else 0.0
    return _py_std(xs)


# -----------------------------
# Serialização (interna)
# -----------------------------
def dumps_model(obj: Any) -> str:
    raw = pickle.dumps(obj, protocol=pickle.HIGHEST_PROTOCOL)
    return base64.b64encode(raw).decode("utf-8")


def loads_model(b64: str) -> Any:
    raw = base64.b64decode(b64.encode("utf-8"))
    return pickle.loads(raw)


def _safe_load_model(b64: Optional[str]) -> Any:
    """
    Carrega modelo serializado em base64.
    - Retorna None se b64 for vazio/None ou inválido/corrompido.
    """
    if not b64:
        return None
    try:
        return loads_model(str(b64))
    except Exception:
        return None


# -----------------------------
# Utils defensivos
# -----------------------------
def _safe_float(x: Any, default: float = 0.0) -> float:
    try:
        if x is None:
            return float(default)
        return float(x)
    except Exception:
        return float(default)


def _parse_ymd(d: str) -> Optional[datetime]:
    try:
        return datetime.strptime(d, "%Y-%m-%d")
    except Exception:
        return None


def _sort_unique_daily_hist(hist: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Garante:
    - datas válidas YYYY-MM-DD quando possível
    - ordenação crescente (por data real; fallback lexicográfico)
    - 1 registro por data (último vence)
    - tipos numéricos coerentes
    """
    if not hist:
        return []

    tmp: Dict[str, Dict[str, Any]] = {}
    for r in hist:
        if not isinstance(r, dict):
            continue
        d = (r.get("date") or "").strip()
        if not d:
            continue

        tmp[d] = {
            "date": d,
            "income": _safe_float(r.get("income"), 0.0),
            "expense": _safe_float(r.get("expense"), 0.0),
        }

    def _key(dd: str):
        dt = _parse_ymd(dd)
        return dt if dt is not None else dd  # type: ignore[return-value]

    out = [tmp[d] for d in sorted(tmp.keys(), key=_key)]
    for r in out:
        r["net"] = float(_safe_float(r.get("income")) - _safe_float(r.get("expense")))
    return out


# -----------------------------
# Features
# -----------------------------
def _date_feats(date_str: str, t_idx: int) -> List[float]:
    dt = datetime.strptime(date_str, "%Y-%m-%d")
    dow = dt.weekday()  # 0..6
    dom = dt.day        # 1..31
    moy = dt.month      # 1..12

    ang7 = 2.0 * pi * (float(dow) / 7.0)
    ang12 = 2.0 * pi * (float(moy) / 12.0)

    return [
        float(t_idx),
        float(dow),
        sin(ang7),
        cos(ang7),
        float(dom),
        float(moy),
        sin(ang12),
        cos(ang12),
    ]


def _ym_feats(ym: str, t_idx: int) -> List[float]:
    _, m = ym.split("-")
    month = int(m)
    ang12 = 2.0 * pi * (float(month) / 12.0)
    return [float(t_idx), float(month), sin(ang12), cos(ang12)]


def _rolling_mean(vals: List[float], w: int) -> float:
    if not vals:
        return 0.0
    w = max(1, min(int(w), len(vals)))
    return float(sum(vals[-w:]) / float(w))


def _make_supervised_daily(
    dates: List[str],
    inc: List[float],
    exp: List[float],
    lags: int,
) -> Tuple["np.ndarray", "np.ndarray", "np.ndarray"]:
    if np is None:
        raise RuntimeError("numpy não disponível para _make_supervised_daily")

    X, y_inc, y_exp = [], [], []

    for i in range(lags, len(dates)):
        inc_lags = [inc[i - k] for k in range(1, lags + 1)]
        exp_lags = [exp[i - k] for k in range(1, lags + 1)]

        feats = _date_feats(dates[i], i)

        inc_ma7 = _rolling_mean(inc[:i], 7)
        inc_ma14 = _rolling_mean(inc[:i], 14)
        exp_ma7 = _rolling_mean(exp[:i], 7)
        exp_ma14 = _rolling_mean(exp[:i], 14)

        net_last = float(inc[i - 1] - exp[i - 1])
        net_ma7 = float(_rolling_mean([a - b for a, b in zip(inc[:i], exp[:i])], 7))

        row = feats + inc_lags + exp_lags + [inc_ma7, inc_ma14, exp_ma7, exp_ma14, net_last, net_ma7]
        X.append([float(v) for v in row])
        y_inc.append(float(inc[i]))
        y_exp.append(float(exp[i]))

    return np.array(X, dtype=float), np.array(y_inc, dtype=float), np.array(y_exp, dtype=float)


def _make_supervised_monthly(
    yms: List[str],
    inc: List[float],
    exp: List[float],
    lags: int,
) -> Tuple["np.ndarray", "np.ndarray", "np.ndarray"]:
    if np is None:
        raise RuntimeError("numpy não disponível para _make_supervised_monthly")

    X, y_inc, y_exp = [], [], []

    for i in range(lags, len(yms)):
        inc_lags = [inc[i - k] for k in range(1, lags + 1)]
        exp_lags = [exp[i - k] for k in range(1, lags + 1)]

        feats = _ym_feats(yms[i], i)

        inc_ma3 = _rolling_mean(inc[:i], 3)
        inc_ma6 = _rolling_mean(inc[:i], 6)
        exp_ma3 = _rolling_mean(exp[:i], 3)
        exp_ma6 = _rolling_mean(exp[:i], 6)

        net_last = float(inc[i - 1] - exp[i - 1])
        net_ma3 = float(_rolling_mean([a - b for a, b in zip(inc[:i], exp[:i])], 3))

        row = feats + inc_lags + exp_lags + [inc_ma3, inc_ma6, exp_ma3, exp_ma6, net_last, net_ma3]
        X.append([float(v) for v in row])
        y_inc.append(float(inc[i]))
        y_exp.append(float(exp[i]))

    return np.array(X, dtype=float), np.array(y_inc, dtype=float), np.array(y_exp, dtype=float)


# -----------------------------
# Métricas e validação temporal
# -----------------------------
def _mae(y_true: "np.ndarray", y_pred: "np.ndarray") -> float:
    return float(np.mean(np.abs(y_true - y_pred)))


def _walk_forward_mae(
    X: "np.ndarray",
    y: "np.ndarray",
    fit_predict_fn,
    n_start: int,
    n_steps: int,
) -> float:
    """
    Walk-forward 1-step:
    - Treina em [0:t)
    - Prediz em t
    - Avança
    """
    n = len(y)
    n_start = max(5, min(int(n_start), n - 2))
    end = min(n, n_start + max(1, int(n_steps)))

    preds = []
    trues = []

    for t in range(n_start, end):
        Xtr, ytr = X[:t], y[:t]
        Xte, yte = X[t:t + 1], y[t:t + 1]
        yp = float(fit_predict_fn(Xtr, ytr, Xte)[0])
        preds.append(yp)
        trues.append(float(yte[0]))

    return _mae(np.array(trues, dtype=float), np.array(preds, dtype=float))


# -----------------------------
# Baseline sazonal (forte e barato)
# -----------------------------
def _baseline_seasonal_predict_one(
    history_dates: List[str],
    history_vals: List[float],
    target_date: str,
    fallback_w: int = 7,
    alpha: float = 0.6,
) -> float:
    """
    Prediz usando média do mesmo dia da semana nas últimas semanas,
    com suavização para a média móvel recente.

    alpha -> peso do sazonal; (1-alpha) -> peso da média móvel
    """
    if not history_vals:
        return 0.0

    ma = _rolling_mean(history_vals, fallback_w)

    dt_target = datetime.strptime(target_date, "%Y-%m-%d")
    dow_target = dt_target.weekday()

    lookback = min(len(history_dates), 56)
    vals_same_dow = []
    for d, v in zip(history_dates[-lookback:], history_vals[-lookback:]):
        try:
            if datetime.strptime(d, "%Y-%m-%d").weekday() == dow_target:
                vals_same_dow.append(float(v))
        except Exception:
            continue

    if not vals_same_dow:
        return float(ma)

    seasonal = float(sum(vals_same_dow) / float(len(vals_same_dow)))
    return float(alpha * seasonal + (1.0 - alpha) * ma)


# -----------------------------
# Treino (um alvo)
# -----------------------------
@dataclass
class TrainedTarget:
    algo: str
    model_b64: Optional[str]
    mae_val: float
    baseline_mae_val: float
    resid_std: float


def _fit_one_target(
    X: "np.ndarray",
    y: "np.ndarray",
    dates_for_baseline: Optional[List[str]] = None,
    force_ml: bool = False,
) -> TrainedTarget:
    """
    Seleção entre:
    - baseline_seasonal
    - Ridge
    - HistGradientBoostingRegressor

    Validação: walk-forward em janela final (~20%).
    """
    # Se algo essencial do ML não existir, cai em baseline sem drama
    if np is None or Pipeline is None or StandardScaler is None or Ridge is None or HistGradientBoostingRegressor is None:
        ys = [float(v) for v in (y.tolist() if hasattr(y, "tolist") else list(y))]
        s = _std(ys)
        return TrainedTarget(
            algo="baseline_seasonal",
            model_b64=None,
            mae_val=float(s),
            baseline_mae_val=float(s),
            resid_std=float(s),
        )

    n = len(y)
    if n < 20:
        resid = y - np.mean(y)
        s = float(np.std(resid) if len(resid) > 1 else 0.0)
        return TrainedTarget(
            algo="baseline_seasonal",
            model_b64=None,
            mae_val=s,
            baseline_mae_val=s,
            resid_std=s,
        )

    n_val = max(10, int(0.2 * n))
    n_start = n - n_val
    n_steps = n_val

    # ---- baseline walk-forward
    if dates_for_baseline is None:
        def baseline_fit_predict(_Xtr, ytr, _Xte):
            last = float(ytr[-1])
            return np.array([last], dtype=float)

        base_mae = _walk_forward_mae(X, y, baseline_fit_predict, n_start=n_start, n_steps=n_steps)
    else:
        def baseline_fit_predict(_Xtr, ytr, _Xte):
            t = len(ytr)
            if t < 1:
                return np.array([0.0], dtype=float)
            if t >= len(dates_for_baseline):
                return np.array([float(ytr[-1])], dtype=float)

            target_date = dates_for_baseline[t]
            pred = _baseline_seasonal_predict_one(
                history_dates=dates_for_baseline[:t],
                history_vals=[float(v) for v in y[:t]],
                target_date=target_date,
            )
            return np.array([pred], dtype=float)

        base_mae = _walk_forward_mae(X, y, baseline_fit_predict, n_start=n_start, n_steps=n_steps)

    # ---- Ridge
    def ridge_fit_predict(Xtr, ytr, Xte):
        model = Pipeline([
            ("scaler", StandardScaler(with_mean=True, with_std=True)),
            ("model", Ridge(alpha=3.0)),
        ])
        model.fit(Xtr, ytr)
        return model.predict(Xte)

    ridge_mae = _walk_forward_mae(X, y, ridge_fit_predict, n_start=n_start, n_steps=n_steps)

    # ---- HGB
    def hgb_fit_predict(Xtr, ytr, Xte):
        model = HistGradientBoostingRegressor(
            loss="squared_error",
            max_depth=3,
            learning_rate=0.06,
            max_iter=450,
            random_state=42,
        )
        model.fit(Xtr, ytr)
        return model.predict(Xte)

    hgb_mae = _walk_forward_mae(X, y, hgb_fit_predict, n_start=n_start, n_steps=n_steps)

    best_algo = "baseline_seasonal"
    best_mae = float(base_mae)
    best_model = None

    if ridge_mae < best_mae:
        best_algo = "ridge"
        best_mae = float(ridge_mae)

    if hgb_mae < best_mae:
        best_algo = "hgb"
        best_mae = float(hgb_mae)

    # Se não forçado, ML só ganha se vencer baseline com folga mínima
    if (not force_ml) and (best_algo != "baseline_seasonal"):
        if best_mae >= (1.0 - 0.02) * float(base_mae):
            best_algo = "baseline_seasonal"
            best_mae = float(base_mae)

    # Treina modelo final em TODO histórico (se ML escolhido)
    if best_algo == "ridge":
        final_model = Pipeline([
            ("scaler", StandardScaler(with_mean=True, with_std=True)),
            ("model", Ridge(alpha=3.0)),
        ])
        final_model.fit(X, y)
        best_model = final_model

        resid = final_model.predict(X) - y
        resid_std = float(np.std(resid)) if len(resid) > 1 else 0.0

    elif best_algo == "hgb":
        final_model = HistGradientBoostingRegressor(
            loss="squared_error",
            max_depth=3,
            learning_rate=0.06,
            max_iter=450,
            random_state=42,
        )
        final_model.fit(X, y)
        best_model = final_model

        resid = final_model.predict(X) - y
        resid_std = float(np.std(resid)) if len(resid) > 1 else 0.0

    else:
        tail = y[-max(14, int(0.2 * len(y))):]
        resid_std = float(np.std(tail - np.mean(tail))) if len(tail) > 1 else 0.0

    return TrainedTarget(
        algo=best_algo,
        model_b64=(dumps_model(best_model) if best_model is not None else None),
        mae_val=float(best_mae),
        baseline_mae_val=float(base_mae),
        resid_std=float(resid_std),
    )


# -----------------------------
# Preencher datas faltantes
# -----------------------------
def fill_daily_series(rows: List[Dict[str, Any]]) -> Tuple[List[str], List[float], List[float]]:
    """
    rows: [{date:'YYYY-MM-DD', income:float, expense:float}] (dias com movimento)
    devolve série diária contínua (dias sem movimento => 0)
    """
    if not rows:
        return [], [], []

    # normaliza e mantém 1 por dia (último vence)
    by_d: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        if not isinstance(r, dict):
            continue
        d = (r.get("date") or "").strip()
        if not d:
            continue
        # opcional: valida formato
        if _parse_ymd(d) is None:
            continue
        by_d[d] = r

    if not by_d:
        return [], [], []

    d0 = datetime.strptime(min(by_d.keys()), "%Y-%m-%d")
    d1 = datetime.strptime(max(by_d.keys()), "%Y-%m-%d")

    dates, inc, exp = [], [], []
    cur = d0
    while cur <= d1:
        ds = cur.strftime("%Y-%m-%d")
        r = by_d.get(ds, {})
        dates.append(ds)
        inc.append(_safe_float(r.get("income"), 0.0))
        exp.append(_safe_float(r.get("expense"), 0.0))
        cur += timedelta(days=1)

    return dates, inc, exp


def month_seq(start_ym: str, end_ym: str) -> List[str]:
    sy, sm = start_ym.split("-")
    ey, em = end_ym.split("-")
    y, m = int(sy), int(sm)
    y_end, m_end = int(ey), int(em)

    out = []
    while (y < y_end) or (y == y_end and m <= m_end):
        out.append(f"{y:04d}-{m:02d}")
        m += 1
        if m == 13:
            m = 1
            y += 1
    return out


def fill_monthly_series(rows: List[Dict[str, Any]]) -> Tuple[List[str], List[float], List[float]]:
    if not rows:
        return [], [], []

    by_ym: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        if not isinstance(r, dict):
            continue
        ym = (r.get("ym") or "").strip()
        if not ym:
            continue
        # valida simples YYYY-MM
        try:
            datetime.strptime(ym + "-01", "%Y-%m-%d")
        except Exception:
            continue
        by_ym[ym] = r

    if not by_ym:
        return [], [], []

    start_ym = min(by_ym.keys())
    end_ym = max(by_ym.keys())

    yms = month_seq(start_ym, end_ym)
    inc, exp = [], []
    for ym in yms:
        r = by_ym.get(ym, {})
        inc.append(_safe_float(r.get("income"), 0.0))
        exp.append(_safe_float(r.get("expense_total"), 0.0))
    return yms, inc, exp


# -----------------------------
# Categorias: modelo heurístico (robusto e explicável)
# -----------------------------
def build_category_profile(
    rows_expense_by_category_daily: List[Dict[str, Any]],
    decay: float = 0.965,
    smooth: float = 1.0,
) -> Dict[str, float]:
    """
    Entrada esperada (por dia e categoria):
      [{date:'YYYY-MM-DD', category:'Moradia', expense:123.45}, ...]

    Retorna "peso" por categoria (não-normalizado).
    - decay aplica maior peso a dias recentes (exponencial)
    - smooth evita categoria sumir (Laplace)
    """
    if not rows_expense_by_category_daily:
        return {}

    valid_rows = []
    for r in rows_expense_by_category_daily:
        if not isinstance(r, dict):
            continue
        d = (r.get("date") or "").strip()
        if not d or _parse_ymd(d) is None:
            continue
        valid_rows.append(r)

    if not valid_rows:
        return {}

    rows = sorted(valid_rows, key=lambda r: r["date"])
    unique_dates = sorted({r["date"] for r in rows})
    idx_map = {d: i for i, d in enumerate(unique_dates)}

    T = len(unique_dates)
    w_date = {d: (decay ** (T - 1 - idx_map[d])) for d in unique_dates}

    weights: Dict[str, float] = {}
    for r in rows:
        cat = str(r.get("category") or "Outros")
        v = _safe_float(r.get("expense"), 0.0)
        if v <= 0:
            continue
        weights[cat] = weights.get(cat, 0.0) + (v * float(w_date.get(r["date"], 1.0)))

    if weights and smooth > 0:
        for k in list(weights.keys()):
            weights[k] = float(weights[k] + smooth)

    return weights


def allocate_expense_to_categories(
    expense_value: float,
    cat_weights: Dict[str, float],
    top_k: int = 8,
) -> Tuple[Dict[str, float], List[Dict[str, Any]]]:
    """
    Distribui expense_value proporcionalmente aos pesos de categoria.
    Retorna:
      (dict completo por categoria, lista top_k com share)
    """
    expense_value = float(max(0.0, float(expense_value)))

    if not cat_weights:
        d = {"Outros": expense_value}
        top = [{"category": "Outros", "amount": expense_value, "share": 1.0}]
        return d, top

    total_w = float(sum(max(0.0, float(v)) for v in cat_weights.values()))
    if total_w <= 0:
        d = {"Outros": expense_value}
        top = [{"category": "Outros", "amount": expense_value, "share": 1.0}]
        return d, top

    alloc: Dict[str, float] = {}
    for cat, w in cat_weights.items():
        w = float(max(0.0, float(w)))
        alloc[cat] = float(expense_value * (w / total_w))

    items = sorted(alloc.items(), key=lambda kv: kv[1], reverse=True)
    top = []
    for cat, amt in items[:max(1, int(top_k))]:
        share = float(amt / expense_value) if expense_value > 0 else 0.0
        top.append({"category": cat, "amount": float(amt), "share": float(share)})

    return alloc, top


# -----------------------------
# Treino + payload (diário)
# -----------------------------
def train_daily_sklearn(
    rows_daily_income_expense: List[Dict[str, Any]],
    lags: int = 14,
    force_ml: bool = False,
) -> Dict[str, Any]:
    """
    Retorna payload treinado para daily.
    - Se ML indisponível (numpy/sklearn): retorna baseline (sem levantar exceção).
    - Se histórico curto: baseline.
    """
    dates, inc, exp = fill_daily_series(rows_daily_income_expense)

    if not dates:
        return {
            "basis": "cash_daily_sklearn",
            "trained_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "lags": int(lags),
            "warning": "Sem histórico diário.",
            "history_tail": [],
            "targets": {},
        }

    lags = int(max(3, min(int(lags), 30)))
    if len(dates) <= (lags + 5):
        lags = int(max(3, min(lags, max(3, len(dates) // 3))))

    # baseline por falta de dados
    if len(dates) <= (lags + 2):
        return {
            "basis": "cash_daily_sklearn",
            "trained_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "lags": int(lags),
            "warning": "Histórico insuficiente para ML. Usando baseline sazonal.",
            "history_tail": [{"date": d, "income": float(i), "expense": float(e), "net": float(i - e)}
                             for d, i, e in zip(dates[-60:], inc[-60:], exp[-60:])],
            "targets": {
                "income": TrainedTarget("baseline_seasonal", None, 0.0, 0.0, float(_std(inc))).__dict__,
                "expense": TrainedTarget("baseline_seasonal", None, 0.0, 0.0, float(_std(exp))).__dict__,
            },
        }

    # Se ML não disponível, baseline (sem derrubar API)
    if _SKLEARN_IMPORT_ERROR is not None or np is None:
        return {
            "basis": "cash_daily_sklearn",
            "trained_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "lags": int(lags),
            "warning": f"ML indisponível ({_SKLEARN_IMPORT_ERROR}). Usando baseline sazonal.",
            "history_tail": [{"date": d, "income": float(i), "expense": float(e), "net": float(i - e)}
                             for d, i, e in zip(dates[-90:], inc[-90:], exp[-90:], )],
            "targets": {
                "income": TrainedTarget("baseline_seasonal", None, 0.0, 0.0, float(_std(inc))).__dict__,
                "expense": TrainedTarget("baseline_seasonal", None, 0.0, 0.0, float(_std(exp))).__dict__,
            },
        }

    X, y_inc, y_exp = _make_supervised_daily(dates, inc, exp, lags=lags)
    dates_y = dates[lags:]  # y começa em dates[lags:]

    t_inc = _fit_one_target(X, y_inc, dates_for_baseline=dates_y, force_ml=bool(force_ml))
    t_exp = _fit_one_target(X, y_exp, dates_for_baseline=dates_y, force_ml=bool(force_ml))

    return {
        "basis": "cash_daily_sklearn",
        "trained_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "lags": int(lags),
        "history_tail": [{"date": d, "income": float(i), "expense": float(e), "net": float(i - e)}
                         for d, i, e in zip(dates[-90:], inc[-90:], exp[-90:])],
        "targets": {
            "income": t_inc.__dict__,
            "expense": t_exp.__dict__,
        },
        "feature_spec": {
            "date_feats": ["t_idx", "dow", "sin7", "cos7", "dom", "moy", "sin12", "cos12"],
            "lags_income": [f"inc_lag_{k}" for k in range(1, lags + 1)],
            "lags_expense": [f"exp_lag_{k}" for k in range(1, lags + 1)],
            "ma": ["inc_ma7", "inc_ma14", "exp_ma7", "exp_ma14"],
            "net": ["net_last", "net_ma7"],
        },
        "note": "Modelos separados para income e expense. Série diária contínua.",
    }


def _predict_one(
    algo: str,
    model: Any,
    baseline_hist_dates: List[str],
    baseline_hist_vals: List[float],
    target_date: str,
    X: Optional[Any] = None,
) -> float:
    """
    Predição 1-step robusta.
    - Se baseline: sempre funciona (não depende de numpy)
    - Se ML mas model=None/X=None: cai para baseline
    """
    if algo == "baseline_seasonal":
        return float(_baseline_seasonal_predict_one(baseline_hist_dates, baseline_hist_vals, target_date))

    if model is None or X is None:
        return float(_baseline_seasonal_predict_one(baseline_hist_dates, baseline_hist_vals, target_date))

    try:
        return float(model.predict(X)[0])
    except Exception:
        return float(_baseline_seasonal_predict_one(baseline_hist_dates, baseline_hist_vals, target_date))

def _today_ymd_local() -> str:
    """
    Data local do servidor no formato YYYY-MM-DD.
    Observação: se você quer a data do usuário (America/Sao_Paulo),
    o ideal é passar anchor_date pelo endpoint (string YYYY-MM-DD).
    """
    return datetime.now().strftime("%Y-%m-%d")


def _extend_series_until_anchor_with_zeros(
    dates: List[str],
    inc_vals: List[float],
    exp_vals: List[float],
    anchor_date: str,
) -> Tuple[List[str], List[float], List[float]]:
    """
    Estende a série diária (dates/inc/exp) com dias faltantes preenchidos com 0,
    de modo que o último dia do histórico fique em anchor_date - 1.

    Exemplo:
      último histórico = 2025-11-30
      anchor_date = 2026-01-02
      => adiciona 2025-12-01..2026-01-01 com (0,0)

    Se anchor_date <= último histórico: não altera (previsão segue a partir do último histórico).
    """
    if not dates:
        return dates, inc_vals, exp_vals

    adt = _parse_ymd(anchor_date)
    if adt is None:
        return dates, inc_vals, exp_vals

    last = _parse_ymd(dates[-1])
    if last is None:
        return dates, inc_vals, exp_vals

    # Queremos histórico até anchor_date-1
    target_last = adt - timedelta(days=1)

    if target_last <= last:
        return dates, inc_vals, exp_vals

    cur = last + timedelta(days=1)
    while cur <= target_last:
        ds = cur.strftime("%Y-%m-%d")
        dates.append(ds)
        inc_vals.append(0.0)
        exp_vals.append(0.0)
        cur += timedelta(days=1)

    return dates, inc_vals, exp_vals


# -----------------------------
# Forecast diário — V2 (objeto completo)
# -----------------------------
def forecast_next_days_daily_v2(
    payload: Dict[str, Any],
    days: int = 7,
    rows_expense_by_category_daily: Optional[List[Dict[str, Any]]] = None,
    top_k_categories: int = 8,
    anchor_date: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Retorna forecast completo para UI (V2):
    - meta, horizon_days, kpis, series, top_categories, alerts, risk_score

    anchor_date (YYYY-MM-DD):
      - Se informado e for maior que o último dia do histórico, estende a série com zeros
        até anchor_date-1 e inicia a previsão em anchor_date.
      - Se não informado, usa a data local do servidor.
    """
    days = int(days)
    if days < 1 or days > 60:
        raise ValueError("days deve estar entre 1 e 60.")

    hist_raw = payload.get("history_tail") or []
    hist = _sort_unique_daily_hist(hist_raw)

    if not hist:
        return {
            "meta": {
                "basis": payload.get("basis"),
                "trained_at": payload.get("trained_at"),
                "anchor_date": anchor_date or _today_ymd_local(),
                "history_last_date": None,
            },
            "horizon_days": days,
            "kpis": {"income_pred_total": 0.0, "expense_pred_total": 0.0, "net_pred_total": 0.0},
            "series": [],
            "top_categories": [],
            "alerts": [{"level": "warn", "message": "Sem histórico no payload."}],
            "risk_score": 0,
        }

    lags = int(payload.get("lags", 14))

    dates = [r["date"] for r in hist]
    inc_vals = [float(r["income"]) for r in hist]
    exp_vals = [float(r["expense"]) for r in hist]

    # Ajusta lags defensivo
    if len(inc_vals) < max(3, lags) or len(exp_vals) < max(3, lags):
        lags = int(max(3, min(lags, len(inc_vals) - 1, len(exp_vals) - 1)))

    # ---- Âncora: se o histórico é antigo, estende com zeros até (anchor_date - 1)
    effective_anchor = (anchor_date or _today_ymd_local()).strip()
    dates, inc_vals, exp_vals = _extend_series_until_anchor_with_zeros(
        dates=dates,
        inc_vals=inc_vals,
        exp_vals=exp_vals,
        anchor_date=effective_anchor,
    )

    t_income = payload.get("targets", {}).get("income") or {}
    t_expense = payload.get("targets", {}).get("expense") or {}

    inc_algo = str(t_income.get("algo") or "baseline_seasonal")
    exp_algo = str(t_expense.get("algo") or "baseline_seasonal")

    inc_model = _safe_load_model(t_income.get("model_b64"))
    exp_model = _safe_load_model(t_expense.get("model_b64"))

    # fallback: se payload diz ML mas modelo não existe, baseline.
    if inc_algo != "baseline_seasonal" and inc_model is None:
        inc_algo = "baseline_seasonal"
    if exp_algo != "baseline_seasonal" and exp_model is None:
        exp_algo = "baseline_seasonal"

    inc_std = float(t_income.get("resid_std") or 0.0)
    exp_std = float(t_expense.get("resid_std") or 0.0)

    # Se numpy não existe, forçamos baseline (porque o X não será montado).
    if np is None:
        inc_algo = "baseline_seasonal"
        exp_algo = "baseline_seasonal"
        inc_model = None
        exp_model = None

    cat_profile = build_category_profile(rows_expense_by_category_daily or [])

    # A previsão sempre parte do último dia *da série estendida*
    last_dt = datetime.strptime(dates[-1], "%Y-%m-%d")
    preds: List[Dict[str, Any]] = []

    for h in range(1, days + 1):
        fdt = last_dt + timedelta(days=h)
        fdate = fdt.strftime("%Y-%m-%d")
        t_idx = (len(dates) - 1) + h

        # lags
        eff_lags = int(min(lags, len(inc_vals), len(exp_vals), 30))
        eff_lags = max(3, eff_lags)

        inc_lags = [inc_vals[-k] for k in range(1, eff_lags + 1)]
        exp_lags = [exp_vals[-k] for k in range(1, eff_lags + 1)]
        feats = _date_feats(fdate, t_idx)

        inc_ma7 = _rolling_mean(inc_vals, 7)
        inc_ma14 = _rolling_mean(inc_vals, 14)
        exp_ma7 = _rolling_mean(exp_vals, 7)
        exp_ma14 = _rolling_mean(exp_vals, 14)

        net_last = float(inc_vals[-1] - exp_vals[-1])
        net_ma7 = float(_rolling_mean([a - b for a, b in zip(inc_vals[-30:], exp_vals[-30:])], 7))

        X = None
        if np is not None and (
            (inc_algo != "baseline_seasonal" and inc_model is not None) or
            (exp_algo != "baseline_seasonal" and exp_model is not None)
        ):
            X = np.array([feats + inc_lags + exp_lags + [inc_ma7, inc_ma14, exp_ma7, exp_ma14, net_last, net_ma7]], dtype=float)

        inc_pred = _predict_one(
            algo=inc_algo,
            model=inc_model,
            baseline_hist_dates=dates,
            baseline_hist_vals=inc_vals,
            target_date=fdate,
            X=X,
        )
        inc_pred = max(0.0, float(inc_pred))

        exp_pred = _predict_one(
            algo=alerts if False else exp_algo,  # não muda nada; só evita "variável não usada" em alguns linters
            model=exp_model,
            baseline_hist_dates=dates,
            baseline_hist_vals=exp_vals,
            target_date=fdate,
            X=X,
        )
        exp_pred = max(0.0, float(exp_pred))

        net_pred = float(inc_pred - exp_pred)

        z = 1.28
        inc_low, inc_high = max(0.0, inc_pred - z * inc_std), inc_pred + z * inc_std
        exp_low, exp_high = max(0.0, exp_pred - z * exp_std), exp_pred + z * exp_std

        exp_by_cat, _ = allocate_expense_to_categories(exp_pred, cat_profile, top_k=top_k_categories)

        preds.append({
            "date": fdate,
            "income_pred": float(inc_pred),
            "expense_pred": float(exp_pred),
            "net_pred": float(net_pred),
            "income_low": float(inc_low),
            "income_high": float(inc_high),
            "expense_low": float(exp_low),
            "expense_high": float(exp_high),
            "expense_by_category": exp_by_cat,
        })

        # recursão
        inc_vals.append(float(inc_pred))
        exp_vals.append(float(exp_pred))
        dates.append(fdate)

    income_total = float(sum(p["income_pred"] for p in preds))
    expense_total = float(sum(p["expense_pred"] for p in preds))
    net_total = float(income_total - expense_total)

    # categorias agregadas
    cat_sum: Dict[str, float] = {}
    for p in preds:
        for cat, amt in (p.get("expense_by_category") or {}).items():
            cat_sum[cat] = float(cat_sum.get(cat, 0.0) + float(amt))

    top_cats = sorted(cat_sum.items(), key=lambda kv: kv[1], reverse=True)
    top_categories = []
    for cat, amt in top_cats[:max(1, int(top_k_categories))]:
        share = float(amt / expense_total) if expense_total > 0 else 0.0
        top_categories.append({"category": cat, "amount": float(amt), "share": float(share)})

    # alertas/risco (estatística no histórico estendido recente)
    alerts_out = []
    risk = 0

    hist_exp = [float(x) for x in exp_vals[-60:]]  # já inclui zeros se houve buraco
    mu = _mean(hist_exp)
    sigma = _std(hist_exp)

    exp_avg_pred = float(expense_total / float(days)) if days > 0 else 0.0
    if sigma > 0 and exp_avg_pred > mu + 1.0 * sigma:
        alerts_out.append({"level": "warn", "message": "Despesa média prevista acima do padrão recente."})
        risk += 3

    if net_total < 0:
        alerts_out.append({"level": "warn", "message": "Saldo líquido previsto negativo no horizonte."})
        risk += 4

    if (inc_std + exp_std) > 0 and (inc_std + exp_std) > (0.6 * (mu + 1e-9)):
        alerts_out.append({"level": "info", "message": "Incerteza elevada: histórico instável ou esparso."})
        risk += 2

    risk = int(max(0, min(10, risk)))

    return {
        "meta": {
            "basis": payload.get("basis"),
            "trained_at": payload.get("trained_at"),
            "lags": payload.get("lags"),
            "income_algo": inc_algo,
            "expense_algo": exp_algo,
            "anchor_date": effective_anchor,
            "history_last_date": hist[-1]["date"] if hist else None,
        },
        "horizon_days": days,
        "kpis": {
            "income_pred_total": float(income_total),
            "expense_pred_total": float(expense_total),
            "net_pred_total": float(net_total),
        },
        "series": preds,
        "top_categories": top_categories,
        "alerts": alerts_out,
        "risk_score": risk,
    }


# -----------------------------
# Forecast diário — V1 (compat: lista)
# -----------------------------
def forecast_next_days_daily_v1_list(
    payload: Dict[str, Any],
    days: int = 7,
    rows_expense_by_category_daily: Optional[List[Dict[str, Any]]] = None,
    top_k_categories: int = 8,
    anchor_date: Optional[str] = None,
) -> List[Dict[str, Any]]:
    out = forecast_next_days_daily_v2(
        payload=payload,
        days=days,
        rows_expense_by_category_daily=rows_expense_by_category_daily,
        top_k_categories=top_k_categories,
        anchor_date=anchor_date,
    )
    return list(out.get("series") or [])


def forecast_next_days_daily_response(
    payload: Dict[str, Any],
    days: int = 7,
    rows_expense_by_category_daily: Optional[List[Dict[str, Any]]] = None,
    top_k_categories: int = 8,
    mode: str = "v2",
    anchor_date: Optional[str] = None,
) -> Any:
    mode = (mode or "v2").strip().lower()
    if mode == "v1_list":
        return forecast_next_days_daily_v1_list(
            payload, days, rows_expense_by_category_daily, top_k_categories, anchor_date
        )
    return forecast_next_days_daily_v2(
        payload, days, rows_expense_by_category_daily, top_k_categories, anchor_date
    )


# Mantém compatibilidade de nome (se você já chama forecast_next_days_daily)
forecast_next_days_daily = forecast_next_days_daily_v2


def forecast_next_days_daily_response(
    payload: Dict[str, Any],
    days: int = 7,
    rows_expense_by_category_daily: Optional[List[Dict[str, Any]]] = None,
    top_k_categories: int = 8,
    mode: str = "v2",
) -> Any:
    """
    Helper para o ENDPOINT decidir o formato sem refatorar tudo.

    mode:
      - "v2"      -> dict completo (meta/horizon/kpis/series/...)
      - "v1_list" -> lista (compat) == V2["series"]
    """
    mode = (mode or "v2").strip().lower()
    if mode == "v1_list":
        return forecast_next_days_daily_v1_list(payload, days, rows_expense_by_category_daily, top_k_categories)
    return forecast_next_days_daily_v2(payload, days, rows_expense_by_category_daily, top_k_categories)


# Mantém compatibilidade de nome (se você já chama forecast_next_days_daily)
forecast_next_days_daily = forecast_next_days_daily_v2


# -----------------------------
# Mensal (competência)
# -----------------------------
def train_monthly_sklearn(
    rows_monthly_income_expense: List[Dict[str, Any]],
    lags: int = 6,
    force_ml: bool = False,
) -> Dict[str, Any]:
    yms, inc, exp = fill_monthly_series(rows_monthly_income_expense)
    if not yms:
        return {
            "basis": "competencia_sklearn",
            "trained_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "lags": int(lags),
            "warning": "Sem histórico mensal.",
            "history": [],
            "targets": {},
        }

    lags = int(max(2, min(int(lags), 12)))
    if len(yms) <= (lags + 2):
        lags = int(max(2, min(lags, max(2, len(yms) // 3))))

    # baseline por falta de dados
    if len(yms) <= (lags + 1):
        return {
            "basis": "competencia_sklearn",
            "trained_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "lags": int(lags),
            "warning": "Histórico insuficiente para ML. Usando baseline sazonal.",
            "history": [{"ym": ym, "income": float(i), "expense_total": float(e), "balance": float(i - e)}
                        for ym, i, e in zip(yms, inc, exp)],
            "targets": {
                "income": TrainedTarget("baseline_seasonal", None, 0.0, 0.0, float(_std(inc))).__dict__,
                "expense_total": TrainedTarget("baseline_seasonal", None, 0.0, 0.0, float(_std(exp))).__dict__,
            },
        }

    # Se ML não disponível, baseline
    if _SKLEARN_IMPORT_ERROR is not None or np is None:
        return {
            "basis": "competencia_sklearn",
            "trained_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "lags": int(lags),
            "warning": f"ML indisponível ({_SKLEARN_IMPORT_ERROR}). Usando baseline sazonal.",
            "history": [{"ym": ym, "income": float(i), "expense_total": float(e), "balance": float(i - e)}
                        for ym, i, e in zip(yms, inc, exp)],
            "targets": {
                "income": TrainedTarget("baseline_seasonal", None, 0.0, 0.0, float(_std(inc))).__dict__,
                "expense_total": TrainedTarget("baseline_seasonal", None, 0.0, 0.0, float(_std(exp))).__dict__,
            },
        }

    X, y_inc, y_exp = _make_supervised_monthly(yms, inc, exp, lags=lags)

    t_inc = _fit_one_target(X, y_inc, dates_for_baseline=None, force_ml=bool(force_ml))
    t_exp = _fit_one_target(X, y_exp, dates_for_baseline=None, force_ml=bool(force_ml))

    return {
        "basis": "competencia_sklearn",
        "trained_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "lags": int(lags),
        "start_ym": yms[0],
        "end_ym": yms[-1],
        "history": [{"ym": ym, "income": float(i), "expense_total": float(e), "balance": float(i - e)}
                    for ym, i, e in zip(yms, inc, exp)],
        "targets": {
            "income": t_inc.__dict__,
            "expense_total": t_exp.__dict__,
        },
        "note": "Competência contínua. Modelos separados para income e expense_total.",
    }


def _add_months(ym: str, delta: int) -> str:
    y, m = ym.split("-")
    y = int(y)
    m = int(m)
    m0 = (m - 1) + int(delta)
    y2 = y + (m0 // 12)
    m2 = (m0 % 12) + 1
    return f"{y2:04d}-{m2:02d}"


def forecast_next_months(payload: Dict[str, Any], horizon: int = 12) -> Dict[str, Any]:
    horizon = int(horizon)
    if horizon < 1 or horizon > 24:
        raise ValueError("horizon deve estar entre 1 e 24.")

    hist = payload.get("history") or []
    if not hist:
        return {
            "meta": {"basis": payload.get("basis"), "trained_at": payload.get("trained_at")},
            "horizon": horizon,
            "series": [],
            "kpis": {"income_pred_total": 0.0, "expense_pred_total": 0.0, "balance_pred_total": 0.0},
        }

    lags = int(payload.get("lags", 6))

    yms = [str(r.get("ym") or "").strip() for r in hist if (r.get("ym") or "").strip()]
    inc_vals = [_safe_float(r.get("income"), 0.0) for r in hist if (str(r.get("ym") or "").strip())]
    exp_vals = [_safe_float(r.get("expense_total"), 0.0) for r in hist if (str(r.get("ym") or "").strip())]

    if not yms:
        return {
            "meta": {"basis": payload.get("basis"), "trained_at": payload.get("trained_at")},
            "horizon": horizon,
            "series": [],
            "kpis": {"income_pred_total": 0.0, "expense_pred_total": 0.0, "balance_pred_total": 0.0},
        }

    # lags defensivo
    if len(inc_vals) <= 2 or len(exp_vals) <= 2:
        lags = 2
    else:
        lags = int(max(2, min(lags, len(inc_vals) - 1, len(exp_vals) - 1)))

    t_income = payload.get("targets", {}).get("income") or {}
    t_expense = payload.get("targets", {}).get("expense_total") or {}

    inc_algo = str(t_income.get("algo") or "baseline_seasonal")
    exp_algo = str(t_expense.get("algo") or "baseline_seasonal")

    inc_model = _safe_load_model(t_income.get("model_b64"))
    exp_model = _safe_load_model(t_expense.get("model_b64"))

    if inc_algo != "baseline_seasonal" and inc_model is None:
        inc_algo = "baseline_seasonal"
    if exp_algo != "baseline_seasonal" and exp_model is None:
        exp_algo = "baseline_seasonal"

    inc_std = float(t_income.get("resid_std") or 0.0)
    exp_std = float(t_expense.get("resid_std") or 0.0)

    # sem numpy => baseline
    if np is None:
        inc_algo = "baseline_seasonal"
        exp_algo = "baseline_seasonal"
        inc_model = None
        exp_model = None

    last_ym = yms[-1]
    preds = []

    for h in range(1, horizon + 1):
        fym = _add_months(last_ym, h)
        t_idx = (len(yms) - 1) + h

        inc_lags = [inc_vals[-k] for k in range(1, lags + 1)]
        exp_lags = [exp_vals[-k] for k in range(1, lags + 1)]
        feats = _ym_feats(fym, t_idx)

        inc_ma3 = _rolling_mean(inc_vals, 3)
        inc_ma6 = _rolling_mean(inc_vals, 6)
        exp_ma3 = _rolling_mean(exp_vals, 3)
        exp_ma6 = _rolling_mean(exp_vals, 6)

        net_last = float(inc_vals[-1] - exp_vals[-1])
        net_ma3 = float(_rolling_mean([a - b for a, b in zip(inc_vals[-18:], exp_vals[-18:])], 3))

        X = None
        if np is not None and ((inc_algo != "baseline_seasonal" and inc_model is not None) or (exp_algo != "baseline_seasonal" and exp_model is not None)):
            X = np.array([feats + inc_lags + exp_lags + [inc_ma3, inc_ma6, exp_ma3, exp_ma6, net_last, net_ma3]], dtype=float)

        # baseline simples em mensal
        if inc_algo == "baseline_seasonal" or inc_model is None or X is None:
            inc_pred = float(_rolling_mean(inc_vals, 3))
        else:
            try:
                inc_pred = float(inc_model.predict(X)[0])
            except Exception:
                inc_pred = float(_rolling_mean(inc_vals, 3))
        inc_pred = max(0.0, inc_pred)

        if exp_algo == "baseline_seasonal" or exp_model is None or X is None:
            exp_pred = float(_rolling_mean(exp_vals, 3))
        else:
            try:
                exp_pred = float(exp_model.predict(X)[0])
            except Exception:
                exp_pred = float(_rolling_mean(exp_vals, 3))
        exp_pred = max(0.0, exp_pred)

        bal_pred = float(inc_pred - exp_pred)

        z = 1.28
        inc_low, inc_high = max(0.0, inc_pred - z * inc_std), inc_pred + z * inc_std
        exp_low, exp_high = max(0.0, exp_pred - z * exp_std), exp_pred + z * exp_std

        preds.append({
            "ym": fym,
            "income_pred": float(inc_pred),
            "expense_pred": float(exp_pred),
            "balance_pred": float(bal_pred),
            "income_low": float(inc_low),
            "income_high": float(inc_high),
            "expense_low": float(exp_low),
            "expense_high": float(exp_high),
        })

        inc_vals.append(float(inc_pred))
        exp_vals.append(float(exp_pred))

    income_total = float(sum(p["income_pred"] for p in preds))
    expense_total = float(sum(p["expense_pred"] for p in preds))
    bal_total = float(sum(p["balance_pred"] for p in preds))

    return {
        "meta": {
            "basis": payload.get("basis"),
            "trained_at": payload.get("trained_at"),
            "lags": payload.get("lags"),
            "income_algo": inc_algo,
            "expense_algo": exp_algo,
        },
        "horizon": horizon,
        "kpis": {
            "income_pred_total": float(income_total),
            "expense_pred_total": float(expense_total),
            "balance_pred_total": float(bal_total),
        },
        "series": preds,
    }
