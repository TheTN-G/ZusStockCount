import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ClerkProvider, Show, SignIn, SignUp, UserProfile, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { Route, Switch, Redirect, Link, useLocation, Router as WouterRouter, useParams } from 'wouter';
import {
  Activity, AlertTriangle, ArrowDownRight, ArrowRight, ArrowUpRight, Boxes, Check, CheckCircle2, ChevronDown,
  ClipboardCheck, Clock3, Coffee, FilePlus2, Filter, LayoutDashboard, LogOut, Menu, Package, Plus, Search,
  ShieldCheck, ShoppingBag, SlidersHorizontal, Sparkles, UserRound, Users, X, CalendarClock, RefreshCw, Building2, Settings, Truck, Thermometer,
} from 'lucide-react';
import {
  getGetCurrentUserQueryKey, getGetDashboardSummaryQueryKey, getGetProductQueryKey, getGetStockCountQueryKey, getHealthCheckQueryKey,
  getListProductsQueryKey, getListPurchaseOrdersQueryKey, getListStockBatchesQueryKey, getListStoreInvitationsQueryKey,
  getListSuppliersQueryKey, getListDeliveriesQueryKey,
  getListStockCountsQueryKey, getListStockMovementsQueryKey, getListStoreUsersQueryKey,
  getListProductCategoriesQueryKey, getListStockSectionsQueryKey,
  getGetStockTransferOptionsQueryKey,
  useAddStoreMember, useCreateProduct, useCreatePurchaseOrder, useCreateStockAdjustment, useCreateStockCount,
  useCreateStoreInvitation, useCreateOutlet, useUpdateOutlet, useUpdateWorkspace, useCreateSupplier, useUpdateSupplier, useListSuppliers,
  useListDeliveries, useCreateDelivery, useDecideDelivery,
  useCompleteWorkspaceSetup,
  useDecidePurchaseOrder, useGetCurrentUser, useGetDashboardSummary, useGetProduct, useGetStockCount,
  useHealthCheck, useListProducts, useListPurchaseOrders, useListStockBatches, useListStockCounts, useListStockMovements,
  useListStoreInvitations, useListStoreUsers, useReceivePurchaseOrder, useRevokeStoreInvitation, useSubmitStockCount, useUpdateProduct, useUpdateStoreUserRole,
  useListProductCategories, useListStockSections,
  setActiveOutletId,
} from '@workspace/api-client-react';
import type {
  Product, ProductCategory, ProductInput, PurchaseOrder, StockBatch, StockCount, StockCountInputScope, Supplier, Delivery,
  StoreInvitation, StockMovement, StoreUser, UserRole,
} from '@workspace/api-client-react';
import { filterExpiryRadarBatches } from './lib/expiry-window';
import CatalogueSettings from './CatalogueSettings';
import StockTransfersPage from './StockTransfersPage';
import { toast, Toaster } from 'sonner';
import './index.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false } } });
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const PENDING_WORKSPACE_NAME_KEY = 'zusstock.pendingWorkspaceName';
const clerkPubKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
function stripBase(path: string) { return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path; }
function readPendingWorkspaceName() {
  try {
    return window.sessionStorage.getItem(PENDING_WORKSPACE_NAME_KEY) || '';
  } catch {
    return '';
  }
}
if (!clerkPubKey) throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: { logoPlacement: 'inside' as const, logoLinkUrl: basePath || '/', logoImageUrl: `${window.location.origin}${basePath}/zus-logo.webp` },
  variables: {
    colorPrimary: '#101d79', colorForeground: '#0b1649', colorMutedForeground: '#6d7080',
    colorDanger: '#ae3832', colorBackground: '#fffdf7', colorInput: '#fbfaf5',
    colorInputForeground: '#0b1649', colorNeutral: '#d8c7a3', fontFamily: 'Manrope, sans-serif', borderRadius: '12px',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'w-full max-w-full overflow-hidden !bg-transparent !shadow-none !border-0 !rounded-none',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none !p-0',
    footer: 'hidden',
    header: 'hidden',
    headerTitle: 'text-[#1c2e4a] font-extrabold tracking-tight',
    headerSubtitle: 'text-[#6c7b93]',
    socialButtonsBlockButtonText: 'text-[#1c2e4a] font-semibold',
    formFieldLabel: 'text-[#15245f] font-semibold',
    footerActionLink: 'text-[#101d79] font-bold',
    footerActionText: 'text-[#6c7b93]',
    dividerText: 'text-[#6c7b93]',
    identityPreviewEditButton: 'text-[#101d79]',
    formFieldSuccessText: 'text-[#101d79]',
    alertText: 'text-[#7c3732]',
    logoBox: 'rounded-xl overflow-hidden',
    logoImage: 'rounded-xl',
    socialButtonsBlockButton: 'border-[#d7dce5] bg-white hover:bg-[#f5f7fb]',
    formButtonPrimary: 'bg-[#101d79] hover:bg-[#091650] text-white font-bold',
    formFieldInput: 'border-[#d7dce5] bg-white text-[#0b1649]',
    footerAction: 'border-t border-[#e0d4bd]',
    dividerLine: 'bg-[#d7dce5]',
    alert: 'border-[#e9c6be] bg-[#fff4ef]',
    otpCodeFieldInput: 'border-[#d8c7a3] bg-[#fbfaf5]',
    formFieldRow: 'gap-1.5',
    main: 'gap-5',
  },
};

const nav = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/products', label: 'Products', icon: Package },
  { href: '/catalogue-settings', label: 'Categories & storage', icon: SlidersHorizontal },
  { href: '/suppliers', label: 'Suppliers', icon: Building2 },
  { href: '/inventory', label: 'Inventory', icon: Boxes },
  { href: '/stock-transfers', label: 'Stock transfers', icon: RefreshCw },
  { href: '/orders', label: 'Orders', icon: ShoppingBag },
  { href: '/deliveries', label: 'Deliveries', icon: Truck },
  { href: '/counts', label: 'Stock counts', icon: ClipboardCheck },
  { href: '/activity', label: 'Activity', icon: Activity },
  { href: '/team', label: 'Team', icon: Users },
  { href: '/outlets', label: 'Outlets', icon: Building2 },
  { href: '/account', label: 'My account', icon: UserRound },
  { href: '/settings', label: 'Workspace settings', icon: Settings },
];
const categoryLabels: Record<string, string> = { food: 'Food', drink: 'Drink', consumable: 'Consumables', cleaning: 'Cleaning', packaging: 'Packaging' };
const today = new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
const dateText = (value?: string | null) => value ? new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value)) : '—';
const timeText = (value?: string | null) => value ? new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }).format(new Date(value)) : '—';
const titleCase = (value: string) => value.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
function activateOutlet(id: number) {
  setActiveOutletId(id);
  window.dispatchEvent(new CustomEvent('zus-active-outlet-change', { detail: id }));
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className="flex items-center gap-3">
    <img src={`${basePath}/zus-logo.webp`} alt="ZUS Stock Count logo" className="h-10 w-10 rounded-xl object-cover" />
    {!compact && <div className="leading-none"><div className="font-extrabold tracking-[-.06em] text-[1.18rem]">ZUS <span className="font-medium tracking-[-.04em] opacity-65">stockroom</span></div><div className="mt-1 text-[9px] font-bold tracking-[.16em] opacity-60">STORE OPERATIONS</div></div>}
  </div>;
}

