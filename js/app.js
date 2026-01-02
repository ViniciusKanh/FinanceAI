"use strict";

/* ==========================================================
   CONFIG
   ========================================================== */
// Permite configurar via localStorage:
// localStorage.setItem("FINANCEAI_API_BASE","http://localhost:8000");
// localStorage.removeItem("FINANCEAI_API_BASE");
const DEFAULT_API_BASE = "https://viniciuskhan-financeai.hf.space";
const API_BASE = (localStorage.getItem("FINANCEAI_API_BASE") || DEFAULT_API_BASE)
  .trim()
  .replace(/\/+$/, "");

window.FINANCEAI_API_BASE = API_BASE;

/* ==========================================================
   ESTADO LOCAL (frontend)
   ========================================================== */
const state = {
  accounts: [],
  categories: [],
  transactions: [],            // CAIXA (transactions)
  combinedTransactions: [],    // COMPETÊNCIA (cash + card_purchases)
  summaryCombined: null,       // /summary/combined
  health: null,                // /health
  cardPaymentCategory: "Cartão de Crédito (Pagamento)",

  currentDate: new Date(),
  isAiProcessing: false,

  // Cartões
  cards: [],
  selectedCardId: null,

  // Charts instances
  charts: {
    timeseries: null,
    categories: null,
    cardCategories: null,

    // Predictions
    predFlow: null,
    predCats: null,
  },

  // Relatórios
  reports: {
    lastMd: "",
    lastHtml: "",
  },

  // Cache predição (última)
  predictions: {
    lastPayload: null,
    lastRunAt: null,
  }
};

/* ==========================================================
   TOAST
   ========================================================== */
function showToast(title, msg, ms = 3500) {
  const box = document.getElementById("toast");
  const t = document.getElementById("toast-title");
  const m = document.getElementById("toast-msg");
  if (!box || !t || !m) return;

  t.innerText = String(title || "Aviso");
  m.innerText = String(msg || "");
  box.classList.remove("hidden");

  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => box.classList.add("hidden"), ms);
}
window.toast = showToast;

/* ==========================================================
   HELPERS
   ========================================================== */
function monthLabel(date) {
  const year = date.getFullYear();
  const month = date.getMonth(); // 0..11
  const months = [
    "Janeiro","Fevereiro","Março","Abril","Maio","Junho",
    "Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"
  ];
  return { year, month, label: `${months[month]} ${year}`, months };
}

function toMoney(v) {
  return `R$ ${Number(v || 0).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function safeText(s) {
  return String(s ?? "").replace(/[<>&"]/g, c => ({
    "<":"&lt;", ">":"&gt;", "&":"&amp;", '"':"&quot;"
  }[c]));
}

function sanitizeHtml(html) {
  const s = String(html ?? "");
  return s
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/on\w+="[^"]*"/gi, "")
    .replace(/on\w+='[^']*'/gi, "")
    .replace(/javascript:/gi, "");
}

function setDisabled(el, disabled) {
  if (!el) return;
  el.disabled = !!disabled;
  el.classList.toggle("opacity-60", !!disabled);
  el.classList.toggle("cursor-not-allowed", !!disabled);
}

function destroyChart(inst) {
  if (inst && typeof inst.destroy === "function") inst.destroy();
}

/* ==========================================================
   API (fetch com timeout + erros uniformes)
   ========================================================== */
async function api(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const headers = { ...(options.headers || {}) };

  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs || 12000);
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let resp;
  try {
    resp = await fetch(url, { ...options, headers, signal: controller.signal });
  } catch (e) {
    clearTimeout(timeoutId);
    const isAbort = (e && e.name === "AbortError");
    const err = new Error(isAbort
      ? "Timeout ao acessar o backend. Verifique o servidor/API_BASE."
      : "Falha de rede/CORS ao acessar o backend. Verifique API_BASE e o servidor (e evite abrir via file://)."
    );
    err.status = 0;
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!resp.ok) {
    let detail = "";
    try {
      const j = await resp.json();
      detail = j.detail || j.message || j.error || JSON.stringify(j);
    } catch {
      try { detail = await resp.text(); } catch { detail = ""; }
    }
    const err = new Error(detail || `Erro HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }

  const text = await resp.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

/* ==========================================================
   LOADERS
   ========================================================== */
async function loadHealth() {
  state.health = await api("/health");
  state.cardPaymentCategory =
    (state.health && state.health.card_payment_category) || state.cardPaymentCategory;
}

async function loadAccounts() {
  state.accounts = await api("/accounts");
}

async function loadCategories() {
  state.categories = await api("/categories");
}

async function loadCards() {
  state.cards = await api("/cards");
  if (!state.selectedCardId && state.cards.length > 0) {
    state.selectedCardId = state.cards[0].id;
  }
}

async function loadTransactionsForCurrentMonth() {
  const { year, month } = monthLabel(state.currentDate);
  state.transactions = await api(`/transactions?year=${year}&month=${month + 1}&limit=2000`);
}

async function loadCombinedForCurrentMonth() {
  const { year, month } = monthLabel(state.currentDate);
  state.combinedTransactions = await api(`/transactions/combined?year=${year}&month=${month + 1}&limit=5000`);
  state.summaryCombined = await api(`/summary/combined?year=${year}&month=${month + 1}`);
}

async function refreshAll() {
  try {
    await loadHealth();
    await Promise.all([loadAccounts(), loadCategories(), loadCards()]);
    await Promise.all([loadTransactionsForCurrentMonth(), loadCombinedForCurrentMonth()]);

    renderAll();
    await reloadCharts();
    await renderCreditControls();

    // se estiver na aba de relatórios, atualiza preview
    const reportsView = document.getElementById("view-reports");
    if (reportsView && !reportsView.classList.contains("hidden")) {
      await window.generateAndRenderReport?.();
    }

    // se estiver na aba de predições e já rodou antes, re-renderiza
    const predView = document.getElementById("view-predictions");
    if (predView && !predView.classList.contains("hidden") && state.predictions.lastPayload) {
      renderPredictionsUI(state.predictions.lastPayload);
      renderPredictionsCharts(state.predictions.lastPayload);
    }
  } catch (e) {
    console.error(e);
    showToast("Erro", e.message || String(e), 6000);
  }
}
window.refreshAll = refreshAll;

/* ==========================================================
   RENDERERS
   ========================================================== */
function renderAll() {
  renderAccounts();
  renderCategories();
  renderDashboard();
  renderCreditCardsList();
  hydrateCreditSelects();
  hydratePredictionsSelects();
}

function renderAccounts() {
  const select = document.getElementById("tx-account");
  if (select) {
    if (state.accounts.length > 0) {
      select.innerHTML = state.accounts
        .map(acc => `<option value="${acc.id}">${safeText(acc.name)} (${safeText(acc.bank)})</option>`)
        .join("");
    } else {
      select.innerHTML = `<option value="">Sem contas</option>`;
    }
  }

  const payAcc = document.getElementById("pay-account");
  if (payAcc) {
    payAcc.innerHTML = state.accounts.length
      ? state.accounts.map(a => `<option value="${a.id}">${safeText(a.name)} (${safeText(a.bank)})</option>`).join("")
      : `<option value="">Sem contas</option>`;
  }

  const list = document.getElementById("settings-accounts-list");
  if (list) {
    list.innerHTML = state.accounts
      .map(acc => `
        <li class="flex justify-between items-center p-4 border border-slate-100 rounded-xl bg-slate-50">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-full bg-white border border-slate-200 flex items-center justify-center text-slate-500">
              <i class="fas fa-university"></i>
            </div>
            <div>
              <p class="font-bold text-slate-800 text-sm">${safeText(acc.name)}</p>
              <p class="text-xs text-slate-500 uppercase">${safeText(acc.bank)} • ${safeText(acc.type)}</p>
            </div>
          </div>
          <button onclick="deleteAccount(${acc.id})"
            class="w-8 h-8 rounded-full hover:bg-red-100 hover:text-red-600 text-slate-400 transition-colors">
            <i class="fas fa-trash"></i>
          </button>
        </li>
      `)
      .join("");
  }

  const cardsContainer = document.getElementById("accounts-cards-container");
  if (!cardsContainer) return;

  const accBalances = {};
  state.accounts.forEach(a => (accBalances[a.id] = 0));

  state.transactions.forEach(tx => {
    if (accBalances[tx.account_id] !== undefined) {
      accBalances[tx.account_id] += (tx.type === "income" ? Number(tx.amount || 0) : -Number(tx.amount || 0));
    }
  });

  if (state.accounts.length === 0) {
    cardsContainer.innerHTML = `
      <div class="w-full h-32 flex items-center justify-center text-slate-400 bg-white border border-slate-200 rounded-2xl border-dashed">
        <span class="text-sm">Cadastre uma conta para começar.</span>
      </div>
    `;
    return;
  }

  cardsContainer.innerHTML = state.accounts
    .map(acc => `
      <div class="flex-shrink-0 w-64 bg-white border border-slate-200 rounded-2xl p-5 shadow-sm relative overflow-hidden group">
        <div class="flex justify-between items-start mb-4">
          <div>
            <p class="text-[10px] font-bold uppercase text-slate-400 tracking-wider">${safeText(acc.bank)}</p>
            <h4 class="font-bold text-slate-700 text-lg truncate w-40">${safeText(acc.name)}</h4>
          </div>
          <div class="px-2 py-1 rounded bg-slate-100 text-[10px] font-bold text-slate-500 capitalize">${safeText(acc.type)}</div>
        </div>
        <p class="text-2xl font-bold ${accBalances[acc.id] < 0 ? "text-rose-600" : "text-slate-800"}">
          ${toMoney(accBalances[acc.id])}
        </p>
        <div class="absolute -right-4 -bottom-4 text-8xl text-slate-50 opacity-10 pointer-events-none group-hover:scale-110 transition-transform">
          <i class="fas fa-wallet"></i>
        </div>
      </div>
    `)
    .join("");
}

