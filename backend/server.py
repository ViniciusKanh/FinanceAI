# server.py
# ============================================================
# FinanceAI API (FastAPI) — pronto para Hugging Face Spaces
# - SQLite local (./data/finance.db) OU Turso/libSQL (sync opcional)
# - CRUD: contas, categorias, transações (caixa)
# - Cartão: cartões, compras, faturas, pagamento de fatura (registrado no caixa)
# - Relatórios/Export: mensal (CSV/JSON)
# - AI (Groq): explicações (não previsão numérica)
# - Forecast (sklearn):
#   * Diário (caixa): treino + previsão multi-step com fallback robusto
#   * Mensal (competência): despesas reais = caixa (sem pagamento) + compras do cartão (invoice_ym)
#
# Observação importante (evita bug comum):
# - As funções forecast_next_days_daily / forecast_next_months retornam um DICT com "series".
#   Aqui a API devolve "predictions" = series (lista), e "metrics" agrega meta/kpis/risco etc.
#   (consistente e estável pro frontend).
# ============================================================

from __future__ import annotations

import csv
import io
import json
import os
import sqlite3
import urllib.error
import urllib.request
from contextlib import contextmanager, asynccontextmanager
from datetime import datetime
from typing import Any, Dict, Literal, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

# Forecast (sklearn)
from ml_forecast import (
    train_daily_sklearn,
    forecast_next_days_daily,
    train_monthly_sklearn,
    forecast_next_months,
)

# ============================================================
# Env
# ============================================================
load_dotenv()


def _env_str(name: str, default: str = "") -> str:
    v = os.getenv(name)
    if v is None:
        return default
    v = v.strip()
    return v if v != "" else default


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return int(default)
    raw = raw.strip()
    if raw == "":
        return int(default)
    try:
        return int(raw)
    except Exception:
        return int(default)


def _parse_origins(origins_str: str) -> list[str]:
    """
    Converte CORS_ORIGINS em lista.
    Aceita:
      - "*" => ["*"]
      - "http://127.0.0.1:5500,http://localhost:5500" => lista
    Normaliza removendo "/" no final.
    """
    s = (origins_str or "").strip()
    if not s:
        return []
    if s == "*":
        return ["*"]
    return [o.strip().rstrip("/") for o in s.split(",") if o.strip()]


DB_PATH = _env_str("FINANCE_DB", "./data/finance.db")

GROQ_API_KEY = _env_str("GROQ_API_KEY", "")
GROQ_MODEL = _env_str("GROQ_MODEL", "llama-3.3-70b-versatile")
GROQ_BASE = "https://api.groq.com/openai/v1"

# Turso/libSQL (opcional)
TURSO_DATABASE_URL = _env_str("TURSO_DATABASE_URL", "")
TURSO_AUTH_TOKEN = _env_str("TURSO_AUTH_TOKEN", "")
TURSO_SYNC_INTERVAL = _env_int("TURSO_SYNC_INTERVAL", 60)
USE_TURSO = bool(TURSO_DATABASE_URL and TURSO_AUTH_TOKEN)

# CORS (origens permitidas)
origins_str = _env_str(
    "CORS_ORIGINS",
    "http://127.0.0.1:5500,http://localhost:5500,http://127.0.0.1:5173,http://localhost:5173",
)
origins = _parse_origins(origins_str)
if not origins:
    origins = [
        "http://127.0.0.1:5500",
        "http://localhost:5500",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
    ]

allow_credentials = True
if origins == ["*"]:
    allow_credentials = False  # browser bloqueia credentials + "*"

# ============================================================
# Constantes (evitar dupla contagem)
# ============================================================
CATEGORY_CARD_BUCKET = "Cartão de Crédito"
CATEGORY_CARD_PAYMENT = "Cartão de Crédito (Pagamento)"  # NÃO é despesa real (quitação de passivo)

TxType = Literal["income", "expense"]
PurchaseStatus = Literal["pending", "paid"]
ExportFormat = Literal["json", "csv"]

# ============================================================
# libsql opcional
# ============================================================
try:
    import libsql  # pip install libsql
except Exception:
    libsql = None


def now_iso() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def _ensure_db_dir(db_path: str) -> None:
    os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)


def _maybe_sync(conn: Any) -> None:
    """Sync best-effort (não derruba a API)."""
    if not USE_TURSO:
        return
    try:
        sync_fn = getattr(conn, "sync", None)
        if callable(sync_fn):
            sync_fn()
    except Exception:
        pass


def get_conn():
    _ensure_db_dir(DB_PATH)

    if USE_TURSO:
        if libsql is None:
            raise RuntimeError("libsql não está instalado. Rode: pip install libsql")
        try:
            conn = libsql.connect(
                DB_PATH,
                sync_url=TURSO_DATABASE_URL,
                auth_token=TURSO_AUTH_TOKEN,
                sync_interval=TURSO_SYNC_INTERVAL,
            )
        except TypeError:
            # compatibilidade com versões sem sync_interval
            conn = libsql.connect(
                DB_PATH,
                sync_url=TURSO_DATABASE_URL,
                auth_token=TURSO_AUTH_TOKEN,
            )
    else:
        conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        conn.row_factory = sqlite3.Row

    # pragmas (se suportado)
    try:
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA synchronous = NORMAL;")
    except Exception:
        pass

    return conn


@contextmanager
def db():
    conn = get_conn()
    try:
        yield conn
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _rows_to_dicts(cur: Any, rows: list[Any]) -> list[dict]:
    if not rows:
        return []
    if hasattr(rows[0], "keys"):
        return [dict(r) for r in rows]
    cols = [d[0] for d in (cur.description or [])]
    return [dict(zip(cols, r)) for r in rows]


def _row_to_dict(cur: Any, row: Any) -> Optional[dict]:
    if row is None:
        return None
    if hasattr(row, "keys"):
        return dict(row)
    cols = [d[0] for d in (cur.description or [])]
    return dict(zip(cols, row))


def q_all(conn: Any, sql: str, params: tuple = ()) -> list[dict]:
    cur = conn.execute(sql, params)
    rows = cur.fetchall()
    return _rows_to_dicts(cur, rows)


def q_one(conn: Any, sql: str, params: tuple = ()) -> Optional[dict]:
    cur = conn.execute(sql, params)
    row = cur.fetchone()
    return _row_to_dict(cur, row)


def q_scalar(conn: Any, sql: str, params: tuple = (), default: float = 0.0) -> float:
    r = q_one(conn, sql, params)
    if not r:
        return float(default)
    return float(next(iter(r.values())) or default)


def _lastrowid(cur: Any, conn: Any) -> int:
    lid = getattr(cur, "lastrowid", None)
    if lid is not None:
        try:
            return int(lid)
        except Exception:
            pass
    try:
        r = conn.execute("SELECT last_insert_rowid()").fetchone()
        if r is None:
            return 0
        return int(r[0])
    except Exception:
        return 0


def _rowcount(cur: Any) -> int:
    rc = getattr(cur, "rowcount", None)
    if rc is not None:
        try:
            return int(rc)
        except Exception:
            return 0
    ra = getattr(cur, "rows_affected", None)
    if ra is not None:
        try:
            return int(ra)
        except Exception:
            return 0
    return 0


