import { useState } from "react";
import { BookOpen, X } from "lucide-react";

type Guide = {
  title: string;
  summary: string;
  steps: string[];
};

const guides: Record<string, Guide> = {
  dashboard: {
    title: "Overview",
    summary: "Use this page to check what needs attention in the active outlet.",
    steps: [
      "Review low-stock and expiry alerts before the shift.",
      "Open the linked order, delivery, count, or approval to take action.",
      "Switch outlets from the workspace card or outlet selector to see another location.",
    ],
  },
  products: {
    title: "Products & SOP",
    summary: "Keep the catalogue, storage defaults, and receiving rules accurate.",
    steps: [
      "Search by product or category, then open a product to update its details.",
      "Set bundle size and base unit so counts and order quantities are clear.",
      "Assign a default stock section and receiving temperature range; a product can still have stock in multiple sections.",
    ],
  },
  "catalogue-settings": {
    title: "Categories & storage",
    summary: "Configure reusable product categories and the physical stock sections inside an outlet.",
    steps: [
      "Set a category receiving temperature range and handling notes for products in that category.",
      "Create sections such as Chiller, Freezer, Dry Store, or Room for this outlet.",
      "Products can keep a default section while their batches are counted and tracked in more than one section.",
    ],
  },
  suppliers: {
    title: "Suppliers",
    summary: "Maintain the contacts used when creating purchase orders and recording deliveries.",
    steps: [
      "Search suppliers by name, contact, phone, email, or notes.",
      "Update contact details when they change; archive a supplier to keep it out of new orders.",
      "Existing purchase orders and delivery records remain available after a supplier is archived.",
    ],
  },
  orders: {
    title: "Purchase orders",
    summary: "Draft an order, set its expected delivery date, then issue it to the supplier.",
    steps: [
      "Review low-stock suggestions and adjust the products or quantities while the order is a draft.",
      "Issue the order when it is ready; its monthly PO number is assigned at issue.",
      "Record the arriving goods from the linked delivery so received quantities update stock and batch expiry details.",
    ],
  },
  deliveries: {
    title: "Deliveries",
    summary: "Record what arrived against its purchase order and document any difference.",
    steps: [
      "Choose the linked purchase order when recording an ordered delivery.",
      "Enter received quantities and any required expiry or storage details.",
      "Submit the delivery for the outlet’s approval when a decision is needed.",
    ],
  },
  approvals: {
    title: "Approvals",
    summary: "Managers review deliveries and other outlet decisions that need approval.",
    steps: [
      "Open a pending item to compare the submitted details with the order or stock record.",
      "Approve it to apply the change, or reject it with a clear reason.",
      "The decision and date remain available in the related record and activity history.",
    ],
  },
  counts: {
    title: "Stock counts",
    summary: "Count stock by section, review only the lines you entered, then reconcile.",
    steps: [
      "Search by product or category; use the section grouping to count one physical area at a time.",
      "Enter whole bundles and loose base units. Extra loose units are rolled into bundles when you select Review.",
      "A blank line means no change. Enter 0 only when you counted the item and found none.",
      "You can download a workbook grouped by section or category, fill it in, upload it, review, and confirm.",
    ],
  },
  "stock-transfers": {
    title: "Stock transfers",
    summary: "Record stock moving between physical sections or between outlets.",
    steps: [
      "Choose the source and destination, then select the product and quantity in its base unit.",
      "Review the transfer before confirming so both outlet balances are updated together.",
      "Use the transfer reference and activity details to follow the movement later.",
    ],
  },
  activity: {
    title: "Activity",
    summary: "Track stock changes by date, product, section, and the person who recorded them.",
    steps: [
      "Filter the latest activity by date, person, movement type, section, product, or search terms.",
      "Expand an entry for its recorded time, reason, actor, and transfer details.",
      "Use the totals above the list to compare the number of entries and quantities added or removed.",
    ],
  },
  team: {
    title: "Team",
    summary: "Manage access for people working in the active outlet.",
    steps: [
      "Owners and managers can manage team access; managers can only assign staff access.",
      "Team access is scoped to this outlet and does not automatically grant access to other outlets.",
      "Use the password reset action for an existing teammate who cannot sign in.",
    ],
  },
  outlets: {
    title: "Outlets",
    summary: "Create and manage locations inside the owner workspace.",
    steps: [
      "Each outlet has its own stock, storage sections, suppliers, and team access.",
      "Use the outlet selector to switch the active data view.",
      "Stock transfers can be recorded within an outlet or between outlets.",
    ],
  },
  account: {
    title: "My account",
    summary: "Update your personal profile and sign-in security.",
    steps: [
      "Profile details belong to your account, not to a single outlet.",
      "Use Security to change your password or review available account controls.",
      "Ask an owner or manager for help if you can no longer sign in.",
    ],
  },
  settings: {
    title: "Workspace settings",
    summary: "Update business details and the catalogue rules used by this workspace.",
    steps: [
      "Keep the business profile current so records show the right workspace details.",
      "Review categories, stock sections, and temperature rules when operations change.",
      "Outlet stock and membership remain separate when you switch locations.",
    ],
  },
};

function guideForPath(path: string): Guide {
  const first = path.split("/").filter(Boolean)[0] || "dashboard";
  const key = first === "counts" ? "counts" : first;
  return guides[key] ?? guides.dashboard;
}

export function ModuleGuideButton({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  const guide = guideForPath(path);

  return (
    <>
      <button
        type="button"
        className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-card text-primary hover:bg-muted"
        aria-label={`Open ${guide.title} guide`}
        title={`How ${guide.title} works`}
        onClick={() => setOpen(true)}
      >
        <BookOpen size={16} />
      </button>
      {open && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-[#0b1649]/40 p-4"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <section
            className="w-full max-w-xl rounded-2xl border border-border bg-card p-5 shadow-2xl sm:p-7"
            role="dialog"
            aria-modal="true"
            aria-labelledby="module-guide-title"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="mono text-[10px] font-bold uppercase tracking-[.16em] text-primary">Module guide</p>
                <h2 id="module-guide-title" className="zus-title mt-2 text-2xl font-bold">{guide.title}</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{guide.summary}</p>
              </div>
              <button
                type="button"
                className="btn btn-ghost p-2"
                aria-label="Close module guide"
                onClick={() => setOpen(false)}
              >
                <X size={17} />
              </button>
            </div>
            <ol className="mt-5 space-y-3">
              {guide.steps.map((step, index) => (
                <li key={step} className="flex gap-3 text-sm leading-6">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#e8edf6] text-xs font-bold text-primary">
                    {index + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </>
  );
}