function renderCategories() {
  const select = document.getElementById("tx-category");
  if (select) {
    select.innerHTML = state.categories.length > 0
      ? state.categories.map(cat => `<option value="${safeText(cat.name)}">${safeText(cat.name)}</option>`).join("")
      : `<option value="Geral">Geral</option>`;
  }

  const pc = document.getElementById("purchase-category");
  if (pc) {
    pc.innerHTML = state.categories.length
      ? state.categories.map(cat => `<option value="${safeText(cat.name)}">${safeText(cat.name)}</option>`).join("")
      : `<option value="Geral">Geral</option>`;
  }

  const list = document.getElementById("settings-categories-list");
  if (list) {
    list.innerHTML = state.categories
      .map(cat => `
        <li class="flex justify-between items-center p-3 border border-slate-100 rounded-xl hover:bg-slate-50 transition-colors">
          <span class="font-bold text-slate-600 text-sm ml-2">${safeText(cat.name)}</span>
          <button onclick="deleteCategory(${cat.id})" class="text-slate-300 hover:text-red-500 p-2">
            <i class="fas fa-trash"></i>
          </button>
        </li>
      `)
      .join("");
  }
}

function renderDashboard() {
  const { label, months, month } = monthLabel(state.currentDate);
  const monthDisplay = document.getElementById("current-month-display");
  if (monthDisplay) monthDisplay.innerText = label;

  const sc = state.summaryCombined;
  const inc = sc ? Number(sc.income || 0) : 0;
  const exp = sc ? Number(sc.expense_total || 0) : 0;
  const bal = sc ? Number(sc.balance || 0) : (inc - exp);
  const txCount = sc ? Number((sc.count_cash || 0) + (sc.count_card || 0)) : 0;

  const totalBalance = document.getElementById("total-balance");
  const totalIncome = document.getElementById("total-income");
  const totalExpense = document.getElementById("total-expense");
  const txCountEl = document.getElementById("tx-count");

  if (totalBalance) totalBalance.innerText = toMoney(bal);
  if (totalIncome) totalIncome.innerText = toMoney(inc);
  if (totalExpense) totalExpense.innerText = toMoney(exp);
  if (txCountEl) txCountEl.innerText = `${txCount} lançamentos`;

  const list = document.getElementById("transactions-list");
  if (!list) return;

  const rows = Array.isArray(state.combinedTransactions) ? state.combinedTransactions : [];

  if (rows.length === 0) {
    list.innerHTML = `
      <div class="flex flex-col items-center justify-center h-64 text-slate-400">
        <i class="fas fa-calendar-times text-4xl mb-3 opacity-20"></i>
        <p class="text-sm font-medium">Nenhum lançamento em ${months[month]}.</p>
      </div>`;
    return;
  }

  const sorted = [...rows].sort(
    (a, b) => (b.date || "").localeCompare(a.date || "") || (Number(b.id) - Number(a.id))
  );

  list.innerHTML = sorted.map(t => {
    const source = t.source || "cash"; // 'cash'|'card'
    const isCard = source === "card";
    const isExp = isCard ? true : (t.type === "expense");
    const icon = isCard ? "fa-credit-card" : (isExp ? "fa-arrow-down" : "fa-arrow-up");
    const badge = isCard
      ? `<span class="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 font-bold">CARTÃO</span>`
      : `<span class="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-bold">CAIXA</span>`;

    const cat = safeText(t.category || "Geral");
    const dt = t.date ? new Date(t.date + "T00:00:00").toLocaleDateString("pt-BR") : "-";

    const onDelete = isCard
      ? `deleteCardPurchase(${Number(t.id)})`
      : `deleteTransaction(${Number(t.id)})`;

    const amount = Number(t.amount || 0);

    return `
      <div class="p-4 flex items-center justify-between hover:bg-slate-50 transition-colors group">
        <div class="flex items-center gap-4">
          <div class="w-10 h-10 rounded-xl ${isExp ? "bg-rose-100 text-rose-600" : "bg-emerald-100 text-emerald-600"} flex items-center justify-center text-lg">
            <i class="fas ${icon}"></i>
          </div>
          <div>
            <p class="font-bold text-slate-800 text-sm">${safeText(t.description || "")}</p>
            <div class="flex items-center gap-2 text-xs text-slate-400 mt-1">
              <span>${dt}</span>
              <span class="w-1 h-1 rounded-full bg-slate-300"></span>
              <span class="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-medium">${cat}</span>
              <span class="w-1 h-1 rounded-full bg-slate-300"></span>
              ${badge}
            </div>
          </div>
        </div>
        <div class="text-right">
          <p class="font-bold text-sm ${isExp ? "text-rose-600" : "text-emerald-600"}">
            ${isExp ? "- " : "+ "}${toMoney(amount)}
          </p>
          <button onclick="${onDelete}"
            class="text-xs text-red-500 opacity-0 group-hover:opacity-100 hover:underline mt-1">
            Excluir
          </button>
        </div>
      </div>`;
  }).join("");
}

/* ===== Credit card render ===== */
function renderCreditCardsList() {
  const container = document.getElementById("cards-list");
  if (!container) return;

  if (!state.cards || state.cards.length === 0) {
    container.innerHTML = `
      <div class="p-4 text-sm text-slate-400">
        Nenhum cartão cadastrado. Clique em <b>Novo Cartão</b>.
      </div>`;
    return;
  }

  container.innerHTML = state.cards.map(c => {
    const active = (Number(c.id) === Number(state.selectedCardId));
    return `
      <div role="button" tabindex="0"
        onclick="selectCard(${c.id})"
        class="w-full text-left p-4 rounded-2xl border ${active ? "border-blue-200 bg-blue-50" : "border-slate-200 bg-white hover:bg-slate-50"} transition-colors cursor-pointer">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="text-[10px] font-bold uppercase ${active ? "text-blue-700" : "text-slate-400"} tracking-wider">${safeText(c.bank)}</p>
            <p class="font-bold text-slate-900">${safeText(c.name)}</p>
            <p class="text-xs text-slate-500 mt-1">
              Fecha dia <b>${c.closing_day}</b> • Vence dia <b>${c.due_day}</b>
              ${Number(c.credit_limit || 0) > 0 ? `• Limite: <b>${toMoney(c.credit_limit)}</b>` : ""}
            </p>
          </div>
          <button onclick="event.stopPropagation(); deleteCard(${c.id});"
            class="w-9 h-9 rounded-full ${active ? "hover:bg-blue-100 text-blue-700" : "hover:bg-red-100 hover:text-red-600 text-slate-400"} transition-colors">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>
    `;
  }).join("");
}

function hydrateCreditSelects() {
  const purchaseCard = document.getElementById("purchase-card");
  if (purchaseCard) {
    purchaseCard.innerHTML = state.cards.length
      ? state.cards.map(c => `<option value="${c.id}">${safeText(c.name)} (${safeText(c.bank)})</option>`).join("")
      : `<option value="">Sem cartões</option>`;
  }

  const payCard = document.getElementById("pay-card");
  if (payCard) {
    payCard.innerHTML = state.cards.length
      ? state.cards.map(c => `<option value="${c.id}">${safeText(c.name)} (${safeText(c.bank)})</option>`).join("")
      : `<option value="">Sem cartões</option>`;
  }
}