# ============================================================
# Init DB
# ============================================================
def init_db() -> None:
    with db() as conn:
        conn.execute("""
        CREATE TABLE IF NOT EXISTS accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          bank TEXT NOT NULL,
          type TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        """)

        conn.execute("""
        CREATE TABLE IF NOT EXISTS categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL
        );
        """)

        conn.execute("""
        CREATE TABLE IF NOT EXISTS transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL CHECK(type IN ('income','expense')),
          amount REAL NOT NULL CHECK(amount >= 0),
          description TEXT NOT NULL,
          date TEXT NOT NULL,
          account_id INTEGER NOT NULL,
          category TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
        );
        """)

        conn.execute("CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_tx_cat ON transactions(category);")

        conn.execute("""
        CREATE TABLE IF NOT EXISTS credit_cards (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          bank TEXT NOT NULL,
          closing_day INTEGER NOT NULL CHECK(closing_day BETWEEN 1 AND 31),
          due_day INTEGER NOT NULL CHECK(due_day BETWEEN 1 AND 31),
          credit_limit REAL DEFAULT 0 CHECK(credit_limit >= 0),
          created_at TEXT NOT NULL
        );
        """)

        conn.execute("""
        CREATE TABLE IF NOT EXISTS card_purchases (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          card_id INTEGER NOT NULL,
          amount REAL NOT NULL CHECK(amount >= 0),
          description TEXT NOT NULL,
          category TEXT NOT NULL,
          purchase_date TEXT NOT NULL,
          invoice_ym TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','paid')) DEFAULT 'pending',
          paid_at TEXT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(card_id) REFERENCES credit_cards(id) ON DELETE CASCADE
        );
        """)

        conn.execute("CREATE INDEX IF NOT EXISTS idx_card_purchases_invoice ON card_purchases(card_id, invoice_ym);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_card_purchases_date ON card_purchases(purchase_date);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_card_purchases_cat ON card_purchases(category);")

        conn.execute("""
        CREATE TABLE IF NOT EXISTS ml_models (
          name TEXT PRIMARY KEY,
          trained_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        """)

        conn.commit()
        _maybe_sync(conn)


def seed_defaults() -> None:
    with db() as conn:
        acc_count = int(q_scalar(conn, "SELECT COUNT(*) AS c FROM accounts", default=0))
        cat_count = int(q_scalar(conn, "SELECT COUNT(*) AS c FROM categories", default=0))

        if acc_count == 0:
            conn.execute(
                "INSERT INTO accounts(name, bank, type, created_at) VALUES (?,?,?,?)",
                ("Carteira", "Pessoal", "carteira", now_iso()),
            )

        if cat_count == 0:
            base = [
                "Alimentação",
                "Transporte",
                "Lazer",
                "Contas Fixas",
                "Salário",
                CATEGORY_CARD_BUCKET,
                CATEGORY_CARD_PAYMENT,
            ]
            for n in base:
                conn.execute(
                    "INSERT OR IGNORE INTO categories(name, created_at) VALUES (?,?)",
                    (n, now_iso()),
                )

        conn.commit()
        _maybe_sync(conn)


# ============================================================
# Lifespan
# ============================================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    seed_defaults()
    yield


# ============================================================
# App + CORS (ordem correta)
# ============================================================
app = FastAPI(title="FinanceAI API", version="1.7.1", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)

print("[CORS] origins =", origins, "| allow_credentials =", allow_credentials)

# ============================================================
# Pydantic
# ============================================================
class AccountIn(BaseModel):
    name: str = Field(min_length=1)
    bank: str = Field(min_length=1)
    type: str = Field(min_length=1)


class AccountOut(AccountIn):
    id: int
    created_at: str


class CategoryIn(BaseModel):
    name: str = Field(min_length=1)


class CategoryOut(CategoryIn):
    id: int
    created_at: str


class TransactionIn(BaseModel):
    type: TxType
    amount: float = Field(ge=0)
    description: str = Field(min_length=1)
    date: str = Field(min_length=10, max_length=10)  # YYYY-MM-DD
    account_id: int
    category: str = Field(min_length=1)


class TransactionOut(TransactionIn):
    id: int
    created_at: str


class SummaryOut(BaseModel):
    year: int
    month: int
    income: float
    expense: float
    balance: float
    count: int


class CombinedSummaryOut(BaseModel):
    year: int
    month: int
    income: float
    expense_cash: float
    expense_card: float
    expense_total: float
    balance: float
    count_cash: int
    count_card: int


class AIRequest(BaseModel):
    question: str = Field(min_length=1)
    context: Dict[str, Any] = Field(default_factory=dict)


class AIResponse(BaseModel):
    answer_md: str


class CreditCardIn(BaseModel):
    name: str = Field(min_length=1)
    bank: str = Field(min_length=1)
    closing_day: int = Field(ge=1, le=31)
    due_day: int = Field(ge=1, le=31)
    credit_limit: float = Field(default=0, ge=0)


class CreditCardOut(CreditCardIn):
    id: int
    created_at: str


class CardPurchaseIn(BaseModel):
    card_id: int
    amount: float = Field(ge=0)
    description: str = Field(min_length=1)
    category: str = Field(min_length=1)
    purchase_date: str = Field(min_length=10, max_length=10)  # YYYY-MM-DD


class CardPurchaseOut(CardPurchaseIn):
    id: int
    invoice_ym: str
    status: PurchaseStatus
    paid_at: Optional[str] = None
    created_at: str


class CardPurchasePatch(BaseModel):
    status: PurchaseStatus


class InvoiceSummaryOut(BaseModel):
    card_id: int
    invoice_ym: str
    total: float
    pending_total: float
    paid_total: float
    count: int


class PayInvoiceIn(BaseModel):
    card_id: int
    invoice_ym: str = Field(min_length=7, max_length=7)  # YYYY-MM
    pay_date: str = Field(min_length=10, max_length=10)  # YYYY-MM-DD
    account_id: int


class MonthlyReportOut(BaseModel):
    year: int
    month: int
    ym: str
    transactions: list[Dict[str, Any]]
    card_purchases: list[Dict[str, Any]]


class ForecastDailyOut(BaseModel):
    ok: bool
    basis: str
    days: int
    trained_at: Optional[str]
    account_id: Optional[int]
    history: list[Dict[str, Any]]
    predictions: list[Dict[str, Any]]
    metrics: Dict[str, Any]
    note: str


class ForecastTrainOut(BaseModel):
    ok: bool
    basis: str
    trained_at: str
    n_months: int
    start_ym: str
    end_ym: str
    metrics: Dict[str, Any]


class ForecastOut(BaseModel):
    ok: bool
    basis: str
    horizon: int
    trained_at: Optional[str]
    history: list[Dict[str, Any]]
    predictions: list[Dict[str, Any]]
    metrics: Dict[str, Any]
    note: str


# ============================================================
# Helpers: datas/competência
# ============================================================
def parse_date_yyyy_mm_dd(date_str: str) -> None:
    try:
        datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=422, detail="date inválida. Use YYYY-MM-DD.")


def parse_ym(ym: str) -> None:
    try:
        datetime.strptime(ym, "%Y-%m")
    except ValueError:
        raise HTTPException(status_code=422, detail="valor inválido. Use YYYY-MM.")


