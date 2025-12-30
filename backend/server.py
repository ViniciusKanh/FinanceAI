"""
Backend FinanceAI (SQLite/Turso + Groq)
- API REST para contas, categorias, transações e sumário mensal
- Endpoints de gráficos (temporal e por categoria)
- Módulo de Cartão de Crédito: cartões, compras, fatura (YYYY-MM) e pagamento
- Relatórios: exportação por competência (normal + cartão)
- IMPORTANTE (evitar dupla contagem):
  * Compras no cartão contam como DESPESA na competência da fatura (invoice_ym).
  * Pagamento da fatura é movimento de CAIXA (saída da conta), mas NÃO é despesa “real” (é quitação de passivo).
    => por padrão, os endpoints de despesas EXCLUEM a categoria de pagamento de fatura.

Como rodar:
1) python -m venv .venv
2) .venv\Scripts\activate  (Windows)  |  source .venv/bin/activate (Linux/Mac)
3) pip install -r requirements.txt
   - Se for usar Turso/libSQL (opcional): pip install libsql
4) Crie um .env com:
   # Replica local (arquivo no disco)
   FINANCE_DB=./data/financeai_replica.db

   # Turso (opcional; se setar, usa libSQL Embedded Replica)
   TURSO_DATABASE_URL=libsql://<seu-db>.turso.io
   TURSO_AUTH_TOKEN=<token-do-db>
   TURSO_SYNC_INTERVAL=60

   # Groq
   GROQ_API_KEY="sua_chave"
   GROQ_MODEL="llama-3.3-70b-versatile"

   # CORS
   CORS_ORIGINS="http://127.0.0.1:5500,http://localhost:5500"
5) uvicorn server:app --reload --port 8000
"""

from __future__ import annotations

import csv
import io
import json
import os
import sqlite3
import urllib.error
import urllib.request
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Dict, Literal, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from contextlib import asynccontextmanager

# ============================================================
# Env
# ============================================================
load_dotenv()

DB_PATH = os.getenv("FINANCE_DB", "./data/finance.db").strip()

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile").strip()

# Turso/libSQL (opcional)
TURSO_DATABASE_URL = os.getenv("TURSO_DATABASE_URL", "").strip()
TURSO_AUTH_TOKEN = os.getenv("TURSO_AUTH_TOKEN", "").strip()
TURSO_SYNC_INTERVAL = int(os.getenv("TURSO_SYNC_INTERVAL", "60").strip() or "60")
USE_TURSO = bool(TURSO_DATABASE_URL and TURSO_AUTH_TOKEN)

# Base OpenAI-compatible do Groq
GROQ_BASE = "https://api.groq.com/openai/v1"

# CORS
origins_str = os.getenv("CORS_ORIGINS", "*").strip()
origins = ["*"] if origins_str == "*" else [o.strip() for o in origins_str.split(",") if o.strip()]
if not origins:
    origins = ["*"]

# ============================================================
# Constantes de domínio (evitar dupla contagem)
# ============================================================
CATEGORY_CARD_BUCKET = "Cartão de Crédito"               # “pasta”/bucket útil no app
CATEGORY_CARD_PAYMENT = "Cartão de Crédito (Pagamento)"  # NÃO contar como “despesa real”

# ============================================================
# Tipos / Utilidades
# ============================================================
TxType = Literal["income", "expense"]
PurchaseStatus = Literal["pending", "paid"]
ExportFormat = Literal["json", "csv"]


def now_iso() -> str:
    """Timestamp UTC em ISO-8601 (segundos) com sufixo Z."""
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def parse_date_yyyy_mm_dd(date_str: str) -> None:
    """Valida data no formato YYYY-MM-DD."""
    try:
        datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=422, detail="date inválida. Use YYYY-MM-DD.")


def parse_ym(ym: str) -> None:
    """Valida competência no formato YYYY-MM."""
    try:
        datetime.strptime(ym, "%Y-%m")
    except ValueError:
        raise HTTPException(status_code=422, detail="valor inválido. Use YYYY-MM.")