async function renderCreditControls() {
  const invYmInput = document.getElementById("invoice-ym");
  if (invYmInput && !invYmInput.value) {
    const d = new Date();
    invYmInput.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  const payYm = document.getElementById("pay-invoice-ym");
  if (payYm && invYmInput && invYmInput.value) {
    payYm.value = invYmInput.value;
  }

  const payDate = document.getElementById("pay-date");
  if (payDate && !payDate.value) {
    const d = new Date();
    payDate.value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  }
}

/* ==========================================================
   CHARTS (Dashboard)
   ========================================================== */
async function reloadCharts() {
  await Promise.all([renderTimeseriesChart(), renderCategoriesChart()]);
}
window.reloadCharts = reloadCharts;

async function renderTimeseriesChart() {
  const el = document.getElementById("chart-timeseries");
  if (!el) return;

  if (typeof Chart === "undefined") {
    showToast("Charts", "Chart.js não carregou.");
    return;
  }

  const { year, month } = monthLabel(state.currentDate);

  const [cash, comb] = await Promise.all([
    api(`/charts/timeseries?year=${year}&month=${month+1}`),
    api(`/charts/combined/timeseries?year=${year}&month=${month+1}`),
  ]);

  const map = new Map();
  (cash || []).forEach(d => {
    const k = d.date;
    if (!map.has(k)) map.set(k, { income: 0, expense_total: 0 });
    map.get(k).income = Number(d.income || 0);
  });
  (comb || []).forEach(d => {
    const k = d.date;
    if (!map.has(k)) map.set(k, { income: 0, expense_total: 0 });
    map.get(k).expense_total = Number(d.expense_total || 0);
  });

  const dates = Array.from(map.keys()).sort((a,b) => String(a).localeCompare(String(b)));

  const labels = dates.map(ds => {
    const dt = new Date(ds + "T00:00:00");
    return dt.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  });
  const income = dates.map(ds => map.get(ds).income);
  const expense = dates.map(ds => map.get(ds).expense_total);

  destroyChart(state.charts.timeseries);
  state.charts.timeseries = new Chart(el, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Receitas (Caixa)", data: income, tension: 0.25 },
        { label: "Despesas (Competência: Caixa + Cartão)", data: expense, tension: 0.25 },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: true },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${toMoney(ctx.parsed.y)}` } }
      },
      scales: { y: { ticks: { callback: (v) => toMoney(v) } } },
    },
  });
}

async function renderCategoriesChart() {
  const el = document.getElementById("chart-categories");
  if (!el) return;

  if (typeof Chart === "undefined") {
    showToast("Charts", "Chart.js não carregou.");
    return;
  }

  const { year, month } = monthLabel(state.currentDate);
  const data = await api(`/charts/combined/categories?year=${year}&month=${month+1}`);

  const labels = (data || []).map(d => d.category);
  const totals = (data || []).map(d => Number(d.total || 0));

  destroyChart(state.charts.categories);
  state.charts.categories = new Chart(el, {
    type: "doughnut",
    data: { labels, datasets: [{ data: totals }] },
    options: {
      responsive: true,
      plugins: {
        legend: { display: true, position: "bottom" },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${toMoney(ctx.parsed)}` } }
      },
    },
  });
}

function renderCardCategoryChart(purchases) {
  const el = document.getElementById("chart-card-categories");
  if (!el) return;

  if (typeof Chart === "undefined") {
    showToast("Charts", "Chart.js não carregou.");
    return;
  }

  const byCat = {};
  (purchases || []).forEach(p => {
    const k = p.category || "Geral";
    byCat[k] = (byCat[k] || 0) + Number(p.amount || 0);
  });

  const labels = Object.keys(byCat);
  const totals = labels.map(k => byCat[k]);

  destroyChart(state.charts.cardCategories);
  state.charts.cardCategories = new Chart(el, {
    type: "bar",
    data: { labels, datasets: [{ label: "Total", data: totals }] },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => toMoney(ctx.parsed.y) } }
      },
      scales: { y: { ticks: { callback: (v) => toMoney(v) } } }
    }
  });
}

/* ==========================================================
   NAV (Desktop + Mobile) - ALINHADO AO HTML
   ========================================================== */
function setActiveNav(view) {
  const ids = ["dashboard", "predictions", "credit", "settings", "reports"];

  ids.forEach(id => {
    const el = document.getElementById(`nav-${id}`);
    if (!el) return;
    el.className = "w-full flex items-center gap-3 px-4 py-3 text-sm font-medium rounded-lg text-slate-600 hover:bg-slate-50 transition-colors";
  });

  const active = document.getElementById(`nav-${view}`);
  if (active) {
    active.className =
      "w-full flex items-center gap-3 px-4 py-3 text-sm font-medium rounded-lg bg-blue-50 text-blue-700 transition-colors border border-blue-100";
  }

  ids.forEach(id => {
    const m = document.getElementById(`mnav-${id}`);
    if (!m) return;
    m.className = "flex flex-col items-center p-2 text-slate-400 hover:text-blue-600";
  });

  const mactive = document.getElementById(`mnav-${view}`);
  if (mactive) mactive.className = "flex flex-col items-center p-2 text-blue-600";
}

window.switchView = async (v) => {
  ["dashboard","predictions","credit","settings","reports"].forEach(id => {
    const el = document.getElementById(`view-${id}`);
    if (el) el.classList.add("hidden");
  });

  const target = document.getElementById(`view-${v}`);
  if (target) target.classList.remove("hidden");

  setActiveNav(v);

  try {
    if (v === "dashboard") await reloadCharts();
    if (v === "credit") await window.loadCardsAndRender?.();
    if (v === "reports") await window.generateAndRenderReport?.();
    if (v === "predictions" && state.predictions.lastPayload) {
      renderPredictionsUI(state.predictions.lastPayload);
      renderPredictionsCharts(state.predictions.lastPayload);
    }
  } catch (e) {
    console.error(e);
    showToast("Erro", e.message || String(e));
  }
};

window.toggleAIModal = () => {
  const el = document.getElementById("ai-modal");
  if (el) el.classList.toggle("hidden");
};
window.toggleModal = (id) => {
  const el = document.getElementById(id);
  if (el) el.classList.toggle("hidden");
};

/* ==========================================================
   DASHBOARD ACTIONS
   ========================================================== */
window.setTxType = (type) => {
  const txType = document.getElementById("tx-type");
  if (txType) txType.value = type;

  const btnE = document.getElementById("btn-expense");
  const btnI = document.getElementById("btn-income");
  if (!btnE || !btnI) return;

  if (type === "expense") {
    btnE.className = "py-2.5 text-sm font-bold rounded-lg shadow-sm bg-white text-rose-600 transition-all";
    btnI.className = "py-2.5 text-sm font-bold rounded-lg text-slate-500 hover:text-emerald-600 transition-all";
  } else {
    btnE.className = "py-2.5 text-sm font-bold rounded-lg text-slate-500 hover:text-rose-600 transition-all";
    btnI.className = "py-2.5 text-sm font-bold rounded-lg shadow-sm bg-white text-emerald-600 transition-all";
  }
};

window.filterDate = async (d) => {
  if (d === "next") state.currentDate.setMonth(state.currentDate.getMonth() + 1);
  else state.currentDate.setMonth(state.currentDate.getMonth() - 1);

  try {
    await Promise.all([loadTransactionsForCurrentMonth(), loadCombinedForCurrentMonth()]);
    renderAll();
    await reloadCharts();

    const reportsView = document.getElementById("view-reports");
    if (reportsView && !reportsView.classList.contains("hidden")) {
      await window.generateAndRenderReport?.();
    }
  } catch (e) {
    console.error(e);
    showToast("Erro", e.message || String(e));
  }
};

/* ==========================================================
   PREDICTIONS (ABA) — CONTRATO NOVO (backend ml_forecast.py)
   Esperado:
   {
     meta:{basis,trained_at,lags,income_algo,expense_algo},
     horizon_days:int,
     kpis:{income_pred_total,expense_pred_total,net_pred_total},
     series:[{date,income_pred,expense_pred,net_pred,income_low, ... , expense_by_category:{...}}],
     top_categories:[{category,amount,share}],
     alerts:[{level,message}],
     risk_score:int(0..10)
   }
   ========================================================== */
function hydratePredictionsSelects() {
  const accSel = document.getElementById("pred-account");
  if (!accSel) return;

  accSel.innerHTML = state.accounts.length
    ? state.accounts.map(a => `<option value="${a.id}">${safeText(a.name)} (${safeText(a.bank)})</option>`).join("")
    : `<option value="">Sem contas</option>`;

  const scope = document.getElementById("pred-scope");
  if (scope) {
    const v = scope.value || "all";
    accSel.classList.toggle("hidden", v !== "account");
  }
}

function setPredMeta(text) {
  const el = document.getElementById("pred-meta");
  if (el) el.innerText = text;
}

/* --- Pred utils (robustos) --- */
function asNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function clampCanvasHeight(canvasEl, h = 260) {
  if (!canvasEl) return;
  if (!canvasEl.height || canvasEl.height < 80) canvasEl.height = h;
}

function isIsoDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function fmtLabel(x) {
  if (!x) return "—";
  if (isIsoDate(x)) return new Date(x + "T00:00:00").toLocaleDateString("pt-BR");
  return String(x);
}

function median(arr) {
  const a = (arr || []).filter(n => Number.isFinite(n)).slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function riskLabel(score0to10) {
  const s = asNumber(score0to10);
  if (s >= 7) return "Alto";
  if (s >= 3) return "Médio";
  return "Baixo";
}

function levelToUi(level) {
  const lv = String(level || "").toLowerCase();
  if (lv.includes("warn") || lv.includes("warning")) {
    return { icon: "fa-triangle-exclamation", cls: "bg-amber-50 border-amber-200 text-amber-900", title: "Atenção" };
  }
  if (lv.includes("error") || lv.includes("critical")) {
    return { icon: "fa-circle-xmark", cls: "bg-rose-50 border-rose-200 text-rose-900", title: "Risco" };
  }
  if (lv.includes("info")) {
    return { icon: "fa-circle-info", cls: "bg-sky-50 border-sky-200 text-sky-900", title: "Info" };
  }
  return { icon: "fa-circle-check", cls: "bg-emerald-50 border-emerald-200 text-emerald-900", title: "OK" };
}

/**
 * Normaliza resposta do backend para um formato único no front.
 * - Novo contrato: payload.series + payload.kpis
 * - Antigo (se existir): payload.predictions/history
 */
function normalizeForecastDaily(payload) {
  const p = payload || {};

  // -------------------------
  // 1) CONTRATO "NOVO" ANTIGO (series + kpis no topo)
  // -------------------------
  const isNew = Array.isArray(p.series) && p.kpis && typeof p.kpis === "object";
  if (isNew) {
    const horizon = asNumber(p.horizon_days || (p.series?.length || 7)) || 7;
    const series = (p.series || [])
      .filter(r => r && isIsoDate(r.date))
      .map(r => ({
        date: r.date,
        label: fmtLabel(r.date),
        income: asNumber(r.income_pred),
        expense: asNumber(r.expense_pred),
        net: asNumber(r.net_pred ?? (asNumber(r.income_pred) - asNumber(r.expense_pred))),
        income_low: asNumber(r.income_low),
        income_high: asNumber(r.income_high),
        expense_low: asNumber(r.expense_low),
        expense_high: asNumber(r.expense_high),
        expense_by_category: r.expense_by_category || null,
      }));

    return {
      contract: "new",
      meta: p.meta || {},
      basis: String(p?.meta?.basis || p.basis || "cash_daily_sklearn"),
      horizonDays: horizon,
      kpis: {
        income: asNumber(p?.kpis?.income_pred_total),
        expense: asNumber(p?.kpis?.expense_pred_total),
        net: asNumber(p?.kpis?.net_pred_total),
      },
      series,
      topCategories: Array.isArray(p.top_categories) ? p.top_categories : [],
      alerts: Array.isArray(p.alerts) ? p.alerts : [],
      riskScore: asNumber(p.risk_score),
    };
  }

  // -------------------------
  // 2) SEU BACKEND ATUAL (v2): predictions + metrics.{kpis,alerts,risk_score,meta,top_categories}
  // -------------------------
  const isBackendV2 =
    Array.isArray(p.predictions) &&
    p.metrics &&
    typeof p.metrics === "object";

  if (isBackendV2) {
    const preds = p.predictions || [];
    const horizon = asNumber(p.days || preds.length || 7) || 7;

    const series = preds.map((r, idx) => {
      const date = r?.date || null;

      // Aceita tanto income_pred/expense_pred quanto income/expense (fallback)
      const income = asNumber(r?.income_pred ?? r?.income);
      const expense = asNumber(r?.expense_pred ?? r?.expense ?? r?.expense_total);
      const net = asNumber(r?.net_pred ?? r?.net ?? (income - expense));

      return {
        date: isIsoDate(date) ? date : null,
        label: isIsoDate(date) ? fmtLabel(date) : `t+${idx + 1}`,
        income,
        expense,
        net,
        income_low: asNumber(r?.income_low),
        income_high: asNumber(r?.income_high),
        expense_low: asNumber(r?.expense_low),
        expense_high: asNumber(r?.expense_high),
        expense_by_category: (r?.expense_by_category && typeof r.expense_by_category === "object")
          ? r.expense_by_category
          : null,
      };
    });

    const k = (p.metrics.kpis && typeof p.metrics.kpis === "object") ? p.metrics.kpis : {};
    const kIncome = asNumber(k.income_pred_total ?? k.income_total ?? 0);
    const kExpense = asNumber(k.expense_pred_total ?? k.expense_total ?? 0);
    const kNet = asNumber(k.net_pred_total ?? (kIncome - kExpense));

    return {
      contract: "backend_v2",
      meta: p.metrics.meta || {},
      basis: String(p.basis || p.metrics?.meta?.basis || "cash_daily_sklearn"),
      horizonDays: horizon,
      kpis: { income: kIncome, expense: kExpense, net: kNet },
      series,
      topCategories: Array.isArray(p.metrics.top_categories) ? p.metrics.top_categories : [],
      alerts: Array.isArray(p.metrics.alerts) ? p.metrics.alerts : [],
      riskScore: asNumber(p.metrics.risk_score),
    };
  }

  // -------------------------
  // 3) FALLBACK: contrato antigo genérico (predictions sem metrics)
  // -------------------------
  const predRaw = Array.isArray(p.predictions) ? p.predictions : [];
  const horizon = asNumber(p.horizon_days || predRaw.length || 7) || 7;

  const series = predRaw.map((r, idx) => {
    const date = r?.date || null;
    const income = asNumber(r?.income_pred ?? r?.income);
    const expense = asNumber(r?.expense_pred ?? r?.expense ?? r?.expense_total);
    const net = asNumber(r?.net_pred ?? r?.net ?? (income - expense));
    return {
      date: isIsoDate(date) ? date : null,
      label: isIsoDate(date) ? fmtLabel(date) : `t+${idx + 1}`,
      income,
      expense,
      net,
      income_low: asNumber(r?.income_low),
      income_high: asNumber(r?.income_high),
      expense_low: asNumber(r?.expense_low),
      expense_high: asNumber(r?.expense_high),
      expense_by_category: null,
    };
  });

  const kIncome = series.reduce((a, r) => a + r.income, 0);
  const kExpense = series.reduce((a, r) => a + r.expense, 0);
  const kNet = series.reduce((a, r) => a + r.net, 0);

  return {
    contract: "old",
    meta: p.meta || {},
    basis: String(p.basis || p?.meta?.basis || "daily"),
    horizonDays: horizon,
    kpis: { income: kIncome, expense: kExpense, net: kNet },
    series,
    topCategories: [],
    alerts: [],
    riskScore: 0,
  };
}

/**
 * Gera histórico diário a partir das transações combinadas (competência),
 * para dar contexto no gráfico (últimos ~30 dias).
 */
function buildDailyHistoryFromCombined(maxDays = 30) {
  const rows = Array.isArray(state.combinedTransactions) ? state.combinedTransactions : [];
  const byDay = {};

  for (const r of rows) {
    const dt = r?.date || r?.purchase_date;
    if (!dt) continue;
    const date = String(dt).slice(0, 10);
    if (!isIsoDate(date)) continue;

    if (!byDay[date]) byDay[date] = { income: 0, expense: 0, net: 0 };

    const isCard = (r?.source === "card");
    const isInc = (!isCard) && (r?.type === "income");
    const isExp = isCard || (r?.type === "expense");

    const amt = asNumber(r?.amount);
    if (amt <= 0) continue;

    if (isInc) byDay[date].income += amt;
    if (isExp) byDay[date].expense += amt;
  }

  const days = Object.keys(byDay).sort((a, b) => a.localeCompare(b));
  const tail = days.slice(Math.max(0, days.length - maxDays));

  return tail.map(d => {
    const v = byDay[d];
    const net = asNumber(v.income) - asNumber(v.expense);
    return { date: d, label: fmtLabel(d), income: asNumber(v.income), expense: asNumber(v.expense), net };
  });
}

function setPredLoading(isLoading) {
  const btn = document.getElementById("btn-run-pred");
  const icon = document.getElementById("pred-loading-icon"); // opcional (se existir no HTML)

  if (btn) {
    setDisabled(btn, isLoading);
    btn.innerHTML = isLoading
      ? `<i class="fas fa-circle-notch animate-spin mr-2"></i>Gerando...`
      : `<i class="fas fa-wand-magic-sparkles mr-2"></i> Gerar`;
  }
  if (icon) icon.classList.toggle("hidden", !isLoading);

  // deixa os cards “vivos” durante o load
  const elBal = document.getElementById("pred-balance");
  const elInc = document.getElementById("pred-income");
  const elExp = document.getElementById("pred-expense");
  const elRisk = document.getElementById("pred-risk");
  const elCount = document.getElementById("pred-count");
  const elNote = document.getElementById("pred-balance-note");

  if (isLoading) {
    if (elBal) elBal.innerText = "…";
    if (elInc) elInc.innerText = "…";
    if (elExp) elExp.innerText = "…";
    if (elRisk) elRisk.innerText = "Processando…";
    if (elCount) elCount.innerText = "—";
    if (elNote) elNote.innerText = "calculando previsão…";
  }
}

/* --- Charts de predição --- */
function renderPredictionsCharts(payload) {
  if (typeof Chart === "undefined") {
    showToast("Predições", "Chart.js não carregou.");
    return;
  }

  const flowCanvas = document.getElementById("chart-pred-flow");
  const catCanvas = document.getElementById("chart-pred-categories");

  const norm = normalizeForecastDaily(payload);
  const pred = norm.series || [];
  const hist = buildDailyHistoryFromCombined(30);

  // ---------- Flow (hist + pred) ----------
  if (flowCanvas) {
    clampCanvasHeight(flowCanvas, 260);

    const labels = [...hist.map(r => r.label), ...pred.map(r => r.label)];
    const netSeries = [...hist.map(r => asNumber(r.net)), ...pred.map(r => asNumber(r.net))];

    destroyChart(state.charts.predFlow);
    if (!labels.length) {
      state.charts.predFlow = null;
    } else {
      const n = Math.min(labels.length, netSeries.length);

      state.charts.predFlow = new Chart(flowCanvas, {
        type: "line",
        data: {
          labels: labels.slice(0, n),
          datasets: [{ label: "Saldo líquido (histórico + previsão)", data: netSeries.slice(0, n), tension: 0.25 }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: true },
            tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${toMoney(ctx.parsed.y)}` } }
          },
          scales: { y: { ticks: { callback: (v) => toMoney(v) } } },
        }
      });
    }
  }

  // ---------- Categories provável (do backend) ----------
  if (catCanvas) {
    clampCanvasHeight(catCanvas, 240);

    // 1) se backend trouxe top_categories, usa
    let top = Array.isArray(norm.topCategories) ? norm.topCategories : [];
    top = top
      .map(x => ({ category: String(x.category || "Outros"), amount: asNumber(x.amount || 0) }))
      .filter(x => x.amount > 0)
      .slice(0, 10);

    // 2) fallback: soma categorias do histórico do mês
    if (!top.length) {
      const byCat = {};
      const rows = Array.isArray(state.combinedTransactions) ? state.combinedTransactions : [];
      for (const r of rows) {
        const isExpense = (r?.source === "card") || (r?.type === "expense");
        if (!isExpense) continue;
        const amt = asNumber(r?.amount);
        if (amt <= 0) continue;
        const cat = (r?.category && String(r.category).trim()) ? String(r.category).trim() : "Geral";
        byCat[cat] = (byCat[cat] || 0) + amt;
      }
      top = Object.entries(byCat)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([category, amount]) => ({ category, amount }));
    }

    destroyChart(state.charts.predCats);
    if (!top.length) {
      state.charts.predCats = null;
    } else {
      const labels = top.map(x => x.category);
      const totals = top.map(x => x.amount);

      state.charts.predCats = new Chart(catCanvas, {
        type: "doughnut",
        data: { labels, datasets: [{ data: totals }] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: true, position: "bottom" },
            tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${toMoney(ctx.parsed)}` } }
          },
        }
      });
    }
  }
}

