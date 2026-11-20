import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'wouter';
import ExcelJS from 'exceljs';
import {
  downloadStockCountWorkbook, getGetCurrentUserQueryKey, getGetDashboardSummaryQueryKey, getGetStockCountQueryKey, getListDeliveriesQueryKey, getListProductCategoriesQueryKey, getListProductsQueryKey,
  getListPurchaseOrdersQueryKey, getListStockBatchesQueryKey, getListStockCountsQueryKey, getListStockMovementsQueryKey,
  getListStockSectionsQueryKey, getListSuppliersQueryKey, useCancelPurchaseOrder, useCreateDelivery,
  useCreateLowStockPurchaseOrderDrafts, useCreatePurchaseOrder, useCreateStockCount, useDecideDelivery, useDecidePurchaseOrder,
  useGetCurrentUser, useGetPurchaseOrderHistory, useGetStockCount, useIssuePurchaseOrder, useListDeliveries, useListProductCategories,
  useGetPurchaseOrderHistoryExport, useListProducts, useListPurchaseOrders, useListStockBatches, useListStockCounts, useListStockSections,
  useListSuppliers, useRequestStockCountWorkbookUploadUrl, useSubmitStockCount, useUpdatePurchaseOrderDraft,
} from '@workspace/api-client-react';
import type { Delivery, Product, PurchaseOrder, PurchaseOrderHistoryEntry, StockCountInputScope, StockCountLine } from '@workspace/api-client-react';
import { ArrowRight, Check, CheckCircle2, ChevronDown, ChevronRight, ClipboardCheck, Clock3, Download, Package, Plus, Printer, RefreshCw, Search, Truck, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { SearchableSelect } from './components/SearchableSelect';
import { countTotal, hasCountInput, splitCount, type CountDraft } from './stock-count-entry';
import { parseStockCountWorkbook, STOCKTAKE_HEADERS, type WorkbookCountImport } from './stock-count-workbook';
import {
  STOCKTAKE_GUIDE_SHEET,
  STOCKTAKE_MANIFEST_MARKER,
  STOCKTAKE_MANIFEST_SHEET,
} from './lib/stocktake-workbook';
import { printNamedDocument, purchaseOrderDocumentName, stockTakeDocumentName } from './lib/print-documents';
import { summarizeStockCountMovements } from './lib/stock-count-movement-summary';

function useHideMobileAppChrome(active: boolean) {
  useEffect(() => {
    if (!active) return;
    document.documentElement.dataset.mobileChromeHidden = 'true';
    return () => {
      delete document.documentElement.dataset.mobileChromeHidden;
    };
  }, [active]);
}

const dateText = (value?: string | null) => value ? new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value)) : '—';
const dateTimeText = (value?: string | null) => value ? new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : '—';
const titleCase = (value: string) => value.replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
const keyFor = (productId: number, sectionId: number | null) => `${productId}:${sectionId ?? 'outlet'}`;
const quantityText = (value: number) => new Intl.NumberFormat('en', { maximumFractionDigits: 3 }).format(value);
function csvCell(value: string | number) {
  let text = String(value);
  if (/^[\t\r\n ]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function Heading({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><div className="mono mb-2 text-[10px] uppercase tracking-[.16em] text-primary">Store operations</div><h1 className="zus-title text-3xl font-bold tracking-tight">{title}</h1><p className="mt-2 text-sm text-muted-foreground">{detail}</p></div>{action}</div>;
}
function PanelEmpty({ title, detail }: { title: string; detail: string }) {
  return <div className="grid min-h-48 place-items-center p-7 text-center"><div><div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-2xl bg-[#e7ebf6] text-primary"><Package size={19}/></div><b className="text-sm">{title}</b><p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">{detail}</p></div></div>;
}
function refreshOrders(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() });
  void qc.invalidateQueries({ queryKey: getListDeliveriesQueryKey() });
  void qc.invalidateQueries({ queryKey: getListProductsQueryKey() });
  void qc.invalidateQueries({ queryKey: getListStockBatchesQueryKey() });
  void qc.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
  void qc.invalidateQueries({
    predicate: query => typeof query.queryKey[0] === 'string' &&
      query.queryKey[0].startsWith('/api/purchase-orders/') &&
      query.queryKey[0].endsWith('/history'),
  });
}

function OrderFollowUp({ orders, deliveries, deliveriesLoading, deliveriesError }: {
  orders: PurchaseOrder[];
  deliveries: Delivery[];
  deliveriesLoading: boolean;
  deliveriesError: boolean;
}) {
  const today = localDateKey(new Date());
  const followUps = orders.flatMap(order => {
    if (!['issued', 'partially_received', 'approved'].includes(order.status)) return [];
    const remainingLines = order.lines
      .map(line => ({ ...line, remaining: Math.max(0, line.quantity - line.receivedQuantity) }))
      .filter(line => line.remaining > 0.001);
    if (!remainingLines.length) return [];
    const expectedDate = order.expectedDeliveryDate?.slice(0, 10) || null;
    return [{ order, remainingLines, expectedDate, overdue: Boolean(expectedDate && expectedDate < today) }];
  }).sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.expectedDate || '9999-12-31').localeCompare(b.expectedDate || '9999-12-31'));

  return <section className="panel mb-5 overflow-hidden" aria-labelledby="order-follow-up-title">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-4">
      <div><h2 id="order-follow-up-title" className="text-sm font-extrabold">Outstanding orders</h2><p className="mt-1 text-[11px] text-muted-foreground">Orders that are not fully received, with quantities still due in the order units.</p></div>
      <span className="mono rounded-full bg-[#f8eed6] px-2.5 py-1 text-xs font-bold text-[#875b15]">{followUps.length} open</span>
    </div>
    {followUps.length === 0 ? <div className="px-5 py-6 text-center text-xs text-muted-foreground">No outstanding issued orders.</div> : <div className="divide-y divide-border">
      {followUps.map(({ order, remainingLines, expectedDate, overdue }) => {
        const linkedDeliveries = deliveries.filter(delivery => delivery.purchaseOrderId === order.id);
        return <article key={order.id} className="grid gap-3 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-center">
          <div>
            <div className="flex flex-wrap items-center gap-2 text-xs font-extrabold">
              <a className="text-primary underline underline-offset-2" href={`#purchase-order-${order.id}`}>{order.orderNumber || `Order ${order.id}`}</a>
              <span className={`rounded-full px-2 py-1 text-[10px] ${overdue ? 'bg-[#f8e5e1] text-[#98483e]' : 'bg-[#e5f0e9] text-[#28644b]'}`}>{overdue ? 'Overdue' : 'Short-received'}</span>
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">{order.supplierName || 'Supplier not selected'} · {titleCase(order.status)}</p>
            <p className={`mt-1 text-[10px] font-semibold ${overdue ? 'text-[#98483e]' : 'text-muted-foreground'}`}>{expectedDate ? `${overdue ? 'Expected' : 'Due'} ${dateText(expectedDate)}` : 'No expected delivery date'}</p>
          </div>
          <div className="space-y-1">
            <p className="mono text-[9px] uppercase tracking-wide text-muted-foreground">Still due</p>
            {remainingLines.map((line, index) => <p key={`${line.productId}-${index}`} className="text-[11px]"><b>{line.productName}</b> · {quantityText(line.remaining)} {line.unit}</p>)}
          </div>
          <div className="space-y-1">
            <p className="mono text-[9px] uppercase tracking-wide text-muted-foreground">Related deliveries</p>
            {deliveriesLoading ? <p className="text-[10px] text-muted-foreground">Loading deliveries…</p> : deliveriesError ? <p className="text-[10px] text-[#98483e]">Deliveries could not be loaded.</p> : linkedDeliveries.length ? linkedDeliveries.map(delivery => <p key={delivery.id} className="text-[10px]">
              <a className="text-primary underline underline-offset-2" href={`/deliveries#delivery-${delivery.id}`}>Delivery {delivery.id}</a>
              <span className="ml-1 text-muted-foreground">· {titleCase(delivery.status)} · {dateText(delivery.createdAt)}</span>
            </p>) : <p className="text-[10px] text-muted-foreground">No linked deliveries</p>}
          </div>
          <a className="btn btn-soft justify-self-start text-xs lg:justify-self-end" href={`#purchase-order-${order.id}`}>Open order <ArrowRight size={13}/></a>
        </article>;
      })}
    </div>}
  </section>;
}

type OrderLineDraft = { productId: string; quantity: string; unitType: 'unit' | 'bundle' };
function OrderEditor({ order, close, onSaved }: { order?: PurchaseOrder; close: () => void; onSaved: () => void }) {
  const qc = useQueryClient();
  const productsQuery = useListProducts({ active: true }, { query: { queryKey: getListProductsQueryKey({ active: true }) } });
  const suppliersQuery = useListSuppliers({ query: { queryKey: getListSuppliersQueryKey() } });
  const create = useCreatePurchaseOrder();
  const update = useUpdatePurchaseOrderDraft();
  const [supplierId, setSupplierId] = useState(order?.supplierId ? String(order.supplierId) : '');
  const [date, setDate] = useState(order?.expectedDeliveryDate?.slice(0, 10) || '');
  const [note, setNote] = useState(order?.note || '');
  const [lines, setLines] = useState<OrderLineDraft[]>(order?.lines.map(line => ({ productId: String(line.productId), quantity: String(line.quantity), unitType: 'unit' })) || [{ productId: '', quantity: '1', unitType: 'unit' }]);
  const products = useMemo(() => productsQuery.data || [], [productsQuery.data]);
  const hydratedOrder = useRef<number | null>(null);
  useEffect(() => {
    if (!order || productsQuery.isLoading || hydratedOrder.current === order.id) return;
    hydratedOrder.current = order.id;
    setLines(order.lines.map(line => ({ productId: String(line.productId), quantity: String(line.quantity), unitType: line.unit === products.find(p => p.id === line.productId)?.bundleUnit ? 'bundle' : 'unit' })));
  }, [order?.id, products, productsQuery.isLoading]);
  const setLine = (index: number, field: keyof OrderLineDraft, value: string) => setLines(old => old.map((line, i) => i === index ? { ...line, [field]: value } : line));
  function submit(event: FormEvent) {
    event.preventDefault();
    const cleanLines = lines.filter(line => line.productId && Number(line.quantity) > 0).map(line => ({ productId: Number(line.productId), quantity: Number(line.quantity), unitType: line.unitType }));
    if (!cleanLines.length) { toast.error('Add at least one product and quantity.'); return; }
    const data = { supplierId: supplierId ? Number(supplierId) : null, expectedDeliveryDate: date || null, note: note.trim() || null, lines: cleanLines };
    const success = () => { toast.success(order ? 'Purchase-order request updated' : 'Purchase-order request sent for approval'); refreshOrders(qc); onSaved(); close(); };
    if (order) update.mutate({ orderId: order.id, data }, { onSuccess: success, onError: () => toast.error('Could not save purchase-order request') });
    else create.mutate({ data: { ...data, note: data.note || undefined } }, { onSuccess: success, onError: () => toast.error('Could not submit purchase-order request') });
  }
  const busy = create.isPending || update.isPending;
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#0b1649]/45 p-0 backdrop-blur-sm sm:items-center sm:p-5" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}><section className="max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-border bg-card p-5 shadow-2xl sm:rounded-2xl sm:p-7">
    <div className="mb-5 flex justify-between"><div><h2 className="zus-title text-2xl font-bold">{order ? 'Edit purchase-order request' : 'New purchase-order request'}</h2><p className="mt-1 text-xs text-muted-foreground">{order ? 'Update the supplier, delivery date, products or quantities before approval.' : 'The owner or manager will review this request before it becomes an issued order.'}</p></div><button className="btn btn-ghost p-2" onClick={close} aria-label="Close"><X size={18}/></button></div>
    <form onSubmit={submit} className="space-y-4" data-testid="form-purchase-order">
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs font-bold">Supplier<SearchableSelect data-testid="select-order-supplier" className="mt-1.5" value={supplierId} onChange={e => setSupplierId(e.target.value)}><option value="">Choose supplier before issue</option>{(suppliersQuery.data || []).filter(s => s.active || s.id === order?.supplierId).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</SearchableSelect></label><label className="text-xs font-bold">Expected delivery<input data-testid="input-order-expected-delivery" className="field mt-1.5" type="date" value={date} onChange={e => setDate(e.target.value)}/></label></div>
      <div className="space-y-2">{lines.map((line, i) => <div key={i} className="grid gap-2 rounded-xl border border-border p-3 sm:grid-cols-[minmax(0,1fr)_100px_130px_36px]">
        <SearchableSelect data-testid={`select-order-product-${i}`} required value={line.productId} onChange={e => { setLine(i, 'productId', e.target.value); const p = products.find(item => String(item.id) === e.target.value); if (p) setLine(i, 'unitType', 'unit'); }}><option value="">Choose product</option>{products.map(p => <option key={p.id} value={p.id}>{p.name} · {p.unit}/{p.bundleUnit}</option>)}</SearchableSelect>
        <input data-testid={`input-order-quantity-${i}`} className="field" type="number" min=".01" step=".01" required value={line.quantity} aria-label="Quantity" onChange={e => setLine(i, 'quantity', e.target.value)}/>
        <select data-testid={`select-order-unit-${i}`} className="field" value={line.unitType} onChange={e => setLine(i, 'unitType', e.target.value)}><option value="unit">{products.find(p => String(p.id) === line.productId)?.unit || 'Base unit'}</option><option value="bundle">{products.find(p => String(p.id) === line.productId)?.bundleUnit || 'Bundle unit'}</option></select>
        <button type="button" className="btn btn-ghost p-2" disabled={lines.length === 1} aria-label="Remove line" onClick={() => setLines(old => old.filter((_, j) => j !== i))}><X size={16}/></button>
      </div>)}</div>
      <button type="button" data-testid="button-add-order-line" onClick={() => setLines(old => [...old, { productId: '', quantity: '1', unitType: 'unit' }])} className="btn btn-soft text-xs"><Plus size={14}/> Add product</button>
      <label className="block text-xs font-bold">Order note<textarea className="field mt-1.5 min-h-16" value={note} onChange={e => setNote(e.target.value)}/></label>
      <div className="flex justify-end gap-2"><button type="button" className="btn btn-soft" onClick={close}>Cancel</button><button data-testid="button-save-purchase-order-draft" disabled={busy || productsQuery.isLoading} className="btn btn-primary">{busy ? 'Saving…' : order ? 'Save changes' : 'Submit for approval'}</button></div>
    </form>
  </section></div>;
}

