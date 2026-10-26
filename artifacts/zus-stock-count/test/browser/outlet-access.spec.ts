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
  await expect(page.getByTestId('link-nav-outlets')).toBeVisible();
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
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByTestId('form-workspace-settings')).toHaveCount(0);
  await expect(page.getByTestId('input-workspace-contact-email')).toHaveCount(0);
});

test('workspace owner can rename any outlet and the new name appears in the list and active-outlet selector', async ({ page }) => {
  await mockApi(page, 'owner');

  await page.goto('/outlets');
  await expect(page.getByRole('heading', { name: 'Your outlets' })).toBeVisible();
  await expect(page.getByTestId('link-nav-outlets')).toBeVisible();
  await expect(page.getByTestId('link-nav-workspace-settings')).toBeVisible();

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

  await page.getByTestId('link-nav-workspace-settings').click();
  await expect(page.getByTestId('form-workspace-settings')).toBeVisible();
  await expect(page.getByTestId('input-workspace-contact-email')).toHaveValue('business@example.com');
});