def add_months(year: int, month: int, delta: int) -> tuple[int, int]:
    m = month - 1 + delta
    y = year + (m // 12)
    m = (m % 12) + 1
    return y, m


def compute_invoice_ym(purchase_date: str, closing_day: int) -> str:
    dt = datetime.strptime(purchase_date, "%Y-%m-%d")
    y, m = dt.year, dt.month
    if dt.day > int(closing_day):
        y, m = add_months(y, m, 1)
    return f"{y:04d}-{m:02d}"


# ============================================================
# Persistência de modelos (ml_models)
# ============================================================
def save_model(conn: Any, name: str, payload: dict) -> None:
    conn.execute(
        """
        INSERT INTO ml_models(name, trained_at, payload_json)
        VALUES (?,?,?)
        ON CONFLICT(name) DO UPDATE SET
          trained_at=excluded.trained_at,
          payload_json=excluded.payload_json
        """,
        (name, payload.get("trained_at", now_iso()), json.dumps(payload, ensure_ascii=False)),
    )
    conn.commit()
    _maybe_sync(conn)


def load_model(conn: Any, name: str) -> Optional[dict]:
    row = q_one(conn, "SELECT payload_json FROM ml_models WHERE name=?", (name,))
    if not row:
        return None
    try:
        return json.loads(row["payload_json"])
    except Exception:
        return None


# ============================================================
# Health
# ============================================================
@app.get("/")
def root():
    return {"name": "FinanceAI API", "version": "1.7.1", "ok": True}


@app.get("/health")
def health():
    return {
        "ok": True,
        "db_mode": "turso" if USE_TURSO else "sqlite",
        "db_path": DB_PATH,
        "turso_url_set": bool(TURSO_DATABASE_URL),
        "turso_sync_interval": TURSO_SYNC_INTERVAL,
        "groq_model": GROQ_MODEL,
        "cors_origins": origins,
        "ts": now_iso(),
        "card_payment_category": CATEGORY_CARD_PAYMENT,
    }


# ============================================================
# Accounts
# ============================================================
@app.get("/accounts", response_model=list[AccountOut])
def list_accounts():
    with db() as conn:
        return q_all(conn, "SELECT * FROM accounts ORDER BY id DESC")


@app.post("/accounts", response_model=AccountOut)
def create_account(payload: AccountIn):
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO accounts(name, bank, type, created_at) VALUES (?,?,?,?)",
            (payload.name, payload.bank, payload.type, now_iso()),
        )
        conn.commit()
        _maybe_sync(conn)
        new_id = _lastrowid(cur, conn)
        row = q_one(conn, "SELECT * FROM accounts WHERE id = ?", (new_id,))
        return row  # type: ignore[return-value]


@app.delete("/accounts/{account_id}")
def delete_account(account_id: int):
    with db() as conn:
        cur = conn.execute("DELETE FROM accounts WHERE id = ?", (account_id,))
        conn.commit()
        _maybe_sync(conn)
        if _rowcount(cur) == 0:
            raise HTTPException(status_code=404, detail="Conta não encontrada.")
        return {"ok": True}


# ============================================================
# Categories
# ============================================================
@app.get("/categories", response_model=list[CategoryOut])
def list_categories():
    with db() as conn:
        return q_all(conn, "SELECT * FROM categories ORDER BY name ASC")


@app.post("/categories", response_model=CategoryOut)
def create_category(payload: CategoryIn):
    if payload.name.strip() == "":
        raise HTTPException(status_code=422, detail="Nome de categoria inválido.")
    with db() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO categories(name, created_at) VALUES (?,?)",
                (payload.name, now_iso()),
            )
            conn.commit()
            _maybe_sync(conn)
        except Exception as e:
            msg = str(e).lower()
            if "unique" in msg:
                raise HTTPException(status_code=409, detail="Categoria já existe.")
            raise
        new_id = _lastrowid(cur, conn)
        row = q_one(conn, "SELECT * FROM categories WHERE id = ?", (new_id,))
        return row  # type: ignore[return-value]


@app.delete("/categories/{category_id}")
def delete_category(category_id: int):
    with db() as conn:
        row = q_one(conn, "SELECT name FROM categories WHERE id=?", (category_id,))
        if not row:
            raise HTTPException(status_code=404, detail="Categoria não encontrada.")
        if row["name"] == CATEGORY_CARD_PAYMENT:
            raise HTTPException(status_code=409, detail="Categoria reservada. Não pode ser removida.")
        cur = conn.execute("DELETE FROM categories WHERE id = ?", (category_id,))
        conn.commit()
        _maybe_sync(conn)
        if _rowcount(cur) == 0:
            raise HTTPException(status_code=404, detail="Categoria não encontrada.")
        return {"ok": True}


# ============================================================
# Transactions (Caixa)
# ============================================================
@app.get("/transactions", response_model=list[TransactionOut])
def list_transactions(year: Optional[int] = None, month: Optional[int] = None, limit: int = 200):
    if limit < 1 or limit > 2000:
        raise HTTPException(status_code=422, detail="limit deve estar entre 1 e 2000.")
    with db() as conn:
        if year is not None and month is not None:
            if month < 1 or month > 12:
                raise HTTPException(status_code=422, detail="month deve estar entre 1 e 12.")
            ym = f"{year:04d}-{month:02d}"
            return q_all(
                conn,
                "SELECT * FROM transactions WHERE substr(date,1,7)=? ORDER BY date DESC, id DESC LIMIT ?",
                (ym, limit),
            )
        return q_all(conn, "SELECT * FROM transactions ORDER BY date DESC, id DESC LIMIT ?", (limit,))


@app.post("/transactions", response_model=TransactionOut)
def create_transaction(payload: TransactionIn):
    parse_date_yyyy_mm_dd(payload.date)
    with db() as conn:
        acc = q_one(conn, "SELECT id FROM accounts WHERE id=?", (payload.account_id,))
        if not acc:
            raise HTTPException(status_code=400, detail="account_id inválido.")
        cur = conn.execute(
            """
            INSERT INTO transactions(type, amount, description, date, account_id, category, created_at)
            VALUES (?,?,?,?,?,?,?)
            """,
            (
                payload.type,
                float(payload.amount),
                payload.description,
                payload.date,
                payload.account_id,
                payload.category,
                now_iso(),
            ),
        )
        conn.commit()
        _maybe_sync(conn)
        new_id = _lastrowid(cur, conn)
        row = q_one(conn, "SELECT * FROM transactions WHERE id = ?", (new_id,))
        return row  # type: ignore[return-value]


@app.delete("/transactions/{tx_id}")
def delete_transaction(tx_id: int):
    with db() as conn:
        cur = conn.execute("DELETE FROM transactions WHERE id = ?", (tx_id,))
        conn.commit()
        _maybe_sync(conn)
        if _rowcount(cur) == 0:
            raise HTTPException(status_code=404, detail="Transação não encontrada.")
        return {"ok": True}