/* --- UI de predição --- */
function renderPredictionsUI(payload) {
  const norm = normalizeForecastDaily(payload);
  const pred = norm.series || [];
  const horizon = norm.horizonDays || pred.length || 7;

  const elBal = document.getElementById("pred-balance");
  const elInc = document.getElementById("pred-income");
  const elExp = document.getElementById("pred-expense");
  const elRisk = document.getElementById("pred-risk");
  const elCount = document.getElementById("pred-count");
  const elNote = document.getElementById("pred-balance-note");

  // KPIs completos (agora preenche tudo)
  if (elBal) elBal.innerText = toMoney(norm.kpis.net);
  if (elInc) elInc.innerText = toMoney(norm.kpis.income);
  if (elExp) elExp.innerText = toMoney(norm.kpis.expense);
  if (elNote) elNote.innerText = `projeção no horizonte • ${horizon} dia(s)`;
  if (elCount) elCount.innerText = `${pred.length} itens`;

  // Risk: score 0..10 + contagem de alertas
  const alertCount = Array.isArray(norm.alerts) ? norm.alerts.length : 0;
  const rLabel = riskLabel(norm.riskScore);
  if (elRisk) elRisk.innerText = `${rLabel} (${Math.max(alertCount, asNumber(norm.riskScore))})`;

  // Alerts (do backend)
  const alertsBox = document.getElementById("pred-alerts");
  if (alertsBox) {
    const items = [];

    if (Array.isArray(norm.alerts) && norm.alerts.length) {
      for (const a of norm.alerts.slice(0, 8)) {
        const ui = levelToUi(a?.level);
        items.push({
          title: ui.title,
          text: String(a?.message || "").trim() || "Alerta",
          icon: ui.icon,
          cls: ui.cls
        });
      }
    } else {
      // fallback: alerta básico via sinal
      if (norm.kpis.net < 0) {
        items.push({
          title: "Saldo negativo previsto",
          text: "O saldo líquido previsto no horizonte está abaixo de zero.",
          icon: "fa-triangle-exclamation",
          cls: "bg-amber-50 border-amber-200 text-amber-900"
        });
      } else {
        items.push({
          title: "Sem alertas críticos",
          text: "Nada crítico no horizonte. Use como planejamento, não como sentença.",
          icon: "fa-circle-check",
          cls: "bg-emerald-50 border-emerald-200 text-emerald-900"
        });
      }
    }

    alertsBox.innerHTML = items.map(a => `
      <div class="p-3 rounded-xl border ${a.cls} flex gap-3 items-start">
        <i class="fas ${a.icon} mt-0.5"></i>
        <div>
          <div class="font-bold text-sm">${safeText(a.title)}</div>
          <div class="text-xs opacity-80">${safeText(a.text)}</div>
        </div>
      </div>
    `).join("");
  }

  // Actions (objetivas, baseadas em risco + saldo)
  const actionsBox = document.getElementById("pred-actions");
  if (actionsBox) {
    const acts = [];

    acts.push("Revise despesas recorrentes e corte o que não agrega valor (a tradição manda: pagar menos sempre funciona).");

    if (norm.kpis.net < 0) {
      acts.push("Antecipe recebíveis ou reprograme pagamentos para evitar saldo negativo no horizonte.");
      acts.push("Defina um teto diário de gasto até estabilizar.");
    }

    if (norm.riskScore >= 7 || alertCount >= 4) {
      acts.push("Concentre compras em dias com maior probabilidade de receita e evite parcelamentos no curto prazo.");
      acts.push("Se existir uma categoria dominante, trate como ‘ponto de vazamento’ e ataque primeiro.");
    }

    if (!acts.length) acts.push("Mantenha o monitoramento; ajuste fino > improviso.");

    actionsBox.innerHTML = acts.map(t => `
      <div class="p-3 rounded-xl border border-slate-200 bg-slate-50 flex gap-3 items-start">
        <i class="fas fa-list-check mt-0.5 text-slate-600"></i>
        <div class="text-sm text-slate-700 font-medium">${safeText(t)}</div>
      </div>
    `).join("");
  }

  // Lista detalhada (com income/expense/net + intervalo quando existir)
  const list = document.getElementById("pred-list");
  if (list) {
    if (!pred.length) {
      list.innerHTML = `<div class="p-6 text-sm text-slate-400">Sem dados previstos.</div>`;
    } else {
      list.innerHTML = pred.slice(0, 120).map(r => {
        const inc = asNumber(r.income);
        const exp = asNumber(r.expense);
        const net = asNumber(r.net);

        const incHasRange = (asNumber(r.income_low) > 0 || asNumber(r.income_high) > 0);
        const expHasRange = (asNumber(r.expense_low) > 0 || asNumber(r.expense_high) > 0);

        // categoria top do dia (se backend mandou expense_by_category)
        let topCat = null;
        const ebc = r.expense_by_category && typeof r.expense_by_category === "object" ? r.expense_by_category : null;
        if (ebc) {
          const entries = Object.entries(ebc).map(([k, v]) => [k, asNumber(v)]);
          entries.sort((a, b) => b[1] - a[1]);
          if (entries.length && entries[0][1] > 0) topCat = { name: String(entries[0][0]), value: entries[0][1] };
        }

        return `
          <div class="p-4 flex items-center justify-between hover:bg-slate-50 transition-colors">
            <div>
              <div class="text-sm font-bold text-slate-800">${safeText(r.label)}</div>
              <div class="text-xs text-slate-500 mt-1">
                Receita: <b>${toMoney(inc)}</b>${incHasRange ? ` <span class="opacity-70">(≈ ${toMoney(r.income_low)}–${toMoney(r.income_high)})</span>` : ""}
                • Despesa: <b>${toMoney(exp)}</b>${expHasRange ? ` <span class="opacity-70">(≈ ${toMoney(r.expense_low)}–${toMoney(r.expense_high)})</span>` : ""}
                ${topCat ? ` • Provável: <span class="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 font-semibold">${safeText(topCat.name)}</span>` : ""}
              </div>
            </div>
            <div class="text-right">
              <div class="text-sm font-bold ${net < 0 ? "text-rose-600" : "text-emerald-600"}">
                ${net < 0 ? "-" : "+"} ${toMoney(Math.abs(net))}
              </div>
            </div>
          </div>
        `;
      }).join("");
    }
  }
}

