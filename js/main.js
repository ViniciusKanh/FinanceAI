"use strict";

import "./crud_credit_invoice.js";
import "./reports.js";
import { initApp } from "./init.js";

// Boot
document.addEventListener("DOMContentLoaded", () => {
  initApp();
  console.log("[FinanceAI] API_BASE =", window.FINANCEAI_API_BASE);
});
