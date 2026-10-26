import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'wouter';
import ExcelJS from 'exceljs';
import {
  downloadStockCountWorkbook, getGetCurrentUserQueryKey, getGetDashboardSummaryQueryKey, getGetStockCountQueryKey, getListDeliveriesQueryKey, getListProductCategoriesQueryKey, getListProductsQueryKey,
  getListPurchaseOrdersQueryKey, getListStockBatchesQueryKey, getListStockCountsQueryKey, getListStockMovementsQueryKey,
  getListStockSectionsQueryKey, getListSuppliersQueryKey, useCancelPurchaseOrder, useCreateDelivery,
  useCreateLowStockPurchaseOrderDrafts, useCreatePurchaseOrder, useCreateStockCount, useDecideDelivery, useDecidePurchaseOrder,
  useGetCurrentUser, useGetStockCount, useIssuePurchaseOrder, useListDeliveries, useListProductCategories,
  useListProducts, useListPurchaseOrders, useListStockBatches, useListStockCounts, useListStockSections,
  useListSuppliers, useRequestStockCountWorkbookUploadUrl, useSubmitStockCount, useUpdatePurchaseOrderDraft,
} from '@workspace/api-client-react';
import type { Delivery, Product, PurchaseOrder, StockCountInputScope, StockCountLine } from '@workspace/api-client-react';
import { ArrowRight, Check, CheckCircle2, ClipboardCheck, Download, Package, Plus, Printer, RefreshCw, Search, Truck, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { countTotal, hasCountInput, splitCount, type CountDraft } from './stock-count-entry';
import { parseStockCountWorkbook } from './stock-count-workbook';
import {
  STOCKTAKE_GUIDE_SHEET,
  STOCKTAKE_HEADERS,
  STOCKTAKE_MANIFEST_MARKER,
  STOCKTAKE_MANIFEST_SHEET,
  validateStocktakeWorkbook,
  type StocktakeValidation,
} from './lib/stocktake-workbook';
import { printNamedDocument, purchaseOrderDocumentName, stockTakeDocumentName } from './lib/print-documents';

const dateText = (value?: string | null) => value ? new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value)) : '—';
const dateTimeText = (value?: string | null) => value ? new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : '—';
const titleCase = (value: string) => value.replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
const keyFor = (productId: number, sectionId: number | null) => `${productId}:${sectionId ?? 'outlet'}`;
const quantityText = (value: number) => new Intl.NumberFormat('en', { maximumFractionDigits: 3 }).format(value);
function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
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
    const success = () => { toast.success(order ? 'Draft saved' : 'Purchase-order draft created'); refreshOrders(qc); onSaved(); close(); };
    if (order) update.mutate({ orderId: order.id, data }, { onSuccess: success, onError: () => toast.error('Could not save draft') });
    else create.mutate({ data: { ...data, note: data.note || undefined } }, { onSuccess: success, onError: () => toast.error('Could not create draft') });
  }
  const busy = create.isPending || update.isPending;
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#0b1649]/45 p-0 backdrop-blur-sm sm:items-center sm:p-5" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}><section className="max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-border bg-card p-5 shadow-2xl sm:rounded-2xl sm:p-7">
    <div className="mb-5 flex justify-between"><div><h2 className="zus-title text-2xl font-bold">{order ? 'Edit purchase-order draft' : 'New purchase-order draft'}</h2><p className="mt-1 text-xs text-muted-foreground">Save as a draft now. Issue only when the supplier and quantities are confirmed.</p></div><button className="btn btn-ghost p-2" onClick={close} aria-label="Close"><X size={18}/></button></div>
    <form onSubmit={submit} className="space-y-4" data-testid="form-purchase-order">
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs font-bold">Supplier<select data-testid="select-order-supplier" className="field mt-1.5" value={supplierId} onChange={e => setSupplierId(e.target.value)}><option value="">Choose supplier before issue</option>{(suppliersQuery.data || []).filter(s => s.active || s.id === order?.supplierId).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label className="text-xs font-bold">Expected delivery<input data-testid="input-order-expected-delivery" className="field mt-1.5" type="date" value={date} onChange={e => setDate(e.target.value)}/></label></div>
      <div className="space-y-2">{lines.map((line, i) => <div key={i} className="grid gap-2 rounded-xl border border-border p-3 sm:grid-cols-[minmax(0,1fr)_100px_130px_36px]">
        <select data-testid={`select-order-product-${i}`} className="field" required value={line.productId} onChange={e => { setLine(i, 'productId', e.target.value); const p = products.find(item => String(item.id) === e.target.value); if (p) setLine(i, 'unitType', 'unit'); }}><option value="">Choose product</option>{products.map(p => <option key={p.id} value={p.id}>{p.name} · {p.unit}/{p.bundleUnit}</option>)}</select>
        <input data-testid={`input-order-quantity-${i}`} className="field" type="number" min=".01" step=".01" required value={line.quantity} aria-label="Quantity" onChange={e => setLine(i, 'quantity', e.target.value)}/>
        <select data-testid={`select-order-unit-${i}`} className="field" value={line.unitType} onChange={e => setLine(i, 'unitType', e.target.value)}><option value="unit">{products.find(p => String(p.id) === line.productId)?.unit || 'Base unit'}</option><option value="bundle">{products.find(p => String(p.id) === line.productId)?.bundleUnit || 'Bundle unit'}</option></select>
        <button type="button" className="btn btn-ghost p-2" disabled={lines.length === 1} aria-label="Remove line" onClick={() => setLines(old => old.filter((_, j) => j !== i))}><X size={16}/></button>
      </div>)}</div>
      <button type="button" data-testid="button-add-order-line" onClick={() => setLines(old => [...old, { productId: '', quantity: '1', unitType: 'unit' }])} className="btn btn-soft text-xs"><Plus size={14}/> Add product</button>
      <label className="block text-xs font-bold">Order note<textarea className="field mt-1.5 min-h-16" value={note} onChange={e => setNote(e.target.value)}/></label>
      <div className="flex justify-end gap-2"><button type="button" className="btn btn-soft" onClick={close}>Cancel</button><button data-testid="button-save-purchase-order-draft" disabled={busy || productsQuery.isLoading} className="btn btn-primary">{busy ? 'Saving…' : 'Save draft'}</button></div>
    </form>
  </section></div>;
}

