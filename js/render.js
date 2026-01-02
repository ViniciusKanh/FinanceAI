"use strict";

import { state, safeText, toMoney, monthLabel } from "./core.js";

/* ==========================================================
   RENDERERS
   ========================================================== */
export function renderAll() {
  renderAccounts();
  renderCategories();
  renderDashboard();
  renderCreditCardsList();
  hydrateCreditSelects();
  hydratePredictionsSelects();
}

export function renderAccounts() {
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

export function renderCategories() {
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

export function renderDashboard() {
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
export function renderCreditCardsList() {
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

export function hydrateCreditSelects() {
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

export function hydratePredictionsSelects() {
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