def add_months(year: int, month: int, delta: int) -> tuple[int, int]:
    """Soma delta meses em (year, month)."""
    m = month - 1 + delta
    y = year + (m // 12)
    m = (m % 12) + 1
    return y, m


def compute_invoice_ym(purchase_date: str, closing_day: int) -> str:
    """
    Regra: se dia da compra > closing_day, entra na fatura do próximo mês.
    invoice_ym = YYYY-MM (competência da fatura).
    """
    dt = datetime.strptime(purchase_date, "%Y-%m-%d")
    y, m = dt.year, dt.month
    if dt.day > int(closing_day):
        y, m = add_months(y, m, 1)
    return f"{y:04d}-{m:02d}"


# ============================================================
# Banco: SQLite local OU Turso (libSQL Embedded Replica)
# ============================================================
try:
    import libsql  # pip install libsql
except Exception:
    libsql = None


def _ensure_db_dir(db_path: str) -> None:
    os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)


def _rowcount(cur: Any) -> int:
    """Compat: sqlite3 e libsql variam no atributo de contagem."""
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


def _rows_to_dicts(cur: Any, rows: list[Any]) -> list[dict]:
    """Converte linhas em lista de dict, suportando sqlite3.Row e tuplas (libsql)."""
    if not rows:
        return []
    if hasattr(rows[0], "keys"):  # sqlite3.Row
        return [dict(r) for r in rows]
    cols = [d[0] for d in (cur.description or [])]
    return [dict(zip(cols, r)) for r in rows]


def _row_to_dict(cur: Any, row: Any) -> Optional[dict]:
    """Converte 1 linha em dict."""
    if row is None:
        return None
    if hasattr(row, "keys"):
        return dict(row)
    cols = [d[0] for d in (cur.description or [])]
    return dict(zip(cols, row))


def _lastrowid(cur: Any, conn: Any) -> int:
    """Compat: lastrowid nem sempre existe no libsql."""
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


def _maybe_sync(conn: Any) -> None:
    """
    Se for libSQL, tenta sincronizar sem quebrar o fluxo.
    Observação: em ambiente local puro (sqlite), não faz nada.
    """
    if not USE_TURSO:
        return
    try:
        sync_fn = getattr(conn, "sync", None)
        if callable(sync_fn):
            sync_fn()
    except Exception:
        pass


def get_conn():
    """
    Retorna conexão:
    - Se USE_TURSO: libsql.connect(replica_local, sync_url, auth_token, sync_interval?)
    - Caso contrário: sqlite3.connect(local)
    """
    _ensure_db_dir(DB_PATH)

    if USE_TURSO:
        if libsql is None:
            raise RuntimeError("libsql não está instalado. Rode: pip install libsql")

        # Algumas versões aceitam sync_interval; outras não.
        try:
            conn = libsql.connect(
                DB_PATH,
                sync_url=TURSO_DATABASE_URL,
                auth_token=TURSO_AUTH_TOKEN,
                sync_interval=TURSO_SYNC_INTERVAL,
            )
        except TypeError:
            conn = libsql.connect(
                DB_PATH,
                sync_url=TURSO_DATABASE_URL,
                auth_token=TURSO_AUTH_TOKEN,
            )
    else:
        conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        conn.row_factory = sqlite3.Row

    # Garantir FKs no SQLite/libSQL
    try:
        conn.execute("PRAGMA foreign_keys = ON;")
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


def init_db() -> None:
    """
    Evita executescript para manter compatível com libsql.
    Executa cada statement separadamente.
    """
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
          date TEXT NOT NULL,               -- YYYY-MM-DD
          account_id INTEGER NOT NULL,
          category TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
        );
        """)

        conn.execute("CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);")

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
          purchase_date TEXT NOT NULL,        -- YYYY-MM-DD
          invoice_ym TEXT NOT NULL,           -- YYYY-MM
          status TEXT NOT NULL CHECK(status IN ('pending','paid')) DEFAULT 'pending',
          paid_at TEXT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(card_id) REFERENCES credit_cards(id) ON DELETE CASCADE
        );
        """)

        conn.execute("CREATE INDEX IF NOT EXISTS idx_card_purchases_invoice ON card_purchases(card_id, invoice_ym);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_card_purchases_date ON card_purchases(purchase_date);")

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

        # Categorias base (inclui bucket do cartão e categoria de pagamento)
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
# Lifespan (substitui on_event: startup/shutdown)
# ============================================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    seed_defaults()
    # Sincroniza 1x na subida (se for Turso/libSQL)
    if USE_TURSO:
        try:
            with db() as conn:
                _maybe_sync(conn)
        except Exception:
            pass
    yield
    # shutdown: nada a fazer (conexões são por-request)


