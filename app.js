// ==========================================================
// CONFIG
// ==========================================================
// Permite configurar via localStorage:
// localStorage.setItem("FINANCEAI_API_BASE","http://localhost:8000");
const API_BASE =
  (localStorage.getItem("FINANCEAI_API_BASE") || "").trim() ||
  "http://localhost:8000";

// ==========================================================
// ESTADO LOCAL (frontend)
// ==========================================================
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
  },

  // Relatórios
  reports: {
    lastMd: "",
    lastHtml: "",
  },
};

// ==========================================================
// TOAST
// ==========================================================
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

// ==========================================================
// HELPERS (datas, texto seguro, dinheiro)
// ==========================================================
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

// Sanitização simples (não substitui DOMPurify, mas corta o básico de XSS)
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

// ==========================================================
// API (fetch com timeout + erros uniformes)
// ==========================================================
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
    throw new Error(isAbort
      ? "Timeout ao acessar o backend. Verifique o servidor/API_BASE."
      : "Falha de rede/CORS ao acessar o backend. Verifique API_BASE e o servidor."
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!resp.ok) {
    let detail = "";
    try {
      const j = await resp.json();
      detail = j.detail || JSON.stringify(j);
    } catch {
      try { detail = await resp.text(); } catch { detail = ""; }
    }
    throw new Error(detail || `Erro HTTP ${resp.status}`);
  }

  // Robusto: se não for JSON, devolve texto
  const text = await resp.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ==========================================================
// LOADERS
// ==========================================================
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

async function loadTransactionsForCurrentMonth() {
  const { year, month } = monthLabel(state.currentDate);
  // CAIXA (transactions) inclui pagamentos (impactam saldo da conta)
  state.transactions = await api(`/transactions?year=${year}&month=${month + 1}&limit=2000`);
}

async function loadCombinedForCurrentMonth() {
  const { year, month } = monthLabel(state.currentDate);
  // COMPETÊNCIA: cash + card_purchases (cartão entra pelo invoice_ym; sem dupla contagem)
  state.combinedTransactions = await api(`/transactions/combined?year=${year}&month=${month + 1}&limit=5000`);
  state.summaryCombined = await api(`/summary/combined?year=${year}&month=${month + 1}`);
}

async function loadCards() {
  state.cards = await api("/cards");
  if (!state.selectedCardId && state.cards.length > 0) {
    state.selectedCardId = state.cards[0].id;
  }
}

async function refreshAll() {
  try {
    await loadHealth();
    await Promise.all([loadAccounts(), loadCategories(), loadCards()]);
    await Promise.all([loadTransactionsForCurrentMonth(), loadCombinedForCurrentMonth()]);

    renderAll();
    await reloadCharts();
    await renderCreditControls();

    // Se estiver em "reports", renderiza o relatório automaticamente (server-side)
    const reportsView = document.getElementById("view-reports");
    if (reportsView && !reportsView.classList.contains("hidden")) {
      await generateAndRenderReport();
    }
  } catch (e) {
    console.error(e);
    showToast("Erro", e.message || String(e));
  }
}

// ==========================================================
// RENDERERS
// ==========================================================
function renderAll() {
  renderAccounts();
  renderCategories();
  renderDashboard();
  renderCreditCardsList();
  hydrateCreditSelects();
}

