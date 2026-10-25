import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCurrentUserQueryKey,
  getListProductCategoriesQueryKey,
  getListProductsQueryKey,
  getListStockBatchesQueryKey,
  getListStockMovementsQueryKey,
  getListStockSectionsQueryKey,
  getListStockTransfersQueryKey,
  useCreateProductCategory,
  useCreateStockSection,
  useDeleteProductCategory,
  useDeleteStockSection,
  useGetCurrentUser,
  useListProductCategories,
  useListStockSections,
  useUpdateProductCategory,
  useUpdateStockSection,
} from "@workspace/api-client-react";
import { toast } from "sonner";
import { ArrowLeftRight, Check, Pencil, Plus, Trash2, X } from "lucide-react";

const managerRoles = ["owner", "admin", "supervisor"];
const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

export default function CatalogueSettings() {
  const queryClient = useQueryClient();
  const userQuery = useGetCurrentUser({
    query: { queryKey: getGetCurrentUserQueryKey() },
  });
  const categoriesQuery = useListProductCategories({
    query: { queryKey: getListProductCategoriesQueryKey() },
  });
  const sectionsQuery = useListStockSections({
    query: { queryKey: getListStockSectionsQueryKey() },
  });
  const createCategory = useCreateProductCategory();
  const updateCategory = useUpdateProductCategory();
  const deleteCategory = useDeleteProductCategory();
  const createSection = useCreateStockSection();
  const updateSection = useUpdateStockSection();
  const deleteSection = useDeleteStockSection();
  const [categoryName, setCategoryName] = useState("");
  const [sectionName, setSectionName] = useState("");
  const [editingCategory, setEditingCategory] = useState<number | null>(null);
  const [editingSection, setEditingSection] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editTempMinC, setEditTempMinC] = useState("");
  const [editTempMaxC, setEditTempMaxC] = useState("");
  const [editHandlingSop, setEditHandlingSop] = useState("");
  const [deleteCategoryId, setDeleteCategoryId] = useState<number | null>(null);
  const [deleteSectionId, setDeleteSectionId] = useState<number | null>(null);
  const canManage = managerRoles.includes(userQuery.data?.role ?? "");
  const categories = categoriesQuery.data ?? [];
  const sections = sectionsQuery.data ?? [];
  const isLoading = categoriesQuery.isLoading || sectionsQuery.isLoading;
  const isError = categoriesQuery.isError || sectionsQuery.isError;

  function refreshProductsAndLists() {
    void queryClient.invalidateQueries({ queryKey: getListProductCategoriesQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListStockSectionsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListStockBatchesQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListStockMovementsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListStockTransfersQueryKey() });
  }

  function submitCategory(event: FormEvent) {
    event.preventDefault();
    const name = categoryName.trim();
    if (!name) return;
    createCategory.mutate(
      { data: { name } },
      {
        onSuccess: () => {
          setCategoryName("");
          refreshProductsAndLists();
          toast.success("Category added");
        },
        onError: (error) => toast.error(errorMessage(error, "Could not add category")),
      },
    );
  }

  function saveCategory(event: FormEvent) {
    event.preventDefault();
    const category = categories.find((item) => item.id === editingCategory);
    const name = editName.trim();
    if (!category || !name) return;
    const receivingTempMinC = editTempMinC.trim() === "" ? null : Number(editTempMinC);
    const receivingTempMaxC = editTempMaxC.trim() === "" ? null : Number(editTempMaxC);
    if (
      (receivingTempMinC === null) !== (receivingTempMaxC === null) ||
      (receivingTempMinC !== null &&
        receivingTempMaxC !== null &&
        receivingTempMinC > receivingTempMaxC)
    ) {
      toast.error("Set both temperature limits and keep the minimum at or below the maximum.");
      return;
    }
    updateCategory.mutate(
      {
        categoryId: category.id,
        data: {
          name,
          receivingTempMinC,
          receivingTempMaxC,
          receivingHandlingSop: editHandlingSop.trim(),
        },
      },
      {
        onSuccess: () => {
          setEditingCategory(null);
          refreshProductsAndLists();
          toast.success("Category and receiving SOP saved");
        },
        onError: (error) => toast.error(errorMessage(error, "Could not rename category")),
      },
    );
  }

  function removeCategory(id: number) {
    deleteCategory.mutate(
      { categoryId: id },
      {
        onSuccess: () => {
          setDeleteCategoryId(null);
          refreshProductsAndLists();
          toast.success("Category deleted");
        },
        onError: (error) => toast.error(errorMessage(error, "Could not delete category")),
      },
    );
  }

  function submitSection(event: FormEvent) {
    event.preventDefault();
    const name = sectionName.trim();
    if (!name) return;
    createSection.mutate(
      { data: { name } },
      {
        onSuccess: () => {
          setSectionName("");
          refreshProductsAndLists();
          toast.success("Storage area added");
        },
        onError: (error) => toast.error(errorMessage(error, "Could not add storage area")),
      },
    );
  }

  function saveSection(event: FormEvent) {
    event.preventDefault();
    const section = sections.find((item) => item.id === editingSection);
    const name = editName.trim();
    if (!section || !name) return;
    updateSection.mutate(
      { sectionId: section.id, data: { name } },
      {
        onSuccess: () => {
          setEditingSection(null);
          refreshProductsAndLists();
          toast.success("Storage area renamed");
        },
        onError: (error) => toast.error(errorMessage(error, "Could not rename storage area")),
      },
    );
  }

  function removeSection(id: number) {
    deleteSection.mutate(
      { sectionId: id },
      {
        onSuccess: () => {
          setDeleteSectionId(null);
          refreshProductsAndLists();
          toast.success("Storage area deleted");
        },
        onError: (error) => toast.error(errorMessage(error, "Could not delete storage area")),
      },
    );
  }

  const canSaveCategory = !createCategory.isPending && categoryName.trim().length > 0;
  const canSaveSection = !createSection.isPending && sectionName.trim().length > 0;

  return (
    <>
      <div className="mb-7">
        <div className="mono mb-2 text-[10px] font-medium uppercase tracking-[.16em] text-primary">
          Product catalogue
        </div>
        <h1 className="zus-title text-[2rem] font-bold leading-none tracking-tight sm:text-[2.55rem]">
          Categories & storage
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Set up product categories and the physical stock areas for this outlet.
          Stock areas keep independent balances; transfers do not change the overall stock total.
        </p>
      </div>

      {!canManage && (
        <div className="panel mb-4 p-4 text-sm text-muted-foreground">
          You can view these lists. An owner, admin, or supervisor can make changes.
        </div>
      )}

      {isLoading ? (
        <div className="panel p-6 text-sm text-muted-foreground">Loading categories and storage areas…</div>
      ) : isError ? (
        <div className="panel p-6 text-sm text-[#98483e]">
          Could not load the outlet lists. Refresh the page and try again.
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <section className="panel overflow-hidden">
            <div className="border-b border-border p-5">
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#e8eee7] text-primary">
                  <span className="text-sm font-black">Aa</span>
                </span>
                <div>
                  <h2 className="text-base font-extrabold">Product categories</h2>
                  <p className="mt-1 text-xs text-muted-foreground">Group products here and set the receiving temperature and handling SOP shared by each category.</p>
                </div>
              </div>
              {canManage && (
                <form onSubmit={submitCategory} className="mt-4 flex gap-2">
                  <input
                    aria-label="New category name"
                    className="field"
                    maxLength={80}
                    placeholder="e.g. Dairy"
                    value={categoryName}
                    onChange={(event) => setCategoryName(event.target.value)}
                  />
                  <button className="btn btn-primary shrink-0" disabled={!canSaveCategory}>
                    <Plus size={15} /> Add
                  </button>
                </form>
              )}
            </div>
            <div className="divide-y divide-border/70">
              {categories.map((category) => (
                <div key={category.id} className="flex min-h-16 items-center justify-between gap-3 px-5 py-3">
                  {editingCategory === category.id ? (
                    <form onSubmit={saveCategory} className="w-full space-y-3">
                      <label className="block text-xs font-bold">
                        Category name
                        <input
                          autoFocus
                          aria-label={`Category name for ${category.name}`}
                          className="field mt-1.5"
                          maxLength={80}
                          value={editName}
                          onChange={(event) => setEditName(event.target.value)}
                        />
                      </label>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <label className="block text-xs font-bold">
                          Receiving minimum °C
                          <input type="number" min="-60" max="100" step=".1" className="field mt-1.5" value={editTempMinC} onChange={(event) => setEditTempMinC(event.target.value)} placeholder="Optional" />
                        </label>
                        <label className="block text-xs font-bold">
                          Receiving maximum °C
                          <input type="number" min="-60" max="100" step=".1" className="field mt-1.5" value={editTempMaxC} onChange={(event) => setEditTempMaxC(event.target.value)} placeholder="Optional" />
                        </label>
                      </div>
                      <label className="block text-xs font-bold">
                        Receiving and handling SOP
                        <textarea maxLength={4000} className="field mt-1.5 min-h-20 resize-y" value={editHandlingSop} onChange={(event) => setEditHandlingSop(event.target.value)} placeholder="Instructions shared by every product in this category" />
                      </label>
                      <div className="flex justify-end gap-2">
                        <button className="btn btn-primary px-3" disabled={!editName.trim() || updateCategory.isPending}>
                          <Check size={15} /> Save category
                        </button>
                        <button type="button" className="btn btn-soft px-3" onClick={() => setEditingCategory(null)} aria-label="Cancel category edit">
                          <X size={15} />
                        </button>
                      </div>
                    </form>
                  ) : deleteCategoryId === category.id ? (
                    <div className="flex w-full flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-bold">Delete {category.name}? Products using it must be reassigned first.</span>
                      <span className="flex gap-2">
                        <button className="btn btn-soft text-xs" onClick={() => setDeleteCategoryId(null)}>Cancel</button>
                        <button className="btn btn-soft text-xs text-[#98483e]" disabled={deleteCategory.isPending} onClick={() => removeCategory(category.id)}>Delete</button>
                      </span>
                    </div>
                  ) : (
                    <>
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-bold">{category.name}</span>
                            {category.isDefault && <span className="rounded-full bg-muted px-2 py-1 text-[9px] font-bold text-muted-foreground">Default</span>}
                          </div>
                          <div className="mt-1 text-[10px] text-muted-foreground">
                            {category.receivingTempMinC !== null && category.receivingTempMaxC !== null
                              ? `${category.receivingTempMinC}°C to ${category.receivingTempMaxC}°C`
                              : "No temperature range"}
                            {category.receivingHandlingSop ? " · Receiving SOP set" : ""}
                          </div>
                        </div>
                      </div>
                      {canManage && (
                        <div className="flex shrink-0 gap-1">
                          <button className="btn btn-ghost p-2" aria-label={`Edit ${category.name} category and receiving SOP`} onClick={() => {
                            setEditingCategory(category.id);
                            setEditName(category.name);
                            setEditTempMinC(category.receivingTempMinC === null ? "" : String(category.receivingTempMinC));
                            setEditTempMaxC(category.receivingTempMaxC === null ? "" : String(category.receivingTempMaxC));
                            setEditHandlingSop(category.receivingHandlingSop);
                            setDeleteCategoryId(null);
                          }}>
                            <Pencil size={14} />
                          </button>
                          <button className="btn btn-ghost p-2 text-[#98483e]" aria-label={`Delete ${category.name}`} onClick={() => setDeleteCategoryId(category.id)}>
                            <Trash2 size={14} />
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
              {!categories.length && <div className="p-5 text-sm text-muted-foreground">No categories yet.</div>}
            </div>
          </section>

          <section className="panel overflow-hidden">
            <div className="border-b border-border p-5">
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#f0eadc] text-[#7b6846]">
                  <ArrowLeftRight size={17} />
                </span>
                <div>
                  <h2 className="text-base font-extrabold">Physical storage areas</h2>
                  <p className="mt-1 text-xs text-muted-foreground">Examples: Main Store, Chiller, Freezer, or Substore.</p>
                </div>
              </div>
              {canManage && (
                <form onSubmit={submitSection} className="mt-4 flex gap-2">
                  <input
                    aria-label="New physical storage area"
                    className="field"
                    maxLength={80}
                    placeholder="e.g. Chiller"
                    value={sectionName}
                    onChange={(event) => setSectionName(event.target.value)}
                  />
                  <button className="btn btn-primary shrink-0" disabled={!canSaveSection}>
                    <Plus size={15} /> Add
                  </button>
                </form>
              )}
            </div>
            <div className="divide-y divide-border/70">
              {sections.map((section) => (
                <div key={section.id} className="flex min-h-16 items-center justify-between gap-3 px-5 py-3">
                  {editingSection === section.id ? (
                    <form onSubmit={saveSection} className="flex w-full gap-2">
                      <input
                        autoFocus
                        aria-label={`Rename ${section.name}`}
                        className="field"
                        maxLength={80}
                        value={editName}
                        onChange={(event) => setEditName(event.target.value)}
                      />
                      <button className="btn btn-primary px-3" disabled={!editName.trim() || updateSection.isPending} aria-label="Save storage area name">
                        <Check size={15} />
                      </button>
                      <button type="button" className="btn btn-soft px-3" onClick={() => setEditingSection(null)} aria-label="Cancel storage area rename">
                        <X size={15} />
                      </button>
                    </form>
                  ) : deleteSectionId === section.id ? (
                    <div className="flex w-full flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-bold">Delete {section.name}? It must be empty first.</span>
                      <span className="flex gap-2">
                        <button className="btn btn-soft text-xs" onClick={() => setDeleteSectionId(null)}>Cancel</button>
                        <button className="btn btn-soft text-xs text-[#98483e]" disabled={deleteSection.isPending} onClick={() => removeSection(section.id)}>Delete</button>
                      </span>
                    </div>
                  ) : (
                    <>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-bold">{section.name}</span>
                          {section.isDefault && <span className="rounded-full bg-muted px-2 py-1 text-[9px] font-bold text-muted-foreground">Main</span>}
                        </div>
                      </div>
                      {canManage && (
                        <div className="flex shrink-0 gap-1">
                          <button className="btn btn-ghost p-2" aria-label={`Rename ${section.name}`} onClick={() => { setEditingSection(section.id); setEditName(section.name); setDeleteSectionId(null); }}>
                            <Pencil size={14} />
                          </button>
                          {!section.isDefault && (
                            <button className="btn btn-ghost p-2 text-[#98483e]" aria-label={`Delete ${section.name}`} onClick={() => setDeleteSectionId(section.id)}>
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
              {!sections.length && <div className="p-5 text-sm text-muted-foreground">No storage areas yet.</div>}
            </div>
            <div className="border-t border-border bg-muted/25 px-5 py-3 text-[10px] leading-relaxed text-muted-foreground">
              Renaming an area keeps stock and historical transfer names. The main area cannot be deleted, and other areas can only be deleted when no stock remains.
            </div>
          </section>
        </div>
      )}
    </>
  );
}