async function runPredictions() {
  try {
    setPredLoading(true);

    const horizon = Number(document.getElementById("pred-horizon")?.value || 7);
    const scope = String(document.getElementById("pred-scope")?.value || "all");
    const accId = scope === "account" ? Number(document.getElementById("pred-account")?.value || 0) : null;

    const qs = new URLSearchParams();
    qs.set("days", String(horizon));
    if (accId) qs.set("account_id", String(accId));

    // treino pode demorar (scikit-learn)
    const payload = await api(`/forecast/daily?${qs.toString()}`, { method: "GET", timeoutMs: 120000 });

    state.predictions.lastPayload = payload;
    state.predictions.lastRunAt = new Date();

    const norm = normalizeForecastDaily(payload);
    const dt = new Date().toLocaleString("pt-BR");
    const incomeAlgo = safeText(norm?.meta?.income_algo || "—");
    const expenseAlgo = safeText(norm?.meta?.expense_algo || "—");
    const basis = safeText(norm?.meta?.basis || norm.basis || "—");

    setPredMeta(`Modelo: ${basis} | income=${incomeAlgo} • expense=${expenseAlgo} | Última execução: ${dt}`);

    renderPredictionsUI(payload);
    renderPredictionsCharts(payload);

    showToast("Predições", "Previsão gerada com sucesso.");
  } catch (e) {
    console.error(e);
    showToast("Predições (erro)", e.message || String(e), 7000);
    setPredMeta(`Modelo: — | Última execução: erro`);

    // limpa charts
    destroyChart(state.charts.predFlow);
    destroyChart(state.charts.predCats);
    state.charts.predFlow = null;
    state.charts.predCats = null;

    // UI fallback
    const elBal = document.getElementById("pred-balance");
    const elInc = document.getElementById("pred-income");
    const elExp = document.getElementById("pred-expense");
    const elRisk = document.getElementById("pred-risk");
    const elCount = document.getElementById("pred-count");
    const elNote = document.getElementById("pred-balance-note");
    if (elBal) elBal.innerText = "—";
    if (elInc) elInc.innerText = "—";
    if (elExp) elExp.innerText = "—";
    if (elRisk) elRisk.innerText = "Indisponível";
    if (elCount) elCount.innerText = "0 itens";
    if (elNote) elNote.innerText = "erro ao gerar predição";

    const alertsBox = document.getElementById("pred-alerts");
    if (alertsBox) {
      alertsBox.innerHTML = `
        <div class="p-3 rounded-xl border bg-rose-50 border-rose-200 text-rose-900 flex gap-3 items-start">
          <i class="fas fa-triangle-exclamation mt-0.5"></i>
          <div>
            <div class="font-bold text-sm">Predição não gerada</div>
            <div class="text-xs opacity-80">${safeText(e.message || String(e))}</div>
          </div>
        </div>
      `;
    }

    const list = document.getElementById("pred-list");
    if (list) list.innerHTML = `<div class="p-6 text-sm text-slate-400">Sem dados previstos.</div>`;
  } finally {
    setPredLoading(false);
  }
}
window.forecastLoadUI = runPredictions;


/* ==========================================================
   CRUD: Accounts / Categories / Transactions
   ========================================================== */
async function deleteAccount(id) {
  if (!confirm("Excluir esta conta?")) return;
  await api(`/accounts/${id}`, { method: "DELETE" });
  await refreshAll();
}
window.deleteAccount = deleteAccount;

async function deleteCategory(id) {
  if (!confirm("Excluir esta categoria?")) return;
  await api(`/categories/${id}`, { method: "DELETE" });
  await refreshAll();
}
window.deleteCategory = deleteCategory;

async function deleteTransaction(id) {
  if (!confirm("Excluir esta transação?")) return;
  await api(`/transactions/${id}`, { method: "DELETE" });
  await refreshAll();
}
window.deleteTransaction = deleteTransaction;

window.handleSaveAccount = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await api("/accounts", {
    method: "POST",
    body: JSON.stringify({
      name: String(fd.get("accName") || "").trim(),
      bank: String(fd.get("accBank") || "").trim(),
      type: String(fd.get("accType") || "").trim(),
    }),
  });
  window.toggleModal("modal-account");
  e.target.reset();
  await refreshAll();
};

window.handleSaveCategory = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await api("/categories", {
    method: "POST",
    body: JSON.stringify({ name: String(fd.get("catName") || "").trim() }),
  });
  window.toggleModal("modal-category");
  e.target.reset();
  await refreshAll();
};

/* ==========================================================
   CRUD: Cartões
   ========================================================== */
async function deleteCard(id) {
  if (!confirm("Excluir este cartão e suas compras?")) return;
  await api(`/cards/${id}`, { method: "DELETE" });
  if (Number(state.selectedCardId) === Number(id)) state.selectedCardId = null;
  await window.loadCardsAndRender?.();
  await loadCombinedForCurrentMonth();
  renderAll();
  await reloadCharts();
}
window.deleteCard = deleteCard;

window.handleSaveCard = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);

  const payload = {
    name: String(fd.get("cardName") || "").trim(),
    bank: String(fd.get("cardBank") || "").trim(),
    closing_day: Number(fd.get("closingDay")),
    due_day: Number(fd.get("dueDay")),
    credit_limit: Number(fd.get("creditLimit") || 0),
  };

  await api("/cards", { method: "POST", body: JSON.stringify(payload) });

  window.toggleModal("modal-card");
  e.target.reset();
  await window.loadCardsAndRender?.();
};

window.handleSaveCardPurchase = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);

  const payload = {
    card_id: Number(fd.get("cardId")),
    amount: Number(fd.get("amount")),
    description: String(fd.get("description") || "").trim(),
    category: String(fd.get("category") || "Geral").trim(),
    purchase_date: String(fd.get("purchaseDate") || "").trim(),
  };

  await api("/cards/purchases", { method: "POST", body: JSON.stringify(payload) });

  window.toggleModal("modal-card-purchase");
  e.target.reset();
  const pd = document.getElementById("purchase-date");
  if (pd) pd.valueAsDate = new Date();

  await window.loadInvoice?.();
  await loadCombinedForCurrentMonth();
  renderAll();
  await reloadCharts();
};

window.handlePayInvoice = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);

  const payload = {
    card_id: Number(fd.get("cardId")),
    invoice_ym: String(fd.get("invoiceYm") || "").trim(),
    pay_date: String(fd.get("payDate") || "").trim(),
    account_id: Number(fd.get("accountId")),
  };

  const res = await api("/cards/pay-invoice", { method: "POST", body: JSON.stringify(payload) });
  window.toggleModal("modal-pay-invoice");

  await window.loadInvoice?.();
  await Promise.all([loadTransactionsForCurrentMonth(), loadCombinedForCurrentMonth()]);
  renderAll();
  await reloadCharts();

  if (res && res.paid_total) alert(`Fatura paga: ${toMoney(res.paid_total)}`);
  else alert("Operação concluída.");
};

/* ==========================================================
   FATURA
   ========================================================== */
window.selectCard = async (id) => {
  state.selectedCardId = Number(id);
  renderCreditCardsList();
  await window.loadInvoice?.();
};

window.loadCardsAndRender = async () => {
  await loadCards();
  renderCreditCardsList();
  hydrateCreditSelects();
  await window.loadInvoice?.();
};

