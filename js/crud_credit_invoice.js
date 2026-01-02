"use strict";

import { api, state, toMoney, safeText, showToast } from "./core.js";
import { renderAll, renderCreditCardsList, hydrateCreditSelects } from "./render.js";
import { renderCardCategoryChart, reloadCharts } from "./charts.js";
import { loadCombinedForCurrentMonth, loadTransactionsForCurrentMonth, loadCards } from "./loaders.js";

/* ==========================================================
   CRUD: Accounts / Categories / Transactions
   ========================================================== */
export async function deleteAccount(id) {
  if (!confirm("Excluir esta conta?")) return;
  await api(`/accounts/${id}`, { method: "DELETE" });
  await window.refreshAll();
}
window.deleteAccount = deleteAccount;

export async function deleteCategory(id) {
  if (!confirm("Excluir esta categoria?")) return;
  await api(`/categories/${id}`, { method: "DELETE" });
  await window.refreshAll();
}
window.deleteCategory = deleteCategory;

export async function deleteTransaction(id) {
  if (!confirm("Excluir esta transação?")) return;
  await api(`/transactions/${id}`, { method: "DELETE" });
  await window.refreshAll();
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
  await window.refreshAll();
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
  await window.refreshAll();
};

/* ==========================================================
   CREDIT controls (inputs default)
   ========================================================== */
export async function renderCreditControls() {
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
   CRUD: Cartões
   ========================================================== */
export async function deleteCard(id) {
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

export async function deleteCardPurchase(id) {
  if (!confirm("Excluir esta compra do cartão?")) return;
  await api(`/cards/purchases/${id}`, { method: "DELETE" });
  await window.loadInvoice?.();
  await loadCombinedForCurrentMonth();
  renderAll();
  await reloadCharts();
}
window.deleteCardPurchase = deleteCardPurchase;
