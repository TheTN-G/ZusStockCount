import { expect, test, type Page, type Route } from '@playwright/test';

type TestRole = 'manager' | 'owner';

const outlets = [
  {
    id: 11,
    name: 'Assigned Outlet',
    role: 'supervisor',
    contactEmail: 'assigned@example.com',
    contactPhone: '+60 1111',
    businessAddress: '11 Main Street',
  },
  {
    id: 22,
    name: 'Sibling Outlet',
    role: 'staff',
    contactEmail: 'sibling@example.com',
    contactPhone: '+60 2222',
    businessAddress: '22 Side Street',
  },
];

function currentUser(role: TestRole, outletList = outlets) {
  const isOwner = role === 'owner';
  return {
    id: isOwner ? 'owner-user' : 'manager-user',
    name: isOwner ? 'Workspace Owner' : 'Outlet Manager',
    email: `${role}@example.com`,
    role: isOwner ? 'owner' : 'supervisor',
    storeName: 'Sample Workspace',
    activeStoreroomId: 11,
    storerooms: [{ id: 11, name: 'Assigned Outlet', role: isOwner ? 'owner' : 'supervisor' }],
    activeOutletId: 11,
    workspace: {
      id: 7,
      name: 'Sample Workspace',
      contactEmail: 'business@example.com',
      contactPhone: '+60 7000',
      businessAddress: '7 Workspace Road',
      setupComplete: true,
      isOwner,
    },
    outlets: outletList.map((outlet) => ({
      ...outlet,
      role: isOwner ? 'owner' : outlet.role,
    })),
    access: {
      dashboard: 'edit',
      receiving: 'edit',
      deliveryRecords: 'edit',
      products: 'edit',
      suppliers: 'edit',
      stockTransfers: 'edit',
      purchaseOrders: 'edit',
      approvals: 'edit',
      activity: 'edit',
      stockCount: 'edit',
    },
  };
}