app = FastAPI(title="FinanceAI API", version="1.5.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================================================
# Models (Pydantic)
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


# -------- Cartões ----------
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


# -------- Relatórios --------
class MonthlyReportOut(BaseModel):
    year: int
    month: int
    ym: str
    transactions: list[Dict[str, Any]]
    card_purchases: list[Dict[str, Any]]


# ============================================================
# Healthcheck
# ============================================================
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
    # Protege nomes reservados (opcional; evita bagunça semântica)
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

        # Evita deletar a categoria “contábil” do pagamento do cartão
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
    """
    Retorna transações (caixa).
    Observação: pagamentos de fatura são transações de caixa e ficam aqui.
    """
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


@app.get("/transactions/combined")
def list_transactions_combined(year: int, month: int, limit: int = 2000, order: Literal["asc", "desc"] = "desc"):
    """
    Extrato “combinado” (competência):
    - cash: transactions do mês (YYYY-MM)
    - card: compras cujo invoice_ym = YYYY-MM

    Retorno unificado com campo 'source' ('cash'|'card').
    """
    if month < 1 or month > 12:
        raise HTTPException(status_code=422, detail="month deve estar entre 1 e 12.")
    if limit < 1 or limit > 5000:
        raise HTTPException(status_code=422, detail="limit deve estar entre 1 e 5000.")

    ym = f"{year:04d}-{month:02d}"

    with db() as conn:
        cash = q_all(
            conn,
            """
            SELECT
              'cash' AS source,
              id,
              date AS date,
              type AS type,
              amount,
              description,
              category,
              account_id,
              NULL AS card_id,
              NULL AS invoice_ym,
              NULL AS status
            FROM transactions
            WHERE substr(date,1,7)=?
            """,
            (ym,),
        )

        card = q_all(
            conn,
            """
            SELECT
              'card' AS source,
              id,
              purchase_date AS date,
              'card_purchase' AS type,
              amount,
              description,
              category,
              NULL AS account_id,
              card_id,
              invoice_ym,
              status
            FROM card_purchases
            WHERE invoice_ym=?
            """,
            (ym,),
        )

        rows = cash + card

        # Ordenação previsível (front costuma querer desc)
        rows.sort(key=lambda r: (r.get("date") or "", int(r.get("id") or 0)), reverse=(order == "desc"))
        return rows[:limit]


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
# Summary
# ============================================================
@app.get("/summary", response_model=SummaryOut)
def get_summary(year: int, month: int, exclude_card_payments: bool = True):
    """
    Sumário de CAIXA (transactions).
    Por padrão, exclui pagamentos de fatura da categoria CATEGORY_CARD_PAYMENT,
    porque isso não é “despesa real”, é quitação de passivo.
    """
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
                  SUM(CASE WHEN type='expense' AND category<>? THEN amount ELSE 0 END) AS expense,
                  COUNT(*) AS cnt
                FROM transactions
                WHERE substr(date,1,7)=?
                """,
                (CATEGORY_CARD_PAYMENT, ym),
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
    """
    Sumário por competência (cartão por invoice_ym):
    - income: receitas em transactions
    - expense_cash: despesas em transactions (EXCLUINDO pagamento de fatura)
    - expense_card: soma das compras em card_purchases com invoice_ym=YYYY-MM
    - expense_total = expense_cash + expense_card
    """
    if month < 1 or month > 12:
        raise HTTPException(status_code=422, detail="month deve estar entre 1 e 12.")
    ym = f"{year:04d}-{month:02d}"

    with db() as conn:
        cash = q_one(
            conn,
            """
            SELECT
              SUM(CASE WHEN type='income'  THEN amount ELSE 0 END) AS income,
              SUM(CASE WHEN type='expense' AND category<>? THEN amount ELSE 0 END) AS expense_cash,
              COUNT(*) AS cnt_cash
            FROM transactions
            WHERE substr(date,1,7)=?
            """,
            (CATEGORY_CARD_PAYMENT, ym),
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
# Charts (Cash)
# ============================================================
@app.get("/charts/timeseries")
def chart_timeseries(year: int, month: int, exclude_card_payments: bool = True):
    """
    Agregação diária do mês: income/expense por dia (transactions).
    Por padrão, exclui pagamentos de fatura da categoria CATEGORY_CARD_PAYMENT.
    """
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
                  SUM(CASE WHEN type='expense' AND category<>? THEN amount ELSE 0 END) AS expense
                FROM transactions
                WHERE substr(date,1,7)=?
                GROUP BY date
                ORDER BY date ASC
                """,
                (CATEGORY_CARD_PAYMENT, ym),
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
    """
    Total por categoria no mês (transactions).
    Se tx_type='expense', por padrão exclui pagamentos de fatura (CATEGORY_CARD_PAYMENT).
    """
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
                  AND category<>?
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
# Cartões: CRUD + Compras + Fatura
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
            (
                payload.name,
                payload.bank,
                int(payload.closing_day),
                int(payload.due_day),
                float(payload.credit_limit or 0),
                now_iso(),
            ),
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
    """Lista competências (invoice_ym) existentes para um cartão."""
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
            (
                payload.card_id,
                float(payload.amount),
                payload.description,
                payload.category,
                payload.purchase_date,
                inv_ym,
                now_iso(),
            ),
        )
        conn.commit()
        _maybe_sync(conn)

        new_id = _lastrowid(cur, conn)
        row = q_one(conn, "SELECT * FROM card_purchases WHERE id=?", (new_id,))
        return row  # type: ignore[return-value]