# ============================================================
# Transactions (Combined) — usado pelo frontend
# ============================================================
@app.get("/transactions/combined")
def list_transactions_combined(
    year: int,
    month: int,
    limit: int = 5000,
    include_card_payments: bool = False,
):
    if month < 1 or month > 12:
        raise HTTPException(status_code=422, detail="month deve estar entre 1 e 12.")
    if limit < 1 or limit > 20000:
        raise HTTPException(status_code=422, detail="limit deve estar entre 1 e 20000.")

    ym = f"{year:04d}-{month:02d}"

    with db() as conn:
        if include_card_payments:
            tx = q_all(
                conn,
                """
                SELECT id, type, amount, description, date, account_id, category, created_at
                FROM transactions
                WHERE substr(date,1,7)=?
                ORDER BY date DESC, id DESC
                LIMIT ?
                """,
                (ym, limit),
            )
        else:
            tx = q_all(
                conn,
                """
                SELECT id, type, amount, description, date, account_id, category, created_at
                FROM transactions
                WHERE substr(date,1,7)=?
                  AND NOT (type='expense' AND category=?)
                ORDER BY date DESC, id DESC
                LIMIT ?
                """,
                (ym, CATEGORY_CARD_PAYMENT, limit),
            )

        cp = q_all(
            conn,
            """
            SELECT id, card_id, amount, description, category, purchase_date, invoice_ym, status, paid_at, created_at
            FROM card_purchases
            WHERE invoice_ym=?
            ORDER BY purchase_date DESC, id DESC
            LIMIT ?
            """,
            (ym, limit),
        )

        combined: list[dict] = []

        for t in tx:
            combined.append(
                {
                    "source": "cash",
                    "id": t.get("id"),
                    "type": t.get("type"),
                    "amount": float(t.get("amount") or 0.0),
                    "description": t.get("description") or "",
                    "date": t.get("date"),
                    "category": t.get("category") or "",
                    "account_id": t.get("account_id"),
                    "created_at": t.get("created_at"),
                }
            )

        for p in cp:
            combined.append(
                {
                    "source": "card",
                    "id": p.get("id"),
                    "type": "expense",
                    "amount": float(p.get("amount") or 0.0),
                    "description": p.get("description") or "",
                    "date": p.get("purchase_date"),
                    "category": p.get("category") or "",
                    "account_id": None,
                    "card_id": p.get("card_id"),
                    "invoice_ym": p.get("invoice_ym"),
                    "status": p.get("status"),
                    "paid_at": p.get("paid_at"),
                    "created_at": p.get("created_at"),
                }
            )

        combined.sort(key=lambda r: (str(r.get("date") or ""), int(r.get("id") or 0)), reverse=True)
        return combined[:limit]


# ============================================================
# Summary (caixa) + combinado (caixa + cartão)
# ============================================================
@app.get("/summary", response_model=SummaryOut)
def get_summary(year: int, month: int, exclude_card_payments: bool = True):
    if month < 1 or month > 12:
        raise HTTPException(status_code=422, detail="month deve estar entre 1 e 12.")
    ym = f"{year:04d}-{month:02d}"
    with db() as conn:
        if exclude_card_payments:
            row = q_one(
                conn,
                """
                SELECT
                  SUM(CASE WHEN type='income'  THEN amount ELSE 0 END) AS income,
                  SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) AS expense,
                  COUNT(*) AS cnt
                FROM transactions
                WHERE substr(date,1,7)=?
                  AND NOT (type='expense' AND category=?)
                """,
                (ym, CATEGORY_CARD_PAYMENT),
            )
        else:
            row = q_one(
                conn,
                """
                SELECT
                  SUM(CASE WHEN type='income'  THEN amount ELSE 0 END) AS income,
                  SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) AS expense,
                  COUNT(*) AS cnt
                FROM transactions
                WHERE substr(date,1,7)=?
                """,
                (ym,),
            )

        row = row or {"income": 0.0, "expense": 0.0, "cnt": 0}
        income = float(row.get("income") or 0.0)
        expense = float(row.get("expense") or 0.0)

        return {
            "year": year,
            "month": month,
            "income": income,
            "expense": expense,
            "balance": income - expense,
            "count": int(row.get("cnt") or 0),
        }


@app.get("/summary/combined", response_model=CombinedSummaryOut)
def get_summary_combined(year: int, month: int):
    if month < 1 or month > 12:
        raise HTTPException(status_code=422, detail="month deve estar entre 1 e 12.")
    ym = f"{year:04d}-{month:02d}"
    with db() as conn:
        cash = q_one(
            conn,
            """
            SELECT
              SUM(CASE WHEN type='income'  THEN amount ELSE 0 END) AS income,
              SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) AS expense_cash,
              COUNT(*) AS cnt_cash
            FROM transactions
            WHERE substr(date,1,7)=?
              AND NOT (type='expense' AND category=?)
            """,
            (ym, CATEGORY_CARD_PAYMENT),
        ) or {"income": 0.0, "expense_cash": 0.0, "cnt_cash": 0}

        card = q_one(
            conn,
            """
            SELECT
              SUM(amount) AS expense_card,
              COUNT(*) AS cnt_card
            FROM card_purchases
            WHERE invoice_ym=?
            """,
            (ym,),
        ) or {"expense_card": 0.0, "cnt_card": 0}

        income = float(cash.get("income") or 0.0)
        expense_cash = float(cash.get("expense_cash") or 0.0)
        expense_card = float(card.get("expense_card") or 0.0)
        expense_total = expense_cash + expense_card

        return {
            "year": year,
            "month": month,
            "income": income,
            "expense_cash": expense_cash,
            "expense_card": expense_card,
            "expense_total": expense_total,
            "balance": income - expense_total,
            "count_cash": int(cash.get("cnt_cash") or 0),
            "count_card": int(card.get("cnt_card") or 0),
        }


# ============================================================
# Charts (caixa)
# ============================================================
@app.get("/charts/timeseries")
def chart_timeseries(year: int, month: int, exclude_card_payments: bool = True):
    if month < 1 or month > 12:
        raise HTTPException(status_code=422, detail="month deve estar entre 1 e 12.")
    ym = f"{year:04d}-{month:02d}"
    with db() as conn:
        if exclude_card_payments:
            return q_all(
                conn,
                """
                SELECT
                  date,
                  SUM(CASE WHEN type='income'  THEN amount ELSE 0 END) AS income,
                  SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) AS expense
                FROM transactions
                WHERE substr(date,1,7)=?
                  AND NOT (type='expense' AND category=?)
                GROUP BY date
                ORDER BY date ASC
                """,
                (ym, CATEGORY_CARD_PAYMENT),
            )
        return q_all(
            conn,
            """
            SELECT
              date,
              SUM(CASE WHEN type='income'  THEN amount ELSE 0 END) AS income,
              SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) AS expense
            FROM transactions
            WHERE substr(date,1,7)=?
            GROUP BY date
            ORDER BY date ASC
            """,
            (ym,),
        )


