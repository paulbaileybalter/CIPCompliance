# Balter Brewing – FV & BBT CIP/SIP Tracker

A PIN-protected Cloudflare Worker site that replaces the "FV/BBT CIP Compliance" tab.
Drop the Live Brewery Board (.xlsx) on the page to pull in FV/FMT brew dates and BBT transfer
dates; enter CIP and SIP details by hand.

## Deploy (GitHub → Cloudflare)

1. Create a GitHub repo and push this folder (`.gitignore` already excludes `node_modules` and `.wrangler`).
2. Cloudflare dashboard → **Workers & Pages → Create → Import a repository** → pick the repo.
3. Build settings: leave the build command empty; deploy command `npx wrangler deploy`.
4. First deploy automatically creates the `KV` namespace (the binding in `wrangler.jsonc` has no id on purpose).
5. Open the site URL. On first visit you'll be asked to **set a 4-digit PIN**.
   To stop strangers claiming the setup screen before you do, add a `SETUP_CODE` variable
   (Worker → Settings → Variables) and enter it on that screen.

## Using it

- **Drag the Live Brewery Board** anywhere on the page. A preview shows what will be added; re-importing is safe
  and never overwrites CIP/SIP you've typed.
- **Migrate old data once:** drop the old "Vessel & Equipment CIP monitoring" workbook; its
  "FVBBT CIP Compliance NN" sheets are imported.
- Settings (gear icon): FV/BBT lists, which BBTs are DME, change PIN, sign out.
- Data is saved to KV; a daily backup (`bak:YYYY-MM-DD`) is kept for 30 days.

## Rules implemented

- FV compliant: brew − CIP < 8 days and brew − SIP < 3 days (or both exactly 3 → "<72 hours since CIP").
- BBT: acid CIP within 3 days of transfer is green; otherwise purple for DME tanks, flagged for Krones tanks.
  Fill count 6 / 7 / 8+ = cream / gold / orange; ready when count < 8 (Krones also needs acid CIP < 3 days).
- Future (planned) rows show "too early" rather than "No".

## Local dev / tests

```
npm install
npm run dev     # wrangler dev (local KV)
npm test        # parser, merge and rules tests
```

## Pre-loaded history

`public/seed.json` holds the CIP/SIP history from the old workbook (2025 + 2026 tabs). The first time the site is opened after a deploy, the Worker merges it into the database automatically (once; existing rows are matched, never duplicated or overwritten).
is used with an empty KV store it loads that data automatically. To rebuild it from an updated workbook:
`node scripts/build-seed.mjs path/to/Vessel_Equipment_CIP_monitoring.xlsx` and redeploy (only affects a fresh KV store).
It contains your operational data, so keep the GitHub repo **private**.

If the site already had data in it when you deployed (so the seed didn't auto-load), use **Settings → Load CIP history** to merge it in.

**Forgot the PIN / already set a longer password?** In Cloudflare → Workers & Pages → KV, delete the `auth` key; the next visit shows the PIN setup screen again (your data is untouched).

## BBT fill count (automatic)

Next to each BBT clean date pick **Acid CIP** (the acid wash after a fill: count = previous count + 1) or **CIP**
(caustic CIP, which also takes its SIP date: count resets to 0). The count is filled in for you and follows later edits. Typing a count by hand switches
that row back to manual. Older migrated rows keep their counts and are the starting point.

## Key & rules (editable)

The Overview has a **Key & rules** card under the compliance tile. FV: days CIP and SIP must be before the brew, and the
"<72 h" exception. BBT: days before transfer, which tanks are DME, and how many fills before a CIP is required.
Changes apply to every status, tile and alert immediately and are saved with the data (Reset restores the workbook's values).

## Excel export

The **Excel** button in the header (left of the Saved indicator) downloads a styled workbook for the year shown on the
Overview: a Summary sheet (compliance %, counts, the rules in force, colour key), Fermenters and Brite tanks (real Excel
dates, coloured status cells, filters, frozen headers), all in the site's colour palette.
