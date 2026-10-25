import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCurrentUserQueryKey,
  getGetDashboardSummaryQueryKey,
  getGetStockTransferOptionsQueryKey,
  getListProductsQueryKey,
  getListStockBatchesQueryKey,
  getListStockMovementsQueryKey,
  getListStockSectionsQueryKey,
  getListStockTransfersQueryKey,
  useCreateStockTransfer,
  useGetCurrentUser,
  useGetStockTransferOptions,
  useListProducts,
  useListStockTransfers,
} from "@workspace/api-client-react";
import { ArrowDownRight, ArrowLeftRight, ArrowUpRight, RefreshCw } from "lucide-react";
import { toast } from "sonner";

const managerRoles = ["owner", "admin", "supervisor"];
const epsilon = 0.001;
const formatTime = (value: string | Date) =>
  new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

export default function StockTransfersPage() {
  const queryClient = useQueryClient();
  const userQuery = useGetCurrentUser({
    query: { queryKey: getGetCurrentUserQueryKey() },
  });
  const canTransfer = managerRoles.includes(userQuery.data?.role ?? "");
  const activeOutletId = userQuery.data?.activeOutletId ?? 0;
  const outlets = userQuery.data?.outlets ?? [];
  const productsQuery = useListProducts(
    { active: true },
    { query: { queryKey: getListProductsQueryKey({ active: true }) } },
  );
  const transferParams = { limit: 100 };
  const historyQuery = useListStockTransfers(transferParams, {
    query: { queryKey: getListStockTransfersQueryKey(transferParams) },
  });
  const createTransfer = useCreateStockTransfer();
  const [destinationOutletId, setDestinationOutletId] = useState("");
  const [productId, setProductId] = useState("");
  const [destinationProductId, setDestinationProductId] = useState("");
  const [sourceSectionId, setSourceSectionId] = useState("");
  const [destinationSectionId, setDestinationSectionId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const attemptRef = useRef<{ body: string; key: string } | null>(null);

  useEffect(() => {
    if (!activeOutletId || !outlets.length) return;
    setDestinationOutletId((current) =>
      current && outlets.some((outlet) => String(outlet.id) === current)
        ? current
        : String(outlets.find((outlet) => outlet.id !== activeOutletId)?.id ?? activeOutletId),
    );
  }, [activeOutletId, outlets]);

  const products = productsQuery.data ?? [];
  useEffect(() => {
    if (!products.length) {
      setProductId("");
      return;
    }
    setProductId((current) =>
      current && products.some((product) => String(product.id) === current)
        ? current
        : String(products[0].id),
    );
  }, [products]);

  const optionsParams = {
    destinationOutletId: Number(destinationOutletId || 0),
    productId: Number(productId || 0),
  };
  const optionsQuery = useGetStockTransferOptions(optionsParams, {
    query: {
      queryKey: getGetStockTransferOptionsQueryKey(optionsParams),
      enabled: canTransfer && optionsParams.destinationOutletId > 0 && optionsParams.productId > 0,
    },
  });
  const options = optionsQuery.data;
  const isSameOutlet = Number(destinationOutletId) === activeOutletId;
  const destinationProducts = (options?.destinationProducts ?? []).filter((product) =>
    isSameOutlet ? product.id === options?.sourceProduct.id : true,
  );
  const destinationProduct =
    destinationProducts.find((product) => String(product.id) === destinationProductId) ??
    destinationProducts[0];
  const sourceSections = options?.sourceSections ?? [];
  const destinationSections = destinationProduct?.sections ?? [];
  const sourceSection =
    sourceSections.find((section) => String(section.id) === sourceSectionId) ??
    sourceSections.find((section) => section.quantity > epsilon) ??
    sourceSections[0];
  const destinationSection =
    destinationSections.find((section) => String(section.id) === destinationSectionId) ??
    destinationSections[0];

  useEffect(() => {
    if (!options) {
      setDestinationProductId("");
      setSourceSectionId("");
      setDestinationSectionId("");
      return;
    }
    const candidates = options.destinationProducts.filter((product) =>
      Number(destinationOutletId) === activeOutletId
        ? product.id === options.sourceProduct.id
        : true,
    );
    setDestinationProductId((current) =>
      current && candidates.some((product) => String(product.id) === current)
        ? current
        : String(candidates[0]?.id ?? ""),
    );
    setSourceSectionId((current) =>
      current && options.sourceSections.some((section) => String(section.id) === current)
        ? current
        : String(
            options.sourceSections.find((section) => section.quantity > epsilon)?.id ??
              options.sourceSections[0]?.id ??
              "",
          ),
    );
  }, [activeOutletId, destinationOutletId, options]);

  useEffect(() => {
    if (!destinationProduct) {
      setDestinationSectionId("");
      return;
    }
    setDestinationSectionId((current) =>
      current && destinationProduct.sections.some((section) => String(section.id) === current)
        ? current
        : String(destinationProduct.sections[0]?.id ?? ""),
    );
  }, [destinationProduct]);

  const sourceQuantity = sourceSection?.quantity ?? 0;
  const destinationQuantity = destinationSection?.quantity ?? 0;
  const numericQuantity = Number(quantity);
  const sameSection =
    isSameOutlet &&
    Boolean(sourceSection && destinationSection && sourceSection.id === destinationSection.id);
  const canSubmit =
    canTransfer &&
    Boolean(options && sourceSection && destinationSection && destinationProduct) &&
    !sameSection &&
    Number.isFinite(numericQuantity) &&
    numericQuantity > 0 &&
    numericQuantity <= sourceQuantity + epsilon &&
    !createTransfer.isPending;

  function invalidateInventory() {
    void queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListStockBatchesQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListStockMovementsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListStockSectionsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListStockTransfersQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetStockTransferOptionsQueryKey() });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!options || !sourceSection || !destinationSection || !destinationProduct || !canSubmit) return;
    const draft = {
      destinationOutletId: Number(destinationOutletId),
      productId: options.sourceProduct.id,
      destinationProductId: destinationProduct.id,
      sourceSectionId: sourceSection.id,
      destinationSectionId: destinationSection.id,
      quantity: numericQuantity,
      expectedSourceQuantity: sourceQuantity,
      expectedDestinationQuantity: destinationQuantity,
      note: note.trim() || undefined,
    };
    const serialized = JSON.stringify(draft);
    if (!attemptRef.current || attemptRef.current.body !== serialized) {
      attemptRef.current = { body: serialized, key: crypto.randomUUID() };
    }
    createTransfer.mutate(
      { data: { ...draft, clientKey: attemptRef.current.key } },
      {
        onSuccess: (transfer) => {
          toast.success(`Transfer ${transfer.reference} recorded`);
          attemptRef.current = null;
          setQuantity("");
          setNote("");
          invalidateInventory();
          void historyQuery.refetch();
          void optionsQuery.refetch();
        },
        onError: (error) => {
          toast.error(errorMessage(error, "Could not record this transfer"));
        },
      },
    );
  }

  const history = historyQuery.data ?? [];

  return (
    <>
      <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mono mb-2 text-[10px] font-medium uppercase tracking-[.16em] text-primary">
            Inventory movement
          </div>
          <h1 className="zus-title text-[2rem] font-bold leading-none tracking-tight sm:text-[2.55rem]">
            Stock transfers
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Move stock between physical storage areas or outlets without losing expiry-batch traceability.
          </p>
        </div>
        <button className="btn btn-soft" onClick={() => { void optionsQuery.refetch(); void historyQuery.refetch(); }}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {canTransfer ? (
        <section className="panel mb-5 p-5 sm:p-6">
          <div className="mb-5 flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#e8eee7] text-primary">
              <ArrowLeftRight size={18} />
            </span>
            <div>
              <h2 className="text-base font-extrabold">Record a transfer</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Source is the selected outlet. Choose another outlet to move stock between locations.
              </p>
            </div>
          </div>
          {productsQuery.isError && (
            <div role="alert" className="mb-4 rounded-xl bg-[#fff4ef] p-3 text-xs text-[#98483e]">
              Could not load products from this outlet. Refresh and try again.
            </div>
          )}
          <form onSubmit={submit} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs font-bold">
                Product in this outlet
                <select
                  required
                  className="field mt-1.5"
                  value={productId}
                  onChange={(event) => { setProductId(event.target.value); setQuantity(""); }}
                  disabled={productsQuery.isLoading}
                >
                  <option value="">Choose product</option>
                  {products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name} · {product.stockOnHand} {product.unit}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs font-bold">
                Destination outlet
                <select
                  required
                  className="field mt-1.5"
                  value={destinationOutletId}
                  onChange={(event) => {
                    setDestinationOutletId(event.target.value);
                    setDestinationProductId("");
                    setDestinationSectionId("");
                    setQuantity("");
                  }}
                >
                  {outlets.map((outlet) => (
                    <option key={outlet.id} value={outlet.id}>
                      {outlet.name}{outlet.id === activeOutletId ? " (same outlet)" : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {optionsQuery.isLoading && <div className="skeleton h-16 w-full" />}
            {optionsQuery.isError && (
              <div role="alert" className="rounded-xl bg-[#fff4ef] p-3 text-xs text-[#98483e]">
                Could not load transfer locations. Check that you have access to both outlets, then retry.
              </div>
            )}

            {options && (
              <>
                {!isSameOutlet && (
                  <label className="block text-xs font-bold">
                    Matching product at {options.destinationOutlet.name}
                    <select
                      required
                      className="field mt-1.5"
                      value={destinationProduct?.id ?? ""}
                      onChange={(event) => {
                        setDestinationProductId(event.target.value);
                        setDestinationSectionId("");
                        setQuantity("");
                      }}
                    >
                      <option value="">Choose matching product</option>
                      {destinationProducts.map((product) => (
                        <option key={product.id} value={product.id}>
                          {product.name} · {product.unit}
                        </option>
                      ))}
                    </select>
                    <span className="mt-1 block text-[10px] font-normal text-muted-foreground">
                      Only active products with the same unit and bundle size are listed.
                    </span>
                  </label>
                )}
                {!isSameOutlet && !destinationProducts.length && (
                  <div className="rounded-xl bg-[#f5f1e7] p-3 text-xs text-[#76531b]">
                    Add an active matching product in the destination outlet before transferring stock.
                  </div>
                )}
                {destinationProduct && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block text-xs font-bold">
                      From · {options.sourceOutlet.name}
                      <select
                        required
                        className="field mt-1.5"
                        value={sourceSection?.id ?? ""}
                        onChange={(event) => setSourceSectionId(event.target.value)}
                      >
                        {sourceSections.map((section) => (
                          <option key={section.id} value={section.id}>
                            {section.name} · {section.quantity} {options.sourceProduct.unit}
                          </option>
                        ))}
                      </select>
                      <span className="mt-1 block text-[10px] font-normal text-muted-foreground">
                        Available: {sourceQuantity} {options.sourceProduct.unit}
                      </span>
                    </label>
                    <label className="block text-xs font-bold">
                      To · {options.destinationOutlet.name}
                      <select
                        required
                        className="field mt-1.5"
                        value={destinationSection?.id ?? ""}
                        onChange={(event) => setDestinationSectionId(event.target.value)}
                      >
                        {destinationSections.map((section) => (
                          <option key={section.id} value={section.id}>
                            {section.name} · {section.quantity} {destinationProduct.unit}
                          </option>
                        ))}
                      </select>
                      <span className="mt-1 block text-[10px] font-normal text-muted-foreground">
                        Currently stored: {destinationQuantity} {destinationProduct.unit}
                      </span>
                    </label>
                  </div>
                )}
                {sameSection && (
                  <div className="rounded-xl bg-[#f8eed6] p-3 text-xs text-[#76531b]">
                    Choose a different storage area for the destination.
                  </div>
                )}
                {destinationProduct && (
                  <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
                    <label className="block text-xs font-bold">
                      Quantity · {options.sourceProduct.unit}
                      <input
                        required
                        className="field mt-1.5"
                        type="number"
                        min="0.01"
                        max={sourceQuantity}
                        step="0.01"
                        value={quantity}
                        onChange={(event) => setQuantity(event.target.value)}
                      />
                    </label>
                    <label className="block text-xs font-bold">
                      Note <span className="font-normal text-muted-foreground">optional</span>
                      <input
                        className="field mt-1.5"
                        maxLength={1000}
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                        placeholder="Reason or handover details"
                      />
                    </label>
                  </div>
                )}
                {sourceSection && destinationSection && destinationProduct && numericQuantity > 0 && (
                  <div className="rounded-xl border border-border bg-muted/30 p-3 text-xs">
                    <div className="font-bold">
                      {options.sourceProduct.name}: {sourceSection.name} → {destinationSection.name}
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      Outlet total {isSameOutlet ? "stays the same" : `moves from ${options.sourceOutlet.name} to ${options.destinationOutlet.name}`} · {numericQuantity} {options.sourceProduct.unit}
                    </div>
                  </div>
                )}
                <div className="flex justify-end border-t border-border pt-4">
                  <button className="btn btn-primary" disabled={!canSubmit}>
                    <ArrowLeftRight size={15} />
                    {createTransfer.isPending ? "Recording…" : "Record transfer"}
                  </button>
                </div>
              </>
            )}
          </form>
        </section>
      ) : (
        <div className="panel mb-5 p-4 text-sm text-muted-foreground">
          Stock transfers can be recorded by an owner, admin, or supervisor. You can still review transfer history below.
        </div>
      )}

      <section className="panel overflow-hidden">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-base font-extrabold">Transfer history</h2>
          <p className="mt-1 text-xs text-muted-foreground">The record keeps the section balances and names as they were when the transfer was posted.</p>
        </div>
        {historyQuery.isLoading ? (
          <div className="p-6 text-sm text-muted-foreground">Loading transfer history…</div>
        ) : historyQuery.isError ? (
          <div className="p-6 text-sm text-[#98483e]">Could not load transfer history. Refresh and try again.</div>
        ) : history.length ? (
          <div className="divide-y divide-border/70">
            {history.map((transfer) => {
              const sent = transfer.sourceOutletId === activeOutletId;
              return (
                <details key={transfer.id} className="group px-5 py-4">
                  <summary className="grid cursor-pointer list-none gap-3 sm:grid-cols-[1fr_1.2fr_1fr_auto] sm:items-center">
                    <div>
                      <div className="flex items-center gap-2 text-xs font-extrabold">
                        {sent ? <ArrowUpRight size={15} className="text-[#a65339]" /> : <ArrowDownRight size={15} className="text-primary" />}
                        {transfer.reference}
                        <span className={`rounded-full px-2 py-1 text-[9px] ${sent ? "bg-[#f5e8de] text-[#98483e]" : "bg-[#e5eee6] text-primary"}`}>
                          {sent ? "Sent" : "Received"}
                        </span>
                      </div>
                      <div className="mt-1 text-[10px] text-muted-foreground">{formatTime(transfer.occurredAt)} · {transfer.actor}</div>
                    </div>
                    <div className="text-xs font-bold">
                      {transfer.sourceProductName}
                      <div className="mt-1 text-[10px] font-normal text-muted-foreground">
                        {transfer.sourceOutletName} · {transfer.sourceSectionName}
                        <span className="mx-1">→</span>
                        {transfer.destinationOutletName} · {transfer.destinationSectionName}
                      </div>
                    </div>
                    <div className="mono text-xs font-bold">
                      {transfer.quantity} {transfer.unit}
                    </div>
                    <span className="text-[10px] font-bold text-primary group-open:hidden">Details</span>
                    <span className="hidden text-[10px] font-bold text-primary group-open:inline">Hide</span>
                  </summary>
                  <div className="mt-4 grid gap-3 rounded-xl bg-muted/30 p-4 text-xs sm:grid-cols-2">
                    <div>
                      <div className="font-extrabold">Section balances</div>
                      <p className="mt-2 text-muted-foreground">
                        {transfer.sourceSectionName}: {transfer.sourceBefore} → {transfer.sourceAfter} {transfer.unit}
                      </p>
                      <p className="mt-1 text-muted-foreground">
                        {transfer.destinationSectionName}: {transfer.destinationBefore} → {transfer.destinationAfter} {transfer.unit}
                      </p>
                    </div>
                    <div>
                      <div className="font-extrabold">Outlet totals</div>
                      <p className="mt-2 text-muted-foreground">
                        {transfer.sourceOutletName}: {transfer.sourceTotalBefore} → {transfer.sourceTotalAfter} {transfer.unit}
                      </p>
                      <p className="mt-1 text-muted-foreground">
                        {transfer.destinationOutletName}: {transfer.destinationTotalBefore} → {transfer.destinationTotalAfter} {transfer.unit}
                      </p>
                    </div>
                    {transfer.note && <p className="whitespace-pre-wrap text-muted-foreground sm:col-span-2">Note: {transfer.note}</p>}
                  </div>
                </details>
              );
            })}
          </div>
        ) : (
          <div className="grid min-h-48 place-items-center p-6 text-center">
            <div>
              <ArrowLeftRight size={24} className="mx-auto mb-3 text-primary" />
              <div className="font-extrabold">No transfers yet</div>
              <p className="mt-1 text-sm text-muted-foreground">Transfers involving this outlet will appear here.</p>
            </div>
          </div>
        )}
      </section>
    </>
  );
}