@app.get("/charts/categories")
def chart_categories(year: int, month: int, tx_type: TxType = "expense", exclude_card_payments: bool = True):
    if month < 1 or month > 12:
        raise HTTPException(status_code=422, detail="month deve estar entre 1 e 12.")
    if tx_type not in ("income", "expense"):
        raise HTTPException(status_code=422, detail="tx_type deve ser 'income' ou 'expense'.")
    ym = f"{year:04d}-{month:02d}"
    with db() as conn:
        if tx_type == "expense" and exclude_card_payments:
            return q_all(
                conn,
                """
                SELECT category, SUM(amount) AS total
                FROM transactions
                WHERE substr(date,1,7)=?
                  AND type='expense'
                  AND NOT (type='expense' AND category=?)
                GROUP BY category
                ORDER BY total DESC
                """,
                (ym, CATEGORY_CARD_PAYMENT),
            )
        return q_all(
            conn,
            """
            SELECT category, SUM(amount) AS total
            FROM transactions
            WHERE substr(date,1,7)=?
              AND type=?
            GROUP BY category
            ORDER BY total DESC
            """,
            (ym, tx_type),
        )


# ============================================================
# Charts (combined)
# ============================================================
@app.get("/charts/combined/timeseries")
def chart_combined_timeseries(year: int, month: int):
    if month < 1 or month > 12:
        raise HTTPException(status_code=422, detail="month deve estar entre 1 e 12.")
    ym = f"{year:04d}-{month:02d}"

    with db() as conn:
        cash_inc = q_all(
            conn,
            """
            SELECT date, SUM(amount) AS income
            FROM transactions
            WHERE substr(date,1,7)=? AND type='income'
            GROUP BY date
            """,
            (ym,),
        )
        cash_exp = q_all(
            conn,
            """
            SELECT date, SUM(amount) AS expense_cash
            FROM transactions
            WHERE substr(date,1,7)=?
              AND type='expense'
              AND category<>?
            GROUP BY date
            """,
            (ym, CATEGORY_CARD_PAYMENT),
        )

        card_exp = q_all(
            conn,
            """
            SELECT purchase_date AS date, SUM(amount) AS expense_card
            FROM card_purchases
            WHERE invoice_ym=?
            GROUP BY purchase_date
            """,
            (ym,),
        )

        m: dict[str, dict[str, float]] = {}

        for r in cash_inc:
            d = str(r.get("date"))
            m.setdefault(d, {"income": 0.0, "expense_total": 0.0})
            m[d]["income"] += float(r.get("income") or 0.0)

        for r in cash_exp:
            d = str(r.get("date"))
            m.setdefault(d, {"income": 0.0, "expense_total": 0.0})
            m[d]["expense_total"] += float(r.get("expense_cash") or 0.0)

        for r in card_exp:
            d = str(r.get("date"))
            m.setdefault(d, {"income": 0.0, "expense_total": 0.0})
            m[d]["expense_total"] += float(r.get("expense_card") or 0.0)

        out = [{"date": k, "income": v["income"], "expense_total": v["expense_total"]} for k, v in m.items()]
        out.sort(key=lambda x: str(x.get("date") or ""))
        return out


@app.get("/charts/combined/categories")
def chart_combined_categories(year: int, month: int):
    if month < 1 or month > 12:
        raise HTTPException(status_code=422, detail="month deve estar entre 1 e 12.")
    ym = f"{year:04d}-{month:02d}"

    with db() as conn:
        cash = q_all(
            conn,
            """
            SELECT category, SUM(amount) AS total
            FROM transactions
            WHERE substr(date,1,7)=?
              AND type='expense'
              AND category<>?
            GROUP BY category
            """,
            (ym, CATEGORY_CARD_PAYMENT),
        )

        card = q_all(
            conn,
            """
            SELECT category, SUM(amount) AS total
            FROM card_purchases
            WHERE invoice_ym=?
            GROUP BY category
            """,
            (ym,),
        )

        agg: dict[str, float] = {}

        for r in cash:
            c = str(r.get("category") or "Geral")
            agg[c] = agg.get(c, 0.0) + float(r.get("total") or 0.0)

        for r in card:
            c = str(r.get("category") or "Geral")
            agg[c] = agg.get(c, 0.0) + float(r.get("total") or 0.0)

        out = [{"category": k, "total": v} for k, v in agg.items()]
        out.sort(key=lambda x: float(x.get("total") or 0.0), reverse=True)
        return out


# ============================================================
# Cartões
# ============================================================
@app.get("/cards", response_model=list[CreditCardOut])
def list_cards():
    with db() as conn:
        return q_all(conn, "SELECT * FROM credit_cards ORDER BY id DESC")


@app.post("/cards", response_model=CreditCardOut)
def create_card(payload: CreditCardIn):
    with db() as conn:
        cur = conn.execute(
            """
            INSERT INTO credit_cards(name, bank, closing_day, due_day, credit_limit, created_at)
            VALUES (?,?,?,?,?,?)
            """,
            (payload.name, payload.bank, int(payload.closing_day), int(payload.due_day), float(payload.credit_limit or 0), now_iso()),
        )
        conn.commit()
        _maybe_sync(conn)
        new_id = _lastrowid(cur, conn)
        row = q_one(conn, "SELECT * FROM credit_cards WHERE id=?", (new_id,))
        return row  # type: ignore[return-value]


@app.delete("/cards/{card_id}")
def delete_card(card_id: int):
    with db() as conn:
        cur = conn.execute("DELETE FROM credit_cards WHERE id=?", (card_id,))
        conn.commit()
        _maybe_sync(conn)
        if _rowcount(cur) == 0:
            raise HTTPException(status_code=404, detail="Cartão não encontrado.")
        return {"ok": True}


@app.get("/cards/{card_id}/invoices")
def list_card_invoices(card_id: int):
    with db() as conn:
        card = q_one(conn, "SELECT id FROM credit_cards WHERE id=?", (card_id,))
        if not card:
            raise HTTPException(status_code=404, detail="Cartão não encontrado.")
        return q_all(
            conn,
            """
            SELECT invoice_ym, COUNT(*) AS cnt, SUM(amount) AS total,
                   SUM(CASE WHEN status='pending' THEN amount ELSE 0 END) AS pending_total
            FROM card_purchases
            WHERE card_id=?
            GROUP BY invoice_ym
            ORDER BY invoice_ym DESC
            """,
            (card_id,),
        )


@app.get("/cards/{card_id}/purchases", response_model=list[CardPurchaseOut])
def list_card_purchases(card_id: int, invoice_ym: Optional[str] = None, limit: int = 500):
    if limit < 1 or limit > 5000:
        raise HTTPException(status_code=422, detail="limit deve estar entre 1 e 5000.")
    if invoice_ym:
        parse_ym(invoice_ym)
    with db() as conn:
        card = q_one(conn, "SELECT id FROM credit_cards WHERE id=?", (card_id,))
        if not card:
            raise HTTPException(status_code=404, detail="Cartão não encontrado.")
        if invoice_ym:
            return q_all(
                conn,
                """
                SELECT * FROM card_purchases
                WHERE card_id=? AND invoice_ym=?
                ORDER BY purchase_date DESC, id DESC
                LIMIT ?
                """,
                (card_id, invoice_ym, limit),
            )
        return q_all(
            conn,
            """
            SELECT * FROM card_purchases
            WHERE card_id=?
            ORDER BY purchase_date DESC, id DESC
            LIMIT ?
            """,
            (card_id, limit),
        )


