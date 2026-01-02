"use strict";

import { api, state, monthLabel, showToast } from "./core.js";
import { renderAll } from "./render.js";
import { reloadCharts } from "./charts.js";
import { renderCreditControls } from "./crud_credit_invoice.js";
import { renderPredictionsUI, renderPredictionsCharts } from "./predictions.js";

/* ==========================================================
   LOADERS
   ========================================================== */
export async function loadHealth() {
  state.health = await api("/health");
  state.cardPaymentCategory =
    (state.health && state.health.card_payment_category) || state.cardPaymentCategory;
}

export async function loadAccounts() {
  state.accounts = await api("/accounts");
}

export async function loadCategories() {
  state.categories = await api("/categories");
}

export async function loadCards() {
  state.cards = await api("/cards");
  if (!state.selectedCardId && state.cards.length > 0) {
    state.selectedCardId = state.cards[0].id;
  }
}

export async function loadTransactionsForCurrentMonth() {
  const { year, month } = monthLabel(state.currentDate);
  state.transactions = await api(`/transactions?year=${year}&month=${month + 1}&limit=2000`);
}

export async function loadCombinedForCurrentMonth() {
  const { year, month } = monthLabel(state.currentDate);
  state.combinedTransactions = await api(`/transactions/combined?year=${year}&month=${month + 1}&limit=5000`);
  state.summaryCombined = await api(`/summary/combined?year=${year}&month=${month + 1}`);
}

/* ==========================================================
   Refresh geral
   ========================================================== */
export async function refreshAll() {
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
