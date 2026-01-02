"use strict";

import { api, state, toMoney, safeText, sanitizeHtml, showToast } from "./core.js";

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
