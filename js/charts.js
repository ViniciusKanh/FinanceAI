"use strict";

import { api, state, monthLabel, toMoney, showToast, destroyChart } from "./core.js";

/* ==========================================================
   CHARTS (Dashboard)
   ========================================================== */
export async function reloadCharts() {
  await Promise.all([renderTimeseriesChart(), renderCategoriesChart()]);
}
window.reloadCharts = reloadCharts;

export async function renderTimeseriesChart() {
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

export async function renderCategoriesChart() {
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

export function renderCardCategoryChart(purchases) {
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