function renderAccounts() {
  // Select in Form
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

  // Pay invoice account select
  const payAcc = document.getElementById("pay-account");
  if (payAcc) {
    payAcc.innerHTML = state.accounts.length
      ? state.accounts.map(a => `<option value="${a.id}">${safeText(a.name)} (${safeText(a.bank)})</option>`).join("")
      : `<option value="">Sem contas</option>`;
  }

  // Settings List
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

  // Dashboard Cards (saldo por conta) — CAIXA (inclui pagamento de fatura)
  const cardsContainer = document.getElementById("accounts-cards-container");
  if (!cardsContainer) return;

  const accBalances = {};
  state.accounts.forEach(a => (accBalances[a.id] = 0));

  state.transactions.forEach(tx => {
    if (accBalances[tx.account_id] !== undefined) {
      accBalances[tx.account_id] += (tx.type === "income" ? tx.amount : -tx.amount);
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
    if (state.categories.length > 0) {
      select.innerHTML = state.categories
        .map(cat => `<option value="${safeText(cat.name)}">${safeText(cat.name)}</option>`)
        .join("");
    } else {
      select.innerHTML = `<option value="Geral">Geral</option>`;
    }
  }

  // Purchase category
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

  // KPIs por competência (sem dupla contagem do cartão)
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

  // Extrato do mês por competência: cash + card
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

  list.innerHTML = sorted
    .map(t => {
      const source = t.source || "cash"; // 'cash'|'card'
      const isCard = source === "card";

      // Para card_purchase, tratar como despesa
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
    })
    .join("");
}

// ===== Credit card render =====
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
      <button onclick="selectCard(${c.id})"
        class="w-full text-left p-4 rounded-2xl border ${active ? "border-blue-200 bg-blue-50" : "border-slate-200 bg-white hover:bg-slate-50"} transition-colors">
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
      </button>
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

  // Sempre sincroniza o campo do modal de pagamento com a competência selecionada
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

// ==========================================================
// CHARTS (competência; sem dupla contagem)
// ==========================================================
function destroyChart(inst) {
  if (inst && typeof inst.destroy === "function") inst.destroy();
}

async function reloadCharts() {
  await Promise.all([renderTimeseriesChart(), renderCategoriesChart()]);
}

async function renderTimeseriesChart() {
  const el = document.getElementById("chart-timeseries");
  if (!el) return;

  const { year, month } = monthLabel(state.currentDate);

  // 1) income diário vem do cash timeseries (já exclui pagamento de fatura por padrão no backend)
  // 2) expense_total diário vem do combined timeseries (cash expenses + card purchases por competência)
  const [cash, comb] = await Promise.all([
    api(`/charts/timeseries?year=${year}&month=${month+1}`),
    api(`/charts/combined/timeseries?year=${year}&month=${month+1}`),
  ]);

  const map = new Map(); // date -> {income, expense_total}
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

  const { year, month } = monthLabel(state.currentDate);

  // Categorias por competência: cash expenses (sem pagamento) + card purchases
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

// ==========================================================
// UI Actions / Nav (Desktop + Mobile)
// ==========================================================
function setActiveNav(view) {
  const ids = ["dashboard", "credit", "settings", "reports"];

  // Desktop nav
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

  // Mobile nav
  ids.forEach(id => {
    const m = document.getElementById(`mnav-${id}`);
    if (!m) return;
    m.className = "flex flex-col items-center p-2 text-slate-400 hover:text-blue-600";
  });

  const mactive = document.getElementById(`mnav-${view}`);
  if (mactive) mactive.className = "flex flex-col items-center p-2 text-blue-600";
}

window.switchView = async (v) => {
  ["dashboard","credit","settings","reports"].forEach(id => {
    const el = document.getElementById(`view-${id}`);
    if (el) el.classList.add("hidden");
  });

  const target = document.getElementById(`view-${v}`);
  if (target) target.classList.remove("hidden");

  setActiveNav(v);

  try {
    if (v === "dashboard") await reloadCharts();
    if (v === "credit") await loadCardsAndRender();
    if (v === "reports") await generateAndRenderReport();
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

window.setTxType = (type) => {
  document.getElementById("tx-type").value = type;
  const btnE = document.getElementById("btn-expense");
  const btnI = document.getElementById("btn-income");

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

    // Atualiza relatório se estiver aberto
    const reportsView = document.getElementById("view-reports");
    if (reportsView && !reportsView.classList.contains("hidden")) {
      await generateAndRenderReport();
    }
  } catch (e) {
    console.error(e);
    showToast("Erro", e.message || String(e));
  }
};

// Credit events
window.selectCard = async (id) => {
  state.selectedCardId = Number(id);
  renderCreditCardsList();
  await loadInvoice();
};

window.loadCardsAndRender = async () => {
  await loadCards();
  renderCreditCardsList();
  hydrateCreditSelects();
  await loadInvoice();
};

// ==========================================================
// CRUD: Accounts / Categories / Transactions
// ==========================================================
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

const txForm = document.getElementById("transaction-form");
if (txForm) {
  txForm.onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const prevHtml = btn ? btn.innerHTML : "";
    if (btn) { btn.innerHTML = "Salvando..."; setDisabled(btn, true); }

    const payload = {
      type: document.getElementById("tx-type").value,
      amount: parseFloat(document.getElementById("tx-amount").value),
      description: document.getElementById("tx-desc").value,
      date: document.getElementById("tx-date").value,
      account_id: Number(document.getElementById("tx-account").value),
      category: document.getElementById("tx-category").value,
    };

    try {
      await api("/transactions", { method: "POST", body: JSON.stringify(payload) });
      e.target.reset();
      document.getElementById("tx-date").valueAsDate = new Date();

      await Promise.all([loadTransactionsForCurrentMonth(), loadCombinedForCurrentMonth()]);
      renderAll();
      await reloadCharts();

      // Se relatório aberto, atualiza
      const reportsView = document.getElementById("view-reports");
      if (reportsView && !reportsView.classList.contains("hidden")) {
        await generateAndRenderReport();
      }
    } catch (e) {
      console.error(e);
      showToast("Erro", e.message || String(e));
    } finally {
      if (btn) { btn.innerHTML = prevHtml || '<i class="fas fa-save"></i> Salvar Lançamento'; setDisabled(btn, false); }
    }
  };
}

// ==========================================================
// CRUD: Cartões
// ==========================================================
async function deleteCard(id) {
  if (!confirm("Excluir este cartão e suas compras?")) return;
  await api(`/cards/${id}`, { method: "DELETE" });
  if (Number(state.selectedCardId) === Number(id)) state.selectedCardId = null;
  await loadCardsAndRender();
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
  await loadCardsAndRender();
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

  await loadInvoice();
  await loadCombinedForCurrentMonth();
  renderAll();
  await reloadCharts();

  const reportsView = document.getElementById("view-reports");
  if (reportsView && !reportsView.classList.contains("hidden")) {
    await generateAndRenderReport();
  }
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

  await loadInvoice();
  await Promise.all([loadTransactionsForCurrentMonth(), loadCombinedForCurrentMonth()]);
  renderAll();
  await reloadCharts();

  const reportsView = document.getElementById("view-reports");
  if (reportsView && !reportsView.classList.contains("hidden")) {
    await generateAndRenderReport();
  }

  if (res && res.paid_total) alert(`Fatura paga: ${toMoney(res.paid_total)}`);
  else alert("Operação concluída.");
};

// ==========================================================
// FATURA (load)
// ==========================================================
window.loadInvoice = async () => {
  const invInput = document.getElementById("invoice-ym");
  const invoiceYm = invInput ? invInput.value : null;

  const invItems = document.getElementById("invoice-items");
  if (!state.selectedCardId || !invoiceYm) {
    if (invItems) invItems.innerHTML =
      `<div class="p-6 text-sm text-slate-400">Selecione um cartão e a competência.</div>`;
    return;
  }

  // Sempre sincroniza também modal de pagamento
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
  await loadInvoice();
  await loadCombinedForCurrentMonth();
  renderAll();
  await reloadCharts();
}
window.deleteCardPurchase = deleteCardPurchase;

// ==========================================================
// CHAT: /ai (Groq via backend)
// ==========================================================
const chatForm = document.getElementById("chat-form");
if (chatForm) {
  chatForm.onsubmit = async (e) => {
    e.preventDefault();
    const input = document.getElementById("chat-input");
    const q = input.value.trim();
    if (!q || state.isAiProcessing) return;

    const msgs = document.getElementById("chat-messages");
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

      const rendered = sanitizeHtml(marked.parse(answer));
      msgs.innerHTML += `
        <div class="flex gap-3">
          <div class="chat-bubble-ai p-4 shadow-sm text-sm text-slate-700 max-w-[90%]">
            <div class="prose prose-sm max-w-none">${rendered}</div>
          </div>
        </div>`;
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

// ==========================================================
// RELATÓRIOS (server-side: /reports/monthly)
// ==========================================================
function ymNow() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function parseYm(ym) {
  const [y, m] = String(ym || "").split("-");
  const year = Number(y);
  const month = Number(m); // 1..12
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

function mdMoney(v) {
  return toMoney(Number(v || 0));
}

function aggregateMonthlyFromReport(report, year, month) {
  const tx = Array.isArray(report?.transactions) ? report.transactions : [];
  const cp = Array.isArray(report?.card_purchases) ? report.card_purchases : [];

  // despesas de caixa “reais”: exclui pagamento de fatura
  const payCat = state.cardPaymentCategory;

  let income = 0;
  let expenseCash = 0;
  let expenseCard = 0;

  const byCat = {};      // despesas por categoria (cash real + card purchases)
  const byAccount = {};  // delta por conta (CAIXA, inclui pagamento e receitas)
  const byDay = {};      // YYYY-MM-DD => {income, expense_total}

  tx.forEach(t => {
    const amt = Number(t.amount || 0);
    const isInc = t.type === "income";
    const isExp = t.type === "expense";

    if (isInc) income += amt;

    // conta: sempre reflete caixa (inclui pagamentos)
    const accId = Number(t.account_id);
    byAccount[accId] = (byAccount[accId] || 0) + (isInc ? amt : -amt);

    const day = t.date;
    if (!byDay[day]) byDay[day] = { income: 0, expense: 0 };
    if (isInc) byDay[day].income += amt;

    // despesas “reais” (excluir pagamento)
    if (isExp && String(t.category || "") !== String(payCat)) {
      expenseCash += amt;
      const cat = t.category || "Geral";
      byCat[cat] = (byCat[cat] || 0) + amt;
      byDay[day].expense += amt;
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

  const accountRows = (state.accounts || []).map(a => ({
    id: a.id,
    name: a.name,
    bank: a.bank,
    type: a.type,
    balance_delta: Number(byAccount[a.id] || 0),
  })).sort((a,b) => Math.abs(b.balance_delta) - Math.abs(a.balance_delta));

  const daily = Object.entries(byDay)
    .sort((a,b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, income: v.income, expense: v.expense, net: v.income - v.expense }));

  return {
    year, month,
    txCountCash: tx.length,
    txCountCard: cp.length,
    txCount: tx.length + cp.length,
    income,
    expenseCash,
    expenseCard,
    expense: expenseTotal,
    balance,
    topCats,
    accountRows,
    daily,
  };
}

function generateReportMarkdown(data) {
  const dtGen = new Date().toLocaleString("pt-BR");
  const title = `Relatório Financeiro (Competência) — ${monthNamePt(data.month)} ${data.year}`;

  const lines = [];
  lines.push(`# ${title}`);
  lines.push(``);
  lines.push(`**Gerado em:** ${dtGen}`);
  lines.push(``);
  lines.push(`## 1. Sumário Executivo`);
  lines.push(`- **Receitas (Caixa):** ${mdMoney(data.income)}`);
  lines.push(`- **Despesas (Caixa, sem pagamento de fatura):** ${mdMoney(data.expenseCash)}`);
  lines.push(`- **Despesas (Cartão na competência):** ${mdMoney(data.expenseCard)}`);
  lines.push(`- **Despesas totais (Competência):** ${mdMoney(data.expense)}`);
  lines.push(`- **Saldo do período (Receitas − Despesas competência):** ${mdMoney(data.balance)}`);
  lines.push(`- **Lançamentos:** ${data.txCount} (Caixa: ${data.txCountCash}, Cartão: ${data.txCountCard})`);
  lines.push(``);

  lines.push(`## 2. Principais Categorias de Despesa (Competência)`);
  if (data.topCats.length === 0) {
    lines.push(`Nenhuma despesa registrada na competência.`);
  } else {
    data.topCats.forEach((c, i) => {
      lines.push(`${i + 1}. **${safeText(c.category)}** — ${mdMoney(c.total)}`);
    });
  }
  lines.push(``);

  lines.push(`## 3. Variação por Conta (Δ no mês — Caixa)`);
  if ((data.accountRows || []).length === 0) {
    lines.push(`Nenhuma conta cadastrada.`);
  } else {
    lines.push(`| Conta | Banco | Tipo | Δ (mês) |`);
    lines.push(`|---|---|---:|---:|`);
    data.accountRows.forEach(a => {
      lines.push(`| ${safeText(a.name)} | ${safeText(a.bank)} | ${safeText(a.type)} | ${mdMoney(a.balance_delta)} |`);
    });
  }
  lines.push(``);

  lines.push(`## 4. Série Diária (Receitas e Despesas por Competência)`);
  if (data.daily.length === 0) {
    lines.push(`Sem movimentos na série diária.`);
  } else {
    lines.push(`| Data | Receitas | Despesas | Saldo do dia |`);
    lines.push(`|---|---:|---:|---:|`);
    data.daily.forEach(d => {
      const dt = new Date(d.date + "T00:00:00").toLocaleDateString("pt-BR");
      lines.push(`| ${dt} | ${mdMoney(d.income)} | ${mdMoney(d.expense)} | ${mdMoney(d.net)} |`);
    });
  }
  lines.push(``);

  lines.push(`## 5. Observações`);
  lines.push(`- Compras no cartão são contabilizadas na **competência da fatura** (invoice_ym).`);
  lines.push(`- Pagamento da fatura afeta o **caixa**, mas não é despesa “real”; por isso é excluído de despesas por competência.`);
  lines.push(``);

  return lines.join("\n");
}

function reportToHtml(md) {
  const body = sanitizeHtml(marked.parse(md || ""));
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
  if (!parsed) {
    showToast("Relatórios", "Competência inválida.");
    return;
  }

  // Busca no backend (consistente: tx + card_purchases)
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
  if (prev) prev.innerHTML = sanitizeHtml(marked.parse(md));
};

window.downloadReport = async (fmt) => {
  if (!state.reports.lastMd) await generateAndRenderReport();

  const ymInput = document.getElementById("report-ym");
  const ym = (ymInput && ymInput.value) ? ymInput.value : ymNow();

  if (fmt === "md") {
    downloadBlob(`relatorio_${ym}.md`, state.reports.lastMd, "text/markdown;charset=utf-8");
    return;
  }
  if (fmt === "html") {
    downloadBlob(`relatorio_${ym}.html`, state.reports.lastHtml, "text/html;charset=utf-8");
    return;
  }
  showToast("Relatórios", "Formato de download não suportado.");
};

window.printReport = async () => {
  if (!state.reports.lastHtml) await generateAndRenderReport();

  const w = window.open("", "_blank");
  if (!w) {
    showToast("Relatórios", "Pop-up bloqueado. Autorize pop-ups para imprimir/salvar PDF.");
    return;
  }
  w.document.open();
  w.document.write(state.reports.lastHtml);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 350);
};

// ==========================================================
// PDF Viewer (upload local) - pdf.js
// ==========================================================
async function renderPdfFile(file) {
  const meta = document.getElementById("pdf-meta");
  const pages = document.getElementById("pdf-pages");
  if (!pages) return;

  pages.innerHTML = "";
  if (!file) return;

  const buf = await file.arrayBuffer();
  const task = pdfjsLib.getDocument({ data: buf });
  const pdf = await task.promise;

  if (meta) meta.innerText = `${pdf.numPages} pág.`;

  const maxPages = Math.min(pdf.numPages, 12);

  for (let p = 1; p <= maxPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1.4 });

    const wrap = document.createElement("div");
    wrap.className = "bg-slate-50 border border-slate-200 rounded-2xl p-3 overflow-hidden";

    const title = document.createElement("div");
    title.className = "text-xs font-bold text-slate-600 mb-2";
    title.innerText = `Página ${p}${pdf.numPages > maxPages ? ` (mostrando até ${maxPages})` : ""}`;
    wrap.appendChild(title);

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.className = "w-full h-auto rounded-xl bg-white";
    wrap.appendChild(canvas);

    pages.appendChild(wrap);

    await page.render({ canvasContext: ctx, viewport }).promise;
  }

  if (pdf.numPages > maxPages) {
    const warn = document.createElement("div");
    warn.className = "text-xs text-slate-500";
    warn.innerText = `PDF grande: renderizadas apenas as primeiras ${maxPages} páginas.`;
    pages.appendChild(warn);
  }
}

// ==========================================================
// UX: ESC fecha modais
// ==========================================================
function closeIfOpen(id) {
  const el = document.getElementById(id);
  if (el && !el.classList.contains("hidden")) el.classList.add("hidden");
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  closeIfOpen("ai-modal");
  ["modal-account","modal-category","modal-card","modal-card-purchase","modal-pay-invoice"].forEach(closeIfOpen);
});

// ==========================================================
// Init (DOM ready)
// ==========================================================
document.addEventListener("DOMContentLoaded", () => {
  // datas default
  const txDate = document.getElementById("tx-date");
  if (txDate) txDate.valueAsDate = new Date();

  const pd = document.getElementById("purchase-date");
  if (pd) pd.valueAsDate = new Date();

  // Sincroniza mudança de competência da fatura
  const invYm = document.getElementById("invoice-ym");
  if (invYm) invYm.addEventListener("change", () => window.loadInvoice());

  // Se quiser: ao mudar competência do relatório, recalcula preview
  const repYm = document.getElementById("report-ym");
  if (repYm) repYm.addEventListener("change", () => window.generateAndRenderReport());

  // Hook PDF input
  const inp = document.getElementById("report-pdf-input");
  if (inp) {
    inp.addEventListener("change", async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        await renderPdfFile(f);
      } catch (err) {
        console.error(err);
        showToast("PDF", err.message || String(err));
      }
    });
  }

  setActiveNav("dashboard");
  refreshAll();
});
