# FinanceAI 🧠💰

Plataforma de gestão financeira pessoal com **Dashboard Web + API (FastAPI) + IA (Groq)** e persistência em **SQLite local** ou **Turso (libSQL)**.

[![Python](https://img.shields.io/badge/Python-3.10%2B-blue)](#)
[![FastAPI](https://img.shields.io/badge/FastAPI-API-green)](#)
[![SQLite](https://img.shields.io/badge/SQLite-Local-lightgrey)](#)
[![Turso](https://img.shields.io/badge/Turso-libSQL-black)](#)
[![Groq](https://img.shields.io/badge/Groq-LLM-orange)](#)

🔗 **Hugging Face Space (deploy):** [https://huggingface.co/spaces/ViniciusKhan/FinanceAI](https://huggingface.co/spaces/ViniciusKhan/FinanceAI)
🔗 **GitHub (código):** [https://github.com/ViniciusKanh/FinanceAI](https://github.com/ViniciusKanh/FinanceAI)

---

## 📌 Visão Geral

O **FinanceAI** integra, no mesmo repositório:

* 🌐 **Frontend Web (na raiz)**: `index.html` + `assets/` + `js/`
* 🧠 **Backend API (FastAPI)**: `backend/server.py` (Swagger/OpenAPI)
* 🗄️ **Banco de dados**:

  * ✅ **SQLite local** (arquivo em disco) para desenvolvimento
  * ✅ **Turso (libSQL)** (SQLite hosted) para produção com baixa fricção

A proposta é simples: **registro financeiro + visualização + automações/insights por IA**, sem “planilha infinita” como dependência estrutural. (Planilha é ótima… até virar sistema.)

---

## ✨ Funcionalidades

### 📊 Dashboard

* Saldo consolidado e por conta
* Fluxo de caixa (entradas/saídas)
* Filtros por mês/ano
* Gráficos de série temporal e por categoria

### 🏦 Gestão Financeira (Core)

* Contas
* Categorias
* Transações (receitas/despesas)
* Sumário mensal consolidado
* Relatórios por competência (export)

### 💳 Cartão de Crédito

* Cartões
* Compras do cartão (com **competência** `YYYY-MM`)
* Faturas agregadas por competência
* Pagamento de fatura com regra de **não dupla contagem** (ver seção abaixo)

### 🤖 Assistente IA (Groq)

* Perguntas sobre gastos, tendências e recomendações
* Respostas em linguagem natural com baixa latência (Groq)

---

## 🧠 Regra crítica: cartão sem dupla contagem (Caixa vs Competência) ✅

O FinanceAI separa dois conceitos:

* **Despesa real (competência do cartão)**: vem das **compras do cartão**
* **Pagamento da fatura**: é um **movimento de caixa**, mas **não é despesa “real”** (é quitação de passivo)

📌 Implementação prática:

* O backend usa uma categoria reservada para pagamento de fatura:

  * `CATEGORY_CARD_PAYMENT = "Cartão de Crédito (Pagamento)"`
* E outra para agrupar compras do cartão:

  * `CATEGORY_CARD_BUCKET = "Cartão de Crédito"`

✅ Resultado: você consegue visualizar:

* **Despesa real** = compras no cartão (por competência)
* **Saída de caixa** = pagamento da fatura (sem “contar duas vezes”)

---

## 🧱 Arquitetura

### 🌐 Frontend (raiz do repo)

* **TailwindCSS** (UI)
* **Chart.js** (gráficos)
* **Marked.js** (Markdown no chat/IA)
* **FontAwesome** (ícones)

### 🧠 Backend

* **FastAPI** (Swagger/OpenAPI)
* **Python**
* Integração com **Groq** (modelo configurável via env)

### 🗄️ Persistência

* **SQLite local**: arquivo definido por `FINANCE_DB`
* **Turso/libSQL**: usando `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`
* **Sync opcional**: `TURSO_SYNC_INTERVAL` (segundos)

---

## 📁 Estrutura do Repositório (REAL)

> Seu frontend **não está em `/web`**. Está **na raiz**.

```text
/
├─ index.html          # Frontend (entrada principal)
├─ assets/             # Imagens, logo, etc.
├─ js/                 # Scripts do frontend
├─ backend/
│  ├─ server.py        # FastAPI (API + DB + IA + reports + forecast)
│  ├─ requirements.txt
│  └─ ... (data/, etc.)
├─ FinanceAI/          # Pasta adicional do projeto (módulos/artefatos)
├─ .gitignore
└─ README.md
```

---

## 🚀 Como rodar localmente (SQLite) ✅

### 1) Backend (FastAPI)

```bash
cd backend
python -m venv .venv

# Windows
.\.venv\Scripts\activate

# Linux/Mac
# source .venv/bin/activate

pip install -r requirements.txt
```

Crie um `.env` dentro de `backend/` (não commitar):

```env
# ===== Banco (SQLite local) =====
FINANCE_DB=./data/finance.db

# ===== IA (Groq) =====
GROQ_API_KEY=coloque_sua_chave_aqui
# Opcional (o backend define default se não setar):
GROQ_MODEL=llama-3.1-70b-versatile

# ===== CORS (opcional) =====
CORS_ORIGINS=http://localhost:5500,http://127.0.0.1:5500
```

Suba a API:

```bash
uvicorn server:app --reload --host 0.0.0.0 --port 8000
```

### 2) Frontend

Sirva a raiz do projeto (recomendado para evitar CORS e caminhos relativos):

```bash
# na raiz (onde está o index.html)
python -m http.server 5500
```

Acesse:

* 🌐 Frontend: `http://localhost:5500`
* 🧠 API: `http://localhost:8000`
* 📚 Swagger: `http://localhost:8000/docs`

---

## 🔧 Configurar o Frontend para apontar para a API

O frontend usa um `API_BASE` no `js/app.js`.

✅ Em dev, mantenha:

* `http://localhost:8000`

✅ Em produção (HF Space), use a URL pública do Space (ou domínio que você definir).

---

## 📚 Documentação da API (Swagger / OpenAPI)

Quando o backend está rodando:

* Swagger UI: `http://localhost:8000/docs`
* OpenAPI JSON: `http://localhost:8000/openapi.json`

---

## 🧩 Endpoints principais (backend FastAPI)

### ✅ Saúde

* `GET /health` → status + versão + modo do banco

### 🏦 Contas

* `GET /accounts`
* `POST /accounts`
* `DELETE /accounts/{account_id}`

### 🏷️ Categorias

* `GET /categories`
* `POST /categories`
* `DELETE /categories/{category_id}`

### 💸 Transações (Caixa)

* `GET /transactions?year=YYYY&month=MM&limit=N`
* `POST /transactions`
* `DELETE /transactions/{tx_id}`

### 🔀 Transações consolidadas (Caixa + Cartão)

* `GET /transactions/combined?year=YYYY&month=MM&limit=N&include_card_payments=0|1`

> `include_card_payments=0` evita poluir “despesa” com pagamento de fatura.

### 📌 Sumário consolidado

* `GET /summary/combined?year=YYYY&month=MM`

Retorna (alto nível):

* saldo (caixa + cartão)
* receitas (caixa)
* despesas reais (caixa sem pagamento de fatura + compras do cartão)
* contagem de itens

### 📈 Gráficos

* `GET /charts/time?year=YYYY&month=MM`
* `GET /charts/categories?year=YYYY&month=MM`
* `GET /charts/combined/timeseries?year=YYYY&month=MM`
* `GET /charts/combined/categories?year=YYYY&month=MM`

### 💳 Cartões

* `GET /cards`
* `POST /cards`
* `DELETE /cards/{card_id}`

**Compras do cartão**

* `GET /cards/{card_id}/purchases?invoice_ym=YYYY-MM&limit=N`
* `POST /cards/purchases`
* `PATCH /cards/purchases/{purchase_id}`
* `DELETE /cards/purchases/{purchase_id}`

**Faturas / Sumário**

* `GET /cards/{card_id}/invoices`
* `GET /cards/{card_id}/invoice-summary?invoice_ym=YYYY-MM`

**Pagamento de fatura (saída de caixa sem dupla contagem)**

* `POST /cards/pay-invoice`

### 🤖 IA

* `POST /ai`
  Envia prompt/contexto e retorna resposta do Groq.

### 🧾 Relatórios

* `GET /reports/monthly?ym=YYYY-MM`
* `GET /reports/export?ym=YYYY-MM`

### 📉 Forecast (ML leve)

**Mensal (competência)**

* `POST /forecast/train`
* `GET /forecast?months=N&auto_train=1&account_id=...&include_card=0|1`

**Diário (caixa)**

* `POST /forecast/daily/train`
* `GET /forecast/daily?days=N&auto_train=1&lags=K&account_id=...&exclude_card_payments=1|0`

---

## 🌍 Produção com Turso (libSQL) ✅

### 1) Crie um banco no Turso

Você terá:

* `TURSO_DATABASE_URL` (ex.: `libsql://...`)
* `TURSO_AUTH_TOKEN`

### 2) Configure o backend para Turso

No `backend/.env` (local) ou **Secrets** (deploy):

```env
# ===== Banco (Turso / libSQL) =====
TURSO_DATABASE_URL=libsql://SEU_BANCO.turso.io
TURSO_AUTH_TOKEN=SEU_TOKEN_AQUI

# (Opcional) Sync periódico (em segundos)
TURSO_SYNC_INTERVAL=60

# ===== IA (Groq) =====
GROQ_API_KEY=coloque_sua_chave_aqui
GROQ_MODEL=llama-3.1-70b-versatile
```

📌 Observação objetiva:

* **Se `TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN` estiverem definidos**, o backend usa **Turso**.
* Caso contrário, usa **SQLite local** via `FINANCE_DB`.

---

## ☁️ Deploy no Hugging Face Spaces + Turso ✅

A forma mais estável e gratuita (na prática) é:

* Código no **GitHub**
* Backend rodando no **Hugging Face Spaces**
* Banco no **Turso**

### Passos (alto nível)

1. No Space, configure **Secrets**:

   * `TURSO_DATABASE_URL`
   * `TURSO_AUTH_TOKEN`
   * `GROQ_API_KEY`
   * `GROQ_MODEL`
2. (Opcional) `CORS_ORIGINS` se seu frontend estiver fora do Space.
3. Confirme no `/health` se o modo Turso está ativo.

---

## 🔐 Segurança (não negociar com isso)

Nunca commitar:

* `.env`
* `*.db`, `*.sqlite`
* tokens (Groq/Turso)

---

## 👤 Autor

**Vinicius de Souza Santos** — FinanceAI 🧠💰
