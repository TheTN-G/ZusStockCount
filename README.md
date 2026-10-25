# Zus Store Stock

Phone-friendly stock, expiry, and ordering workflows for ZUS store teams. This repository is based on the existing ASP.NET Core application and borrows SOPBox's practical patterns—clear role-based actions, guided receiving/counting, and traceable stock changes—without copying its AI services. **There are no AI, OCR, or model-provider integrations in this app.**

## What it does

- Track products by category, storage zone, bundle size, reorder threshold, and expiry policy.
- Maintain stock by expiry batch; flag low, expired, and soon-to-expire products.
- Record stock additions, usage, and stocktake adjustments in an item activity history.
- Create store requests, approve or reject them, mark approved requests as ordered, and receive partial or complete deliveries.
- Record deliveries that arrive without a prior order.
- Run guided counts for all active products, a category, or one product; see variances and retain a count history.
- Import and export stock counts with Excel workbooks.
- Protect pages with cookie authentication, role checks, anti-forgery validation, and login rate limiting.

## Stack

- ASP.NET Core MVC on .NET 8
- Entity Framework Core 8 with SQL Server
- ClosedXML for Excel import/export
- Bootstrap 5 via jsDelivr and the existing ZUS theme

## Run locally

1. Install the .NET 8 SDK and SQL Server (or a compatible SQL Server instance).
2. Copy `appsettings.example.json` to `appsettings.json`.
3. Set `ConnectionStrings:DefaultConnection` to your development database connection string. Set `Registration:StoreCode` and `Registration:SupervisorKey` only if self-signup should be enabled; keep these values out of Git.
4. Run `dotnet restore` and `dotnet run` from this directory. The app applies checked-in EF Core migrations at startup.
5. On first launch, use the setup page to create the first Admin. Later user registrations are controlled by the registration settings.

Configuration can also be supplied using environment variables:

- `ConnectionStrings__DefaultConnection`
- `Registration__StoreCode`
- `Registration__SupervisorKey`

## Stock count flow

Open **Stock check** and choose all active stock, a category, or a single item. Enter the physical count in the product's loose unit. On save, the app records the system quantity, physical quantity, and difference; updates expiry batches using the existing first-expiry-first-out rule; updates the product's last-checked date; and writes a stock movement for every changed quantity. The count and adjustments are saved together.

The stock page also supports the existing Excel template workflow. Blank Excel rows are skipped; filled rows replace the system quantity for those products.

## Repository hygiene

Local `appsettings.json` files are ignored because they may contain database credentials or registration codes. Build output, IDE state, and generated source maps are excluded. Use `appsettings.example.json` as a starting point and keep real values in environment variables or a secrets manager.

