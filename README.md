# Balter Brewing – FV & BBT CIP/SIP Tracker

A password-protected Cloudflare Worker site that replaces the "FV/BBT CIP Compliance" tab.
Drop the Live Brewery Board (.xlsx) on the page to pull in FV/FMT brew dates and BBT transfer
dates; enter CIP and SIP details by hand.

## Deploy (GitHub → Cloudflare)

1. Create a GitHub repo and push this folder (`.gitignore` already excludes `node_modules` and `.wrangler`).
2. Cloudflare dashboard → **Workers & Pages → Create → Import a repository** → pick the repo.
3. Build settings: leave the build command empty; deploy command `npx wrangler deploy`.
4. First deploy automatically creates the `KV` namespace (the binding in `wrangler.jsonc` has no id on purpose).
5. Open the site URL. On first visit you'll be asked to **set a password** (min 8 characters).
   To stop strangers claiming the setup screen before you do, add a `SETUP_CODE` variable
   (Worker → Settings → Variables) and enter it on that screen.

## Using it

- **Drag the Live Brewery Board** anywhere on the page. A preview shows what will be added; re-importing is safe
  and never overwrites CIP/SIP you've typed.
- **Migrate old data once:** drop the old "Vessel & Equipment CIP monitoring" workbook; its
  "FVBBT CIP Compliance NN" sheets are imported.
- Settings (gear icon): FV/BBT lists, which BBTs are DME, change password, sign out.
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