export function OrdersPage() {
  const qc = useQueryClient();
  const query = useListPurchaseOrders({}, { query: { queryKey: getListPurchaseOrdersQueryKey({}) } });
  const deliveries = useListDeliveries({ query: { queryKey: getListDeliveriesQueryKey() } });
  const lowDrafts = useCreateLowStockPurchaseOrderDrafts();
  const issue = useIssuePurchaseOrder();
  const cancel = useCancelPurchaseOrder();
  const [editor, setEditor] = useState<{ open: boolean; order?: PurchaseOrder }>({ open: false });
  const rows = query.data || [];
  return <><Heading title="Purchase orders" detail="Build a draft, check the details, then issue it when it is ready." action={<div className="flex flex-wrap gap-2"><button className="btn btn-soft" disabled={lowDrafts.isPending} onClick={() => lowDrafts.mutate(undefined, { onSuccess: result => { refreshOrders(qc); toast.success(`${result.length} low-stock draft${result.length === 1 ? '' : 's'} created`); }, onError: () => toast.error('Could not create low-stock drafts') })}><RefreshCw size={15}/>{lowDrafts.isPending ? 'Preparing…' : 'Create low-stock drafts'}</button><button className="btn btn-primary" onClick={() => setEditor({ open: true })}><Plus size={15}/> New draft</button></div>}/>
    <div className="mb-4 grid gap-3 sm:grid-cols-3">{[['Drafts', rows.filter(o => o.status === 'draft').length], ['Issued', rows.filter(o => o.status === 'issued' || o.status === 'partially_received').length], ['Linked deliveries', (deliveries.data || []).filter(d => d.purchaseOrderId).length]].map(([label, value]) => <div key={String(label)} className="panel p-4"><div className="mono text-2xl">{value}</div><div className="mt-1 text-[10px] text-muted-foreground">{label}</div></div>)}</div>
    {query.data && <OrderFollowUp orders={rows} deliveries={deliveries.data || []} deliveriesLoading={deliveries.isLoading} deliveriesError={deliveries.isError}/>}
    <div className="space-y-3">{query.isLoading ? <div className="panel p-6"><div className="skeleton h-5 w-1/3"/><div className="skeleton mt-4 h-16 w-full"/></div> : query.isError ? <div className="panel p-6 text-center"><p className="text-sm font-bold">Orders did not load</p><button className="btn btn-soft mt-3" onClick={() => void query.refetch()}>Retry</button></div> : rows.length === 0 ? <div className="panel"><PanelEmpty title="No purchase orders yet" detail="Create an editable draft, or prepare drafts from uncovered low-stock needs."/></div> : rows.map(order => <article key={order.id} id={`purchase-order-${order.id}`} className="panel scroll-mt-4 overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4"><div><div className="flex flex-wrap items-center gap-2 text-sm font-extrabold"><ShoppingBagIcon/> {order.orderNumber || `Draft · ${String(order.id).padStart(4, '0')}`}<span className={`rounded-full px-2.5 py-1 text-[10px] ${order.status === 'issued' ? 'bg-[#e5f0e9] text-[#28644b]' : order.status === 'draft' ? 'bg-[#f8eed6] text-[#875b15]' : 'bg-muted text-muted-foreground'}`}>{titleCase(order.status)}</span></div><div className="mt-1 text-[11px] text-muted-foreground">{order.supplierName || 'Supplier not selected'} · expected {dateText(order.expectedDeliveryDate)}</div></div><div className="no-print flex flex-wrap gap-2">{order.orderNumber ? <button className="btn btn-soft text-xs" title={`Print or save as ${order.orderNumber}.pdf`} onClick={(event) => printNamedDocument(event.currentTarget.closest('article')?.querySelector<HTMLElement>('[data-print-document="purchase-order"]') ?? null, purchaseOrderDocumentName(order.orderNumber!))}><Printer size={14}/> Print / Save PDF</button> : <button className="btn btn-soft text-xs" disabled title="Issue or approve the order to assign its official purchase-order number before printing."><Printer size={14}/> Print after issue</button>}{order.status === 'draft' && <><button className="btn btn-soft text-xs" onClick={() => setEditor({ open: true, order })}>Edit draft</button><button className="btn btn-primary text-xs" disabled={!order.supplierId || issue.isPending} title={!order.supplierId ? 'Select a supplier before issue' : undefined} onClick={() => issue.mutate({ orderId: order.id }, { onSuccess: issued => { refreshOrders(qc); toast.success(`Issued ${issued.orderNumber || 'purchase order'}`); }, onError: () => toast.error('Could not issue order') })}><Check size={14}/> Issue order</button></>}{['draft','issued','partially_received'].includes(order.status) && <button className="btn btn-ghost text-xs text-[#98483e]" disabled={cancel.isPending} onClick={() => { if (!window.confirm(`Cancel ${order.orderNumber || 'this purchase order'}?`)) return; cancel.mutate({ orderId: order.id }, { onSuccess: () => { refreshOrders(qc); toast.success('Purchase order cancelled'); }, onError: () => toast.error('Could not cancel order') }); }}>Cancel order</button>}</div></div>
      <div className="grid gap-2 p-4 sm:grid-cols-2">{order.lines.map(line => <div key={line.productId} className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2.5"><span className="text-xs font-bold">{line.productName}</span><span className="mono text-[11px]">{line.receivedQuantity}/{line.quantity} {line.unit}</span></div>)}</div>
      {order.note && <p className="px-5 pb-3 text-xs text-muted-foreground">{order.note}</p>}
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
function ShoppingBagIcon() { return <span className="inline-grid h-8 w-8 place-items-center rounded-lg bg-[#e7ebf6] text-primary"><Package size={16}/></span>; }

type DeliveryLineDraft = { productId: string; quantity: string; tempC: string; expiryDate: string; sectionId: string };
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
  const [lines, setLines] = useState<DeliveryLineDraft[]>([{ productId: '', quantity: '1', tempC: '', expiryDate: '', sectionId: '' }]);
  const orders = (ordersQuery.data || []).filter(o => ['issued', 'partially_received', 'approved'].includes(o.status));
  const chosen = orders.find(o => String(o.id) === orderId);
  const products = productsQuery.data || [];
  const changeLine = (i: number, field: keyof DeliveryLineDraft, value: string) => setLines(old => old.map((line, n) => n === i ? { ...line, [field]: value } : line));
  function selectOrder(value: string) {
    setOrderId(value);
    const po = orders.find(o => String(o.id) === value);
    if (po) { setSupplierId(String(po.supplierId || '')); setLines(po.lines.filter(l => l.quantity - l.receivedQuantity > 0).map(l => ({ productId: String(l.productId), quantity: String(Math.max(0, (l.quantity - l.receivedQuantity) * l.conversionFactor)), tempC: '', expiryDate: '', sectionId: '' }))); }
    else setLines([{ productId: '', quantity: '1', tempC: '', expiryDate: '', sectionId: '' }]);
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    const submitted = lines.filter(l => l.productId && Number(l.quantity) > 0);
    if (!submitted.length || submitted.some(l => !l.sectionId)) { toast.error('Choose a stock section for every received item.'); return; }
    create.mutate({ data: { supplierId: supplierId ? Number(supplierId) : null, purchaseOrderId: orderId ? Number(orderId) : null, lines: submitted.map(l => ({ productId: Number(l.productId), quantity: Number(l.quantity), tempC: l.tempC ? Number(l.tempC) : null, expiryDate: l.expiryDate || null, sectionId: Number(l.sectionId) })) } }, {
      onSuccess: () => { toast.success('Delivery recorded'); refreshOrders(qc); void qc.invalidateQueries({ queryKey: getListStockMovementsQueryKey() }); close(); },
      onError: () => toast.error('Could not record delivery'),
    });
  }
  const busy = productsQuery.isLoading || categoriesQuery.isLoading || suppliersQuery.isLoading || ordersQuery.isLoading || sectionsQuery.isLoading;
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#0b1649]/45 p-0 sm:items-center sm:p-5"><section className="max-h-[92dvh] w-full max-w-3xl overflow-y-auto rounded-t-2xl bg-card p-5 sm:rounded-2xl sm:p-7"><div className="mb-5 flex justify-between"><div><h2 className="zus-title text-2xl font-bold">Receive delivery</h2><p className="mt-1 text-xs text-muted-foreground">Received quantities are entered in each product’s base unit.</p></div><button onClick={close} className="btn btn-ghost p-2"><X size={18}/></button></div>
    <form onSubmit={submit} className="space-y-4"><div className="grid gap-3 sm:grid-cols-2"><label className="text-xs font-bold">Link purchase order<select className="field mt-1.5" value={orderId} onChange={e => selectOrder(e.target.value)}><option value="">No linked order</option>{orders.map(o => <option key={o.id} value={o.id}>{o.orderNumber || `Draft ${o.id}`} · {o.supplierName || 'Supplier'}</option>)}</select></label><label className="text-xs font-bold">Supplier<select className="field mt-1.5" required value={supplierId} onChange={e => setSupplierId(e.target.value)}><option value="">Choose supplier</option>{(suppliersQuery.data || []).filter(s => s.active || s.id === chosen?.supplierId).map(s => <option key={s.id} value={s.id}>{s.active ? s.name : `${s.name} · archived on linked order`}</option>)}</select></label></div>
       {chosen && <div className="rounded-xl bg-[#e7ebf6] p-3 text-xs"><b>{chosen.orderNumber || `Order ${chosen.id}`}</b> · {chosen.supplierName}<div className="mt-2 flex flex-wrap gap-2">{chosen.lines.map((line, i) => <span key={`${line.productId}-${i}`} className="rounded-md bg-white/75 px-2 py-1 text-[10px]">{line.productName}: {Math.max(0, line.quantity - line.receivedQuantity)} {line.unit} outstanding</span>)}</div></div>}
       <div className="space-y-2">{lines.map((line, i) => { const product = products.find(p => String(p.id) === line.productId); const category = product ? (categoriesQuery.data || []).find(c => c.key === product.category) : undefined; const customTemp = Boolean(product && product.tempMinC !== null && product.tempMaxC !== null); const minTemp = customTemp ? product?.tempMinC ?? null : category?.receivingTempMinC ?? null; const maxTemp = customTemp ? product?.tempMaxC ?? null : category?.receivingTempMaxC ?? null; const poLine = chosen?.lines.find(l => String(l.productId) === line.productId); return <div key={i} className="rounded-xl border border-border p-3">
        <div className="grid gap-2 sm:grid-cols-[1fr_110px_1fr]"><label className="text-[10px] font-bold">Product<select required className="field mt-1" value={line.productId} onChange={e => changeLine(i, 'productId', e.target.value)}><option value="">Choose product</option>{(chosen ? chosen.lines.filter(l => l.quantity > l.receivedQuantity).map(l => products.find(p => p.id === l.productId)).filter((p): p is Product => Boolean(p)) : products).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label className="text-[10px] font-bold">Received ({product?.unit || 'base units'})<input required className="field mt-1" type="number" min=".01" step=".01" value={line.quantity} onChange={e => changeLine(i, 'quantity', e.target.value)}/></label><label className="text-[10px] font-bold">Stock section<select required className="field mt-1" value={line.sectionId} onChange={e => changeLine(i, 'sectionId', e.target.value)}><option value="">Choose area</option>{(sectionsQuery.data || []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label></div>
         {poLine && <div className="mt-2 text-[10px] text-muted-foreground">Outstanding: {Math.max(0, poLine.quantity - poLine.receivedQuantity)} {poLine.unit}</div>}
         {product && (category?.receivingHandlingSop || minTemp !== null || maxTemp !== null) && <div className="mt-2 rounded-lg bg-[#f5f1e7] px-3 py-2 text-[10px] leading-4 text-muted-foreground"><b>{category?.name || product.category} receiving guidance</b>{category?.receivingHandlingSop && <p className="mt-1 whitespace-pre-wrap">{category.receivingHandlingSop}</p>}{(minTemp !== null || maxTemp !== null) && <p className="mt-1 font-bold">{customTemp ? 'Product-specific range' : 'Category range'}: {minTemp ?? '—'}°C to {maxTemp ?? '—'}°C</p>}</div>}
        <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto]"><label className="text-[10px] font-bold">Probe temperature °C<input className="field mt-1" type="number" step=".1" value={line.tempC} onChange={e => changeLine(i, 'tempC', e.target.value)}/></label><label className="text-[10px] font-bold">Expiry (optional)<input className="field mt-1" type="date" value={line.expiryDate} onChange={e => changeLine(i, 'expiryDate', e.target.value)}/></label><button type="button" className="btn btn-ghost self-end p-2" disabled={lines.length === 1} onClick={() => setLines(old => old.filter((_, n) => n !== i))}><X size={15}/></button></div>
      </div>; })}</div>
      <button type="button" className="btn btn-soft text-xs" onClick={() => setLines(old => [...old, { productId: chosen ? String(chosen.lines.find(l => l.quantity > l.receivedQuantity)?.productId || '') : '', quantity: '1', tempC: '', expiryDate: '', sectionId: '' }])}><Plus size={14}/> Add {chosen ? 'split batch' : 'product'}</button>
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
    <div className="space-y-2 p-4">{d.lines.map((l,i) => <div key={`${l.productId}-${i}`} className="grid gap-2 rounded-xl bg-muted/45 p-3 sm:grid-cols-[1fr_auto]"><div><b className="text-xs">{l.productName}</b><div className="mt-1 text-[10px] text-muted-foreground">{l.quantity} received · {l.sectionName || 'Section unavailable'}{l.expiryDate ? ` · expires ${dateText(l.expiryDate)}` : ' · no expiry'}{l.tempC !== null ? ` · ${l.tempC}°C` : ''}</div>{l.issue && <div className="mt-1 text-[10px] font-bold text-[#98483e]">{l.issue}</div>}</div><span className={`self-center text-[10px] font-bold ${l.checkStatus === 'pass' ? 'text-[#28644b]' : 'text-[#875b15]'}`}>{l.checkStatus === 'pass' ? 'Checks passed' : 'Review flag'}</span></div>)}</div>
    {d.decisionNote && <p className="border-t border-border bg-[#f8eed6] px-5 py-3 text-xs">Decision note: {d.decisionNote}</p>}
    {canReview && d.status === 'pending_approval' && <div className="border-t border-border p-4"><label className="text-[10px] font-bold">Reviewer note<textarea className="field mt-1 min-h-16" value={notes[d.id] || ''} onChange={e => setNotes(old => ({ ...old, [d.id]: e.target.value }))} placeholder="Required to reject or return"/></label><div className="mt-2 flex justify-end gap-2"><button className="btn btn-soft text-xs" disabled={decide.isPending} onClick={() => decideItem(d, 'returned')}>Return</button><button className="btn btn-soft text-xs" disabled={decide.isPending} onClick={() => decideItem(d, 'rejected')}>Reject</button><button className="btn btn-primary text-xs" disabled={decide.isPending} onClick={() => decideItem(d, 'accepted')}><Check size={14}/> Accept</button></div></div>}
  </article>)}
    {visible.length === 0 && <div className="panel"><PanelEmpty title={approvalOnly ? 'No deliveries held for review' : 'No deliveries yet'} detail={approvalOnly ? 'Held receiving records will appear here for authorized review.' : 'Log supplier arrivals and keep stock checks traceable.'}/></div>}
  </div>;
}
export function DeliveriesPage() {
  const query = useListDeliveries({ query: { queryKey: getListDeliveriesQueryKey() } });
  const user = useGetCurrentUser({ query: { queryKey: getGetCurrentUserQueryKey() } });
  const [open, setOpen] = useState(false);
  const canReview = ['owner','admin','supervisor'].includes(user.data?.role || '');
  return <><Heading title="Deliveries" detail="Receive against an issued order or log an arrival directly." action={<button className="btn btn-primary" onClick={() => setOpen(true)}><Plus size={15}/> Receive delivery</button>}/>{query.isError ? <div className="panel p-6 text-center"><p className="text-sm font-bold">Deliveries did not load</p><button className="btn btn-soft mt-3" onClick={() => void query.refetch()}>Retry</button></div> : query.isLoading ? <div className="panel p-8"><div className="skeleton h-12 w-full"/></div> : <DeliveryRows rows={query.data || []} canReview={canReview}/ >}{open && <DeliveryEditor close={() => setOpen(false)}/>}</>;
}
export function ApprovalsPage() {
  const deliveries = useListDeliveries({ query: { queryKey: getListDeliveriesQueryKey() } });
  const orders = useListPurchaseOrders({}, { query: { queryKey: getListPurchaseOrdersQueryKey({}) } });
  const user = useGetCurrentUser({ query: { queryKey: getGetCurrentUserQueryKey() } });
  const decideOrder = useDecidePurchaseOrder();
  const qc = useQueryClient();
  const canReview = ['owner','admin','supervisor'].includes(user.data?.role || '');
  const pendingOrders = (orders.data || []).filter(o => o.status === 'pending');
  const decision = useMemo(() => pendingOrders, [orders.data]);
  return <><Heading title="Approvals" detail="Review held deliveries and legacy purchase requests without losing the decision trail."/>
    <h2 className="mb-3 text-sm font-extrabold">Held deliveries <span className="mono ml-1 text-muted-foreground">{(deliveries.data || []).filter(d => d.status === 'pending_approval').length}</span></h2>
    {deliveries.isLoading ? <div className="panel p-8"><div className="skeleton h-12 w-full"/></div> : deliveries.isError ? <div className="panel p-5"><button className="btn btn-soft" onClick={() => void deliveries.refetch()}>Retry deliveries</button></div> : <DeliveryRows rows={deliveries.data || []} canReview={canReview} approvalOnly/>}
    {decision.length > 0 && <section className="mt-7"><h2 className="mb-3 text-sm font-extrabold">Legacy purchase requests</h2><div className="panel divide-y divide-border">{decision.map(o => <div key={o.id} className="flex flex-wrap items-center justify-between gap-3 p-4"><div><b className="text-xs">Request #{o.id}</b><p className="mt-1 text-[10px] text-muted-foreground">{o.requestedBy} · {o.lines.map(l => `${l.productName} × ${l.quantity}`).join(', ')}</p></div><div className="flex gap-2"><button className="btn btn-soft text-xs" disabled={!canReview || decideOrder.isPending} onClick={() => decideOrder.mutate({ orderId: o.id, data: { decision: 'rejected' } }, { onSuccess: () => { toast.success('Request rejected'); void qc.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() }); }, onError: () => toast.error('Could not reject request') })}>Reject</button><button className="btn btn-primary text-xs" disabled={!canReview || decideOrder.isPending} onClick={() => decideOrder.mutate({ orderId: o.id, data: { decision: 'approved' } }, { onSuccess: () => { toast.success('Request approved'); void qc.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() }); }, onError: () => toast.error('Could not approve request') })}>Approve</button></div></div>)}</div></section>}
  </>;
}

type ScopeSelection = { scope: StockCountInputScope; category: string; section: string; product: string };
type ExcelRowLike = { getCell: (column: number) => { value: unknown } };
type WorkbookUploadPreview = StocktakeValidation & { drafts: Record<string, CountDraft> };
export function CountsPage() {
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  const counts = useListStockCounts({ query: { queryKey: getListStockCountsQueryKey() } });
  const products = useListProducts({ active: true }, { query: { queryKey: getListProductsQueryKey({ active: true }) } });
  const categories = useListProductCategories({ query: { queryKey: getListProductCategoriesQueryKey() } });
  const sections = useListStockSections({ query: { queryKey: getListStockSectionsQueryKey() } });
  const create = useCreateStockCount();
  const [show, setShow] = useState(false);
  const [scope, setScope] = useState<ScopeSelection>({ scope: 'all', category: '', section: '', product: '' });
  function start(e: FormEvent) {
    e.preventDefault();
    const data = { scope: scope.scope, ...(scope.scope === 'category' ? { category: scope.category } : {}), ...(scope.scope === 'section' ? { sectionId: Number(scope.section) } : {}), ...(scope.scope === 'product' ? { productId: Number(scope.product) } : {}) };
    create.mutate({ data }, { onSuccess: c => { toast.success('Count started'); void qc.invalidateQueries({ queryKey: getListStockCountsQueryKey() }); setLocation(`/counts/${c.id}`); }, onError: () => toast.error('Could not start count') });
  }
  const rows = counts.data || [];
  return <><Heading title="Stock counts" detail="Count an entire outlet, or focus on the category, area, or product that needs attention." action={<button className="btn btn-primary" onClick={() => setShow(true)}><ClipboardCheck size={15}/> Start count</button>}/>
    <div className="grid gap-3 sm:grid-cols-3"><div className="panel p-4"><div className="mono text-2xl">{rows.filter(c => c.status === 'in_progress').length}</div><div className="mt-1 text-[10px] text-muted-foreground">In progress</div></div><div className="panel p-4"><div className="mono text-2xl">{rows.filter(c => c.status === 'completed').length}</div><div className="mt-1 text-[10px] text-muted-foreground">Reconciled</div></div><div className="panel p-4"><div className="mono text-2xl">{products.data?.length ?? '—'}</div><div className="mt-1 text-[10px] text-muted-foreground">Active products</div></div></div>
    <section className="panel mt-5 overflow-hidden"><div className="border-b border-border px-5 py-4"><b className="text-sm">Recent count sessions</b><p className="mt-1 text-[11px] text-muted-foreground">Review an active count or open a completed reconciliation.</p></div>{counts.isLoading ? <div className="p-5"><div className="skeleton h-12 w-full"/></div> : counts.isError ? <div className="p-5"><button className="btn btn-soft" onClick={() => void counts.refetch()}>Retry</button></div> : rows.length ? rows.map(c => <Link href={`/counts/${c.id}`} key={c.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-5 py-4 last:border-0 hover:bg-muted/40"><div className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-xl bg-[#e7ebf6] text-primary"><ClipboardCheck size={17}/></span><div><b className="text-xs">{titleCase(c.scope)} count · #{c.id}</b><p className="mt-1 text-[10px] text-muted-foreground">{c.createdBy} · {dateText(c.createdAt)} · {c.lines.length} product-section pairs</p>{c.workbook && <p className="mt-1 truncate text-[10px] text-muted-foreground">Submitted workbook · {c.workbook.name} · {c.workbook.uploadedBy} · {dateTimeText(c.workbook.submittedAt)}</p>}</div></div><span className="text-xs font-bold">{titleCase(c.status)} <ArrowRight className="ml-1 inline" size={14}/></span></Link>) : <PanelEmpty title="No count sessions" detail="Start a count and capture the number physically on the shelf."/>}</section>
    {show && <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#0b1649]/45 p-0 sm:items-center sm:p-5"><section className="w-full max-w-lg rounded-t-2xl bg-card p-6 sm:rounded-2xl"><h2 className="zus-title text-2xl font-bold">Start a count</h2><p className="mb-5 mt-1 text-xs text-muted-foreground">The expected quantity stays hidden while counting.</p><form onSubmit={start} className="space-y-4"><label className="block text-xs font-bold">Scope<select className="field mt-1.5" value={scope.scope} onChange={e => setScope({ ...scope, scope: e.target.value as StockCountInputScope })}><option value="all">All products and sections</option><option value="category">Category</option><option value="section">Stock section</option><option value="product">Single product</option></select></label>{scope.scope === 'category' && <label className="block text-xs font-bold">Category<select required className="field mt-1.5" value={scope.category} onChange={e => setScope({ ...scope, category: e.target.value })}><option value="">Choose category</option>{(categories.data || []).map(c => <option key={c.id} value={c.key}>{c.name}</option>)}</select></label>}{scope.scope === 'section' && <label className="block text-xs font-bold">Stock section<select required className="field mt-1.5" value={scope.section} onChange={e => setScope({ ...scope, section: e.target.value })}><option value="">Choose section</option>{(sections.data || []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}{scope.scope === 'product' && <label className="block text-xs font-bold">Product<select required className="field mt-1.5" value={scope.product} onChange={e => setScope({ ...scope, product: e.target.value })}><option value="">Choose product</option>{(products.data || []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}<div className="flex justify-end gap-2"><button type="button" className="btn btn-soft" onClick={() => setShow(false)}>Cancel</button><button className="btn btn-primary" disabled={create.isPending || (scope.scope === 'section' && !scope.section) || (scope.scope === 'category' && !scope.category) || (scope.scope === 'product' && !scope.product)}>{create.isPending ? 'Starting…' : 'Create count'}</button></div></form></section></div>}
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
  const [acknowledgedMovementSignature, setAcknowledgedMovementSignature] = useState<string | null>(null);
  const [uploadPreview, setUploadPreview] = useState<WorkbookUploadPreview | null>(null);
  const [sourceWorkbook, setSourceWorkbook] = useState<File | null>(null);
  const [workbookUploadInProgress, setWorkbookUploadInProgress] = useState(false);
  const workbookSubmitInFlight = useRef(false);
  const [activeOutletId, setActiveOutletId] = useState<number | null>(null);
  const groupBy = 'section' as const;
  const [search, setSearch] = useState('');
  const [searchIn, setSearchIn] = useState<'all' | 'product' | 'category' | 'storage'>('all');
  const count = query.data;
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
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'ZUS Stockroom';
    const group = new Map<string, typeof count.lines>();
    for (const line of count.lines) {
      const sheetName = groupBy === 'section'
        ? (line.sectionName || 'Outlet total')
        : (productMap.get(line.productId)?.category || 'Uncategorised');
      group.set(sheetName, [...(group.get(sheetName) || []), line]);
    }
    const usedSheetNames = new Set<string>();
    for (const [groupName, lines] of group) {
      const prefix = groupBy === 'section' ? 'Area' : 'Category';
      const baseName = `${prefix} - ${groupName}`.replace(/[\\/*?:[\]]/g, '-').replace(/['"]+$/g, '').slice(0, 31);
      let sheetName = baseName;
      let suffix = 2;
      while (usedSheetNames.has(sheetName) || sheetName === STOCKTAKE_GUIDE_SHEET || sheetName === STOCKTAKE_MANIFEST_SHEET) {
        const ending = ` ${suffix++}`;
        sheetName = `${baseName.slice(0, 31 - ending.length)}${ending}`;
      }
      usedSheetNames.add(sheetName);
      const sheet = workbook.addWorksheet(sheetName);
      sheet.addRow([...STOCKTAKE_HEADERS]);
      sheet.columns = [
        { width: 32 }, { width: 22 }, { width: 16 }, { width: 20 },
        { width: 18 }, { width: 12 }, { width: 16 }, { width: 16 },
      ];
      sheet.getRow(1).font = { bold: true, color: { argb: 'FF101D79' } };
      for (const line of lines) {
        sheet.addRow([
          line.productName,
          line.sectionName || 'Outlet total',
          line.unit,
          line.expectedQuantity,
          null,
          line.productId,
          line.sectionId ?? '',
          count.id,
        ]);
      }
      sheet.getColumn(6).hidden = true;
      sheet.getColumn(7).hidden = true;
      sheet.getColumn(8).hidden = true;
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
      sheet.autoFilter = { from: 'A1', to: 'E1' };
    }
    const guide = workbook.addWorksheet(STOCKTAKE_GUIDE_SHEET);
    guide.addRows([
      ['ZUS Stockroom · stock count worksheet'],
      [`Outlet: ${outletName}`],
      [`Count session: #${count.id} · ${titleCase(count.scope)} · started ${dateText(count.createdAt)}`],
      ['Enter a physical quantity for every product and storage area. For bundled products, enter whole bundles and remaining base units. Enter 0 for an empty area.'],
      ['Expected quantity is a reference for this session. Do not change it or the hidden product and session IDs.'],
      ['Upload this workbook to the same count session. Review all rows and any validation errors before confirming.'],
    ]);
    guide.getColumn(1).width = 105;
    guide.getRow(1).font = { bold: true, size: 14, color: { argb: 'FF101D79' } };
    guide.eachRow(row => { row.height = 24; });
    const manifest = workbook.addWorksheet(STOCKTAKE_MANIFEST_SHEET);
    manifest.addRows([[STOCKTAKE_MANIFEST_MARKER], [count.id], [activeOutletId]]);
    manifest.state = 'hidden';
    const buffer = await workbook.xlsx.writeBuffer();
    const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const a = document.createElement('a'); a.href = url; a.download = `zus-stock-count-${count.id}-outlet-${activeOutletId}.xlsx`; a.click(); URL.revokeObjectURL(url);
    toast.success('Workbook template downloaded');
  }
  async function uploadWorkbook(file?: File): Promise<void> {
    if (!file || !count || activeOutletId === null) return;
    setSourceWorkbook(null);
    if (file.size > 5 * 1024 * 1024) { toast.error('Workbook must be 5 MB or smaller.'); return; }
    try {
      const buffer = await file.arrayBuffer();
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);
      const validation = validateStocktakeWorkbook({
        sheets: workbook.worksheets.map((sheet) => {
          const rows: unknown[][] = [];
          sheet.eachRow((row: ExcelRowLike) => {
            rows.push(Array.from({ length: STOCKTAKE_HEADERS.length }, (_, index) => row.getCell(index + 1).value));
          });
          return { name: sheet.name, rows };
        }),
        countId: count.id,
        outletId: activeOutletId,
        lines: count.lines,
      });
      let drafts: Record<string, CountDraft> = {};
      if (validation.issues.length === 0) {
        const parsed = await parseStockCountWorkbook(buffer, count.lines);
        if (parsed.issues.length > 0) {
          validation.issues.push(...parsed.issues);
        } else if (Object.keys(parsed.counts).length !== count.lines.length) {
          validation.issues.push('Workbook does not contain a counted quantity for every product and storage area.');
        } else {
          drafts = parsed.counts;
        }
      }
      setUploadPreview({ ...validation, drafts });
      if (validation.issues.length) {
        toast.error(`Workbook needs ${validation.issues.length} correction${validation.issues.length === 1 ? '' : 's'}.`);
      } else {
        setSourceWorkbook(file);
        toast.success(`${validation.validRows.length} rows validated. Review them before using these counts.`);
      }
    } catch {
      toast.error('Could not read this workbook. Use the downloaded .xlsx template.');
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
    const product = productMap.get(line.productId);
    const fields = {
      all: `${line.productName} ${product?.category || ''} ${line.sectionName || ''} ${line.unit}`,
      product: line.productName,
      category: product?.category || '',
      storage: line.sectionName || 'Outlet total',
    };
    return fields[searchIn].toLocaleLowerCase().includes(searchTerm);
  });
  const groupedLines = new Map<string, StockCountLine[]>();
  for (const line of visibleLines) {
    const group = line.sectionName || 'Outlet total';
    groupedLines.set(group, [...(groupedLines.get(group) || []), line]);
  }
  const summaryLines = count?.status === 'completed'
    ? count.lines.filter((line) => line.countedQuantity !== null)
    : [];
  const summaryExpected = summaryLines.reduce((sum, line) => sum + line.expectedQuantity, 0);
  const summaryCounted = summaryLines.reduce((sum, line) => sum + (line.countedQuantity ?? 0), 0);
  const summaryVariance = summaryCounted - summaryExpected;
  const stockTakeNumber = count ? stockTakeDocumentName(count.createdAt, count.id) : '';
  return <><div className="mb-5"><Link href="/counts" className="btn btn-ghost -ml-2 text-xs"><ArrowRight className="rotate-180" size={14}/> All counts</Link></div>
    {query.isLoading ? <div className="panel p-6"><div className="skeleton h-8 w-1/3"/><div className="skeleton mt-5 h-24 w-full"/></div> : query.isError || !count ? <div className="panel p-6"><b>Count could not be loaded</b><button className="btn btn-soft ml-3" onClick={() => void query.refetch()}>Retry</button></div> : <>
      <Heading title={`${titleCase(count.scope)} count`} detail={`Started by ${count.createdBy} · ${dateText(count.createdAt)} · ${count.lines.length} product-section pairs`} action={<div className="flex flex-wrap items-center gap-2">{count.status === 'completed' && count.workbook && <button className="btn btn-soft text-xs" onClick={() => void downloadSubmittedWorkbook()}><Download size={14}/> Download submitted workbook</button>}{count.status === 'completed' && <button className="btn btn-soft text-xs" title={`Print or save as ${stockTakeNumber}.pdf`} onClick={() => printNamedDocument(document.getElementById(`stock-take-print-${count.id}`), stockTakeNumber)}><Printer size={14}/> Print / Save PDF</button>}<span className={`rounded-full px-3 py-2 text-xs font-bold ${count.status === 'completed' ? 'bg-[#e5f0e9] text-[#28644b]' : 'bg-[#f8eed6] text-[#875b15]'}`}>{titleCase(count.status)}</span></div>}/>
      {count.workbook && <p className="mb-4 text-xs text-muted-foreground">Original workbook: <b className="text-foreground">{count.workbook.name}</b> · submitted by {count.workbook.uploadedBy} · {dateTimeText(count.workbook.submittedAt)}</p>}
      {count.status === 'completed' && <section id={`stock-take-print-${count.id}`} className="print-only-document p-8 text-black" data-print-document="stock-take">
        <header className="flex items-start justify-between border-b-2 border-black pb-5">
          <div><p className="text-xs font-bold uppercase tracking-[.18em]">ZUS Stockroom · Store Operations</p><h1 className="mt-3 text-3xl font-extrabold">Stock-take summary</h1><p className="mt-1 text-sm">{stockTakeNumber}</p></div>
          <div className="text-right text-sm"><p className="font-bold">Completed</p><p className="mt-2">Count date · {dateText(count.createdAt)}</p><p className="mt-1">Completed · {dateText(count.completedAt)}</p></div>
        </header>
        <div className="mt-6 grid grid-cols-2 gap-8 text-sm">
          <section><h2 className="mb-2 font-bold uppercase tracking-wide">Outlet</h2><p>{outletName}</p></section>
          <section><h2 className="mb-2 font-bold uppercase tracking-wide">Count details</h2><p>{titleCase(count.scope)} count · started by {count.createdBy}</p></section>
        </div>
        <div className="mt-7 grid grid-cols-3 gap-3 text-sm">
          <div className="rounded-lg border border-gray-300 p-3"><p className="text-xs uppercase tracking-wide">Lines counted</p><p className="mt-1 text-xl font-bold">{summaryLines.length}</p></div>
          <div className="rounded-lg border border-gray-300 p-3"><p className="text-xs uppercase tracking-wide">Expected total</p><p className="mt-1 text-xl font-bold">{quantityText(summaryExpected)}</p></div>
          <div className="rounded-lg border border-gray-300 p-3"><p className="text-xs uppercase tracking-wide">Counted total</p><p className="mt-1 text-xl font-bold">{quantityText(summaryCounted)}</p></div>
        </div>
        <p className="mt-3 text-sm"><b>Net variance:</b> {summaryVariance > 0 ? '+' : ''}{quantityText(summaryVariance)} units</p>
        <table className="mt-7 w-full border-collapse text-sm">
          <thead><tr><th className="border-b-2 border-black py-2 text-left">Product</th><th className="border-b-2 border-black py-2 text-left">Storage area</th><th className="border-b-2 border-black py-2 text-right">Expected</th><th className="border-b-2 border-black py-2 text-right">Counted</th><th className="border-b-2 border-black py-2 text-right">Variance</th></tr></thead>
          <tbody>{summaryLines.map((line) => {
            const variance = (line.countedQuantity ?? 0) - line.expectedQuantity;
            return <tr key={keyFor(line.productId, line.sectionId)}><td className="border-b border-gray-300 py-3">{line.productName}<span className="ml-1 text-xs">({line.unit})</span></td><td className="border-b border-gray-300 py-3">{line.sectionName || 'Outlet total'}</td><td className="border-b border-gray-300 py-3 text-right">{quantityText(line.expectedQuantity)}</td><td className="border-b border-gray-300 py-3 text-right">{quantityText(line.countedQuantity ?? 0)}</td><td className="border-b border-gray-300 py-3 text-right">{variance > 0 ? '+' : ''}{quantityText(variance)}</td></tr>;
          })}</tbody>
        </table>
        <p className="mt-5 text-xs">Only quantities entered during this stock take are included. Blank lines remain unchanged.</p>
      </section>}
      <div className="mb-4 flex flex-wrap items-end gap-2"><span className="self-center rounded-lg bg-[#e8edf6] px-3 py-2 text-[10px] font-bold text-primary">Grouped by storage area</span><span className="mr-2 self-center text-[10px] text-muted-foreground">Worksheet for {outletName} · count #{count.id}</span><button className="btn btn-soft" disabled={count.status === 'completed' || activeOutletId === null} onClick={() => void downloadTemplate()}><Download size={14}/> Download .xlsx worksheet</button><label className={`btn btn-soft ${count.status === 'completed' || activeOutletId === null ? 'pointer-events-none opacity-50' : 'cursor-pointer'}`}><Upload size={14}/> Upload completed worksheet<input className="sr-only" type="file" accept=".xlsx" disabled={count.status === 'completed' || activeOutletId === null} onChange={e => { void uploadWorkbook(e.target.files?.[0]); e.currentTarget.value = ''; }}/></label><span className="self-center text-[10px] text-muted-foreground">5 MB max · 5,000 rows</span>{sourceWorkbook && <span className="self-center text-[10px] text-muted-foreground">Source will be saved: {sourceWorkbook.name}</span>}</div>
      {uploadPreview && <section className={`mb-4 rounded-xl border p-4 text-xs ${uploadPreview.issues.length ? 'border-[#ead4cc] bg-[#fff4ef]' : 'border-[#d5e4d8] bg-[#f3f8f3]'}`}>
        <div className="flex flex-wrap items-center justify-between gap-2"><div><b>{uploadPreview.issues.length ? 'Worksheet needs attention' : 'Worksheet is ready to review'}</b><p className="mt-1 text-[10px] text-muted-foreground">{uploadPreview.validRows.length} valid row{uploadPreview.validRows.length === 1 ? '' : 's'} · {uploadPreview.issues.length} error{uploadPreview.issues.length === 1 ? '' : 's'} · no stock has changed</p></div><button type="button" className="btn btn-ghost p-2" aria-label="Close worksheet preview" onClick={() => setUploadPreview(null)}><X size={15}/></button></div>
        {uploadPreview.validRows.length > 0 && <div className="mt-3 max-h-36 overflow-y-auto rounded-lg border border-border/70 bg-card"><div className="grid grid-cols-[1fr_1fr_auto] gap-3 border-b border-border px-3 py-2 text-[9px] font-extrabold uppercase text-muted-foreground"><span>Product</span><span>Storage area</span><span>Counted</span></div>{uploadPreview.validRows.slice(0, 8).map(row => <div key={row.key} className="grid grid-cols-[1fr_1fr_auto] gap-3 border-b border-border/60 px-3 py-2 last:border-0"><span className="truncate">{row.productName}</span><span className="truncate text-muted-foreground">{row.sectionName}</span><span className="mono">{row.quantity}</span></div>)}{uploadPreview.validRows.length > 8 && <p className="px-3 py-2 text-[10px] text-muted-foreground">And {uploadPreview.validRows.length - 8} more valid rows.</p>}</div>}
        {uploadPreview.issues.length > 0 && <ul className="mt-3 max-h-36 list-inside list-disc space-y-1 overflow-y-auto">{uploadPreview.issues.slice(0, 8).map((issue,i) => <li key={i}>{issue}</li>)}</ul>}
        {uploadPreview.issues.length > 8 && <p className="mt-1">And {uploadPreview.issues.length - 8} more errors.</p>}
        <div className="mt-3 flex justify-end"><button type="button" className="btn btn-primary" disabled={uploadPreview.issues.length > 0 || uploadPreview.validRows.length !== count.lines.length || Object.keys(uploadPreview.drafts).length !== count.lines.length} onClick={() => { setCounts(old => ({ ...old, ...uploadPreview.drafts })); setUploadPreview(null); setReview(false); toast.success('Validated counts added for review'); }}>Use these counts</button></div>
      </section>}
      {batches.isError && <div className="mb-3 rounded-xl bg-[#fff4ef] p-3 text-xs">Batch expiry details are unavailable, but count entry is still available.</div>}
      <div className="panel mb-3 flex flex-col gap-2 p-3 sm:flex-row sm:items-center"><Search size={16} className="hidden shrink-0 text-muted-foreground sm:block"/><input aria-label="Search stock count" className="field border-0 bg-transparent shadow-none" placeholder="Search stock count" value={search} onChange={(e) => setSearch(e.target.value)}/><select aria-label="Search stock count in" className="field sm:w-44" value={searchIn} onChange={(e) => setSearchIn(e.target.value as typeof searchIn)}><option value="all">All fields</option><option value="product">Product name</option><option value="category">Category</option><option value="storage">Storage area</option></select>{search && <button className="btn btn-ghost px-2 py-1 text-xs" onClick={() => setSearch('')}>Clear</button>}</div>
      <form onSubmit={reviewCount}><div className="panel overflow-x-auto"><div className="grid min-w-[720px] grid-cols-[minmax(190px,1fr)_minmax(130px,.8fr)_100px_110px_130px] gap-3 border-b border-border bg-muted/50 px-5 py-3 text-[10px] font-extrabold uppercase tracking-wider text-muted-foreground"><span>Product</span><span>Stock section</span><span>Bundles</span><span>Loose units</span><span>Counted total</span></div>
        {[...groupedLines.entries()].map(([group, lines]) => <section key={group}><h2 className="sticky top-0 z-10 border-b border-border bg-[#e8edf6] px-5 py-2 text-xs font-extrabold text-primary">{group}<span className="ml-2 font-medium text-muted-foreground">{lines.length} product{lines.length === 1 ? '' : 's'}</span></h2>{lines.map(line => { const key = keyFor(line.productId,line.sectionId); const p = productMap.get(line.productId); const current = draft(line); const total = calculate(line); const size = bundleSize(line); const hasBundle = size > 1; return <div key={key} className="grid min-w-[720px] grid-cols-[minmax(190px,1fr)_minmax(130px,.8fr)_100px_110px_130px] items-center gap-3 border-b border-border/70 px-5 py-4 last:border-0"><div><b className="text-xs">{line.productName}</b><div className="mt-1 text-[10px] text-muted-foreground">{p?.category || 'Uncategorised'} · {hasBundle ? `${size} ${p?.bundleUnit} = 1 bundle` : line.unit}</div></div><span className="text-xs text-muted-foreground">{line.sectionName || 'Outlet total'}</span><input aria-label={`Bundle count ${line.productName}`} disabled={count.status === 'completed' || !hasBundle} className="field px-2 text-center mono disabled:opacity-50" type="number" min="0" step="1" value={current.bundles} placeholder={hasBundle ? '0' : '—'} onChange={e => setDraftValue(line, 'bundles', e.target.value)}/><input aria-label={`Loose count ${line.productName}`} disabled={count.status === 'completed'} className="field px-2 text-center mono" type="number" min="0" step="1" value={current.loose} placeholder="0" onChange={e => setDraftValue(line, 'loose', e.target.value)}/><span className="mono text-xs">{total === null ? '—' : total}</span></div>; })}</section>)}
        {visibleLines.length === 0 && <div className="p-8 text-center text-sm text-muted-foreground">No products match this search.</div>}
      </div><div className="mt-4 flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-muted-foreground">{count.lines.filter(hasEntry).length} of {count.lines.length} pairs counted</span>{count.status !== 'completed' && <button className="btn btn-primary" disabled={submitCount.isPending}><CheckCircle2 size={15}/> Review count</button>}</div></form>
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