async function mockApi(page: Page, role: TestRole, onUpdate?: (route: Route) => Promise<void>) {
  const outletRecords = outlets.map((outlet) => ({ ...outlet }));
  await page.route('**/api/me', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(currentUser(role, outletRecords)) }),
  );
  await page.route('**/api/healthz', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok' }) }),
  );
  await page.route('**/api/outlets/**', async (route) => {
    if (route.request().method() === 'PATCH' && onUpdate) {
      await onUpdate(route);
      return;
    }
    if (route.request().method() === 'PATCH' && route.request().url().endsWith('/name')) {
      const { name } = route.request().postDataJSON() as { name: string };
      const outletId = Number(new URL(route.request().url()).pathname.split('/').at(-2));
      const outlet = outletRecords.find(({ id }) => id === outletId);
      if (outlet) outlet.name = name;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(outlet),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

test('outlet manager can edit only the active assigned outlet and cannot access owner controls', async ({ page }) => {
  let updateRequest: { url: string; body: unknown } | undefined;
  await mockApi(page, 'manager', async (route) => {
    updateRequest = {
      url: new URL(route.request().url()).pathname,
      body: route.request().postDataJSON(),
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(outlets[0]),
    });
  });

  await page.goto('/outlets');
  await expect(page.getByRole('heading', { name: 'Outlet details' })).toBeVisible();
  await page.getByRole('button', { name: 'Outlet Manager profile' }).click();
  await expect(page.getByRole('menuitem', { name: 'Manage outlets' })).toBeVisible();
  await expect(page.getByTestId('link-nav-workspace-settings')).toHaveCount(0);
  await expect(page.getByTestId('button-add-outlet')).toHaveCount(0);
  await expect(page.getByTestId('button-rename-outlet-11')).toHaveCount(0);
  await expect(page.getByTestId('button-rename-outlet-22')).toHaveCount(0);

  await expect(page.getByTestId('button-edit-outlet-11')).toBeVisible();
  await expect(page.getByTestId('button-edit-outlet-22')).toHaveCount(0);
  await page.getByTestId('button-edit-outlet-11').click();

  await page.getByTestId('input-outlet-email-11').fill('updated@example.com');
  await page.getByTestId('input-outlet-phone-11').fill('+60 3333');
  await page.getByTestId('input-outlet-address-11').fill('33 New Street');
  await page.getByTestId('button-save-outlet-11').click();

  await expect.poll(() => updateRequest).toEqual({
    url: '/api/outlets/11',
    body: {
      contactEmail: 'updated@example.com',
      contactPhone: '+60 3333',
      businessAddress: '33 New Street',
    },
  });

  await page.goto('/settings');
  await expect(page.getByRole('alert')).toContainText('This section is not available');
  await expect(page.getByTestId('form-workspace-settings')).toHaveCount(0);
  await expect(page.getByTestId('input-workspace-contact-email')).toHaveCount(0);
});

test('workspace owner can rename any outlet and the new name appears in the list and active-outlet selector', async ({ page }) => {
  await mockApi(page, 'owner');

  await page.goto('/outlets');
  await expect(page.getByRole('heading', { name: 'Your outlets' })).toBeVisible();
  await page.getByRole('button', { name: 'Workspace Owner profile' }).click();
  await expect(page.getByRole('menuitem', { name: 'Manage outlets' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Workspace settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Workspace Owner profile' }).click();

  await page.getByTestId('button-add-outlet').click();
  await expect(page.getByTestId('form-create-outlet')).toBeVisible();
  await expect(page.getByTestId('button-edit-outlet-11')).toBeVisible();
  await expect(page.getByTestId('button-edit-outlet-22')).toBeVisible();

  await page.getByTestId('button-rename-outlet-22').click();
  await page.getByTestId('input-rename-outlet-22').fill('Airport Annex');
  await page.getByTestId('button-save-outlet-name-22').click();
  await expect(page.getByTestId('text-outlet-name-22')).toHaveText('Airport Annex');
  await expect(page.getByTestId('select-active-outlet').locator('option', { hasText: 'Airport Annex' })).toBeAttached();

  await page.reload();
  await expect(page.getByTestId('text-outlet-name-22')).toHaveText('Airport Annex');
  await expect(page.getByTestId('select-active-outlet').locator('option', { hasText: 'Airport Annex' })).toBeAttached();

  await page.getByRole('button', { name: 'Workspace Owner profile' }).click();
  await page.getByRole('menuitem', { name: 'Workspace settings' }).click();
  await expect(page.getByTestId('form-workspace-settings')).toBeVisible();
  await expect(page.getByTestId('input-workspace-contact-email')).toHaveValue('business@example.com');
});

const allStaffSections = {
  dashboard: 'none',
  receiving: 'none',
  deliveryRecords: 'none',
  products: 'none',
  suppliers: 'none',
  stockTransfers: 'none',
  purchaseOrders: 'none',
  approvals: 'none',
  activity: 'none',
  stockCount: 'none',
} as const;

function staffUser(access: Record<string, string>) {
  const outlet = {
    id: 31,
    name: 'Staff Outlet',
    role: 'staff',
    contactEmail: null,
    contactPhone: null,
    businessAddress: null,
  };
  return {
    id: 'staff-user',
    name: 'Outlet Staff',
    email: 'staff@example.com',
    role: 'staff',
    storeName: outlet.name,
    activeStoreroomId: outlet.id,
    storerooms: [{ id: outlet.id, name: outlet.name, role: 'staff' }],
    activeOutletId: outlet.id,
    workspace: {
      id: 9,
      name: 'Staff Workspace',
      contactEmail: null,
      contactPhone: null,
      businessAddress: null,
      setupComplete: true,
      isOwner: false,
    },
    outlets: [outlet],
    access,
  };
}

async function mockStaffApi(page: Page, access: Record<string, string>) {
  const requests: Array<{ method: string; path: string }> = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    requests.push({ method, path });
    let body: unknown = {};
    if (path === '/api/me') body = staffUser(access);
    else if (path === '/api/healthz') body = { status: 'ok' };
    else if (path === '/api/stock-counts' || path === '/api/products' ||
      path === '/api/product-categories' || path === '/api/stock-sections') body = [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  return requests;
}

test('staff without section access cannot find it in navigation or open it directly', async ({ page }) => {
  await mockStaffApi(page, allStaffSections);
  await page.goto('/products');

  await expect(page.getByRole('alert')).toContainText('This section is not available');
  await expect(page.getByTestId('link-nav-products')).toHaveCount(0);
  await expect(page.getByTestId('link-nav-stock-counts')).toHaveCount(0);
});

test('staff with view-only count access cannot start a count from the page', async ({ page }) => {
  const requests = await mockStaffApi(page, {
    ...allStaffSections,
    stockCount: 'view',
  });
  await page.goto('/counts');

  await expect(page.getByTestId('link-nav-stock-counts')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Stock counts' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('View-only access');
  await page.getByRole('button', { name: 'Start count' }).click();
  await expect(page.getByText('Your access to this section is view-only.')).toBeVisible();
  expect(requests.filter((request) =>
    request.method === 'POST' && request.path === '/api/stock-counts',
  )).toHaveLength(0);
});