function SkeletonRows({ count = 4 }: { count?: number }) {
  return <div className="space-y-3 p-5">{Array.from({ length: count }, (_, i) => <div key={i} className="flex gap-4"><div className="skeleton h-10 w-10"/><div className="flex-1 space-y-2"><div className="skeleton h-3 w-2/5"/><div className="skeleton h-3 w-1/4"/></div><div className="skeleton h-5 w-16"/></div>)}</div>;
}
function QueryState({ loading, error, retry, children, empty, hasRows }: { loading: boolean; error?: boolean; retry?: () => void; children: ReactNode; empty?: ReactNode; hasRows?: boolean }) {
  if (loading) return <SkeletonRows />;
  if (error) return <div className="grid min-h-52 place-items-center p-6 text-center"><div><div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-full bg-[#f3e5df] text-[#9d463d]"><AlertTriangle size={19}/></div><p className="font-bold">Couldn’t load this view</p><p className="mt-1 text-sm text-muted-foreground">Check your connection and try again.</p><button onClick={retry} className="btn btn-soft mt-4"><RefreshCw size={14}/> Retry</button></div></div>;
  if (!hasRows && empty) return <>{empty}</>;
  return <>{children}</>;
}
function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="grid min-h-56 place-items-center p-7 text-center"><div className="max-w-sm"><div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-[#e8eee7] text-primary"><Sparkles size={20}/></div><p className="font-extrabold">{title}</p><p className="mt-1 text-sm leading-relaxed text-muted-foreground">{detail}</p>{action && <div className="mt-4">{action}</div>}</div></div>;
}
function Modal({ title, detail, onClose, children }: { title: string; detail?: string; onClose: () => void; children: ReactNode }) {
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#10231f]/45 p-0 backdrop-blur-[3px] sm:items-center sm:p-5" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <section className="page-enter max-h-[92dvh] w-full overflow-y-auto rounded-t-[1.4rem] border border-border bg-card p-5 shadow-2xl sm:max-w-xl sm:rounded-[1.4rem] sm:p-7">
      <div className="mb-5 flex items-start justify-between gap-4"><div><h2 className="zus-title text-2xl font-bold">{title}</h2>{detail && <p className="mt-1 text-sm text-muted-foreground">{detail}</p>}</div><button onClick={onClose} aria-label="Close dialog" className="btn btn-ghost rounded-full p-2"><X size={18}/></button></div>
      {children}
    </section>
  </div>;
}
function PageHeading({ eyebrow, title, subtitle, action }: { eyebrow: string; title: string; subtitle: string; action?: ReactNode }) {
  return <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><div className="mono mb-2 text-[10px] font-medium uppercase tracking-[.16em] text-primary">{eyebrow}</div><h1 className="zus-title text-[2rem] font-bold leading-none tracking-tight sm:text-[2.55rem]">{title}</h1><p className="mt-2 text-sm text-muted-foreground">{subtitle}</p></div>{action}</div>;
}
function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' }) {
  const style = tone === 'good' ? 'bg-[#e5f0e9] text-[#28644b]' : tone === 'warn' ? 'bg-[#f8eed6] text-[#875b15]' : tone === 'bad' ? 'bg-[#f6e4df] text-[#98483e]' : 'bg-muted text-muted-foreground';
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-extrabold leading-none ${style}`}>{children}</span>;
}
function ContentShell({ children, title }: { children: ReactNode; title?: string }) {
  const { data: user, isLoading } = useGetCurrentUser({ query: { queryKey: getGetCurrentUserQueryKey() } });
  const health = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 60_000 } });
  const { signOut } = useClerk();
  const qc = useQueryClient();
  const [mobileMenu, setMobileMenu] = useState(false);
  const [selectedOutletId, setSelectedOutletId] = useState<number | undefined>();
  const [location] = useLocation();
  useEffect(() => {
    if (user?.activeOutletId) {
      setActiveOutletId(user.activeOutletId);
      setSelectedOutletId((current) => current ?? user.activeOutletId);
    }
  }, [user?.activeOutletId]);
  useEffect(() => {
    const handleOutletChange = (event: Event) => setSelectedOutletId((event as CustomEvent<number>).detail);
    window.addEventListener('zus-active-outlet-change', handleOutletChange);
    return () => window.removeEventListener('zus-active-outlet-change', handleOutletChange);
  }, []);
  function clearOutletQueries() {
    qc.removeQueries({ predicate: (query) => {
      const key = query.queryKey[0];
      return typeof key === 'string' && key.startsWith('/api/') && key !== '/api/me' && key !== '/api/healthz';
    } });
  }
  function switchOutlet(value: string) {
    const nextId = Number(value);
    if (!Number.isSafeInteger(nextId) || nextId <= 0 || nextId === user?.activeOutletId) return;
    activateOutlet(nextId);
    clearOutletQueries();
  }
  return <div className="min-h-[100dvh] bg-background lg:flex">
    <aside className="hidden w-[252px] shrink-0 flex-col bg-sidebar text-sidebar-foreground lg:sticky lg:top-0 lg:flex lg:h-[100dvh]">
      <div className="px-6 pb-7 pt-7"><Brand/></div>
      <div className="mx-4 mb-5 rounded-xl border border-white/10 bg-white/[.055] px-4 py-3" data-testid="workspace-summary"><div className="mono text-[9px] uppercase tracking-[.14em] text-white/45">Workspace</div><div className="mt-1 truncate text-sm font-bold">{isLoading ? 'Loading workspace…' : user?.workspace?.name || 'Workspace'}</div><div className="mt-1 flex items-center gap-1.5 text-[10px] text-white/50"><span className="h-1.5 w-1.5 rounded-full bg-[#e9b850]"/>{user?.workspace?.isOwner ? 'Owner workspace' : 'Team member'}</div></div>
      <nav className="flex-1 space-y-1 px-3">{nav.filter((item) => item.href === '/outlets' ? Boolean(user?.workspace?.isOwner || user?.outlets?.some((outlet) => outlet.role === 'supervisor')) : item.href === '/settings' ? Boolean(user?.workspace?.isOwner) : true).map((item) => { const active = location === item.href || (item.href === '/counts' && location.startsWith('/counts/')); const Icon = item.icon; return <Link key={item.href} href={item.href} data-testid={`link-nav-${item.label.toLowerCase().replaceAll(' ', '-')}`} className={`flex items-center gap-3 rounded-lg px-3.5 py-2.5 text-[13px] font-semibold transition-colors ${active ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-white/65 hover:bg-white/[.06] hover:text-white'}`}><Icon size={17}/>{item.label}{item.href === '/orders' && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-[#e9b850]"/>}</Link>; })}</nav>
      <div className="mx-4 mb-4 rounded-xl bg-[#e8b34c] p-4 text-[#17332c]"><div className="mono text-[9px] font-medium uppercase tracking-[.15em]">Shift-ready</div><p className="mt-1.5 text-sm font-extrabold leading-snug">Accurate stock.<br/>Better service.</p><div className="mt-3 flex items-center gap-2 text-[10px] font-bold"><span className="grid h-5 w-5 place-items-center rounded-full bg-[#17332c]/10"><Check size={12}/></span>Built for the floor</div></div>
      <div className="flex items-center gap-3 border-t border-sidebar-border px-5 py-4"><div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-sidebar-accent text-xs font-extrabold text-[#f0c05b]">{user?.name?.split(' ').map((s) => s[0]).join('').slice(0, 2) || 'ZS'}</div><div className="min-w-0 flex-1"><div className="truncate text-xs font-bold">{user?.name || (isLoading ? 'Loading…' : 'Store team')}</div><div className="truncate text-[10px] text-white/45">{user?.email || 'Inventory workspace'}</div></div><button onClick={() => signOut({ redirectUrl: basePath || '/' })} title="Sign out" aria-label="Sign out" className="rounded-lg p-2 text-white/45 hover:bg-white/10 hover:text-white"><LogOut size={15}/></button></div>
    </aside>
    <div className="min-w-0 flex-1">
      <header className="sticky top-0 z-30 flex h-[68px] items-center justify-between border-b border-border/80 bg-background/95 px-4 backdrop-blur-md sm:px-7 lg:px-10">
        <div className="flex items-center gap-3"><button className="btn btn-ghost p-2 lg:hidden" onClick={() => setMobileMenu(!mobileMenu)} aria-label="Toggle navigation"><Menu size={20}/></button><div className="lg:hidden"><Brand compact/></div><div className="hidden text-sm font-bold lg:block">{title || 'Store operations'}<span className="ml-3 font-normal text-muted-foreground">/</span><span className="ml-3 font-medium text-muted-foreground">{today}</span></div></div>
        <div className="flex items-center gap-2">
          {user?.outlets?.length ? <select aria-label="Active outlet" data-testid="select-active-outlet" className="field h-9 max-w-[155px] py-1 text-xs sm:max-w-[220px]" value={selectedOutletId ?? user.activeOutletId} onChange={(e) => switchOutlet(e.target.value)}>{user.outlets.map((outlet) => <option value={outlet.id} key={outlet.id}>{outlet.name}</option>)}</select> : null}
          <span className={`hidden rounded-full border px-3 py-1.5 text-[10px] font-bold sm:inline-flex ${health.isError ? 'border-[#ead4cc] bg-[#f7e7df] text-[#9d463d]' : 'border-[#d6e3d9] bg-[#e8f1e9] text-[#346849]'}`}><span className={`mr-2 mt-[3px] h-1.5 w-1.5 rounded-full ${health.isError ? 'bg-[#ad594c]' : 'bg-[#43885e]'}`}/>{health.isError ? 'CONNECTION CHECK' : 'LIVE STORE DATA'}</span><div className="grid h-9 w-9 place-items-center rounded-full border border-border bg-card text-sm font-extrabold text-primary">{user?.name?.[0] || <UserRound size={16}/>}</div>
        </div>
      </header>
      {mobileMenu && <div className="fixed inset-0 z-40 bg-[#10231f]/40 lg:hidden" onClick={() => setMobileMenu(false)}><div className="h-full w-[290px] bg-sidebar p-5 text-sidebar-foreground" onClick={(e) => e.stopPropagation()}><div className="mb-7 flex items-center justify-between"><Brand/><button onClick={() => setMobileMenu(false)} className="rounded-lg p-2" data-testid="button-close-navigation"><X size={18}/></button></div><div className="mb-4 rounded-xl bg-white/10 p-3 text-sm font-bold">{user?.workspace?.name || 'Workspace'}</div><nav className="space-y-1">{nav.filter((item) => item.href === '/outlets' ? Boolean(user?.workspace?.isOwner || user?.outlets?.some((outlet) => outlet.role === 'supervisor')) : item.href === '/settings' ? Boolean(user?.workspace?.isOwner) : true).map((item) => { const Icon = item.icon; return <Link key={item.href} href={item.href} onClick={() => setMobileMenu(false)} data-testid={`mobile-nav-${item.href.slice(1)}`} className="flex items-center gap-3 rounded-lg px-3 py-3 text-sm font-semibold text-white/75 hover:bg-white/10"><Icon size={17}/>{item.label}</Link>; })}</nav><button onClick={() => signOut({ redirectUrl: basePath || '/' })} className="btn btn-ghost mt-8 w-full justify-start text-white" data-testid="button-sign-out-mobile"><LogOut size={16}/> Sign out</button></div></div>}
      <main className="page-enter mx-auto max-w-[1440px] px-4 py-7 sm:px-7 sm:py-9 lg:px-10">{children}</main>
    </div>
  </div>;
}

function Landing() {
  return <div className="min-h-[100dvh] overflow-hidden bg-[#f7f4eb] text-[#0b1649]">
    <header className="mx-auto flex max-w-7xl items-center justify-between px-5 py-5 sm:px-9"><Brand/><div className="flex gap-2"><Link href="/sign-in" className="btn btn-ghost text-[#101d79]">Sign in</Link><Link href="/sign-up" className="btn btn-primary">Get started <ArrowRight size={15}/></Link></div></header>
    <section className="relative mx-auto grid max-w-7xl items-center gap-9 px-5 pb-16 pt-10 sm:px-9 md:grid-cols-[1.02fr_.98fr] md:pb-24 md:pt-16">
      <div className="relative z-10"><div className="mono mb-5 flex items-center gap-2 text-[10px] uppercase tracking-[.19em] text-[#101d79]"><span className="h-px w-7 bg-[#c7aa76]"/>Stockroom, in rhythm</div><h1 className="zus-title max-w-2xl text-[3.3rem] font-bold leading-[.98] tracking-[-.065em] sm:text-6xl lg:text-[5.4rem]">A better shift<br/>starts <span className="relative inline-block text-[#101d79]">in stock.<i className="absolute -bottom-1 left-0 h-[6px] w-full rounded-full bg-[#c7aa76]"/></span></h1><p className="mt-7 max-w-lg text-base leading-7 text-[#596983] sm:text-lg">Know what’s on hand, what’s running low, and what needs using first. One clear stockroom for every ZUS café shift.</p><div className="mt-8 flex flex-wrap gap-3"><Link href="/sign-up" className="btn btn-primary px-5 py-3 text-sm">Open your stockroom <ArrowRight size={16}/></Link><Link href="/sign-in" className="btn btn-soft px-5 py-3 text-sm">Team sign in</Link></div><div className="mt-9 flex items-center gap-3 text-xs font-semibold text-[#68748a]"><span className="flex -space-x-2"><span className="grid h-8 w-8 place-items-center rounded-full border-2 border-[#f7f4eb] bg-[#e4e9f3] text-[10px] font-bold text-[#101d79]">OP</span><span className="grid h-8 w-8 place-items-center rounded-full border-2 border-[#f7f4eb] bg-[#f3dfac] text-[10px] font-bold text-[#76531b]">JL</span><span className="grid h-8 w-8 place-items-center rounded-full border-2 border-[#f7f4eb] bg-[#e8d8d1] text-[10px] font-bold text-[#864e42]">MK</span></span>Made for the people keeping cafés moving</div></div>
      <div className="relative mx-auto w-full max-w-[580px]"><div className="absolute -right-6 -top-10 h-52 w-52 rounded-full bg-[#c7aa76]/35 blur-3xl"/><div className="relative rounded-[2rem] bg-[#101d79] p-5 shadow-[0_24px_80px_rgba(11,22,73,.2)] sm:p-7"><div className="mb-6 flex items-center justify-between text-[#f8f2df]"><div><div className="mono text-[9px] uppercase tracking-[.18em] text-white/55">The daily read</div><div className="mt-2 text-xl font-extrabold">Store pulse</div></div><div className="rounded-full border border-white/15 px-3 py-1.5 text-[10px] font-bold text-[#f2ca71]">TODAY · 08:42</div></div><div className="grid grid-cols-3 gap-2 sm:gap-3">{[['01','Low stock'],['04','Use soon'],['02','To review']].map(([num,label])=><div key={label} className="rounded-2xl bg-[#f8f4e9] p-3 sm:p-4"><div className="zus-title text-3xl font-bold text-[#101d79] sm:text-4xl">{num}</div><div className="mt-2 text-[10px] font-bold text-[#737a70] sm:text-xs">{label}</div></div>)}</div><div className="mt-4 rounded-2xl bg-[#e8b34c] p-4 text-[#0b1649]"><div className="flex items-center justify-between"><div className="text-sm font-extrabold">Ready for the morning rush</div><span className="grid h-7 w-7 place-items-center rounded-full bg-[#101d79]/10"><Check size={15}/></span></div><div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#101d79]/15"><div className="h-full w-[78%] rounded-full bg-[#101d79]"/></div><div className="mt-2 flex justify-between text-[10px] font-bold text-[#35436e]"><span>Stock count progress</span><span>78%</span></div></div><div className="mt-4 grid grid-cols-[1fr_auto] items-center gap-4 rounded-2xl border border-white/15 bg-white/[.06] p-4 text-[#f8f2df]"><div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-xl bg-white/10"><Package size={17}/></div><div><div className="text-xs font-bold">Oat milk · 1L</div><div className="mt-1 text-[10px] text-white/55">Chiller section · expires tomorrow</div></div></div><div className="mono text-xs text-[#f2ca71]">03 units</div></div><div className="mt-4 flex items-center gap-2 text-[10px] font-bold text-white/50"><span className="h-1.5 w-1.5 rounded-full bg-[#e8b34c]"/> One source of truth for every shift</div></div><div className="absolute -bottom-7 -left-5 hidden rounded-xl bg-[#fcfaf3] px-4 py-3 shadow-xl sm:block"><div className="mono text-[9px] uppercase tracking-wider text-[#829089]">Inventory confidence</div><div className="mt-1 flex items-center gap-2 text-sm font-extrabold"><ShieldCheck size={16} className="text-[#101d79]"/> Count it. Trust it.</div></div></div>
    </section>
    <section className="border-y border-[#dcd9cc] bg-[#eeece1]"><div className="mx-auto grid max-w-7xl gap-8 px-5 py-9 sm:px-9 md:grid-cols-3">{[['01','Count without the guesswork','Capture the real shelf number and surface the difference before it becomes a problem.'],['02','Use the good stuff first','Expiry-aware batches keep the next use-by date where the team can see it.'],['03','Keep requests moving','A clear approval and delivery trail keeps stores and supervisors in sync.']].map(([n,t,d])=><div className="grid grid-cols-[40px_1fr] gap-4" key={n}><span className="mono pt-1 text-xs text-[#101d79]">{n}</span><div><h2 className="text-sm font-extrabold">{t}</h2><p className="mt-1.5 max-w-sm text-xs leading-5 text-[#67746d]">{d}</p></div></div>)}</div></section>
    <footer className="mx-auto flex max-w-7xl flex-col justify-between gap-4 px-5 py-7 text-xs text-[#758078] sm:flex-row sm:items-center sm:px-9"><Brand/><span>Stockroom clarity for the pace of café life.</span><span className="mono text-[10px]">ZUS STOCK COUNT · STORE OPS</span></footer>
  </div>;
}
function HomeRedirect() { return <><Show when="signed-in"><Redirect to="/dashboard"/></Show><Show when="signed-out"><Landing/></Show></>; }
function WorkspaceRouteGate({ children }: { children: ReactNode }) {
  const location = useLocation()[0];
  const currentUser = useGetCurrentUser({ query: { queryKey: getGetCurrentUserQueryKey() } });
  if (currentUser.isLoading) return <div className="grid min-h-[100dvh] place-items-center bg-background p-6 text-sm text-muted-foreground">Loading your workspace…</div>;
  if (currentUser.isError || !currentUser.data) return <div className="grid min-h-[100dvh] place-items-center bg-background p-6 text-center"><div><p className="font-bold">We couldn’t load your workspace.</p><p className="mt-1 text-sm text-muted-foreground">Check your connection and refresh to continue.</p><button className="btn btn-soft mt-4" onClick={() => void currentUser.refetch()}>Try again</button></div></div>;
  const setupPath = location === '/workspace-setup';
  const needsSetup = currentUser.data.workspace.isOwner && !currentUser.data.workspace.setupComplete;
  if (needsSetup && !setupPath) return <Redirect to="/workspace-setup"/>;
  if (!needsSetup && setupPath) return <Redirect to="/dashboard"/>;
  return <>{children}</>;
}
function Protected({ children }: { children: ReactNode }) { return <><Show when="signed-in"><WorkspaceRouteGate>{children}</WorkspaceRouteGate></Show><Show when="signed-out"><Redirect to="/"/></Show></>; }
function AuthTabs({ active }: { active: 'sign-in' | 'sign-up' }) {
  return <nav aria-label="Account access" className="mb-5 grid grid-cols-2 rounded-2xl bg-[#e9edf2] p-1.5">
    <Link
      href="/sign-in"
      aria-current={active === 'sign-in' ? 'page' : undefined}
      data-testid="link-auth-sign-in"
      className={`rounded-xl px-3 py-3 text-center text-sm font-bold transition-colors ${active === 'sign-in' ? 'bg-white text-[#0b1649] shadow-sm' : 'text-[#687386] hover:text-[#0b1649]'}`}
    >Sign in</Link>
    <Link
      href="/sign-up"
      aria-current={active === 'sign-up' ? 'page' : undefined}
      data-testid="link-auth-create-workspace"
      className={`rounded-xl px-3 py-3 text-center text-sm font-bold transition-colors ${active === 'sign-up' ? 'bg-white text-[#0b1649] shadow-sm' : 'text-[#687386] hover:text-[#0b1649]'}`}
    >Create a workspace</Link>
  </nav>;
}
function AuthPageFrame({ active, title, subtitle, children }: { active: 'sign-in' | 'sign-up'; title: string; subtitle: string; children: ReactNode }) {
  return <div className="min-h-[100dvh] bg-[#f5f7f3] px-4 py-8 text-[#0b1649] sm:px-7 sm:py-10">
    <Link href="/" className="btn btn-ghost fixed left-4 top-4 z-10 bg-[#f5f7f3]/90 sm:left-7 sm:top-6" data-testid="link-back-to-stockroom"><ArrowRight className="rotate-180" size={15}/> Back to stockroom</Link>
    <main className="mx-auto flex min-h-[calc(100dvh-4rem)] w-full max-w-[660px] flex-col justify-center pt-12 sm:min-h-[calc(100dvh-5rem)] sm:pt-8">
      <div className="mb-5 flex justify-center sm:justify-start"><Brand/></div>
      <header className="mb-6">
        <h1 className="zus-title text-3xl font-extrabold tracking-tight text-[#0b1649] sm:text-[2.5rem]">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-[#667386] sm:text-base">{subtitle}</p>
      </header>
      <AuthTabs active={active}/>
      {children}
    </main>
  </div>;
}
function SignInPage() {
  return <AuthPageFrame
    active="sign-in"
    title="Welcome back"
    subtitle="Sign in to record and check today’s deliveries."
  >
    <section className="rounded-2xl border border-[#dce1e8] bg-white p-4 shadow-[0_12px_36px_rgba(16,29,121,.06)] sm:p-7" data-testid="panel-sign-in">
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
        appearance={{ elements: { formFieldAction: 'hidden' } }}
      />
    </section>
    <div className="mt-4 rounded-2xl border border-[#e3e7eb] bg-white/90 p-4 text-sm leading-6 text-[#667386]" data-testid="note-staff-sign-in">
      <strong className="text-[#0b1649]">Staff or manager?</strong> Your owner sends you an email invitation to set up your account. After accepting it, sign in here.
    </div>
  </AuthPageFrame>;
}
function SignUpPage() {
  const [businessName, setBusinessName] = useState(readPendingWorkspaceName);
  function updateBusinessName(value: string) {
    setBusinessName(value);
    try {
      if (value.trim()) window.sessionStorage.setItem(PENDING_WORKSPACE_NAME_KEY, value);
      else window.sessionStorage.removeItem(PENDING_WORKSPACE_NAME_KEY);
    } catch {
      // The workspace setup page still asks for the business name if storage is unavailable.
    }
  }
  return <AuthPageFrame
    active="sign-up"
    title="Create your workspace"
    subtitle="You’ll be the owner. Add your managers and staff after setup."
  >
    <section className="rounded-2xl border border-[#dce1e8] bg-white p-4 shadow-[0_12px_36px_rgba(16,29,121,.06)] sm:p-7" data-testid="panel-create-workspace">
      <label className="mb-5 block text-sm font-bold text-[#24324b]">
        Business name
        <input
          className="field mt-2 !border-[#d7dce5] !bg-white"
          data-testid="input-auth-business-name"
          value={businessName}
          onChange={(event) => updateBusinessName(event.target.value)}
          placeholder="e.g. Kopi Corner Sdn Bhd"
          maxLength={80}
          autoComplete="organization"
        />
        <span className="mt-1.5 block text-xs font-normal leading-5 text-[#738095]">We’ll carry this into your business details after you verify your account.</span>
      </label>
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`}/>
      <div className="mt-4 border-t border-[#e9edf2] pt-4 text-sm leading-6 text-[#667386]">
        After creating your account, you’ll add your first outlet and business contact details.
      </div>
    </section>
  </AuthPageFrame>;
}
function WorkspaceSetupPage() {
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  const currentUser = useGetCurrentUser({ query: { queryKey: getGetCurrentUserQueryKey() } });
  const completeSetup = useCompleteWorkspaceSetup();
  const [initialized, setInitialized] = useState(false);
  const [name, setName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [businessAddress, setBusinessAddress] = useState('');
  const [firstOutletName, setFirstOutletName] = useState('Main Outlet');

  useEffect(() => {
    if (currentUser.data && !initialized) {
      const workspace = currentUser.data.workspace;
      setName(readPendingWorkspaceName().trim() || workspace.name);
      setContactEmail(workspace.contactEmail || currentUser.data.email);
      setContactPhone(workspace.contactPhone || '');
      setBusinessAddress(workspace.businessAddress || '');
      setFirstOutletName(currentUser.data.outlets[0]?.name || 'Main Outlet');
      setInitialized(true);
    }
  }, [currentUser.data, initialized]);

  function submit(event: FormEvent) {
    event.preventDefault();
    completeSetup.mutate({
      data: {
        name: name.trim(),
        contactEmail: contactEmail.trim() || null,
        contactPhone: contactPhone.trim() || null,
        businessAddress: businessAddress.trim() || null,
        firstOutletName: firstOutletName.trim(),
      },
    }, {
      onSuccess: async () => {
        try {
          window.sessionStorage.removeItem(PENDING_WORKSPACE_NAME_KEY);
        } catch {
          // Storage is only a prefill convenience; the workspace is already saved.
        }
        await qc.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() });
        toast.success('Workspace registration complete');
        setLocation('/dashboard');
      },
      onError: (error) => toast.error(error.message || 'Could not complete workspace setup'),
    });
  }

  return <div className="min-h-[100dvh] bg-[#f7f4eb] px-4 py-6 text-[#0b1649] sm:px-8 sm:py-10">
    <header className="mx-auto flex max-w-5xl items-center justify-between"><Brand/><span className="mono rounded-full border border-[#d8c7a3] bg-white/60 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-[#596983]">Owner setup</span></header>
    <main className="mx-auto max-w-3xl">
      <div className="mb-7 mt-10 sm:mb-9 sm:mt-14"><div className="mono mb-3 text-[10px] font-bold uppercase tracking-[.18em] text-[#101d79]">Your business workspace</div><h1 className="zus-title text-4xl font-bold tracking-tight sm:text-5xl">Register your store.</h1><p className="mt-3 max-w-xl text-sm leading-6 text-[#596983]">Add your business details and first outlet. You can update the profile later and add more outlets whenever you’re ready.</p></div>
      {currentUser.isError && <div className="panel mb-4 p-4 text-sm text-destructive">We couldn’t load your account details. Refresh and try again.</div>}
      <form onSubmit={submit} className="panel overflow-hidden" data-testid="form-workspace-registration">
        <div className="border-b border-border/80 p-5 sm:p-7">
          <div className="mb-5 flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-xl bg-[#101d79] text-sm font-extrabold text-white">1</span><div><h2 className="text-sm font-extrabold">Business information</h2><p className="mt-1 text-xs text-muted-foreground">Shared across your owner workspace.</p></div></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-xs font-bold sm:col-span-2">Business / workspace name<input className="field mt-2" data-testid="input-registration-workspace-name" required minLength={1} maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. SweetnCo Sdn Bhd"/></label>
            <label className="text-xs font-bold">Business email <span className="font-normal text-muted-foreground">optional</span><input className="field mt-2" type="email" maxLength={320} value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} placeholder="hello@example.com"/></label>
            <label className="text-xs font-bold">Business phone <span className="font-normal text-muted-foreground">optional</span><input className="field mt-2" type="tel" maxLength={40} value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} placeholder="+60…"/></label>
            <label className="text-xs font-bold sm:col-span-2">Business address <span className="font-normal text-muted-foreground">optional</span><textarea className="field mt-2 min-h-24 resize-y" maxLength={500} value={businessAddress} onChange={(event) => setBusinessAddress(event.target.value)} placeholder="Street, city, state, postcode"/></label>
          </div>
        </div>
        <div className="p-5 sm:p-7">
          <div className="mb-5 flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-xl bg-[#c7aa76] text-sm font-extrabold text-[#0b1649]">2</span><div><h2 className="text-sm font-extrabold">First outlet</h2><p className="mt-1 text-xs text-muted-foreground">Its stock and team stay separate from other outlets.</p></div></div>
          <label className="block text-xs font-bold">Outlet name<input className="field mt-2" data-testid="input-registration-outlet-name" required minLength={1} maxLength={80} value={firstOutletName} onChange={(event) => setFirstOutletName(event.target.value)} placeholder="e.g. Bangsar South"/></label>
          <div className="mt-4 rounded-xl bg-[#f4f0e5] p-4 text-xs leading-5 text-[#596983]"><strong className="text-[#0b1649]">Owner account:</strong> {currentUser.data?.name || 'Your account'} · {currentUser.data?.email || 'Email from sign-up'}. Manage your personal details under My account.</div>
          <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between"><p className="text-[11px] text-muted-foreground">You can add more outlets after setup.</p><button className="btn btn-primary justify-center" data-testid="button-complete-workspace-registration" type="submit" disabled={currentUser.isLoading || completeSetup.isPending || !name.trim() || !firstOutletName.trim()}>{completeSetup.isPending ? 'Saving workspace…' : 'Save and open workspace'} <ArrowRight size={15}/></button></div>
        </div>
      </form>
    </main>
  </div>;
}

function Dashboard() {
  const { data: summary, isLoading, isError, refetch } = useGetDashboardSummary({ query: { queryKey: getGetDashboardSummaryQueryKey() } });
  const { data: products = [] } = useListProducts({ active: true }, { query: { queryKey: getListProductsQueryKey({ active: true }) } });
  const { data: batches = [] } = useListStockBatches({}, { query: { queryKey: getListStockBatchesQueryKey({}) } });
  const low = products.filter((p) => p.lowStock).slice(0, 4);
  const expiring = useMemo(() => filterExpiryRadarBatches(batches).slice(0, 4), [batches]);
  return <><PageHeading eyebrow="Shift overview" title="Good morning." subtitle={`${today} · Here's where your store stands.`} action={<Link href="/counts" className="btn btn-primary"><ClipboardCheck size={16}/> Start a count</Link>}/>
    <QueryState loading={isLoading} error={isError} retry={() => void refetch()}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[
        { label: 'Active products', value: summary?.productCount ?? 0, hint: 'In your catalogue', icon: Package, tint: 'text-primary bg-[#e7ebf6]' },
        { label: 'Running low', value: summary?.lowStockCount ?? 0, hint: 'Below minimum stock', icon: ArrowDownRight, tint: 'text-[#a65339] bg-[#f5e9de]' },
        { label: 'Use soon', value: summary?.expiringSoonCount ?? 0, hint: 'Expiry within 7 days', icon: CalendarClock, tint: 'text-[#8a621b] bg-[#f6efd9]' },
        { label: 'Needs review', value: summary?.pendingApprovals ?? 0, hint: 'Requests waiting', icon: Clock3, tint: 'text-[#536e87] bg-[#e6edf0]' },
      ].map((item) => { const Icon = item.icon; return <div key={item.label} className="panel p-5"><div className="flex items-start justify-between"><span className="text-xs font-bold text-muted-foreground">{item.label}</span><span className={`grid h-9 w-9 place-items-center rounded-xl ${item.tint}`}><Icon size={17}/></span></div><div className="zus-title mt-4 text-[2.4rem] font-bold leading-none">{isLoading ? '—' : item.value}</div><div className="mt-2 text-[11px] text-muted-foreground">{item.hint}</div></div>; })}</div>
      <div className="mt-5 grid gap-5 xl:grid-cols-[1.3fr_.7fr]">
        <section className="panel overflow-hidden"><div className="flex items-center justify-between border-b border-border px-5 py-4"><div><h2 className="text-sm font-extrabold">Stock movements</h2><p className="mt-1 text-[11px] text-muted-foreground">Latest changes in your store</p></div><Link href="/activity" className="btn btn-ghost px-2 text-xs">Full activity <ArrowRight size={14}/></Link></div><MovementRows rows={summary?.recentMovements || []}/></section>
        <div className="space-y-5"><section className="panel overflow-hidden"><div className="flex items-center justify-between px-5 pt-5"><div><div className="mono text-[9px] uppercase tracking-[.15em] text-[#a05c3d]">Watchlist</div><h2 className="mt-1 text-sm font-extrabold">Below par</h2></div><Link href="/products" className="btn btn-ghost p-2"><ArrowRight size={15}/></Link></div><div className="px-5 pb-3 pt-2">{low.length ? low.map((p) => <div key={p.id} className="flex items-center justify-between border-b border-border/70 py-3 last:border-0"><div><div className="text-xs font-bold">{p.name}</div><div className="mt-1 text-[10px] text-muted-foreground">Minimum {p.minStock} {p.unit}</div></div><Pill tone="warn">{p.stockOnHand} left</Pill></div>) : <p className="py-6 text-center text-xs text-muted-foreground">No items below minimum.</p>}</div></section>
         <section className="panel overflow-hidden"><div className="flex items-center justify-between px-5 pt-5"><div><div className="mono text-[9px] uppercase tracking-[.15em] text-[#53668f]">Expiry radar</div><h2 className="mt-1 text-sm font-extrabold">Use these first</h2></div><Link href="/inventory" className="btn btn-ghost p-2"><ArrowRight size={15}/></Link></div><div className="px-5 pb-3 pt-2">{expiring.length ? expiring.map((b) => <div key={b.id} className="flex items-center justify-between border-b border-border/70 py-3 last:border-0"><div><div className="text-xs font-bold">{b.productName}</div><div className="mt-1 text-[10px] text-muted-foreground">{b.quantity} units · exp {dateText(b.expiryDate)}</div></div><Pill tone="bad">Soon</Pill></div>) : <p className="py-6 text-center text-xs text-muted-foreground">No batches near expiry.</p>}</div></section></div>
      </div>
       <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-[#101d79] px-5 py-4 text-[#f8f4e9]"><div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-xl bg-[#eab650] text-[#0b1649]"><Coffee size={18}/></div><div><div className="text-sm font-extrabold">One clean count keeps the next shift calm.</div><div className="mt-1 text-[11px] text-white/60">Start with a full-store walk-through or count a single category.</div></div></div><Link href="/counts" className="btn rounded-lg bg-[#f4d78e] text-[#0b1649]">New stock count <ArrowRight size={14}/></Link></div>
    </QueryState>
  </>;
}

function ProductDialog({ item, close }: { item?: Product; close: () => void }) {
  const qc = useQueryClient();
  const categoriesQuery = useListProductCategories({ query: { queryKey: getListProductCategoriesQueryKey() } });
  const sectionsQuery = useListStockSections({ query: { queryKey: getListStockSectionsQueryKey() } });
  const productDetail = useGetProduct(item?.id ?? 0, { query: { enabled: Boolean(item), queryKey: getGetProductQueryKey(item?.id ?? 0) } });
  const create = useCreateProduct();
  const update = useUpdateProduct();
  const savedCategories = categoriesQuery.data ?? [];
  const sections = sectionsQuery.data ?? [];
  const defaultSection = sections.find((section) => section.isDefault) ?? sections[0];
  const categoryOptions = savedCategories.length
    ? savedCategories
    : Object.entries(categoryLabels).map(([key, name]) => ({ key, name }));
  const categories =
    item?.category && !categoryOptions.some((category) => category.key === item.category)
      ? [...categoryOptions, { key: item.category, name: categoryLabels[item.category] || item.category }]
      : categoryOptions;
  const [form, setForm] = useState({ name: item?.name || '', category: item?.category || 'food', defaultSectionId: item?.defaultSectionId == null ? '' : String(item.defaultSectionId), unit: item?.unit || 'each', bundleSize: String(item?.bundleSize ?? 1), minStock: String(item?.minStock ?? 0), tempMinC: item?.tempMinC == null ? '' : String(item.tempMinC), tempMaxC: item?.tempMaxC == null ? '' : String(item.tempMaxC), active: item?.active ?? true });
  const selectedSectionId = form.defaultSectionId || (defaultSection ? String(defaultSection.id) : '');
  const busy = create.isPending || update.isPending;
  function submit(e: FormEvent) {
    e.preventDefault();
    const tempMinC = form.tempMinC.trim() === '' ? null : Number(form.tempMinC);
    const tempMaxC = form.tempMaxC.trim() === '' ? null : Number(form.tempMaxC);
    if ((tempMinC === null) !== (tempMaxC === null) || (tempMinC !== null && tempMaxC !== null && tempMinC > tempMaxC)) {
      toast.error('Enter both product-specific temperature limits, with the minimum at or below the maximum.');
      return;
    }
    const data = { name: form.name.trim(), sku: null, category: form.category as ProductCategory, defaultSectionId: selectedSectionId ? Number(selectedSectionId) : null, tempMinC, tempMaxC, unit: form.unit.trim(), bundleSize: Number(form.bundleSize), minStock: Number(form.minStock) };
    const done = () => { void qc.invalidateQueries({ queryKey: getListProductsQueryKey() }); void qc.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() }); if (item) void qc.invalidateQueries({ queryKey: getGetProductQueryKey(item.id) }); toast.success(item ? 'Product updated' : 'Product added'); close(); };
    if (item) update.mutate({ productId: item.id, data: { ...data, active: form.active } }, { onSuccess: done, onError: () => toast.error('Could not save product') });
    else create.mutate({ data: data as ProductInput }, { onSuccess: done, onError: () => toast.error('Could not add product') });
  }
  const set = (key: keyof typeof form, value: string | boolean) => setForm((f) => ({ ...f, [key]: value }));
  return <Modal title={item ? 'Edit product' : 'Add a product'} detail="Keep the catalogue useful for the whole team." onClose={close}><form onSubmit={submit} className="space-y-4">
    {item && productDetail.isLoading && <div className="skeleton h-8 w-full"/>}
    {(sectionsQuery.isError || categoriesQuery.isError) && <div role="alert" className="rounded-xl bg-[#f6e4df] p-3 text-xs text-[#98483e]">Could not load this outlet's categories or stock sections.</div>}
    <label className="block text-xs font-bold">Product name<input required value={form.name} onChange={(e) => set('name', e.target.value)} className="field mt-1.5" placeholder="e.g. Oat milk, 1L"/></label>
    <label className="block text-xs font-bold">Category<select className="field mt-1.5" value={form.category} onChange={(e) => set('category', e.target.value)}>{categories.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}</select></label>
    <label className="block text-xs font-bold">Default stock section<select required className="field mt-1.5" value={selectedSectionId} onChange={(e) => set('defaultSectionId', e.target.value)} disabled={sectionsQuery.isLoading || sections.length === 0}><option value="">Choose a stock section</option>{sections.map((section) => <option key={section.id} value={section.id}>{section.name}{section.isDefault ? ' · default' : ''}</option>)}</select><span className="mt-1 block text-[10px] font-normal text-muted-foreground">Newly received stock starts here. Existing stock can remain in, or move to, other sections.</span></label>
    <div className="grid gap-3 sm:grid-cols-2"><label className="block text-xs font-bold">Bundle size<input type="number" min=".01" step=".01" required value={form.bundleSize} onChange={(e) => set('bundleSize', e.target.value)} className="field mt-1.5"/></label><label className="block text-xs font-bold">Count unit<input required value={form.unit} onChange={(e) => set('unit', e.target.value)} className="field mt-1.5" placeholder="each, bottle, pack"/></label></div>
    <label className="block text-xs font-bold">Minimum stock<input data-testid="input-product-min-stock" type="number" min="0" step="1" required value={form.minStock} onChange={(e) => set('minStock', e.target.value)} className="field mt-1.5"/></label>
    <div className="rounded-xl border border-border bg-muted/25 p-4">
      <div className="mb-3 flex items-center gap-2 text-xs font-extrabold"><Thermometer size={15}/> Product temperature override (optional)</div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-bold">Minimum °C<input type="number" min="-60" max="100" step=".1" value={form.tempMinC} onChange={(e) => set('tempMinC', e.target.value)} className="field mt-1.5" placeholder="Use category range"/></label>
        <label className="block text-xs font-bold">Maximum °C<input type="number" min="-60" max="100" step=".1" value={form.tempMaxC} onChange={(e) => set('tempMaxC', e.target.value)} className="field mt-1.5" placeholder="Use category range"/></label>
      </div>
      <p className="mt-2 text-[10px] leading-4 text-muted-foreground">Leave both blank to use the category range. Set both to override it for this product only; the handling SOP remains on the category.</p>
    </div>
    {item && <label className="flex items-center gap-2 text-xs font-bold"><input type="checkbox" checked={form.active} onChange={(e) => set('active', e.target.checked)} className="accent-[#155d4d]"/> Active in catalogue</label>}
    {sections.length === 0 && !sectionsQuery.isLoading && <p className="text-xs text-[#98483e]">Create a stock section in Manage lists before adding products.</p>}
    <div className="flex justify-end gap-2 pt-2"><button type="button" onClick={close} className="btn btn-soft">Cancel</button><button disabled={busy || sectionsQuery.isLoading || sections.length === 0} className="btn btn-primary">{busy ? 'Saving…' : item ? 'Save changes' : 'Add product'}</button></div>
  </form></Modal>;
}
function ProductSopDialog({ product, category, close }: { product: Product; category?: { name: string; receivingTempMinC: number | null; receivingTempMaxC: number | null; receivingHandlingSop: string }; close: () => void }) {
  const hasProductRange = product.tempMinC !== null && product.tempMaxC !== null;
  const rangeMin = hasProductRange ? product.tempMinC : category?.receivingTempMinC ?? null;
  const rangeMax = hasProductRange ? product.tempMaxC : category?.receivingTempMaxC ?? null;
  const hasTemperatureRange = rangeMin !== null && rangeMax !== null;
  return <Modal title={`${product.name} · ${category?.name || product.category}`} detail="A product-specific range overrides the category default." onClose={close}>
    <div className="space-y-4">
      <div className="rounded-xl bg-[#f5f1e7] p-4">
        <div className="flex items-center gap-2 text-xs font-extrabold"><Thermometer size={15}/> {hasProductRange ? 'Product-specific temperature' : 'Category temperature'}</div>
        <p className="mt-2 text-sm">{hasTemperatureRange ? `${rangeMin}°C to ${rangeMax}°C` : 'No temperature range set on this product or category'}</p>
      </div>
      <div className="rounded-xl border border-border p-4">
        <h3 className="text-xs font-extrabold">Category receiving SOP</h3>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{category?.receivingHandlingSop || 'No receiving instructions have been added to this category yet.'}</p>
      </div>
      <div className="flex justify-end"><button data-testid="button-close-product-sop" onClick={close} className="btn btn-primary">Done</button></div>
    </div>
  </Modal>;
}
function Products() {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [active, setActive] = useState('true');
  const [dialog, setDialog] = useState(false);
  const [edit, setEdit] = useState<Product>();
  const [sopProduct, setSopProduct] = useState<Product>();
  const categoriesQuery = useListProductCategories({ query: { queryKey: getListProductCategoriesQueryKey() } });
  const categories = categoriesQuery.data || [];
  const sectionsQuery = useListStockSections({ query: { queryKey: getListStockSectionsQueryKey() } });
  const sections = sectionsQuery.data || [];
  const params = { ...(search ? { search } : {}), ...(category ? { category: category as ProductCategory } : {}), ...(active ? { active: active === 'true' } : {}) };
  const query = useListProducts(params, { query: { queryKey: getListProductsQueryKey(params) } }); const rows = query.data || [];
  const sopCategory = sopProduct
    ? categories.find((item) => item.key === sopProduct.category)
    : undefined;
  return (
    <>
      <PageHeading
        eyebrow="Product catalogue"
        title="Products"
        subtitle="The shared reference for what your store keeps on hand."
        action={
          <div className="flex flex-wrap gap-2">
            <Link href="/catalogue-settings" className="btn btn-soft">
              <SlidersHorizontal size={15} /> Manage lists
            </Link>
            <button onClick={() => { setEdit(undefined); setDialog(true); }} className="btn btn-primary">
              <Plus size={16} /> Add product
            </button>
          </div>
        }
      />
      <div className="panel mb-4 flex flex-col gap-3 p-3 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
          <input data-testid="input-search-products" className="field pl-9" placeholder="Search product name" value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
        <select className="field sm:w-48" value={category} onChange={(event) => setCategory(event.target.value)}>
          <option value="">All categories</option>
          {categories.map((item) => <option value={item.key} key={item.id}>{item.name}</option>)}
        </select>
        <select className="field sm:w-40" value={active} onChange={(event) => setActive(event.target.value)}>
          <option value="true">Active products</option>
          <option value="false">Inactive</option>
          <option value="">All status</option>
        </select>
      </div>
      <section className="panel overflow-hidden">
        <div className="hidden grid-cols-[minmax(180px,1.4fr)_1fr_1fr_.8fr_.8fr_150px] gap-3 border-b border-border bg-muted/50 px-5 py-3 text-[10px] font-extrabold uppercase tracking-wider text-muted-foreground md:grid">
          <span>Product</span><span>Category</span><span>Stock section</span><span>On hand</span><span>Minimum</span><span />
        </div>
        <QueryState
          loading={query.isLoading}
          error={query.isError}
          retry={() => void query.refetch()}
          hasRows={rows.length > 0}
          empty={<EmptyState title="Your catalogue starts here" detail="Add the products your team counts and orders. The list stays connected to live store stock." action={<button onClick={() => setDialog(true)} className="btn btn-primary"><Plus size={15} /> Add first product</button>} />}
        >
          {rows.map((product) => (
            <div key={product.id} data-testid={`row-product-${product.id}`} className="grid gap-3 border-b border-border/75 px-5 py-4 last:border-0 md:grid-cols-[minmax(180px,1.4fr)_1fr_1fr_.8fr_.8fr_150px] md:items-center">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#e8eee7] text-primary"><Package size={17} /></span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-extrabold">{product.name}</div>
                  <div className="mt-1 text-[10px] text-muted-foreground">{product.bundleSize} per bundle</div>
                </div>
              </div>
              <div className="flex items-center justify-between md:block">
                <span className="text-[10px] text-muted-foreground md:hidden">Category</span>
                <Pill>{categories.find((item) => item.key === product.category)?.name || categoryLabels[product.category] || product.category}</Pill>
              </div>
              <div className="flex justify-between md:block">
                <span className="text-[10px] text-muted-foreground md:hidden">Stock section</span>
                <span className="text-xs">{sections.find((section) => section.id === product.defaultSectionId)?.name || "Not set"}</span>
              </div>
              <div className="flex justify-between md:block">
                <span className="text-[10px] text-muted-foreground md:hidden">On hand</span>
                <span className={`mono text-xs font-medium ${product.lowStock ? 'text-[#a65339]' : ''}`}>{product.stockOnHand} <span className="font-sans text-muted-foreground">{product.unit}</span></span>
              </div>
              <div className="flex justify-between md:block">
                <span className="text-[10px] text-muted-foreground md:hidden">Minimum</span>
                <span className="mono text-xs">{product.minStock} <span className="font-sans text-muted-foreground">{product.unit}</span></span>
              </div>
              <div className="flex items-center justify-between gap-2 md:justify-end">
                <span className="md:hidden"><Pill tone={product.active ? 'good' : 'neutral'}>{product.active ? 'Active' : 'Inactive'}</Pill></span>
                <button data-testid={`button-view-product-sop-${product.id}`} className="btn btn-soft px-2 text-xs" onClick={() => setSopProduct(product)}>Category SOP</button>
                <button data-testid={`button-edit-product-${product.id}`} className="btn btn-ghost px-2 text-xs" onClick={() => { setEdit(product); setDialog(true); }}>Edit</button>
              </div>
            </div>
          ))}
        </QueryState>
      </section>
      {dialog && <ProductDialog item={edit} close={() => setDialog(false)} />}
      {sopProduct && <ProductSopDialog product={sopProduct} category={sopCategory} close={() => setSopProduct(undefined)} />}
    </>
  );
}

function SupplierDialog({ item, close }: { item?: Supplier; close: () => void }) {
  const qc = useQueryClient();
  const create = useCreateSupplier();
  const update = useUpdateSupplier();
  const [form, setForm] = useState({ name: item?.name || '', contactName: item?.contactName || '', phone: item?.phone || '', email: item?.email || '', notes: item?.notes || '' });
  const busy = create.isPending || update.isPending;
  function submit(event: FormEvent) {
    event.preventDefault();
    const data = { name: form.name.trim(), contactName: form.contactName.trim() || null, phone: form.phone.trim() || null, email: form.email.trim() || null, notes: form.notes.trim() || null };
    const done = () => { void qc.invalidateQueries({ queryKey: getListSuppliersQueryKey() }); toast.success(item ? 'Supplier updated' : 'Supplier added'); close(); };
    if (item) update.mutate({ supplierId: item.id, data }, { onSuccess: done, onError: () => toast.error('Could not save supplier') });
    else create.mutate({ data }, { onSuccess: done, onError: () => toast.error('Could not add supplier') });
  }
  return <Modal title={item ? 'Edit supplier' : 'Add supplier'} detail="Keep contact details close to the receiving bench." onClose={close}><form onSubmit={submit} className="space-y-4">
    <label className="block text-xs font-bold">Supplier name<input data-testid="input-supplier-name" required maxLength={120} className="field mt-1.5" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}/></label>
    <div className="grid gap-3 sm:grid-cols-2"><label className="block text-xs font-bold">Contact name<input data-testid="input-supplier-contact" maxLength={120} className="field mt-1.5" value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })}/></label><label className="block text-xs font-bold">Phone<input data-testid="input-supplier-phone" maxLength={40} type="tel" className="field mt-1.5" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}/></label></div>
    <label className="block text-xs font-bold">Email<input data-testid="input-supplier-email" maxLength={320} type="email" className="field mt-1.5" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}/></label>
    <label className="block text-xs font-bold">Notes<textarea data-testid="input-supplier-notes" maxLength={1000} className="field mt-1.5 min-h-20 resize-y" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}/></label>
    <div className="flex justify-end gap-2"><button type="button" data-testid="button-cancel-supplier" onClick={close} className="btn btn-soft">Cancel</button><button data-testid="button-save-supplier" disabled={busy} className="btn btn-primary">{busy ? 'Saving…' : item ? 'Save changes' : 'Add supplier'}</button></div>
  </form></Modal>;
}
function Suppliers() {
  const qc = useQueryClient();
  const query = useListSuppliers({ query: { queryKey: getListSuppliersQueryKey() } });
  const update = useUpdateSupplier();
  const [editor, setEditor] = useState<{ open: boolean; item?: Supplier }>({ open: false });
  const rows = query.data || [];
  function archive(item: Supplier) {
    if (!window.confirm(`Archive ${item.name}? It will no longer be available for new requests or deliveries.`)) return;
    update.mutate({ supplierId: item.id, data: { active: false } }, { onSuccess: () => { toast.success('Supplier archived'); void qc.invalidateQueries({ queryKey: getListSuppliersQueryKey() }); }, onError: () => toast.error('Could not archive supplier') });
  }
  return <><PageHeading eyebrow="Outlet directory" title="Suppliers" subtitle="Contacts your team can select on purchase requests and receiving." action={<button data-testid="button-add-supplier" onClick={() => setEditor({ open: true })} className="btn btn-primary"><Plus size={16}/> Add supplier</button>}/>
    <section className="panel overflow-hidden"><div className="grid grid-cols-[1fr_auto] border-b border-border bg-muted/50 px-5 py-3 text-[10px] font-extrabold uppercase tracking-wider text-muted-foreground"><span>Supplier</span><span>Manage</span></div><QueryState loading={query.isLoading} error={query.isError} retry={() => void query.refetch()} hasRows={rows.length > 0} empty={<EmptyState title="No suppliers yet" detail="Add the vendors your outlet receives from. Archived contacts stay out of new workflows." action={<button onClick={() => setEditor({ open: true })} className="btn btn-primary"><Plus size={15}/> Add first supplier</button>}/>}>
      {rows.map((supplier) => <div key={supplier.id} data-testid={`row-supplier-${supplier.id}`} className="grid gap-4 border-b border-border/75 px-5 py-4 last:border-0 sm:grid-cols-[1fr_auto] sm:items-center"><div className="flex min-w-0 items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#e8eee7] text-primary"><Building2 size={17}/></span><div className="min-w-0"><div className="flex flex-wrap items-center gap-2 text-sm font-extrabold">{supplier.name}<Pill tone={supplier.active ? 'good' : 'neutral'}>{supplier.active ? 'Active' : 'Archived'}</Pill></div><div className="mt-1 text-[11px] text-muted-foreground">{[supplier.contactName, supplier.phone, supplier.email].filter(Boolean).join(' · ') || 'No contact details'}</div>{supplier.notes && <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted-foreground">{supplier.notes}</p>}</div></div><div className="flex gap-2"><button data-testid={`button-edit-supplier-${supplier.id}`} onClick={() => setEditor({ open: true, item: supplier })} className="btn btn-soft text-xs">Edit</button>{supplier.active && <button data-testid={`button-archive-supplier-${supplier.id}`} disabled={update.isPending} onClick={() => archive(supplier)} className="btn btn-ghost text-xs text-[#98483e]">Archive</button>}</div></div>)}
    </QueryState></section>
    {editor.open && <SupplierDialog item={editor.item} close={() => setEditor({ open: false })}/>}
  </>;
}
function Inventory() {
  const qc = useQueryClient(); const [productId, setProductId] = useState(''); const [expiring, setExpiring] = useState(''); const [adjust, setAdjust] = useState(false);
  const params = { ...(productId ? { productId: Number(productId) } : {}), ...(expiring ? { expiringWithinDays: Number(expiring) } : {}) };
  const query = useListStockBatches(params, { query: { queryKey: getListStockBatchesQueryKey(params) } }); const productsQ = useListProducts({ active: true }, { query: { queryKey: getListProductsQueryKey({ active: true }) } }); const rows = query.data || [];
  return <><PageHeading eyebrow="Stock room" title="Inventory" subtitle="Track batches, use-by dates, and make a clear correction." action={<button className="btn btn-primary" onClick={() => setAdjust(true)}><SlidersHorizontal size={15}/> Adjust stock</button>}/>
    <div className="panel mb-4 flex flex-col gap-3 p-3 sm:flex-row"><div className="flex items-center gap-2 text-xs font-bold text-muted-foreground sm:px-2"><Filter size={15}/> Refine</div><select className="field sm:max-w-xs" value={productId} onChange={(e) => setProductId(e.target.value)}><option value="">All products</option>{(productsQ.data || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><select className="field sm:w-52" value={expiring} onChange={(e) => setExpiring(e.target.value)}><option value="">Any expiry</option><option value="7">Expiring in 7 days</option><option value="30">Expiring in 30 days</option></select></div>
    <div className="panel overflow-hidden"><div className="grid grid-cols-[1.3fr_.7fr_1fr_1fr_.8fr] gap-3 border-b border-border bg-muted/50 px-5 py-3 text-[10px] font-extrabold uppercase tracking-wider text-muted-foreground"><span>Product batch</span><span>Quantity</span><span>Storage area</span><span>Received</span><span>Use by</span></div><QueryState loading={query.isLoading} error={query.isError} retry={() => void query.refetch()} hasRows={rows.length > 0} empty={<EmptyState title="No batches in view" detail="Receiving and adjusting stock creates traceable batches here. Try clearing your filters."/>}>
      {rows.map((b) => { const days = b.expiryDate ? Math.ceil((new Date(b.expiryDate).getTime() - Date.now()) / 86400000) : Infinity; return <div key={b.id} className="grid grid-cols-[1.3fr_.7fr_1fr_1fr_.8fr] items-center gap-3 border-b border-border/75 px-5 py-4 last:border-0"><div className="min-w-0"><div className="truncate text-xs font-extrabold">{b.productName}</div><div className="mt-1 mono text-[9px] text-muted-foreground">BATCH {String(b.id).padStart(5, '0')}</div></div><span className="mono text-xs">{b.quantity}</span><span className="text-xs text-muted-foreground">{b.sectionName || 'Unassigned'}</span><span className="text-[11px] text-muted-foreground">{dateText(b.receivedAt)}</span><span>{b.expiryDate ? <Pill tone={days <= 3 ? 'bad' : days <= 7 ? 'warn' : 'good'}>{dateText(b.expiryDate)}</Pill> : <span className="text-xs text-muted-foreground">No expiry</span>}</span></div>; })}
    </QueryState></div>
    {adjust && <AdjustmentModal products={productsQ.data || []} close={() => setAdjust(false)} done={() => { void qc.invalidateQueries({ queryKey: getListStockBatchesQueryKey() }); void qc.invalidateQueries({ queryKey: getListProductsQueryKey() }); void qc.invalidateQueries({ queryKey: getListStockMovementsQueryKey() }); void qc.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() }); }}/>}
  </>;
}
function AdjustmentModal({ products, close, done }: { products: Product[]; close: () => void; done: () => void }) {
  const mutation = useCreateStockAdjustment(); const sectionsQ = useListStockSections({ query: { queryKey: getListStockSectionsQueryKey() } }); const sections = sectionsQ.data || [];
  const [id, setId] = useState(products[0]?.id ? String(products[0].id) : ''); const [sectionId, setSectionId] = useState(''); const [delta, setDelta] = useState(''); const [reason, setReason] = useState(''); const [expiry, setExpiry] = useState('');
  useEffect(() => { if (sections.length && !sections.some((section) => String(section.id) === sectionId)) setSectionId(String(sections[0].id)); }, [sections, sectionId]);
  function submit(e: FormEvent) { e.preventDefault(); mutation.mutate({ data: { productId: Number(id), sectionId: Number(sectionId), quantityDelta: Number(delta), reason: reason.trim(), expiryDate: expiry || null } }, { onSuccess: () => { toast.success('Stock adjusted'); done(); close(); }, onError: (error) => toast.error(error.message || 'Could not adjust stock') }); }
  return <Modal title="Adjust stock" detail="Record a correction with a reason so the trail stays clear." onClose={close}><form onSubmit={submit} className="space-y-4"><label className="block text-xs font-bold">Product<select required className="field mt-1.5" value={id} onChange={(e) => setId(e.target.value)}>{products.map((p) => <option value={p.id} key={p.id}>{p.name} · {p.stockOnHand} {p.unit}</option>)}</select></label><label className="block text-xs font-bold">Storage area<select required className="field mt-1.5" value={sectionId} onChange={(e) => setSectionId(e.target.value)}>{sections.map((section) => <option value={section.id} key={section.id}>{section.name}</option>)}</select></label><div className="grid gap-3 sm:grid-cols-2"><label className="block text-xs font-bold">Change quantity<input required type="number" step=".01" className="field mt-1.5" placeholder="Use - for stock loss" value={delta} onChange={(e) => setDelta(e.target.value)}/></label><label className="block text-xs font-bold">Expiry date (optional)<input type="date" className="field mt-1.5" value={expiry} onChange={(e) => setExpiry(e.target.value)}/></label></div><label className="block text-xs font-bold">Reason<input required className="field mt-1.5" placeholder="Waste, breakage, recount…" value={reason} onChange={(e) => setReason(e.target.value)}/></label><div className="flex justify-end gap-2 pt-2"><button type="button" onClick={close} className="btn btn-soft">Cancel</button><button disabled={mutation.isPending || sectionsQ.isLoading || !products.length || !sectionId} className="btn btn-primary">{mutation.isPending ? 'Saving…' : 'Save adjustment'}</button></div></form></Modal>;
}

type DeliveryDraftLine = { productId: string; quantity: string; tempC: string; expiryDate: string };
function DeliveryCreateModal({ close }: { close: () => void }) {
  const qc = useQueryClient();
  const productsQ = useListProducts({ active: true }, { query: { queryKey: getListProductsQueryKey({ active: true }) } });
  const categoriesQ = useListProductCategories({ query: { queryKey: getListProductCategoriesQueryKey() } });
  const suppliersQ = useListSuppliers({ query: { queryKey: getListSuppliersQueryKey() } });
  const ordersQ = useListPurchaseOrders({}, { query: { queryKey: getListPurchaseOrdersQueryKey({}) } });
  const create = useCreateDelivery();
  const [supplierId, setSupplierId] = useState('');
  const [orderId, setOrderId] = useState('');
  const [lines, setLines] = useState<DeliveryDraftLine[]>([{ productId: '', quantity: '1', tempC: '', expiryDate: '' }]);
  const products = (productsQ.data || []).filter((p) => p.active);
  const approvedOrders = (ordersQ.data || []).filter((o) => ['approved', 'partially_received'].includes(o.status));
  const linkedSupplierId = approvedOrders.find((order) => String(order.id) === orderId)?.supplierId;
  const suppliers = (suppliersQ.data || []).filter((supplier) => supplier.active || supplier.id === linkedSupplierId);
  function setLine(index: number, key: keyof DeliveryDraftLine, value: string) { setLines((old) => old.map((line, i) => i === index ? { ...line, [key]: value } : line)); }
  function chooseOrder(value: string) {
    setOrderId(value);
    const order = approvedOrders.find((o) => String(o.id) === value);
    if (order?.supplierId) setSupplierId(String(order.supplierId));
    if (order) setLines(order.lines
      .filter((line) => line.quantity - line.receivedQuantity > 0.001)
      .map((line) => ({ productId: String(line.productId), quantity: String(line.quantity - line.receivedQuantity), tempC: '', expiryDate: '' })));
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const data = { supplierId: Number(supplierId), purchaseOrderId: orderId ? Number(orderId) : null, lines: lines.filter((line) => line.productId).map((line) => ({ productId: Number(line.productId), quantity: Number(line.quantity), tempC: line.tempC === '' ? null : Number(line.tempC), expiryDate: line.expiryDate || null })) };
    create.mutate({ data }, { onSuccess: () => { toast.success('Receiving log recorded'); void qc.invalidateQueries({ queryKey: getListDeliveriesQueryKey() }); void qc.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() }); void qc.invalidateQueries({ queryKey: getListProductsQueryKey() }); void qc.invalidateQueries({ queryKey: getListStockBatchesQueryKey() }); void qc.invalidateQueries({ queryKey: getListStockMovementsQueryKey() }); void qc.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() }); close(); }, onError: () => toast.error('Could not record delivery') });
  }
  const loading = productsQ.isLoading || categoriesQ.isLoading || suppliersQ.isLoading || ordersQ.isLoading;
  return <Modal title="Log a delivery" detail="Capture what arrived, then review the server's checks before deciding." onClose={close}><form onSubmit={submit} className="space-y-4">
    {loading && <div className="space-y-2"><div className="skeleton h-10 w-full"/><div className="skeleton h-10 w-3/4"/></div>}
    {(productsQ.isError || categoriesQ.isError || suppliersQ.isError || ordersQ.isError) && <div role="alert" className="rounded-xl bg-[#f6e4df] p-3 text-xs text-[#98483e]">Could not load suppliers, products, categories, or purchase requests. Close and retry once the connection is restored.</div>}
    <div className="grid gap-3 sm:grid-cols-2"><label className="block text-xs font-bold">Supplier<select data-testid="select-delivery-supplier" required className="field mt-1.5" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}><option value="">Choose supplier</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.active ? s.name : `${s.name} (archived on linked request)`}</option>)}</select></label><label className="block text-xs font-bold">Approved purchase order<select data-testid="select-delivery-order" className="field mt-1.5" value={orderId} onChange={(e) => chooseOrder(e.target.value)}><option value="">No purchase order</option>{approvedOrders.map((o) => <option key={o.id} value={o.id}>Request #{o.id} · {o.supplierName || o.requestedBy}</option>)}</select></label></div>
    <div className="space-y-2">
      <div className="flex items-center justify-between"><h3 className="text-xs font-extrabold">Items received</h3><span className="text-[10px] text-muted-foreground">{lines.length} line{lines.length === 1 ? '' : 's'}</span></div>
      {lines.map((line, i) => {
        const product = products.find((candidate) => String(candidate.id) === line.productId);
        const category = product
          ? (categoriesQ.data || []).find((candidate) => candidate.key === product.category)
          : undefined;
        const hasProductRange = Boolean(
          product && product.tempMinC !== null && product.tempMaxC !== null,
        );
        const effectiveTempMinC = product && product.tempMinC !== null && product.tempMaxC !== null
          ? product.tempMinC
          : category?.receivingTempMinC ?? null;
        const effectiveTempMaxC = product && product.tempMinC !== null && product.tempMaxC !== null
          ? product.tempMaxC
          : category?.receivingTempMaxC ?? null;
        const hasReceivingGuidance = Boolean(category?.receivingHandlingSop) ||
          effectiveTempMinC !== null || effectiveTempMaxC !== null;
        return <div key={i} data-testid={`row-delivery-draft-${i}`} className="rounded-xl border border-border bg-muted/25 p-3">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_100px_100px]">
            <label className="block text-[10px] font-bold">Product<select data-testid={`select-delivery-product-${i}`} required className="field mt-1" value={line.productId} onChange={(e) => setLine(i, 'productId', e.target.value)}><option value="">Choose item</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label className="block text-[10px] font-bold">Quantity<input data-testid={`input-delivery-quantity-${i}`} required min=".01" step=".01" type="number" className="field mt-1" value={line.quantity} onChange={(e) => setLine(i, 'quantity', e.target.value)}/></label>
            <label className="block text-[10px] font-bold">Probe °C<input data-testid={`input-delivery-temp-${i}`} type="number" min="-60" max="100" step=".1" className="field mt-1" value={line.tempC} onChange={(e) => setLine(i, 'tempC', e.target.value)} placeholder="Optional"/></label>
          </div>
          {hasReceivingGuidance && <div className="mt-2 rounded-lg bg-[#f5f1e7] px-3 py-2 text-[10px] leading-4 text-muted-foreground">
            <p className="mb-1 font-bold">{category?.name || product?.category} receiving guidance</p>
            {category?.receivingHandlingSop && <p className="whitespace-pre-wrap">{category.receivingHandlingSop}</p>}
            {(effectiveTempMinC !== null || effectiveTempMaxC !== null) && <p className="mt-1 font-bold">{hasProductRange ? 'Product-specific range' : 'Category range'}: {effectiveTempMinC ?? '—'}°C to {effectiveTempMaxC ?? '—'}°C</p>}
          </div>}
          <div className="mt-2 flex items-end gap-2">
            <label className="block flex-1 text-[10px] font-bold">Expiry date<input data-testid={`input-delivery-expiry-${i}`} type="date" className="field mt-1" value={line.expiryDate} onChange={(e) => setLine(i, 'expiryDate', e.target.value)}/></label>
            <button data-testid={`button-remove-delivery-line-${i}`} type="button" disabled={lines.length === 1} onClick={() => setLines((old) => old.filter((_, index) => index !== i))} className="btn btn-ghost p-2" aria-label="Remove product line"><X size={15}/></button>
          </div>
        </div>;
      })}
    </div>
    <button data-testid="button-add-delivery-line" type="button" onClick={() => setLines((old) => [...old, { productId: '', quantity: '1', tempC: '', expiryDate: '' }])} className="btn btn-soft text-xs"><Plus size={14}/> Add item</button>
    <div className="flex justify-end gap-2 border-t border-border pt-3"><button data-testid="button-cancel-delivery" type="button" onClick={close} className="btn btn-soft">Cancel</button><button data-testid="button-submit-delivery" disabled={create.isPending || loading || !suppliers.length || !products.length} className="btn btn-primary">{create.isPending ? 'Recording…' : 'Record delivery'}</button></div>
  </form></Modal>;
}
function Deliveries() {
  const qc = useQueryClient();
  const query = useListDeliveries({ query: { queryKey: getListDeliveriesQueryKey() } });
  const currentUser = useGetCurrentUser({ query: { queryKey: getGetCurrentUserQueryKey() } });
  const decide = useDecideDelivery();
  const [showCreate, setShowCreate] = useState(false);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const rows = query.data || [];
  const canDecide = ['owner', 'admin', 'supervisor'].includes(currentUser.data?.role || '');
  function invalidate() {
    void qc.invalidateQueries({ queryKey: getListDeliveriesQueryKey() });
    void qc.invalidateQueries({ queryKey: getListProductsQueryKey() });
    void qc.invalidateQueries({ queryKey: getListStockBatchesQueryKey() });
    void qc.invalidateQueries({ queryKey: getListStockMovementsQueryKey() });
    void qc.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() });
    void qc.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
  }
  function decideDelivery(delivery: Delivery, decision: 'accepted' | 'rejected' | 'returned') {
    const note = (notes[delivery.id] || '').trim();
    if (decision !== 'accepted' && !note) { toast.error('Add a note before rejecting or returning a delivery'); return; }
    decide.mutate({ deliveryId: delivery.id, data: { decision, note: note || undefined } }, { onSuccess: () => { toast.success(`Delivery ${decision}`); invalidate(); }, onError: () => toast.error('Could not decide delivery') });
  }
  return <><PageHeading eyebrow="Receiving bench" title="Deliveries" subtitle="Log each arrival, check the category's receiving rules, and keep held stock out of inventory until reviewed." action={<button data-testid="button-log-delivery" onClick={() => setShowCreate(true)} className="btn btn-primary"><Plus size={16}/> Log delivery</button>}/>
    <div className="mb-4 grid gap-3 sm:grid-cols-3"><div className="panel p-4"><div className="mono text-2xl font-medium">{rows.filter((d) => d.status === 'pending_approval').length}</div><div className="mt-1 text-[10px] text-muted-foreground">Held for review</div></div><div className="panel p-4"><div className="mono text-2xl font-medium">{rows.filter((d) => d.status === 'accepted').length}</div><div className="mt-1 text-[10px] text-muted-foreground">Accepted</div></div><div className="panel p-4"><div className="mono text-2xl font-medium">{rows.filter((d) => d.lines.some((line) => line.checkStatus === 'review')).length}</div><div className="mt-1 text-[10px] text-muted-foreground">With review flags</div></div></div>
    <section className="panel overflow-hidden"><QueryState loading={query.isLoading} error={query.isError} retry={() => void query.refetch()} hasRows={rows.length > 0} empty={<EmptyState title="No deliveries logged" detail="Record supplier arrivals here. Each product is checked against its category's receiving rules." action={<button onClick={() => setShowCreate(true)} className="btn btn-primary"><Plus size={15}/> Log the first delivery</button>}/>}>
      <div className="divide-y divide-border/75">{rows.map((delivery) => <article key={delivery.id} data-testid={`row-delivery-${delivery.id}`} className="p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2 text-sm font-extrabold"><Truck size={16} className="text-primary"/> Delivery #{String(delivery.id).padStart(4, '0')}<Pill tone={delivery.status === 'accepted' ? 'good' : delivery.status === 'pending_approval' ? 'warn' : delivery.status === 'rejected' ? 'bad' : 'neutral'}>{titleCase(delivery.status)}</Pill></div><div className="mt-1 text-[11px] text-muted-foreground">{delivery.supplierName || 'Supplier unavailable'} · {timeText(delivery.createdAt)} · recorded by {delivery.recordedBy}{delivery.purchaseOrderId ? ` · Request #${delivery.purchaseOrderId}` : ''}</div></div>{delivery.decidedBy && <div className="text-right text-[10px] text-muted-foreground">Reviewed by {delivery.decidedBy}</div>}</div>
        <div className="mt-4 space-y-2">{delivery.lines.map((line) => <div key={line.productId} data-testid={`row-delivery-line-${delivery.id}-${line.productId}`} className="grid gap-2 rounded-xl bg-muted/40 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center"><div><div className="text-xs font-bold">{line.productName}</div><div className="mt-1 text-[10px] text-muted-foreground">{line.quantity} received{line.tempC !== null ? ` · ${line.tempC}°C` : ' · no probe temperature'}{line.expiryDate ? ` · expires ${dateText(line.expiryDate)}` : ''}</div>{line.issue && <div className="mt-1 text-[10px] font-semibold text-[#98483e]">{line.issue}</div>}</div><Pill tone={line.checkStatus === 'pass' ? 'good' : 'warn'}>{line.checkStatus === 'pass' ? 'Pass' : 'Review'}</Pill><span data-testid={`status-delivery-line-${delivery.id}-${line.productId}`} className="text-[10px] text-muted-foreground">{line.issue || 'Within handling checks'}</span></div>)}</div>
        {delivery.decisionNote && <div className="mt-3 rounded-lg bg-[#f8eed6] px-3 py-2 text-xs text-[#76531b]">Decision note: {delivery.decisionNote}</div>}
        {canDecide && delivery.status === 'pending_approval' && <div className="mt-4 border-t border-border pt-3"><label className="block text-[10px] font-bold">Decision note<textarea data-testid={`input-delivery-decision-note-${delivery.id}`} maxLength={1000} className="field mt-1.5 min-h-16 resize-y" value={notes[delivery.id] || ''} onChange={(e) => setNotes((old) => ({ ...old, [delivery.id]: e.target.value }))} placeholder="Required for reject or return; optional for accept"/></label><div className="mt-2 flex flex-wrap justify-end gap-2"><button data-testid={`button-reject-delivery-${delivery.id}`} disabled={decide.isPending} onClick={() => decideDelivery(delivery, 'rejected')} className="btn btn-soft text-xs">Reject</button><button data-testid={`button-return-delivery-${delivery.id}`} disabled={decide.isPending} onClick={() => decideDelivery(delivery, 'returned')} className="btn btn-soft text-xs">Return</button><button data-testid={`button-accept-delivery-${delivery.id}`} disabled={decide.isPending} onClick={() => decideDelivery(delivery, 'accepted')} className="btn btn-primary text-xs"><Check size={14}/> Accept and update stock</button></div></div>}
      </article>)}</div>
    </QueryState></section>
    {showCreate && <DeliveryCreateModal close={() => setShowCreate(false)}/>}
  </>;
}
function Orders() {
  const qc = useQueryClient(); const [status, setStatus] = useState(''); const [create, setCreate] = useState(false); const [receiving, setReceiving] = useState<PurchaseOrder>();
  const params = status ? { status: status as 'pending' | 'approved' | 'rejected' | 'partially_received' | 'received' } : {};
  const query = useListPurchaseOrders(params, { query: { queryKey: getListPurchaseOrdersQueryKey(params) } }); const rows = query.data || [];
  const decide = useDecidePurchaseOrder();
  const invalidate = () => { void qc.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() }); void qc.invalidateQueries({ queryKey: getListStockBatchesQueryKey() }); void qc.invalidateQueries({ queryKey: getListProductsQueryKey() }); void qc.invalidateQueries({ queryKey: getListStockMovementsQueryKey() }); void qc.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() }); };
  function decideOrder(o: PurchaseOrder, decision: 'approved' | 'rejected') { decide.mutate({ orderId: o.id, data: { decision } }, { onSuccess: () => { toast.success(`Request ${decision}`); invalidate(); }, onError: () => toast.error('Could not update request') }); }
  return <><PageHeading eyebrow="Requests & deliveries" title="Orders" subtitle="Move store requests from need to received, with every decision visible." action={<button onClick={() => setCreate(true)} className="btn btn-primary"><Plus size={16}/> New request</button>}/>
    <div className="mb-4 flex gap-2 overflow-x-auto pb-1">{[['','All orders'],['pending','To review'],['approved','Approved'],['partially_received','Partial'],['received','Received'],['rejected','Rejected']].map(([value,label])=><button key={value} onClick={() => setStatus(value)} className={`shrink-0 rounded-full px-3.5 py-2 text-xs font-bold ${status === value ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground ring-1 ring-border'}`}>{label}</button>)}</div>
    <QueryState loading={query.isLoading} error={query.isError} retry={() => void query.refetch()} hasRows={rows.length > 0} empty={<div className="panel"><EmptyState title="No requests here" detail="When your store needs a top-up, add a request and keep the team in the loop." action={<button onClick={() => setCreate(true)} className="btn btn-primary"><Plus size={15}/> Create a request</button>}/></div>}>
     <div className="space-y-3">{rows.map((o) => <section key={o.id} className="panel overflow-hidden"><div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4"><div className="flex items-start gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[#e8eee7] text-primary"><ShoppingBag size={17}/></span><div><div className="text-sm font-extrabold">Request #{String(o.id).padStart(4, '0')}</div><div className="mt-1 text-[11px] text-muted-foreground">By {o.requestedBy} · {timeText(o.createdAt)}{o.supplierName ? ` · ${o.supplierName}` : ''}</div></div></div><Pill tone={o.status === 'pending' ? 'warn' : o.status === 'rejected' ? 'bad' : o.status === 'received' ? 'good' : 'neutral'}>{titleCase(o.status)}</Pill></div><div className="grid gap-3 border-b border-border/70 bg-[#fbfaf6] px-5 py-4 sm:grid-cols-[1fr_1fr]"><div><div className="mono text-[9px] font-bold uppercase tracking-[.14em] text-muted-foreground">Deliver to</div><div className="mt-1 text-xs font-extrabold" data-testid={`text-order-outlet-${o.id}`}>{o.outlet.name}</div><div className="mt-1 whitespace-pre-line text-[11px] leading-5 text-muted-foreground" data-testid={`text-order-address-${o.id}`}>{o.outlet.businessAddress || 'Address not added'}</div></div><div><div className="mono text-[9px] font-bold uppercase tracking-[.14em] text-muted-foreground">Outlet contact</div><div className="mt-1 text-[11px] leading-5 text-muted-foreground">{o.outlet.contactPhone || 'Phone not added'}<br/>{o.outlet.contactEmail || 'Email not added'}</div></div></div><div className="grid gap-2 px-5 py-4 sm:grid-cols-2">{o.lines.map((line) => <div key={line.productId} className="flex items-center justify-between rounded-lg bg-muted/60 px-3 py-2.5"><span className="text-xs font-bold">{line.productName}</span><span className="mono text-[11px]">{line.receivedQuantity}/{line.quantity} {line.unit}</span></div>)}</div>{o.note && <div className="px-5 pb-3 text-xs text-muted-foreground">Note: {o.note}</div>}<div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 bg-muted/30 px-5 py-3"><span className="text-[10px] text-muted-foreground">{o.reviewedBy ? `Reviewed by ${o.reviewedBy}` : 'Awaiting supervisor review'}</span><div className="flex gap-2">{o.status === 'pending' && <><button disabled={decide.isPending} onClick={() => decideOrder(o, 'rejected')} className="btn btn-soft text-xs">Decline</button><button disabled={decide.isPending} onClick={() => decideOrder(o, 'approved')} className="btn btn-primary text-xs"><Check size={14}/> Approve</button></>}{(o.status === 'approved' || o.status === 'partially_received') && <button onClick={() => setReceiving(o)} className="btn btn-primary text-xs"><Package size={14}/> Record delivery</button>}</div></div></section>)}</div>
    </QueryState>
    {create && <OrderCreateModal close={() => setCreate(false)} done={invalidate}/>}
    {receiving && <ReceiveModal order={receiving} close={() => setReceiving(undefined)} done={invalidate}/>}
  </>;
}
function OrderCreateModal({ close, done }: { close: () => void; done: () => void }) {
  const qc = useQueryClient(); const productsQ = useListProducts({ active: true }, { query: { queryKey: getListProductsQueryKey({ active: true }) } }); const suppliersQ = useListSuppliers({ query: { queryKey: getListSuppliersQueryKey() } }); const create = useCreatePurchaseOrder();
  const [lines, setLines] = useState([{ productId: '', quantity: '1' }]); const [note, setNote] = useState(''); const [supplierId, setSupplierId] = useState('');
  const setLine = (i: number, key: 'productId' | 'quantity', value: string) => setLines((old) => old.map((l, j) => i === j ? { ...l, [key]: value } : l));
  function submit(e: FormEvent) { e.preventDefault(); const data = { note: note || undefined, supplierId: supplierId ? Number(supplierId) : null, lines: lines.filter((l) => l.productId).map((l) => ({ productId: Number(l.productId), quantity: Number(l.quantity) })) }; create.mutate({ data }, { onSuccess: () => { toast.success('Request sent for review'); done(); void qc.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() }); close(); }, onError: () => toast.error('Could not create request') }); }
  const products = productsQ.data || [];
  return <Modal title="New stock request" detail="Request the quantities your store needs next." onClose={close}><form onSubmit={submit} className="space-y-4"><label className="block text-xs font-bold">Supplier (optional)<select data-testid="select-order-supplier" className="field mt-1.5" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}><option value="">Choose later</option>{(suppliersQ.data || []).filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><div className="space-y-2">{lines.map((line, i) => <div key={i} className="grid grid-cols-[1fr_100px_34px] gap-2"><select data-testid={`select-order-product-${i}`} required className="field" value={line.productId} onChange={(e) => setLine(i, 'productId', e.target.value)}><option value="">Choose a product</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.unit}</option>)}</select><input data-testid={`input-order-quantity-${i}`} className="field" required min=".01" step=".01" type="number" value={line.quantity} onChange={(e) => setLine(i, 'quantity', e.target.value)} aria-label={`Quantity for line ${i + 1}`}/><button data-testid={`button-remove-order-line-${i}`} type="button" onClick={() => setLines((old) => old.length > 1 ? old.filter((_,j) => i !== j) : old)} className="btn btn-ghost p-2" aria-label="Remove line"><X size={15}/></button></div>)}</div><button data-testid="button-add-order-line" type="button" onClick={() => setLines((l) => [...l, { productId: '', quantity: '1' }])} className="btn btn-soft text-xs"><Plus size={14}/> Add another item</button><label className="block text-xs font-bold">Note to supervisor<textarea data-testid="input-order-note" className="field mt-1.5 min-h-20 resize-y" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What's behind this request?"/></label><div className="flex justify-end gap-2 pt-2"><button data-testid="button-cancel-order" type="button" onClick={close} className="btn btn-soft">Cancel</button><button data-testid="button-submit-order" disabled={create.isPending || products.length === 0} className="btn btn-primary">{create.isPending ? 'Sending…' : 'Send request'}</button></div></form></Modal>;
}
function ReceiveModal({ order, close, done }: { order: PurchaseOrder; close: () => void; done: () => void }) {
  const mutation = useReceivePurchaseOrder(); const [qty, setQty] = useState<Record<number,string>>(Object.fromEntries(order.lines.map((l) => [l.productId, String(Math.max(0, l.quantity - l.receivedQuantity))]))); const [expiry, setExpiry] = useState('');
  function submit(e: FormEvent) { e.preventDefault(); mutation.mutate({ orderId: order.id, data: { lines: order.lines.map((l) => ({ productId: l.productId, receivedQuantity: Number(qty[l.productId] || 0), expiryDate: expiry || null })) } }, { onSuccess: () => { toast.success('Delivery recorded'); done(); close(); }, onError: () => toast.error('Could not record delivery') }); }
  return <Modal title="Record delivery" detail={`Request #${String(order.id).padStart(4,'0')} · enter what arrived today.`} onClose={close}><form onSubmit={submit} className="space-y-4">{order.lines.map((l) => <div key={l.productId} className="grid grid-cols-[1fr_100px] items-center gap-3 rounded-xl bg-muted/60 p-3"><div><div className="text-xs font-bold">{l.productName}</div><div className="mt-1 text-[10px] text-muted-foreground">{l.receivedQuantity} of {l.quantity} already received</div></div><input className="field" aria-label={`Received quantity ${l.productName}`} type="number" min="0" step=".01" value={qty[l.productId]} onChange={(e) => setQty((q) => ({ ...q, [l.productId]: e.target.value }))}/></div>)}<label className="block text-xs font-bold">Expiry date for this delivery (optional)<input className="field mt-1.5" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)}/></label><div className="flex justify-end gap-2 pt-2"><button type="button" onClick={close} className="btn btn-soft">Cancel</button><button disabled={mutation.isPending} className="btn btn-primary">{mutation.isPending ? 'Saving…' : 'Save delivery'}</button></div></form></Modal>;
}

