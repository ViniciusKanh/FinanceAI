"use strict";

/* ==========================================================
   CONFIG (API_BASE)
   ========================================================== */
// Permite configurar via localStorage:
// localStorage.setItem("FINANCEAI_API_BASE","http://localhost:8000");
// localStorage.removeItem("FINANCEAI_API_BASE");
export const DEFAULT_API_BASE = "https://viniciuskhan-financeai.hf.space";
export const API_BASE = (localStorage.getItem("FINANCEAI_API_BASE") || DEFAULT_API_BASE)
  .trim()
  .replace(/\/+$/, "");

window.FINANCEAI_API_BASE = API_BASE;

/* ==========================================================
   ESTADO LOCAL (frontend)
   ========================================================== */
export const state = {
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
    predFlow: null,
    predCats: null,
  },

  // Relatórios
  reports: {
    lastMd: "",
    lastHtml: "",
  },

  // Cache predição
  predictions: {
    lastPayload: null,
    lastRunAt: null,
  }
};

/* ==========================================================
   TOAST
   ========================================================== */
export function showToast(title, msg, ms = 3500) {
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
export function monthLabel(date) {
  const year = date.getFullYear();
  const month = date.getMonth(); // 0..11
  const months = [
    "Janeiro","Fevereiro","Março","Abril","Maio","Junho",
    "Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"
  ];
  return { year, month, label: `${months[month]} ${year}`, months };
}

export function toMoney(v) {
  return `R$ ${Number(v || 0).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

export function safeText(s) {
  return String(s ?? "").replace(/[<>&"]/g, c => ({
    "<":"&lt;", ">":"&gt;", "&":"&amp;", '"':"&quot;"
  }[c]));
}

export function sanitizeHtml(html) {
  const s = String(html ?? "");
  return s
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/on\w+="[^"]*"/gi, "")
    .replace(/on\w+='[^']*'/gi, "")
    .replace(/javascript:/gi, "");
}

export function setDisabled(el, disabled) {
  if (!el) return;
  el.disabled = !!disabled;
  el.classList.toggle("opacity-60", !!disabled);
  el.classList.toggle("cursor-not-allowed", !!disabled);
}

export function destroyChart(inst) {
  if (inst && typeof inst.destroy === "function") inst.destroy();
}

/* ==========================================================
   API (fetch com timeout + erros uniformes)
   ========================================================== */
export async function api(path, options = {}) {
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
      : "Falha de rede/CORS ao acessar o backend. Verifique API_BASE e o servidor (evite abrir via file://)."
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
