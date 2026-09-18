# Rollbook

Rent roll and ledger for a self-managing landlord. One password, one file of data, no monthly fee.

Built for a portfolio of small buildings tracked today in per-building Excel workbooks (Income tab, Expenses tab, receipt log). Rollbook imports those workbooks, then takes over: rent posts itself each month, payments get recorded in ten seconds, and the delinquency report is always current.

## What it does

- **Who owes** — every tenant with a balance, oldest first, with 0–30 / 31–60 / 61–90 / 90+ day aging, last payment, and a one-click late-fee link. Prints cleanly and exports to Excel.
- **Units** — a board of every unit in every building, colored by status (paid, partial, owes, vacant). Tap a unit for its ledger and to record a payment by cash, check, Zelle, Venmo, bank transfer, card, RentRedi, or money order.
- **Ledger per unit** — charges and payments with a running balance. Balances are computed, never typed, so they cannot drift.
- **Leases** — end dates soonest first, with the ones inside 90 days flagged.
- **Expenses** — a real chart of accounts (Mortgage, Property tax, Insurance, Utilities, Repairs & maintenance, Capital improvements, Supplies, Cleaning, Legal & professional, Management & admin, Advertising, Other), filterable by building, month, year, category.
- **Work orders** — log a repair when a tenant calls; marking it done can post the cost straight to Expenses.
- **Reports** — year at a glance: received vs. spent per building, month by month, and by category, with capital improvements broken out for the accountant.
- **Import** — drop a workbook in the existing layout. It is read in the browser, previewed, and only saved when confirmed. Re-importing the same file adds nothing twice.
- **Export** — the same building workbook layout (Income / Expenses / Summary / Receipts) filled from the ledger, plus rent roll, who-owes, year-end, and all-expenses spreadsheets. Built in the browser; nothing is sent anywhere.
- **Backup** — download the whole database as one file.
- **Demo mode** — a fake three-building portfolio for showing the app; cleared with one button and never mixed with real buildings.

## Requirements

Node 22.13 or newer. Nothing else: no `npm install`, no database server. SQLite is built into Node.

## Run it on your own computer

```
node server.js
```

Open http://localhost:3000. The first visit asks you to set a password. Data lives in `./data/rollbook.sqlite`.

Run the test suite (boots a throwaway copy and walks every workflow over HTTP):

```
npm test
```

## Deploy on Render

Two ways. Either one reads `render.yaml`, which sets up a web service with a 1 GB persistent disk at `/var/data` and `DATA_DIR=/var/data`. The disk is what makes the data survive deploys and restarts; do not remove it.

**One-click, for the owner (recommended).** Host this folder in a public GitHub repository, then give her the link `https://render.com/deploy?repo=<repository URL>`. She signs in to her own Render account, clicks Apply, and the app is hers. Updates: she clicks **Manual Deploy → Deploy latest commit** on the service. See `SETUP-GUIDE.md`.

**From your own account.** **New → Blueprint**, pick the repository, Apply.

Either way, the first visit to the service URL goes to `/setup`: choose the password, name the portfolio, and decide whether to start with demo data. There is one account by design.

`render.yaml` pins Node 22.22.2 via `NODE_VERSION` and sets `autoDeploy: false`. The Starter plan ($7/month) is required for a persistent disk; the free plan has none.

To move the data later: download a backup from **Export → Download backup**, and place that file at `DATA_DIR/rollbook.sqlite` on the new host before starting.

## The owner's workflow

**First week.** Import each building's workbook from Import. For each file: check the building name and year, type the unit number for every tenant row, save. Fourteen buildings is fourteen drops. Then open Settings and set the rent due day, grace period, and late fee.

**When a payment arrives.** Units → tap the unit → the amount is pre-filled with what they owe → pick how they paid → Record payment. Or start from Who owes and use the Record payment link on the row.

**Start of the month.** Open Who owes. Rent for the new month has already posted to every active tenant, so anyone who has not paid is listed. Print it or export it.

**When a lease turns over.** Unit page → Move out (the ledger is kept, the unit shows vacant) → Move someone in. Rent starts posting from the month chosen.

**When something breaks.** Work orders → New. When it is fixed, Mark done and the cost goes to Expenses under the right category.

**Tax time.** Reports → pick the year → Excel, or Export → Year-end by building.

## How imported numbers are read

- One workbook = one building, one year. The year comes from the filename (`..._2026.xlsx`) and can be corrected on the preview.
- Each tenant row on the Income tab becomes a unit and an active tenancy. The lease text ("5-1-25 to 4-20-26") is parsed into start and end dates when it can be; the original text is kept either way.
- Rent is charged from the first month that has money in it (a tenant who moved in mid-year is not shown as owing for months before that). Each month with money becomes one payment, dated the rent due day, marked as coming from the workbook.
- Expenses tab lines become one expense per month, mapped onto the chart of accounts by name (the "Mortgage" under Repairs & Maintenance lands under Mortgage, "Property Tax" under Property tax, and so on).
- Receipt-log rows become individual expenses with their real dates. For any month the receipt log covers, the hand-typed "Supplies" total for that month is skipped so purchases are not counted twice; months without receipts keep their Supplies figure.
- "Other" income rows (e.g. laundry) are not imported; add them as a unit if they belong in the ledger.

Every guessed category can be changed under Expenses.

## Privacy and safety

- The workbook is parsed in the owner's browser. The server only ever sees the rows she confirms.
- No third-party services, analytics, or fonts other than Google Fonts for the typefaces (the app works without them).
- Sessions are 30-day signed cookies; the password is hashed with scrypt; every form carries a CSRF token; eight wrong passwords in ten minutes locks that address out for ten minutes.
- Nothing is deleted without a confirmation page, and "Clear demo data" only ever touches buildings flagged as demo.
- Late fees are never added automatically. The report shows who is eligible; adding one is a click.

## Layout of the code

```
server.js          routes and request handling (node:http)
lib/db.js          schema and settings (node:sqlite)
lib/ledger.js      rent posting, FIFO allocation, aging, balances
lib/importer.js    writes a confirmed workbook into the ledger
lib/auth.js        password, sessions, CSRF, login throttle
lib/demo.js        the fake portfolio
lib/views.js       page templates (part 1)
lib/views2.js      page templates (part 2)
lib/util.js        escaping, money formatting, chart of accounts
public/app.css     the design system
public/js/parse.js workbook parser (shared by the browser and the tests)
public/js/import.js  import page: preview and confirm
public/js/export.js  export page: builds .xlsx files with SheetJS
test/run.js        end-to-end test over HTTP
```

## Not in this version

Tenant-facing online payments, tenant maintenance requests, and text-message reminders. Those are the next phase and slot in without changing the ledger.

Built by NormalGuyAI.