export function OrdersPage() {
  const qc = useQueryClient();
  const query = useListPurchaseOrders({}, { query: { queryKey: getListPurchaseOrdersQueryKey({}) } });
  const [exportStartDate, setExportStartDate] = useState('');
  const [exportEndDate, setExportEndDate] = useState('');
  const [exportStatus, setExportStatus] = useState('');
  const exportFiltersValid = !exportStartDate || !exportEndDate || exportStartDate <= exportEndDate;
  const historyExport = useGetPurchaseOrderHistoryExport({
    startDate: exportStartDate || undefined,
    endDate: exportEndDate || undefined,
    status: exportStatus ? exportStatus as 'draft' | 'issued' | 'pending' | 'approved' | 'rejected' | 'partially_received' | 'received' | 'cancelled' : undefined,
  }, { query: { enabled: false } });
  const deliveries = useListDeliveries({ query: { queryKey: getListDeliveriesQueryKey() } });
  const lowDrafts = useCreateLowStockPurchaseOrderDrafts();
  const issue = useIssuePurchaseOrder();
  const cancel = useCancelPurchaseOrder();
  const [editor, setEditor] = useState<{ open: boolean; order?: PurchaseOrder }>({ open: false });
  const rows = query.data || [];
  async function exportHistory() {
    try {
      const result = await historyExport.refetch();
      if (result.error || !result.data) throw result.error || new Error('No export data was returned.');
      const header = ['Order number', 'Order ID', 'Actor', 'Action', 'Status', 'Decision note', 'Timestamp (UTC)'];
      const lines = result.data.map(event => [
        event.orderNumber || `Draft #${event.orderId}`,
        event.orderId,
        event.actor,
        event.action,
        titleCase(event.status),
        event.note || '',
        new Date(event.createdAt).toISOString(),
      ]);
      const csv = [header, ...lines].map(line => line.map(csvCell).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      const rangeLabel = exportStartDate || exportEndDate
        ? `${exportStartDate || 'all'}-to-${exportEndDate || 'all'}`
        : localDateKey(new Date());
      link.download = `purchase-order-history-${rangeLabel}${exportStatus ? `-${exportStatus}` : ''}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${lines.length} purchase-order history entr${lines.length === 1 ? 'y' : 'ies'}`);
    } catch {
      toast.error('Could not export purchase-order history');
    }
  }
  return <><Heading title="Purchase orders" detail="Staff requests are reviewed by an owner or manager before they are issued." action={<div className="flex flex-wrap gap-2"><button type="button" className="btn btn-soft" disabled={historyExport.isFetching || !exportFiltersValid} onClick={() => void exportHistory()}><Download size={15}/>{historyExport.isFetching ? 'Preparing export…' : 'Export history CSV'}</button><button className="btn btn-soft" disabled={lowDrafts.isPending} onClick={() => lowDrafts.mutate(undefined, { onSuccess: result => { refreshOrders(qc); toast.success(`${result.length} low-stock draft${result.length === 1 ? '' : 's'} created`); }, onError: () => toast.error('Could not create low-stock drafts') })}><RefreshCw size={15}/>{lowDrafts.isPending ? 'Preparing…' : 'Create low-stock drafts'}</button><button className="btn btn-primary" onClick={() => setEditor({ open: true })}><Plus size={15}/> New purchase order</button></div>}/>
    <section className="panel mb-4 p-4" aria-label="Purchase-order history export filters">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-xs font-bold">Start date<input aria-label="Export start date" className="field mt-1.5" type="date" value={exportStartDate} max={exportEndDate || undefined} onChange={event => setExportStartDate(event.target.value)}/></label>
        <label className="text-xs font-bold">End date<input aria-label="Export end date" className="field mt-1.5" type="date" value={exportEndDate} min={exportStartDate || undefined} onChange={event => setExportEndDate(event.target.value)}/></label>
        <label className="text-xs font-bold">Order status<select aria-label="Export order status" className="field mt-1.5" value={exportStatus} onChange={event => setExportStatus(event.target.value)}><option value="">All statuses</option>{['draft', 'issued', 'pending', 'approved', 'rejected', 'partially_received', 'received', 'cancelled'].map(status => <option key={status} value={status}>{titleCase(status)}</option>)}</select></label>
      </div>
      {!exportFiltersValid && <p className="mt-2 text-xs text-destructive" role="alert">Start date must be on or before end date.</p>}
    </section>
    <div className="mb-4 grid gap-3 sm:grid-cols-3">{[['Waiting approval', rows.filter(o => o.status === 'pending').length], ['Issued', rows.filter(o => o.status === 'issued' || o.status === 'partially_received' || o.status === 'approved').length], ['Linked deliveries', (deliveries.data || []).filter(d => d.purchaseOrderId).length]].map(([label, value]) => <div key={String(label)} className="panel p-4"><div className="mono text-2xl">{value}</div><div className="mt-1 text-[10px] text-muted-foreground">{label}</div></div>)}</div>
    {query.data && <OrderFollowUp orders={rows} deliveries={deliveries.data || []} deliveriesLoading={deliveries.isLoading} deliveriesError={deliveries.isError}/>}
    <div className="space-y-3">{query.isLoading ? <div className="panel p-6"><div className="skeleton h-5 w-1/3"/><div className="skeleton mt-4 h-16 w-full"/></div> : query.isError ? <div className="panel p-6 text-center"><p className="text-sm font-bold">Orders did not load</p><button className="btn btn-soft mt-3" onClick={() => void query.refetch()}>Retry</button></div> : rows.length === 0 ? <div className="panel"><PanelEmpty title="No purchase orders yet" detail="Create an editable draft, or prepare drafts from uncovered low-stock needs."/></div> : rows.map(order => <article key={order.id} id={`purchase-order-${order.id}`} className="panel scroll-mt-4 overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4"><div><div className="flex flex-wrap items-center gap-2 text-sm font-extrabold"><ShoppingBagIcon/> {order.orderNumber || `${order.status === 'pending' ? 'Request' : 'Draft'} · ${String(order.id).padStart(4, '0')}`}<span className={`rounded-full px-2.5 py-1 text-[10px] ${order.status === 'issued' || order.status === 'approved' ? 'bg-[#e5f0e9] text-[#28644b]' : order.status === 'draft' || order.status === 'pending' ? 'bg-[#f8eed6] text-[#875b15]' : 'bg-muted text-muted-foreground'}`}>{titleCase(order.status)}</span></div><div className="mt-1 text-[11px] text-muted-foreground">{order.supplierName || 'Supplier not selected'} · expected {dateText(order.expectedDeliveryDate)}</div></div><div className="no-print flex flex-wrap gap-2">{order.orderNumber ? <button className="btn btn-soft text-xs" title={`Print or save as ${order.orderNumber}.pdf`} onClick={(event) => printNamedDocument(event.currentTarget.closest('article')?.querySelector<HTMLElement>('[data-print-document="purchase-order"]') ?? null, purchaseOrderDocumentName(order.orderNumber!))}><Printer size={14}/> Print / Save PDF</button> : <button className="btn btn-soft text-xs" disabled title="Issue or approve the order to assign its official purchase-order number before printing."><Printer size={14}/> Print after issue</button>}{order.status === 'draft' && <><button className="btn btn-soft text-xs" onClick={() => setEditor({ open: true, order })}>Edit draft</button><button className="btn btn-primary text-xs" disabled={!order.supplierId || issue.isPending} title={!order.supplierId ? 'Select a supplier before issue' : undefined} onClick={() => issue.mutate({ orderId: order.id }, { onSuccess: issued => { refreshOrders(qc); toast.success(`Issued ${issued.orderNumber || 'purchase order'}`); }, onError: () => toast.error('Could not issue order') })}><Check size={14}/> Issue order</button></>}{['draft','issued','partially_received'].includes(order.status) && <button className="btn btn-ghost text-xs text-[#98483e]" disabled={cancel.isPending} onClick={() => { if (!window.confirm(`Cancel ${order.orderNumber || 'this purchase order'}?`)) return; cancel.mutate({ orderId: order.id }, { onSuccess: () => { refreshOrders(qc); toast.success('Purchase order cancelled'); }, onError: () => toast.error('Could not cancel order') }); }}>Cancel order</button>}</div></div>
      <div className="grid gap-2 p-4 sm:grid-cols-2">{order.lines.map(line => <div key={line.productId} className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2.5"><span className="text-xs font-bold">{line.productName}</span><span className="mono text-[11px]">{line.receivedQuantity}/{line.quantity} {line.unit}</span></div>)}</div>
      {order.note && <p className="px-5 pb-3 text-xs text-muted-foreground">{order.note}</p>}
      <OrderHistory orderId={order.id}/>
      {((deliveries.data || []).filter(d => d.purchaseOrderId === order.id)).map(d => <div key={d.id} className="no-print border-t border-border/70 bg-[#f8f6ef] px-5 py-3 text-xs"><b>Delivery {d.purchaseOrderNumber || order.orderNumber || `#${d.id}`}</b><span className="ml-2 text-muted-foreground">{titleCase(d.status)} · {dateText(d.createdAt)}</span><a className="ml-2 text-primary underline" href={`/deliveries#delivery-${d.id}`}>View delivery</a></div>)}
      {order.orderNumber && <div className="print-only-document p-8 text-black" data-print-document="purchase-order">
        <header className="flex items-start justify-between border-b-2 border-black pb-5">
          <div><p className="text-xs font-bold uppercase tracking-[.18em]">ZUS Stockroom · Store Operations</p><h1 className="mt-3 text-3xl font-extrabold">Purchase order</h1><p className="mt-1 text-sm">{order.orderNumber}</p></div>
          <div className="text-right text-sm"><p className="font-bold">{titleCase(order.status)}</p><p className="mt-2">Order date · {dateText(order.createdAt)}</p><p className="mt-1">Expected delivery · {dateText(order.expectedDeliveryDate)}</p></div>
        </header>
        <div className="mt-6 grid grid-cols-2 gap-8 text-sm">
          <section><h2 className="mb-2 font-bold uppercase tracking-wide">Supplier</h2><p>{order.supplierName || '—'}</p></section>
          <section><h2 className="mb-2 font-bold uppercase tracking-wide">Outlet</h2><p>{order.outlet.name}</p>{order.outlet.businessAddress && <p className="mt-1 whitespace-pre-line">{order.outlet.businessAddress}</p>}{order.outlet.contactPhone && <p className="mt-1">{order.outlet.contactPhone}</p>}</section>
        </div>
        <table className="mt-8 w-full border-collapse text-sm">
          <thead><tr><th className="border-b-2 border-black py-2 text-left">Product</th><th className="border-b-2 border-black py-2 text-right">Order quantity</th><th className="border-b-2 border-black py-2 pl-4 text-left">Unit</th></tr></thead>
          <tbody>{order.lines.map((line) => <tr key={line.productId}><td className="border-b border-gray-300 py-3">{line.productName}</td><td className="border-b border-gray-300 py-3 text-right">{quantityText(line.quantity)}</td><td className="border-b border-gray-300 py-3 pl-4">{line.unit}</td></tr>)}</tbody>
        </table>
        {order.note && <section className="mt-6 text-sm"><h2 className="font-bold">Notes</h2><p className="mt-1 whitespace-pre-line">{order.note}</p></section>}
        <footer className="mt-10 border-t border-gray-300 pt-3 text-xs">Requested by {order.requestedBy}{order.reviewedBy ? ` · Reviewed by ${order.reviewedBy}` : ''}</footer>
      </div>}
    </article>)}</div>
    {editor.open && <OrderEditor order={editor.order} close={() => setEditor({ open: false })} onSaved={() => refreshOrders(qc)}/>}
  </>;
}

function OrderHistory({ orderId }: { orderId: number }) {
  const [open, setOpen] = useState(false);
  const query = useGetPurchaseOrderHistory(orderId, { query: { enabled: open } });
  const events = query.data || [];
  return <section className="border-t border-border/70">
    <button
      type="button"
      className="flex w-full items-center gap-2 px-5 py-3 text-left text-xs font-bold text-primary hover:bg-muted/40"
      aria-expanded={open}
      onClick={() => setOpen(value => !value)}
    >
      <Clock3 size={14}/>{open ? 'Hide order history' : 'View order history'}
    </button>
    {open && <div className="border-t border-border/50 bg-muted/20 px-5 py-4">
      {query.isLoading ? <p className="text-xs text-muted-foreground">Loading history…</p>
        : query.isError ? <div className="flex items-center justify-between gap-3 text-xs"><span>Order history did not load.</span><button className="text-primary underline" onClick={() => void query.refetch()}>Retry</button></div>
        : events.length === 0 ? <p className="text-xs text-muted-foreground">No history has been recorded for this order yet.</p>
          : <ol className="space-y-3">
            {events.map((event: PurchaseOrderHistoryEntry) => <li key={event.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 text-xs">
              <div><b>{event.action}</b><span className="ml-2 text-muted-foreground">by {event.actor}</span><div className="mt-1 text-[10px] text-muted-foreground">Status: {titleCase(event.status)}</div>{event.note && <p className="mt-1 whitespace-pre-line text-muted-foreground">Decision note: {event.note}</p>}</div>
              <time className="text-[10px] text-muted-foreground" dateTime={event.createdAt}>{dateTimeText(event.createdAt)}</time>
            </li>)}
          </ol>}
    </div>}
  </section>;
}

function ShoppingBagIcon() { return <span className="inline-grid h-8 w-8 place-items-center rounded-lg bg-[#e7ebf6] text-primary"><Package size={16}/></span>; }

type DeliveryLineDraft = {
  productId: string;
  quantity: string;
  tempC: string;
  expiryDate: string;
  expiryLater: boolean;
  sectionId: string;
};
function DeliveryEditor({ close }: { close: () => void }) {
  const qc = useQueryClient();
  const productsQuery = useListProducts({ active: true }, { query: { queryKey: getListProductsQueryKey({ active: true }) } });
  const categoriesQuery = useListProductCategories({ query: { queryKey: getListProductCategoriesQueryKey() } });
  const suppliersQuery = useListSuppliers({ query: { queryKey: getListSuppliersQueryKey() } });
  const ordersQuery = useListPurchaseOrders({}, { query: { queryKey: getListPurchaseOrdersQueryKey({}) } });
  const sectionsQuery = useListStockSections({ query: { queryKey: getListStockSectionsQueryKey() } });
  const create = useCreateDelivery();
  const [orderId, setOrderId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [lines, setLines] = useState<DeliveryLineDraft[]>([{ productId: '', quantity: '1', tempC: '', expiryDate: '', expiryLater: false, sectionId: '' }]);
  const orders = (ordersQuery.data || []).filter(o => ['issued', 'partially_received', 'approved'].includes(o.status));
  const chosen = orders.find(o => String(o.id) === orderId);
  const products = productsQuery.data || [];
  const changeLine = (i: number, field: keyof DeliveryLineDraft, value: string | boolean) => setLines(old => old.map((line, n) => n === i ? { ...line, [field]: value } : line));
  function selectOrder(value: string) {
    setOrderId(value);
    const po = orders.find(o => String(o.id) === value);
    if (po) { setSupplierId(String(po.supplierId || '')); setLines(po.lines.filter(l => l.quantity - l.receivedQuantity > 0).map(l => ({ productId: String(l.productId), quantity: String(Math.max(0, (l.quantity - l.receivedQuantity) * l.conversionFactor)), tempC: '', expiryDate: '', expiryLater: false, sectionId: '' }))); }
    else setLines([{ productId: '', quantity: '1', tempC: '', expiryDate: '', expiryLater: false, sectionId: '' }]);
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    const submitted = lines.filter(l => l.productId && Number(l.quantity) > 0);
    if (!submitted.length || submitted.some(l => !l.sectionId)) { toast.error('Choose a stock section for every received item.'); return; }
    const missingRequiredExpiry = submitted.some((line) => {
      const product = products.find((entry) => String(entry.id) === line.productId);
      return product?.trackExpiry && !line.expiryDate && !line.expiryLater;
    });
    if (missingRequiredExpiry) {
      toast.error('Add the expiry date, or mark that it cannot be seen yet.');
      return;
    }
    create.mutate({ data: { supplierId: supplierId ? Number(supplierId) : null, purchaseOrderId: orderId ? Number(orderId) : null, lines: submitted.map(l => ({ productId: Number(l.productId), quantity: Number(l.quantity), tempC: l.tempC ? Number(l.tempC) : null, expiryDate: l.expiryDate || null, expiryLater: l.expiryLater, sectionId: Number(l.sectionId) })) } }, {
      onSuccess: () => { toast.success('Delivery recorded'); refreshOrders(qc); void qc.invalidateQueries({ queryKey: getListStockMovementsQueryKey() }); close(); },
      onError: () => toast.error('Could not record delivery'),
    });
  }
  const busy = productsQuery.isLoading || categoriesQuery.isLoading || suppliersQuery.isLoading || ordersQuery.isLoading || sectionsQuery.isLoading;
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#0b1649]/45 p-0 sm:items-center sm:p-5"><section className="max-h-[92dvh] w-full max-w-3xl overflow-y-auto rounded-t-2xl bg-card p-5 sm:rounded-2xl sm:p-7"><div className="mb-5 flex justify-between"><div><h2 className="zus-title text-2xl font-bold">Receive delivery</h2><p className="mt-1 text-xs text-muted-foreground">Received quantities are entered in each product’s base unit.</p></div><button onClick={close} className="btn btn-ghost p-2"><X size={18}/></button></div>
    <form onSubmit={submit} className="space-y-4"><div className="grid gap-3 sm:grid-cols-2"><label className="text-xs font-bold">Link purchase order<SearchableSelect className="mt-1.5" value={orderId} onChange={e => selectOrder(e.target.value)}><option value="">No linked order</option>{orders.map(o => <option key={o.id} value={o.id}>{o.orderNumber || `Draft ${o.id}`} · {o.supplierName || 'Supplier'}</option>)}</SearchableSelect></label><label className="text-xs font-bold">Supplier<SearchableSelect className="mt-1.5" required value={supplierId} onChange={e => setSupplierId(e.target.value)}><option value="">Choose supplier</option>{(suppliersQuery.data || []).filter(s => s.active || s.id === chosen?.supplierId).map(s => <option key={s.id} value={s.id}>{s.active ? s.name : `${s.name} · archived on linked order`}</option>)}</SearchableSelect></label></div>
       {chosen && <div className="rounded-xl bg-[#e7ebf6] p-3 text-xs"><b>{chosen.orderNumber || `Order ${chosen.id}`}</b> · {chosen.supplierName}<div className="mt-2 flex flex-wrap gap-2">{chosen.lines.map((line, i) => <span key={`${line.productId}-${i}`} className="rounded-md bg-white/75 px-2 py-1 text-[10px]">{line.productName}: {Math.max(0, line.quantity - line.receivedQuantity)} {line.unit} outstanding</span>)}</div></div>}
       <div className="space-y-2">{lines.map((line, i) => { const product = products.find(p => String(p.id) === line.productId); const category = product ? (categoriesQuery.data || []).find(c => c.key === product.category) : undefined; const customTemp = Boolean(product && product.tempMinC !== null && product.tempMaxC !== null); const minTemp = customTemp ? product?.tempMinC ?? null : category?.receivingTempMinC ?? null; const maxTemp = customTemp ? product?.tempMaxC ?? null : category?.receivingTempMaxC ?? null; const poLine = chosen?.lines.find(l => String(l.productId) === line.productId); return <div key={i} className="rounded-xl border border-border p-3">
        <div className="grid gap-2 sm:grid-cols-[1fr_110px_1fr]"><label className="text-[10px] font-bold">Product<SearchableSelect required className="mt-1" value={line.productId} onChange={e => setLines(old => old.map((draft, index) => index === i ? { ...draft, productId: e.target.value, expiryDate: '', expiryLater: false } : draft))}><option value="">Choose product</option>{(chosen ? chosen.lines.filter(l => l.quantity > l.receivedQuantity).map(l => products.find(p => p.id === l.productId)).filter((p): p is Product => Boolean(p)) : products).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</SearchableSelect></label><label className="text-[10px] font-bold">Received ({product?.unit || 'base units'})<input required className="field mt-1" type="number" min=".01" step=".01" value={line.quantity} onChange={e => changeLine(i, 'quantity', e.target.value)}/></label><label className="text-[10px] font-bold">Stock section<SearchableSelect required className="mt-1" value={line.sectionId} onChange={e => changeLine(i, 'sectionId', e.target.value)}><option value="">Choose area</option>{(sectionsQuery.data || []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</SearchableSelect></label></div>
         {poLine && <div className="mt-2 text-[10px] text-muted-foreground">Outstanding: {Math.max(0, poLine.quantity - poLine.receivedQuantity)} {poLine.unit}</div>}
         {product && (category?.receivingHandlingSop || minTemp !== null || maxTemp !== null) && <div className="mt-2 rounded-lg bg-[#f5f1e7] px-3 py-2 text-[10px] leading-4 text-muted-foreground"><b>{category?.name || product.category} receiving guidance</b>{category?.receivingHandlingSop && <p className="mt-1 whitespace-pre-wrap">{category.receivingHandlingSop}</p>}{(minTemp !== null || maxTemp !== null) && <p className="mt-1 font-bold">{customTemp ? 'Product-specific range' : 'Category range'}: {minTemp ?? '—'}°C to {maxTemp ?? '—'}°C</p>}</div>}
        <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto]"><label className="text-[10px] font-bold">Probe temperature °C<input className="field mt-1" type="number" step=".1" value={line.tempC} onChange={e => changeLine(i, 'tempC', e.target.value)}/></label><label className="text-[10px] font-bold">Expiry {product?.trackExpiry ? 'date' : '(optional)'}<input className="field mt-1" type="date" required={Boolean(product?.trackExpiry && !line.expiryLater)} value={line.expiryDate} onChange={e => { changeLine(i, 'expiryDate', e.target.value); if (e.target.value) changeLine(i, 'expiryLater', false); }}/></label><button type="button" className="btn btn-ghost self-end p-2" disabled={lines.length === 1} onClick={() => setLines(old => old.filter((_, n) => n !== i))}><X size={15}/></button></div>
        {product?.trackExpiry && !line.expiryDate && <label className="mt-2 flex items-center gap-2 text-[10px] font-semibold"><input type="checkbox" checked={line.expiryLater} onChange={e => changeLine(i, 'expiryLater', e.target.checked)}/> Can&apos;t see the date yet; add it later in Expiry dates.</label>}
      </div>; })}</div>
      <button type="button" className="btn btn-soft text-xs" onClick={() => setLines(old => [...old, { productId: chosen ? String(chosen.lines.find(l => l.quantity > l.receivedQuantity)?.productId || '') : '', quantity: '1', tempC: '', expiryDate: '', expiryLater: false, sectionId: '' }])}><Plus size={14}/> Add {chosen ? 'split batch' : 'product'}</button>
      <div className="flex justify-end gap-2"><button type="button" onClick={close} className="btn btn-soft">Cancel</button><button disabled={busy || create.isPending} className="btn btn-primary">{create.isPending ? 'Recording…' : 'Record delivery'}</button></div>
    </form></section></div>;
}

function DeliveryRows({ rows, canReview, approvalOnly = false }: { rows: Delivery[]; canReview: boolean; approvalOnly?: boolean }) {
  const qc = useQueryClient();
  const decide = useDecideDelivery();
  const [notes, setNotes] = useState<Record<number, string>>({});
  const visible = approvalOnly ? rows.filter(d => d.status === 'pending_approval') : rows;
  function decideItem(d: Delivery, decision: 'accepted' | 'rejected' | 'returned') {
    const note = (notes[d.id] || '').trim();
    if (decision !== 'accepted' && !note) { toast.error('A note is required to reject or return a held delivery.'); return; }
    decide.mutate({ deliveryId: d.id, data: { decision, note: note || undefined } }, { onSuccess: () => { toast.success(`Delivery ${decision}`); refreshOrders(qc); }, onError: () => toast.error('Could not update delivery') });
  }
  return <div className="space-y-3">{visible.map(d => <article id={`delivery-${d.id}`} className="panel scroll-mt-4 overflow-hidden" key={d.id}>
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4"><div><div className="flex items-center gap-2 text-sm font-extrabold"><Truck size={16} className="text-primary"/> {d.purchaseOrderNumber || `Delivery ${d.id}`} <span className="rounded-full bg-[#f8eed6] px-2.5 py-1 text-[10px]">{titleCase(d.status)}</span></div><p className="mt-1 text-[11px] text-muted-foreground">{d.supplierName || 'Supplier'} · {dateText(d.createdAt)}</p>{d.decidedBy && <p className="mt-1 text-[10px] text-muted-foreground">Reviewed by {d.decidedBy}</p>}</div>{d.purchaseOrderId && <a href={`/orders#purchase-order-${d.purchaseOrderId}`} className="btn btn-soft text-xs">Related order <ArrowRight size={13}/></a>}</div>
    <div className="space-y-2 p-4">{d.lines.map((l,i) => <div key={`${l.productId}-${i}`} className="grid gap-2 rounded-xl bg-muted/45 p-3 sm:grid-cols-[1fr_auto]"><div><b className="text-xs">{l.productName}</b><div className="mt-1 text-[10px] text-muted-foreground">{l.quantity} received · {l.sectionName || 'Section unavailable'}{l.expiryDate ? ` · expires ${dateText(l.expiryDate)}` : l.expiryLater ? ' · expiry date not visible yet' : ' · no expiry'}{l.tempC !== null ? ` · ${l.tempC}°C` : ''}</div>{l.issue && <div className="mt-1 text-[10px] font-bold text-[#98483e]">{l.issue}</div>}</div><span className={`self-center text-[10px] font-bold ${l.checkStatus === 'pass' ? 'text-[#28644b]' : 'text-[#875b15]'}`}>{l.checkStatus === 'pass' ? 'Checks passed' : 'Review flag'}</span></div>)}</div>
    {d.decisionNote && <p className="border-t border-border bg-[#f8eed6] px-5 py-3 text-xs">Decision note: {d.decisionNote}</p>}
    {canReview && d.status === 'pending_approval' && <div className="border-t border-border p-4"><label className="text-[10px] font-bold">Reviewer note<textarea className="field mt-1 min-h-16" value={notes[d.id] || ''} onChange={e => setNotes(old => ({ ...old, [d.id]: e.target.value }))} placeholder="Required to reject or return"/></label><div className="mt-2 flex justify-end gap-2"><button className="btn btn-soft text-xs" disabled={decide.isPending} onClick={() => decideItem(d, 'returned')}>Return</button><button className="btn btn-soft text-xs" disabled={decide.isPending} onClick={() => decideItem(d, 'rejected')}>Reject</button><button className="btn btn-primary text-xs" disabled={decide.isPending} onClick={() => decideItem(d, 'accepted')}><Check size={14}/> Accept</button></div></div>}
  </article>)}
    {visible.length === 0 && <div className="panel"><PanelEmpty title={approvalOnly ? 'No deliveries held for review' : 'No deliveries yet'} detail={approvalOnly ? 'Held receiving records will appear here for authorized review.' : 'Log supplier arrivals and keep stock checks traceable.'}/></div>}
  </div>;
}
export function DeliveriesPage() {
  const query = useListDeliveries({ query: { queryKey: getListDeliveriesQueryKey() } });
  const [open, setOpen] = useState(false);
  return <><Heading title="Deliveries" detail="Receive against an issued order or log an arrival directly. Problematic checks are reviewed in Approvals." action={<button className="btn btn-primary" onClick={() => setOpen(true)}><Plus size={15}/> Receive delivery</button>}/>{query.isError ? <div className="panel p-6 text-center"><p className="text-sm font-bold">Deliveries did not load</p><button className="btn btn-soft mt-3" onClick={() => void query.refetch()}>Retry</button></div> : query.isLoading ? <div className="panel p-8"><div className="skeleton h-12 w-full"/></div> : <DeliveryRows rows={query.data || []} canReview={false}/ >}{open && <DeliveryEditor close={() => setOpen(false)}/>}</>;
}
export function ApprovalsPage() {
  const deliveries = useListDeliveries({ query: { queryKey: getListDeliveriesQueryKey() } });
  const orders = useListPurchaseOrders({}, { query: { queryKey: getListPurchaseOrdersQueryKey({}) } });
  const user = useGetCurrentUser({ query: { queryKey: getGetCurrentUserQueryKey() } });
  const decideOrder = useDecidePurchaseOrder();
  const qc = useQueryClient();
  const [section, setSection] = useState<'purchase-orders' | 'receiving'>('purchase-orders');
  const [editingOrder, setEditingOrder] = useState<PurchaseOrder>();
  const [decisionNotes, setDecisionNotes] = useState<Record<number, string>>({});
  const canReview = ['owner','admin','supervisor'].includes(user.data?.role || '');
  const pendingOrders = (orders.data || []).filter(o => o.status === 'pending');
  const heldDeliveries = (deliveries.data || []).filter(delivery => delivery.status === 'pending_approval');
  const decide = (orderId: number, decision: 'approved' | 'rejected') => {
    const note = decisionNotes[orderId]?.trim();
    if (decision === 'rejected' && !note) {
      toast.error('Add a reason before rejecting this purchase order.');
      return;
    }
    decideOrder.mutate({ orderId, data: { decision, ...(note ? { note } : {}) } }, {
      onSuccess: (updated) => {
        toast.success(decision === 'approved' ? `Approved and issued ${updated.orderNumber || 'purchase order'}` : 'Purchase-order request rejected');
        void qc.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() });
      },
      onError: (error) => toast.error(error.message || 'Could not review purchase order'),
    });
  };
  return <>
    <Heading title="Approvals" detail="Review purchase orders and problematic receiving checks in separate sections."/>
    <div role="tablist" aria-label="Approval sections" className="mb-5 flex w-full gap-2 overflow-x-auto rounded-xl bg-[#e9edf0] p-1 sm:w-fit">
      <button role="tab" aria-selected={section === 'purchase-orders'} type="button" onClick={() => setSection('purchase-orders')} className={`shrink-0 rounded-lg px-4 py-2.5 text-xs font-bold ${section === 'purchase-orders' ? 'bg-white text-primary shadow-sm' : 'text-muted-foreground'}`}>Purchase orders <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5">{pendingOrders.length}</span></button>
      <button role="tab" aria-selected={section === 'receiving'} type="button" onClick={() => setSection('receiving')} className={`shrink-0 rounded-lg px-4 py-2.5 text-xs font-bold ${section === 'receiving' ? 'bg-white text-primary shadow-sm' : 'text-muted-foreground'}`}>Receiving checks <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5">{heldDeliveries.length}</span></button>
    </div>
    {section === 'purchase-orders' ? <>
      {orders.isLoading ? <div className="panel p-8"><div className="skeleton h-12 w-full"/></div>
        : orders.isError ? <div className="panel p-5"><button className="btn btn-soft" onClick={() => void orders.refetch()}>Retry purchase orders</button></div>
        : pendingOrders.length === 0 ? <div className="panel"><PanelEmpty title="No purchase orders waiting" detail="New staff requests will appear here for review."/></div>
        : <div className="space-y-3">{pendingOrders.map(order => <article key={order.id} className="panel p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><b className="text-sm">Purchase-order request #{order.id}</b><span className="rounded-full bg-[#f8eed6] px-2.5 py-1 text-[10px] font-bold text-[#875b15]">Pending approval</span></div>
              <p className="mt-1 text-xs text-muted-foreground">{order.requestedBy} · {order.supplierName || 'Supplier not selected'} · expected {dateText(order.expectedDeliveryDate)}</p>
              <div className="mt-3 flex flex-wrap gap-2">{order.lines.map(line => <span key={line.productId} className="rounded-lg bg-muted px-2.5 py-1.5 text-[11px]">{line.productName} · {line.quantity} {line.unit}</span>)}</div>
              {order.note && <p className="mt-2 whitespace-pre-line text-xs text-muted-foreground">{order.note}</p>}
            </div>
            {canReview && <button type="button" className="btn btn-soft shrink-0 text-xs" onClick={() => setEditingOrder(order)}>Edit request</button>}
          </div>
          {canReview && <div className="mt-4 grid gap-2 border-t border-border pt-4 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
            <label className="text-[11px] font-semibold text-muted-foreground sm:col-span-3">Decision note <span className="font-normal">(required when rejecting)</span>
              <textarea className="field mt-1.5 min-h-16" maxLength={1000} value={decisionNotes[order.id] || ''} onChange={event => setDecisionNotes(notes => ({ ...notes, [order.id]: event.target.value }))} placeholder="Add a reason or instructions for the requester"/>
            </label>
            <span className="self-center text-[10px] text-muted-foreground">Approving assigns the monthly PO number and issues the order.</span>
            <button type="button" className="btn btn-soft text-xs" disabled={decideOrder.isPending || !decisionNotes[order.id]?.trim()} onClick={() => decide(order.id, 'rejected')}>Reject request</button>
            <button type="button" className="btn btn-primary text-xs" disabled={decideOrder.isPending || !order.supplierId || !order.lines.length} title={!order.supplierId ? 'Select a supplier before approval' : undefined} onClick={() => decide(order.id, 'approved')}><Check size={14}/> Approve and issue</button>
          </div>}
        </article>)}</div>}
    </> : <>
      {deliveries.isLoading ? <div className="panel p-8"><div className="skeleton h-12 w-full"/></div>
        : deliveries.isError ? <div className="panel p-5"><button className="btn btn-soft" onClick={() => void deliveries.refetch()}>Retry receiving checks</button></div>
        : <DeliveryRows rows={deliveries.data || []} canReview={canReview} approvalOnly/>}
    </>}
    {editingOrder && <OrderEditor order={editingOrder} close={() => setEditingOrder(undefined)} onSaved={() => void qc.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() })}/>}
  </>;
}

type ScopeSelection = { scope: StockCountInputScope; category: string; section: string; product: string };
type WorkbookUploadPreview = Pick<WorkbookCountImport, 'validRows' | 'issues'> & { drafts: Record<string, CountDraft> };
export function CountsPage() {
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  const counts = useListStockCounts({ query: { queryKey: getListStockCountsQueryKey() } });
  const products = useListProducts({ active: true }, { query: { queryKey: getListProductsQueryKey({ active: true }) } });
  const categories = useListProductCategories({ query: { queryKey: getListProductCategoriesQueryKey() } });
  const sections = useListStockSections({ query: { queryKey: getListStockSectionsQueryKey() } });
  const create = useCreateStockCount();
  const [scope, setScope] = useState<ScopeSelection>({ scope: 'all', category: '', section: '', product: '' });
  const [countDate, setCountDate] = useState(() => localDateKey(new Date()));
  const [notes, setNotes] = useState('');
  function start(e: FormEvent) {
    e.preventDefault();
    const data = { scope: scope.scope, countDate, notes: notes.trim(), ...(scope.scope === 'category' ? { category: scope.category } : {}), ...(scope.scope === 'section' ? { sectionId: Number(scope.section) } : {}), ...(scope.scope === 'product' ? { productId: Number(scope.product) } : {}) };
    create.mutate({ data }, { onSuccess: c => { toast.success('Count started'); void qc.invalidateQueries({ queryKey: getListStockCountsQueryKey() }); setLocation(`/counts/${c.id}`); }, onError: () => toast.error('Could not start count') });
  }
  const rows = counts.data || [];
  return <>
    <Heading title="Stock Count" detail="Count each product by storage section. Blank counts stay unchanged; enter 0 only when you counted zero."/>
    <section className="panel mb-5 p-4 sm:p-5">
      <div className="mb-4"><h2 className="text-sm font-extrabold">New stocktake</h2><p className="mt-1 text-xs text-muted-foreground">Choose a date and scope. Enter quantities on the next screen; expected stock stays hidden until review.</p></div>
      <form onSubmit={start} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block text-xs font-bold">Count date<input required type="date" className="field mt-1.5" value={countDate} onChange={event => setCountDate(event.target.value)}/></label>
          <label className="block text-xs font-bold">Count scope<select className="field mt-1.5" value={scope.scope} onChange={event => setScope({ ...scope, scope: event.target.value as StockCountInputScope })}><option value="all">All products and sections</option><option value="section">Storage section</option><option value="category">Product category</option><option value="product">Single product</option></select></label>
          {scope.scope === 'section' && <label className="block text-xs font-bold">Storage section<select required className="field mt-1.5" value={scope.section} onChange={event => setScope({ ...scope, section: event.target.value })}><option value="">Choose storage section</option>{(sections.data || []).map(section => <option key={section.id} value={section.id}>{section.name}</option>)}</select></label>}
          {scope.scope === 'category' && <label className="block text-xs font-bold">Product category<select required className="field mt-1.5" value={scope.category} onChange={event => setScope({ ...scope, category: event.target.value })}><option value="">Choose category</option>{(categories.data || []).map(category => <option key={category.id} value={category.key}>{category.name}</option>)}</select></label>}
          {scope.scope === 'product' && <label className="block text-xs font-bold">Product<select required className="field mt-1.5" value={scope.product} onChange={event => setScope({ ...scope, product: event.target.value })}><option value="">Choose product</option>{(products.data || []).map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>}
        </div>
        <label className="block text-xs font-bold">Notes <span className="font-normal text-muted-foreground">(optional)</span><textarea maxLength={1000} className="field mt-1.5 min-h-20" placeholder="Reason for the count or any relevant notes" value={notes} onChange={event => setNotes(event.target.value)}/></label>
        <div className="flex justify-end"><button className="btn btn-primary" disabled={create.isPending || !countDate || (scope.scope === 'section' && !scope.section) || (scope.scope === 'category' && !scope.category) || (scope.scope === 'product' && !scope.product)}><ClipboardCheck size={15}/>{create.isPending ? 'Starting…' : 'Start stocktake'}</button></div>
      </form>
    </section>
    <section className="panel mt-5 overflow-hidden">
      <div className="border-b border-border px-5 py-4"><b className="text-sm">Stocktake history</b><p className="mt-1 text-[11px] text-muted-foreground">Every saved count, newest first.</p></div>
      {counts.isLoading ? <div className="p-5"><div className="skeleton h-12 w-full"/></div> : counts.isError ? <div className="p-5"><button className="btn btn-soft" onClick={() => void counts.refetch()}>Retry</button></div> : rows.length ? rows.map(c => <Link href={`/counts/${c.id}`} key={c.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-5 py-4 last:border-0 hover:bg-muted/40"><div className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-xl bg-[#e7ebf6] text-primary"><ClipboardCheck size={17}/></span><div><b className="text-xs">{titleCase(c.scope)} count · #{c.id}</b><p className="mt-1 text-[10px] text-muted-foreground">{c.createdBy} · Count date {dateText(c.countDate)} · {c.lines.length} product-section pairs</p>{c.notes && <p className="mt-1 text-[10px] text-muted-foreground">{c.notes}</p>}{c.workbook && <p className="mt-1 truncate text-[10px] text-muted-foreground">Submitted workbook · {c.workbook.name} · {c.workbook.uploadedBy} · {dateTimeText(c.workbook.submittedAt)}</p>}</div></div><span className="text-xs font-bold">{titleCase(c.status)} <ArrowRight className="ml-1 inline" size={14}/></span></Link>) : <PanelEmpty title="No stocktakes yet" detail="Start a count and record the stock physically on the shelf."/>}
    </section>
  </>;
}

export function CountDetailPage() {
  const params = useParams<{ countId: string }>();
  const countId = Number(params.countId);
  const qc = useQueryClient();
  const query = useGetStockCount(countId, { query: { enabled: Number.isFinite(countId), queryKey: getGetStockCountQueryKey(countId) } });
  const submitCount = useSubmitStockCount();
  const requestWorkbookUploadUrl = useRequestStockCountWorkbookUploadUrl();
  const currentUser = useGetCurrentUser({ query: { queryKey: getGetCurrentUserQueryKey() } });
  const products = useListProducts({ active: true }, { query: { queryKey: getListProductsQueryKey({ active: true }) } });
  const sections = useListStockSections({ query: { queryKey: getListStockSectionsQueryKey() } });
  const batches = useListStockBatches({}, { query: { queryKey: getListStockBatchesQueryKey({}) } });
  const [counts, setCounts] = useState<Record<string, CountDraft>>({});
  const [review, setReview] = useState(false);
  useHideMobileAppChrome(review);
  const [acknowledgedMovementSignature, setAcknowledgedMovementSignature] = useState<string | null>(null);
  const [uploadPreview, setUploadPreview] = useState<WorkbookUploadPreview | null>(null);
  const [sourceWorkbook, setSourceWorkbook] = useState<File | null>(null);
  const [workbookUploadInProgress, setWorkbookUploadInProgress] = useState(false);
  const workbookSubmitInFlight = useRef(false);
  const [activeOutletId, setActiveOutletId] = useState<number | null>(null);
  const [countNotes, setCountNotes] = useState('');
  const notesInitializedCountId = useRef<number | null>(null);
  const groupBy = 'section' as const;
  const [search, setSearch] = useState('');
  const [storageFilter, setStorageFilter] = useState<Set<string> | null>(null);
  const [storageSearch, setStorageSearch] = useState('');
  const [storageFilterOpen, setStorageFilterOpen] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(() => new Set());
  const expandedSectionsCountId = useRef<number | null>(null);
  const count = query.data;
  const enteredLineCount = count?.lines.filter(hasEntry).length ?? 0;
  useEffect(() => {
    if (!count || notesInitializedCountId.current === count.id) return;
    notesInitializedCountId.current = count.id;
    setCountNotes(count.notes || '');
  }, [count]);
  const storageNames = [...new Set((count?.lines || []).map((line) => line.sectionName || 'Outlet total'))]
    .sort((a, b) => a.localeCompare(b));
  const matchingStorageNames = storageNames.filter((name) =>
    name.toLocaleLowerCase().includes(storageSearch.trim().toLocaleLowerCase()),
  );
  const selectedStorageCount = storageFilter === null ? storageNames.length : storageFilter.size;
  const movements = count?.movements ?? [];
  const movementSignature = movements.map((movement) => movement.id).join(',');
  const movementsAcknowledged = acknowledgedMovementSignature === movementSignature;
  const productMap = useMemo(() => new Map((products.data || []).map(p => [p.id, p])), [products.data]);
  const outlet = currentUser.data?.outlets.find((candidate) => candidate.id === activeOutletId);
  const outletName = outlet?.name || currentUser.data?.storeName || 'Selected outlet';
  useEffect(() => {
    if (activeOutletId === null && currentUser.data?.activeOutletId) {
      setActiveOutletId(currentUser.data.activeOutletId);
    }
  }, [activeOutletId, currentUser.data?.activeOutletId]);
  useEffect(() => {
    if (!count || expandedSectionsCountId.current === count.id) return;
    expandedSectionsCountId.current = count.id;
    setExpandedSections(new Set([...new Set(count.lines.map((line) => line.sectionName || 'Outlet total'))].slice(0, 2)));
  }, [count?.id]);
  useEffect(() => {
    const handleOutletChange = (event: Event) => {
      const outletId = Number((event as CustomEvent<number>).detail);
      if (Number.isSafeInteger(outletId) && outletId > 0) setActiveOutletId(outletId);
      setUploadPreview(null);
      setSourceWorkbook(null);
    };
    window.addEventListener('zus-active-outlet-change', handleOutletChange);
    return () => window.removeEventListener('zus-active-outlet-change', handleOutletChange);
  }, []);
  function bundleSize(line: StockCountLine) {
    const product = productMap.get(line.productId);
    return product?.bundleUnit && (product.bundleSize || 1) > 1 ? product.bundleSize! : 1;
  }
  function savedDraft(line: StockCountLine) {
    if (line.countedQuantity === null) return { bundles: '', loose: '' };
    return splitCount(line.countedQuantity, bundleSize(line));
  }
  function draft(line: StockCountLine) {
    return counts[keyFor(line.productId, line.sectionId)] ?? savedDraft(line);
  }
  function hasEntry(line: StockCountLine) {
    return hasCountInput(draft(line));
  }
  function calculate(line: StockCountLine) {
    return countTotal(draft(line), bundleSize(line));
  }
  function matchesStorageFilter(line: StockCountLine) {
    return storageFilter === null || storageFilter.has(line.sectionName || 'Outlet total');
  }
  function toggleStorageFilter(name: string, checked: boolean) {
    setStorageFilter((current) => {
      const next = new Set(current ?? storageNames);
      if (checked) next.add(name);
      else next.delete(name);
      return next.size === storageNames.length ? null : next;
    });
  }
  function normalizedDraft(line: StockCountLine, total: number) {
    return splitCount(total, bundleSize(line));
  }
  function setDraftValue(line: StockCountLine, field: 'bundles' | 'loose', value: string) {
    const key = keyFor(line.productId, line.sectionId);
    setReview(false);
    setUploadPreview(null);
    setCounts((current) => ({ ...current, [key]: { ...(current[key] ?? savedDraft(line)), [field]: value } }));
  }
  async function downloadTemplate() {
    if (!count || activeOutletId === null) return;
    if (storageFilter?.size === 0) {
      toast.error('Select at least one storage area for the worksheet.');
      return;
    }
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'ZUS Stockroom';
    const group = new Map<string, typeof count.lines>();
    for (const line of count.lines.filter(matchesStorageFilter)) {
      const sheetName = groupBy === 'section'
        ? (line.sectionName || 'Outlet total')
        : (productMap.get(line.productId)?.category || 'Uncategorised');
      group.set(sheetName, [...(group.get(sheetName) || []), line]);
    }
    const usedSheetNames = new Set<string>();
    for (const [groupName, lines] of group) {
      const baseName = groupName.replace(/[\\/*?:[\]]/g, '-').replace(/['"]+$/g, '').slice(0, 31);
      let sheetName = baseName;
      let suffix = 2;
      while (usedSheetNames.has(sheetName) || sheetName === STOCKTAKE_GUIDE_SHEET || sheetName === STOCKTAKE_MANIFEST_SHEET) {
        const ending = ` ${suffix++}`;
        sheetName = `${baseName.slice(0, 31 - ending.length)}${ending}`;
      }
      usedSheetNames.add(sheetName);
      const sheet = workbook.addWorksheet(sheetName);
      sheet.addRow([groupName]);
      sheet.mergeCells(1, 1, 1, STOCKTAKE_HEADERS.length);
      sheet.addRow([...STOCKTAKE_HEADERS]);
      [12, 34, 17, 17, 16, 16, 20, 12, 15, 14].forEach((width, index) => {
        sheet.getColumn(index + 1).width = width;
      });
      sheet.getRow(1).height = 27;
      sheet.getRow(1).font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF173A83' } };
      sheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'left' };
      sheet.getRow(2).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D5B99' } };
      for (const line of lines) {
        const product = productMap.get(line.productId);
        sheet.addRow([
          line.productId,
          line.productName,
          null,
          product?.bundleUnit || '',
          null,
          line.unit,
          line.sectionName || 'Outlet total',
          line.sectionId ?? '',
          count.id,
          bundleSize(line),
        ]);
      }
      sheet.getColumn(1).hidden = true;
      [7, 8, 9, 10].forEach((column) => { sheet.getColumn(column).hidden = true; });
      const lastRow = Math.max(3, lines.length + 2);
      for (const column of ['C', 'E']) {
        for (let rowNumber = 3; rowNumber <= lastRow; rowNumber += 1) {
          sheet.getCell(`${column}${rowNumber}`).dataValidation = {
            type: 'whole',
            operator: 'between',
            formulae: [0, 1_000_000],
            allowBlank: true,
            showErrorMessage: true,
            errorTitle: 'Whole number required',
            error: 'Enter a whole number from 0 to 1,000,000, or leave it blank.',
          };
        }
      }
      sheet.views = [{ state: 'frozen', ySplit: 2 }];
      sheet.autoFilter = { from: 'A2', to: `F${lastRow}` };
      sheet.pageSetup.orientation = 'landscape';
      sheet.pageSetup.paperSize = 9;
      sheet.pageSetup.fitToPage = true;
      sheet.pageSetup.fitToWidth = 1;
      sheet.pageSetup.fitToHeight = 0;
    }
    const guide = workbook.addWorksheet(STOCKTAKE_GUIDE_SHEET);
    guide.addRows([
      ['ZUS Stockroom · stock count worksheet'],
      [`Outlet: ${outletName}`],
      [`Count session: #${count.id} · ${titleCase(count.scope)} · count date ${dateText(count.countDate)}`],
      [`Notes: ${count.notes || '—'}`],
      ['Each worksheet represents one stock section. The Product ID and session details are hidden; do not unhide or change them.'],
      ['Enter whole bundles and loose base units. Extra loose units are converted into bundles only when you review the count.'],
      ['Leave both count fields blank if not counted. Enter 0 when you counted the product and found none. If one field is filled, a blank in the other field is treated as 0.'],
      ['This is a blind-count worksheet: expected stock is not included. Upload it to the same count session, then review entered rows before confirming.'],
    ]);
    guide.getColumn(1).width = 105;
    guide.getRow(1).font = { bold: true, size: 14, color: { argb: 'FF101D79' } };
    guide.eachRow(row => { row.height = 24; });
    const manifest = workbook.addWorksheet(STOCKTAKE_MANIFEST_SHEET);
    manifest.addRows([[STOCKTAKE_MANIFEST_MARKER], [count.id], [activeOutletId]]);
    manifest.state = 'hidden';
    const buffer = await workbook.xlsx.writeBuffer();
    const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const name = count.scope === 'section' || storageFilter !== null
      ? 'Stock-Count-Store'
      : 'Stock-Count-All';
    const a = document.createElement('a'); a.href = url; a.download = `${name}.xlsx`; a.click(); URL.revokeObjectURL(url);
    toast.success('Workbook template downloaded');
  }
  function printBlankSheet() {
    if (!count) return;
    if (storageFilter?.size === 0) {
      toast.error('Select at least one storage area before printing.');
      return;
    }
    const groups = new Map<string, typeof count.lines>();
    for (const line of count.lines.filter(matchesStorageFilter)) {
      const sectionName = line.sectionName || 'Outlet total';
      groups.set(sectionName, [...(groups.get(sectionName) || []), line]);
    }
    const sectionsHtml = [...groups.entries()].map(([sectionName, lines]) => {
      const rows = lines.map(line => {
        const product = productMap.get(line.productId);
        const bundleLabel = product?.bundleUnit || '';
        const hasBundle = Boolean(bundleLabel && (product?.bundleSize || 1) > 1);
        return `<tr><td>${escapeHtml(line.productName)}</td><td class="write"></td><td>${escapeHtml(hasBundle ? bundleLabel : '—')}</td><td class="write"></td><td>${escapeHtml(line.unit)}</td></tr>`;
      }).join('');
      return `<section><h2>${escapeHtml(sectionName)}</h2><table><thead><tr><th>Product</th><th>Bundles</th><th>Bundle unit</th><th>Loose</th><th>Base unit</th></tr></thead><tbody>${rows}</tbody></table></section>`;
    }).join('');
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      toast.error('Allow pop-ups to print the blank stock-count sheet.');
      return;
    }
    const documentName = `${stockTakeDocumentName(count.countDate, count.id)}-blank-sheet`;
    printWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(documentName)}</title><style>
      @page{size:A4 landscape;margin:14mm}body{font:12px Arial,sans-serif;color:#101d32;margin:0}
      h1{font-size:22px;margin:0 0 8px}header{border-bottom:2px solid #173a83;padding-bottom:12px;margin-bottom:18px}
      .meta{display:flex;gap:28px;color:#46556b;font-size:11px;margin-top:8px}.note{margin-top:10px;font-size:11px}
      section{break-inside:avoid;margin:18px 0 24px}h2{font-size:15px;background:#173a83;color:white;padding:8px 10px;margin:0}
      table{width:100%;border-collapse:collapse}th{background:#e8edf6;text-align:left;font-size:10px;text-transform:uppercase}
      th,td{border:1px solid #cbd3df;padding:7px 8px}td.write{min-width:74px;height:24px}
      @media print{section{break-inside:avoid}}
    </style></head><body><header><h1>Stock count worksheet</h1><div class="meta"><span>Outlet: ${escapeHtml(outletName)}</span><span>Count date: ${escapeHtml(dateText(count.countDate))}</span><span>Session: #${count.id}</span></div>${count.notes ? `<p class="note">Notes: ${escapeHtml(count.notes)}</p>` : ''}</header>${sectionsHtml}</body></html>`);
    printWindow.document.close();
    window.setTimeout(() => {
      printWindow.focus();
      printWindow.print();
    }, 250);
  }
  async function uploadWorkbook(file?: File): Promise<void> {
    if (!file || !count || activeOutletId === null) return;
    setSourceWorkbook(null);
    if (file.size > 5 * 1024 * 1024) { toast.error('Workbook must be 5 MB or smaller.'); return; }
    try {
      const buffer = await file.arrayBuffer();
      const parsed = await parseStockCountWorkbook(buffer, count.lines, {
        countId: count.id,
        outletId: activeOutletId,
        products: (products.data || []).map((product) => ({
          id: product.id,
          name: product.name,
          unit: product.unit,
          bundleSize: product.bundleSize,
          bundleUnit: product.bundleUnit,
        })),
      });
      setUploadPreview({ issues: parsed.issues, validRows: parsed.validRows, drafts: parsed.counts });
      if (parsed.issues.length) {
        toast.error(`Workbook needs ${parsed.issues.length} correction${parsed.issues.length === 1 ? '' : 's'}.`);
      } else {
        setSourceWorkbook(file);
        toast.success(`${parsed.validRows.length} counted rows ready. Blank rows will remain unchanged.`);
      }
    } catch {
      toast.error('Could not read this workbook. Use a valid SOPBox-style .xlsx count sheet.');
    }
  }
  function reviewCount(event: FormEvent) {
    event.preventDefault();
    if (!count) return;
    const countedLines = count.lines.filter(hasEntry);
    if (countedLines.length === 0) { toast.error('Enter at least one count. Blank lines will remain unchanged.'); return; }
    const invalid = countedLines.filter((line) => calculate(line) === null);
    if (invalid.length) { toast.error('Counts must be non-negative whole numbers. Blank lines will remain unchanged.'); return; }
    const normalized: Record<string, CountDraft> = { ...counts };
    for (const line of countedLines) {
      const total = calculate(line);
      if (total === null) continue;
      normalized[keyFor(line.productId, line.sectionId)] = normalizedDraft(line, total);
    }
    setCounts(normalized);
    setAcknowledgedMovementSignature(null);
    void query.refetch().then(() => setReview(true));
  }
  async function confirmSubmit() {
    if (!count || !movementsAcknowledged || workbookSubmitInFlight.current) return;
    workbookSubmitInFlight.current = true;
    setWorkbookUploadInProgress(true);
    try {
      let workbookDetails: { workbookObjectPath: string; workbookName: string } | undefined;
      if (sourceWorkbook) {
        const contentType = sourceWorkbook.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        const upload = await requestWorkbookUploadUrl.mutateAsync({
          countId,
          data: { name: sourceWorkbook.name, size: sourceWorkbook.size, contentType },
        });
        const uploaded = await fetch(upload.uploadURL, {
          method: 'PUT',
          headers: { 'Content-Type': contentType },
          body: sourceWorkbook,
        });
        if (!uploaded.ok) throw new Error('Could not upload the original workbook. Try again.');
        workbookDetails = { workbookObjectPath: upload.objectPath, workbookName: sourceWorkbook.name };
      }

      await submitCount.mutateAsync({
        countId,
        data: {
          lines: count.lines.filter(hasEntry).map(line => ({ productId: line.productId, ...(line.sectionId === null ? {} : { sectionId: line.sectionId }), countedQuantity: calculate(line) as number })),
          acknowledgedMovementIds: movements.map(movement => movement.id),
          notes: countNotes.trim(),
          ...workbookDetails,
        },
      });
      toast.success('Count reconciled');
      setReview(false);
      setSourceWorkbook(null);
      void qc.invalidateQueries({ queryKey: getGetStockCountQueryKey(countId) });
      void qc.invalidateQueries({ queryKey: getListStockCountsQueryKey() });
      void qc.invalidateQueries({ queryKey: getListProductsQueryKey() });
      void qc.invalidateQueries({ queryKey: getListStockBatchesQueryKey() });
      void qc.invalidateQueries({ queryKey: getListStockSectionsQueryKey() });
      void qc.invalidateQueries({ queryKey: getListStockMovementsQueryKey() });
      void qc.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
    } catch (error) {
      const status = (error as { status?: number }).status;
      setAcknowledgedMovementSignature(null);
      void query.refetch();
      toast.error(status === 409 ? 'Stock changed while you were reviewing. The movement list has been refreshed; review and confirm again.' : error instanceof Error ? error.message : 'Could not reconcile count. Try again.');
    } finally {
      workbookSubmitInFlight.current = false;
      setWorkbookUploadInProgress(false);
    }
  }
  async function downloadSubmittedWorkbook() {
    if (!count?.workbook) return;
    try {
      const blob = await downloadStockCountWorkbook(countId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = count.workbook.name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not download the submitted workbook.');
    }
  }
  const searchTerm = search.trim().toLocaleLowerCase();
  const visibleLines = (count?.lines || []).filter((line) => {
    if (!matchesStorageFilter(line)) return false;
    const product = productMap.get(line.productId);
    const searchableText = `${line.productName} ${product?.unit || ''} ${product?.bundleUnit || ''} ${product?.category || ''} ${line.sectionName || ''}`.toLocaleLowerCase();
    return searchableText.includes(searchTerm);
  });
  const groupedLines = new Map<string, StockCountLine[]>();
  for (const line of visibleLines) {
    const group = line.sectionName || 'Outlet total';
    groupedLines.set(group, [...(groupedLines.get(group) || []), line]);
  }
  const groupNames = [...groupedLines.keys()];
  const summaryLines = count?.status === 'completed'
    ? count.lines.filter((line) => line.countedQuantity !== null)
    : [];
  const summaryTotalsByUnit = new Map<string, { expected: number; counted: number; variance: number }>();
  for (const line of summaryLines) {
    const totals = summaryTotalsByUnit.get(line.unit) || { expected: 0, counted: 0, variance: 0 };
    const counted = line.countedQuantity ?? 0;
    totals.expected += line.expectedQuantity;
    totals.counted += counted;
    totals.variance += counted - line.expectedQuantity;
    summaryTotalsByUnit.set(line.unit, totals);
  }
  const movementSummaries = summarizeStockCountMovements(
    count?.movements ?? [],
    movement => count?.lines.find(line => line.productId === movement.productId && line.sectionId === movement.sectionId)?.unit
      || count?.lines.find(line => line.productId === movement.productId)?.unit
      || 'units',
    count?.lines.map(line => line.unit) ?? [],
  );
  const movementTotalValues = (key: 'increases' | 'decreases' | 'net') => movementSummaries.length
    ? movementSummaries.map(({ unit, ...totals }) => {
        const value = totals[key];
        return <span key={unit}>{key === 'net' && value > 0 ? '+' : ''}{quantityText(value)} {unit}</span>;
      })
    : <span>0</span>;
  const stockTakeNumber = count ? stockTakeDocumentName(count.countDate, count.id) : '';
  return <><div className="mb-5"><Link href="/counts" className="btn btn-ghost -ml-2 text-xs"><ArrowRight className="rotate-180" size={14}/> All counts</Link></div>
    {query.isLoading ? <div className="panel p-6"><div className="skeleton h-8 w-1/3"/><div className="skeleton mt-5 h-24 w-full"/></div> : query.isError || !count ? <div className="panel p-6"><b>Count could not be loaded</b><button className="btn btn-soft ml-3" onClick={() => void query.refetch()}>Retry</button></div> : <>
       <Heading title="Stock Count" detail="Count each product as whole bundles plus loose items. Extra loose items are rolled into bundles. Blank counts stay unchanged; enter 0 only when you counted zero." action={<div className="flex flex-wrap items-center gap-2">{count.status !== 'completed' && <button className="btn btn-soft text-xs" disabled={activeOutletId === null} onClick={() => void downloadTemplate()}><Download size={14}/> Stock Count Template</button>}{count.status === 'completed' && count.workbook && <button className="btn btn-soft text-xs" onClick={() => void downloadSubmittedWorkbook()}><Download size={14}/> Download submitted workbook</button>}{count.status === 'completed' && <button className="btn btn-soft text-xs" title={`Print or save as ${stockTakeNumber}.pdf`} onClick={() => printNamedDocument(document.getElementById(`stock-take-print-${count.id}`), stockTakeNumber)}><Printer size={14}/> Print / Save PDF</button>}{count.status !== 'completed' && <button className="btn btn-soft text-xs" onClick={printBlankSheet}><Printer size={14}/> Print blank sheet</button>}<span className={`rounded-full px-3 py-2 text-xs font-bold ${count.status === 'completed' ? 'bg-[#e5f0e9] text-[#28644b]' : 'bg-[#f8eed6] text-[#875b15]'}`}>{titleCase(count.status)}</span></div>}/>
      {count.workbook && <p className="mb-4 text-xs text-muted-foreground">Original workbook: <b className="text-foreground">{count.workbook.name}</b> · submitted by {count.workbook.uploadedBy} · {dateTimeText(count.workbook.submittedAt)}</p>}
      {count.status === 'completed' && <section id={`stock-take-print-${count.id}`} className="print-only-document p-8 text-black" data-print-document="stock-take">
        <header className="flex items-start justify-between border-b-2 border-black pb-5">
          <div><p className="text-xs font-bold uppercase tracking-[.18em]">ZUS Stockroom · Store Operations</p><h1 className="mt-3 text-3xl font-extrabold">Stock-take summary</h1><p className="mt-1 text-sm">{stockTakeNumber}</p></div>
           <div className="text-right text-sm"><p className="font-bold">Completed</p><p className="mt-2">Count date · {dateText(count.countDate)}</p><p className="mt-1">Completed · {dateText(count.completedAt)}</p></div>
        </header>
        <div className="mt-6 grid grid-cols-2 gap-8 text-sm">
          <section><h2 className="mb-2 font-bold uppercase tracking-wide">Outlet</h2><p>{outletName}</p></section>
           <section><h2 className="mb-2 font-bold uppercase tracking-wide">Count details</h2><p>{titleCase(count.scope)} count · started by {count.createdBy}</p>{count.notes && <p className="mt-2">Notes: {count.notes}</p>}</section>
        </div>
         <div className="mt-7 rounded-lg border border-gray-300 p-3 text-sm">
           <p className="text-xs uppercase tracking-wide">Lines counted</p>
           <p className="mt-1 text-xl font-bold">{summaryLines.length}</p>
         </div>
         <section className="mt-5" aria-label="Count totals by base unit">
           <h2 className="mb-2 text-lg font-bold">Count totals by base unit</h2>
           <table className="w-full border-collapse text-sm" data-print-table="count-totals">
             <thead><tr><th className="border-b-2 border-black py-2 text-left">Base unit</th><th className="border-b-2 border-black py-2 text-right">Expected</th><th className="border-b-2 border-black py-2 text-right">Counted</th><th className="border-b-2 border-black py-2 text-right">Net variance</th></tr></thead>
             <tbody>{[...summaryTotalsByUnit].map(([unit, totals]) => (
               <tr key={unit}>
                 <td className="border-b border-gray-300 py-2">{unit}</td>
                 <td className="border-b border-gray-300 py-2 text-right">{quantityText(totals.expected)}</td>
                 <td className="border-b border-gray-300 py-2 text-right">{quantityText(totals.counted)}</td>
                 <td className="border-b border-gray-300 py-2 text-right">{totals.variance > 0 ? '+' : ''}{quantityText(totals.variance)}</td>
               </tr>
             ))}</tbody>
           </table>
           {summaryTotalsByUnit.size === 0 && <p className="mt-2 text-xs">No counted lines were recorded.</p>}
         </section>
        <section className="mt-6" aria-label="Stock movement summary">
          <h2 className="mb-1 text-lg font-bold">Stock movement summary</h2>
          <p className="mb-3 text-xs">Totals reflect the same movement entries listed below, grouped by base unit.</p>
          <div className="grid grid-cols-3 gap-3 text-sm">
            <div className="rounded-lg border border-gray-300 p-3"><p className="text-xs uppercase tracking-wide">Total increases</p><div className="mt-2 flex flex-col gap-1 font-bold">{movementTotalValues('increases')}</div></div>
            <div className="rounded-lg border border-gray-300 p-3"><p className="text-xs uppercase tracking-wide">Total decreases</p><div className="mt-2 flex flex-col gap-1 font-bold">{movementTotalValues('decreases')}</div></div>
            <div className="rounded-lg border border-gray-300 p-3"><p className="text-xs uppercase tracking-wide">Net movement</p><div className="mt-2 flex flex-col gap-1 font-bold">{movementTotalValues('net')}</div></div>
          </div>
        </section>
        <table className="mt-7 w-full border-collapse text-sm" data-print-table="count-lines">
          <thead><tr><th className="border-b-2 border-black py-2 text-left">Product</th><th className="border-b-2 border-black py-2 text-left">Storage area</th><th className="border-b-2 border-black py-2 text-right">Expected</th><th className="border-b-2 border-black py-2 text-right">Counted</th><th className="border-b-2 border-black py-2 text-right">Variance</th></tr></thead>
          <tbody>{summaryLines.map((line) => {
            const variance = (line.countedQuantity ?? 0) - line.expectedQuantity;
            return <tr key={keyFor(line.productId, line.sectionId)}><td className="border-b border-gray-300 py-3">{line.productName}<span className="ml-1 text-xs">({line.unit})</span></td><td className="border-b border-gray-300 py-3">{line.sectionName || 'Outlet total'}</td><td className="border-b border-gray-300 py-3 text-right">{quantityText(line.expectedQuantity)}</td><td className="border-b border-gray-300 py-3 text-right">{quantityText(line.countedQuantity ?? 0)}</td><td className="border-b border-gray-300 py-3 text-right">{variance > 0 ? '+' : ''}{quantityText(variance)}</td></tr>;
          })}</tbody>
        </table>
        <section className="mt-8">
          <h2 className="mb-2 border-b-2 border-black pb-2 text-lg font-bold">Stock movements during the count</h2>
          {count.movements?.length ? <table className="w-full border-collapse text-sm" data-print-table="movements">
            <thead><tr><th className="border-b border-black py-2 text-left">Product</th><th className="border-b border-black py-2 text-left">Storage area</th><th className="border-b border-black py-2 text-left">Movement details</th><th className="border-b border-black py-2 text-right">Quantity change</th></tr></thead>
            <tbody>{count.movements.map((movement) => {
              const unit = count.lines.find((line) => line.productId === movement.productId && line.sectionId === movement.sectionId)?.unit
                || count.lines.find((line) => line.productId === movement.productId)?.unit
                || '';
              return <tr key={movement.id}>
                <td className="border-b border-gray-300 py-3">{movement.productName}</td>
                <td className="border-b border-gray-300 py-3">{movement.sectionName || 'Outlet total'}</td>
                <td className="border-b border-gray-300 py-3"><b>{titleCase(movement.type)}</b><span className="block">{movement.reason}</span><span className="block text-xs">Recorded by {movement.actor} · {dateTimeText(movement.occurredAt)}</span></td>
                <td className="border-b border-gray-300 py-3 text-right">{movement.quantityDelta > 0 ? '+' : ''}{quantityText(movement.quantityDelta)} {unit}</td>
              </tr>;
            })}</tbody>
          </table> : <p className="py-3 text-sm">No stock movements were recorded during this count.</p>}
        </section>
        <p className="mt-5 text-xs">Only quantities entered during this stock take are included. Blank lines remain unchanged.</p>
      </section>}
      {uploadPreview && <section className={`mb-4 rounded-xl border p-4 text-xs ${uploadPreview.issues.length ? 'border-[#ead4cc] bg-[#fff4ef]' : 'border-[#d5e4d8] bg-[#f3f8f3]'}`}>
         <div className="flex flex-wrap items-center justify-between gap-2"><div><b>{uploadPreview.issues.length ? 'Worksheet needs attention' : 'Worksheet is ready to review'}</b><p className="mt-1 text-[10px] text-muted-foreground">{uploadPreview.validRows.length} counted row{uploadPreview.validRows.length === 1 ? '' : 's'} · {uploadPreview.issues.length} error{uploadPreview.issues.length === 1 ? '' : 's'} · blank rows remain unchanged · no stock has changed</p></div><button type="button" className="btn btn-ghost p-2" aria-label="Close worksheet preview" onClick={() => setUploadPreview(null)}><X size={15}/></button></div>
        {uploadPreview.validRows.length > 0 && <div className="mt-3 max-h-36 overflow-y-auto rounded-lg border border-border/70 bg-card"><div className="grid grid-cols-[1fr_1fr_auto] gap-3 border-b border-border px-3 py-2 text-[9px] font-extrabold uppercase text-muted-foreground"><span>Product</span><span>Storage area</span><span>Counted</span></div>{uploadPreview.validRows.slice(0, 8).map(row => <div key={row.key} className="grid grid-cols-[1fr_1fr_auto] gap-3 border-b border-border/60 px-3 py-2 last:border-0"><span className="truncate">{row.productName}</span><span className="truncate text-muted-foreground">{row.sectionName}</span><span className="mono">{row.quantity}</span></div>)}{uploadPreview.validRows.length > 8 && <p className="px-3 py-2 text-[10px] text-muted-foreground">And {uploadPreview.validRows.length - 8} more valid rows.</p>}</div>}
        {uploadPreview.issues.length > 0 && <ul className="mt-3 max-h-36 list-inside list-disc space-y-1 overflow-y-auto">{uploadPreview.issues.slice(0, 8).map((issue,i) => <li key={i}>{issue}</li>)}</ul>}
        {uploadPreview.issues.length > 8 && <p className="mt-1">And {uploadPreview.issues.length - 8} more errors.</p>}
         <div className="mt-3 flex justify-end"><button type="button" className="btn btn-primary" disabled={uploadPreview.issues.length > 0 || uploadPreview.validRows.length === 0} onClick={() => { setCounts(old => ({ ...old, ...uploadPreview.drafts })); setUploadPreview(null); setReview(false); toast.success('Entered counts added for review; blank rows are unchanged'); }}>Use these counts</button></div>
      </section>}
      {batches.isError && <div className="mb-3 rounded-xl bg-[#fff4ef] p-3 text-xs">Batch expiry details are unavailable, but count entry is still available.</div>}
       <form onSubmit={reviewCount} className="panel mb-3 p-4 sm:p-5">
         <div className="mb-4">
           <h2 className="text-sm font-extrabold">New stocktake</h2>
           <p className="mt-1 text-xs text-muted-foreground">Enter what is on the shelf. The system quantity is shown in the review step.</p>
           <p className="mt-1 text-[10px] text-muted-foreground">Worksheet for {outletName} · Count #{count.id} · {dateText(count.countDate)} · started by {count.createdBy}</p>
         </div>
         <div className="grid gap-3 sm:grid-cols-[minmax(170px,.8fr)_150px_minmax(220px,1.2fr)_auto] sm:items-end">
           <div className="relative">
             <label className="mb-1 block text-[11px] font-semibold">Storage area counted</label>
             <button type="button" className="field flex w-full items-center justify-between gap-2 text-left text-xs" aria-label="Choose storage areas counted" aria-expanded={storageFilterOpen} onClick={() => setStorageFilterOpen((current) => !current)}>
               <span className="truncate">{storageFilter === null ? 'All storage areas' : selectedStorageCount === 1 ? [...storageFilter][0] : `${selectedStorageCount} areas selected`}</span><ChevronDown size={14} className="shrink-0"/>
             </button>
           </div>
           <label className="block text-[11px] font-semibold">Count date<input aria-label="Count date" className="field mt-1 text-xs" type="date" value={count.countDate} readOnly/></label>
           <label className="block text-[11px] font-semibold">Find a product<div className="relative mt-1"><Search size={15} className="absolute left-3 top-2.5 text-muted-foreground"/><input aria-label="Search stock count" className="field pl-9 text-xs" placeholder="Search product, type, category or storage" value={search} onChange={(event) => setSearch(event.target.value)}/></div></label>
           <label className={`btn btn-soft min-h-10 ${count.status === 'completed' || activeOutletId === null ? 'pointer-events-none opacity-50' : 'cursor-pointer'}`}><Upload size={14}/> Upload count sheet<input className="sr-only" type="file" accept=".xlsx" disabled={count.status === 'completed' || activeOutletId === null} onChange={event => { void uploadWorkbook(event.target.files?.[0]); event.currentTarget.value = ''; }}/></label>
         </div>
         {search && <button type="button" className="mt-2 btn btn-ghost px-2 py-1 text-xs" onClick={() => setSearch('')}>Clear search</button>}
         {sourceWorkbook && <p className="mt-2 text-[10px] text-muted-foreground">Source will be saved: {sourceWorkbook.name} · 5 MB max · blank rows unchanged</p>}
         {storageFilterOpen && <div className="mt-3 rounded-xl border border-border p-3">
           <div className="flex flex-wrap items-center justify-between gap-2">
             <div><b className="text-xs">Choose storage areas</b><p className="mt-1 text-[10px] text-muted-foreground">This filters the rows and workbook view; existing entries in other areas are kept.</p></div>
             <div className="flex gap-2"><button type="button" className="btn btn-ghost px-2 py-1 text-xs" onClick={() => setStorageFilter(null)}>Select all</button><button type="button" className="btn btn-ghost px-2 py-1 text-xs" onClick={() => setStorageFilter(new Set())}>Clear</button></div>
           </div>
           <label className="relative mt-3 block"><Search size={14} className="absolute left-3 top-2.5 text-muted-foreground"/><input aria-label="Search storage areas" className="field h-9 pl-9 text-xs" placeholder="Search storage areas" value={storageSearch} onChange={(event) => setStorageSearch(event.target.value)}/></label>
           <div className="mt-2 grid max-h-44 gap-1 overflow-y-auto sm:grid-cols-2">
             {matchingStorageNames.map((name) => <label key={name} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-muted/60"><input type="checkbox" checked={storageFilter === null || storageFilter.has(name)} onChange={(event) => toggleStorageFilter(name, event.target.checked)} className="accent-primary"/><span className="truncate">{name}</span></label>)}
             {matchingStorageNames.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">No storage areas match.</p>}
           </div>
         </div>}
         <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3 text-[10px] text-muted-foreground"><span>{groupNames.length} storage sections · {visibleLines.filter(hasEntry).length}/{visibleLines.length} products counted</span><div className="flex gap-1"><button type="button" className="btn btn-ghost px-2 py-1 text-[10px]" onClick={() => setExpandedSections(new Set())}>Collapse all</button><button type="button" className="btn btn-ghost px-2 py-1 text-[10px]" onClick={() => setExpandedSections(new Set(groupNames))}>Expand all</button></div></div>
          <div className="mt-3 overflow-hidden rounded-xl border border-border sm:hidden">
            {[...groupedLines.entries()].map(([group, lines]) => {
              const isExpanded = Boolean(searchTerm) || expandedSections.has(group);
              const counted = lines.filter(hasEntry).length;
              return <section key={group}>
                <button type="button" aria-expanded={isExpanded} className="flex w-full items-center justify-between gap-2 border-b border-[#2c603f] bg-[#316c45] px-3 py-2.5 text-left text-xs font-extrabold text-white" onClick={() => setExpandedSections(current => { const next = new Set(current); if (next.has(group)) next.delete(group); else next.add(group); return next; })}>
                  <span className="flex min-w-0 items-center gap-2">{isExpanded ? <ChevronDown size={15}/> : <ChevronRight size={15}/>}<span className="truncate">{group}</span></span>
                  <span className="shrink-0 rounded-full bg-white/20 px-2 py-1 text-[10px] font-bold text-white">{counted}/{lines.length} counted</span>
                </button>
                {isExpanded && lines.map(line => {
                  const key = keyFor(line.productId, line.sectionId);
                  const product = productMap.get(line.productId);
                  const current = draft(line);
                  const total = calculate(line);
                  const size = bundleSize(line);
                  const hasBundle = size > 1;
                  const normalized = total === null ? null : splitCount(total, size);
                  const inHand = total === null
                    ? 'Not counted'
                    : hasBundle && normalized
                      ? `${quantityText(Number(normalized.bundles))} ${product?.bundleUnit || 'bundles'} (${quantityText(total)} ${line.unit})`
                      : `${quantityText(total)} ${line.unit}`;
                  return <article key={key} className="border-b border-border/70 px-3 py-3 last:border-0">
                    <div className="text-sm font-semibold leading-snug">{line.productName}</div>
                    <div className="mt-1 text-[10px] text-muted-foreground">{product?.category || 'Uncategorised'}</div>
                    {hasBundle ? <div className="mt-3 grid grid-cols-2 gap-3">
                      <label className="min-w-0 text-[10px] font-semibold text-muted-foreground">
                        <span className="mb-1 block">Bundles</span>
                        <span className="flex min-w-0 items-center gap-1.5">
                          <input aria-label={`Bundle count ${line.productName}`} disabled={count.status === 'completed'} className="field h-11 min-w-0 px-2 text-center mono disabled:opacity-50" type="number" min="0" step="1" value={current.bundles} placeholder="0" onChange={event => setDraftValue(line, 'bundles', event.target.value)}/>
                          <span className="max-w-16 shrink-0 break-words text-[10px]">{product?.bundleUnit || 'bundle'}</span>
                        </span>
                        <span className="mt-1 block text-[9px] font-normal">1 {product?.bundleUnit || 'bundle'} = {quantityText(size)} {line.unit}</span>
                      </label>
                      <label className="min-w-0 text-[10px] font-semibold text-muted-foreground">
                        <span className="mb-1 block">Loose items</span>
                        <span className="flex min-w-0 items-center gap-1.5">
                          <input aria-label={`Loose count ${line.productName}`} disabled={count.status === 'completed'} className="field h-11 min-w-0 px-2 text-center mono" type="number" min="0" step="1" value={current.loose} placeholder="0" onChange={event => setDraftValue(line, 'loose', event.target.value)}/>
                          <span className="max-w-16 shrink-0 break-words text-[10px]">{line.unit}</span>
                        </span>
                      </label>
                    </div> : <label className="mt-3 block text-[10px] font-semibold text-muted-foreground">
                      Count ({line.unit})
                      <input aria-label={`Loose count ${line.productName}`} disabled={count.status === 'completed'} className="field mt-1 h-11 px-3 mono" type="number" min="0" step="1" value={current.loose} placeholder="0" onChange={event => setDraftValue(line, 'loose', event.target.value)}/>
                    </label>}
                    <p className="mt-2 text-[11px] text-muted-foreground">In hand: <span className="font-semibold text-foreground">{inHand}</span></p>
                  </article>;
                })}
              </section>;
            })}
            {visibleLines.length === 0 && <div className="p-6 text-center text-sm text-muted-foreground">No products match the current search and storage selection.</div>}
          </div>
          <div className="mt-3 hidden overflow-x-auto rounded-xl border border-border sm:block"><div className="grid min-w-[620px] grid-cols-[minmax(190px,1fr)_100px_110px_150px] gap-3 border-b border-border bg-muted/50 px-5 py-3 text-[10px] font-extrabold uppercase tracking-wider text-muted-foreground"><span>Product</span><span>Bundles</span><span>Loose</span><span>In hand</span></div>
            {[...groupedLines.entries()].map(([group, lines]) => { const isExpanded = Boolean(searchTerm) || expandedSections.has(group); const counted = lines.filter(hasEntry).length; return <section key={group}><button type="button" aria-expanded={isExpanded} className="sticky top-0 z-10 flex w-full items-center justify-between border-b border-[#2c603f] bg-[#316c45] px-5 py-2 text-left text-xs font-extrabold text-white" onClick={() => setExpandedSections(current => { const next = new Set(current); if (next.has(group)) next.delete(group); else next.add(group); return next; })}><span className="flex items-center gap-2">{isExpanded ? <ChevronDown size={15}/> : <ChevronRight size={15}/>}<span>{group}<span className="ml-2 font-medium text-white/75">{lines.length} product{lines.length === 1 ? '' : 's'}</span></span></span><span className="rounded-full bg-white/20 px-2 py-1 text-[10px] font-bold text-white">{counted}/{lines.length} counted</span></button>{isExpanded && lines.map(line => { const key = keyFor(line.productId,line.sectionId); const p = productMap.get(line.productId); const current = draft(line); const total = calculate(line); const size = bundleSize(line); const hasBundle = size > 1; const normalized = total === null ? null : splitCount(total, size); return <div key={key} className="grid min-w-[620px] grid-cols-[minmax(190px,1fr)_100px_110px_150px] items-center gap-3 border-b border-border/70 px-5 py-4 last:border-0"><div><b className="text-xs">{line.productName}</b><div className="mt-1 text-[10px] text-muted-foreground">{p?.category || 'Uncategorised'} · {hasBundle ? `${size} ${p?.unit} = 1 ${p?.bundleUnit}` : line.unit}</div></div><input aria-label={`Bundle count ${line.productName}`} disabled={count.status === 'completed' || !hasBundle} className="field px-2 text-center mono disabled:opacity-50" type="number" min="0" step="1" value={current.bundles} placeholder={hasBundle ? '0' : '—'} onChange={e => setDraftValue(line, 'bundles', e.target.value)}/><input aria-label={`Loose count ${line.productName}`} disabled={count.status === 'completed'} className="field px-2 text-center mono" type="number" min="0" step="1" value={current.loose} placeholder="0" onChange={e => setDraftValue(line, 'loose', e.target.value)}/><span className="mono text-xs">{total === null ? '—' : hasBundle && normalized ? `${quantityText(Number(normalized.bundles))} ${p?.bundleUnit} (${quantityText(total)} ${line.unit})` : `${quantityText(total)} ${line.unit}`}</span></div>; })}</section>; })}
            {visibleLines.length === 0 && <div className="p-8 text-center text-sm text-muted-foreground">No products match the current search and storage selection.</div>}
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <label className="block text-xs font-bold">Notes <span className="font-normal text-muted-foreground">(optional)</span><textarea maxLength={1000} disabled={count.status === 'completed'} className="field mt-1.5 min-h-20 disabled:opacity-60" placeholder="Reason for the count or any relevant notes" value={countNotes} onChange={event => setCountNotes(event.target.value)}/></label>
            <div className="flex items-center justify-between gap-3 sm:flex-col sm:items-end">
              <span className="text-xs text-muted-foreground">{enteredLineCount} of {count.lines.length} pairs counted</span>
              {count.status !== 'completed' && <button className="btn btn-primary" disabled={submitCount.isPending || enteredLineCount === 0}><CheckCircle2 size={15}/> Review {enteredLineCount} {enteredLineCount === 1 ? 'count' : 'counts'}</button>}
            </div>
          </div>
        </form>
    </>}
    {review && count && <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#0b1649]/45 p-0 sm:items-center sm:p-5"><section className="max-h-[85dvh] w-full max-w-3xl overflow-y-auto rounded-t-2xl bg-card p-5 sm:rounded-2xl sm:p-7"><div className="mb-4 flex justify-between"><div><h2 className="zus-title text-2xl font-bold">Review before reconciling</h2><p className="mt-1 text-xs text-muted-foreground">Only entered lines are included. Loose quantities have been converted into bundles and remaining units. Blank lines stay unchanged; 0 means no stock.</p></div><button className="btn btn-ghost p-2" aria-label="Close count review" onClick={() => setReview(false)}><X size={17}/></button></div>
      <section className="mb-4 rounded-xl border border-[#e4d7ba] bg-[#fffaf0] p-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><div><b className="text-xs">Stock movements since this count started</b><p className="mt-1 text-[10px] text-muted-foreground">Check these changes before applying the count to today’s stock balance.</p></div><button type="button" className="btn btn-soft px-3 py-2 text-[10px]" disabled={query.isFetching} onClick={() => { setAcknowledgedMovementSignature(null); void query.refetch(); }}><RefreshCw size={13}/> {query.isFetching ? 'Refreshing…' : 'Refresh movements'}</button></div>
        {movements.length === 0 ? <p className="mt-3 rounded-lg bg-white/70 p-3 text-xs text-muted-foreground">No stock movements have been recorded since this count began.</p> : <div className="mt-3 max-h-36 overflow-y-auto rounded-lg border border-border/70 bg-card"><div className="grid grid-cols-[minmax(100px,1fr)_minmax(90px,.8fr)_auto] gap-3 border-b border-border px-3 py-2 text-[9px] font-extrabold uppercase text-muted-foreground"><span>Product / area</span><span>Movement</span><span className="text-right">Change</span></div>{movements.map(movement => <div key={movement.id} className="grid grid-cols-[minmax(100px,1fr)_minmax(90px,.8fr)_auto] items-center gap-3 border-b border-border/60 px-3 py-2 last:border-0"><span className="min-w-0 truncate text-[11px]"><b>{movement.productName}</b><span className="block truncate text-[9px] text-muted-foreground">{movement.sectionName || 'Outlet total'} · {movement.actor}</span></span><span className="text-[10px] text-muted-foreground">{titleCase(movement.type)}</span><span className={`mono text-right text-[11px] ${movement.quantityDelta < 0 ? 'text-[#98483e]' : 'text-primary'}`}>{movement.quantityDelta > 0 ? '+' : ''}{quantityText(movement.quantityDelta)} {count.lines.find(line => line.productId === movement.productId)?.unit || ''}</span></div>)}</div>}
        <label className="mt-3 flex items-start gap-2 text-[11px] font-semibold"><input type="checkbox" className="mt-0.5 accent-primary" checked={movementsAcknowledged} disabled={query.isFetching} onChange={event => setAcknowledgedMovementSignature(event.target.checked ? movementSignature : null)}/><span>I reviewed these movements and confirm this count against the current stock balance.</span></label>
      </section>
      <div className="max-h-[38dvh] overflow-y-auto rounded-xl border border-border"><table className="w-full text-left text-xs"><thead className="sticky top-0 bg-muted"><tr><th className="p-3">Product / area</th><th className="p-3 text-right">Expected</th><th className="p-3 text-right">Counted</th><th className="p-3 text-right">Variance</th></tr></thead><tbody>{count.lines.filter(hasEntry).map(line => { const n = calculate(line) as number; const variance = n - line.expectedQuantity; const current = draft(line); const size = bundleSize(line); const bundleText = size > 1 ? `${current.bundles} ${productMap.get(line.productId)?.bundleUnit} + ${current.loose || '0'} ${line.unit}` : `${current.loose} ${line.unit}`; return <tr key={keyFor(line.productId,line.sectionId)} className="border-t border-border/70"><td className="p-3"><b>{line.productName}</b><div className="mt-1 text-[10px] text-muted-foreground">{line.sectionName || 'Outlet total'}</div></td><td className="mono p-3 text-right">{line.expectedQuantity}</td><td className="p-3 text-right"><span className="block font-semibold">{n}</span><span className="mt-1 block text-[10px] text-muted-foreground">{bundleText}</span></td><td className={`mono p-3 text-right ${variance < 0 ? 'text-[#98483e]' : variance > 0 ? 'text-primary' : ''}`}>{variance > 0 ? `+${variance}` : variance}</td></tr>; })}</tbody></table></div>
      <div className="mt-4 flex justify-end gap-2"><button className="btn btn-soft" onClick={() => setReview(false)}>Continue editing</button><button className="btn btn-primary" disabled={submitCount.isPending || workbookUploadInProgress || query.isFetching || !movementsAcknowledged} onClick={() => void confirmSubmit()}>{workbookUploadInProgress ? sourceWorkbook ? 'Saving workbook…' : 'Reconciling…' : submitCount.isPending ? 'Reconciling…' : 'Confirm and reconcile'}</button></div></section></div>}
  </>;
}