@app.patch("/cards/purchases/{purchase_id}", response_model=dict)
def patch_card_purchase(purchase_id: int, payload: CardPurchasePatch):
    """Atualiza status de uma compra (pending/paid)."""
    if payload.status not in ("pending", "paid"):
        raise HTTPException(status_code=422, detail="status inválido.")

    with db() as conn:
        row = q_one(conn, "SELECT * FROM card_purchases WHERE id=?", (purchase_id,))
        if not row:
            raise HTTPException(status_code=404, detail="Compra não encontrada.")

        if payload.status == "paid":
            conn.execute(
                "UPDATE card_purchases SET status='paid', paid_at=? WHERE id=?",
                (now_iso(), purchase_id),
            )
        else:
            conn.execute(
                "UPDATE card_purchases SET status='pending', paid_at=NULL WHERE id=?",
                (purchase_id,),
            )

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
    """
    Paga uma fatura:
    1) marca compras pendentes como pagas
    2) cria transação de CAIXA para baixar o saldo da conta
       - categoria: CATEGORY_CARD_PAYMENT (por padrão, NÃO entra como “despesa real” nos somatórios)
    """
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

        # 1) Marca compras como pagas
        conn.execute(
            """
            UPDATE card_purchases
            SET status='paid', paid_at=?
            WHERE card_id=? AND invoice_ym=? AND status='pending'
            """,
            (now_iso(), payload.card_id, payload.invoice_ym),
        )

        # 2) Transação de caixa (quitação)
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
# Charts (Cartão e Combinado)
# ============================================================
@app.get("/charts/card/categories")
def chart_card_categories(card_id: int, invoice_ym: str):
    """Total por categoria na fatura (invoice_ym) de um cartão."""
    parse_ym(invoice_ym)

    with db() as conn:
        card = q_one(conn, "SELECT id FROM credit_cards WHERE id=?", (card_id,))
        if not card:
            raise HTTPException(status_code=404, detail="Cartão não encontrado.")

        return q_all(
            conn,
            """
            SELECT category, SUM(amount) AS total
            FROM card_purchases
            WHERE card_id=? AND invoice_ym=?
            GROUP BY category
            ORDER BY total DESC
            """,
            (card_id, invoice_ym),
        )