@app.post("/cards/purchases", response_model=CardPurchaseOut)
def create_card_purchase(payload: CardPurchaseIn):
    parse_date_yyyy_mm_dd(payload.purchase_date)
    with db() as conn:
        card = q_one(conn, "SELECT * FROM credit_cards WHERE id=?", (payload.card_id,))
        if not card:
            raise HTTPException(status_code=400, detail="card_id inválido.")
        inv_ym = compute_invoice_ym(payload.purchase_date, int(card["closing_day"]))
        cur = conn.execute(
            """
            INSERT INTO card_purchases(card_id, amount, description, category, purchase_date, invoice_ym, status, created_at)
            VALUES (?,?,?,?,?,?, 'pending', ?)
            """,
            (payload.card_id, float(payload.amount), payload.description, payload.category, payload.purchase_date, inv_ym, now_iso()),
        )
        conn.commit()
        _maybe_sync(conn)
        new_id = _lastrowid(cur, conn)
        row = q_one(conn, "SELECT * FROM card_purchases WHERE id=?", (new_id,))
        return row  # type: ignore[return-value]


@app.patch("/cards/purchases/{purchase_id}", response_model=dict)
def patch_card_purchase(purchase_id: int, payload: CardPurchasePatch):
    if payload.status not in ("pending", "paid"):
        raise HTTPException(status_code=422, detail="status inválido.")
    with db() as conn:
        row = q_one(conn, "SELECT * FROM card_purchases WHERE id=?", (purchase_id,))
        if not row:
            raise HTTPException(status_code=404, detail="Compra não encontrada.")
        if payload.status == "paid":
            conn.execute("UPDATE card_purchases SET status='paid', paid_at=? WHERE id=?", (now_iso(), purchase_id))
        else:
            conn.execute("UPDATE card_purchases SET status='pending', paid_at=NULL WHERE id=?", (purchase_id,))
        conn.commit()
        _maybe_sync(conn)
        return {"ok": True}


@app.delete("/cards/purchases/{purchase_id}")
def delete_card_purchase(purchase_id: int):
    with db() as conn:
        cur = conn.execute("DELETE FROM card_purchases WHERE id=?", (purchase_id,))
        conn.commit()
        _maybe_sync(conn)
        if _rowcount(cur) == 0:
            raise HTTPException(status_code=404, detail="Compra não encontrada.")
        return {"ok": True}


@app.get("/cards/{card_id}/invoice-summary", response_model=InvoiceSummaryOut)
def invoice_summary(card_id: int, invoice_ym: str):
    parse_ym(invoice_ym)
    with db() as conn:
        card = q_one(conn, "SELECT id FROM credit_cards WHERE id=?", (card_id,))
        if not card:
            raise HTTPException(status_code=404, detail="Cartão não encontrado.")
        row = q_one(
            conn,
            """
            SELECT
              COUNT(*) AS cnt,
              SUM(amount) AS total,
              SUM(CASE WHEN status='pending' THEN amount ELSE 0 END) AS pending_total,
              SUM(CASE WHEN status='paid' THEN amount ELSE 0 END) AS paid_total
            FROM card_purchases
            WHERE card_id=? AND invoice_ym=?
            """,
            (card_id, invoice_ym),
        ) or {"cnt": 0, "total": 0.0, "pending_total": 0.0, "paid_total": 0.0}

        return {
            "card_id": card_id,
            "invoice_ym": invoice_ym,
            "total": float(row.get("total") or 0.0),
            "pending_total": float(row.get("pending_total") or 0.0),
            "paid_total": float(row.get("paid_total") or 0.0),
            "count": int(row.get("cnt") or 0),
        }


@app.post("/cards/pay-invoice")
def pay_invoice(payload: PayInvoiceIn):
    parse_ym(payload.invoice_ym)
    parse_date_yyyy_mm_dd(payload.pay_date)
    with db() as conn:
        card = q_one(conn, "SELECT * FROM credit_cards WHERE id=?", (payload.card_id,))
        if not card:
            raise HTTPException(status_code=400, detail="card_id inválido.")
        acc = q_one(conn, "SELECT id FROM accounts WHERE id=?", (payload.account_id,))
        if not acc:
            raise HTTPException(status_code=400, detail="account_id inválido.")

        row = q_one(
            conn,
            """
            SELECT SUM(amount) AS total
            FROM card_purchases
            WHERE card_id=? AND invoice_ym=? AND status='pending'
            """,
            (payload.card_id, payload.invoice_ym),
        ) or {"total": 0.0}

        total = float(row.get("total") or 0.0)
        if total <= 0:
            return {"ok": True, "message": "Nada pendente para pagar nesta fatura.", "paid_total": 0.0}

        conn.execute(
            """
            UPDATE card_purchases
            SET status='paid', paid_at=?
            WHERE card_id=? AND invoice_ym=? AND status='pending'
            """,
            (now_iso(), payload.card_id, payload.invoice_ym),
        )

        desc = f"Pagamento fatura {card['name']} ({payload.invoice_ym})"
        conn.execute(
            """
            INSERT INTO transactions(type, amount, description, date, account_id, category, created_at)
            VALUES ('expense', ?, ?, ?, ?, ?, ?)
            """,
            (total, desc, payload.pay_date, payload.account_id, CATEGORY_CARD_PAYMENT, now_iso()),
        )

        conn.commit()
        _maybe_sync(conn)
        return {"ok": True, "paid_total": total}


# ============================================================
# Reports
# ============================================================
def _fetch_monthly_report(conn: Any, ym: str) -> tuple[list[dict], list[dict]]:
    tx = q_all(
        conn,
        """
        SELECT * FROM transactions
        WHERE substr(date,1,7)=?
        ORDER BY date ASC, id ASC
        """,
        (ym,),
    )
    cp = q_all(
        conn,
        """
        SELECT * FROM card_purchases
        WHERE invoice_ym=?
        ORDER BY purchase_date ASC, id ASC
        """,
        (ym,),
    )
    return tx, cp


@app.get("/reports/monthly", response_model=MonthlyReportOut)
def report_monthly(year: int, month: int):
    if month < 1 or month > 12:
        raise HTTPException(status_code=422, detail="month deve estar entre 1 e 12.")
    ym = f"{year:04d}-{month:02d}"
    with db() as conn:
        tx, cp = _fetch_monthly_report(conn, ym)
        return {"year": year, "month": month, "ym": ym, "transactions": tx, "card_purchases": cp}


@app.get("/reports/export")
def report_export(year: int, month: int, fmt: ExportFormat = "csv"):
    if month < 1 or month > 12:
        raise HTTPException(status_code=422, detail="month deve estar entre 1 e 12.")
    ym = f"{year:04d}-{month:02d}"
    with db() as conn:
        tx, cp = _fetch_monthly_report(conn, ym)
        if fmt == "json":
            return {"year": year, "month": month, "ym": ym, "transactions": tx, "card_purchases": cp}

        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(
            ["source", "ym", "date", "type", "amount", "description", "category", "account_id", "card_id", "invoice_ym", "status"]
        )

        for t in tx:
            writer.writerow(
                ["cash", ym, t.get("date"), t.get("type"), t.get("amount"), t.get("description"), t.get("category"), t.get("account_id"), "", "", ""]
            )
        for p in cp:
            writer.writerow(
                ["card", ym, p.get("purchase_date"), "card_purchase", p.get("amount"), p.get("description"), p.get("category"), "", p.get("card_id"), p.get("invoice_ym"), p.get("status")]
            )

        data_bytes = output.getvalue().encode("utf-8")
        filename = f"financeai_{ym}_export.csv"
        return StreamingResponse(
            iter([data_bytes]),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )


