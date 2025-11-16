## Solend Liquidator Server

This package exposes an Express API consumed by the Phantom UI and also runs an optional autonomous liquidator that compounds profits by swapping seized collateral back into the settlement mint (USDC by default). The auto-bot reuses the same Solend + Jupiter pipeline as the `/api/build-liquidation` endpoint so you can dry-run through Phantom before letting it loose.

### Features

- `GET /api/opportunities` — pulls Solend’s liquidation feed, filters by health factor, and returns enriched metadata for the UI.
- `POST /api/build-liquidation` — constructs a full liquidation transaction (plus optional Jupiter swap) and returns the unsigned base64 blob for Phantom.
- `POST /api/tx-submitted` — optional callback so the UI can notify the server after it broadcasts a signed tx.
- `GET /api/bot/state` — exposes cycle counters, realized balances, and the most recent signature from the autonomous bot.
- Static neon dashboard served from `public/index.html` with Phantom connect, live telemetry, and manual liquidation controls.
- Autonomous engine (`LiquidatorEngine`) that:
  - Polls the Solend feed every `POLL_INTERVAL_MS`.
  - Sizes each liquidation based on the settlement-token balance (compounding).
  - Uses Jupiter to swap seized collateral back to the settlement mint so capital keeps growing.

### Configuration

Copy `.env.example` → `.env` and set the required env vars:

```
cp .env.example .env
```

Key settings:

| Variable | Description |
| --- | --- |
| `LIQUIDATOR_KEYPAIR` | Base58 or JSON secret key for the server wallet that signs auto-liquidations. |
| `PRIMARY_SETTLEMENT_MINT` | Token mint used to repay borrows (USDC default). Bot only targets obligations whose repay mint is on the allow-list. |
| `JUP_*` | Jupiter quote/swap endpoints & slippage. |
| `AUTO_LIQUIDATE` | Set to `false` if you only want the HTTP API. |
| `MIN_REPAY_LAMPORTS` / `MAX_REPAY_LAMPORTS` | Bounds for each liquidation notional. |
| `UTILIZATION_BPS` | Fraction of available balance to deploy per liquidation (default 6000 = 60%). |

### Install & Run

```bash
pnpm install          # from repo root (already scoped to workspace)
cd server
pnpm dev              # or pnpm start in production
```

The service listens on `PORT` (default 4000). The neon console is available at `http://localhost:4000/`, and the API at `http://localhost:4000/api/...`.

### Safety Checklist

- **Start on devnet**: override `RPC_ENDPOINT` + `SOLEND_ENV=devnet` until you trust the stack.
- **Small utilization**: cap `UTILIZATION_BPS` and `MAX_REPAY_LAMPORTS` so losses are bounded.
- **Observe Jupiter quotes**: watch the logs to ensure swaps execute at expected prices.
- **Monitor state**: `curl /api/bot/state` to inspect balances, cycle counts, and last errors.

### Extending

- Plug in your own opportunity selector (e.g., custom heuristics or risk scoring) by feeding data directly into `LiquidatorEngine`.
- Persist realized PnL to a DB or metrics stack by replacing the `StateStore`.
- Introduce multi-repay assets by updating `REPAY_ALLOW_LIST` and funding the wallet with the corresponding mints.