function Counts() {
  const qc = useQueryClient(); const [, setLocation] = useLocation(); const query = useListStockCounts({ query: { queryKey: getListStockCountsQueryKey() } }); const create = useCreateStockCount(); const [scope, setScope] = useState<StockCountInputScope>('all'); const [scopeCategory, setScopeCategory] = useState<ProductCategory>('food'); const [scopeProduct, setScopeProduct] = useState(''); const [showNew, setShowNew] = useState(false);
  const categoriesQ = useListProductCategories({ query: { queryKey: getListProductCategoriesQueryKey() } });
  const categories = categoriesQ.data || [];
  const products = useListProducts({ active: true }, { query: { queryKey: getListProductsQueryKey({ active: true }) } });
  function start(e: FormEvent) { e.preventDefault(); const data = { scope, ...(scope === 'category' ? { category: scopeCategory } : {}), ...(scope === 'product' ? { productId: Number(scopeProduct) } : {}) }; create.mutate({ data }, { onSuccess: (count) => { toast.success('Count started'); void qc.invalidateQueries({ queryKey: getListStockCountsQueryKey() }); setLocation(`/counts/${count.id}`); }, onError: () => toast.error('Could not start count') }); }
  const rows = query.data || [];
  return <><PageHeading eyebrow="Count sessions" title="Stock counts" subtitle="A reliable count turns assumptions into a usable number." action={<button onClick={() => setShowNew(true)} className="btn btn-primary"><FilePlus2 size={16}/> Start count</button>}/>
    <div className="grid gap-4 sm:grid-cols-3"><div className="panel flex items-center gap-3 p-4"><div className="grid h-10 w-10 place-items-center rounded-xl bg-[#e8eee7] text-primary"><ClipboardCheck size={18}/></div><div><div className="mono text-xl font-medium">{rows.filter((c) => c.status === 'in_progress').length}</div><div className="text-[10px] text-muted-foreground">In progress</div></div></div><div className="panel flex items-center gap-3 p-4"><div className="grid h-10 w-10 place-items-center rounded-xl bg-[#f5efd9] text-[#8b641e]"><CheckCircle2 size={18}/></div><div><div className="mono text-xl font-medium">{rows.filter((c) => c.status === 'completed').length}</div><div className="text-[10px] text-muted-foreground">Completed</div></div></div><div className="panel flex items-center gap-3 p-4"><div className="grid h-10 w-10 place-items-center rounded-xl bg-[#ece8df] text-[#6d706a]"><Package size={18}/></div><div><div className="mono text-xl font-medium">{products.data?.length ?? '—'}</div><div className="text-[10px] text-muted-foreground">Products to count</div></div></div></div>
    <section className="panel mt-5 overflow-hidden"><div className="flex items-center justify-between border-b border-border px-5 py-4"><div><h2 className="text-sm font-extrabold">Recent sessions</h2><p className="mt-1 text-[11px] text-muted-foreground">Pick up a count or review what was submitted.</p></div><span className="mono text-[10px] text-muted-foreground">{rows.length} TOTAL</span></div><QueryState loading={query.isLoading} error={query.isError} retry={() => void query.refetch()} hasRows={rows.length > 0} empty={<EmptyState title="No count sessions yet" detail="Start a count for your full store, a category, or one product. The session saves as you work." action={<button onClick={() => setShowNew(true)} className="btn btn-primary"><FilePlus2 size={15}/> Start your first count</button>}/>}>
      {rows.map((c) => <Link key={c.id} href={`/counts/${c.id}`} className="flex flex-wrap items-center justify-between gap-3 border-b border-border/75 px-5 py-4 last:border-0 hover:bg-muted/35"><div className="flex items-center gap-3"><span className={`grid h-10 w-10 place-items-center rounded-xl ${c.status === 'completed' ? 'bg-[#e5f0e9] text-[#28644b]' : 'bg-[#f6efd9] text-[#8b641e]'}`}><ClipboardCheck size={17}/></span><div><div className="text-xs font-extrabold">{titleCase(c.scope)} count <span className="mono ml-1 font-normal text-muted-foreground">#{c.id}</span></div><div className="mt-1 text-[10px] text-muted-foreground">{c.createdBy} · Started {timeText(c.createdAt)} · {c.lines.length} product-area lines</div></div></div><div className="flex items-center gap-3"><Pill tone={c.status === 'completed' ? 'good' : 'warn'}>{c.status === 'completed' ? 'Submitted' : 'In progress'}</Pill><ArrowRight size={15} className="text-muted-foreground"/></div></Link>)}
    </QueryState></section>
    {showNew && <Modal title="Start a stock count" detail="Make a new session for the items you are checking." onClose={() => setShowNew(false)}><form onSubmit={start} className="space-y-4"><label className="block text-xs font-bold">Count scope<select className="field mt-1.5" value={scope} onChange={(e) => setScope(e.target.value as StockCountInputScope)}><option value="all">Entire store</option><option value="category">Category</option><option value="product">Single product</option></select></label>{scope === 'category' && <label className="block text-xs font-bold">Category<select className="field mt-1.5" value={scopeCategory} onChange={(e) => setScopeCategory(e.target.value as ProductCategory)}>{categories.map((c) => <option key={c.id} value={c.key}>{c.name}</option>)}</select></label>}{scope === 'product' && <label className="block text-xs font-bold">Product<select required className="field mt-1.5" value={scopeProduct} onChange={(e) => setScopeProduct(e.target.value)}><option value="">Choose product</option>{(products.data || []).map((p) => <option value={p.id} key={p.id}>{p.name}</option>)}</select></label>}<div className="flex justify-end gap-2 pt-2"><button type="button" onClick={() => setShowNew(false)} className="btn btn-soft">Cancel</button><button disabled={create.isPending || (scope === 'product' && !scopeProduct) || (scope === 'category' && categoriesQ.isLoading)} className="btn btn-primary">{create.isPending ? 'Starting…' : 'Create count'}</button></div></form></Modal>}
  </>;
}
function CountDetail() {
  const params = useParams<{ countId: string }>();
  const countId = Number(params.countId);
  const qc = useQueryClient();
  const query = useGetStockCount(countId, {
    query: {
      queryKey: getGetStockCountQueryKey(countId),
      enabled: Number.isFinite(countId),
    },
  });
  const submit = useSubmitStockCount();
  const [counts, setCounts] = useState<Record<string, string>>({});
  const count = query.data;
  const lineKey = (line: { productId: number; sectionId: number | null }) =>
    `${line.productId}:${line.sectionId ?? "outlet"}`;

  useEffect(() => {
    if (!count) return;
    setCounts(
      Object.fromEntries(
        count.lines.map((line) => [
          lineKey(line),
          line.countedQuantity === null ? "" : String(line.countedQuantity),
        ]),
      ),
    );
  }, [count?.id]);

  function save(event: FormEvent) {
    event.preventDefault();
    if (!count) return;
    if (count.lines.some((line) => counts[lineKey(line)] === undefined || counts[lineKey(line)] === "")) {
      toast.error("Enter a counted quantity for every product and storage area.");
      return;
    }
    const lines = count.lines.map((line) => ({
      productId: line.productId,
      ...(line.sectionId === null ? {} : { sectionId: line.sectionId }),
      countedQuantity: Number(counts[lineKey(line)]),
    }));
    submit.mutate(
      { countId, data: { lines } },
      {
        onSuccess: () => {
          toast.success("Count submitted");
          void qc.invalidateQueries({ queryKey: getGetStockCountQueryKey(countId) });
          void qc.invalidateQueries({ queryKey: getListStockCountsQueryKey() });
          void qc.invalidateQueries({ queryKey: getListProductsQueryKey() });
          void qc.invalidateQueries({ queryKey: getListStockBatchesQueryKey() });
          void qc.invalidateQueries({ queryKey: getListStockSectionsQueryKey() });
          void qc.invalidateQueries({ queryKey: getListStockMovementsQueryKey() });
          void qc.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          void qc.invalidateQueries({ queryKey: getGetStockTransferOptionsQueryKey() });
        },
        onError: (error) => toast.error(error.message || "Could not submit count"),
      },
    );
  }

  return (
    <>
      <div className="mb-5">
        <Link href="/counts" className="btn btn-ghost -ml-2 text-xs">
          <ArrowRight className="rotate-180" size={14} /> All counts
        </Link>
      </div>
      <QueryState loading={query.isLoading} error={query.isError} retry={() => void query.refetch()}>
        {count && (
          <>
            <PageHeading
              eyebrow={`Count session #${count.id}`}
              title={`${titleCase(count.scope)} count`}
              subtitle={`Started by ${count.createdBy} · ${timeText(count.createdAt)}`}
              action={
                <Pill tone={count.status === "completed" ? "good" : "warn"}>
                  {titleCase(count.status)}
                </Pill>
              }
            />
            <form onSubmit={save}>
              <div className="panel overflow-x-auto">
                <div className="grid min-w-[620px] grid-cols-[minmax(190px,1fr)_minmax(120px,.7fr)_100px_120px] gap-3 border-b border-border bg-muted/50 px-5 py-3 text-[10px] font-extrabold uppercase tracking-wider text-muted-foreground">
                  <span>Product</span>
                  <span>Storage area</span>
                  <span>Expected</span>
                  <span>Counted</span>
                </div>
                {count.lines.map((line) => {
                  const key = lineKey(line);
                  const value = counts[key];
                  const variance =
                    value === "" || value === undefined
                      ? null
                      : Number(value) - line.expectedQuantity;
                  return (
                    <div
                      key={key}
                      className="grid min-w-[620px] grid-cols-[minmax(190px,1fr)_minmax(120px,.7fr)_100px_120px] items-center gap-3 border-b border-border/75 px-5 py-4 last:border-0"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-xs font-extrabold">{line.productName}</div>
                        <div className="mt-1 text-[10px] text-muted-foreground">
                          {line.unit}
                          {variance !== null && variance !== 0 && (
                            <span className={`ml-2 font-bold ${variance < 0 ? "text-[#a65339]" : "text-primary"}`}>
                              {variance > 0 ? "+" : ""}{variance} variance
                            </span>
                          )}
                        </div>
                      </div>
                      <span className="text-xs text-muted-foreground">{line.sectionName || "Outlet total"}</span>
                      <span className="mono text-xs text-muted-foreground">{line.expectedQuantity}</span>
                      <input
                        aria-label={`Counted quantity ${line.productName} in ${line.sectionName || "outlet"}`}
                        disabled={count.status === "completed"}
                        className="field px-2 text-center mono"
                        type="number"
                        min="0"
                        step=".01"
                        value={value ?? ""}
                        onChange={(event) => setCounts((current) => ({ ...current, [key]: event.target.value }))}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-muted-foreground">
                  {Object.values(counts).filter((value) => value !== "").length} of {count.lines.length} product-area lines counted
                </div>
                {count.status !== "completed" && (
                  <button
                    disabled={submit.isPending || count.lines.some((line) => counts[lineKey(line)] === undefined || counts[lineKey(line)] === "")}
                    className="btn btn-primary"
                  >
                    <CheckCircle2 size={15} />
                    {submit.isPending ? "Submitting…" : "Submit count"}
                  </button>
                )}
              </div>
            </form>
          </>
        )}
      </QueryState>
    </>
  );
}

function MovementRows({ rows }: { rows: StockMovement[] }) {
  return rows.length ? <div>{rows.map((m) => <div key={m.id} className="flex items-center gap-3 border-b border-border/70 px-5 py-3.5 last:border-0"><div className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${m.quantityDelta < 0 ? 'bg-[#f5e8de] text-[#a65339]' : 'bg-[#e5eee6] text-primary'}`}>{m.quantityDelta < 0 ? <ArrowDownRight size={16}/> : <ArrowUpRight size={16}/>}</div><div className="min-w-0 flex-1"><div className="truncate text-xs font-bold">{m.productName}</div><div className="mt-1 truncate text-[10px] text-muted-foreground">{titleCase(m.type)}{m.sectionName ? ` · ${m.sectionName}` : ''}{m.otherOutletName ? ` · ${m.otherOutletName}` : ''}{m.transferReference ? ` · ${m.transferReference}` : ''} · {m.reason} · {m.actor}</div></div><div className="text-right"><div className={`mono text-xs font-medium ${m.quantityDelta < 0 ? 'text-[#a65339]' : 'text-primary'}`}>{m.quantityDelta > 0 ? '+' : ''}{m.quantityDelta}</div><div className="mt-1 text-[9px] text-muted-foreground">{timeText(m.occurredAt)}</div></div></div>)}</div> : <EmptyState title="No movements yet" detail="Receipts, adjustments, transfers, and count changes will show up here."/>;
}
function ActivityPage() {
  const [productId, setProductId] = useState(''); const productsQ = useListProducts({}, { query: { queryKey: getListProductsQueryKey({}) } }); const params = { ...(productId ? { productId: Number(productId) } : {}), limit: 100 };
  const query = useListStockMovements(params, { query: { queryKey: getListStockMovementsQueryKey(params) } });
  return <><PageHeading eyebrow="Inventory trail" title="Activity" subtitle="A clear record of what changed, when, and who recorded it."/><div className="panel mb-4 flex items-center gap-3 p-3"><Filter size={15} className="ml-1 text-muted-foreground"/><select className="field max-w-sm" value={productId} onChange={(e) => setProductId(e.target.value)}><option value="">All products</option>{(productsQ.data || []).map((p) => <option value={p.id} key={p.id}>{p.name}</option>)}</select><span className="ml-auto hidden text-[10px] text-muted-foreground sm:block">Showing latest 100</span></div><section className="panel overflow-hidden"><QueryState loading={query.isLoading} error={query.isError} retry={() => void query.refetch()} hasRows={(query.data || []).length > 0} empty={<EmptyState title="Nothing in the trail yet" detail="Your inventory audit trail will fill in as stock changes are recorded."/>}><MovementRows rows={query.data || []}/></QueryState></section></>;
}
function Team() {
  const qc = useQueryClient();
  const query = useListStoreUsers({ query: { queryKey: getListStoreUsersQueryKey(), refetchOnMount: 'always', refetchInterval: 30_000 } });
  const currentUser = useGetCurrentUser({ query: { queryKey: getGetCurrentUserQueryKey() } });
  const update = useUpdateStoreUserRole();
  const addMember = useAddStoreMember();
  const invitationsQuery = useListStoreInvitations({ query: { queryKey: getListStoreInvitationsQueryKey(), enabled: ['owner', 'admin', 'supervisor'].includes(currentUser.data?.role ?? ''), refetchOnMount: 'always', refetchInterval: 30_000 } });
  const createInvitation = useCreateStoreInvitation();
  const revokeInvitation = useRevokeStoreInvitation();
  const [email, setEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [role, setRole] = useState<UserRole>('staff');
  const [inviteRole, setInviteRole] = useState<UserRole>('staff');
  const users = query.data || [];
  const canInvite = ['owner', 'admin', 'supervisor'].includes(currentUser.data?.role ?? '');
  const canManageRoles = currentUser.data?.role === 'owner' || currentUser.data?.role === 'admin';
  function changeRole(user: StoreUser, nextRole: UserRole) {
    update.mutate({ userId: user.id, data: { role: nextRole } }, {
      onSuccess: () => {
        toast.success(`${user.name} is now ${nextRole}`);
        void qc.invalidateQueries({ queryKey: getListStoreUsersQueryKey() });
        void qc.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() });
      },
      onError: (error) => toast.error(error.message || 'Could not update role'),
    });
  }
  function submitMember(event: FormEvent) {
    event.preventDefault();
    addMember.mutate({ data: { email: email.trim(), role } }, {
      onSuccess: (member) => {
        setEmail('');
        toast.success(`${member.name} added to this outlet`);
        void qc.invalidateQueries({ queryKey: getListStoreUsersQueryKey() });
      },
      onError: (error) => toast.error(error.message || 'Could not add team member'),
    });
  }
  function submitInvitation(event: FormEvent) {
    event.preventDefault();
    createInvitation.mutate({ data: { name: inviteName.trim(), email: inviteEmail.trim(), role: inviteRole } }, {
      onSuccess: (invitation) => {
        setInviteName('');
        setInviteEmail('');
        toast.success(`Invitation sent to ${invitation.email}`);
        void qc.invalidateQueries({ queryKey: getListStoreInvitationsQueryKey() });
      },
      onError: (error) => toast.error(error.message || 'Could not send invitation'),
    });
  }
  function revokeInvite(invitation: StoreInvitation) {
    if (!window.confirm(`Revoke the invitation for ${invitation.email}?`)) return;
    revokeInvitation.mutate({ invitationId: invitation.id }, {
      onSuccess: () => {
        toast.success(`Invitation for ${invitation.email} revoked`);
        void qc.invalidateQueries({ queryKey: getListStoreInvitationsQueryKey() });
      },
      onError: (error) => {
        toast.error(error.message || 'Could not revoke invitation');
        void qc.invalidateQueries({ queryKey: getListStoreInvitationsQueryKey() });
      },
    });
  }
  return <>
    <PageHeading eyebrow="Outlet access" title="Team" subtitle="Each outlet has its own team and roles."/>
    {canInvite && <section className="panel mb-5 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-sm font-extrabold">Invite a teammate</h2><p className="mt-1 text-[11px] text-muted-foreground">We’ll email them a sign-up invitation. They set their own password and can update their name later.</p></div>
        <Pill>{users.length} people</Pill>
      </div>
      <form onSubmit={submitInvitation} className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_170px_auto]">
        <input className="field" type="text" required minLength={1} maxLength={120} placeholder="Teammate name" value={inviteName} onChange={(e) => setInviteName(e.target.value)}/>
        <input className="field" type="email" required placeholder="Email address" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)}/>
        <select className="field" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as UserRole)}><option value="staff">Staff</option>{canManageRoles && <><option value="supervisor">Manager</option><option value="admin">Admin</option></>}</select>
        <button className="btn btn-primary" type="submit" disabled={createInvitation.isPending}><Plus size={15}/>{createInvitation.isPending ? 'Sending…' : 'Send invitation'}</button>
      </form>
    </section>}
    {canInvite && <section className="panel mb-5 overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-5 py-4"><div><h2 className="text-sm font-extrabold">Invitations</h2><p className="mt-1 text-[11px] text-muted-foreground">Pending invitations apply only to this outlet.</p></div><Pill>{(invitationsQuery.data || []).filter((invite) => invite.status === 'pending').length} pending</Pill></div>
      <QueryState loading={invitationsQuery.isLoading} error={invitationsQuery.isError} retry={() => void invitationsQuery.refetch()} hasRows={(invitationsQuery.data || []).length > 0} empty={<EmptyState title="No invitations sent" detail="Invitations you send to new teammates will appear here."/>}>
        {(invitationsQuery.data || []).map((invitation) => {
          const statusTone = invitation.status === 'accepted' ? 'good' : invitation.status === 'pending' ? 'warn' : invitation.status === 'revoked' ? 'bad' : 'neutral';
          return <div key={invitation.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-border/75 px-5 py-4 last:border-0">
            <div className="min-w-0"><div className="truncate text-xs font-extrabold">{invitation.email}</div><div className="mt-1 text-[10px] text-muted-foreground">{titleCase(invitation.role)} · Sent {dateText(invitation.createdAt)} · Expires {dateText(invitation.expiresAt)}</div></div>
            <div className="flex items-center gap-3"><Pill tone={statusTone}>{titleCase(invitation.status)}</Pill>{invitation.status === 'pending' && <button className="btn btn-soft px-3 py-2 text-xs" type="button" disabled={revokeInvitation.isPending} onClick={() => revokeInvite(invitation)}>Revoke</button>}</div>
          </div>;
        })}
      </QueryState>
    </section>}
    {canInvite && <section className="panel mb-5 p-5">
      <div><h2 className="text-sm font-extrabold">Add an existing account</h2><p className="mt-1 text-[11px] text-muted-foreground">For someone who already has a ZUS Stock Count account. Access is limited to this outlet.</p></div>
      <form onSubmit={submitMember} className="mt-4 grid gap-3 sm:grid-cols-[1fr_170px_auto]">
        <input className="field" type="email" required placeholder="Registered account email" value={email} onChange={(e) => setEmail(e.target.value)}/>
        <select className="field" value={role} onChange={(e) => setRole(e.target.value as UserRole)}><option value="staff">Staff</option>{canManageRoles && <><option value="supervisor">Manager</option><option value="admin">Admin</option></>}</select>
        <button className="btn btn-soft" type="submit" disabled={addMember.isPending}><Plus size={15}/>{addMember.isPending ? 'Adding…' : 'Add account'}</button>
      </form>
    </section>}
    {!canInvite && <p className="panel mb-5 p-5 text-xs text-muted-foreground">Ask an owner or manager to add a teammate to this outlet.</p>}
    <div className="mb-5 grid gap-4 sm:grid-cols-[1.2fr_.8fr]">
      <div className="panel bg-[#101d79] p-5 text-[#f7f4eb]"><div className="mono text-[9px] uppercase tracking-[.17em] text-white/50">Role guide</div><div className="mt-3 grid gap-3 sm:grid-cols-3">{[['Staff','Counts stock and requests top-ups.'],['Manager','Reviews requests, records deliveries, and can add staff.'],['Admin','Manages roles and catalogue setup.']].map(([name,desc])=><div key={name} className="rounded-xl bg-white/[.07] p-3"><div className="text-xs font-extrabold text-[#edc263]">{name}</div><div className="mt-1.5 text-[10px] leading-4 text-white/65">{desc}</div></div>)}</div></div>
      <div className="panel flex items-center gap-4 p-5"><div className="grid h-12 w-12 place-items-center rounded-2xl bg-[#f1ead8] text-[#8b641e]"><ShieldCheck size={21}/></div><div><div className="text-xs font-extrabold">Access is scoped to this outlet</div><div className="mt-1 text-[11px] leading-5 text-muted-foreground">Team changes here do not affect the same people in other outlets.</div></div></div>
    </div>
    <section className="panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-5 py-4"><div><h2 className="text-sm font-extrabold">Current outlet team</h2><p className="mt-1 text-[11px] text-muted-foreground">People who can access this inventory.</p></div><Pill>{users.length} people</Pill></div>
      <QueryState loading={query.isLoading} error={query.isError} retry={() => void query.refetch()} hasRows={users.length > 0} empty={<EmptyState title="No team members found" detail="Invite a teammate or add an existing account to give it access to this outlet."/>}>
        {users.map((member) => <div key={member.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-border/75 px-5 py-4 last:border-0">
          <div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-full bg-[#e8eee7] text-xs font-extrabold text-primary">{member.name.split(' ').map((part) => part[0]).slice(0,2).join('')}</div><div><div className="text-xs font-extrabold">{member.name}</div><div className="mt-1 text-[10px] text-muted-foreground">{member.email}</div></div></div>
          <div className="flex items-center gap-3"><span className="hidden text-[10px] text-muted-foreground sm:inline">{member.storeName}</span>{member.role === 'owner' ? <Pill tone="good">Owner</Pill> : <select className="field w-36 py-2 text-xs" aria-label={`Role for ${member.name}`} value={member.role} disabled={!canManageRoles || update.isPending} onChange={(e) => changeRole(member, e.target.value as UserRole)}><option value="staff">Staff</option><option value="supervisor">Manager</option><option value="admin">Admin</option></select>}</div>
        </div>)}
      </QueryState>
    </section>
  </>;
}
function OutletsPage() {
  const qc = useQueryClient();
  const { data: user, isLoading, isError, refetch } = useGetCurrentUser({ query: { queryKey: getGetCurrentUserQueryKey() } });
  const createOutlet = useCreateOutlet();
  const updateOutlet = useUpdateOutlet();
  const [name, setName] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingOutletId, setEditingOutletId] = useState<number | null>(null);
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [businessAddress, setBusinessAddress] = useState('');
  const [selectedOutletId, setSelectedOutletId] = useState<number | undefined>();
  const isOwner = Boolean(user?.workspace?.isOwner);
  const canManageOutletDetails = isOwner || Boolean(user?.outlets?.some((outlet) => outlet.role === 'supervisor'));
  useEffect(() => setEditingOutletId(null), [selectedOutletId]);
  useEffect(() => {
    if (user?.activeOutletId) setSelectedOutletId((current) => current ?? user.activeOutletId);
  }, [user?.activeOutletId]);
  useEffect(() => {
    const handleOutletChange = (event: Event) => setSelectedOutletId((event as CustomEvent<number>).detail);
    window.addEventListener('zus-active-outlet-change', handleOutletChange);
    return () => window.removeEventListener('zus-active-outlet-change', handleOutletChange);
  }, []);
  function submit(event: FormEvent) {
    event.preventDefault();
    const outletName = name.trim();
    if (!outletName) return;
    createOutlet.mutate({ data: { name: outletName } }, {
      onSuccess: (outlet) => {
        activateOutlet(outlet.id);
        void qc.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() });
        qc.removeQueries({ predicate: (query) => {
          const key = query.queryKey[0];
          return typeof key === 'string' && key.startsWith('/api/') && key !== '/api/me' && key !== '/api/healthz';
        } });
        toast.success(`${outlet.name} added`);
        setName('');
        setShowForm(false);
      },
      onError: (error) => toast.error(error.message || 'Could not add outlet'),
    });
  }
  function editOutlet(outlet: NonNullable<typeof user>['outlets'][number]) {
    setEditingOutletId(outlet.id);
    setContactEmail(outlet.contactEmail || '');
    setContactPhone(outlet.contactPhone || '');
    setBusinessAddress(outlet.businessAddress || '');
  }
  function saveOutletDetails(event: FormEvent<HTMLFormElement>, outletId: number) {
    event.preventDefault();
    updateOutlet.mutate({
      outletId,
      data: {
        contactEmail: contactEmail.trim() || null,
        contactPhone: contactPhone.trim() || null,
        businessAddress: businessAddress.trim() || null,
      },
    }, {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() });
        toast.success('Outlet details saved');
        setEditingOutletId(null);
      },
      onError: (error) => toast.error(error.message || 'Could not save outlet details'),
    });
  }
  if (!isLoading && !canManageOutletDetails) return <><PageHeading eyebrow="Workspace" title="Outlets" subtitle="Outlet details are available to outlet managers and workspace owners."/><div className="panel p-6 text-sm text-muted-foreground">Ask your outlet manager or workspace owner to update location details.</div></>;
  return <>
    <PageHeading eyebrow={isOwner ? "Workspace · Locations" : "Assigned location"} title={isOwner ? "Your outlets" : "Outlet details"} subtitle={isOwner ? "Each café runs its own stock, counts, and team." : "Update contact and address details for your assigned outlet."} action={isOwner ? <button className="btn btn-primary" data-testid="button-add-outlet" onClick={() => setShowForm((open) => !open)}><Plus size={16}/>{showForm ? 'Close form' : 'Add outlet'}</button> : undefined}/>
    {isOwner && showForm && <form onSubmit={submit} className="panel mb-5 flex flex-col gap-3 p-5 sm:flex-row sm:items-end" data-testid="form-create-outlet">
      <label className="flex-1 text-xs font-bold text-foreground">Outlet name<input className="field mt-2" data-testid="input-outlet-name" maxLength={80} required autoFocus placeholder="e.g. Bangsar South" value={name} onChange={(event) => setName(event.target.value)}/></label>
      <button type="submit" className="btn btn-primary" data-testid="button-submit-outlet" disabled={createOutlet.isPending || !name.trim()}>{createOutlet.isPending ? 'Adding outlet…' : 'Create outlet'}</button>
    </form>}
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4"><div><h2 className="text-sm font-extrabold">Workspace locations</h2><p className="mt-1 text-[11px] text-muted-foreground">{user?.workspace?.name || 'Your workspace'} · outlet access stays separate</p></div><Pill>{user?.outlets?.length ?? 0} outlets</Pill></div>
      <QueryState loading={isLoading} error={isError} retry={() => void refetch()} hasRows={(user?.outlets?.length ?? 0) > 0} empty={<EmptyState title="Your first outlet starts here" detail="Add a location to give its stock and team a dedicated place to work." action={isOwner ? <button className="btn btn-primary" onClick={() => setShowForm(true)} data-testid="button-create-first-outlet"><Plus size={15}/> Add an outlet</button> : undefined}/>}>
        <div className="divide-y divide-border/70">{user?.outlets?.map((outlet, index) => {
          const active = (selectedOutletId ?? user.activeOutletId) === outlet.id;
          const canEditDetails = isOwner || (outlet.role === 'supervisor' && active);
          return <div key={outlet.id} data-testid={`outlet-row-${outlet.id}`} className="px-5 py-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-4"><div className={`grid h-12 w-12 place-items-center rounded-2xl ${active ? 'bg-primary text-primary-foreground' : 'bg-[#f0e9d9] text-primary'}`}><Building2 size={20}/></div><div><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-extrabold" data-testid={`text-outlet-name-${outlet.id}`}>{outlet.name}</h3>{active && <Pill tone="good">Active outlet</Pill>}</div><div className="mt-1 text-xs text-muted-foreground">{titleCase(outlet.role)} access <span className="mx-1.5 text-border">·</span> Location {String(index + 1).padStart(2, '0')}</div></div></div>
              <div className="flex flex-wrap items-center gap-2">
                {active ? <span className="mono text-[10px] font-medium uppercase tracking-[.12em] text-primary">Current location</span> : <button className="btn btn-soft" data-testid={`button-switch-outlet-${outlet.id}`} onClick={() => { activateOutlet(outlet.id); qc.removeQueries({ predicate: (query) => { const key = query.queryKey[0]; return typeof key === 'string' && key.startsWith('/api/') && key !== '/api/me' && key !== '/api/healthz'; } }); toast.success(`Switched to ${outlet.name}`); }}>Switch outlet</button>}
                {canEditDetails && <button type="button" className="btn btn-ghost" data-testid={`button-edit-outlet-${outlet.id}`} onClick={() => editingOutletId === outlet.id ? setEditingOutletId(null) : editOutlet(outlet)}>{editingOutletId === outlet.id ? 'Close details' : 'Edit details'}</button>}
              </div>
            </div>
            <div className="mt-4 grid gap-2 rounded-xl bg-muted/35 p-3 text-xs sm:grid-cols-3">
              <p className="truncate"><span className="font-bold">Email:</span> {outlet.contactEmail || 'Not added'}</p>
              <p className="truncate"><span className="font-bold">Phone:</span> {outlet.contactPhone || 'Not added'}</p>
              <p className="whitespace-pre-line sm:col-span-3"><span className="font-bold">Address:</span> {outlet.businessAddress || 'Not added'}</p>
            </div>
            {editingOutletId === outlet.id && canEditDetails && <form onSubmit={(event) => saveOutletDetails(event, outlet.id)} className="mt-4 grid gap-3 rounded-xl border border-border p-4 sm:grid-cols-2" data-testid={`form-outlet-details-${outlet.id}`}>
              <label className="text-xs font-bold">Outlet contact email<input className="field mt-2" data-testid={`input-outlet-email-${outlet.id}`} type="email" maxLength={320} value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} placeholder="cafe@example.com"/></label>
              <label className="text-xs font-bold">Outlet contact phone<input className="field mt-2" data-testid={`input-outlet-phone-${outlet.id}`} type="tel" maxLength={40} value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} placeholder="+60…"/></label>
              <label className="text-xs font-bold sm:col-span-2">Outlet address<textarea className="field mt-2 min-h-20 resize-y" data-testid={`input-outlet-address-${outlet.id}`} maxLength={500} value={businessAddress} onChange={(event) => setBusinessAddress(event.target.value)} placeholder="Street, city, state, postcode"/></label>
              <div className="flex justify-end gap-2 sm:col-span-2"><button type="button" className="btn btn-soft" onClick={() => setEditingOutletId(null)}>Cancel</button><button type="submit" className="btn btn-primary" data-testid={`button-save-outlet-${outlet.id}`} disabled={updateOutlet.isPending}>{updateOutlet.isPending ? 'Saving…' : 'Save outlet details'}</button></div>
            </form>}
          </div>;
        })}</div>
      </QueryState>
    </section>
    <div className="mt-5 grid gap-4 md:grid-cols-[1.1fr_.9fr]"><div className="rounded-2xl bg-[#101d79] p-5 text-[#f8f7f1]"><div className="mono text-[9px] uppercase tracking-[.16em] text-white/55">Separate by design</div><h2 className="mt-2 text-lg font-extrabold">One workspace. Independent outlets.</h2><p className="mt-2 max-w-xl text-xs leading-5 text-white/65">Stock levels, purchase activity, counts, and outlet team access follow the selected location, keeping every café’s operations clear.</p></div><div className="panel flex items-start gap-3 p-5"><div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#f2ead9] text-primary"><ShieldCheck size={17}/></div><div><div className="text-xs font-extrabold">{isOwner ? 'Owner-managed locations' : 'Assigned outlet details'}</div><p className="mt-1 text-[11px] leading-5 text-muted-foreground">{isOwner ? 'Create an outlet when your business is ready to bring another café into the workspace.' : 'Your updates apply only to the outlet assigned to your manager role.'}</p></div></div></div>
  </>;
}
function WorkspaceSettingsPage() {
  const qc = useQueryClient();
  const { data: user, isLoading, isError, refetch } = useGetCurrentUser({ query: { queryKey: getGetCurrentUserQueryKey() } });
  const updateWorkspace = useUpdateWorkspace();
  const [name, setName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [businessAddress, setBusinessAddress] = useState('');
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (user?.workspace && !initialized) {
      setName(user.workspace.name);
      setContactEmail(user.workspace.contactEmail || '');
      setContactPhone(user.workspace.contactPhone || '');
      setBusinessAddress(user.workspace.businessAddress || '');
      setInitialized(true);
    }
  }, [user?.workspace, initialized]);
  function submit(event: FormEvent) {
    event.preventDefault();
    const workspaceName = name.trim();
    if (!workspaceName) return;
    updateWorkspace.mutate({ data: {
      name: workspaceName,
      contactEmail: contactEmail.trim() || null,
      contactPhone: contactPhone.trim() || null,
      businessAddress: businessAddress.trim() || null,
    } }, {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() });
        toast.success('Workspace profile updated');
      },
      onError: (error) => toast.error(error.message || 'Could not update workspace'),
    });
  }
  const profileChanged = Boolean(user?.workspace && (
    name.trim() !== user.workspace.name ||
    (contactEmail.trim() || null) !== user.workspace.contactEmail ||
    (contactPhone.trim() || null) !== user.workspace.contactPhone ||
    (businessAddress.trim() || null) !== user.workspace.businessAddress
  ));
  if (!isLoading && !user?.workspace?.isOwner) return <><PageHeading eyebrow="Workspace" title="Settings" subtitle="Workspace settings are available to the owner."/><div className="panel p-6 text-sm text-muted-foreground">Ask your workspace owner to update these details.</div></>;
  return <>
    <PageHeading eyebrow="Workspace · Business profile" title="Workspace settings" subtitle="Keep your business contact details consistent across every outlet."/>
    <QueryState loading={isLoading} error={isError} retry={() => void refetch()}>
      <div className="grid gap-5 lg:grid-cols-[1fr_.7fr]">
        <form onSubmit={submit} className="panel p-5 sm:p-7" data-testid="form-workspace-settings">
          <div className="flex items-start gap-4 border-b border-border pb-5"><div className="grid h-12 w-12 place-items-center rounded-2xl bg-[#f0e7d5] text-primary"><Settings size={21}/></div><div><h2 className="text-base font-extrabold">Business information</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">These details belong to your workspace, not an individual outlet.</p></div></div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="text-xs font-bold sm:col-span-2">Business / workspace name<input className="field mt-2" data-testid="input-workspace-name" maxLength={80} minLength={1} required value={name} onChange={(event) => setName(event.target.value)} placeholder="Your business name"/></label>
            <label className="text-xs font-bold">Business email <span className="font-normal text-muted-foreground">optional</span><input className="field mt-2" data-testid="input-workspace-contact-email" type="email" maxLength={320} value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} placeholder="hello@example.com"/></label>
            <label className="text-xs font-bold">Business phone <span className="font-normal text-muted-foreground">optional</span><input className="field mt-2" data-testid="input-workspace-contact-phone" type="tel" maxLength={40} value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} placeholder="+60…"/></label>
            <label className="text-xs font-bold sm:col-span-2">Business address <span className="font-normal text-muted-foreground">optional</span><textarea className="field mt-2 min-h-24 resize-y" data-testid="input-workspace-business-address" maxLength={500} value={businessAddress} onChange={(event) => setBusinessAddress(event.target.value)} placeholder="Street, city, state, postcode"/></label>
          </div>
          <div className="mt-6 flex justify-end"><button className="btn btn-primary" type="submit" data-testid="button-save-workspace" disabled={updateWorkspace.isPending || !name.trim() || !profileChanged}>{updateWorkspace.isPending ? 'Saving…' : 'Save business profile'}</button></div>
        </form>
        <aside className="rounded-2xl bg-[#f0eadc] p-5 sm:p-6"><div className="mono text-[9px] uppercase tracking-[.16em] text-[#7b6846]">Your workspace</div><div className="mt-3 flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-xl bg-[#101d79] text-[#f7f4eb]"><Building2 size={19}/></div><div className="min-w-0"><div className="truncate text-sm font-extrabold" data-testid="text-workspace-name">{user?.workspace?.name}</div><div className="mt-1 text-[10px] text-muted-foreground">Owner-managed business profile</div></div></div><div className="mt-4 space-y-2 rounded-xl bg-[#fbfaf6] p-3 text-xs"><p className="truncate"><span className="font-bold">Email:</span> {user?.workspace?.contactEmail || 'Not added'}</p><p className="truncate"><span className="font-bold">Phone:</span> {user?.workspace?.contactPhone || 'Not added'}</p><p className="line-clamp-3 whitespace-pre-line"><span className="font-bold">Address:</span> {user?.workspace?.businessAddress || 'Not added'}</p></div><div className="mt-3 grid grid-cols-2 gap-3"><div className="rounded-xl bg-[#fbfaf6] p-3"><div className="mono text-[9px] uppercase tracking-wide text-muted-foreground">Outlets</div><div className="mt-1 text-xl font-extrabold" data-testid="text-workspace-outlet-count">{user?.outlets?.length ?? 0}</div></div><div className="rounded-xl bg-[#fbfaf6] p-3"><div className="mono text-[9px] uppercase tracking-wide text-muted-foreground">Access</div><div className="mt-1 text-xs font-extrabold">Owner</div></div></div><Link href="/outlets" className="btn btn-ghost mt-4 w-full justify-between text-xs" data-testid="link-manage-outlets">Manage outlets <ArrowRight size={14}/></Link></aside>
      </div>
    </QueryState>
  </>;
}
function AccountPage() {
  return <>
    <PageHeading eyebrow="Personal settings" title="My account" subtitle="Update your profile and sign-in details. Your outlet role is managed separately by the team."/>
    <section className="panel flex justify-center overflow-hidden p-4 sm:p-6">
      <UserProfile routing="path" path={`${basePath}/account`}/>
    </section>
  </>;
}
function NotFound() {
  return <div className="grid min-h-[100dvh] place-items-center bg-background px-5"><div className="max-w-lg text-center"><div className="mx-auto mb-7 w-fit"><Brand/></div><div className="mono text-xs tracking-[.2em] text-primary">404 · NOT ON THE SHELF</div><h1 className="zus-title mt-4 text-5xl font-bold">This page took<br/>a wrong turn.</h1><p className="mt-4 text-sm text-muted-foreground">That address doesn’t lead to a stockroom view. Head back and keep the shift moving.</p><Link href="/" className="btn btn-primary mt-7"><ArrowRight className="rotate-180" size={15}/> Back to stockroom</Link></div></div>;
}
function AppRoutes() {
  const [, setLocation] = useLocation();
  return <Switch>
    <Route path="/" component={HomeRedirect}/>
    <Route path="/sign-in/*?" component={SignInPage}/>
    <Route path="/sign-up/*?" component={SignUpPage}/>
    <Route path="/workspace-setup"><Protected><WorkspaceSetupPage/></Protected></Route>
    <Route path="/dashboard"><Protected><ContentShell title="Store overview"><Dashboard/></ContentShell></Protected></Route>
    <Route path="/products"><Protected><ContentShell title="Product catalogue"><Products/></ContentShell></Protected></Route>
    <Route path="/catalogue-settings"><Protected><ContentShell title="Categories & storage"><CatalogueSettings/></ContentShell></Protected></Route>
    <Route path="/suppliers"><Protected><ContentShell title="Suppliers"><Suppliers/></ContentShell></Protected></Route>
    <Route path="/inventory"><Protected><ContentShell title="Inventory"><Inventory/></ContentShell></Protected></Route>
    <Route path="/stock-transfers"><Protected><ContentShell title="Stock transfers"><StockTransfersPage/></ContentShell></Protected></Route>
    <Route path="/orders"><Protected><ContentShell title="Orders"><Orders/></ContentShell></Protected></Route>
    <Route path="/deliveries"><Protected><ContentShell title="Deliveries"><Deliveries/></ContentShell></Protected></Route>
    <Route path="/counts"><Protected><ContentShell title="Stock counts"><Counts/></ContentShell></Protected></Route>
    <Route path="/counts/:countId"><Protected><ContentShell title="Count session"><CountDetail/></ContentShell></Protected></Route>
    <Route path="/activity"><Protected><ContentShell title="Activity"><ActivityPage/></ContentShell></Protected></Route>
    <Route path="/team"><Protected><ContentShell title="Team"><Team/></ContentShell></Protected></Route>
    <Route path="/outlets"><Protected><ContentShell title="Outlets"><OutletsPage/></ContentShell></Protected></Route>
    <Route path="/account/*?"><Protected><ContentShell title="My account"><AccountPage/></ContentShell></Protected></Route>
    <Route path="/settings"><Protected><ContentShell title="Workspace settings"><WorkspaceSettingsPage/></ContentShell></Protected></Route>
    <Route><NotFound/></Route>
  </Switch>;
}
function ClerkRouter() {
  const [, setLocation] = useLocation();
  return <ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={clerkAppearance} signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`}
    localization={{ signIn: { start: { title: 'Welcome back', subtitle: 'Sign in to record and check today’s deliveries.' } }, signUp: { start: { title: 'Create your workspace', subtitle: 'You’ll be the owner. Add your managers and staff after setup.' } } }}
    routerPush={(to: string) => setLocation(stripBase(to))} routerReplace={(to: string) => setLocation(stripBase(to), { replace: true })}>
    <QueryClientProvider client={queryClient}><AppRoutes/><Toaster richColors position="top-right"/></QueryClientProvider>
  </ClerkProvider>;
}
function App() { return <WouterRouter base={basePath}><ClerkRouter/></WouterRouter>; }
export default App;
