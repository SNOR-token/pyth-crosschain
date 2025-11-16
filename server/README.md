## Solend Liquidator Bot

This package is now a single Node.js worker that scans Solend obligations, liquidates unhealthy accounts, swaps seized collateral back into the settlement mint with Jupiter, and compounds the proceeds. Everything happens in the console—no HTTP server or UI required.

### What it does

- Polls the Solend liquidation feed (`SOLEND_LIQ_API`) on the cadence set by `POLL_INTERVAL_MS`.
- Filters opportunities below `HEALTH_THRESHOLD`.
- Sizes each repay using your wallet’s settlement balance (`UTILIZATION_BPS`, `MIN/MAX_REPAY_LAMPORTS`).
- Builds Solend liquidation instructions, signs with your keypair, and submits.
- (Optional) Appends Jupiter swap instructions so collateral is auto-sold back to the settlement mint.
- Persists cycle counts + balances in `STATE_FILE` so you can resume after restarts.

### Configure

Copy the example env file and edit it:

```bash
cp .env.example .env
```

Important variables:

| Variable | Description |
| --- | --- |
| `LIQUIDATOR_KEYPAIR` | Base58 string or JSON array of the secret key used to sign liquidations. |
| `PRIMARY_SETTLEMENT_MINT` / `PRIMARY_SETTLEMENT_DECIMALS` | Token you use to repay borrows (USDC by default). |
| `UTILIZATION_BPS` | Percentage (in basis points) of the wallet balance to deploy per liquidation (e.g., 2000 = 20%). |
| `MIN_REPAY_LAMPORTS` / `MAX_REPAY_LAMPORTS` | Lower/upper clamps for the repay amount. |
| `REPAY_ALLOW_LIST` | Comma-separated list of repay mints you are willing to target. |
| `JUP_*` | Jupiter quote/swap endpoints and slippage controls for the auto-compound step. |
| `STATE_FILE` | Where the bot stores counters + last signature (defaults to `.liquidator-state.json`). |

> 💡 If you are behind a TLS-intercepting proxy, you can temporarily run with `NODE_TLS_REJECT_UNAUTHORIZED=0 node src/bot.js` so Solend/Jupiter calls succeed. Only do this on networks you trust.

### Run

```bash
pnpm install          # from repo root
cd server
pnpm dev              # nodemon + pretty logs
# or
pnpm start            # plain node src/bot.js
```

All output streams to the console. Stop the bot with `Ctrl+C`; it will flush state and exit cleanly.

### Safety Checklist

- **Start on devnet** (`SOLEND_ENV=devnet`, `RPC_ENDPOINT=https://api.devnet.solana.com`) before risking real capital.
- **Keep utilization low** until you trust the flow. 10–25% of wallet balance per liquidation is a safe place to start.
- **Fund the wallet** with the repay mint (e.g., USDC) plus a small amount of SOL for fees.
- **Watch Jupiter quotes** in the logs—if swaps start failing, disable them by omitting `JUP_*` vars or removing `swapToMint`.
- **Monitor state file** to see cumulative liquidations, failures, and last signature.

### Extending

- Swap out `SolendHelper.fetchOpportunities` if you prefer a custom opportunity feed.
- Replace `StateStore` with a database-backed implementation for deeper analytics.
- Wire alerting (Telegram, email, etc.) by hooking into the log stream or augmenting `LiquidatorEngine`.