@app.get("/charts/combined/categories")
def chart_combined_categories(year: int, month: int):
    """
    Categorias de DESPESA por competência, combinando:
    - transactions (expense) no mês, EXCLUINDO pagamento de fatura
    - card_purchases com invoice_ym no mês
    """
    if month < 1 or month > 12:
        raise HTTPException(status_code=422, detail="month deve estar entre 1 e 12.")
    ym = f"{year:04d}-{month:02d}"

    with db() as conn:
        return q_all(
            conn,
            """
            SELECT category, SUM(total) AS total
            FROM (
              SELECT category AS category, SUM(amount) AS total
              FROM transactions
              WHERE substr(date,1,7)=?
                AND type='expense'
                AND category<>?
              GROUP BY category

              UNION ALL

              SELECT category AS category, SUM(amount) AS total
              FROM card_purchases
              WHERE invoice_ym=?
              GROUP BY category
            )
            GROUP BY category
            ORDER BY total DESC
            """,
            (ym, CATEGORY_CARD_PAYMENT, ym),
        )


@app.get("/charts/combined/timeseries")
def chart_combined_timeseries(year: int, month: int):
    """
    Série temporal diária por competência, combinando:
    - transactions (despesas) no mês, EXCLUINDO pagamento de fatura
    - card_purchases (invoice_ym do mês) agrupadas por purchase_date
    """
    if month < 1 or month > 12:
        raise HTTPException(status_code=422, detail="month deve estar entre 1 e 12.")
    ym = f"{year:04d}-{month:02d}"

    with db() as conn:
        return q_all(
            conn,
            """
            WITH cash AS (
              SELECT date AS d, SUM(amount) AS expense_cash
              FROM transactions
              WHERE substr(date,1,7)=?
                AND type='expense'
                AND category<>?
              GROUP BY date
            ),
            card AS (
              SELECT purchase_date AS d, SUM(amount) AS expense_card
              FROM card_purchases
              WHERE invoice_ym=?
              GROUP BY purchase_date
            ),
            all_dates AS (
              SELECT d FROM cash
              UNION
              SELECT d FROM card
            )
            SELECT
              ad.d AS date,
              COALESCE(cash.expense_cash, 0) AS expense_cash,
              COALESCE(card.expense_card, 0) AS expense_card,
              (COALESCE(cash.expense_cash, 0) + COALESCE(card.expense_card, 0)) AS expense_total
            FROM all_dates ad
            LEFT JOIN cash ON cash.d = ad.d
            LEFT JOIN card ON card.d = ad.d
            ORDER BY ad.d ASC
            """,
            (ym, CATEGORY_CARD_PAYMENT, ym),
        )


# ============================================================
# Relatórios / Exportação por competência
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
    """
    Exporta por competência (ym):
    - transactions do mês (caixa)
    - card_purchases com invoice_ym do mês (cartão)

    fmt=json => retorna JSON
    fmt=csv  => retorna CSV (download)
    """
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
            [
                "source", "ym", "date", "type", "amount", "description", "category",
                "account_id", "card_id", "invoice_ym", "status"
            ]
        )

        for t in tx:
            writer.writerow(
                [
                    "cash",
                    ym,
                    t.get("date"),
                    t.get("type"),
                    t.get("amount"),
                    t.get("description"),
                    t.get("category"),
                    t.get("account_id"),
                    "",
                    "",
                    "",
                ]
            )

        for p in cp:
            writer.writerow(
                [
                    "card",
                    ym,
                    p.get("purchase_date"),
                    "card_purchase",
                    p.get("amount"),
                    p.get("description"),
                    p.get("category"),
                    "",
                    p.get("card_id"),
                    p.get("invoice_ym"),
                    p.get("status"),
                ]
            )

        output.seek(0)
        filename = f"financeai_{ym}_export.csv"

        return StreamingResponse(
            iter([output.getvalue()]),
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
            "User-Agent": "FinanceAI/1.5.0",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
            data = json.loads(raw)
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

    try:
        answer = data["choices"][0]["message"]["content"]
    except Exception:
        answer = "Não consegui extrair a resposta do Groq. Verifique o payload retornado no servidor."

    return {"answer_md": answer}