window.loadInvoice = async () => {
  const invInput = document.getElementById("invoice-ym");
  const invoiceYm = invInput ? invInput.value : null;

  const invItems = document.getElementById("invoice-items");
  if (!state.selectedCardId || !invoiceYm) {
    if (invItems) invItems.innerHTML =
      `<div class="p-6 text-sm text-slate-400">Selecione um cartão e a competência.</div>`;
    return;
  }

  const payYm = document.getElementById("pay-invoice-ym");
  if (payYm) payYm.value = invoiceYm;

  try {
    const sum = await api(`/cards/${state.selectedCardId}/invoice-summary?invoice_ym=${encodeURIComponent(invoiceYm)}`);

    const invTotal = document.getElementById("inv-total");
    const invPending = document.getElementById("inv-pending");
    const invPaid = document.getElementById("inv-paid");
    const invCount = document.getElementById("inv-count");
    const invBadge = document.getElementById("inv-items-badge");

    if (invTotal) invTotal.innerText = toMoney(sum.total);
    if (invPending) invPending.innerText = toMoney(sum.pending_total);
    if (invPaid) invPaid.innerText = toMoney(sum.paid_total);
    if (invCount) invCount.innerText = String(sum.count);
    if (invBadge) invBadge.innerText = `${sum.count} itens`;

    const purchases = await api(`/cards/${state.selectedCardId}/purchases?invoice_ym=${encodeURIComponent(invoiceYm)}&limit=2000`);
    renderInvoiceItems(purchases);
    renderCardCategoryChart(purchases);
  } catch (e) {
    console.error(e);
    showToast("Erro", e.message || String(e));
  }
};

function renderInvoiceItems(items) {
  const cont = document.getElementById("invoice-items");
  if (!cont) return;

  if (!items || items.length === 0) {
    cont.innerHTML = `<div class="p-6 text-sm text-slate-400">Nenhuma compra nesta fatura.</div>`;
    return;
  }

  const sorted = [...items].sort(
    (a,b) => (b.purchase_date || "").localeCompare(a.purchase_date || "") || (b.id - a.id)
  );

  cont.innerHTML = sorted.map(i => {
    const isPaid = i.status === "paid";
    return `
      <div class="p-4 flex items-center justify-between hover:bg-slate-50 transition-colors group">
        <div class="flex items-center gap-4">
          <div class="w-10 h-10 rounded-xl ${isPaid ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"} flex items-center justify-center text-lg">
            <i class="fas ${isPaid ? "fa-check" : "fa-clock"}"></i>
          </div>
          <div>
            <p class="font-bold text-slate-800 text-sm">${safeText(i.description)}</p>
            <div class="flex items-center gap-2 text-xs text-slate-400 mt-1">
              <span>${new Date(i.purchase_date + "T00:00:00").toLocaleDateString("pt-BR")}</span>
              <span class="w-1 h-1 rounded-full bg-slate-300"></span>
              <span class="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-medium">${safeText(i.category)}</span>
              <span class="w-1 h-1 rounded-full bg-slate-300"></span>
              <span class="px-1.5 py-0.5 rounded ${isPaid ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"} font-bold">
                ${isPaid ? "PAGO" : "PENDENTE"}
              </span>
            </div>
          </div>
        </div>

        <div class="text-right">
          <p class="font-bold text-sm text-slate-900">${toMoney(i.amount)}</p>
          <button onclick="deleteCardPurchase(${i.id})"
            class="text-xs text-red-500 opacity-0 group-hover:opacity-100 hover:underline mt-1">
            Excluir
          </button>
        </div>
      </div>
    `;
  }).join("");
}

async function deleteCardPurchase(id) {
  if (!confirm("Excluir esta compra do cartão?")) return;
  await api(`/cards/purchases/${id}`, { method: "DELETE" });
  await window.loadInvoice?.();
  await loadCombinedForCurrentMonth();
  renderAll();
  await reloadCharts();
}
window.deleteCardPurchase = deleteCardPurchase;

/* ==========================================================
   RELATÓRIOS
   ========================================================== */
function ymNow() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function parseYm(ym) {
  const [y, m] = String(ym || "").split("-");
  const year = Number(y);
  const month = Number(m);
  if (!year || !month || month < 1 || month > 12) return null;
  return { year, month };
}

function monthNamePt(month1to12) {
  const months = [
    "Janeiro","Fevereiro","Março","Abril","Maio","Junho",
    "Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"
  ];
  return months[month1to12 - 1] || `Mês ${month1to12}`;
}

function mdMoney(v) { return toMoney(Number(v || 0)); }

function aggregateMonthlyFromReport(report, year, month) {
  const tx = Array.isArray(report?.transactions) ? report.transactions : [];
  const cp = Array.isArray(report?.card_purchases) ? report.card_purchases : [];

  const payCat = state.cardPaymentCategory;
  let income = 0, expenseCash = 0, expenseCard = 0;

  const byCat = {};
  const byDay = {};

  tx.forEach(t => {
    const amt = Number(t.amount || 0);
    const isInc = t.type === "income";
    const isExp = t.type === "expense";
    const day = t.date;

    if (!byDay[day]) byDay[day] = { income: 0, expense: 0 };
    if (isInc) { income += amt; byDay[day].income += amt; }

    if (isExp && String(t.category || "") !== String(payCat)) {
      expenseCash += amt;
      byDay[day].expense += amt;
      const cat = t.category || "Geral";
      byCat[cat] = (byCat[cat] || 0) + amt;
    }
  });

  cp.forEach(p => {
    const amt = Number(p.amount || 0);
    expenseCard += amt;
    const cat = p.category || "Geral";
    byCat[cat] = (byCat[cat] || 0) + amt;

    const day = p.purchase_date;
    if (!byDay[day]) byDay[day] = { income: 0, expense: 0 };
    byDay[day].expense += amt;
  });

  const expenseTotal = expenseCash + expenseCard;
  const balance = income - expenseTotal;

  const topCats = Object.entries(byCat)
    .sort((a,b) => b[1] - a[1])
    .slice(0, 10)
    .map(([category, total]) => ({ category, total }));

  const daily = Object.entries(byDay)
    .sort((a,b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, income: v.income, expense: v.expense, net: v.income - v.expense }));

  return { year, month, income, expenseCash, expenseCard, expense: expenseTotal, balance, topCats, daily, txCount: tx.length + cp.length };
}

function generateReportMarkdown(data) {
  const dtGen = new Date().toLocaleString("pt-BR");
  const title = `Relatório Financeiro (Competência) — ${monthNamePt(data.month)} ${data.year}`;

  const lines = [];
  lines.push(`# ${title}`, ``);
  lines.push(`**Gerado em:** ${dtGen}`, ``);

  lines.push(`## 1. Sumário Executivo`);
  lines.push(`- **Receitas (Caixa):** ${mdMoney(data.income)}`);
  lines.push(`- **Despesas (Caixa, sem pagamento de fatura):** ${mdMoney(data.expenseCash)}`);
  lines.push(`- **Despesas (Cartão na competência):** ${mdMoney(data.expenseCard)}`);
  lines.push(`- **Despesas totais (Competência):** ${mdMoney(data.expense)}`);
  lines.push(`- **Saldo do período:** ${mdMoney(data.balance)}`);
  lines.push(`- **Lançamentos:** ${data.txCount}`, ``);

  lines.push(`## 2. Principais Categorias de Despesa (Competência)`);
  if (!data.topCats.length) lines.push(`Nenhuma despesa registrada.`);
  else data.topCats.forEach((c,i) => lines.push(`${i+1}. **${safeText(c.category)}** — ${mdMoney(c.total)}`));
  lines.push(``);

  lines.push(`## 3. Série Diária`);
  if (!data.daily.length) lines.push(`Sem movimentos.`);
  else {
    lines.push(`| Data | Receitas | Despesas | Saldo do dia |`);
    lines.push(`|---|---:|---:|---:|`);
    data.daily.forEach(d => {
      const dt = new Date(d.date + "T00:00:00").toLocaleDateString("pt-BR");
      lines.push(`| ${dt} | ${mdMoney(d.income)} | ${mdMoney(d.expense)} | ${mdMoney(d.net)} |`);
    });
  }
  lines.push(``);

  lines.push(`## 4. Observações`);
  lines.push(`- Cartão entra por competência (invoice_ym).`);
  lines.push(`- Pagamento de fatura afeta o caixa, mas não é despesa “real”.`);
  lines.push(``);

  return lines.join("\n");
}

