"use strict";

import { api, state, toMoney, safeText, sanitizeHtml, showToast, destroyChart, setDisabled, monthLabel } from "./core.js";

/* ==========================================================
   PREDICTIONS (ABA)
   ========================================================== */
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
function isYm(s) {
  return typeof s === "string" && /^\d{4}-\d{2}$/.test(s);
}
function fmtLabel(x) {
  if (!x) return "—";
  if (isIsoDate(x)) return new Date(x + "T00:00:00").toLocaleDateString("pt-BR");
  if (isYm(x)) {
    const [yy, mm] = x.split("-");
    return `${mm}/${yy}`;
  }
  return String(x);
}
function addDaysIso(baseDate, days) {
  const d = new Date(baseDate);
  d.setDate(d.getDate() + days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function median(arr) {
  const a = (arr || []).filter(n => Number.isFinite(n)).slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * Normaliza timeline e corrige datas incoerentes do backend.
 * - Se as datas de previsão estiverem MUITO longe do horizonte, gera t+1...t+h.
 */
function buildTimeline(hist, pred, horizonDays) {
  const history = Array.isArray(hist) ? hist : [];
  const predictions = Array.isArray(pred) ? pred : [];

  const today = new Date();
  const h = horizonDays || predictions.length || 7;

  const rawKey = (r) => (r?.date || r?.ym || r?.period || null);

  const normHist = history
    .map(r => ({
      rawKey: rawKey(r),
      income: asNumber(r?.income ?? 0),
      expense: asNumber(r?.expense ?? r?.expense_total ?? 0),
    }))
    .filter(r => r.rawKey);

  const normPred = predictions.map(r => ({
    rawKey: rawKey(r),
    income: asNumber(r?.income_pred ?? r?.income ?? 0),
    expense: asNumber(r?.expense_pred ?? r?.expense ?? r?.expense_total ?? 0),
    net: asNumber(
      r?.net_pred ?? r?.net ??
      (asNumber(r?.income_pred ?? r?.income ?? 0) - asNumber(r?.expense_pred ?? r?.expense ?? r?.expense_total ?? 0))
    ),
  }));

  // Decide se confia nas datas vindas do backend
  const isoDates = normPred.map(r => r.rawKey).filter(isIsoDate);
  let useDates = isoDates.length >= Math.max(1, Math.floor(normPred.length * 0.6));

  if (useDates) {
    const maxReasonableDaysAhead = Math.max(45, h + 14);
    let far = 0;
    for (const s of isoDates) {
      const d = new Date(s + "T00:00:00");
      const diffDays = Math.round((d - today) / (1000 * 60 * 60 * 24));
      if (diffDays > maxReasonableDaysAhead || diffDays < -7) far++;
    }
    if (far >= Math.ceil(isoDates.length * 0.5)) useDates = false;
  } else {
    const ymDates = normPred.map(r => r.rawKey).filter(isYm);
    if (ymDates.length >= Math.max(1, Math.floor(normPred.length * 0.6))) useDates = true;
  }

  const predKeys = useDates
    ? normPred.map(r => r.rawKey || null)
    : Array.from({ length: h }, (_, i) => addDaysIso(today, i + 1));

  const fixedPred = normPred.map((r, i) => ({
    ...r,
    rawKey: predKeys[i] || r.rawKey || null
  }));

  const histOut = normHist.map(r => ({ ...r, label: fmtLabel(r.rawKey) }));
  const predOut = fixedPred
    .filter(r => r.rawKey)
    .map(r => ({ ...r, label: fmtLabel(r.rawKey) }));

  return { hist: histOut, pred: predOut, usedSyntheticDates: !useDates };
}

/**
 * Risco:
 * - se hist vier, usa mediana recente de despesa para identificar pico
 * - se não vier, cai para percentil interno no próprio horizonte
 */
function computeRiskFromPred(predRows, histRows = []) {
  const pred = Array.isArray(predRows) ? predRows : [];
  const hist = Array.isArray(histRows) ? histRows : [];

  const nets = pred.map(r => asNumber(r?.net ?? r?.net_pred ?? (asNumber(r?.income) - asNumber(r?.expense))));
  const exps = pred.map(r => asNumber(r?.expense ?? r?.expense_pred ?? r?.expense_total ?? 0));

  if (!pred.length) return { level: "—", count: 0, negDays: 0, highExpDays: 0 };

  const negDays = nets.filter(v => v < 0).length;

  let highExpDays = 0;
  const histExp = hist.map(r => asNumber(r?.expense)).filter(n => n > 0);

  if (histExp.length >= 6) {
    const base = median(histExp.slice(-14));
    const thr = base > 0 ? base * 1.6 : 0;
    if (thr > 0) highExpDays = exps.filter(v => v > thr).length;
  } else {
    const sorted = [...exps].filter(n => n > 0).sort((a,b) => a-b);
    const p80 = sorted.length ? sorted[Math.floor(0.8 * (sorted.length - 1))] : 0;
    if (p80 > 0) highExpDays = exps.filter(v => v > p80).length;
  }

  const count = negDays + highExpDays;
  let level = "Baixo";
  if (count >= 1) level = "Médio";
  if (count >= 4 || negDays >= 2) level = "Alto";

  return { level, count, negDays, highExpDays };
}

/* --- Charts de predição --- */
export function renderPredictionsCharts(payload) {
  if (typeof Chart === "undefined") {
    showToast("Predições", "Chart.js não carregou.");
    return;
  }

  const flowCanvas = document.getElementById("chart-pred-flow");
  const catCanvas = document.getElementById("chart-pred-categories");

  const histRaw = Array.isArray(payload?.history) ? payload.history : [];
  const predRaw = Array.isArray(payload?.predictions) ? payload.predictions : [];
  const basis = String(payload?.basis || payload?.meta?.basis || "").toLowerCase();

  const hasNetPred = predRaw.some(r => r && Object.prototype.hasOwnProperty.call(r, "net_pred"));
  const isDaily = basis.includes("daily") || hasNetPred;

  const horizonInput = Number(document.getElementById("pred-horizon")?.value || 0);
  const horizon = predRaw.length || horizonInput || 7;

  const backendError = payload?.error || payload?.detail || payload?.message;
  if (backendError && (!predRaw.length)) {
    destroyChart(state.charts.predFlow);
    destroyChart(state.charts.predCats);
    state.charts.predFlow = null;
    state.charts.predCats = null;
    return;
  }

  const tl = buildTimeline(histRaw, predRaw, horizon);

  // ---------- Flow (hist + pred) ----------
  if (flowCanvas) {
    clampCanvasHeight(flowCanvas, 260);

    const labels = [
      ...tl.hist.map(r => r.label),
      ...tl.pred.map(r => r.label),
    ];

    destroyChart(state.charts.predFlow);

    if (!labels.length) {
      state.charts.predFlow = null;
    } else if (isDaily) {
      const series = [
        ...tl.hist.map(r => asNumber((r.income || 0) - (r.expense || 0))),
        ...tl.pred.map(r => asNumber(r.net)),
      ];

      const n = Math.min(labels.length, series.length);
      state.charts.predFlow = new Chart(flowCanvas, {
        type: "line",
        data: {
          labels: labels.slice(0, n),
          datasets: [{ label: "Saldo líquido", data: series.slice(0, n), tension: 0.25 }],
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
    } else {
      const inc = [...tl.hist.map(r => asNumber(r.income)), ...tl.pred.map(r => asNumber(r.income))];
      const exp = [...tl.hist.map(r => asNumber(r.expense)), ...tl.pred.map(r => asNumber(r.expense))];

      const n = Math.min(labels.length, inc.length, exp.length);
      state.charts.predFlow = new Chart(flowCanvas, {
        type: "line",
        data: {
          labels: labels.slice(0, n),
          datasets: [
            { label: "Receitas", data: inc.slice(0, n), tension: 0.25 },
            { label: "Despesas", data: exp.slice(0, n), tension: 0.25 },
          ],
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

  // ---------- Categories provável (heurística local) ----------
  if (catCanvas) {
    clampCanvasHeight(catCanvas, 240);

    const lastCats = {};
    const rows = Array.isArray(state.combinedTransactions) ? state.combinedTransactions : [];

    for (const r of rows) {
      const isExpense = (r?.source === "card") || (r?.type === "expense");
      if (!isExpense) continue;

      const amt = asNumber(r?.amount);
      if (amt <= 0) continue;

      const cat = (r?.category && String(r.category).trim()) ? String(r.category).trim() : "Geral";
      lastCats[cat] = (lastCats[cat] || 0) + amt;
    }

    const top = Object.entries(lastCats)
      .sort((a,b) => b[1] - a[1])
      .slice(0, 8);

    destroyChart(state.charts.predCats);

    if (!top.length) {
      state.charts.predCats = null;
    } else {
      const labels = top.map(x => x[0]);
      const totals = top.map(x => x[1]);

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
export function renderPredictionsUI(payload) {
  const predRaw = Array.isArray(payload?.predictions) ? payload.predictions : [];
  const histRaw = Array.isArray(payload?.history) ? payload.history : [];
  const basis = String(payload?.basis || payload?.meta?.basis || "").toLowerCase();

  const backendError = payload?.error || payload?.detail || payload?.message;

  const horizonInput = Number(document.getElementById("pred-horizon")?.value || 0);
  const horizon = predRaw.length || horizonInput || 7;

  if (backendError && !predRaw.length) {
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
    if (elCount) elCount.innerText = `0 itens`;
    if (elNote) elNote.innerText = `para ${horizon} dia(s)`;

    const alertsBox = document.getElementById("pred-alerts");
    if (alertsBox) {
      alertsBox.innerHTML = `
        <div class="p-3 rounded-xl border bg-rose-50 border-rose-200 text-rose-900 flex gap-3 items-start">
          <i class="fas fa-triangle-exclamation mt-0.5"></i>
          <div>
            <div class="font-bold text-sm">Predição não gerada</div>
            <div class="text-xs opacity-80">${safeText(String(backendError))}</div>
          </div>
        </div>
      `;
    }

    const actionsBox = document.getElementById("pred-actions");
    if (actionsBox) {
      const acts = [
        "Registre mais dias com movimentação (histórico curto derruba qualquer modelo).",
        "Ou reduza lags/validação no backend (ex.: lags=3).",
        "Enquanto isso, use baseline (média móvel / último valor) como planejamento."
      ];
      actionsBox.innerHTML = acts.map(t => `
        <div class="p-3 rounded-xl border border-slate-200 bg-slate-50 flex gap-3 items-start">
          <i class="fas fa-list-check mt-0.5 text-slate-600"></i>
          <div class="text-sm text-slate-700 font-medium">${safeText(t)}</div>
        </div>
      `).join("");
    }

    const list = document.getElementById("pred-list");
    if (list) list.innerHTML = `<div class="p-6 text-sm text-slate-400">Sem dados previstos (erro no treino).</div>`;
    return;
  }

  const hasNetPred = predRaw.some(r => r && Object.prototype.hasOwnProperty.call(r, "net_pred"));
  const isDaily = basis.includes("daily") || hasNetPred;

  const tl = buildTimeline(histRaw, predRaw, horizon);

  let income = 0;
  let expense = 0;
  let balance = 0;

  if (isDaily) {
    balance = tl.pred.reduce((acc, r) => acc + asNumber(r.net), 0);
  } else {
    income = tl.pred.reduce((acc, r) => acc + asNumber(r.income), 0);
    expense = tl.pred.reduce((acc, r) => acc + asNumber(r.expense), 0);
    balance = income - expense;
  }

  const elBal = document.getElementById("pred-balance");
  const elInc = document.getElementById("pred-income");
  const elExp = document.getElementById("pred-expense");
  const elRisk = document.getElementById("pred-risk");
  const elCount = document.getElementById("pred-count");
  const elNote = document.getElementById("pred-balance-note");

  if (elBal) elBal.innerText = toMoney(balance);

  if (isDaily) {
    if (elInc) elInc.innerText = "—";
    if (elExp) elExp.innerText = "—";
    if (elNote) elNote.innerText = `saldo líquido previsto (modo diário) • ${horizon} dia(s)`;
  } else {
    if (elInc) elInc.innerText = toMoney(income);
    if (elExp) elExp.innerText = toMoney(expense);
    if (elNote) elNote.innerText = `para ${horizon} período(s)`;
  }

  if (elCount) elCount.innerText = `${tl.pred.length} itens`;

  const risk = isDaily
    ? (() => {
        const nets = tl.pred.map(r => asNumber(r.net));
        const negDays = nets.filter(v => v < 0).length;

        const abs = nets.map(v => Math.abs(v)).filter(v => v > 0);
        const med = median(abs);
        const thr = med > 0 ? med * 1.8 : 0;
        const highSwingDays = thr > 0 ? abs.filter(v => v >= thr).length : 0;

        let level = "Baixo";
        const count = negDays + highSwingDays;
        if (negDays >= 3 || highSwingDays >= 3) level = "Alto";
        else if (negDays >= 1 || highSwingDays >= 1) level = "Médio";

        return { level, count, negDays, highExpDays: 0, highSwingDays };
      })()
    : computeRiskFromPred(tl.pred, tl.hist);

  if (elRisk) elRisk.innerText = `${risk.level} (${risk.count})`;

  const alertsBox = document.getElementById("pred-alerts");
  if (alertsBox) {
    const items = [];

    if (risk.negDays > 0) {
      items.push({
        title: "Saldo previsto negativo",
        text: `${risk.negDays} dia(s) com saldo líquido abaixo de zero no horizonte.`,
        icon: "fa-triangle-exclamation",
        cls: "bg-amber-50 border-amber-200 text-amber-900"
      });
    }

    if (!isDaily && risk.highExpDays > 0) {
      items.push({
        title: "Picos de despesa",
        text: `${risk.highExpDays} dia(s) com despesa acima do padrão recente.`,
        icon: "fa-fire",
        cls: "bg-rose-50 border-rose-200 text-rose-900"
      });
    }

    if (isDaily && risk.highSwingDays > 0) {
      items.push({
        title: "Oscilações fortes no saldo",
        text: `${risk.highSwingDays} dia(s) com variação de saldo bem acima do padrão.`,
        icon: "fa-wave-square",
        cls: "bg-indigo-50 border-indigo-200 text-indigo-900"
      });
    }

    if (tl.usedSyntheticDates) {
      items.push({
        title: "Datas normalizadas",
        text: "O backend enviou datas incoerentes; o front ajustou para o horizonte (t+1…t+h).",
        icon: "fa-circle-info",
        cls: "bg-sky-50 border-sky-200 text-sky-900"
      });
    }

    if (items.length === 0) {
      items.push({
        title: "Sem alertas críticos",
        text: "Nada crítico no horizonte. Continue monitorando.",
        icon: "fa-circle-check",
        cls: "bg-emerald-50 border-emerald-200 text-emerald-900"
      });
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

  const actionsBox = document.getElementById("pred-actions");
  if (actionsBox) {
    const acts = [];
    acts.push("Revise despesas recorrentes (assinaturas) e corte o que não usa.");

    if (risk.level !== "Baixo") {
      acts.push("Defina um teto diário de gasto até o período estabilizar.");
      acts.push("Se houver dias negativos previstos, antecipe recebíveis ou reprograme pagamentos.");
    }

    if (isDaily) {
      acts.push("Evite comprometer o saldo com compras parceladas no curto prazo (bola de neve é velha e funciona).");
      if (risk.highSwingDays > 0) acts.push("Planeje uma janela de contenção para reduzir volatilidade do caixa.");
    } else {
      acts.push("Antecipe contas com vencimento no horizonte para evitar juros.");
      acts.push("Se houver pico previsto, planeje uma janela de contenção.");
    }

    actionsBox.innerHTML = acts.map(t => `
      <div class="p-3 rounded-xl border border-slate-200 bg-slate-50 flex gap-3 items-start">
        <i class="fas fa-list-check mt-0.5 text-slate-600"></i>
        <div class="text-sm text-slate-700 font-medium">${safeText(t)}</div>
      </div>
    `).join("");
  }

  const list = document.getElementById("pred-list");
  if (list) {
    if (!tl.pred.length) {
      list.innerHTML = `<div class="p-6 text-sm text-slate-400">Sem dados previstos.</div>`;
    } else {
      const rows = tl.pred.slice(0, 120);
      list.innerHTML = rows.map(r => {
        if (isDaily) {
          const netD = asNumber(r.net);
          return `
            <div class="p-4 flex items-center justify-between hover:bg-slate-50 transition-colors">
              <div>
                <div class="text-sm font-bold text-slate-800">${safeText(r.label)}</div>
                <div class="text-xs text-slate-500">Saldo líquido previsto</div>
              </div>
              <div class="text-sm font-bold ${netD < 0 ? "text-rose-600" : "text-emerald-600"}">
                ${netD < 0 ? "-" : "+"} ${toMoney(Math.abs(netD))}
              </div>
            </div>
          `;
        }

        const incD = asNumber(r.income);
        const expD = asNumber(r.expense);
        const netD = incD - expD;

        return `
          <div class="p-4 flex items-center justify-between hover:bg-slate-50 transition-colors">
            <div>
              <div class="text-sm font-bold text-slate-800">${safeText(r.label)}</div>
              <div class="text-xs text-slate-500">Receita: ${toMoney(incD)} • Despesa: ${toMoney(expD)}</div>
            </div>
            <div class="text-sm font-bold ${netD < 0 ? "text-rose-600" : "text-emerald-600"}">
              ${netD < 0 ? "-" : "+"} ${toMoney(Math.abs(netD))}
            </div>
          </div>
        `;
      }).join("");
    }
  }
}

export async function runPredictions() {
  const btn = document.getElementById("btn-run-pred");
  const prev = btn ? btn.innerHTML : "";

  try {
    if (btn) { btn.innerHTML = "Gerando..."; setDisabled(btn, true); }

    const horizon = Number(document.getElementById("pred-horizon")?.value || 7);
    const scope = String(document.getElementById("pred-scope")?.value || "all");
    const accId = scope === "account" ? Number(document.getElementById("pred-account")?.value || 0) : null;

    const qs = new URLSearchParams();
    qs.set("days", String(horizon));
    if (accId) qs.set("account_id", String(accId));

    // timeout maior para treino
    const payload = await api(`/forecast/daily?${qs.toString()}`, { method: "GET", timeoutMs: 60000 });

    state.predictions.lastPayload = payload;
    state.predictions.lastRunAt = new Date();

    const modelName = payload?.model || payload?.meta?.model || payload?.meta?.name || "—";
    const dt = new Date().toLocaleString("pt-BR");
    setPredMeta(`Modelo: ${modelName} | Última execução: ${dt}`);

    renderPredictionsUI(payload);
    renderPredictionsCharts(payload);

    showToast("Predições", "Previsão gerada com sucesso.");
  } catch (e) {
    console.error(e);
    showToast("Predições (erro)", e.message || String(e), 7000);
    setPredMeta(`Modelo: — | Última execução: erro`);

    destroyChart(state.charts.predFlow);
    destroyChart(state.charts.predCats);
    state.charts.predFlow = null;
    state.charts.predCats = null;
  } finally {
    if (btn) {
      btn.innerHTML = prev || '<i class="fas fa-wand-magic-sparkles mr-2"></i> Gerar';
      setDisabled(btn, false);
    }
  }
}

window.forecastLoadUI = runPredictions;