# ============================================================
# AI (Groq)
# ============================================================
@app.post("/ai", response_model=AIResponse)
def ask_ai(payload: AIRequest):
    if not GROQ_API_KEY:
        raise HTTPException(status_code=500, detail="GROQ_API_KEY não configurada no servidor.")
    context_json = json.dumps(payload.context, ensure_ascii=False)
    system_prompt = (
        "Você é um consultor financeiro pessoal dentro do app FinanceAI. "
        "Responda em Português do Brasil, objetivo, com Markdown, e cite números usando o contexto fornecido. "
        "Se faltarem dados, diga explicitamente o que está faltando."
    )
    user_prompt = f"Contexto (JSON): {context_json}\n\nPergunta: {payload.question}"
    body = {
        "model": GROQ_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.2,
    }

    req = urllib.request.Request(
        url=f"{GROQ_BASE}/chat/completions",
        method="POST",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {GROQ_API_KEY}",
            "User-Agent": "FinanceAI/1.7.1",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = ""
        try:
            err_body = e.read().decode("utf-8", errors="ignore")
        except Exception:
            err_body = str(e)
        raise HTTPException(status_code=502, detail=f"Groq HTTPError {e.code}: {err_body}")
    except urllib.error.URLError as e:
        raise HTTPException(status_code=502, detail=f"Groq URLError: {e}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Falha ao chamar Groq: {e}")

    answer = (data.get("choices") or [{}])[0].get("message", {}).get("content") or "Não consegui extrair a resposta do Groq."
    return {"answer_md": answer}


# ============================================================
# Forecast — diário (caixa)
# ============================================================
def _fetch_daily_income_expense(conn: Any, account_id: Optional[int], exclude_card_payments: bool) -> list[dict]:
    where_extra = ""
    params: list[Any] = []

    if exclude_card_payments:
        where_extra = " AND NOT (type='expense' AND category=?) "
        params.append(CATEGORY_CARD_PAYMENT)

    if account_id is None:
        return q_all(
            conn,
            f"""
            SELECT date,
                   SUM(CASE WHEN type='income' THEN amount ELSE 0 END) AS income,
                   SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) AS expense
            FROM transactions
            WHERE 1=1 {where_extra}
            GROUP BY date
            ORDER BY date ASC
            """,
            tuple(params),
        )

    params = [account_id] + params
    return q_all(
        conn,
        f"""
        SELECT date,
               SUM(CASE WHEN type='income' THEN amount ELSE 0 END) AS income,
               SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) AS expense
        FROM transactions
        WHERE account_id=? {where_extra}
        GROUP BY date
        ORDER BY date ASC
        """,
        tuple(params),
    )


@app.post("/forecast/daily/train")
def forecast_daily_train(account_id: Optional[int] = None, lags: int = 14, exclude_card_payments: bool = True):
    with db() as conn:
        rows = _fetch_daily_income_expense(conn, account_id=account_id, exclude_card_payments=exclude_card_payments)
        try:
            payload = train_daily_sklearn(rows, lags=int(lags))
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Falha no treino diário: {e}")

        name = f"forecast_daily_v2_acc_{account_id if account_id is not None else 'all'}_xpay_{1 if exclude_card_payments else 0}"
        save_model(conn, name, payload)
        return {
            "ok": True,
            "trained_at": payload.get("trained_at"),
            "basis": payload.get("basis"),
            "lags": payload.get("lags"),
            "note": payload.get("note"),
        }


@app.get("/forecast/daily", response_model=ForecastDailyOut)
def forecast_daily(
    days: int = 7,
    auto_train: bool = True,
    lags: int = 14,
    account_id: Optional[int] = None,
    exclude_card_payments: bool = True,
):
    with db() as conn:
        name = f"forecast_daily_v2_acc_{account_id if account_id is not None else 'all'}_xpay_{1 if exclude_card_payments else 0}"
        payload = load_model(conn, name)

        if not payload:
            if not auto_train:
                raise HTTPException(status_code=404, detail="Modelo diário não treinado. Rode POST /forecast/daily/train.")
            rows = _fetch_daily_income_expense(conn, account_id=account_id, exclude_card_payments=exclude_card_payments)
            try:
                payload = train_daily_sklearn(rows, lags=int(lags))
            except ValueError as e:
                raise HTTPException(status_code=422, detail=str(e))
            save_model(conn, name, payload)

        try:
            daily_result = forecast_next_days_daily(payload, days=int(days))
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Falha ao prever diário: {e}")

        targets = payload.get("targets") or {}
        model_metrics = {
            "income": {
                "mae_val": (targets.get("income") or {}).get("mae_val"),
                "baseline_mae_val": (targets.get("income") or {}).get("baseline_mae_val"),
                "algo": (targets.get("income") or {}).get("algo"),
            },
            "expense": {
                "mae_val": (targets.get("expense") or {}).get("mae_val"),
                "baseline_mae_val": (targets.get("expense") or {}).get("baseline_mae_val"),
                "algo": (targets.get("expense") or {}).get("algo"),
            },
        }

        metrics = {
            "meta": daily_result.get("meta"),
            "kpis": daily_result.get("kpis"),
            "top_categories": daily_result.get("top_categories"),
            "alerts": daily_result.get("alerts"),
            "risk_score": daily_result.get("risk_score"),
            "model_metrics": model_metrics,
        }

        note = (
            "Previsão diária no caixa (transactions). "
            "Por padrão, exclui pagamento de fatura (não é despesa real). "
            "O Groq deve ser usado para explicar, não para prever números."
        )
        if not exclude_card_payments:
            note = (
                "Previsão diária no caixa (transactions) incluindo pagamento de fatura (fluxo de caixa puro). "
                "O Groq deve ser usado para explicar, não para prever números."
            )

        return {
            "ok": True,
            "basis": payload.get("basis", "cash_daily_sklearn"),
            "days": int(days),
            "trained_at": payload.get("trained_at"),
            "account_id": account_id,
            "history": payload.get("history_tail") or [],
            "predictions": daily_result.get("series") or [],
            "metrics": metrics,
            "note": note,
        }


# ============================================================
# Forecast — competência mensal
# ============================================================
def _fetch_monthly_competencia(conn: Any, account_id: Optional[int], include_card: bool) -> list[dict]:
    if account_id is None:
        r1 = q_one(conn, "SELECT MIN(substr(date,1,7)) AS mn, MAX(substr(date,1,7)) AS mx FROM transactions")
    else:
        r1 = q_one(conn, "SELECT MIN(substr(date,1,7)) AS mn, MAX(substr(date,1,7)) AS mx FROM transactions WHERE account_id=?", (account_id,))

    r2 = None
    if include_card:
        r2 = q_one(conn, "SELECT MIN(invoice_ym) AS mn, MAX(invoice_ym) AS mx FROM card_purchases")

    mins = [x for x in [(r1 or {}).get("mn"), (r2 or {}).get("mn") if r2 else None] if x]
    maxs = [x for x in [(r1 or {}).get("mx"), (r2 or {}).get("mx") if r2 else None] if x]
    if not mins or not maxs:
        return []

    start_ym, end_ym = min(mins), max(maxs)

    def month_seq_local(start_ym: str, end_ym: str):
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

    yms = month_seq_local(start_ym, end_ym)
    series = []

    for ym in yms:
        if account_id is None:
            income = q_scalar(conn, "SELECT SUM(amount) AS s FROM transactions WHERE substr(date,1,7)=? AND type='income'", (ym,), default=0.0)
            expense_cash_real = q_scalar(
                conn,
                """
                SELECT SUM(amount) AS s
                FROM transactions
                WHERE substr(date,1,7)=?
                  AND type='expense'
                  AND category<>?
                """,
                (ym, CATEGORY_CARD_PAYMENT),
                default=0.0,
            )
        else:
            income = q_scalar(
                conn,
                """
                SELECT SUM(amount) AS s
                FROM transactions
                WHERE substr(date,1,7)=? AND type='income' AND account_id=?
                """,
                (ym, account_id),
                default=0.0,
            )
            expense_cash_real = q_scalar(
                conn,
                """
                SELECT SUM(amount) AS s
                FROM transactions
                WHERE substr(date,1,7)=?
                  AND type='expense'
                  AND category<>?
                  AND account_id=?
                """,
                (ym, CATEGORY_CARD_PAYMENT, account_id),
                default=0.0,
            )

        expense_card = 0.0
        if include_card:
            expense_card = q_scalar(conn, "SELECT SUM(amount) AS s FROM card_purchases WHERE invoice_ym=?", (ym,), default=0.0)

        expense_total = float(expense_cash_real) + float(expense_card)
        series.append({"ym": ym, "income": float(income), "expense_total": float(expense_total)})

    return series


@app.post("/forecast/train", response_model=ForecastTrainOut)
def forecast_train(lags: int = 6, account_id: Optional[int] = None, include_card: bool = True):
    with db() as conn:
        series = _fetch_monthly_competencia(conn, account_id=account_id, include_card=include_card)
        try:
            payload = train_monthly_sklearn(series, lags=int(lags))
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Falha no treino mensal: {e}")

        name = f"forecast_comp_v2_acc_{account_id if account_id is not None else 'all'}_card_{1 if include_card else 0}"
        save_model(conn, name, payload)

        targets = payload.get("targets") or {}
        metrics = {
            "income": {
                "mae_val": (targets.get("income") or {}).get("mae_val"),
                "baseline_mae_val": (targets.get("income") or {}).get("baseline_mae_val"),
                "algo": (targets.get("income") or {}).get("algo"),
            },
            "expense_total": {
                "mae_val": (targets.get("expense_total") or {}).get("mae_val"),
                "baseline_mae_val": (targets.get("expense_total") or {}).get("baseline_mae_val"),
                "algo": (targets.get("expense_total") or {}).get("algo"),
            },
        }

        hist = payload.get("history") or []
        start_ym = payload.get("start_ym") or (hist[0].get("ym") if hist else "")
        end_ym = payload.get("end_ym") or (hist[-1].get("ym") if hist else "")

        return {
            "ok": True,
            "basis": payload.get("basis", "competencia_sklearn"),
            "trained_at": payload.get("trained_at"),
            "n_months": len(hist),
            "start_ym": start_ym,
            "end_ym": end_ym,
            "metrics": metrics,
        }


@app.get("/forecast/status")
def forecast_status(account_id: Optional[int] = None, include_card: bool = True, min_months: int = 12, lags: int = 6):
    with db() as conn:
        name = f"forecast_comp_v2_acc_{account_id if account_id is not None else 'all'}_card_{1 if include_card else 0}"
        payload = load_model(conn, name)
        series = _fetch_monthly_competencia(conn, account_id=account_id, include_card=include_card)
        n_months = len(series)

        required = int(lags) + 6
        can_train = (n_months >= required) and (n_months >= int(min_months))

        return {
            "trained": bool(payload),
            "trained_at": (payload or {}).get("trained_at"),
            "n_months": n_months,
            "required_months": required,
            "can_train": can_train,
            "note": "O treino mensal exige histórico suficiente (>= lags + 6). Recomenda-se >= 12 meses.",
        }


@app.get("/forecast", response_model=ForecastOut)
def forecast_get(horizon: int = 12, auto_train: bool = True, lags: int = 6, account_id: Optional[int] = None, include_card: bool = True):
    with db() as conn:
        name = f"forecast_comp_v2_acc_{account_id if account_id is not None else 'all'}_card_{1 if include_card else 0}"
        payload = load_model(conn, name)

        if not payload:
            if not auto_train:
                raise HTTPException(status_code=404, detail="Modelo não treinado. Rode POST /forecast/train.")
            series = _fetch_monthly_competencia(conn, account_id=account_id, include_card=include_card)
            try:
                payload = train_monthly_sklearn(series, lags=int(lags))
            except ValueError as e:
                raise HTTPException(status_code=422, detail=str(e))
            save_model(conn, name, payload)

        try:
            monthly_result = forecast_next_months(payload, horizon=int(horizon))
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Falha ao prever mensal: {e}")

        hist = payload.get("history") or []
        hist_tail = hist[-24:] if len(hist) > 24 else hist

        targets = payload.get("targets") or {}
        model_metrics = {
            "income": {
                "mae_val": (targets.get("income") or {}).get("mae_val"),
                "baseline_mae_val": (targets.get("income") or {}).get("baseline_mae_val"),
                "algo": (targets.get("income") or {}).get("algo"),
            },
            "expense_total": {
                "mae_val": (targets.get("expense_total") or {}).get("mae_val"),
                "baseline_mae_val": (targets.get("expense_total") or {}).get("baseline_mae_val"),
                "algo": (targets.get("expense_total") or {}).get("algo"),
            },
        }

        metrics = {
            "meta": monthly_result.get("meta"),
            "kpis": monthly_result.get("kpis"),
            "model_metrics": model_metrics,
        }

        note = (
            "Projeção por competência: despesas = (caixa sem pagamento de fatura) + (compras do cartão por invoice_ym). "
            "Pagamento de fatura afeta caixa, mas não é despesa real e não entra na despesa projetada."
        )

        return {
            "ok": True,
            "basis": payload.get("basis", "competencia_sklearn"),
            "horizon": int(horizon),
            "trained_at": payload.get("trained_at"),
            "history": hist_tail,
            "predictions": monthly_result.get("series") or [],
            "metrics": metrics,
            "note": note,
        }


# ============================================================
# (Opcional) utilitário: listar modelos salvos
# ============================================================
@app.get("/ml/models")
def list_ml_models(limit: int = 50):
    if limit < 1 or limit > 500:
        raise HTTPException(status_code=422, detail="limit deve estar entre 1 e 500.")
    with db() as conn:
        return q_all(conn, "SELECT name, trained_at FROM ml_models ORDER BY trained_at DESC LIMIT ?", (limit,))


# ============================================================
# Entry-point (HF Spaces / Docker)
# ============================================================
if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "7860"))  # HF geralmente usa 7860
    uvicorn.run("server:app", host="0.0.0.0", port=port, log_level="info")