function reportToHtml(md) {
  const body = (typeof marked === "undefined")
    ? `<pre style="white-space:pre-wrap">${safeText(md || "")}</pre>`
    : sanitizeHtml(marked.parse(md || ""));

  return `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Relatório</title>
<style>
  body{font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 28px; color:#0f172a;}
  h1,h2,h3{margin: 0.6em 0 0.4em;}
  table{border-collapse: collapse; width: 100%; margin: 12px 0;}
  th,td{border:1px solid #e2e8f0; padding:8px; font-size: 12px;}
  th{background:#f8fafc; text-align:left;}
  code{background:#f1f5f9; padding:2px 4px; border-radius:6px;}
  @media print { body{margin: 14mm;} }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function updateReportKpis(data) {
  const elB = document.getElementById("rep-balance");
  const elI = document.getElementById("rep-income");
  const elE = document.getElementById("rep-expense");
  const elC = document.getElementById("rep-count");
  if (elB) elB.innerText = mdMoney(data.balance);
  if (elI) elI.innerText = mdMoney(data.income);
  if (elE) elE.innerText = mdMoney(data.expense);
  if (elC) elC.innerText = String(data.txCount);
}

function downloadBlob(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

window.generateAndRenderReport = async () => {
  const ymInput = document.getElementById("report-ym");
  if (ymInput && !ymInput.value) ymInput.value = ymNow();

  const parsed = parseYm(ymInput ? ymInput.value : ymNow());
  if (!parsed) { showToast("Relatórios", "Competência inválida."); return; }

  const report = await api(`/reports/monthly?year=${parsed.year}&month=${parsed.month}`);
  const data = aggregateMonthlyFromReport(report, parsed.year, parsed.month);
  const md = generateReportMarkdown(data);
  const html = reportToHtml(md);

  state.reports.lastMd = md;
  state.reports.lastHtml = html;

  updateReportKpis(data);

  const badge = document.getElementById("rep-badge");
  if (badge) badge.innerText = `${monthNamePt(parsed.month)} ${parsed.year}`;

  const prev = document.getElementById("report-preview");
  if (!prev) return;

  prev.innerHTML = (typeof marked === "undefined")
    ? `<pre class="whitespace-pre-wrap">${safeText(md)}</pre>`
    : sanitizeHtml(marked.parse(md));
};

window.downloadReport = async (fmt) => {
  if (!state.reports.lastMd) await window.generateAndRenderReport();

  const ymInput = document.getElementById("report-ym");
  const ym = (ymInput && ymInput.value) ? ymInput.value : ymNow();

  if (fmt === "md") return downloadBlob(`relatorio_${ym}.md`, state.reports.lastMd, "text/markdown;charset=utf-8");
  if (fmt === "html") return downloadBlob(`relatorio_${ym}.html`, state.reports.lastHtml, "text/html;charset=utf-8");
  showToast("Relatórios", "Formato não suportado.");
};

window.printReport = async () => {
  if (!state.reports.lastHtml) await window.generateAndRenderReport();

  const w = window.open("", "_blank");
  if (!w) { showToast("Relatórios", "Pop-up bloqueado."); return; }
  w.document.open();
  w.document.write(state.reports.lastHtml);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 350);
};

/* ==========================================================
   UX: ESC fecha modais
   ========================================================== */
function closeIfOpen(id) {
  const el = document.getElementById(id);
  if (el && !el.classList.contains("hidden")) el.classList.add("hidden");
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  closeIfOpen("ai-modal");
  ["modal-account","modal-category","modal-card","modal-card-purchase","modal-pay-invoice"].forEach(closeIfOpen);
});

/* ==========================================================
   Init
   ========================================================== */
document.addEventListener("DOMContentLoaded", () => {
  // datas default
  const txDate = document.getElementById("tx-date");
  if (txDate) txDate.valueAsDate = new Date();

  const pd = document.getElementById("purchase-date");
  if (pd) pd.valueAsDate = new Date();

  // Aba cartão: mudança de competência recarrega fatura
  const invYm = document.getElementById("invoice-ym");
  if (invYm) invYm.addEventListener("change", () => window.loadInvoice());

  // Aba relatórios: mudança recarrega preview
  const repYm = document.getElementById("report-ym");
  if (repYm) repYm.addEventListener("change", () => window.generateAndRenderReport());

  // Aba predições: alterna conta específica
  const scope = document.getElementById("pred-scope");
  if (scope) {
    scope.addEventListener("change", () => {
      const accSel = document.getElementById("pred-account");
      if (accSel) accSel.classList.toggle("hidden", scope.value !== "account");
    });
  }

  // transação (novo lançamento)
  const txForm = document.getElementById("transaction-form");
  if (txForm) {
    txForm.onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type="submit"]');
      const prevHtml = btn ? btn.innerHTML : "";
      if (btn) { btn.innerHTML = "Salvando..."; setDisabled(btn, true); }

      const payload = {
        type: document.getElementById("tx-type")?.value || "expense",
        amount: parseFloat(document.getElementById("tx-amount")?.value || "0"),
        description: document.getElementById("tx-desc")?.value || "",
        date: document.getElementById("tx-date")?.value || "",
        account_id: Number(document.getElementById("tx-account")?.value || 0),
        category: document.getElementById("tx-category")?.value || "Geral",
      };

      try {
        await api("/transactions", { method: "POST", body: JSON.stringify(payload) });
        e.target.reset();
        const txDateEl = document.getElementById("tx-date");
        if (txDateEl) txDateEl.valueAsDate = new Date();

        await Promise.all([loadTransactionsForCurrentMonth(), loadCombinedForCurrentMonth()]);
        renderAll();
        await reloadCharts();
      } catch (err) {
        console.error(err);
        showToast("Erro", err.message || String(err));
      } finally {
        if (btn) { btn.innerHTML = prevHtml || '<i class="fas fa-save"></i> Salvar Lançamento'; setDisabled(btn, false); }
      }
    };
  }

  // CHAT
  const chatForm = document.getElementById("chat-form");
  if (chatForm) {
    chatForm.onsubmit = async (e) => {
      e.preventDefault();
      const input = document.getElementById("chat-input");
      const q = (input && input.value ? input.value.trim() : "");
      if (!q || state.isAiProcessing) return;

      const msgs = document.getElementById("chat-messages");
      if (!msgs) return;

      msgs.innerHTML += `
        <div class="flex gap-3 flex-row-reverse">
          <div class="chat-bubble-user p-3 px-4 shadow-sm text-sm max-w-[85%]">${safeText(q)}</div>
        </div>`;
      input.value = "";
      msgs.scrollTop = msgs.scrollHeight;
      state.isAiProcessing = true;

      const loadingId = "load-" + Date.now();
      msgs.innerHTML += `
        <div id="${loadingId}" class="flex gap-3">
          <div class="chat-bubble-ai p-3 shadow-sm text-sm text-slate-500">
            <i class="fas fa-circle-notch animate-spin mr-2"></i>Analisando...
          </div>
        </div>`;
      msgs.scrollTop = msgs.scrollHeight;

      try {
        const { year, month } = monthLabel(state.currentDate);

        const context = {
          monthRef: document.getElementById("current-month-display")?.innerText || "",
          basis: "competencia",
          summary_combined: state.summaryCombined,
          accounts: state.accounts,
          categories: state.categories,
          cash_transactions: state.transactions.slice(0, 120),
          combined_transactions: state.combinedTransactions.slice(0, 160),
          credit_cards: state.cards,
          selected_card_id: state.selectedCardId,
          card_payment_category: state.cardPaymentCategory,
          ym: `${year}-${String(month + 1).padStart(2, "0")}`,
        };

        const data = await api("/ai", {
          method: "POST",
          body: JSON.stringify({ question: q, context }),
        });

        const answer = (data && data.answer_md) ? data.answer_md : "Sem resposta do servidor.";
        const node = document.getElementById(loadingId);
        if (node) node.remove();

        if (typeof marked === "undefined") {
          msgs.innerHTML += `
            <div class="flex gap-3">
              <div class="chat-bubble-ai p-4 shadow-sm text-sm text-slate-700 max-w-[90%]">
                <pre class="whitespace-pre-wrap">${safeText(answer)}</pre>
              </div>
            </div>`;
        } else {
          const rendered = sanitizeHtml(marked.parse(answer));
          msgs.innerHTML += `
            <div class="flex gap-3">
              <div class="chat-bubble-ai p-4 shadow-sm text-sm text-slate-700 max-w-[90%]">
                <div class="prose prose-sm max-w-none">${rendered}</div>
              </div>
            </div>`;
        }
      } catch (err) {
        console.error(err);
        const node = document.getElementById(loadingId);
        if (node) node.innerHTML = `<span class="text-red-600 font-semibold">Erro: ${safeText(err.message || err)}</span>`;
      } finally {
        state.isAiProcessing = false;
        msgs.scrollTop = msgs.scrollHeight;
      }
    };
  }

  // Inicialização visual
  setActiveNav("dashboard");

  // Aplica estado inicial dos botões (receita/despesa)
  window.setTxType(document.getElementById("tx-type")?.value || "expense");

  // Se abrir via file://, avisa.
  if (location.protocol === "file:") {
    showToast("Atenção", "Você está abrindo via file://. Rode um servidor local (python -m http.server) para evitar CORS.", 8000);
  }

  refreshAll();
  console.log("[FinanceAI] API_BASE =", API_BASE);
});
