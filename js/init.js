"use strict";

import { api, state, showToast, safeText, sanitizeHtml, setDisabled, monthLabel } from "./core.js";
import { refreshAll, loadTransactionsForCurrentMonth, loadCombinedForCurrentMonth } from "./loaders.js";
import { renderAll } from "./render.js";
import { reloadCharts } from "./charts.js";
import { renderPredictionsUI, renderPredictionsCharts } from "./predictions.js";

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
   Init (DOMContentLoaded)
   ========================================================== */
export function initApp() {
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

  // Estado inicial dos botões (receita/despesa)
  window.setTxType(document.getElementById("tx-type")?.value || "expense");

  // Se abrir via file://, avisa
  if (location.protocol === "file:") {
    showToast("Atenção", "Você está abrindo via file://. Rode um servidor local (python -m http.server) para evitar CORS.", 8000);
  }

  refreshAll();
}
