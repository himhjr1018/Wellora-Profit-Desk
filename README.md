# Wellora Profit Desk

Local dashboard for Indian dropshipping. Pulls Shopify orders and Meta ad spend automatically, tracks bank money in and out by hand, and shows profit on one page. Runs only on your Mac (localhost), data stays in `data/dropship.db`.

## Run

```bash
npm start
```

Open http://localhost:3000. Needs Node 22.5 or newer. No `npm install` required.

## Connect your accounts

1. Copy `.env.example` to `.env`.
2. **Shopify**: create a custom app (Settings > Apps > Develop apps), give it the `read_orders` scope, and paste the store domain and Admin API token.
3. **Meta Ads**: paste a Marketing API token with `ads_read` and your ad account ID.
4. Restart `npm start`. Data syncs every 30 minutes (`SYNC_MINUTES`) and on the **Sync now** button.

Until you connect, use **Settings > Load sample data** to explore.

## How it works

- **Orders**: COD vs prepaid is read from the Shopify payment gateway. Status starts as `new` or `shipped`. Tag an order `rto` or `delivered` in Shopify, or change the status on the Orders tab (manual changes are never overwritten by sync).
- **Profit**: delivered orders earn revenue after GST minus supplier cost, courier, COD or gateway fees and packaging. RTO orders lose forward courier, return courier and packaging. Orders not yet delivered show their profit if delivered (marked "if delivered").
- **Net profit** = gross profit - ad spend - prorated fixed monthly costs.
- **Bank**: added manually on the Bank tab. The overview compares delivered revenue with money received to spot pending COD remittances.
- **Settings** hold your cost assumptions and per-product supplier cost.
- **Calculator** tab is the original single-product profit calculator (`public/calculator.html`).

## Files

- `server.js` HTTP server and API
- `db.js` SQLite schema and settings
- `sync.js` Shopify, Meta and sample-data sync
- `summary.js` profit calculations
- `public/` dashboard and calculator pages
