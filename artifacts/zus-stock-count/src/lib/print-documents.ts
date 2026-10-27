function monthKey(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("A valid document date is required.");

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "2-digit",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("Could not format the document date.");
  return `${year}${month}`;
}

export function purchaseOrderDocumentName(orderNumber: string): string {
  const safeName = orderNumber.trim().replace(/[^A-Za-z0-9_-]/g, "-");
  if (!safeName) throw new Error("A purchase-order number is required.");
  return safeName;
}

export function stockTakeDocumentName(createdAt: string | Date, countId: number): string {
  if (!Number.isSafeInteger(countId) || countId < 1) {
    throw new Error("A valid stock-take number is required.");
  }
  return `ST-${monthKey(createdAt)}${String(countId).padStart(3, "0")}`;
}

export function printNamedDocument(target: HTMLElement | null, documentName: string): void {
  if (!target) return;

  const previousTitle = document.title;
  const wasPrintModeActive = document.body.classList.contains("print-mode");
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    target.removeAttribute("data-print-target");
    if (!wasPrintModeActive) document.body.classList.remove("print-mode");
    document.title = previousTitle;
  };

  target.setAttribute("data-print-target", "true");
  document.body.classList.add("print-mode");
  document.title = documentName;
  window.addEventListener("afterprint", cleanup, { once: true });
  window.setTimeout(cleanup, 5 * 60 * 1000);
  window.requestAnimationFrame(() => {
    try {
      window.print();
    } catch {
      cleanup();
    }
  });
}
